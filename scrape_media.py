import requests
from bs4 import BeautifulSoup
import re
import time
import sys

# Reconfigure stdout to support Malayalam and other Unicode characters in Windows terminal
sys.stdout.reconfigure(encoding='utf-8')

# Extensive keyword list for identifying rain holiday announcements
KEYWORDS_EN = [
    r"holiday", r"declared", r"closure", r"schools", r"colleges", r"anganwadi",
    r"educational institutions", r"tuition", r"postponed", r"exams", r"heavy rain"
]

KEYWORDS_ML = [
    r"അവധി",                         # Avathi (Holiday)
    r"മഴ",                           # Mazha (Rain)
    r"കലക്ടർ",                       # Collector
    r"അറിയിപ്പ്",                     # Ariyippu (Notice / Announcement)
    r"വിദ്യാഭ്യാസ സ്ഥാപനങ്ങൾക്ക്",    # Educational Institutions
    r"ക്ലാസുകൾ",                     # Classes
    r"ഉത്തരവ്",                       # Order
    r"റെഡ് അലേർട്ട്",                  # Red Alert
    r"ഓറഞ്ച് അലേർട്ട്",                # Orange Alert
]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
}

def check_text(text, keywords):
    """Utility to match text against a list of keywords using regex."""
    text_lower = text.lower()
    matched = []
    for kw in keywords:
        if re.search(kw, text_lower):
            matched.append(kw)
    return len(matched) > 0, matched

def scrape_onmanorama():
    """Scrapes the Kerala News section of Onmanorama (English)."""
    url = "https://www.onmanorama.com/news/kerala.html"
    print(f"\n--- Scraping Onmanorama: {url} ---")
    
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        if response.status_code != 200:
            print(f"[-] Failed to fetch Onmanorama. Status code: {response.status_code}")
            return
        
        soup = BeautifulSoup(response.text, "html.parser")
        
        # Onmanorama lists stories in articles or list items. 
        # Title links typically have classes like 'cmp-story-list__title' or 'story-list__title'
        stories = soup.find_all(["h1", "h2", "h3", "h4", "a"])
        
        found_announcements = []
        seen_urls = set()
        
        for story in stories:
            # Check if element contains a link
            link = None
            if story.name == "a":
                link = story
            else:
                link = story.find("a")
                
            if not link:
                continue
                
            href = link.get("href")
            title_text = link.text.strip()
            
            if not href or not title_text or len(title_text) < 15:
                continue
                
            # Make sure it's a relative/absolute path to news
            if not href.startswith("http"):
                href = "https://www.onmanorama.com" + href
                
            if href in seen_urls:
                continue
            
            seen_urls.add(href)
            
            # Check for rain holiday keywords
            is_relevant, matched_kws = check_text(title_text, KEYWORDS_EN)
            
            if is_relevant:
                found_announcements.append({
                    "title": title_text,
                    "url": href,
                    "matches": matched_kws
                })
                
        print(f"Scanned {len(seen_urls)} unique news articles.")
        if found_announcements:
            print(f"[+] Found {len(found_announcements)} potential holiday updates:")
            for item in found_announcements:
                print(f"\n  * Title: {item['title']}")
                print(f"    URL: {item['url']}")
                print(f"    Matches: {', '.join(item['matches'])}")
        else:
            print("No holiday updates found on the Onmanorama Kerala homepage.")
            
    except Exception as e:
        print(f"Error scraping Onmanorama: {e}")

def scrape_mathrubhumi():
    """Scrapes the Kerala news section of Mathrubhumi (Malayalam)."""
    url = "https://www.mathrubhumi.com/news/kerala"
    print(f"\n--- Scraping Mathrubhumi: {url} ---")
    
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        if response.status_code != 200:
            print(f"[-] Failed to fetch Mathrubhumi. Status code: {response.status_code}")
            return
        
        soup = BeautifulSoup(response.text, "html.parser")
        
        # Mathrubhumi titles are usually inside headings or links with specific styling classes.
        stories = soup.find_all("a")
        
        found_announcements = []
        seen_urls = set()
        
        for link in stories:
            href = link.get("href")
            title_text = link.text.strip()
            
            if not href or not title_text or len(title_text) < 10:
                continue
                
            if not href.startswith("http"):
                href = "https://www.mathrubhumi.com" + href
                
            if href in seen_urls:
                continue
                
            seen_urls.add(href)
            
            # Match against Malayalam keywords
            is_relevant, matched_kws = check_text(title_text, KEYWORDS_ML)
            
            if is_relevant:
                found_announcements.append({
                    "title": title_text,
                    "url": href,
                    "matches": matched_kws
                })
                
        print(f"Scanned {len(seen_urls)} unique news articles.")
        if found_announcements:
            print(f"[+] Found {len(found_announcements)} potential Malayalam updates:")
            for item in found_announcements:
                print(f"\n  * Title: {item['title']}")
                print(f"    URL: {item['url']}")
                print(f"    Matches: {', '.join(item['matches'])}")
        else:
            print("No holiday updates found on the Mathrubhumi Kerala homepage.")
            
    except Exception as e:
        print(f"Error scraping Mathrubhumi: {e}")

def main():
    print("Starting Media Scraper...")
    
    # 1. Scrape Onmanorama (English)
    scrape_onmanorama()
    
    # 2. Scrape Mathrubhumi (Malayalam)
    scrape_mathrubhumi()

if __name__ == "__main__":
    main()
