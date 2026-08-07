const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { runScraper } = require('./server');

const RENDER_URL = process.env.RENDER_URL;
const SCRAPER_API_TOKEN = process.env.SCRAPER_API_TOKEN;

if (!RENDER_URL || !SCRAPER_API_TOKEN) {
  console.error("\x1b[31m[Error] Both RENDER_URL and SCRAPER_API_TOKEN environment variables must be set.\x1b[0m");
  console.error("Usage: RENDER_URL=https://your-app.onrender.com SCRAPER_API_TOKEN=your-secret node run_and_push.js");
  process.exit(1);
}

// Clean target RENDER_URL to remove trailing slash
const cleanRenderUrl = RENDER_URL.replace(/\/$/, "");

// Helper to read current status from status.js
function readCurrentStatus() {
  try {
    const statusPath = path.join(__dirname, 'data', 'status.js');
    if (!fs.existsSync(statusPath)) return null;
    const raw = fs.readFileSync(statusPath, 'utf-8');
    const startPrefix = "window.KERALA_STATUS = ";
    const start = raw.indexOf(startPrefix) + startPrefix.length;
    const end = raw.lastIndexOf(';');
    return JSON.parse(raw.slice(start, end));
  } catch (e) {
    console.error("[Runner] Error parsing status.js:", e.message);
    return null;
  }
}

async function main() {
  console.log("=========================================");
  console.log("🌧  KERALA RAIN HOLIDAY WATCH - LOCAL RUNNER");
  console.log("=========================================");
  console.log(`[Runner] Starting local scraper execution...`);
  
  // Disable local database notifications/polling on the Azure system
  process.env.TELEGRAM_BOT_TOKEN = ""; // Ensure local bot is disabled
  
  try {
    // Run the scraper pipeline (downloads posts, parses text/OCR, writes local files)
    const success = await runScraper();
    if (!success) {
      console.error("\x1b[31m[Runner] Scraper execution failed locally.\x1b[0m");
      process.exit(1);
    }
    
    // Read the generated status
    const statusData = readCurrentStatus();
    if (!statusData) {
      console.error("\x1b[31m[Runner] Failed to read status data from local files.\x1b[0m");
      process.exit(1);
    }
    
    console.log(`\n[Runner] Successfully compiled local holiday status.`);
    console.log(`[Runner] Pushing status to Render: ${cleanRenderUrl}...`);
    
    const response = await axios.post(`${cleanRenderUrl}/api/push-status`, {
      token: SCRAPER_API_TOKEN,
      statusData: statusData
    }, { timeout: 30000 });
    
    console.log(`\x1b[32m[Runner] Render response: success=${response.data.success}, message="${response.data.message}"\x1b[0m`);
    console.log("[Runner] Scrape and push completed successfully!");
    process.exit(0);
  } catch (err) {
    console.error("\x1b[31m[Runner] Execution crashed:\x1b[0m", err.message);
    if (err.response && err.response.data) {
      console.error("[Runner] Render Error Details:", err.response.data);
    }
    process.exit(1);
  }
}

main();
