#!/usr/bin/env python3
"""
DEPRECATED — Superseded by fb_scraper.py

This was the proof-of-concept Facebook scraper, covering only 3 districts and
requiring manual login every run. fb_scraper.py is the production version:
  - Covers all 14 districts
  - Tries logged-out mbasic first, falls back to the logged-in profile
  - OCRs image posters with Tesseract
  - Outputs structured JSON for server.js

Kept for reference only.
"""
import time
import re
import os
import sys
from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
from webdriver_manager.chrome import ChromeDriverManager

# Dictionary of official Facebook page handles for all 14 Kerala District Collectors.
COLLECTOR_PAGES = {
    "Thiruvananthapuram": "https://www.facebook.com/TvmCollector",
    "Kollam": "https://www.facebook.com/kollamcollector",
    "Pathanamthitta": "https://www.facebook.com/dcpathanamthitta",
    "Alappuzha": "https://www.facebook.com/collectoralappuzha",
    "Kottayam": "https://www.facebook.com/CollectorKottayam",
    "Idukki": "https://www.facebook.com/CollectorIdukki",
    "Ernakulam": "https://www.facebook.com/ErnakulamCollector",
    "Thrissur": "https://www.facebook.com/thrissurcollector",
    "Palakkad": "https://www.facebook.com/CollectorPalakkad",
    "Malappuram": "https://www.facebook.com/CollectorMalappuram",
    "Kozhikode": "https://www.facebook.com/CollectorKozhikode",
    "Wayanad": "https://www.facebook.com/collectorwayanad",
    "Kannur": "https://www.facebook.com/KannurCollector",
    "Kasaragod": "https://www.facebook.com/KasaragodCollector"
}

# Extensive list of English and Malayalam keywords for Rain Holiday Announcements.
KEYWORDS = [
    # English Keywords
    r"holiday", r"declared", r"closure", r"schools", r"colleges", r"anganwadi",
    r"educational institutions", r"tuition", r"postponed", r"exams", r"heavy rain",
    
    # Malayalam Keywords
    r"അവധി",                         # Avathi (Holiday)
    r"മഴ",                           # Mazha (Rain)
    r"കലക്ടർ",                       # Collector
    r"അറിയിപ്പ്",                     # Ariyippu (Notice / Announcement)
    r"വിദ്യാഭ്യാസ സ്ഥാപനങ്ങൾക്ക്",    # Educational Institutions
    r"പ്രൊഫഷണൽ കോളേജുകൾ",            # Professional Colleges
    r"ക്ലാസുകൾ",                     # Classes
    r"ഉത്തരവ്",                       # Order
    r"റെഡ് അലേർട്ട്",                  # Red Alert
    r"ഓറഞ്ച് അലേർട്ട്",                # Orange Alert
    r"ദുരന്ത നിവാരണ"                  # Disaster Management
]

def check_for_keywords(text):
    """Checks if the text contains any holiday or rain keywords (English or Malayalam)."""
    text_lower = text.lower()
    matched_words = []
    for kw in KEYWORDS:
        if re.search(kw, text_lower):
            matched_words.append(kw)
    return len(matched_words) > 0, matched_words

def setup_driver(headless=False, local_profile_path=None):
    """Sets up Chrome WebDriver using a local workspace profile directory."""
    chrome_options = Options()
    
    chrome_options.add_argument("--disable-blink-features=AutomationControlled")
    chrome_options.add_experimental_option("excludeSwitches", ["enable-automation"])
    chrome_options.add_experimental_option("useAutomationExtension", False)
    chrome_options.add_argument("--no-sandbox")
    chrome_options.add_argument("--disable-dev-shm-usage")
    chrome_options.add_argument("user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36")
    
    if local_profile_path:
        # Create profile directory if it doesn't exist
        os.makedirs(local_profile_path, exist_ok=True)
        abs_profile_path = os.path.abspath(local_profile_path)
        print(f"Using local browser profile folder: {abs_profile_path}")
        chrome_options.add_argument(f"user-data-dir={abs_profile_path}")
        chrome_options.add_argument("profile-directory=Default")
        
    if headless:
        chrome_options.add_argument("--headless")
        chrome_options.add_argument("--disable-gpu")
    else:
        chrome_options.add_argument("--start-maximized")
    
    service = Service(ChromeDriverManager().install())
    driver = webdriver.Chrome(service=service, options=chrome_options)
    return driver

def check_facebook_login_status(driver):
    """Checks if the browser has a logged-in Facebook session."""
    driver.get("https://www.facebook.com/")
    time.sleep(4)
    body_text = driver.find_element(By.TAG_NAME, "body").text
    
    # If the page asks for email/password or "Log in", it means we're not logged in.
    if "Log in" in body_text and ("Forgotten password?" in body_text or "Create new account" in body_text):
        return False
    return True

def scrape_collector_page(driver, district, url):
    """Scrapes the latest posts from a collector's Facebook page."""
    print(f"\nScanning {district} District Collector Page...")
    
    try:
        driver.get(url)
        time.sleep(6)
        
        # Verify if blocked by login page redirect
        page_title = driver.title
        if "Log in" in page_title or "Facebook" == page_title:
            body_text = driver.find_element(By.TAG_NAME, "body").text
            if "Log in" in body_text or "This content isn't available" in body_text:
                print(f"[-] Blocked by Facebook Login wall for {district}.")
                return

        # Locate posts on desktop layout.
        posts = driver.find_elements(By.XPATH, "//div[@role='article']")
        
        if not posts:
            # Fallback for feed elements
            posts = driver.find_elements(By.XPATH, "//div[contains(@data-ad-preview, 'message')] | //div[@role='feed']/div")

        print(f"Found {len(posts)} potential post elements on page.")
        
        relevant_found = False
        for i, post in enumerate(posts[:5]):  # Scan latest 5 posts
            try:
                post_text = post.text.strip()
                if not post_text:
                    continue
                
                is_relevant, matched_kws = check_for_keywords(post_text)
                
                # Truncate text for display
                display_text = post_text[:300] + "..." if len(post_text) > 300 else post_text
                
                if is_relevant:
                    relevant_found = True
                    print(f"\n[!] MATCH FOUND (Post #{i+1})")
                    print(f"Matched Keywords: {', '.join(matched_kws)}")
                    print(f"Content:\n{display_text}")
                    print("-" * 50)
            except Exception as e:
                continue
                
        if not relevant_found:
            print("No recent rain/holiday announcements detected.")
            
    except Exception as e:
        print(f"Error scraping {district}: {str(e)}")

def main():
    # Local directory to store Chrome profile cookies/session inside the project folder
    local_profile = "./fb_chrome_profile"
    
    # 1. Start browser in visible (non-headless) mode using the local profile folder
    # This avoids locking your primary Chrome browser profile.
    print("Launching Chrome using local workspace profile folder...")
    driver = setup_driver(headless=False, local_profile_path=local_profile)
    
    try:
        # 2. Check if already logged in to Facebook in this local profile
        is_logged_in = check_facebook_login_status(driver)
        
        if not is_logged_in:
            print("\n" + "="*70)
            print("[!] NOT LOGGED IN TO FACEBOOK")
            print("A browser window has opened. Please LOG IN to Facebook manually in that window.")
            print("Once you are logged in and see your home feed, come back here and press Enter.")
            print("="*70 + "\n")
            input("Press Enter after logging in to Facebook...")
            
            # Recheck login status
            if not check_facebook_login_status(driver):
                print("[-] Login verification failed. Exiting.")
                return
            else:
                print("[+] Login verified! Session saved to './fb_chrome_profile'.")
        else:
            print("[+] Login verified from saved session.")
            
        # 3. Scan key districts
        districts_to_check = ["Ernakulam", "Kozhikode", "Pathanamthitta"]
        for dist in districts_to_check:
            url = COLLECTOR_PAGES[dist]
            scrape_collector_page(driver, dist, url)
            time.sleep(3)
            
    finally:
        driver.quit()
        print("\nScraping complete. Browser closed.")

if __name__ == "__main__":
    main()
