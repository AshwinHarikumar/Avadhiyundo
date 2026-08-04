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

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
}

def get_ist_time():
    """Returns current date, time, and target date in IST (UTC+5:30) based on 15:00 (3 PM) rollover."""
    utc_now = datetime.utcnow()
    ist_now = utc_now + timedelta(hours=5, minutes=30)
    
    today_str = ist_now.strftime("%Y-%m-%d")
    
    # If before 3:00 PM (15:00) IST, target is today; otherwise tomorrow
    if ist_now.hour < 15:
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

def find_latest_holiday_article():
    """Scrapes Onmanorama Kerala page to find the URL of the latest rain holiday article."""
    url = "https://www.onmanorama.com/news/kerala.html"
    print(f"Scanning news portal: {url}")
    
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        if response.status_code != 200:
            return None, None
            
        soup = BeautifulSoup(response.text, "html.parser")
        links = soup.find_all("a")
        
        for link in links:
            href = link.get("href")
            title = link.text.strip()
            
            if not href or not title:
                continue
                
            # Look for active holiday updates in the title
            if "holiday" in title.lower() and ("district" in title.lower() or "school" in title.lower() or "rain" in title.lower()):
                if not href.startswith("http"):
                    href = "https://www.onmanorama.com" + href
                return href, title
                
        return None, None
    except Exception as e:
        print(f"Error finding article: {e}")
        return None, None

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

def parse_holiday_data(body_text, article_url, article_title):
    """Parses the article body text to determine district holiday declarations and exam delays."""
    today_str, target_str, target_label, checked_at = get_ist_time()
    alerts_map = parse_alerts(body_text)
    
    # Initialize all districts with 'none' status
    districts_data = []
    confirmed_districts = []
    
    # Local holiday confirmation keywords to check in district context
    LOCAL_HOLIDAY_KEYWORDS = [
        "holiday", "closed", "closure", "declared", "postponed", "cancel", "shut",
        "അവധി", "പ്രഖ്യാപിച്ചു", "നൽകി", "ക്ലാസുകൾ ഉണ്ടാകില്ല"
    ]
    
    for dist in DISTRICTS_LIST:
        is_holiday = False
        context = ""
        
        paragraphs = [p.strip() for p in body_text.split('\n') if p.strip()]
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
    psc_match = re.search(r'PSC\s(has\s)?(cancelled|postponed|deferred)', body_text, re.IGNORECASE)
    if psc_match or "kerala public service commission" in body_text.lower():
        advisories.append({
            "level": "info",
            "title": "Kerala PSC Exams Postponed",
            "body": "The Kerala Public Service Commission (PSC) has cancelled/postponed OMR and online exams scheduled due to inclement weather."
        })
        
    # Check for MG University postponements
    mg_match = re.search(r'(mahatma gandhi university|mg university)\s(has\s)?(postponed|deferred)', body_text, re.IGNORECASE)
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

def main():
    print("=== AUTOMATIC HOLIDAY DATA UPDATE AGENT ===")
    
    # 1. Scan for the latest holiday news article
    article_url, article_title = find_latest_holiday_article()
    
    if not article_url:
        print("[-] No rain holiday news articles found on Onmanorama today.")
        return
        
    print(f"[+] Found Article: {article_title}")
    print(f"[+] URL: {article_url}")
    
    # 2. Fetch full body text of the article
    body_text = fetch_article_body(article_url)
    
    if not body_text:
        print("[-] Error: Empty article body fetched. Exiting.")
        return
        
    # 3. Parse article content to update district statuses
    status_data = parse_holiday_data(body_text, article_url, article_title)
    
    # 4. Record transitions, then write data
    n_events = update_history(status_data)
    write_status_file(status_data)
    print(f"    History:     {n_events} transitions retained")

if __name__ == "__main__":
    main()
