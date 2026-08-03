# Kerala Rain Holiday Watch

A lightweight, static web application and automated scraper that aggregates and displays verified rain-holiday declarations for all 14 districts in Kerala. 

## Overview
During monsoon season in Kerala, District Collectors often declare educational holidays late at night based on rain alerts. This project provides a fast, trustworthy, and accessible dashboard to answer a single question for students and parents: **"Is my district off tomorrow?"**

The platform distinguishes between confirmed holidays, unconfirmed rumours, partial closures, and actively debunked claims.

## Features
- **Static First:** Plain static HTML/CSS/JS frontend. No framework, no build step, no network required at render time (works directly from `file://`).
- **Clear Information Hierarchy:** Status is clearly indicated without needing interpretation. Confirmed, partial, unconfirmed, and debunked statuses are visually distinct.
- **Reliable Data:** Every `confirmed` district carries at least one dated source and a declaring authority.
- **Accessibility:** Designed primarily for phone screens at night in poor lighting. Status is not conveyed by color alone.
- **Automated Scrapers:** Background Python scripts run periodically to aggregate declarations and update the data out-of-band.

## Data Sources
The application scrapes data from official and reliable media sources:
- **Official Announcements:** 
  - Official Facebook pages of all 14 Kerala District Collectors (e.g., Thiruvananthapuram, Ernakulam, Kozhikode, etc.) via `scrape_collectors.py`.
- **Media Reports:** 
  - **Onmanorama** (English News)
  - **Mathrubhumi** (Malayalam News)
  - Managed via `scrape_media.py`.

## Tech Stack
- **Frontend:** HTML5, Vanilla CSS, Vanilla JavaScript.
- **Backend/Data:** Node.js (Express server to serve the static generated `data/status.js` and provide an instant scrape trigger endpoint).
- **Scraping Engine:** Python (BeautifulSoup, Selenium, Requests) to extract holiday announcements from social media and news portals.

## Project Structure
- `index.html`, `app.css`, `app.js` - The frontend application.
- `data/status.js` - The compiled JSON-like data file containing the current holiday statuses.
- `server.js` - Node.js Express server to serve data and trigger scraping.
- `scrape_collectors.py`, `scrape_media.py` - Scrapers for fetching data from sources.
- `auto_update.py`, `cron_update.sh` - Scripts for automating the scraping process.

## Setup and Deployment

### Running Locally
1. Clone the repository.
2. Install Node.js dependencies:
   ```bash
   npm install
   ```
3. Run the Node.js server:
   ```bash
   npm start
   ```
4. The server runs on port 8000. You can also simply open `index.html` in your browser.

### Scraping
To run the scrapers manually:
```bash
pip install -r requirements.txt
python scrape_media.py
python scrape_collectors.py
```


## Disclaimer
This project is an independent platform and is **not affiliated with any government entity**. Always refer to official government orders for final confirmation.
