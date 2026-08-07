#!/usr/bin/env python3
"""
Facebook Collector Page Scraper — Kerala Rain Holiday Watch

Reads the 14 District Collector Facebook pages for rain holiday orders and
prints a JSON verdict per district on stdout. server.js runs this as a child
process and treats whatever comes back as authoritative, falling back to the
news pipeline for any district missing from the output.

Two ways in, tried in order:
  1. mbasic.facebook.com over plain requests — no browser, no login. Often
     blocked; when it works it is by far the cheaper path.
  2. Selenium against ./fb_chrome_profile, which carries a logged-in session.

Posters are common: collectors frequently publish the order as an image with
no caption. Those go through Tesseract (mal+eng). When OCR is unavailable or
the text comes back unreadable, the district is simply omitted — a silent
fall back to news beats publishing a guess.
"""

import sys
import os
import json
import re
import time
import argparse
from datetime import datetime, timedelta, timezone
from io import BytesIO

import requests
from bs4 import BeautifulSoup

# Malayalam has to survive the trip through stdout to server.js.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

# OCR is optional. Everything still works text-only without it.
try:
    import pytesseract
    from PIL import Image, ImageOps, ImageFilter
    # Windows installers rarely land on PATH, so allow an explicit binary path.
    _tess_cmd = os.environ.get("TESSERACT_CMD")
    if _tess_cmd:
        pytesseract.pytesseract.tesseract_cmd = _tess_cmd
    # The module importing proves nothing — the engine is a separate binary that
    # is frequently absent. Ask it for its version now, so a missing install is
    # one clear warning rather than a failure per image.
    pytesseract.get_tesseract_version()
    OCR_AVAILABLE = True
except Exception:
    OCR_AVAILABLE = False

COLLECTOR_PAGES = {
    "Thiruvananthapuram": "https://www.facebook.com/collectortvpm",
    "Kollam": "https://www.facebook.com/dckollam",
    "Pathanamthitta": "https://www.facebook.com/dcpathanamthitta",
    "Alappuzha": "https://www.facebook.com/districtcollectoralappuzha",
    "Kottayam": "https://www.facebook.com/CollectorKottayam",
    "Idukki": "https://www.facebook.com/CollectorIdukki",
    "Ernakulam": "https://www.facebook.com/dcekm",
    "Thrissur": "https://www.facebook.com/thrissurcollector",
    "Palakkad": "https://www.facebook.com/districtcollectorpalakkad",
    "Malappuram": "https://www.facebook.com/malappuramcollector",
    "Kozhikode": "https://www.facebook.com/CollectorKKD",
    "Wayanad": "https://www.facebook.com/wayanadWE/",
    "Kannur": "https://www.facebook.com/CollectorKNR/",
    "Kasaragod": "https://www.facebook.com/KasaragodCollector",
}

DISTRICTS_LIST = list(COLLECTOR_PAGES.keys())

DISTRICT_TRANSLATIONS = {
    "Thiruvananthapuram": ["തിരുവനന്തപുരം"],
    "Kollam": ["കൊല്ലം"],
    "Pathanamthitta": ["പത്തനംതിട്ട"],
    "Alappuzha": ["ആലപ്പുഴ"],
    "Kottayam": ["കോട്ടയം"],
    "Idukki": ["ഇടുക്കി"],
    "Ernakulam": ["എറണാകുളം"],
    "Thrissur": ["തൃശ്ശൂർ", "തൃശൂർ"],
    "Palakkad": ["പാലക്കാട്"],
    "Malappuram": ["മലപ്പുറം"],
    "Kozhikode": ["കോഴിക്കോട്"],
    "Wayanad": ["വയനാട്"],
    "Kannur": ["കണ്ണൂർ"],
    "Kasaragod": ["കാസർഗോഡ്", "കാസർകോട്"],
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9,ml;q=0.8",
}

# Mirrors LOCAL_HOLIDAY_KEYWORDS in server.js — a post must contain one of
# these before we read it as anything.
HOLIDAY_KEYWORDS = [
    "holiday", "closed", "closure", "postponed", "cancel", "shut",
    "അവധി", "ക്ലാസുകൾ ഉണ്ടാകില്ല", "ക്ലാസുകളുണ്ടാകില്ല",
]

# Collector posts announce; news reports describe. These are the verbs that
# separate an actual order from a page repeating what someone else said.
DECLARATION_MARKERS = [
    "declared", "declares", "declare", "announced", "announces", "announce",
    "is a holiday", "will be a holiday", "hereby", "order", "ordered",
    "പ്രഖ്യാപിച്ചു", "പ്രഖ്യാപിച്ചി", "അറിയിച്ചു", "അറിയിപ്പ്",
    "ഉത്തരവ്", "ആയിരിക്കും", "അവധിയാണ്", "നൽകി", "ബാധക", "അവധി",
    "അറിയിച്ചി", "പ്രഖ്യാപനം", "തീരുമാനം",
]

NEGATION_MARKERS = [
    "അവധിയില്ല", "പ്രഖ്യാപിച്ചിട്ടില്ല", "ഉണ്ടായിരിക്കില്ല", "തീരുമാനിച്ചിട്ടില്ല",
]
NEGATION_PATTERNS = r"\b(no holiday|not declared|no district holiday|no general holiday|holiday is not)\b"

TALUK_NAME_RE = re.compile(
    r"\b([A-Z][a-zA-Z]+(?:\s*,\s*[A-Z][a-zA-Z]+)*(?:\s+and\s+[A-Z][a-zA-Z]+)?)\s+taluks?\b"
)

TALUK_STOPWORDS = {
    "the", "in", "of", "and", "district", "districts", "remaining", "other",
    "others", "all", "select", "respective", "both", "two", "three", "several",
}

# Below this, OCR output is noise. Tuned to reject the handful of stray glyphs
# Tesseract emits for a photo with no text in it.
MIN_OCR_TEXT_LENGTH = 40
MIN_OCR_ALNUM_RATIO = 0.45


def log(msg):
    """Diagnostics go to stderr — stdout carries only the JSON verdict."""
    print(f"[fb_scraper] {msg}", file=sys.stderr)


def get_ist_now():
    return datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(hours=5, minutes=30)


def get_target_date():
    """The date a holiday would apply to, using the same 18:30 IST rollover as
    server.js getISTTime(). Before the rollover we are still reporting on today;
    after it, tonight's orders are about tomorrow."""
    ist_now = get_ist_now()
    minutes = ist_now.hour * 60 + ist_now.minute
    target = ist_now if minutes < (18 * 60 + 30) else ist_now + timedelta(days=1)
    return target.strftime("%Y-%m-%d")


# ─────────────────────────── freshness ───────────────────────────

# Facebook renders relative stamps ("3 hrs", "Yesterday at 20:15") in whatever
# locale the page loads in. We only need one bit out of it: is this post recent
# enough to be about the date we are reporting on.
RECENT_RELATIVE_RE = re.compile(
    r"\b(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours)\b", re.IGNORECASE
)
JUST_NOW_RE = re.compile(r"\b(just now|a few seconds|seconds ago)\b", re.IGNORECASE)
YESTERDAY_RE = re.compile(r"\b(yesterday|ഇന്നലെ)\b", re.IGNORECASE)
DAYS_AGO_RE = re.compile(r"\b(\d+)\s*(d|day|days)\b", re.IGNORECASE)
WEEKS_AGO_RE = re.compile(r"\b(\d+)\s*(w|week|weeks|y|yr|yrs|year|years)\b", re.IGNORECASE)


def is_timestamp_recent(stamp, max_age_hours=30):
    """True when a post's timestamp is recent enough to concern the target date.

    Unparseable stamps return True: a post we cannot date still has to face the
    keyword and declaration checks, which are the real filters. Discarding it
    here would lose orders whose stamp format we simply do not recognise."""
    if not stamp:
        return True

    s = stamp.strip().lower()

    if JUST_NOW_RE.search(s):
        return True

    m = RECENT_RELATIVE_RE.search(s)
    if m:
        value = int(m.group(1))
        unit = m.group(2).lower()
        hours = value if unit.startswith("h") else value / 60.0
        return hours <= max_age_hours

    if YESTERDAY_RE.search(s):
        return max_age_hours >= 24

    m = DAYS_AGO_RE.search(s)
    if m:
        return int(m.group(1)) * 24 <= max_age_hours

    if WEEKS_AGO_RE.search(s):
        return False

    # Absolute dates: "6 August at 19:40", "August 6 at 19:40".
    ist_now = get_ist_now()
    months = {
        "january": 1, "february": 2, "march": 3, "april": 4, "may": 5, "june": 6,
        "july": 7, "august": 8, "september": 9, "october": 10, "november": 11,
        "december": 12,
    }
    for name, num in months.items():
        if name in s or name[:3] in s:
            day_match = re.search(r"\b(\d{1,2})\b", s)
            if day_match:
                day = int(day_match.group(1))
                year_match = re.search(r"\b(20\d{2})\b", s)
                year = int(year_match.group(1)) if year_match else ist_now.year
                try:
                    posted = datetime(year, num, day, 23, 59)
                    age_hours = (ist_now - posted).total_seconds() / 3600.0
                    return -24 <= age_hours <= max_age_hours
                except ValueError:
                    return True
            break

    return True


# ─────────────────────────── OCR ───────────────────────────

def looks_like_readable_text(text):
    """Reject OCR output that is mostly punctuation soup.

    Tesseract does not fail loudly on a photo with no text in it — it returns a
    scattering of glyphs. Publishing a reading off that is worse than staying
    quiet and letting the news pipeline answer, so the bar is deliberately high."""
    if not text:
        return False
    stripped = text.strip()
    if len(stripped) < MIN_OCR_TEXT_LENGTH:
        return False

    meaningful = sum(1 for ch in stripped if ch.isalnum() or ch.isspace())
    if meaningful / len(stripped) < MIN_OCR_ALNUM_RATIO:
        return False

    # Malayalam is the common case and never matches \w+ word shapes reliably,
    # so accept either a run of Malayalam codepoints or real English words.
    has_malayalam = any("ഀ" <= ch <= "ൿ" for ch in stripped)
    has_words = len(re.findall(r"[a-zA-Z]{3,}", stripped)) >= 3
    return has_malayalam or has_words


def ocr_image_bytes(img_bytes):
    """Read one image with Tesseract. Returns "" for anything unreadable."""
    if not OCR_AVAILABLE:
        return ""
    try:
        img = Image.open(BytesIO(img_bytes))
        if img.mode != "L":
            img = img.convert("L")

        # Collector posters are usually clean high-contrast documents; the win
        # comes from upscaling small ones, not from aggressive thresholding.
        w, h = img.size
        if max(w, h) < 1000:
            scale = 1000.0 / max(w, h)
            img = img.resize((int(w * scale), int(h * scale)), Image.LANCZOS)

        img = ImageOps.autocontrast(img)
        img = img.filter(ImageFilter.SHARPEN)

        try:
            text = pytesseract.image_to_string(img, lang="mal+eng")
        except pytesseract.TesseractError:
            # Malayalam traineddata missing — English alone still reads the
            # many posters that are bilingual or English-only.
            text = pytesseract.image_to_string(img, lang="eng")

        return text.strip()
    except Exception as e:
        log(f"OCR failed on an image: {e}")
        return ""


def ocr_image_urls(urls, session=None, max_images=4):
    """OCR every image on a post, keeping only output that reads as text.

    Returns (text, attempted, succeeded) so the caller can tell "no images" from
    "images we could not read" — the second case must not reach the output."""
    if not urls:
        return "", 0, 0
    if not OCR_AVAILABLE:
        log("OCR unavailable (pytesseract/Pillow not installed) — skipping images.")
        return "", len(urls[:max_images]), 0

    getter = session or requests
    chunks = []
    attempted = 0
    succeeded = 0

    for url in urls[:max_images]:
        attempted += 1
        try:
            res = getter.get(url, headers=HEADERS, timeout=15)
            if res.status_code != 200 or not res.content:
                continue
            text = ocr_image_bytes(res.content)
            if looks_like_readable_text(text):
                chunks.append(text)
                succeeded += 1
            else:
                log(f"OCR output rejected as unreadable for {url[:70]}")
        except Exception as e:
            log(f"Could not fetch image {url[:70]}: {e}")

    return "\n".join(chunks), attempted, succeeded


# ─────────────────────────── reading a post ───────────────────────────

def extract_taluks(text):
    """Named taluks only. Generic phrasing ("the remaining taluks") yields []
    so we never invent a name. Same contract as extractTaluks in server.js."""
    names = []
    for match in TALUK_NAME_RE.finditer(text or ""):
        for part in re.split(r",|\band\b", match.group(1)):
            name = part.strip()
            if name and name.lower() not in TALUK_STOPWORDS and name not in names:
                names.append(name)
    return names


def mentions_district(text, district):
    """A collector page is district-scoped, so this is a bonus signal rather
    than a requirement — used to catch posts that name a *different* district."""
    if re.search(r"\b" + re.escape(district) + r"\b", text, re.IGNORECASE):
        return True
    return any(mal in text for mal in DISTRICT_TRANSLATIONS.get(district, []))


def parse_collector_post(text, district):
    """Turn one collector post into a verdict, or None if it declares nothing.

    Deliberately parallel to deriveReading() in server.js, with one difference
    that matters: a collector page *is* the authority, so we require an explicit
    declaration verb rather than treating a bare keyword mention as an order.
    A page can post "no holiday tomorrow" or share a news link, and neither is
    a closure."""
    if not text:
        return None

    lower = text.lower()

    if not any(kw in lower for kw in HOLIDAY_KEYWORDS):
        return None

    if any(n in lower for n in NEGATION_MARKERS) or re.search(NEGATION_PATTERNS, lower):
        return None

    if not any(m in lower for m in DECLARATION_MARKERS):
        return None

    # A post naming only some other district is not this collector's order.
    other = [d for d in DISTRICTS_LIST if d != district and mentions_district(text, d)]
    if other and not mentions_district(text, district):
        return None

    mentions_professional = "professional" in lower or "പ്രൊഫഷണൽ" in lower
    has_exclusion_kw = bool(re.search(r"\b(except|excluding|not)\b", lower)) or \
        "ഒഴികെ" in lower or "ഒഴികെയുള്ള" in lower
    excludes_professional = mentions_professional and has_exclusion_kw

    if excludes_professional:
        type_label = "Educational institutions except professional colleges"
        applies_to = ("Educational institutions except professional colleges "
                      "(schools, anganwadis, tuition centres, etc.)")
        excludes = "Professional colleges NOT covered."
    else:
        type_label = "All educational institutions"
        applies_to = ("All educational institutions — schools, professional colleges, "
                      "anganwadis, and tuition centres")
        excludes = None

    reason = "Adverse weather and heavy rainfall"

    mentions_relief_camp = ("relief camp" in lower or "relief-camp" in lower or
                            "ദുരിതാശ്വാസ" in lower or "ക്യാമ്പ്" in lower)
    relief_camp_only = mentions_relief_camp and (
        "only" in lower or "except" in lower or "functioning as" in lower or
        "പ്രവർത്തിക്കുന്ന" in lower or "മാത്രം" in lower)

    taluks = extract_taluks(text)
    mentions_taluk = bool(taluks) or "taluk" in lower or \
        "താലൂക്ക്" in lower or "താലൂക്കുകൾ" in lower

    if taluks:
        label = ", ".join(taluks) + (" taluk" if len(taluks) == 1 else " taluks")
        is_mixed = relief_camp_only and any(
            x in lower for x in ["remaining", "other", "elsewhere", "ശേഷിക്കുന്ന", "മറ്റു", "മറ്റുള്ള"]
        )

        if relief_camp_only and not is_mixed:
            return {
                "scope": f"Relief camp schools in {label} only",
                "appliesTo": f"Schools functioning as relief camps in {label}.",
                "excludes": "All other educational institutions",
                "reason": "Schools serving as relief camps during floods",
            }

        reading = {
            "scope": label + " only",
            "appliesTo": type_label + " in " + label + ".",
            "excludes": excludes,
            "reason": reason,
        }
        if relief_camp_only:
            reading["appliesTo"] += (" Elsewhere in the district, only schools "
                                     "functioning as relief camps are closed.")
            reading["excludes"] = "Institutions outside " + label + " that are not relief camps."
        return reading

    if relief_camp_only:
        return {
            "scope": "Relief camp schools only",
            "appliesTo": "All schools functioning as relief camps",
            "excludes": "All other educational institutions",
            "reason": "Schools serving as relief camps during floods",
        }

    if mentions_taluk:
        return {
            "scope": "Select taluks only",
            "appliesTo": "Educational institutions in specific taluks",
            "excludes": excludes,
            "reason": reason,
        }

    return {
        "scope": "District-wide",
        "appliesTo": applies_to,
        "excludes": excludes,
        "reason": reason,
    }


def scope_rank(scope):
    s = (scope or "").lower()
    if "district-wide" in s:
        return 3
    if "relief" in s:
        return 1
    if "taluk" in s:
        return 2
    return 0


# ─────────────────────────── route 1: mbasic ───────────────────────────

def make_session():
    s = requests.Session()
    s.headers.update(HEADERS)
    return s


def to_mbasic(url):
    return url.replace("https://www.facebook.com", "https://mbasic.facebook.com")


def looks_like_login_wall(html):
    if not html:
        return True
    lowered = html.lower()
    markers = ["log in to facebook", "you must log in", "login_form",
               "create new account", "forgotten password"]
    hits = sum(1 for m in markers if m in lowered)
    # A logged-out page footer mentions signup too, so demand more than one hit.
    return hits >= 2


def extract_posts_mbasic(html, base_url):
    """Pull posts out of mbasic's plain HTML.

    mbasic has no stable post class, but every post sits in a container holding
    a permalink to story.php or /posts/. Anchoring on that link and walking up
    is more durable than guessing at markup."""
    soup = BeautifulSoup(html, "html.parser")
    posts = []
    seen = set()

    for anchor in soup.find_all("a", href=True):
        href = anchor["href"]
        if not ("story.php" in href or "/posts/" in href or "story_fbid" in href):
            continue

        container = anchor
        for _ in range(4):
            if container.parent is None:
                break
            container = container.parent
            if len(container.get_text(strip=True)) > 80:
                break

        text = container.get_text(separator="\n", strip=True)
        if not text or len(text) < 40:
            continue

        key = text[:160]
        if key in seen:
            continue
        seen.add(key)

        images = []
        for img in container.find_all("img", src=True):
            src = img["src"]
            # Profile pictures and spacers ride along in every container.
            if "emoji" in src or "static" in src or "rsrc.php" in src:
                continue
            images.append(src)

        stamp = ""
        abbr = container.find("abbr")
        if abbr:
            stamp = abbr.get_text(strip=True)

        permalink = href if href.startswith("http") else "https://mbasic.facebook.com" + href

        posts.append({
            "text": text,
            "images": images,
            "timestamp": stamp,
            "permalink": permalink,
        })

        if len(posts) >= 8:
            break

    return posts


def scrape_via_mbasic(session, district, url, max_posts):
    try:
        res = session.get(to_mbasic(url), timeout=20, allow_redirects=True)
    except Exception as e:
        log(f"{district}: mbasic request failed — {e}")
        return None

    if res.status_code != 200:
        log(f"{district}: mbasic returned HTTP {res.status_code}")
        return None

    if looks_like_login_wall(res.text):
        log(f"{district}: mbasic served a login wall")
        return None

    posts = extract_posts_mbasic(res.text, url)
    if not posts:
        log(f"{district}: mbasic reachable but no posts parsed")
        return None

    return posts[:max_posts]


# ─────────────────────────── route 2: Selenium ───────────────────────────

def setup_selenium_driver(profile_path="./fb_chrome_profile", headless=True):
    from selenium import webdriver
    from selenium.webdriver.chrome.service import Service
    from selenium.webdriver.chrome.options import Options
    from webdriver_manager.chrome import ChromeDriverManager

    opts = Options()
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    import sys
    if sys.platform.startswith("linux"):
        opts.add_argument("--disable-extensions")
        opts.add_argument("--disable-software-rasterizer")
        opts.add_argument("--single-process")
        opts.add_argument("--no-zygote")
    opts.add_argument(f"user-agent={HEADERS['User-Agent']}")

    if profile_path:
        os.makedirs(profile_path, exist_ok=True)
        opts.add_argument(f"user-data-dir={os.path.abspath(profile_path)}")
        opts.add_argument("profile-directory=Default")

    if headless:
        opts.add_argument("--headless=new")
        opts.add_argument("--disable-gpu")
        opts.add_argument("--window-size=1280,2000")
    else:
        opts.add_argument("--start-maximized")

    service = Service(ChromeDriverManager().install())
    return webdriver.Chrome(service=service, options=opts)


def selenium_logged_in(driver):
    from selenium.webdriver.common.by import By
    driver.get("https://www.facebook.com/")
    time.sleep(4)
    try:
        body = driver.find_element(By.TAG_NAME, "body").text
    except Exception:
        return False
    return not ("Log in" in body and
                ("Forgotten password?" in body or "Create new account" in body))


def scrape_via_selenium(driver, district, url, max_posts):
    from selenium.webdriver.common.by import By

    try:
        log(f"{district}: navigating to {url}")
        driver.get(url)
        time.sleep(6)

        body = driver.find_element(By.TAG_NAME, "body").text
        if "This content isn't available" in body:
            log(f"{district}: page unavailable")
            return None

        elements = driver.find_elements(By.XPATH, "//div[@role='article']")
        if not elements:
            elements = driver.find_elements(
                By.XPATH, "//div[contains(@data-ad-preview, 'message')] | //div[@role='feed']/div"
            )
        log(f"{district}: {len(elements)} post element(s); page body {len(body)} chars")
        if not elements:
            # Either the DOM shape changed or Facebook served a wall. Show a
            # slice of what actually rendered so this is diagnosable.
            log(f"{district}: no post elements. Body starts: {body[:220]!r}")

        posts = []
        for el in elements[:max_posts]:
            try:
                # Expand truncated post texts ("See more" / "കൂടുതൽ കാണുക")
                try:
                    for tag in ["div", "span", "a"]:
                        buttons = el.find_elements(By.XPATH, f".//{tag}[@role='button' or @type='button' or contains(@class, 'see_more') or contains(., 'See more') or contains(., 'See More') or contains(., 'കൂടുതൽ')]")
                        for btn in buttons:
                            text_val = btn.text.strip().lower()
                            if btn.is_displayed() and ("see more" in text_val or "കൂടുതൽ" in text_val or "കാണുക" in text_val):
                                driver.execute_script("arguments[0].click();", btn)
                                time.sleep(1)
                                break
                except Exception:
                    pass

                text = el.text.strip()
                if not text:
                    continue

                images = []
                for img in el.find_elements(By.TAG_NAME, "img"):
                    src = img.get_attribute("src") or ""
                    if src.startswith("http") and "emoji" not in src and "rsrc.php" not in src:
                        images.append(src)

                permalink = url
                for a in el.find_elements(By.TAG_NAME, "a"):
                    href = a.get_attribute("href") or ""
                    if "/posts/" in href or "story_fbid" in href or "/permalink/" in href:
                        permalink = href.split("?")[0]
                        break

                # First line of a rendered post is the page name; the second is
                # usually the timestamp.
                lines = [l for l in text.split("\n") if l.strip()]
                stamp = lines[1] if len(lines) > 1 else ""

                posts.append({
                    "text": text,
                    "images": images,
                    "timestamp": stamp,
                    "permalink": permalink,
                })
            except Exception:
                continue

        return posts or None
    except Exception as e:
        log(f"{district}: Selenium scrape failed — {e}")
        return None


# ─────────────────────────── orchestration ───────────────────────────

def evaluate_posts(district, posts, session):
    """Pick the strongest verdict across a page's recent posts.

    Text is tried before OCR: when a post carries a caption that already states
    the order, spending Tesseract on the attached poster buys nothing."""
    best = None

    log(f"{district}: evaluating {len(posts)} post(s)")

    for post in posts:
        if not is_timestamp_recent(post.get("timestamp")):
            log(f"{district}: skipping stale post (stamp={post.get('timestamp')!r})")
            continue

        text = post.get("text") or ""
        reading = parse_collector_post(text, district)
        used_ocr = False
        ocr_attempted = 0
        ocr_succeeded = 0

        if not reading and post.get("images"):
            ocr_text, ocr_attempted, ocr_succeeded = ocr_image_urls(post["images"], session)
            if ocr_text:
                combined = (text + "\n" + ocr_text).strip()
                reading = parse_collector_post(combined, district)
                if reading:
                    used_ocr = True

        if not reading:
            if ocr_attempted and not ocr_succeeded:
                # Unreadable poster. Say so on stderr and leave the district
                # out, so the news pipeline answers for it.
                log(f"{district}: image post could not be read — deferring to news")
            continue

        title = next((l.strip() for l in text.split("\n") if len(l.strip()) > 15), None)
        if not title:
            title = f"District Collector, {district} — Facebook post"

        candidate = {
            "status": "confirmed",
            "scope": reading["scope"],
            "appliesTo": reading["appliesTo"],
            "excludes": reading["excludes"],
            "reason": reading["reason"],
            "sourceTitle": title[:200],
            "sourceUrl": post.get("permalink") or COLLECTOR_PAGES[district],
            "isImagePost": used_ocr,
            "checkedAt": get_ist_now().isoformat() + "+05:30",
        }

        # Posts arrive newest-first, so an earlier candidate wins ties; only a
        # strictly broader order displaces it.
        if best is None or scope_rank(candidate["scope"]) > scope_rank(best["scope"]):
            best = candidate

    return best


def main():
    parser = argparse.ArgumentParser(description="Scrape Kerala District Collector Facebook pages.")
    parser.add_argument("--districts", nargs="*", default=None,
                        help="Districts to check (default: all 14)")
    parser.add_argument("--max-posts", type=int, default=4,
                        help="Recent posts to inspect per page")
    default_profile = os.environ.get("FB_PROFILE_PATH", "./fb_chrome_profile")
    parser.add_argument("--profile", default=default_profile,
                        help="Chrome profile directory for the Selenium fallback")
    parser.add_argument("--no-selenium", action="store_true",
                        help="Use mbasic only; never launch a browser")
    parser.add_argument("--headful", action="store_true",
                        help="Show the browser window (for logging in once)")
    parser.add_argument("--export-cookies", action="store_true",
                        help="Export Selenium session cookies as a JSON string for environment variable use")
    args = parser.parse_args()

    if args.export_cookies:
        driver = setup_selenium_driver(args.profile, headless=True)
        try:
            driver.get("https://www.facebook.com/")
            time.sleep(4)
            if selenium_logged_in(driver):
                print("\n=== COPY THE JSON BELOW FOR FB_COOKIES_JSON ===")
                print(json.dumps(driver.get_cookies()))
                print("================================================\n")
            else:
                print("Not logged in! Run with --headful first to sign in.")
        finally:
            driver.quit()
        return

    districts = args.districts or DISTRICTS_LIST
    unknown = [d for d in districts if d not in COLLECTOR_PAGES]
    if unknown:
        log(f"Unknown district(s) ignored: {', '.join(unknown)}")
        districts = [d for d in districts if d in COLLECTOR_PAGES]

    if not OCR_AVAILABLE:
        log("pytesseract/Pillow not installed — image posts will be skipped. See SETUP_TESSERACT.md")

    session = make_session()
    results = {}
    needs_selenium = []

    # Pass 1: mbasic for everything. Cheap, and on a good day it is the whole job.
    log(f"Pass 1 — mbasic for {len(districts)} district(s)")
    for district in districts:
        posts = scrape_via_mbasic(session, district, COLLECTOR_PAGES[district], args.max_posts)
        if posts is None:
            needs_selenium.append(district)
            continue
        verdict = evaluate_posts(district, posts, session)
        if verdict:
            results[district] = verdict
            log(f"{district}: holiday found via mbasic — {verdict['scope']}")

    # Pass 2: browser for the pages mbasic would not serve.
    if needs_selenium and not args.no_selenium:
        log(f"Pass 2 — Selenium for {len(needs_selenium)} district(s): {', '.join(needs_selenium)}")
        
        # Process in chunks of 3 districts to recycle Chrome and prevent OOM on Render
        chunk_size = 3
        for i in range(0, len(needs_selenium), chunk_size):
            chunk = needs_selenium[i:i+chunk_size]
            log(f"Processing Selenium chunk {i//chunk_size + 1}: {', '.join(chunk)}")
            driver = None
            try:
                driver = setup_selenium_driver(args.profile, headless=not args.headful)
                
                # Inject cookies from environment variable if provided
                cookies_json = os.environ.get("FB_COOKIES_JSON")
                if cookies_json:
                    try:
                        cookies_list = json.loads(cookies_json)
                        driver.get("https://www.facebook.com/")
                        time.sleep(2)
                        for cookie in cookies_list:
                            if "expiry" in cookie:
                                del cookie["expiry"]
                            driver.add_cookie(cookie)
                        log("Injected Facebook cookies from FB_COOKIES_JSON environment variable.")
                    except Exception as ex:
                        log(f"Failed to inject cookies: {ex}")

                logged_in = selenium_logged_in(driver)
                log(f"Login check result: {logged_in}")

                if not logged_in and args.headful and sys.stdin.isatty():
                    log("=" * 68)
                    log("NOT LOGGED IN. A Chrome window is open — sign in to Facebook there.")
                    log("Leave the window open. Once your feed loads, return here and press Enter.")
                    log("=" * 68)
                    try:
                        input()
                    except EOFError:
                        pass
                    logged_in = selenium_logged_in(driver)
                    log("Login verified — session saved to the profile."
                        if logged_in else "Still not logged in; skipping this chunk.")
                elif not logged_in:
                    log("Facebook session is not logged in. Skipping this chunk.")

                if logged_in:
                    for district in chunk:
                        posts = scrape_via_selenium(driver, district, COLLECTOR_PAGES[district], args.max_posts)
                        if not posts:
                            continue
                        verdict = evaluate_posts(district, posts, session)
                        if verdict:
                            results[district] = verdict
                            log(f"{district}: holiday found via Selenium — {verdict['scope']}")
                        time.sleep(2)
            except Exception as e:
                log(f"Selenium chunk failed: {e}")
            finally:
                if driver:
                    try:
                        driver.quit()
                    except Exception:
                        pass
    elif needs_selenium:
        log(f"Skipping Selenium (--no-selenium); {len(needs_selenium)} district(s) unchecked")

    log(f"Done. {len(results)} district(s) with a Collector declaration.")
    print(json.dumps({
        "targetDate": get_target_date(),
        "checkedAt": get_ist_now().isoformat() + "+05:30",
        "ocrAvailable": OCR_AVAILABLE,
        "districtsChecked": districts,
        "districtsUnreachable": needs_selenium if args.no_selenium else [],
        "findings": results,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
