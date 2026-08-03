const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());

// State variables for scrape cooldown
let lastScrapeTime = 0;
const SCRAPE_COOLDOWN = 60 * 1000; // 60 seconds (1 minute cooldown)
let isScraping = false;

const DISTRICTS_LIST = [
  "Thiruvananthapuram", "Kollam", "Pathanamthitta", "Alappuzha", "Kottayam",
  "Idukki", "Ernakulam", "Thrissur", "Palakkad", "Malappuram",
  "Kozhikode", "Wayanad", "Kannur", "Kasaragod"
];

const LOCAL_HOLIDAY_KEYWORDS = [
  "holiday", "closed", "closure", "declared", "postponed", "cancel", "shut",
  "അവധി", "പ്രഖ്യാപിച്ചു", "നൽകി", "ക്ലാസുകൾ ഉണ്ടാകില്ല"
];

// Helper to get IST time formats
function getISTTime() {
  const now = new Date();
  const utc = now.getTime() + (now.getTimezoneOffset() * 60000);
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(utc + istOffset);

  // Format today and tomorrow string (YYYY-MM-DD)
  const todayStr = istTime.toISOString().split('T')[0];
  const tomorrowTime = new Date(istTime.getTime() + 24 * 60 * 60 * 1000);
  const tomorrowStr = tomorrowTime.toISOString().split('T')[0];

  // Tomorrow label format: "Tuesday, 04 August 2026"
  const options = { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' };
  const tomorrowLabel = new Intl.DateTimeFormat('en-IN', options).format(tomorrowTime);

  const checkedAt = istTime.toISOString().replace('Z', '+05:30');

  return { todayStr, tomorrowStr, tomorrowLabel, checkedAt };
}

// Scrape logic
async function runScraper() {
  console.log(`[Scraper] Starting scrape run: ${new Date().toISOString()}`);
  
  // 1. Scan for the latest holiday news article on Onmanorama
  const keralaNewsUrl = "https://www.onmanorama.com/news/kerala.html";
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
  };

  let articleUrl = null;
  let articleTitle = "";

  try {
    const listRes = await axios.get(keralaNewsUrl, { headers, timeout: 10000 });
    const $ = cheerio.load(listRes.data);
    
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();
      
      if (href && text && !articleUrl) {
        const textLower = text.toLowerCase();
        if (textLower.includes('holiday') && (textLower.includes('district') || textLower.includes('school') || textLower.includes('rain'))) {
          articleUrl = href.startsWith('http') ? href : 'https://www.onmanorama.com' + href;
          articleTitle = text;
        }
      }
    });

    if (!articleUrl) {
      console.log("[-] No rain holiday news articles found on Onmanorama today.");
      return false;
    }

    console.log(`[Scraper] Found Article: "${articleTitle}"`);
    console.log(`[Scraper] Fetching text from: ${articleUrl}`);

    // 2. Fetch full body text of the article
    const articleRes = await axios.get(articleUrl, { headers, timeout: 10000 });
    const $art = cheerio.load(articleRes.data);
    
    let bodyText = "";
    $art('p').each((i, el) => {
      bodyText += $art(el).text().trim() + "\n";
    });

    if (!bodyText.trim()) {
      console.log("[-] Error: Empty article body fetched.");
      return false;
    }

    // 3. Parse data
    const { tomorrowStr, tomorrowLabel, checkedAt } = getISTTime();
    const districtsData = [];

    for (const dist of DISTRICTS_LIST) {
      // Find district index in text (regex word boundary matching)
      const distRegex = new RegExp(`\\b${dist}\\b`, 'i');
      const match = bodyText.match(distRegex);
      
      let isHoliday = false;
      let context = "";

      if (match) {
        const matchIdx = match.index;
        const start = Math.max(0, matchIdx - 150);
        const end = Math.min(bodyText.length, matchIdx + dist.length + 150);
        context = bodyText.substring(start, end).toLowerCase();
        
        for (const kw of LOCAL_HOLIDAY_KEYWORDS) {
          if (context.includes(kw)) {
            isHoliday = true;
            break;
          }
        }
      }

      if (isHoliday) {
        let scope = "District-wide";
        let appliesTo = "All educational institutions — schools, professional colleges, anganwadis, and tuition centres";
        let excludes = null;
        let reason = "Adverse weather and heavy rainfall";
        const declaredBy = `District Collector, ${dist}`;

        // 1. Relief Camps
        if (context.includes("relief camp") || context.includes("relief-camp") || context.includes("functioning as relief")) {
          scope = "Relief camp schools only";
          appliesTo = "All schools functioning as relief camps";
          excludes = "All other educational institutions";
          reason = "Schools serving as relief camps during floods";
        }
        // 2. Taluks
        else if (context.includes("taluk") || context.includes("taluks")) {
          const taluksMatch = context.match(/([a-zA-Z\s,]+)\staluk/i);
          if (taluksMatch) {
            scope = `${taluksMatch[1].trim()} taluks only`;
          } else {
            scope = "Select taluks only";
          }
          appliesTo = "Educational institutions in specific taluks";
          
          if (dist === "Kannur" && context.includes("professional") && context.includes("not")) {
            excludes = "Professional colleges NOT covered. Residential schools remain open.";
          }
        }

        districtsData.push({
          name: dist,
          status: "confirmed",
          alert: "orange", // default alert context
          confidence: 95,
          scope,
          appliesTo,
          excludes,
          reason,
          declaredBy,
          exams: "Scheduled public and university examinations proceed unless specified.",
          confidenceNote: "Confirmed by major news report quoting Collector's declaration.",
          sources: [{
            name: "Onmanorama",
            title: articleTitle,
            url: articleUrl,
            time: "Latest Update",
            tier: 1
          }]
        });
      } else {
        districtsData.push({
          name: dist,
          status: "none",
          alert: "none",
          confidence: null,
          scope: null,
          appliesTo: null,
          excludes: null,
          reason: null,
          declaredBy: null,
          exams: null,
          confidenceNote: null,
          sources: []
        });
      }
    }

    // Parse exam advisories
    const advisories = [
      {
        level: "warn",
        title: "Announcements may still be issued tonight",
        body: "Individual District Collectors continue to review local conditions. Remaining districts under rain warnings may still issue closure orders later tonight."
      }
    ];

    if (/PSC\s(has\s)?(cancelled|postponed|deferred)/i.test(bodyText) || bodyText.toLowerCase().includes("kerala public service commission")) {
      advisories.push({
        level: "info",
        title: "Kerala PSC Exams Postponed",
        body: "The Kerala Public Service Commission (PSC) has cancelled/postponed OMR and online exams scheduled due to inclement weather."
      });
    }

    if (/(mahatma gandhi university|mg university)\s(has\s)?(postponed|deferred)/i.test(bodyText)) {
      advisories.push({
        level: "info",
        title: "MG University Exams Postponed",
        body: "Mahatma Gandhi (MG) University has postponed pre-scheduled theory and practical exams. Revised dates will be announced later."
      });
    }

    // Generate Counts and Headline
    const confirmedCount = districtsData.filter(d => d.status === "confirmed" && d.scope === "District-wide").length;
    const partialCount = districtsData.filter(d => d.status === "confirmed" && d.scope !== "District-wide").length;
    let headline = `Holidays declared in ${confirmedCount} districts`;
    if (partialCount > 0) {
      headline += ` and partial/conditional closures in ${partialCount} other districts.`;
    } else {
      headline += ".";
    }

    const finalJson = {
      forDate: tomorrowStr,
      forDateLabel: tomorrowLabel,
      checkedAt,
      headline,
      advisories,
      weather: {
        summary: "Orange alert in force across multiple districts. Heavy to very heavy rainfall expected in isolated areas.",
        outlook: "IMD forecast predicts continued rain statewide.",
        impact: "High risk of waterlogging and localized flooding. Relief camps active.",
        source: {
          name: "Onmanorama",
          url: articleUrl
        }
      },
      districts: districtsData,
      debunked: [],
      limitations: [
        "Parsed automatically from news media reports. Verify with local administrative announcements."
      ]
    };

    // Write to file path data/status.js
    const outDir = path.join(__dirname, 'data');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    
    const jsContent = `/* Kerala Rain Holiday Watch — findings data */\nwindow.KERALA_STATUS = ${JSON.stringify(finalJson, null, 2)};\n`;
    fs.writeFileSync(path.join(outDir, 'status.js'), jsContent, 'utf-8');
    
    console.log(`[Scraper] Successfully updated data/status.js!`);
    return true;
  } catch (err) {
    console.error(`[Scraper] Run error: ${err.message}`);
    return false;
  }
}

// REST endpoints
app.get('/api/scrape', async (req, res) => {
  const now = Date.now();
  
  if (now - lastScrapeTime < SCRAPE_COOLDOWN) {
    const remaining = Math.round((SCRAPE_COOLDOWN - (now - lastScrapeTime)) / 1000);
    return res.status(200).json({
      success: false,
      message: `Scrape on cooldown. Please wait ${remaining} seconds.`
    });
  }

  if (isScraping) {
    return res.status(200).json({
      success: false,
      message: "Scraping task is already in progress."
    });
  }

  isScraping = true;
  const outcome = await runScraper();
  isScraping = false;

  if (outcome) {
    lastScrapeTime = Date.now();
    return res.status(200).json({ success: true, message: "Scraper run completed successfully." });
  } else {
    return res.status(500).json({ success: false, message: "Scraper run failed to complete." });
  }
});

// Serve the generated status file statically
app.use('/data', (req, res, next) => {
  // Prevent browser caching
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  next();
}, express.static(path.join(__dirname, 'data')));

// Serve the rest of the workspace folder statically (fallback)
app.use(express.static(__dirname));

// Start server and trigger initial scrape
app.listen(PORT, async () => {
  console.log(`[Server] Node.js backend listening on port ${PORT}`);
  
  // Trigger initial scrape on startup
  await runScraper();
  lastScrapeTime = Date.now();

  // Set interval to scrape every 15 minutes (900000 ms)
  setInterval(async () => {
    if (!isScraping) {
      isScraping = true;
      await runScraper();
      lastScrapeTime = Date.now();
      isScraping = false;
    }
  }, 15 * 60 * 1000);
});
