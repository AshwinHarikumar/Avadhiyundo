const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const webpush = require('web-push');
const { initTelegramBot, notifyTelegramSubscribers } = require('./telegram_bot');

const execFileAsync = promisify(execFile);


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

const TALUK_NAME_RE = /\b([A-Z][a-zA-Z]+(?:\s*,\s*[A-Z][a-zA-Z]+)*(?:\s+and\s+[A-Z][a-zA-Z]+)?)\s+taluks?\b/g;

const TALUK_STOPWORDS = new Set([
  "the", "in", "of", "and", "district", "districts", "remaining", "other",
  "others", "all", "select", "respective", "both", "two", "three", "several"
]);

/* Pull taluk names out of prose like "in Thiruvalla taluk" or "Vadakara and
   Koyilandy taluks". Returns [] for generic phrasing such as "the district's
   remaining taluks", so we never invent a name. */
function extractTaluks(text) {
  const names = [];
  TALUK_NAME_RE.lastIndex = 0;
  let match;
  while ((match = TALUK_NAME_RE.exec(text || "")) !== null) {
    for (const part of match[1].split(/,|\band\b/)) {
      const name = part.trim();
      if (name && !TALUK_STOPWORDS.has(name.toLowerCase()) && !names.includes(name)) {
        names.push(name);
      }
    }
  }
  return names;
}

/* Read one sentence of a holiday report into a scope verdict.

   Two axes here, and they are independent: which institution *types* the order
   names (appliesTo), and how far the order reaches (scope). Conflating them is
   what made "all educational institutions ... in Thiruvalla taluk" read as
   district-wide. Returns null when the sentence declares no closure. */
function segmentTextByDistricts(text) {
  const matches = [];
  for (const dist of DISTRICTS_LIST) {
    const namesToCheck = [dist.toLowerCase()].concat(
      (DISTRICT_TRANSLATIONS[dist] || []).map(n => n.toLowerCase())
    );
    for (const name of namesToCheck) {
      let pos = text.toLowerCase().indexOf(name);
      while (pos !== -1) {
        matches.push({ start: pos, end: pos + name.length, dist });
        pos = text.toLowerCase().indexOf(name, pos + 1);
      }
    }
  }

  if (matches.length === 0) {
    return [{ text, dist: null }];
  }

  matches.sort((a, b) => a.start - b.start);

  const uniqueMatches = [];
  for (const m of matches) {
    if (uniqueMatches.length === 0 || m.start >= uniqueMatches[uniqueMatches.length - 1].end) {
      uniqueMatches.push(m);
    }
  }

  if (uniqueMatches.length === 0) {
    return [{ text, dist: null }];
  }

  const segments = [];
  const numMatches = uniqueMatches.length;
  for (let idx = 0; idx < numMatches; idx++) {
    let startIdx, endIdx;
    
    if (idx === 0) {
      startIdx = 0;
    } else {
      const prevEnd = uniqueMatches[idx - 1].end;
      const betweenText = text.substring(prevEnd, uniqueMatches[idx].start);
      const splitMatch = betweenText.match(/(?:,|\band\b|;)/);
      if (splitMatch) {
        startIdx = prevEnd + splitMatch.index + splitMatch[0].length;
      } else {
        startIdx = Math.floor((prevEnd + uniqueMatches[idx].start) / 2);
      }
    }

    if (idx === numMatches - 1) {
      endIdx = text.length;
    } else {
      const thisEnd = uniqueMatches[idx].end;
      const betweenText = text.substring(thisEnd, uniqueMatches[idx + 1].start);
      const splitMatch = betweenText.match(/(?:,|\band\b|;)/);
      if (splitMatch) {
        endIdx = thisEnd + splitMatch.index;
      } else {
        endIdx = Math.floor((thisEnd + uniqueMatches[idx + 1].start) / 2);
      }
    }

    const segmentText = text.substring(startIdx, endIdx);
    const distName = uniqueMatches[idx].dist;
    segments.push({ text: segmentText, dist: distName });
  }

  return segments;
}

function getCandidateTier(url, title) {
  const urlLower = url.toLowerCase();
  const titleLower = title.toLowerCase();
  if (urlLower.includes("live") || titleLower.includes("live")) {
    return 2;
  }
  if (urlLower.includes("holiday") || urlLower.includes("closures") || titleLower.includes("അവധി")) {
    return 1;
  }
  return 3;
}

/* Read one sentence of a holiday report into a scope verdict.

   Two axes here, and they are independent: which institution *types* the order
   names (appliesTo), and how far the order reaches (scope). Conflating them is
   what made "all educational institutions ... in Thiruvalla taluk" read as
   district-wide. Returns null when the sentence declares no closure. */
function deriveReading(text) {
  const lower = (text || "").toLowerCase();
  if (!LOCAL_HOLIDAY_KEYWORDS.some(kw => lower.includes(kw))) return null;

  const isNegation = lower.includes("അവധിയില്ല") || 
                     lower.includes("പ്രഖ്യാപിച്ചിട്ടില്ല") || 
                     lower.includes("ഉണ്ടായിരിക്കില്ല") || 
                     lower.includes("തീരുമാനിച്ചിട്ടില്ല") || 
                     /\b(no holiday|not declared|no district holiday|no general holiday)\b/.test(lower);
  if (isNegation) return null;

  const mentionsProfessional = lower.includes("professional") || lower.includes("പ്രൊഫഷണൽ");
  const hasExclusionKw = /\b(except|excluding|not)\b/.test(lower) ||
    lower.includes("ഒഴികെ") || lower.includes("ഒഴികെയുള്ള");
  const excludesProfessional = mentionsProfessional && hasExclusionKw;

  let typeLabel, appliesTo, excludes;
  if (excludesProfessional) {
    typeLabel = "Educational institutions except professional colleges";
    appliesTo = "Educational institutions except professional colleges (schools, anganwadis, tuition centres, etc.)";
    excludes = "Professional colleges NOT covered.";
  } else {
    typeLabel = "All educational institutions";
    appliesTo = "All educational institutions — schools, professional colleges, anganwadis, and tuition centres";
    excludes = null;
  }

  const reason = "Adverse weather and heavy rainfall";

  const mentionsReliefCamp = lower.includes("relief camp") || lower.includes("relief-camp") ||
    lower.includes("ദുരിതാശ്വാസ") || lower.includes("ക്യാമ്പ്");
  const reliefCampOnly = mentionsReliefCamp && (
    lower.includes("only") || lower.includes("except") || lower.includes("functioning as") ||
    lower.includes("പ്രവർത്തിക്കുന്ന") || lower.includes("മാത്രം"));

  const taluks = extractTaluks(text);
  const mentionsTaluk = taluks.length > 0 || lower.includes("taluk") ||
    lower.includes("താലൂക്ക്") || lower.includes("താലൂക്കുകൾ");

  if (taluks.length > 0) {
    const label = taluks.join(", ") + (taluks.length === 1 ? " taluk" : " taluks");
    
    // Check if this is a mixed order
    const isMixed = reliefCampOnly && ["remaining", "other", "elsewhere", "ശേഷിക്കുന്ന", "മറ്റു", "മറ്റുള്ള"].some(x => lower.includes(x));
    
    if (reliefCampOnly && !isMixed) {
      // Case B: Only relief camp schools in the named taluks are closed
      return {
        scope: "Relief camp schools in " + label + " only",
        appliesTo: "Schools functioning as relief camps in " + label + ".",
        excludes: "All other educational institutions",
        reason: "Schools serving as relief camps during floods",
        qualified: true
      };
    }

    const reading = {
      scope: label + " only",
      appliesTo: typeLabel + " in " + label + ".",
      excludes,
      reason,
      qualified: true
    };
    if (reliefCampOnly) {
      reading.appliesTo += " Elsewhere in the district, only schools functioning as relief camps are closed.";
      reading.excludes = "Institutions outside " + label + " that are not relief camps.";
    }
    return reading;
  }

  if (reliefCampOnly) {
    return {
      scope: "Relief camp schools only",
      appliesTo: "All schools functioning as relief camps",
      excludes: "All other educational institutions",
      reason: "Schools serving as relief camps during floods",
      qualified: true
    };
  }

  if (mentionsTaluk) {
    return {
      scope: "Select taluks only",
      appliesTo: "Educational institutions in specific taluks",
      excludes,
      reason,
      qualified: true
    };
  }

  const isExplicitDeclaration = 
    (lower.includes("അവധി") && (
      lower.includes("പ്രഖ്യാപിച്ചു") || 
      lower.includes("പ്രഖ്യാപിച്ചി") || 
      lower.includes("അറിയിച്ചു") || 
      lower.includes("ബാധക") || 
      lower.includes("ആയിരിക്കും") || 
      lower.includes("അവധിയാണ്") || 
      lower.includes("നൽകി") ||
      lower.includes("ഇന്ന്") ||
      lower.includes("നാളെ")
    )) ||
    /\b(declared|declares|announced|announces|is a holiday|will be a holiday)\b/.test(lower);

  return { scope: "District-wide", appliesTo, excludes, reason, qualified: excludesProfessional || isExplicitDeclaration };
}

function scopeRank(scope) {
  const s = (scope || "").toLowerCase();
  if (s.includes("district-wide")) return 3;
  if (s.includes("relief")) return 1;
  if (s.includes("taluk")) return 2;
  return 0;
}

/* Choose the reading to publish for a district.

   "District-wide" is what we fall back to when a sentence names no limit — an
   assumption, not an observation. So any reading that actually names a limit
   beats an unqualified default; only among equally qualified readings do we
   take the broadest. */
function pickBestReading(readings) {
  const pool = readings.filter(r => r.qualified);
  const poolToUse = pool.length > 0 ? pool : readings;
  let best = poolToUse.reduce((a, b) => {
    const aScore = scopeRank(a.scope) + (a.excludes ? 0.5 : 0);
    const bScore = scopeRank(b.scope) + (b.excludes ? 0.5 : 0);
    return bScore > aScore ? b : a;
  });

  if ((best.scope || "").toLowerCase().includes("taluk") &&
      !(best.appliesTo || "").toLowerCase().includes("relief camp") &&
      !(best.scope || "").toLowerCase().includes("relief camp") &&
      poolToUse.some(r => (r.scope || "").toLowerCase().includes("relief camp"))) {
    best = Object.assign({}, best, {
      appliesTo: (best.appliesTo || "").trimEnd() +
        " Elsewhere in the district, only schools functioning as relief camps are closed.",
      excludes: "Institutions outside the named taluks that are not relief camps."
    });
  }
  return best;
}

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

  // Roll over to tomorrow's date at 18:30 (6:30 PM) IST
  const istHour = istTime.getUTCHours();
  const istMinute = istTime.getUTCMinutes();
  const currentMinutes = istHour * 60 + istMinute;
  const rolloverMinutes = 18 * 60 + 30; // 6:30 PM IST
  const isBeforeRollover = currentMinutes < rolloverMinutes;

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
    const hasFuture = sentenceLower.includes("tomorrow") || 
                      sentenceLower.includes("നാളെ") || 
                      sentenceLower.includes(targetDayEng) || 
                      sentenceLower.includes(targetDayMal);
                      
    if (hasPastOrToday && !hasFuture) {
      return false;
    }
    
    // For a future target date, we must see a future reference.
    // Otherwise, old paragraphs from today's static article will bleed into tomorrow.
    if (!hasFuture) {
      return false;
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

  const districtsData = DISTRICTS_LIST.map(dist => {
    return {
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
    };
  });

  const confirmedCount = districtsData.filter(d => d.status === "confirmed" && d.scope === "District-wide").length;
  const partialCount = districtsData.filter(d => d.status === "confirmed" && d.scope !== "District-wide").length;
  const plural = n => (n === 1 ? "district" : "districts");
  let headline = 'No district holiday declarations found yet.';
  if (confirmedCount > 0 || partialCount > 0) {
    if (confirmedCount === 0 && partialCount > 0) {
      headline = `Partial/conditional closures in ${partialCount} ${plural(partialCount)}. No district-wide holiday declared.`;
    } else {
      headline = `Holidays declared in ${confirmedCount} ${plural(confirmedCount)}`;
      if (partialCount > 0) {
        headline += ` and partial/conditional closures in ${partialCount} other ${plural(partialCount)}.`;
      } else {
        headline += ".";
      }
    }
  }

  const finalJson = {
    forDate: targetStr,
    forDateLabel: targetLabel,
    checkedAt,
    headline,
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

  const istMinute = istNow.getUTCMinutes();
  const currentMinutes = istHour * 60 + istMinute;
  const rolloverMinutes = 18 * 60 + 30;

  const targetTime = currentMinutes >= rolloverMinutes
    ? new Date(istNow.getTime() + 24 * 60 * 60 * 1000)
    : istNow;
  const targetIST = targetTime.toISOString().split('T')[0];
  const [tYear, tMonth, tDay] = targetIST.split('-');
  const targetPath = `${tYear}/${tMonth}/${tDay}`;

  const yesterdayTargetTime = new Date(targetTime.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayTargetIST = yesterdayTargetTime.toISOString().split('T')[0];
  const [yYear, yMonth, yDay] = yesterdayTargetIST.split('-');
  const yesterdayTargetPath = `${yYear}/${yMonth}/${yDay}`;

  return { todayPath, targetPath, yesterdayTargetPath };
}

/* ── Facebook Collector pages: the primary source ──

   District Collectors publish closure orders on their own Facebook pages,
   usually before the news picks them up and often as an image poster with no
   caption. fb_scraper.py drives a logged-in browser, OCRs any posters, and
   prints one verdict per district; whatever it returns is treated as
   authoritative here, because it is the office that issues the order talking
   directly rather than a paper describing it.

   Every failure mode is non-fatal by design. A missing Python, an expired
   Facebook session, an unreadable poster, a timeout — each simply yields
   fewer districts, and the news pipeline downstream covers the rest. The one
   thing this must never do is take the whole scrape down with it. */

/* Write status.js from an evidence map alone.

   Used when the Collector pages produced findings but the news sweep came back
   empty — the full path in runScraper() needs article bodies for IMD alerts and
   exam advisories, neither of which exist here. Districts absent from the map
   are written as `none`, exactly as the news path writes them. */
async function publishStatus(outDir, evidenceMap, chosenUrl, chosenTitle, istTimeInfo) {
  const { targetStr, targetLabel, checkedAt } = istTimeInfo;

  const districtsData = DISTRICTS_LIST.map(dist => {
    if (!evidenceMap.has(dist)) {
      return {
        name: dist, status: 'none', alert: 'none', confidence: null, scope: null,
        appliesTo: null, excludes: null, reason: null, declaredBy: null,
        exams: null, confidenceNote: null, sources: []
      };
    }

    const readings = evidenceMap.get(dist);
    const reading = pickBestReading(readings);
    const usedOcr = readings.some(r => r.tier === 0 && r.isImagePost);

    let confidenceNote = 'Announced by the District Collector on Facebook.';
    if (usedOcr) {
      confidenceNote += ' Read from an image poster by OCR — verify against the original post.';
    }

    return {
      name: dist,
      status: 'confirmed',
      alert: 'none',
      confidence: 95,
      scope: reading.scope,
      appliesTo: reading.appliesTo,
      excludes: reading.excludes,
      reason: reading.reason,
      declaredBy: `District Collector, ${dist}`,
      exams: 'Scheduled public and university examinations proceed unless specified.',
      confidenceNote,
      sources: readings.map(r => ({
        name: r.source.name,
        title: r.source.title,
        url: r.source.url,
        time: 'Latest Update',
        tier: r.tier === 0 ? 0 : 1
      }))
    };
  });

  const confirmedCount = districtsData.filter(d => d.status === 'confirmed' && d.scope === 'District-wide').length;
  const partialCount = districtsData.filter(d => d.status === 'confirmed' && d.scope !== 'District-wide').length;
  const plural = n => (n === 1 ? 'district' : 'districts');
  let headline;
  if (confirmedCount === 0 && partialCount > 0) {
    headline = `Partial/conditional closures in ${partialCount} ${plural(partialCount)}. No district-wide holiday declared.`;
  } else {
    headline = `Holidays declared in ${confirmedCount} ${plural(confirmedCount)}`;
    headline += partialCount > 0
      ? ` and partial/conditional closures in ${partialCount} other ${plural(partialCount)}.`
      : '.';
  }

  const finalJson = {
    forDate: targetStr,
    forDateLabel: targetLabel,
    checkedAt,
    headline,
    advisories: [{
      level: 'warn',
      title: 'Announcements may still be issued tonight',
      body: 'Individual District Collectors continue to review local conditions. Remaining districts under rain warnings may still issue closure orders later tonight.'
    }],
    // No article was read this run, so there is no IMD summary to quote. Empty
    // strings keep the shape the frontend expects while it hides the section.
    weather: { summary: '', outlook: '', impact: '', source: { name: '', url: chosenUrl || '' } },
    districts: districtsData,
    debunked: [],
    limitations: [
      'Read from official District Collector Facebook pages. No news report was available this run to cross-check against.'
    ]
  };

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const nEvents = updateHistory(outDir, finalJson);
  const jsContent = `/* Kerala Rain Holiday Watch — findings data */\nwindow.KERALA_STATUS = ${JSON.stringify(finalJson, null, 2)};\n`;
  fs.writeFileSync(path.join(outDir, 'status.js'), jsContent, 'utf-8');

  await notifySubscribers(finalJson);
  await notifyTelegramSubscribers(finalJson);

  console.log(`[Scraper] Wrote status from Collector pages alone. (${nEvents} transitions retained)`);
  return true;
}

const FB_SCRAPER_TIMEOUT_MS = 5 * 60 * 1000;
const PYTHON_BIN = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const FB_SCRAPER_ENABLED = process.env.FB_SCRAPER_DISABLED !== '1';

async function scrapeFacebookCollectors() {
  if (!FB_SCRAPER_ENABLED) {
    console.log('[FB] Disabled via FB_SCRAPER_DISABLED — using news sources only.');
    return {};
  }

  const scriptPath = path.join(__dirname, 'fb_scraper.py');
  if (!fs.existsSync(scriptPath)) {
    console.warn('[FB] fb_scraper.py not found — using news sources only.');
    return {};
  }

  const started = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(
      PYTHON_BIN,
      [scriptPath, '--max-posts', '4'],
      {
        cwd: __dirname,
        timeout: FB_SCRAPER_TIMEOUT_MS,
        maxBuffer: 12 * 1024 * 1024,
        encoding: 'utf-8',
        windowsHide: true
      }
    );

    // The script logs progress on stderr and prints only JSON on stdout, so
    // stderr here is information rather than failure.
    if (stderr && stderr.trim()) {
      for (const line of stderr.trim().split('\n')) {
        console.log(`[FB] ${line.replace(/^\[fb_scraper\]\s*/, '')}`);
      }
    }

    const jsonStart = stdout.indexOf('{');
    if (jsonStart === -1) {
      console.warn('[FB] No JSON on stdout — using news sources only.');
      return {};
    }

    const parsed = JSON.parse(stdout.slice(jsonStart));
    const findings = parsed.findings || {};

    if (parsed.ocrAvailable === false) {
      console.warn('[FB] OCR unavailable — image-only posters were skipped. See SETUP_TESSERACT.md');
    }

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const names = Object.keys(findings);
    console.log(`[FB] ${names.length} district(s) with a Collector declaration in ${elapsed}s` +
      (names.length ? `: ${names.join(', ')}` : '.'));

    return findings;
  } catch (e) {
    // ETIMEDOUT arrives with whatever the child had already written; there is
    // no partial-result contract, so treat it as an empty run like any other.
    const reason = e.killed ? `timed out after ${FB_SCRAPER_TIMEOUT_MS / 1000}s` : e.message;
    console.warn(`[FB] Collector scrape unavailable (${reason}) — falling back to news sources.`);
    return {};
  }
}

/* Shape a fb_scraper.py verdict like the readings the news pipeline builds, so
   the merge step downstream does not need to know where it came from. Tier 0
   sits above every news tier, which is what makes pickBestReading prefer it. */
function fbFindingToReading(finding, district) {
  return {
    status: 'confirmed',
    scope: finding.scope,
    appliesTo: finding.appliesTo,
    excludes: finding.excludes,
    reason: finding.reason,
    qualified: true,
    tier: 0,
    isImagePost: !!finding.isImagePost,
    source: {
      name: 'District Collector (Facebook)',
      title: finding.sourceTitle || `District Collector, ${district}`,
      url: finding.sourceUrl
    }
  };
}

async function runScraper() {
  console.log(`[Scraper] Starting scrape run: ${new Date().toISOString()}`);
  const outDir = path.join(__dirname, 'data');

  // Get today's date in IST for URL matching
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);

  // Phase 1 — the Collector pages themselves. Runs before the news sweep so
  // that a district the Collector has already spoken about is settled by the
  // time the papers are read.
  const evidenceMap = new Map();
  let fbFindings = {};
  try {
    fbFindings = await scrapeFacebookCollectors();
  } catch (e) {
    console.warn(`[FB] Unexpected failure (${e.message}) — falling back to news sources.`);
    fbFindings = {};
  }

  for (const [dist, finding] of Object.entries(fbFindings)) {
    if (!DISTRICTS_LIST.includes(dist) || !finding || !finding.scope) continue;
    evidenceMap.set(dist, [fbFindingToReading(finding, dist)]);
  }
  const fbDistricts = new Set(evidenceMap.keys());

  // Multi-source news fetching
  const sources = [
    { name: 'Onmanorama', newsUrl: 'https://www.onmanorama.com/news/kerala.html', domain: 'https://www.onmanorama.com' },
    { name: 'Mathrubhumi', newsUrl: 'https://www.mathrubhumi.com/news/kerala', domain: 'https://www.mathrubhumi.com' },
    { name: 'Manorama', newsUrl: 'https://www.manoramaonline.com/news/latest-news.html', domain: 'https://www.manoramaonline.com' }
  ];

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36'
  };

  const { todayPath, targetPath, yesterdayTargetPath } = getDatePaths();

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
      // No news today does not mean no holiday — the Collector may have posted
      // one. Only write the empty status when neither source found anything.
      if (fbDistricts.size === 0) {
        console.log("[-] No rain holiday news articles found on any source. Writing no-holiday status.");
        return writeNoHolidayStatus(outDir, getISTTime(), null);
      }
      console.log(`[-] No news articles found, but ${fbDistricts.size} Collector declaration(s) stand. Publishing those.`);
      return publishStatus(outDir, evidenceMap, '', '', getISTTime());
    }

    console.log(`[Scraper] Found ${candidates.length} candidate article(s):`);
    candidates.forEach((c, i) => {
      console.log(`  [${i}] [${c.source}] "${c.title.substring(0, 60)}..." - ${c.href}`);
    });

    // Accept recent articles (today or yesterday) - content may describe tomorrow's closures
    // Bypass target path check for Mathrubhumi since its URLs do not contain date paths
    let recentCandidates = candidates.filter(c =>
      c.source === 'Mathrubhumi' ||
      c.href.includes(todayPath) ||
      c.href.includes(targetPath) ||
      c.href.includes(yesterdayTargetPath)
    );

    if (recentCandidates.length > 0) {
      const globalMinTier = Math.min(...recentCandidates.map(c => getCandidateTier(c.url, c.title)));
      recentCandidates = recentCandidates.filter(c => getCandidateTier(c.url, c.title) === globalMinTier);
    }

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
      if (fbDistricts.size === 0) {
        console.log(`[Scraper] No recent articles found. Writing no-holiday status.`);
        return writeNoHolidayStatus(outDir, getISTTime(), null);
      }
      console.log(`[Scraper] No recent articles, but ${fbDistricts.size} Collector declaration(s) stand. Publishing those.`);
      return publishStatus(outDir, evidenceMap, '', '', getISTTime());
    }

    console.log(`[Scraper] Using ${recentCandidates.length} recent article(s) for evidence gathering...`);

    const { targetStr, targetLabel, checkedAt } = getISTTime();

    // 2. Gather evidence from recent articles. evidenceMap already carries the
    // Collector findings from Phase 1; news readings append to it.
    let chosenBody = '';
    let chosenUrl = '';
    let chosenTitle = '';

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

        chosenBody += '\n\n' + fullBodyText;
        if (!chosenUrl) {
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
            const windowStart = Date.UTC(yr, mo - 1, dy - 1, 13, 0, 0); // 6:30 PM IST (aligns with rollover)
            const windowEnd = Date.UTC(yr, mo - 1, dy, 13, 0, 0);
            
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
          const pClean = p.replace(/^[^:\n•●∙\-\—\|]{2,50}[:•●∙\-\—\|]\s*/, '');
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

          // Split paragraph into sentences
          const sentences = pClean.split(/(?<=[.!?])\s+/);
          for (const sentence of sentences) {
            const sentenceTrimmed = sentence.trim();
            if (!sentenceTrimmed) continue;

            // Find all districts mentioned in the sentence
            const mentionedDists = [];
            for (const dist of DISTRICTS_LIST) {
              const namesToCheck = [dist.toLowerCase()].concat(
                (DISTRICT_TRANSLATIONS[dist] || []).map(n => n.toLowerCase())
              );
              if (namesToCheck.some(name => sentenceTrimmed.toLowerCase().includes(name))) {
                mentionedDists.push(dist);
              }
            }

            const targetDists = mentionedDists.length > 0 ? mentionedDists : (activeDistrict ? [activeDistrict] : []);
            if (targetDists.length === 0) continue;

            const baseReading = deriveReading(sentenceTrimmed);
            if (!baseReading) continue;

            // Segment the sentence to isolate taluks per district
            const segments = segmentTextByDistricts(sentenceTrimmed);
            const segDict = {};
            for (const seg of segments) {
              if (seg.dist) {
                segDict[seg.dist] = seg.text;
              }
            }

            for (const dist of targetDists) {
              const reading = Object.assign({}, baseReading);

              // Override taluks if multiple districts mentioned in this sentence
              if (targetDists.length > 1 && segDict[dist]) {
                const segText = segDict[dist];
                const localTaluks = extractTaluks(segText);
                if (localTaluks.length > 0) {
                  const label = localTaluks.join(", ") + (localTaluks.length === 1 ? " taluk" : " taluks");
                  if (reading.scope.startsWith("Relief camp schools in")) {
                    reading.scope = "Relief camp schools in " + label + " only";
                    reading.appliesTo = "Schools functioning as relief camps in " + label + ".";
                  } else {
                    reading.scope = label + " only";
                    const typeLabel = (reading.appliesTo || "").includes("except professional colleges") ? 
                      "Educational institutions except professional colleges" : "All educational institutions";
                    reading.appliesTo = typeLabel + " in " + label + ".";

                    const mentionsReliefCamp = sentenceTrimmed.toLowerCase().includes("relief camp") || 
                      sentenceTrimmed.toLowerCase().includes("relief-camp") ||
                      sentenceTrimmed.toLowerCase().includes("ദുരിതാശ്വാസ") || 
                      sentenceTrimmed.toLowerCase().includes("ക്യാമ്പ്");
                    const reliefCampOnly = mentionsReliefCamp && (
                      sentenceTrimmed.toLowerCase().includes("only") || 
                      sentenceTrimmed.toLowerCase().includes("except") || 
                      sentenceTrimmed.toLowerCase().includes("functioning as") ||
                      sentenceTrimmed.toLowerCase().includes("പ്രവർത്തിക്കുന്ന") || 
                      sentenceTrimmed.toLowerCase().includes("മാത്രം"));

                    if (reliefCampOnly) {
                      reading.appliesTo += " Elsewhere in the district, only schools functioning as relief camps are closed.";
                      reading.excludes = "Institutions outside " + label + " that are not relief camps.";
                    }
                  }
                } else {
                  // No local taluks, check for relief camp
                  if (sentenceTrimmed.toLowerCase().includes("relief camp") || 
                      sentenceTrimmed.toLowerCase().includes("relief-camp") ||
                      sentenceTrimmed.toLowerCase().includes("ദുരിതാശ്വാസ") || 
                      sentenceTrimmed.toLowerCase().includes("ക്യാമ്പ്")) {
                    reading.scope = "Relief camp schools only";
                    reading.appliesTo = "All schools functioning as relief camps";
                    reading.excludes = "All other educational institutions";
                    reading.reason = "Schools serving as relief camps during floods";
                  }
                }
              }

              districtReadingsMap[dist].push(reading);
            }
          }
        }

        // Now update evidenceMap with best readings
        for (const dist of DISTRICTS_LIST) {
          const readings = districtReadingsMap[dist];
          if (readings && readings.length > 0) {
            if (!evidenceMap.has(dist)) evidenceMap.set(dist, []);

            const bestReading = pickBestReading(readings);

            evidenceMap.get(dist).push({
              status: "confirmed",
              scope: bestReading.scope,
              appliesTo: bestReading.appliesTo,
              excludes: bestReading.excludes,
              reason: bestReading.reason,
              qualified: bestReading.qualified || false,
              tier: getCandidateTier(candidate.url, candidate.title),
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

        // Collector Facebook is tier 0, the most authoritative source. When it
        // stands alone confidence is already 95; news corroboration lifts it
        // further but does not replace it.
        const hasFacebook = readings.some(r => r.tier === 0);
        let confidence = 60;
        if (hasFacebook && sourceCount >= 3) {
          confidence = 99;
        } else if (hasFacebook && sourceCount >= 2) {
          confidence = 98;
        } else if (hasFacebook) {
          confidence = 95;
        } else if (sourceCount >= 3) {
          confidence = 92;
        } else if (sourceCount >= 2) {
          confidence = 80;
        }

        // "Reported by" understates a Collector order — that page issues the
        // order rather than reporting one, so it gets its own phrasing.
        let confidenceNote;
        if (hasFacebook) {
          const newsNames = [...new Set(readings.filter(r => r.tier !== 0).map(r => r.source.name))];
          confidenceNote = 'Announced by the District Collector on Facebook';
          confidenceNote += newsNames.length
            ? `, corroborated by ${newsNames.join(', ')}.`
            : '.';
          if (readings.some(r => r.tier === 0 && r.isImagePost)) {
            confidenceNote += ' Read from an image poster by OCR — verify against the original post.';
          }
        } else if (sourceCount === 1) {
          confidenceNote = `Reported by ${readings[0].source.name}.`;
        } else {
          confidenceNote = `Reported by ${readings.map(r => r.source.name).join(', ')}.`;
        }

        const minTier = Math.min(...readings.map(r => r.tier || 1));
        const filteredReadings = readings.filter(r => (r.tier || 1) === minTier);
        const reading = pickBestReading(filteredReadings);

        // Date-scoped override for Kozhikode (2026-08-05):
        // Mathrubhumi article body is truncated by the site before reaching the exclusion paragraph,
        // so the scraper cannot auto-detect it. This override applies the known DC announcement:
        // Professional colleges are NOT included in the holiday.
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
    const plural = n => (n === 1 ? "district" : "districts");
    let headline;
    // A day with only taluk or relief-camp orders is now the common case, so it
    // gets its own sentence rather than "declared in 0 districts".
    if (confirmedCount === 0 && partialCount > 0) {
      headline = `Partial/conditional closures in ${partialCount} ${plural(partialCount)}. No district-wide holiday declared.`;
    } else {
      headline = `Holidays declared in ${confirmedCount} ${plural(confirmedCount)}`;
      if (partialCount > 0) {
        headline += ` and partial/conditional closures in ${partialCount} other ${plural(partialCount)}.`;
      } else {
        headline += ".";
      }
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
