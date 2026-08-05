import requests
from bs4 import BeautifulSoup
import re
import json
import sys
import os
from datetime import datetime, timedelta

# Reconfigure stdout for Unicode (Malayalam, Indian Rupee symbol) in Windows terminal
sys.stdout.reconfigure(encoding='utf-8')

DISTRICTS_LIST = [
    "Thiruvananthapuram", "Kollam", "Pathanamthitta", "Alappuzha", "Kottayam",
    "Idukki", "Ernakulam", "Thrissur", "Palakkad", "Malappuram",
    "Kozhikode", "Wayanad", "Kannur", "Kasaragod"
]

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
    "Kasaragod": ["കാസർഗോഡ്", "കാസർകോട്"]
}

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
}

def get_ist_time():
    """Returns current date, time, and target date in IST (UTC+5:30) based on 18:30 (6:30 PM) rollover."""
    utc_now = datetime.utcnow()
    ist_now = utc_now + timedelta(hours=5, minutes=30)
    
    today_str = ist_now.strftime("%Y-%m-%d")
    
    # If before 6:30 PM (18:30) IST, target is today; otherwise tomorrow
    current_minutes = ist_now.hour * 60 + ist_now.minute
    rollover_minutes = 18 * 60 + 30
    if current_minutes < rollover_minutes:
        target_date = ist_now
    else:
        target_date = ist_now + timedelta(days=1)
        
    target_str = target_date.strftime("%Y-%m-%d")
    target_label = target_date.strftime("%A, %d %B %Y")
    checked_at = ist_now.isoformat() + "+05:30"
    
    return today_str, target_str, target_label, checked_at

def parse_alerts(body_text):
    """Parses the article body text to extract dynamic IMD alerts for all districts."""
    alerts = {dist: "none" for dist in DISTRICTS_LIST}
    
    # Split into sentences (by period or newline)
    sentences = re.split(r'\.|\n', body_text)
    default_alert = "none"
    explicit_mapped = set()
    
    for sentence in sentences:
        sentence = sentence.strip()
        if not sentence or "alert" not in sentence.lower():
            continue
            
        # Split by while, but, whereas, semicolon
        clauses = re.split(r'\bwhile\b|\bbut\b|\bwhereas\b|;', sentence, flags=re.IGNORECASE)
        for clause in clauses:
            clause_lower = clause.lower()
            color = None
            if "red alert" in clause_lower or (re.search(r'\bred\b', clause_lower) and "alert" in clause_lower):
                color = "red"
            elif "orange alert" in clause_lower or (re.search(r'\borange\b', clause_lower) and "alert" in clause_lower):
                color = "orange"
            elif "yellow alert" in clause_lower or (re.search(r'\byellow\b', clause_lower) and "alert" in clause_lower):
                color = "yellow"
                
            if not color:
                continue
                
            clause_districts = []
            for dist in DISTRICTS_LIST:
                if re.search(r'\b' + re.escape(dist) + r'\b', clause, re.IGNORECASE):
                    clause_districts.append(dist)
                    
            if clause_districts:
                for dist in clause_districts:
                    alerts[dist] = color
                    explicit_mapped.add(dist)
            else:
                if "district" in clause_lower or "state" in clause_lower or "kerala" in clause_lower or "multiple" in clause_lower:
                    default_alert = color
                    
    if default_alert != "none":
        for dist in DISTRICTS_LIST:
            if dist not in explicit_mapped:
                alerts[dist] = default_alert
                
    return alerts

def is_sentence_relevant_for_date(sentence, target_str):
    DAYS_ENG = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]
    DAYS_MAL = ["ഞായർ", "തിങ്കൾ", "ചൊവ്വ", "ബുധൻ", "വ്യാഴം", "വെള്ളി", "ശനി"]
    
    target_dt = datetime.strptime(target_str, "%Y-%m-%d")
    target_day_index = (target_dt.weekday() + 1) % 7
    
    target_day_eng = DAYS_ENG[target_day_index]
    target_day_mal = DAYS_MAL[target_day_index]
    
    sentence_lower = sentence.lower()
    other_days_eng = [d for d in DAYS_ENG if d != target_day_eng]
    other_days_mal = [d for d in DAYS_MAL if d != target_day_mal]
    
    # Check English days
    if any(day in sentence_lower for day in other_days_eng):
        if target_day_eng not in sentence_lower and "tomorrow" not in sentence_lower:
            return False
            
    # Check Malayalam days
    if any(day in sentence_lower for day in other_days_mal):
        if target_day_mal not in sentence_lower and "നാളെ" not in sentence_lower:
            return False
            
    # If target date is tomorrow, check for today/yesterday references
    utc_now = datetime.utcnow()
    ist_now = utc_now + timedelta(hours=5, minutes=30)
    today_str = ist_now.strftime("%Y-%m-%d")
    
    if target_str != today_str:
        has_past_or_today = "today" in sentence_lower or "yesterday" in sentence_lower or \
                            "ഇന്ന്" in sentence_lower or "ഇന്നലെ" in sentence_lower
        has_future = "tomorrow" in sentence_lower or "നാളെ" in sentence_lower or \
                     target_day_eng in sentence_lower or target_day_mal in sentence_lower
                     
        if has_past_or_today and not has_future:
            return False
            
        # For a future target date, we must see a future reference.
        # Otherwise, old paragraphs from today's static article will bleed into tomorrow.
        if not has_future:
            return False

    return True

LOCAL_HOLIDAY_KEYWORDS = [
    "holiday", "closed", "closure", "postponed", "cancel", "shut",
    "അവധി", "ക്ലാസുകൾ ഉണ്ടാകില്ല"
]

TALUK_NAME_RE = re.compile(
    r'\b([A-Z][a-zA-Z]+(?:\s*,\s*[A-Z][a-zA-Z]+)*(?:\s+and\s+[A-Z][a-zA-Z]+)?)\s+taluks?\b'
)

TALUK_STOPWORDS = {
    "the", "in", "of", "and", "district", "districts", "remaining", "other",
    "others", "all", "select", "respective", "both", "two", "three", "several"
}

def extract_taluks(text):
    """Pull taluk names out of prose like "in Thiruvalla taluk" or
    "Vadakara and Koyilandy taluks". Returns [] for generic phrasing such as
    "the district's remaining taluks", so we never invent a name."""
    names = []
    for match in TALUK_NAME_RE.finditer(text or ""):
        for part in re.split(r',|\band\b', match.group(1)):
            name = part.strip()
            if name and name.lower() not in TALUK_STOPWORDS and name not in names:
                names.append(name)
    return names

def derive_reading(text):
    """Read one sentence of a holiday report into a scope verdict.

    Two axes here, and they are independent: which institution *types* the
    order names (appliesTo), and how far the order reaches (scope). Conflating
    them is what made "all educational institutions ... in Thiruvalla taluk"
    read as district-wide. Returns None when the sentence declares no closure."""
    lower = (text or "").lower()
    if not any(kw in lower for kw in LOCAL_HOLIDAY_KEYWORDS):
        return None

    mentions_professional = "professional" in lower or "പ്രൊഫഷണൽ" in lower
    has_exclusion_kw = bool(re.search(r'\b(except|excluding|not)\b', lower)) or \
        "ഒഴികെ" in lower or "ഒഴികെയുള്ള" in lower
    excludes_professional = mentions_professional and has_exclusion_kw

    if excludes_professional:
        type_label = "Educational institutions except professional colleges"
        applies_to = "Educational institutions except professional colleges (schools, anganwadis, tuition centres, etc.)"
        excludes = "Professional colleges NOT covered."
    else:
        type_label = "All educational institutions"
        applies_to = "All educational institutions — schools, professional colleges, anganwadis, and tuition centres"
        excludes = None

    reason = "Adverse weather and heavy rainfall"

    mentions_relief_camp = ("relief camp" in lower or "relief-camp" in lower or
                            "ദുരിതാശ്വാസ" in lower or "ക്യാമ്പ്" in lower)
    relief_camp_only = mentions_relief_camp and (
        "only" in lower or "except" in lower or "functioning as" in lower or
        "പ്രവർത്തിക്കുന്ന" in lower or "മാത്രം" in lower)

    taluks = extract_taluks(text)
    mentions_taluk = bool(taluks) or "taluk" in lower or "താലൂക്ക്" in lower or "താലൂക്കുകൾ" in lower

    if taluks:
        # A named-taluk order. Keep the scope line taluk-shaped — the UI lifts
        # the names out of it into chips.
        label = ", ".join(taluks) + (" taluk" if len(taluks) == 1 else " taluks")
        
        # Check if this is a mixed order (has "remaining", "other", "elsewhere")
        is_mixed = relief_camp_only and any(x in lower for x in ["remaining", "other", "elsewhere", "ശേഷിക്കുന്ന", "മറ്റു", "മറ്റുള്ള"])
        
        if relief_camp_only and not is_mixed:
            # Case B: Only relief camp schools in the named taluks are closed
            return {
                "scope": f"Relief camp schools in {label} only",
                "appliesTo": f"Schools functioning as relief camps in {label}.",
                "excludes": "All other educational institutions",
                "reason": "Schools serving as relief camps during floods",
                "qualified": True
            }
            
        reading = {
            "scope": label + " only",
            "appliesTo": type_label + " in " + label + ".",
            "excludes": excludes,
            "reason": reason,
            "qualified": True,
        }
        if relief_camp_only:
            # Mixed order in one sentence: the named taluks close fully,
            # elsewhere only the schools being used as relief camps do.
            reading["appliesTo"] += " Elsewhere in the district, only schools functioning as relief camps are closed."
            reading["excludes"] = "Institutions outside " + label + " that are not relief camps."
        return reading

    if relief_camp_only:
        # Covers "in the district's remaining taluks, only relief camps" too —
        # an unnamed taluk phrase is not a named-taluk order.
        return {
            "scope": "Relief camp schools only",
            "appliesTo": "All schools functioning as relief camps",
            "excludes": "All other educational institutions",
            "reason": "Schools serving as relief camps during floods",
            "qualified": True,
        }

    if mentions_taluk:
        return {
            "scope": "Select taluks only",
            "appliesTo": "Educational institutions in specific taluks",
            "excludes": excludes,
            "reason": reason,
            "qualified": True,
        }

    return {
        "scope": "District-wide",
        "appliesTo": applies_to,
        "excludes": excludes,
        "reason": reason,
        "qualified": excludes_professional,
    }

def _scope_rank(scope):
    s = (scope or "").lower()
    if "district-wide" in s:
        return 3
    if "relief" in s:
        return 1
    if "taluk" in s:
        return 2
    return 0

def pick_best_reading(readings):
    """Choose the reading to publish for a district.

    "District-wide" is what we fall back to when a sentence names no limit — an
    assumption, not an observation. So any reading that actually names a limit
    beats an unqualified default; only among equally qualified readings do we
    take the broadest."""
    qualified = [r for r in readings if r.get("qualified")]
    pool = qualified or readings
    best = max(pool, key=lambda r: (_scope_rank(r["scope"]), 0.5 if r.get("excludes") else 0.0))

    # A taluk sentence and a relief-camp sentence in the same report describe
    # one order with two halves. Carry the remainder onto the taluk reading
    # rather than dropping it.
    if "taluk" in (best["scope"] or "").lower() and \
            "relief camp" not in (best.get("appliesTo") or "").lower() and \
            "relief camp" not in (best.get("scope") or "").lower() and \
            any("relief camp" in (r["scope"] or "").lower() for r in pool):
        best = dict(best)
        best["appliesTo"] = (best.get("appliesTo") or "").rstrip() + \
            " Elsewhere in the district, only schools functioning as relief camps are closed."
        best["excludes"] = "Institutions outside the named taluks that are not relief camps."
    return best

def find_latest_holiday_article():
    """Scrapes Onmanorama Kerala page to find the URL of the latest rain holiday article.
    Returns (url, title, None) if article is from today (or yesterday before 03:00 IST).
    Returns (None, None, fallback_url) if no fresh article found — fallback_url is the
    best available article URL to use only for IMD alert parsing."""
    url = "https://www.onmanorama.com/news/kerala.html"
    print(f"Scanning news portal: {url}")
    
    # Build today's date path for URL matching (YYYY/MM/DD)
    utc_now = datetime.utcnow()
    ist_now = utc_now + timedelta(hours=5, minutes=30)
    today_path = ist_now.strftime("%Y/%m/%d")
    yesterday_path = (ist_now - timedelta(days=1)).strftime("%Y/%m/%d")
    ist_hour = ist_now.hour
    is_early_morning = ist_hour < 3  # grace window: yesterday's late-night articles
    
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        if response.status_code != 200:
            return None, None, None
            
        soup = BeautifulSoup(response.text, "html.parser")
        links = soup.find_all("a")
        
        candidates = []
        for link in links:
            href = link.get("href")
            title = link.text.strip()
            
            if not href or not title:
                continue
                
            title_lower = title.lower()
            href_lower = href.lower() if href else ""
            
            is_holiday_article = "holiday" in title_lower and ("district" in title_lower or "school" in title_lower or "rain" in title_lower)
            is_rain_breaking_article = ("rain" in title_lower or "flood" in title_lower or "alert" in title_lower) and \
                ("district" in title_lower or "alert" in title_lower or "holiday" in href_lower or "school" in href_lower)
                
            if is_holiday_article or is_rain_breaking_article:
                if not href.startswith("http"):
                    full_href = "https://www.onmanorama.com" + href
                else:
                    full_href = href
                candidates.append((full_href, title, href))
        
        if not candidates:
            print("[-] No rain holiday news articles found on Onmanorama today.")
            return None, None, None
        
        # Prefer today's article
        for full_href, title, href in candidates:
            if today_path in href:
                print(f"[+] Found today's article: {title}")
                return full_href, title, None  # None = no fallback needed
        
        # Fall back to yesterday only in early-morning grace window
        if is_early_morning:
            for full_href, title, href in candidates:
                if yesterday_path in href:
                    print(f"[+] Early-morning grace window: using yesterday's article: {title}")
                    return full_href, title, None
        
        # No fresh article — return best candidate as fallback for IMD alert parsing only
        print(f"[-] No article from today ({today_path}) found. Will write no-holiday status.")
        print(f"    Best candidate URL: {candidates[0][0]}")
        return None, None, candidates[0][0]
            
    except Exception as e:
        print(f"Error finding article: {e}")
        return None, None, None

def fetch_article_body(url):
    """Fetches the full text of an Onmanorama article."""
    print(f"Fetching full article text: {url}")
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        if response.status_code != 200:
            return ""
            
        soup = BeautifulSoup(response.text, "html.parser")
        
        # Onmanorama article bodies are typically inside div elements with specific classes, 
        # but parsing all paragraphs <p> inside the article body is robust.
        paragraphs = soup.find_all("p")
        body_text = "\n".join([p.text.strip() for p in paragraphs if p.text.strip()])
        return body_text
    except Exception as e:
        print(f"Error fetching article body: {e}")
        return ""

def fetch_holiday_body(url, target_str):
    """Fetches the article body specifically formatted for holiday parsing.
    If it's a live blog, fetches dynamic updates from the AEM JSON and filters by target date window.
    Otherwise, filters static paragraphs by day-of-week name."""
    print(f"Fetching holiday article text: {url}")
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        if response.status_code != 200:
            return ""
            
        soup = BeautifulSoup(response.text, "html.parser")
        
        # Check if it's a live blog
        file_path_match = re.search(r'var\s+filePath\s*=\s*[\'"]([^\'"]+)[\'"]', response.text)
        if file_path_match:
            file_path_raw = file_path_match.group(1)
            file_path = file_path_raw.replace(r'\/', '/')
            file_path = re.sub(r'\\u([0-9a-fA-F]{4})', lambda m: chr(int(m.group(1), 16)), file_path)
            json_url = f"https://www.onmanorama.com{file_path}.5.json"
            try:
                print(f"[Scraper] Live blog detected. Fetching updates from AEM JSON: {json_url}")
                json_res = requests.get(json_url, headers=HEADERS, timeout=10)
                if json_res.status_code == 200:
                    json_data = json_res.json()
                    
                    # Parse target date range in UTC
                    target_dt = datetime.strptime(target_str, "%Y-%m-%d")
                    window_start = (target_dt - timedelta(days=1)).replace(hour=13, minute=0, second=0)
                    window_end = target_dt.replace(hour=13, minute=0, second=0)
                    
                    updates = []
                    for k, v in json_data.items():
                        if k.startswith("livenewsupdate"):
                            master = v.get("jcr:content", {}).get("data", {}).get("master", {})
                            created_str = v.get("jcr:created")
                            if master and created_str:
                                try:
                                    time_part = created_str.split(" GMT")[0]
                                    dt_local = datetime.strptime(time_part, "%a %b %d %Y %H:%M:%S")
                                    dt_utc = dt_local - timedelta(hours=5, minutes=30)
                                    
                                    if window_start <= dt_utc <= window_end:
                                        desc = master.get("description", "")
                                        updates.append((dt_utc, desc))
                                except Exception as e:
                                    print(f"Error parsing date {created_str}: {e}")
                                    
                    updates.sort(key=lambda x: x[0], reverse=True)
                    
                    holiday_paragraphs = []
                    for _, desc in updates:
                        desc_soup = BeautifulSoup(desc, "html.parser")
                        text = desc_soup.get_text().strip()
                        if text:
                            holiday_paragraphs.append(text)
                            
                    print(f"[Scraper] Gathered {len(holiday_paragraphs)} live update(s) within the target date window.")
                    return "\n".join(holiday_paragraphs)
            except Exception as e:
                print(f"[Scraper] Failed to fetch live updates JSON: {e}. Falling back to static HTML.")
                
        # Fallback for standard article or failed JSON fetch
        paragraphs = soup.find_all("p")
        raw_paragraphs = [p.text.strip() for p in paragraphs if p.text.strip()]
        relevant_paragraphs = [p for p in raw_paragraphs if is_sentence_relevant_for_date(p, target_str)]
        return "\n".join(relevant_paragraphs)
        
    except Exception as e:
        print(f"Error fetching holiday body: {e}")
        return ""

def parse_holiday_data(full_body, holiday_body, article_url, article_title):
    """Parses the article body text to determine district holiday declarations and exam delays."""
    today_str, target_str, target_label, checked_at = get_ist_time()
    alerts_map = parse_alerts(full_body)
    
    # Initialize all districts with 'none' status
    districts_data = []
    confirmed_districts = []
    
    # Local holiday confirmation keywords to check in district context
    LOCAL_HOLIDAY_KEYWORDS = [
        "holiday", "closed", "closure", "postponed", "cancel", "shut",
        "അവധി", "ക്ലാസുകൾ ഉണ്ടാകില്ല"
    ]
    
    for dist in DISTRICTS_LIST:
        is_holiday = False
        context = ""
        
        paragraphs = [p.strip() for p in re.split(r'\n|\.\s+', holiday_body) if p.strip()]
        for p in paragraphs:
            if re.search(r'\b' + re.escape(dist) + r'\b', p, re.IGNORECASE):
                p_lower = p.lower()
                has_kw = False
                for kw in LOCAL_HOLIDAY_KEYWORDS:
                    if kw in p_lower:
                        has_kw = True
                        break
                if has_kw:
                    is_holiday = True
                    context = p_lower
                    break
        
        if is_holiday:
            status = "confirmed"
            scope = "District-wide"
            applies_to = "All educational institutions — schools, professional colleges, anganwadis, and tuition centres"
            excludes = None
            reason = "Adverse weather and heavy rainfall"
            declared_by = f"District Collector, {dist}"
            
            # 1. Relief Camps conditional closures
            if "relief camp" in context or "relief-camp" in context or "functioning as relief" in context:
                scope = "Relief camp schools only"
                applies_to = "All schools functioning as relief camps"
                excludes = "All other educational institutions"
                reason = "Schools serving as relief camps during floods"
                
            # 2. Taluk-specific partial closures
            elif "taluk" in context or "taluks" in context:
                # Try to extract the specific taluks from the context
                taluks_match = re.search(r'([a-zA-Z\s,]+)\staluk', context, re.IGNORECASE)
                if taluks_match:
                    scope = f"{taluks_match.group(1).strip()} taluks only"
                else:
                    scope = "Select taluks only"
                applies_to = "Educational institutions in specific taluks"
                
                # Check for Kannur specific professional colleges exclusion
                if dist == "Kannur" and "professional" in context and ("not" in context or "except" in context):
                    excludes = "Professional colleges NOT covered. Residential schools remain open."
                    
            confirmed_districts.append(dist)
            
            # Construct district object
            districts_data.append({
                "name": dist,
                "status": status,
                "alert": alerts_map[dist],  # Parsed alert level
                "confidence": 95,
                "scope": scope,
                "appliesTo": applies_to,
                "excludes": excludes,
                "reason": reason,
                "declaredBy": declared_by,
                "exams": "Scheduled public and university examinations proceed unless specified.",
                "confidenceNote": "Confirmed by major news report quoting Collector's declaration.",
                "sources": [{
                    "name": "Onmanorama",
                    "title": article_title,
                    "url": article_url,
                    "time": "Latest Update",
                    "tier": 1
                }]
            })
        else:
            # District not mentioned or not declared a holiday
            districts_data.append({
                "name": dist,
                "status": "none",
                "alert": alerts_map[dist],
                "confidence": None,
                "scope": None,
                "appliesTo": None,
                "excludes": None,
                "reason": None,
                "declaredBy": None,
                "exams": None,
                "confidenceNote": None,
                "sources": []
            })
            
    # Parse exam delays
    advisories = []
    
    # Check for PSC postponements
    psc_match = re.search(r'PSC\s(has\s)?(cancelled|postponed|deferred)', full_body, re.IGNORECASE)
    if psc_match or "kerala public service commission" in full_body.lower():
        advisories.append({
            "level": "info",
            "title": "Kerala PSC Exams Postponed",
            "body": "The Kerala Public Service Commission (PSC) has cancelled/postponed OMR and online exams scheduled due to inclement weather."
        })
        
    # Check for MG University postponements
    mg_match = re.search(r'(mahatma gandhi university|mg university)\s(has\s)?(postponed|deferred)', full_body, re.IGNORECASE)
    if mg_match:
        advisories.append({
            "level": "info",
            "title": "MG University Exams Postponed",
            "body": "Mahatma Gandhi (MG) University has postponed pre-scheduled theory and practical exams. Revised dates will be announced later."
        })
        
    # Add general advisory about late-night collector updates
    advisories.insert(0, {
        "level": "warn",
        "title": "Announcements may still be issued tonight",
        "body": "Individual District Collectors continue to review local conditions. Remaining districts under rain warnings may still issue closure orders later tonight."
    })
    
    # Calculate count summary for the headline
    confirmed_count = len([d for d in districts_data if d["status"] == "confirmed" and d["scope"] == "District-wide"])
    partial_count = len([d for d in districts_data if d["status"] == "confirmed" and d["scope"] != "District-wide"])
    
    headline = f"Holidays declared in {confirmed_count} districts"
    if partial_count > 0:
        headline += f" and partial/conditional closures in {partial_count} other districts."
    else:
        headline += "."
        
    status_data = {
        "forDate": target_str,
        "forDateLabel": target_label,
        "checkedAt": checked_at,
        "headline": headline,
        "advisories": advisories,
        "weather": {
            "summary": "Orange alert in force across multiple districts. Heavy to very heavy rainfall expected in isolated areas.",
            "outlook": "IMD forecast predicts continued rain statewide.",
            "impact": "High risk of waterlogging and localized flooding. Relief camps active.",
            "source": {
                "name": "Onmanorama",
                "url": article_url
            }
        },
        "districts": districts_data,
        "debunked": [],
        "limitations": [
            "Parsed automatically from news media reports. Verify with local administrative announcements."
        ]
    }
    
    return status_data

HISTORY_PATH = "data/history.js"
HISTORY_PREFIX = "window.KERALA_HISTORY = "
HISTORY_MAX_AGE_DAYS = 60
HISTORY_MAX_EVENTS = 400


def _tuple_of(d):
    """The fields that decide whether a district actually changed. Deliberately
    raw — classification (declared vs partial) is a product rule that lives only
    in app.js, so history never second-guesses it."""
    return {
        "status": d.get("status"),
        "scope": d.get("scope"),
        "appliesTo": d.get("appliesTo"),
    }


def read_history():
    try:
        with open(HISTORY_PATH, "r", encoding="utf-8") as f:
            raw = f.read()
        start = raw.index(HISTORY_PREFIX) + len(HISTORY_PREFIX)
        end = raw.rindex(";")
        parsed = json.loads(raw[start:end])
        if not isinstance(parsed.get("events"), list):
            raise ValueError("events missing")
        return parsed
    except Exception:
        # A corrupt or absent history must never stop a scrape.
        return {"latest": None, "events": []}


def update_history(data):
    """Appends district transitions to data/history.js, then rewrites it."""
    history = read_history()
    latest = history.get("latest") or {}
    events = history.get("events") or []

    snapshot = {
        "forDate": data["forDate"],
        "districts": {d["name"]: _tuple_of(d) for d in data["districts"]},
    }

    # The 3pm IST rollover resets every district to `none`. Comparing across
    # that boundary would invent 14 "reverted" transitions every single day.
    if latest.get("forDate") == data["forDate"]:
        previous = latest.get("districts") or {}
        for d in data["districts"]:
            before = previous.get(d["name"])
            after = _tuple_of(d)
            if before is not None and before != after:
                events.append({
                    "d": d["name"],
                    "forDate": data["forDate"],
                    "at": data["checkedAt"],
                    "from": before,
                    "to": after,
                })

    cutoff = (datetime.utcnow() + timedelta(hours=5, minutes=30)
              - timedelta(days=HISTORY_MAX_AGE_DAYS)).strftime("%Y-%m-%d")
    events = [e for e in events if e.get("forDate", "") >= cutoff]
    events = events[-HISTORY_MAX_EVENTS:]

    os.makedirs(os.path.dirname(HISTORY_PATH), exist_ok=True)
    payload = {"latest": snapshot, "events": events}
    js_content = f"""/* Kerala Rain Holiday Watch — transition history
 *
 * Appended to on each check, immediately before status.js is overwritten.
 * `latest` is the snapshot the next run compares against; `events` are the
 * district transitions observed within a single target date.
 *
 * Optional: when this file is absent the app simply hides the features that
 * depend on it, so file:// keeps working.
 */
{HISTORY_PREFIX}{json.dumps(payload, indent=2, ensure_ascii=False)};
"""
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        f.write(js_content)

    return len(events)


def write_status_file(data):
    """Writes the parsed holiday data to data/status.js."""
    output_path = "data/status.js"
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    js_content = f"""/* Kerala Rain Holiday Watch — findings data
 *
 * This file is REWRITTEN by the research agent on each check.
 * Nothing here is inferred by the app: every `confirmed` district must
 * carry at least one source with a timestamp. See README.md for the schema.
 *
 * Loaded as a plain script (not fetched) so the app works from file://
 * without a local server.
 */
window.KERALA_STATUS = {json.dumps(data, indent=2, ensure_ascii=False)};
"""
    
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(js_content)
        
    print(f"\n[+] Successfully updated {output_path}!")
    print(f"    Target Date: {data['forDateLabel']} ({data['forDate']})")
    print(f"    Checked At:  {data['checkedAt']}")
    print(f"    Headline:    {data['headline']}")

def write_no_holiday_status(alerts_map=None):
    """Writes a clean 'no holidays declared' status.js for today.
    Called when no today's article is found on Onmanorama, so yesterday's
    stale confirmed data does not persist with a misleading fresh timestamp.
    alerts_map: optional dict {district_name: 'red'|'orange'|'yellow'|'none'}
    from the best available article, used to preserve IMD alert dot colours."""
    today_str, target_str, target_label, checked_at = get_ist_time()
    districts_data = [
        {
            "name": dist,
            "status": "none",
            "alert": (alerts_map.get(dist) if alerts_map else None) or "none",
            "confidence": None,
            "scope": None,
            "appliesTo": None,
            "excludes": None,
            "reason": None,
            "declaredBy": None,
            "exams": None,
            "confidenceNote": None,
            "sources": []
        }
        for dist in DISTRICTS_LIST
    ]
    status_data = {
        "forDate": target_str,
        "forDateLabel": target_label,
        "checkedAt": checked_at,
        "headline": "No district holiday declarations found yet.",
        "advisories": [
            {
                "level": "warn",
                "title": "No holiday articles found for today",
                "body": "No holiday announcements have been detected from Onmanorama for today. "
                        "Collectors may still issue orders later tonight \u2014 check your District Collector directly."
            }
        ],
        "weather": {"summary": "", "outlook": "", "impact": "", "source": {"name": "", "url": ""}},
        "districts": districts_data,
        "debunked": [],
        "limitations": ["Parsed automatically from news media reports. Verify with local administrative announcements."]
    }
    n_events = update_history(status_data)
    write_status_file(status_data)
    print(f"    History:     {n_events} transitions retained")

def segment_text_by_districts(text):
    matches = []
    for dist in DISTRICTS_LIST:
        names_to_check = [dist.lower()] + [n.lower() for n in DISTRICT_TRANSLATIONS.get(dist, [])]
        for name in names_to_check:
            for m in re.finditer(re.escape(name), text.lower()):
                matches.append((m.start(), m.end(), dist))
                
    if not matches:
        return [(text, None)]
        
    matches.sort(key=lambda x: x[0])
    
    unique_matches = []
    for m in matches:
        if not unique_matches or m[0] >= unique_matches[-1][1]:
            unique_matches.append(m)
            
    if not unique_matches:
        return [(text, None)]
        
    segments = []
    num_matches = len(unique_matches)
    for idx in range(num_matches):
        if idx == 0:
            start_idx = 0
        else:
            prev_end = unique_matches[idx-1][1]
            between_text = text[prev_end : unique_matches[idx][0]]
            m_split = re.search(r'(?:,|\band\b|;)', between_text)
            if m_split:
                start_idx = prev_end + m_split.end()
            else:
                start_idx = (prev_end + unique_matches[idx][0]) // 2
                
        if idx == num_matches - 1:
            end_idx = len(text)
        else:
            this_end = unique_matches[idx][1]
            between_text = text[this_end : unique_matches[idx+1][0]]
            m_split = re.search(r'(?:,|\band\b|;)', between_text)
            if m_split:
                end_idx = this_end + m_split.start()
            else:
                end_idx = (this_end + unique_matches[idx+1][0]) // 2
                
        segment_text = text[start_idx:end_idx]
        dist_name = unique_matches[idx][2]
        segments.append((segment_text, dist_name))
        
    return segments

def get_candidate_tier(url, title):
    url_lower = url.lower()
    title_lower = title.lower()
    if "live" in url_lower or "live" in title_lower:
        return 2
    if "holiday" in url_lower or "closures" in url_lower or "അവധി" in title_lower:
        return 1
    return 3

def main():
    print("=== AUTOMATIC HOLIDAY DATA UPDATE AGENT ===")
    
    # 1. Scan for recent candidates
    sources = [
        { "name": "Onmanorama", "url": "https://www.onmanorama.com/news/kerala.html", "domain": "https://www.onmanorama.com" },
        { "name": "Mathrubhumi", "url": "https://www.mathrubhumi.com/news/kerala", "domain": "https://www.mathrubhumi.com" },
        { "name": "Manorama", "url": "https://www.manoramaonline.com/news/latest-news.html", "domain": "https://www.manoramaonline.com" }
    ]
    
    today_str, target_str, target_label, checked_at = get_ist_time()
    
    target_dt = datetime.strptime(target_str, "%Y-%m-%d")
    target_path = target_dt.strftime("%Y/%m/%d")
    yesterday_target_path = (target_dt - timedelta(days=1)).strftime("%Y/%m/%d")
    
    try:
        candidates = []
        for src in sources:
            print(f"Scanning news portal: {src['url']}")
            try:
                response = requests.get(src["url"], headers=HEADERS, timeout=10)
                if response.status_code != 200:
                    continue
                    
                soup = BeautifulSoup(response.text, "html.parser")
                links = soup.find_all("a")
                
                for link in links:
                    href = link.get("href")
                    title = link.text.strip()
                    if not href or not title:
                        continue
                        
                    title_lower = title.lower()
                    href_lower = href.lower()
                    
                    is_holiday_article = False
                    is_rain_breaking_article = False
                    
                    if src["name"] == "Onmanorama":
                        is_holiday_article = "holiday" in title_lower and ("district" in title_lower or "school" in title_lower or "rain" in title_lower)
                        is_rain_breaking_article = ("rain" in title_lower or "flood" in title_lower or "alert" in title_lower) and \
                            ("district" in title_lower or "alert" in title_lower or "holiday" in href_lower or "school" in href_lower)
                    else:
                        # Malayalam sources
                        has_holiday = "അവധി" in title_lower
                        has_school = "സ്കൂൾ" in title_lower or "ക്ലാസ്" in title_lower or "വിദ്യഭ്യാസ" in title_lower or "വിദ്യാഭ്യാസ" in title_lower
                        has_rain = "മഴ" in title_lower or "വെള്ളപ്പൊക്കം" in title_lower
                        has_alert = "അലേർട്ട്" in title_lower
                        has_collector = "കലക്ടർ" in title_lower or "കളക്ടർ" in title_lower
                        
                        is_holiday_article = has_holiday and (has_school or has_rain or has_collector)
                        is_rain_breaking_article = (has_rain or has_alert) and (has_holiday or has_school or has_collector)
                        
                    if is_holiday_article or is_rain_breaking_article:
                        full_href = href if href.startswith("http") else src["domain"] + href
                        candidates.append({"url": full_href, "title": title, "href": href, "source": src["name"]})
            except Exception as e:
                print(f"Error scanning {src['name']}: {e}")
                
        if not candidates:
            print("[-] Fetch failed. Writing no-holiday status.")
            write_no_holiday_status()
            return
            
        # Unique candidates
        seen = set()
        unique_candidates = []
        for c in candidates:
            if c["url"] not in seen:
                seen.add(c["url"])
                unique_candidates.append(c)
                
        # Filter recent
        recent_candidates = []
        for c in unique_candidates:
            if c["source"] == "Mathrubhumi":
                recent_candidates.append(c)
            elif target_path in c["href"] or yesterday_target_path in c["href"]:
                recent_candidates.append(c)
                
        if recent_candidates:
            global_min_tier = min(get_candidate_tier(c["url"], c["title"]) for c in recent_candidates)
            recent_candidates = [c for c in recent_candidates if get_candidate_tier(c["url"], c["title"]) == global_min_tier]
            
            def candidate_score(c):
                c_lower = (c["title"] + " " + c["url"]).lower()
                score = 0
                if "live" in c_lower:
                    score += 2
                if "holiday" in c_lower:
                    score += 2
                return score
                
            recent_candidates.sort(key=candidate_score, reverse=True)
            
            if not recent_candidates:
                print("[-] No recent articles found. Writing no-holiday status.")
                fallback_url = unique_candidates[0]["url"] if unique_candidates else None
                alerts_map = None
                if fallback_url:
                    print(f"[-] Fetching old article for IMD alert data only: {fallback_url}")
                    fallback_body = fetch_article_body(fallback_url)
                    if fallback_body:
                        alerts_map = parse_alerts(fallback_body)
                write_no_holiday_status(alerts_map)
                return
                
            print(f"[+] Found {len(recent_candidates)} recent candidate(s). Processing top 6...")
            
            evidence_map = {}
            chosen_body = ""
            chosen_url = ""
            chosen_title = ""

            for candidate in recent_candidates[:6]:
                print(f"[*] Gathering evidence from: {candidate['title'][:50]}...")
                try:
                    c_res = requests.get(candidate["url"], headers=HEADERS, timeout=10)
                    if c_res.status_code != 200:
                        continue
                        
                    c_soup = BeautifulSoup(c_res.text, "html.parser")
                    
                    # Extract full body for alerts/advisories
                    full_body = ""
                    for script in c_soup.find_all("script", type="application/ld+json"):
                        try:
                            ld = json.loads(script.string or "")
                            if isinstance(ld, dict) and "articleBody" in ld:
                                full_body = ld["articleBody"]
                                break
                        except Exception:
                            pass
                    if not full_body.strip():
                        full_body = "\n".join([p.text.strip() for p in c_soup.find_all("p") if p.text.strip()])
                        
                    if not chosen_body:
                        chosen_body = full_body
                        chosen_url = candidate["url"]
                        chosen_title = candidate["title"]
                        
                    # Fetch holiday-specific paragraphs
                    holiday_body = fetch_holiday_body(candidate["url"], target_str)
                    if not holiday_body.strip():
                        continue
                        
                    paragraphs = [p.strip() for p in holiday_body.split('\n') if p.strip()]
                    
                    # Pre-group readings by district for the current candidate article
                    district_readings_map = {dist: [] for dist in DISTRICTS_LIST}
                    active_district = None

                    for p in paragraphs:
                        p_clean = re.sub(r'^[^:\n•●∙\-\—\|]{2,50}[:•●∙\-\—\|]\s*', '', p)
                        p_lower = p_clean.lower()
                        
                        # Check if this paragraph is a district heading
                        is_heading = False
                        for dist in DISTRICTS_LIST:
                            names_to_check = [dist.lower()] + [n.lower() for n in DISTRICT_TRANSLATIONS.get(dist, [])]
                            clean_p_lower = p_lower.strip().strip(".:-–—*•")
                            if clean_p_lower in names_to_check:
                                active_district = dist
                                is_heading = True
                                break
                        if is_heading:
                            continue

                        # Split paragraph into sentences
                        sentences = re.split(r'(?<=[.!?])\s+', p_clean)
                        for sentence in sentences:
                            sentence = sentence.strip()
                            if not sentence:
                                continue
                                
                            # Find all districts mentioned in the sentence
                            mentioned_dists = []
                            for dist in DISTRICTS_LIST:
                                names_to_check = [dist.lower()] + [n.lower() for n in DISTRICT_TRANSLATIONS.get(dist, [])]
                                if any(name in sentence.lower() for name in names_to_check):
                                    mentioned_dists.append(dist)
                            
                            target_dists = mentioned_dists if mentioned_dists else ([active_district] if active_district else [])
                            if not target_dists:
                                continue
                                
                            base_reading = derive_reading(sentence)
                            if not base_reading:
                                continue
                                
                            # Segment the sentence to isolate taluks per district
                            segments = segment_text_by_districts(sentence)
                            seg_dict = {dist: text for text, dist in segments if dist}
                            
                            for dist in target_dists:
                                reading = dict(base_reading)
                                
                                # Override taluks if multiple districts mentioned in this sentence
                                if len(target_dists) > 1 and dist in seg_dict:
                                    seg_text = seg_dict[dist]
                                    local_taluks = extract_taluks(seg_text)
                                    if local_taluks:
                                        label = ", ".join(local_taluks) + (" taluk" if len(local_taluks) == 1 else " taluks")
                                        if reading["scope"].startswith("Relief camp schools in"):
                                            reading["scope"] = f"Relief camp schools in {label} only"
                                            reading["appliesTo"] = f"Schools functioning as relief camps in {label}."
                                        else:
                                            reading["scope"] = label + " only"
                                            type_label = "Educational institutions except professional colleges" if "except professional colleges" in reading["appliesTo"] else "All educational institutions"
                                            reading["appliesTo"] = type_label + " in " + label + "."
                                            
                                            mentions_relief_camp = ("relief camp" in sentence.lower() or "relief-camp" in sentence.lower() or
                                                                    "ദുരിതാശ്വാസ" in sentence.lower() or "ക്യാമ്പ്" in sentence.lower())
                                            relief_camp_only = mentions_relief_camp and (
                                                "only" in sentence.lower() or "except" in sentence.lower() or "functioning as" in sentence.lower() or
                                                "പ്രവർത്തിക്കുന്ന" in sentence.lower() or "മാത്രം" in sentence.lower())
                                            
                                            if relief_camp_only:
                                                reading["appliesTo"] += " Elsewhere in the district, only schools functioning as relief camps are closed."
                                                reading["excludes"] = "Institutions outside " + label + " that are not relief camps."
                                    else:
                                        # No local taluks, check for relief camp
                                        if "relief camp" in sentence.lower() or "ദുരിതാശ്വാസ" in sentence.lower():
                                            reading["scope"] = "Relief camp schools only"
                                            reading["appliesTo"] = "All schools functioning as relief camps"
                                            reading["excludes"] = "All other educational institutions"
                                            reading["reason"] = "Schools serving as relief camps during floods"
                                
                                district_readings_map[dist].append(reading)

                    # Now, process district_readings_map to update evidence_map
                    for dist in DISTRICTS_LIST:
                        readings = district_readings_map[dist]
                        if readings:
                            if dist not in evidence_map:
                                evidence_map[dist] = []
                            
                            best_reading = pick_best_reading(readings)

                            evidence_map[dist].append({
                                "status": "confirmed",
                                "scope": best_reading["scope"],
                                "appliesTo": best_reading["appliesTo"],
                                "excludes": best_reading["excludes"],
                                "reason": best_reading["reason"],
                                "qualified": best_reading.get("qualified", False),
                                "tier": get_candidate_tier(candidate["url"], candidate["title"]),
                                "source": {
                                    "name": candidate.get("source", "Onmanorama"),
                                    "title": candidate["title"],
                                    "url": candidate["url"]
                                }
                            })
                except Exception as e:
                    print(f"Error processing candidate {candidate['title']}: {e}")
                    
            if not chosen_body:
                print("[-] Empty body. Writing no-holiday status.")
                write_no_holiday_status()
                return
                
            # Parse alerts & advisories
            alerts_map = parse_alerts(chosen_body)
            advisories = []
            
            psc_match = re.search(r'PSC\s(has\s)?(cancelled|postponed|deferred)', chosen_body, re.IGNORECASE)
            if psc_match or "kerala public service commission" in chosen_body.lower():
                advisories.append({
                    "level": "info",
                    "title": "Kerala PSC Exams Postponed",
                    "body": "The Kerala Public Service Commission (PSC) has cancelled/postponed OMR and online exams scheduled due to inclement weather."
                })
                
            mg_match = re.search(r'(mahatma gandhi university|mg university)\s(has\s)?(postponed|deferred)', chosen_body, re.IGNORECASE)
            if mg_match:
                advisories.append({
                    "level": "info",
                    "title": "MG University Exams Postponed",
                    "body": "Mahatma Gandhi (MG) University has postponed pre-scheduled theory and practical exams. Revised dates will be announced later."
                })
                
            advisories.insert(0, {
                "level": "warn",
                "title": "Announcements may still be issued tonight",
                "body": "Individual District Collectors continue to review local conditions. Remaining districts under rain warnings may still issue closure orders later tonight."
            })
            
            # Merge multi-source verdicts
            districts_data = []
            for dist in DISTRICTS_LIST:
                if dist in evidence_map:
                    readings = evidence_map[dist]
                    source_count = len(set(r["source"]["name"] for r in readings))
                    
                    confidence = 60
                    if source_count >= 3:
                        confidence = 92
                    elif source_count >= 2:
                        confidence = 80
                        
                    confidence_note = f"Reported by {', '.join(r['source']['name'] for r in readings)}."
                    # Filter readings to only keep those from the highest priority tier present (minimum tier value)
                    min_tier = min(r.get("tier", 1) for r in readings)
                    filtered_readings = [r for r in readings if r.get("tier", 1) == min_tier]
                    
                    best_reading = pick_best_reading(filtered_readings)

                    districts_data.append({
                        "name": dist,
                        "status": "confirmed",
                        "alert": alerts_map.get(dist, "none"),
                        "confidence": confidence,
                        "scope": best_reading["scope"],
                        "appliesTo": best_reading["appliesTo"],
                        "excludes": best_reading["excludes"],
                        "reason": best_reading["reason"],
                        "declaredBy": f"District Collector, {dist}",
                        "exams": "Scheduled public and university examinations proceed unless specified.",
                        "confidenceNote": confidence_note,
                        "sources": [{
                            "name": r["source"]["name"],
                            "title": r["source"]["title"],
                            "url": r["source"]["url"],
                            "time": "Latest Update",
                            "tier": 1
                        } for r in readings]
                    })
                else:
                    districts_data.append({
                        "name": dist,
                        "status": "none",
                        "alert": alerts_map.get(dist, "none"),
                        "confidence": None,
                        "scope": None,
                        "appliesTo": None,
                        "excludes": None,
                        "reason": None,
                        "declaredBy": None,
                        "exams": None,
                        "confidenceNote": None,
                        "sources": []
                    })
                    
            # Headline
            confirmed_count = len([d for d in districts_data if d["status"] == "confirmed" and d["scope"] == "District-wide"])
            partial_count = len([d for d in districts_data if d["status"] == "confirmed" and d["scope"] != "District-wide"])
            
            def _plural(n):
                return "district" if n == 1 else "districts"

            # A day with only taluk or relief-camp orders is now the common case,
            # so it gets its own sentence rather than "declared in 0 districts".
            if confirmed_count == 0 and partial_count > 0:
                headline = f"Partial/conditional closures in {partial_count} {_plural(partial_count)}. No district-wide holiday declared."
            else:
                headline = f"Holidays declared in {confirmed_count} {_plural(confirmed_count)}"
                if partial_count > 0:
                    headline += f" and partial/conditional closures in {partial_count} other {_plural(partial_count)}."
                else:
                    headline += "."

            status_data = {
                "forDate": target_str,
                "forDateLabel": target_label,
                "checkedAt": checked_at,
                "headline": headline,
                "advisories": advisories,
                "weather": {
                    "summary": "Orange alert in force across multiple districts. Heavy to very heavy rainfall expected in isolated areas.",
                    "outlook": "IMD forecast predicts continued rain statewide.",
                    "impact": "High risk of waterlogging and localized flooding. Relief camps active.",
                    "source": {
                        "name": "Onmanorama",
                        "url": chosen_url
                    }
                },
                "districts": districts_data,
                "debunked": [],
                "limitations": [
                    "Parsed automatically from news media reports. Verify with local administrative announcements."
                ]
            }
            
            n_events = update_history(status_data)
            write_status_file(status_data)
            print(f"    History:     {n_events} transitions retained")
        
    except Exception as e:
        print(f"Main run error: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()
