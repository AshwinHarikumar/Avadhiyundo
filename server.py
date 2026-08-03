import http.server
import socketserver
import threading
import time
import json
import auto_update

PORT = 8000

# Scrape cooldown settings to prevent rate-limiting/banning
LAST_SCRAPE_TIME = 0
SCRAPE_COOLDOWN = 60  # seconds (1 minute safety limit)
scrape_lock = threading.Lock()

def trigger_manual_scrape():
    global LAST_SCRAPE_TIME
    now = time.time()
    
    # Check cooldown
    if now - LAST_SCRAPE_TIME < SCRAPE_COOLDOWN:
        remaining = int(SCRAPE_COOLDOWN - (now - LAST_SCRAPE_TIME))
        return False, f"Scrape on cooldown. Please wait {remaining} seconds."
    
    # Use lock to make sure only one thread scrapes at a time
    if not scrape_lock.acquire(blocking=False):
        return False, "Another scraping task is already in progress."
        
    try:
        print("[Server] Triggering manual scrape...")
        auto_update.main()
        LAST_SCRAPE_TIME = time.time()
        return True, "Scrape completed successfully."
    except Exception as e:
        print(f"[Server] Manual scrape error: {e}")
        return False, f"Scrape failed: {str(e)}"
    finally:
        scrape_lock.release()

def run_scraper_loop():
    global LAST_SCRAPE_TIME
    print("[Server] Starting background scraper loop...")
    while True:
        try:
            now = time.time()
            if now - LAST_SCRAPE_TIME >= SCRAPE_COOLDOWN:
                with scrape_lock:
                    print("[Server] Running background auto-update scraper...")
                    auto_update.main()
                    LAST_SCRAPE_TIME = time.time()
        except Exception as e:
            print(f"[Server] Background scraper loop error: {e}")
        
        # Check every 30 seconds if we need to do a background scrape
        time.sleep(30)

class NoCacheHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        # Route to execute a manual scrape request from frontend
        if self.path == "/api/scrape" or self.path == "/api/refresh":
            success, msg = trigger_manual_scrape()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            response_json = json.dumps({"success": success, "message": msg})
            self.wfile.write(response_json.encode('utf-8'))
            return
        elif self.path == "/" or self.path == "/index.html":
            # Trigger background scrape if cooldown has passed
            threading.Thread(target=trigger_manual_scrape, daemon=True).start()
            
        super().do_GET()

    def end_headers(self):
        # Disable caching completely so UI updates immediately
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        # Enable CORS so separately hosted frontend can load this resource
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

def run_web_server():
    # Allow port reuse on restart
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("", PORT), NoCacheHTTPRequestHandler) as httpd:
        print(f"[Server] Serving Kerala Rain Holiday Watch at http://localhost:{PORT}")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("[Server] Shutting down...")
            httpd.shutdown()

if __name__ == "__main__":
    # Start the scraper background thread
    scraper_thread = threading.Thread(target=run_scraper_loop, daemon=True)
    scraper_thread.start()
    
    # Run the web server in the main thread
    run_web_server()
