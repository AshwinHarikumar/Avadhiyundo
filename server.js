const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const app = express();
const PORT = process.env.PORT || 8000;

app.use(cors());
app.use(express.json({limit:'16kb'}));

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

// Push notification setup
let vapidPublicKey = null;
let vapidPrivateKey = null;
let vapidSubject = null;

function initVapidKeys() {
  const vapidPublic = process.env.VAPID_PUBLIC;
  const vapidPrivate = process.env.VAPID_PRIVATE;
  const vapidSubj = process.env.VAPID_SUBJECT;

  if (vapidPublic && vapidPrivate && vapidSubj) {
    vapidPublicKey = vapidPublic;
    vapidPrivateKey = vapidPrivate;
    vapidSubject = vapidSubj;
    webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
    console.log("[Push] VAPID keys loaded from environment.");
    return true;
  }

  const vapidPath = path.join(__dirname, '.vapid.json');
  if (fs.existsSync(vapidPath)) {
    try {
      const vapidData = JSON.parse(fs.readFileSync(vapidPath, 'utf-8'));
      vapidPublicKey = vapidData.publicKey;
      vapidPrivateKey = vapidData.privateKey;
      vapidSubject = vapidData.subject || 'mailto:admin@avdhiundo.com';
      webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
      console.log("[Push] VAPID keys loaded from .vapid.json.");
      return true;
    } catch (e) {
      console.warn("[Push] .vapid.json exists but is invalid:", e.message);
    }
  }

  console.log("[Push] No VAPID keys found. Push notifications disabled.");
  return false;
}

const PUSH_ENABLED = initVapidKeys();

function readSubscriptions() {
  try {
    const subsPath = path.join(__dirname, '.subs.json');
    if (!fs.existsSync(subsPath)) return [];
    const data = JSON.parse(fs.readFileSync(subsPath, 'utf-8'));
    return Array.isArray(data) ? data : [];
  } catch (e) {
    return [];
  }
}

function writeSubscriptions(subs) {
  try {
    const subsPath = path.join(__dirname, '.subs.json');
    fs.writeFileSync(subsPath, JSON.stringify(subs, null, 2), 'utf-8');
  } catch (e) {
    console.error("[Push] Failed to write subscriptions:", e.message);
  }
}

function isPartialServer(d) {
  if (d.status !== "confirmed") return false;
  const s = ((d.scope || "") + " " + (d.appliesTo || "")).toLowerCase();
  return s.indexOf("relief") > -1 || s.indexOf("taluk") > -1;
}

function kindOfServer(d) {
  if (d.status === "confirmed") return isPartialServer(d) ? "partial" : "declared";
  if (d.status === "unconfirmed") return "unconfirmed";
  if (d.status === "false") return "debunked";
  return "none";
}

async function notifySubscribers(statusData) {
  if (!PUSH_ENABLED || !statusData || !statusData.districts) return;

  const subs = readSubscriptions();
  if (subs.length === 0) return;

  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const todayStr = istNow.toISOString().split('T')[0];

  for (const sub of subs) {
    if (!sub.district || !sub.subscription) continue;

    const district = statusData.districts.find(d => d.name === sub.district);
    if (!district) continue;

    const kind = kindOfServer(district);
    if (kind !== "declared" && kind !== "partial") continue;

    const key = sub.district + "|" + (statusData.forDate || todayStr);
    if (!sub.sentFor) sub.sentFor = {};
    if (sub.sentFor[key]) continue;

    try {
      const payload = JSON.stringify({
        title: "Holiday declared in " + sub.district,
        body: kind === "partial" ? "Partial closure" : "Holiday declared",
        district: sub.district,
        forDate: statusData.forDate || todayStr
      });

      await webpush.sendNotification(sub.subscription, payload);
      sub.sentFor[key] = true;
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) {
        subs.splice(subs.indexOf(sub), 1);
      } else {
        console.error("[Push] Failed to notify", sub.district, ":", e.message);
      }
    }
  }

  const cutoff = new Date(istNow.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  for (const sub of subs) {
    if (sub.sentFor) {
      for (const key of Object.keys(sub.sentFor)) {
        const date = key.split("|")[1];
        if (date < cutoff) delete sub.sentFor[key];
      }
    }
  }

  writeSubscriptions(subs);
}

// Helper to get IST time formats
function getISTTime() {
  const now = new Date();
  
  // Calculate the current time in IST milliseconds (UTC + 5.5 hours)
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);

  // Format today string (YYYY-MM-DD)
  const todayStr = istTime.toISOString().split('T')[0];

  // Roll over to tomorrow's date at 15:00 (3:00 PM) IST
  const istHour = istTime.getUTCHours();
  const isBeforeRollover = istHour < 15;

  const targetTime = isBeforeRollover ? istTime : new Date(istTime.getTime() + 24 * 60 * 60 * 1000);
  const targetStr = targetTime.toISOString().split('T')[0];

  // Target label format using 'UTC' timezone option, because targetTime is already shifted
  const options = { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', timeZone: 'UTC' };
  const targetLabel = new Intl.DateTimeFormat('en-IN', options).format(targetTime);

  const checkedAt = istTime.toISOString().replace('Z', '+05:30');

  return { todayStr, targetStr, targetLabel, checkedAt };
}

// Dynamic IMD alert parser
function parseAlerts(bodyText) {
  const alerts = {};
  for (const dist of DISTRICTS_LIST) {
    alerts[dist] = "none";
  }

  // Split into sentences (by period or newline)
  const sentences = bodyText.split(/[.\n]/);
  let defaultAlert = "none";
  const explicitMapped = new Set();

  for (let sentence of sentences) {
    sentence = sentence.trim();
    if (!sentence || !sentence.toLowerCase().includes("alert")) {
      continue;
    }

    // Split by while, but, whereas, semicolon
    const clauses = sentence.split(/\bwhile\b|\bbut\b|\bwhereas\b|;/i);
    for (const clause of clauses) {
      const clauseLower = clause.toLowerCase();
      let color = null;
      if (clauseLower.includes("red alert") || (/\bred\b/.test(clauseLower) && clauseLower.includes("alert"))) {
        color = "red";
      } else if (clauseLower.includes("orange alert") || (/\borange\b/.test(clauseLower) && clauseLower.includes("alert"))) {
        color = "orange";
      } else if (clauseLower.includes("yellow alert") || (/\byellow\b/.test(clauseLower) && clauseLower.includes("alert"))) {
        color = "yellow";
      }

      if (!color) continue;

      const clauseDistricts = [];
      for (const dist of DISTRICTS_LIST) {
        const distRegex = new RegExp(`\\b${dist}\\b`, 'i');
        if (distRegex.test(clause)) {
          clauseDistricts.push(dist);
        }
      }

      if (clauseDistricts.length > 0) {
        for (const dist of clauseDistricts) {
          alerts[dist] = color;
          explicitMapped.add(dist);
        }
      } else {
        if (clauseLower.includes("district") || clauseLower.includes("state") || clauseLower.includes("kerala") || clauseLower.includes("multiple")) {
          defaultAlert = color;
        }
      }
    }
  }

  if (defaultAlert !== "none") {
    for (const dist of DISTRICTS_LIST) {
      if (!explicitMapped.has(dist)) {
        alerts[dist] = defaultAlert;
      }
    }
  }

  return alerts;
}

const HISTORY_PREFIX = "window.KERALA_HISTORY = ";
const HISTORY_MAX_AGE_DAYS = 60;
const HISTORY_MAX_EVENTS = 400;

/* The fields that decide whether a district actually changed. Deliberately
   raw — classification (declared vs partial) is a product rule that lives only
   in app.js, so history never second-guesses it. */
function tupleOf(d) {
  return { status: d.status, scope: d.scope, appliesTo: d.appliesTo };
}

function sameTuple(a, b) {
  return a.status === b.status && a.scope === b.scope && a.appliesTo === b.appliesTo;
}

function readHistory(historyPath) {
  try {
    const raw = fs.readFileSync(historyPath, 'utf-8');
    const start = raw.indexOf(HISTORY_PREFIX) + HISTORY_PREFIX.length;
    const end = raw.lastIndexOf(';');
    const parsed = JSON.parse(raw.slice(start, end));
    if (!Array.isArray(parsed.events)) throw new Error('events missing');
    return parsed;
  } catch (e) {
    // A corrupt or absent history must never stop a scrape.
    return { latest: null, events: [] };
  }
}

function updateHistory(outDir, data) {
  const historyPath = path.join(outDir, 'history.js');
  const history = readHistory(historyPath);
  const latest = history.latest || {};
  let events = history.events || [];

  const snapshot = { forDate: data.forDate, districts: {} };
  for (const d of data.districts) snapshot.districts[d.name] = tupleOf(d);

  // The 3pm IST rollover resets every district to `none`. Comparing across
  // that boundary would invent 14 "reverted" transitions every single day.
  if (latest.forDate === data.forDate) {
    const previous = latest.districts || {};
    for (const d of data.districts) {
      const before = previous[d.name];
      const after = tupleOf(d);
      if (before && !sameTuple(before, after)) {
        events.push({
          d: d.name,
          forDate: data.forDate,
          at: data.checkedAt,
          from: before,
          to: after
        });
      }
    }
  }

  const cutoffMs = Date.now() + 5.5 * 3600 * 1000 - HISTORY_MAX_AGE_DAYS * 864e5;
  const cutoff = new Date(cutoffMs).toISOString().slice(0, 10);
  events = events.filter(e => (e.forDate || '') >= cutoff).slice(-HISTORY_MAX_EVENTS);

  const payload = { latest: snapshot, events };
  const jsContent =
    `/* Kerala Rain Holiday Watch — transition history\n` +
    ` *\n` +
    ` * Appended to on each check, immediately before status.js is overwritten.\n` +
    ` * \`latest\` is the snapshot the next run compares against; \`events\` are the\n` +
    ` * district transitions observed within a single target date.\n` +
    ` *\n` +
    ` * Optional: when this file is absent the app simply hides the features that\n` +
    ` * depend on it, so file:// keeps working.\n` +
    ` */\n` +
    `${HISTORY_PREFIX}${JSON.stringify(payload, null, 2)};\n`;

  fs.writeFileSync(historyPath, jsContent, 'utf-8');
  return events.length;
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
    const { targetStr, targetLabel, checkedAt } = getISTTime();
    const alertsMap = parseAlerts(bodyText);
    const districtsData = [];

    for (const dist of DISTRICTS_LIST) {
      let isHoliday = false;
      let context = "";

      const paragraphs = bodyText.split('\n').map(p => p.trim()).filter(Boolean);
      for (const p of paragraphs) {
        const distRegex = new RegExp(`\\b${dist}\\b`, 'i');
        if (distRegex.test(p)) {
          const pLower = p.toLowerCase();
          let hasKw = false;
          for (const kw of LOCAL_HOLIDAY_KEYWORDS) {
            if (pLower.includes(kw)) {
              hasKw = true;
              break;
            }
          }
          if (hasKw) {
            isHoliday = true;
            context = pLower;
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
          
          if (dist === "Kannur" && context.includes("professional") && (context.includes("not") || context.includes("except"))) {
            excludes = "Professional colleges NOT covered. Residential schools remain open.";
          }
        }

        districtsData.push({
          name: dist,
          status: "confirmed",
          alert: alertsMap[dist],
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
          alert: alertsMap[dist],
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
      forDate: targetStr,
      forDateLabel: targetLabel,
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
    
    const nEvents = updateHistory(outDir, finalJson);

    const jsContent = `/* Kerala Rain Holiday Watch — findings data */\nwindow.KERALA_STATUS = ${JSON.stringify(finalJson, null, 2)};\n`;
    fs.writeFileSync(path.join(outDir, 'status.js'), jsContent, 'utf-8');

    await notifySubscribers(finalJson);

    console.log(`[Scraper] Successfully updated data/status.js! (${nEvents} transitions retained)`);
    return true;
  } catch (err) {
    console.error(`[Scraper] Run error: ${err.message}`);
    return false;
  }
}

// Helper to read the current status from status.js
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
    return null;
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

// Trigger background scrape when user loads the page
app.get(['/', '/index.html'], (req, res, next) => {
  const now = Date.now();
  if (!isScraping && (now - lastScrapeTime > SCRAPE_COOLDOWN)) {
    console.log("[Server] User opened page - triggering background scrape.");
    isScraping = true;
    runScraper().then(outcome => {
      isScraping = false;
      if (outcome) {
        lastScrapeTime = Date.now();
      }
    }).catch(err => {
      isScraping = false;
      console.error("[Server] Background scrape error:", err);
    });
  }
  next();
});

// Push API endpoints
app.get('/api/vapid', (req, res) => {
  if (!PUSH_ENABLED || !vapidPublicKey) {
    return res.status(503).json({ error: "Push not enabled" });
  }
  res.json({ publicKey: vapidPublicKey });
});

app.post('/api/subscribe', (req, res) => {
  if (!PUSH_ENABLED) {
    return res.status(503).json({ error: "Push not enabled" });
  }

  const { subscription, district, inst } = req.body;
  if (!subscription || !subscription.endpoint || !district) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const subs = readSubscriptions();
  const existing = subs.findIndex(s => s.subscription.endpoint === subscription.endpoint);

  if (existing !== -1) {
    subs[existing].district = district;
    subs[existing].inst = inst || "school";
  } else {
    subs.push({
      subscription: subscription,
      district: district,
      inst: inst || "school",
      sentFor: {}
    });
  }

  console.log("[Push] Received subscription request for:", district);
  writeSubscriptions(subs);

  // Send an immediate trial notification to verify it works
  const statusData = readCurrentStatus();
  if (statusData && statusData.districts) {
    const d = statusData.districts.find(item => item.name === district);
    if (d) {
      const kind = kindOfServer(d);
      let title = "Holiday Watch: " + district;
      let body = "Push notifications are active. We will notify you if a holiday is declared.";
      
      if (kind === "declared" || kind === "partial") {
        title = "Holiday declared in " + district;
        body = kind === "partial" ? "Partial closure" : "Holiday declared";
      }

      const now = new Date();
      const istOffset = 5.5 * 60 * 60 * 1000;
      const istNow = new Date(now.getTime() + istOffset);
      const todayStr = istNow.toISOString().split('T')[0];
      
      const payload = JSON.stringify({
        title: title,
        body: body,
        district: district,
        forDate: statusData.forDate || todayStr
      });

      console.log("[Push] Sending trial notification to subscription...");
      webpush.sendNotification(subscription, payload)
        .then(() => {
          console.log("[Push] Trial notification sent successfully!");
        })
        .catch(err => {
          console.error("[Push] Trial notification failed:", err.message);
        });
    }
  }

  res.json({ success: true, message: "Subscription saved" });
});

app.post('/api/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  if (!endpoint) {
    return res.status(400).json({ error: "Missing endpoint" });
  }

  const subs = readSubscriptions();
  const filtered = subs.filter(s => s.subscription.endpoint !== endpoint);
  writeSubscriptions(filtered);

  res.json({ success: true, message: "Unsubscribed" });
});

// Deny access to dotfiles
app.use((req, res, next) => {
  if (req.path.startsWith('/.')) {
    return res.status(404).end();
  }
  next();
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
