const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const webpush = require('web-push');
const { initTelegramBot, notifyTelegramSubscribers } = require('./telegram_bot');

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

const DISTRICT_TRANSLATIONS = {
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
};

const LOCAL_HOLIDAY_KEYWORDS = [
  "holiday", "closed", "closure", "postponed", "cancel", "shut",
  "അവധി", "ക്ലാസുകൾ ഉണ്ടാകില്ല"
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
      vapidSubject = vapidData.subject || 'mailto:admin@avadhiyundo.onrender.com';
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

function isSentenceRelevantForDate(sentence, targetStr) {
  const DAYS_ENG = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const DAYS_MAL = ["ഞായർ", "തിങ്കൾ", "ചൊവ്വ", "ബുധൻ", "വ്യാഴം", "വെള്ളി", "ശനി"];
  
  const [yr, mo, dy] = targetStr.split('-').map(Number);
  const targetDayIndex = new Date(Date.UTC(yr, mo - 1, dy)).getDay();
  
  const targetDayEng = DAYS_ENG[targetDayIndex];
  const targetDayMal = DAYS_MAL[targetDayIndex];
  
  const sentenceLower = sentence.toLowerCase();
  const otherDaysEng = DAYS_ENG.filter(d => d !== targetDayEng);
  const otherDaysMal = DAYS_MAL.filter(d => d !== targetDayMal);
  
  // Check English day names
  if (otherDaysEng.some(day => sentenceLower.includes(day))) {
    if (!sentenceLower.includes(targetDayEng) && !sentenceLower.includes("tomorrow")) {
      return false; // Skip
    }
  }
  
  // Check Malayalam day names
  if (otherDaysMal.some(day => sentenceLower.includes(day))) {
    if (!sentenceLower.includes(targetDayMal) && !sentenceLower.includes("നാളെ")) {
      return false; // Skip
    }
  }
  
  // If target date is tomorrow, check for today/yesterday references
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istTime = new Date(now.getTime() + istOffset);
  const todayStr = istTime.toISOString().split('T')[0];
  
  if (targetStr !== todayStr) {
    const hasPastOrToday = sentenceLower.includes("today") || 
                           sentenceLower.includes("yesterday") || 
                           sentenceLower.includes("ഇന്ന്") || 
                           sentenceLower.includes("ഇന്നലെ");
    if (hasPastOrToday) {
      const hasFuture = sentenceLower.includes("tomorrow") || 
                        sentenceLower.includes("നാളെ") || 
                        sentenceLower.includes(targetDayEng) || 
                        sentenceLower.includes(targetDayMal);
      if (!hasFuture) {
        return false;
      }
    }
  }
  
  return true;
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
    const sLower = sentence.toLowerCase();
    if (!sLower || !(sLower.includes("alert") || sLower.includes("അലർട്ട്"))) {
      continue;
    }

    // Split by while, but, whereas, semicolon
    const clauses = sentence.split(/\bwhile\b|\bbut\b|\bwhereas\b|;/i);
    for (const clause of clauses) {
      const clauseLower = clause.toLowerCase();
      let color = null;
      if (clauseLower.includes("red alert") || (/\bred\b/.test(clauseLower) && clauseLower.includes("alert")) || clauseLower.includes("റെഡ്")) {
        color = "red";
      } else if (clauseLower.includes("orange alert") || (/\borange\b/.test(clauseLower) && clauseLower.includes("alert")) || clauseLower.includes("ഓറഞ്ച്")) {
        color = "orange";
      } else if (clauseLower.includes("yellow alert") || (/\byellow\b/.test(clauseLower) && clauseLower.includes("alert")) || clauseLower.includes("യെല്ലോ")) {
        color = "yellow";
      }

      if (!color) continue;

      const clauseDistricts = [];
      for (const dist of DISTRICTS_LIST) {
        const distRegex = new RegExp(`\\b${dist}\\b`, 'i');
        let isMentioned = distRegex.test(clause);
        if (!isMentioned && DISTRICT_TRANSLATIONS[dist]) {
          isMentioned = DISTRICT_TRANSLATIONS[dist].some(mal => clause.includes(mal));
        }
        if (isMentioned) {
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

// Writes a clean "no holidays declared" status for today when no article is found.
// This prevents yesterday's stale confirmed data from persisting with a fresh timestamp.
// alertsMap: optional {DistrictName: 'red'|'orange'|'yellow'|'none'} from the latest article.
function writeNoHolidayStatus(outDir, istTimeInfo, alertsMap) {
  const { targetStr, targetLabel, checkedAt } = istTimeInfo;

  const districtsData = DISTRICTS_LIST.map(dist => ({
    name: dist,
    status: 'none',
    alert: (alertsMap && alertsMap[dist]) || 'none',
    confidence: null,
    scope: null,
    appliesTo: null,
    excludes: null,
    reason: null,
    declaredBy: null,
    exams: null,
    confidenceNote: null,
    sources: []
  }));

  const finalJson = {
    forDate: targetStr,
    forDateLabel: targetLabel,
    checkedAt,
    headline: 'No district holiday declarations found yet.',
    advisories: [
      {
        level: 'warn',
        title: 'No holiday articles found for today',
        body: 'No holiday announcements have been detected from Onmanorama for today. Collectors may still issue orders later tonight — check your District Collector directly.'
      }
    ],
    weather: {
      summary: '',
      outlook: '',
      impact: '',
      source: { name: '', url: '' }
    },
    districts: districtsData,
    debunked: [],
    limitations: [
      'Parsed automatically from news media reports. Verify with local administrative announcements.'
    ]
  };

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const nEvents = updateHistory(outDir, finalJson);
  const jsContent = `/* Kerala Rain Holiday Watch — findings data */\nwindow.KERALA_STATUS = ${JSON.stringify(finalJson, null, 2)};\n`;
  fs.writeFileSync(path.join(outDir, 'status.js'), jsContent, 'utf-8');
  console.log(`[Scraper] Wrote no-holiday status for ${targetStr}. (${nEvents} history events retained)`);
  return true;
}

// Scrape logic
async function fetchArticlesFromSource(sourceName, newsUrl, domain, headers) {
  try {
    const listRes = await axios.get(newsUrl, { headers, timeout: 10000 });
    const $ = cheerio.load(listRes.data);

    const candidates = [];
    $('a').each((i, el) => {
      const href = $(el).attr('href');
      const text = $(el).text().trim();

      if (href && text) {
        const textLower = text.toLowerCase();
        const hrefLower = (href || '').toLowerCase();
        
        let isHolidayArticle = false;
        let isRainBreakingArticle = false;

        if (sourceName === 'Onmanorama') {
          isHolidayArticle = textLower.includes('holiday') &&
            (textLower.includes('district') || textLower.includes('school') || textLower.includes('rain'));
          isRainBreakingArticle = (textLower.includes('rain') || textLower.includes('flood') || textLower.includes('alert')) &&
            (textLower.includes('district') || textLower.includes('alert') || hrefLower.includes('holiday') || hrefLower.includes('school'));
        } else {
          // Malayalam matching for Mathrubhumi and Manorama
          const hasHoliday = textLower.includes('അവധി');
          const hasSchool = textLower.includes('സ്കൂൾ') || textLower.includes('ക്ലാസ്') || textLower.includes('വിദ്യഭ്യാസ') || textLower.includes('വിദ്യാഭ്യാസ');
          const hasRain = textLower.includes('മഴ') || textLower.includes('വെള്ളപ്പൊക്കം');
          const hasAlert = textLower.includes('അലേർട്ട്');
          const hasCollector = textLower.includes('കലക്ടർ') || textLower.includes('കളക്ടർ');
          
          isHolidayArticle = hasHoliday && (hasSchool || hasRain || hasCollector);
          isRainBreakingArticle = (hasRain || hasAlert) && (hasHoliday || hasSchool || hasCollector);
        }
        
        if (isHolidayArticle || isRainBreakingArticle) {
          const fullUrl = href.startsWith('http') ? href : domain + href;
          candidates.push({ url: fullUrl, title: text, href: href, source: sourceName });
        }
      }
    });

    return candidates;
  } catch (e) {
    console.warn(`[Scraper] Error fetching from ${sourceName}: ${e.message}`);
    return [];
  }
}

function getDatePaths() {
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const istHour = istNow.getUTCHours();

  const todayIST = istNow.toISOString().split('T')[0];
  const [todayYear, todayMonth, todayDay] = todayIST.split('-');
  const todayPath = `${todayYear}/${todayMonth}/${todayDay}`;

  const targetTime = istHour >= 15
    ? new Date(istNow.getTime() + 24 * 60 * 60 * 1000)
    : istNow;
  const targetIST = targetTime.toISOString().split('T')[0];
  const [tYear, tMonth, tDay] = targetIST.split('-');
  const targetPath = `${tYear}/${tMonth}/${tDay}`;

  return { todayPath, targetPath };
}

async function runScraper() {
  console.log(`[Scraper] Starting scrape run: ${new Date().toISOString()}`);
  const outDir = path.join(__dirname, 'data');

  // Get today's date in IST for URL matching
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);

  // Multi-source news fetching
  const sources = [
    { name: 'Onmanorama', newsUrl: 'https://www.onmanorama.com/news/kerala.html', domain: 'https://www.onmanorama.com' },
    { name: 'Mathrubhumi', newsUrl: 'https://www.mathrubhumi.com/news/kerala', domain: 'https://www.mathrubhumi.com' },
    { name: 'Manorama', newsUrl: 'https://www.manoramaonline.com/news/latest-news.html', domain: 'https://www.manoramaonline.com' }
  ];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
  };

  const { todayPath, targetPath } = getDatePaths();

  let articleUrl = null;
  let articleTitle = "";

  try {
    // Fetch from all sources in parallel
    console.log(`[Scraper] Checking ${sources.length} news source(s)...`);
    const sourcePromises = sources.map(src =>
      fetchArticlesFromSource(src.name, src.newsUrl, src.domain, headers)
    );
    const allArticles = await Promise.all(sourcePromises);

    // Flatten and deduplicate by URL
    const allCandidates = allArticles.flat();
    const candidatesByUrl = new Map();
    for (const c of allCandidates) {
      if (!candidatesByUrl.has(c.url)) candidatesByUrl.set(c.url, c);
    }
    const candidates = Array.from(candidatesByUrl.values());

    if (candidates.length === 0) {
      console.log("[-] No rain holiday news articles found on any source. Writing no-holiday status.");
      return writeNoHolidayStatus(outDir, getISTTime(), null);
    }

    console.log(`[Scraper] Found ${candidates.length} candidate article(s):`);
    candidates.forEach((c, i) => {
      console.log(`  [${i}] [${c.source}] "${c.title.substring(0, 60)}..." - ${c.href}`);
    });

    // Accept recent articles (today or yesterday) - content may describe tomorrow's closures
    // Bypass target path check for Mathrubhumi since its URLs do not contain date paths
    const recentCandidates = candidates.filter(c =>
      c.source === 'Mathrubhumi' || c.href.includes(todayPath) || c.href.includes(targetPath)
    );

    recentCandidates.sort((a, b) => {
      const aLower = (a.title + ' ' + a.url).toLowerCase();
      const bLower = (b.title + ' ' + b.url).toLowerCase();
      let aScore = 0;
      if (aLower.includes('live')) aScore += 2;
      if (aLower.includes('holiday')) aScore += 2;
      let bScore = 0;
      if (bLower.includes('live')) bScore += 2;
      if (bLower.includes('holiday')) bScore += 2;
      return bScore - aScore;
    });

    if (recentCandidates.length === 0) {
      console.log(`[Scraper] No recent articles found. Writing no-holiday status.`);
      return writeNoHolidayStatus(outDir, getISTTime(), null);
    }

    console.log(`[Scraper] Using ${recentCandidates.length} recent article(s) for evidence gathering...`);

    const { targetStr, targetLabel, checkedAt } = getISTTime();

    // 2. Gather evidence from recent articles
    let chosenBody = '';
    let chosenUrl = '';
    let chosenTitle = '';
    const evidenceMap = new Map();

    const tryList = recentCandidates.slice(0, 6);

    for (const candidate of tryList) {
      console.log(`[Scraper] Gathering from: "${candidate.title.substring(0, 70)}"`);
      try {
        const res = await axios.get(candidate.url, { headers, timeout: 10000 });
        const $a = cheerio.load(res.data);
        
        let fullBodyText = '';
        // Extract full body for alerts (from JSON-LD or p tags)
        $a('script[type="application/ld+json"]').each((i, el) => {
          if (fullBodyText) return;
          try {
            const ld = JSON.parse($a(el).html());
            if (ld.articleBody) fullBodyText = ld.articleBody;
          } catch (e) {}
        });
        if (!fullBodyText.trim()) {
          $a('p').each((i, el) => { fullBodyText += $a(el).text().trim() + '\n'; });
        }

        if (!chosenBody) {
          chosenBody = fullBodyText;
          chosenUrl = candidate.url;
          chosenTitle = candidate.title;
        }

        // Now extract clean paragraphs for holiday parsing
        let holidayParagraphs = [];
        let fetchedFromLiveBlog = false;

        const filePathMatch = res.data.match(/var\s+filePath\s*=\s*['"]([^'"]+)['"]/);
        if (filePathMatch) {
          const filePath = filePathMatch[1]
            .replace(/\\\//g, '/')
            .replace(/\\u([0-9a-fA-F]{4})/g, (match, grp) => String.fromCharCode(parseInt(grp, 16)));
          const jsonUrl = `https://www.onmanorama.com${filePath}.5.json`;
          try {
            console.log(`[Scraper] Live blog detected. Fetching updates from AEM JSON: ${jsonUrl}`);
            const jsonRes = await axios.get(jsonUrl, { headers, timeout: 10000 });
            
            // Calculate active window in UTC ms
            const [yr, mo, dy] = targetStr.split('-').map(Number);
            const windowStart = Date.UTC(yr, mo - 1, dy - 1, 8, 30, 0);
            const windowEnd = Date.UTC(yr, mo - 1, dy, 6, 30, 0);
            
            const updates = [];
            for (const [k, v] of Object.entries(jsonRes.data)) {
              if (k.startsWith('livenewsupdate')) {
                const master = v['jcr:content']?.data?.master;
                if (master && v['jcr:created']) {
                  const createdTime = new Date(v['jcr:created']).getTime();
                  if (createdTime >= windowStart && createdTime <= windowEnd) {
                    updates.push({
                      createdTime,
                      description: master.description || ''
                    });
                  }
                }
              }
            }
            
            // Sort updates descending by time
            updates.sort((a, b) => b.createdTime - a.createdTime);
            
            // Strip HTML tags and map to paragraphs
            holidayParagraphs = updates.map(u => u.description.replace(/<[^>]+>/g, ' ').trim()).filter(Boolean);
            fetchedFromLiveBlog = true;
            console.log(`[Scraper] Gathered ${holidayParagraphs.length} live update(s) within the target date window.`);
          } catch (jsonErr) {
            console.warn(`[Scraper] Failed to fetch live updates JSON: ${jsonErr.message}. Falling back to static HTML.`);
          }
        }

        if (!fetchedFromLiveBlog) {
          // Parse from static HTML, but apply isSentenceRelevantForDate check
          const rawParagraphs = [];
          $a('p').each((i, el) => { rawParagraphs.push($a(el).text().trim()); });
          
          holidayParagraphs = rawParagraphs
            .map(p => p.trim())
            .filter(Boolean)
            .filter(p => isSentenceRelevantForDate(p, targetStr));
        }

        // Now process holidayParagraphs for each district
        // Now process holidayParagraphs using context-tracking (district headings)
        const districtReadingsMap = {};
        for (const dist of DISTRICTS_LIST) {
          districtReadingsMap[dist] = [];
        }
        let activeDistrict = null;

        for (const p of holidayParagraphs) {
          const pClean = p.replace(/^[^\n:]{2,40}:\s*/, '');
          const pLower = pClean.toLowerCase();

          // Check if this paragraph is a district heading
          let isHeading = false;
          for (const dist of DISTRICTS_LIST) {
            const namesToCheck = [dist.toLowerCase()].concat(
              (DISTRICT_TRANSLATIONS[dist] || []).map(n => n.toLowerCase())
            );
            const cleanPLower = pLower.trim().replace(/[.:-–—*•]/g, '');
            if (namesToCheck.includes(cleanPLower)) {
              activeDistrict = dist;
              isHeading = true;
              break;
            }
          }
          if (isHeading) continue;

          for (const dist of DISTRICTS_LIST) {
            // Check if district is mentioned (in English or Malayalam translations)
            const distRegex = new RegExp(`\\b${dist}\\b`, 'i');
            let isMentioned = distRegex.test(pClean);
            if (!isMentioned && DISTRICT_TRANSLATIONS[dist]) {
              for (const malName of DISTRICT_TRANSLATIONS[dist]) {
                if (pClean.includes(malName)) {
                  isMentioned = true;
                  break;
                }
              }
            }

            // Check if the paragraph is relevant to this district (either mentioned directly or under active heading)
            let isTarget = isMentioned || (activeDistrict === dist && !DISTRICTS_LIST.some(d => {
              if (d === dist) return false;
              const dRegex = new RegExp(`\\b${d}\\b`, 'i');
              if (dRegex.test(pClean)) return true;
              if (DISTRICT_TRANSLATIONS[d]) {
                return DISTRICT_TRANSLATIONS[d].some(mal => pClean.includes(mal));
              }
              return false;
            }));

            if (!isTarget) continue;

            let hasKw = false;
            for (const kw of LOCAL_HOLIDAY_KEYWORDS) {
              if (pLower.includes(kw)) {
                hasKw = true;
                break;
              }
            }

            if (!hasKw) continue;

            let scope = "District-wide";
            let appliesTo = "All educational institutions — schools, professional colleges, anganwadis, and tuition centres";
            let excludes = null;
            let reason = "Adverse weather and heavy rainfall";

            // Check if professional colleges are excluded
            const mentionsProfessional = pLower.includes("professional") || pLower.includes("പ്രൊഫഷണൽ");
            const hasExclusionKw = pLower.includes("except") || pLower.includes("not") || pLower.includes("excluding") || 
                                   pLower.includes("ഒഴികെ") || pLower.includes("ഒഴികെയുള്ള");

            const excludesProfessional = mentionsProfessional && hasExclusionKw;

            const isAllInstitutions = (pLower.includes("including professional") || pLower.includes("all educational") ||
                                      pLower.includes("എല്ലാ വിദ്യാഭ്യാസ")) && !excludesProfessional;

            if (excludesProfessional) {
              appliesTo = "Educational institutions except professional colleges (schools, anganwadis, tuition centres, etc.)";
              excludes = "Professional colleges NOT covered.";
            }

            // Check for relief camp closures (only if explicitly limited to relief camps)
            const isReliefCampOnly = !isAllInstitutions &&
              (pLower.includes("relief camp") || pLower.includes("relief-camp") || pLower.includes("ദുരിതാശ്വാസ") || pLower.includes("ക്യാമ്പ്")) &&
              (pLower.includes("only") || pLower.includes("except") || pLower.includes("functioning as") || pLower.includes("പ്രവർത്തിക്കുന്ന") || pLower.includes("മാത്രം"));

            if (isReliefCampOnly) {
              scope = "Relief camp schools only";
              appliesTo = "All schools functioning as relief camps";
              excludes = "All other educational institutions";
              reason = "Schools serving as relief camps during floods";
            } else if (!isAllInstitutions && (pLower.includes("taluk") || pLower.includes("taluks") || pLower.includes("താലൂക്ക്") || pLower.includes("താലൂക്കുകൾ"))) {
              scope = "Select taluks only";
              appliesTo = "Educational institutions in specific taluks";
              if (excludesProfessional) {
                excludes = "Professional colleges NOT covered.";
              }
            }

            districtReadingsMap[dist].push({ scope, appliesTo, excludes, reason });
          }
        }

        // Now update evidenceMap with best readings
        for (const dist of DISTRICTS_LIST) {
          const readings = districtReadingsMap[dist];
          if (readings && readings.length > 0) {
            if (!evidenceMap.has(dist)) evidenceMap.set(dist, []);

            const scopePriority = { "District-wide": 3, "Select taluks only": 2, "Relief camp schools only": 1 };
            const bestReading = readings.reduce((best, current) => {
              const bestScore = (scopePriority[best.scope] || 0) + (best.excludes ? 0.5 : 0);
              const currentScore = (scopePriority[current.scope] || 0) + (current.excludes ? 0.5 : 0);
              return currentScore > bestScore ? current : best;
            });

            evidenceMap.get(dist).push({
              status: "confirmed",
              scope: bestReading.scope,
              appliesTo: bestReading.appliesTo,
              excludes: bestReading.excludes,
              reason: bestReading.reason,
              source: {
                name: candidate.source,
                title: candidate.title,
                url: candidate.url
              }
            });
          }
        }
      } catch (e) {
        console.warn(`[Scraper] Error fetching "${candidate.title.substring(0, 40)}": ${e.message}`);
      }
    }

    // 3. Merge multi-source verdicts
    const alertsMap = parseAlerts(chosenBody || '');
    const districtsData = [];

    for (const dist of DISTRICTS_LIST) {
      if (evidenceMap.has(dist)) {
        const readings = evidenceMap.get(dist);
        const sourceCount = new Set(readings.map(r => r.source.name)).size;

        let confidence = 60;
        if (sourceCount >= 3) confidence = 92;
        else if (sourceCount >= 2) confidence = 80;

        let confidenceNote = `Reported by ${readings.map(r => r.source.name).join(', ')}.`;
        if (sourceCount === 1) confidenceNote = `Reported by ${readings[0].source.name}.`;

        // Prefer broader scope: District-wide > Taluk > Relief camp
        const scopePriority = {
          "District-wide": 3,
          "Relief camp schools only": 1,
          "Select taluks only": 2
        };
        // Date-scoped override for Kozhikode (2026-08-05):
        // Mathrubhumi article body is truncated by the site before reaching the exclusion paragraph,
        // so the scraper cannot auto-detect it. This override applies the known DC announcement:
        // Professional colleges are NOT included in the holiday.
        const reading = readings.reduce((best, current) => {
          const bestScore = (scopePriority[best.scope] || 0) + (best.excludes ? 0.5 : 0);
          const currentScore = (scopePriority[current.scope] || 0) + (current.excludes ? 0.5 : 0);
          return currentScore > bestScore ? current : best;
        });
        let finalExcludes = reading.excludes;
        let finalAppliesTo = reading.appliesTo;
        if (dist === 'Kozhikode' && targetStr === '2026-08-05' && reading.excludes === null) {
          finalExcludes = 'Professional colleges are NOT covered — they function as normal.';
          finalAppliesTo = 'All educational institutions except professional colleges (schools, anganwadis, tuition centres, etc.)';
          console.log('[Scraper] Applied Kozhikode professional-college override for 2026-08-05.');
        }
        districtsData.push({
          name: dist,
          status: "confirmed",
          alert: alertsMap[dist] || "none",
          confidence,
          scope: reading.scope,
          appliesTo: finalAppliesTo,
          excludes: finalExcludes,
          reason: reading.reason,
          declaredBy: `District Collector, ${dist}`,
          exams: "Scheduled public and university examinations proceed unless specified.",
          confidenceNote,
          sources: readings.map(r => ({
            name: r.source.name,
            title: r.source.title,
            url: r.source.url,
            time: "Latest Update",
            tier: 1
          }))
        });
      } else {
        districtsData.push({
          name: dist,
          status: "none",
          alert: alertsMap[dist] || "none",
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

    if (/PSC\s(has\s)?(cancelled|postponed|deferred)/i.test(chosenBody) || chosenBody.toLowerCase().includes("kerala public service commission")) {
      advisories.push({
        level: "info",
        title: "Kerala PSC Exams Postponed",
        body: "The Kerala Public Service Commission (PSC) has cancelled/postponed OMR and online exams scheduled due to inclement weather."
      });
    }

    if (/(mahatma gandhi university|mg university)\s(has\s)?(postponed|deferred)/i.test(chosenBody)) {
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
          url: chosenUrl
        }
      },
      districts: districtsData,
      debunked: [],
      limitations: [
        "Parsed automatically from news media reports. Verify with local administrative announcements."
      ]
    };

    // Write to data/status.js
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    
    const nEvents = updateHistory(outDir, finalJson);

    const jsContent = `/* Kerala Rain Holiday Watch — findings data */\nwindow.KERALA_STATUS = ${JSON.stringify(finalJson, null, 2)};\n`;
    fs.writeFileSync(path.join(outDir, 'status.js'), jsContent, 'utf-8');

    await notifySubscribers(finalJson);
    await notifyTelegramSubscribers(finalJson);

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
  
  // Initialize Telegram Bot
  initTelegramBot();

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
