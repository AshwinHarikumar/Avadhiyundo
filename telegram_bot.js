const fs = require('fs');
const path = require('path');
const axios = require('axios');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

const DISTRICTS_LIST = [
  "Thiruvananthapuram", "Kollam", "Pathanamthitta", "Alappuzha", "Kottayam",
  "Idukki", "Ernakulam", "Thrissur", "Palakkad", "Malappuram",
  "Kozhikode", "Wayanad", "Kannur", "Kasaragod"
];

const DISTRICT_TRANSLATIONS = {
  "Thiruvananthapuram": ["തിരുവനന്തപുരം", "tvm", "trivandrum"],
  "Kollam": ["കൊല്ലം"],
  "Pathanamthitta": ["പത്തനംതിട്ട"],
  "Alappuzha": ["ആലപ്പുഴ"],
  "Kottayam": ["കോട്ടയം"],
  "Idukki": ["ഇടുക്കി"],
  "Ernakulam": ["എറണാകുളം", "kochi", "ernakulam"],
  "Thrissur": ["തൃശ്ശൂർ", "തൃശൂർ"],
  "Palakkad": ["പാലക്കാട്"],
  "Malappuram": ["മലപ്പുറം"],
  "Kozhikode": ["കോഴിക്കോട്", "calicut"],
  "Wayanad": ["വയനാട്"],
  "Kannur": ["കണ്ണൂർ"],
  "Kasaragod": ["കാസർഗോഡ്", "കാസർകോട്"]
};

let telegramOffset = 0;
let isPolling = false;

// Read subscriptions file
function readTelegramSubscriptions() {
  try {
    const subsPath = path.join(__dirname, 'data', 'telegram_subs.json');
    if (!fs.existsSync(subsPath)) {
      // Create data directory if it doesn't exist
      const dataDir = path.join(__dirname, 'data');
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }
      fs.writeFileSync(subsPath, '[]', 'utf-8');
      return [];
    }
    const data = fs.readFileSync(subsPath, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.error("[Telegram Bot] Failed to read subscriptions:", e.message);
    return [];
  }
}

// Write subscriptions file
function writeTelegramSubscriptions(subs) {
  try {
    const subsPath = path.join(__dirname, 'data', 'telegram_subs.json');
    fs.writeFileSync(subsPath, JSON.stringify(subs, null, 2), 'utf-8');
  } catch (e) {
    console.error("[Telegram Bot] Failed to write subscriptions:", e.message);
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
    console.error("[Telegram Bot] Error parsing status.js:", e.message);
    return null;
  }
}

// Resolve user input to district name
function resolveDistrict(input) {
  if (!input) return null;
  const clean = input.trim().toLowerCase();
  
  // Direct matches
  const match = DISTRICTS_LIST.find(d => d.toLowerCase() === clean);
  if (match) return match;
  
  // Check translation maps
  for (const [englishName, malTranslations] of Object.entries(DISTRICT_TRANSLATIONS)) {
    if (malTranslations.some(t => clean.includes(t.toLowerCase()))) {
      return englishName;
    }
  }
  
  // Partial matches
  const partialMatch = DISTRICTS_LIST.find(d => d.toLowerCase().includes(clean) || clean.includes(d.toLowerCase()));
  if (partialMatch) return partialMatch;
  
  return null;
}

// Format bilingual status label with Malayalam translations
function getStatusLabel(status, isPartial) {
  if (status === 'confirmed') {
    return isPartial 
      ? "*Partial Closure* (ഭാഗിക അവധി)" 
      : "*Full Holiday Declared* (അവധി പ്രഖ്യാപിച്ചു)";
  } else if (status === 'false') {
    return "*Debunked / No Holiday* (അവധിയില്ല)";
  } else if (status === 'unconfirmed') {
    return "*Rumoured / Unconfirmed* (സ്ഥിരീകരിച്ചിട്ടില്ല)";
  } else {
    return "*No Announcement / Pending* (അറിയിപ്പ് ലഭ്യമല്ല)";
  }
}

// Send telegram message
async function sendTelegramMessage(chatId, text, options = {}) {
  try {
    await axios.post(`${API_URL}/sendMessage`, {
      chat_id: chatId,
      text: text,
      parse_mode: 'Markdown',
      ...options
    }, { timeout: 10000 });
  } catch (err) {
    console.error(`[Telegram Bot] Error sending message to ${chatId}:`, err.message);
  }
}

// Send telegram photo (with fallback to message)
async function sendTelegramPhoto(chatId, photoUrl, caption, options = {}) {
  try {
    await axios.post(`${API_URL}/sendPhoto`, {
      chat_id: chatId,
      photo: photoUrl,
      caption: caption,
      parse_mode: 'Markdown',
      ...options
    }, { timeout: 15000 });
  } catch (err) {
    console.error(`[Telegram Bot] Error sending photo to ${chatId}:`, err.message);
    // Fallback to text message if photo fails
    await sendTelegramMessage(chatId, caption, options);
  }
}

// Generate keyboard of districts for subscribing
function getDistrictKeyboard(command) {
  const keyboard = [];
  for (let i = 0; i < DISTRICTS_LIST.length; i += 2) {
    const row = [];
    row.push({ text: `/${command} ${DISTRICTS_LIST[i]}` });
    if (i + 1 < DISTRICTS_LIST.length) {
      row.push({ text: `/${command} ${DISTRICTS_LIST[i + 1]}` });
    }
    keyboard.push(row);
  }
  return {
    keyboard: keyboard,
    one_time_keyboard: true,
    resize_keyboard: true
  };
}

// Handle incoming update
async function handleTelegramUpdate(update) {
  const message = update.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id;
  const text = message.text.trim();
  const lowerText = text.toLowerCase();

  // /start or /help
  if (lowerText === '/start' || lowerText === '/help' || lowerText === 'help') {
    const welcome = `🌧 *Kerala Rain Holiday Watch* 🌧\n\n` +
      `Check if schools and colleges are off tomorrow across Kerala's 14 districts.\n\n` +
      `*Commands:*\n` +
      `• Type a district name (e.g. \`Kottayam\` or \`കണ്ണൂർ\`) to check its status.\n` +
      `• /subscribe - Subscribe to automated holiday alerts for a district.\n` +
      `• /unsubscribe - Stop receiving notifications for a district.\n` +
      `• /all - Get tomorrow's holiday status for all 14 districts.\n` +
      `• /help - Show this message.`;
    
    // Send the logo.png from the deployed server
    const logoUrl = 'https://avadhiyundo.onrender.com/logo.png';
    await sendTelegramPhoto(chatId, logoUrl, welcome);
    return;
  }

  // /all summary
  if (lowerText === '/all') {
    const statusData = readCurrentStatus();
    if (!statusData) {
      await sendTelegramMessage(chatId, "⚠️ Holiday data is currently unavailable. Please try again later.");
      return;
    }

    let response = `📅 *Holiday Status — ${statusData.forDateLabel}*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    const confirmed = statusData.districts.filter(d => d.status === 'confirmed');
    const partial = statusData.districts.filter(d => d.status === 'confirmed' && 
      (((d.scope || "") + " " + (d.appliesTo || "")).toLowerCase().includes("relief") || 
       ((d.scope || "") + " " + (d.appliesTo || "")).toLowerCase().includes("taluk"))
    );
    const full = confirmed.filter(d => !partial.includes(d));

    if (full.length > 0) {
      response += `✅ *Holiday Declared (അവധി പ്രഖ്യാപിച്ചു):*\n` +
        `• ${full.map(d => d.name).join(', ')}\n\n`;
    }

    if (partial.length > 0) {
      response += `⚠️ *Partial Closures (ഭാഗിക അവധി):*\n` +
        `• ${partial.map(d => `${d.name} (${d.scope})`).join(', ')}\n\n`;
    }

    const none = statusData.districts.filter(d => d.status === 'none');
    if (none.length > 0) {
      response += `⏳ *No Announcement / Pending (അറിയിപ്പ് ലഭ്യമല്ല):*\n` +
        `• ${none.map(d => d.name).join(', ')}\n\n`;
    }

    const debunked = statusData.districts.filter(d => d.status === 'false');
    if (debunked.length > 0) {
      response += `🚫 *Debunked / Fake News (അവധിയില്ല):*\n` +
        `• ${debunked.map(d => d.name).join(', ')}\n\n`;
    }

    const timeStr = new Date(statusData.checkedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    response += `⏱ _Checked at: ${timeStr} IST_\n` +
      `🔗 [Kerala Rain Holiday Watch](https://avadhiyundo.onrender.com/)`;
    await sendTelegramMessage(chatId, response, { disable_web_page_preview: true });
    return;
  }

  // /subscribe command
  if (lowerText.startsWith('/subscribe')) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      await sendTelegramMessage(chatId, "Please select the district you want to subscribe to:", {
        reply_markup: getDistrictKeyboard('subscribe')
      });
      return;
    }

    const districtInput = parts.slice(1).join(" ");
    const resolved = resolveDistrict(districtInput);
    if (!resolved) {
      await sendTelegramMessage(chatId, `⚠️ District "${districtInput}" not recognized. Please choose a valid Kerala district.`);
      return;
    }

    const subs = readTelegramSubscriptions();
    const alreadySubscribed = subs.some(s => s.chatId === chatId && s.district === resolved);

    if (alreadySubscribed) {
      await sendTelegramMessage(chatId, `✅ You are already subscribed to alerts for *${resolved}*.`);
      return;
    }

    subs.push({
      chatId: chatId,
      district: resolved,
      sentFor: {}
    });
    writeTelegramSubscriptions(subs);

    await sendTelegramMessage(chatId, `🔔 *Subscribed!* You will now receive a notification if a holiday is declared for *${resolved}*.\n\nType /unsubscribe to manage subscriptions.`);
    return;
  }

  // /unsubscribe command
  if (lowerText.startsWith('/unsubscribe')) {
    const parts = text.split(/\s+/);
    const subs = readTelegramSubscriptions();
    const userSubs = subs.filter(s => s.chatId === chatId);

    if (userSubs.length === 0) {
      await sendTelegramMessage(chatId, "You don't have any active subscriptions.");
      return;
    }

    if (parts.length < 2) {
      const keyboard = userSubs.map(s => [{ text: `/unsubscribe ${s.district}` }]);
      await sendTelegramMessage(chatId, "Select the district you want to unsubscribe from:", {
        reply_markup: {
          keyboard: keyboard,
          one_time_keyboard: true,
          resize_keyboard: true
        }
      });
      return;
    }

    const districtInput = parts.slice(1).join(" ");
    const resolved = resolveDistrict(districtInput);
    if (!resolved) {
      await sendTelegramMessage(chatId, `⚠️ District "${districtInput}" not recognized.`);
      return;
    }

    const newSubs = subs.filter(s => !(s.chatId === chatId && s.district === resolved));
    writeTelegramSubscriptions(newSubs);

    await sendTelegramMessage(chatId, `🔕 *Unsubscribed!* You will no longer receive alerts for *${resolved}*.`);
    return;
  }

  // Fallback: Check if user typed a district name
  const resolved = resolveDistrict(text);
  if (resolved) {
    const statusData = readCurrentStatus();
    if (!statusData) {
      await sendTelegramMessage(chatId, "⚠️ Holiday data is currently unavailable. Please try again later.");
      return;
    }

    const dist = statusData.districts.find(d => d.name === resolved);
    if (!dist) {
      await sendTelegramMessage(chatId, `District "${resolved}" not found in current dataset.`);
      return;
    }

    const isPartial = ((dist.scope || "") + " " + (dist.appliesTo || "")).toLowerCase().includes("relief") || 
                     ((dist.scope || "") + " " + (dist.appliesTo || "")).toLowerCase().includes("taluk");
    
    let response = `📍 *${dist.name} District*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📅 *Date:* ${statusData.forDateLabel}\n` +
      `📝 *Status:* ${getStatusLabel(dist.status, isPartial)}\n`;
      
    if (dist.alert && dist.alert !== 'none') {
      response += `🚨 *IMD Alert:* ${dist.alert.toUpperCase()} Alert\n`;
    }
    
    if (dist.status === 'confirmed') {
      response += `\nℹ️ *Details:*\n`;
      if (dist.appliesTo) response += `• *Applies to:* ${dist.appliesTo}\n`;
      if (dist.excludes) response += `• *Excludes:* ${dist.excludes}\n`;
      if (dist.exams) response += `• *Exams:* ${dist.exams}\n`;
      if (dist.declaredBy) response += `• *Authority:* ${dist.declaredBy}\n`;
    } else if (dist.status === 'false') {
      if (dist.reason) response += `\n💬 *Note:* ${dist.reason}\n`;
    }

    if (dist.sources && dist.sources.length > 0) {
      response += `\n📰 *Sources:*\n`;
      dist.sources.forEach(src => {
        response += `• [${src.name}](${src.url})\n`;
      });
    }

    const timeStr = new Date(statusData.checkedAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    response += `\n⏱ _Checked at: ${timeStr} IST_\n` +
      `🔗 [Kerala Rain Holiday Watch](https://avadhiyundo.onrender.com/)`;
    
    await sendTelegramMessage(chatId, response, { disable_web_page_preview: true });
  } else {
    // Unknown text
    await sendTelegramMessage(chatId, "I didn't recognize that command or district. Type /help to see what I can do!");
  }
}

async function pollTelegramUpdates() {
  if (!isPolling) return;
  let delay = 1000;
  try {
    const res = await axios.get(`${API_URL}/getUpdates`, {
      params: { offset: telegramOffset, timeout: 25 },
      timeout: 30000
    });
    if (res.data && res.data.ok) {
      for (const update of res.data.result) {
        telegramOffset = update.update_id + 1;
        await handleTelegramUpdate(update);
      }
    }
  } catch (err) {
    // Avoid logging generic network timeouts to reduce log noise
    if (err.code !== 'ECONNABORTED' && (!err.response || err.response.status !== 502)) {
      if (err.response && err.response.status === 409) {
        console.warn("[Telegram Bot] Polling conflict (409): Another bot instance is active with this token. Retrying in 15 seconds...");
        delay = 15000;
      } else {
        console.error("[Telegram Bot] Polling error:", err.message);
      }
    }
  }
  // Schedule next poll immediately
  if (isPolling) {
    setTimeout(pollTelegramUpdates, delay);
  }
}

// Notify subscribers about a holiday
async function notifyTelegramSubscribers(statusData) {
  if (!TELEGRAM_BOT_TOKEN || !statusData || !statusData.districts) return;

  const subs = readTelegramSubscriptions();
  if (subs.length === 0) return;

  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffset);
  const todayStr = istNow.toISOString().split('T')[0];
  const targetDate = statusData.forDate || todayStr;

  let hasChanged = false;

  for (const sub of subs) {
    if (!sub.district || !sub.chatId) continue;

    const district = statusData.districts.find(d => d.name === sub.district);
    if (!district) continue;

    const isHoliday = district.status === "confirmed";
    if (!isHoliday) continue;

    const isPartial = ((district.scope || "") + " " + (district.appliesTo || "")).toLowerCase().includes("relief") || 
                     ((district.scope || "") + " " + (district.appliesTo || "")).toLowerCase().includes("taluk");

    const key = sub.district + "|" + targetDate;
    if (!sub.sentFor) sub.sentFor = {};
    if (sub.sentFor[key]) continue; // Already notified for this district and date


    let message = `🔔 *NEW HOLIDAY ANNOUNCEMENT*\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `📍 *District:* ${district.name}\n` +
      `📅 *Date:* ${statusData.forDateLabel}\n` +
      `📝 *Status:* ${getStatusLabel(district.status, isPartial)}\n`;

    if (district.alert && district.alert !== 'none') {
      message += `🚨 *IMD Alert:* ${district.alert.toUpperCase()} Alert\n`;
    }

    message += `\nℹ️ *Details:*\n`;
    if (district.appliesTo) message += `• *Applies to:* ${district.appliesTo}\n`;
    if (district.excludes) message += `• *Excludes:* ${district.excludes}\n`;
    if (district.exams) message += `• *Exams:* ${district.exams}\n`;
    if (district.declaredBy) message += `• *Authority:* ${district.declaredBy}\n`;
    
    message += `\n🔗 Check details: https://avadhiyundo.onrender.com/`;

    console.log(`[Telegram Bot] Sending alert to ${sub.chatId} for ${district.name}`);
    await sendTelegramMessage(sub.chatId, message, { disable_web_page_preview: true });
    
    sub.sentFor[key] = true;
    hasChanged = true;
  }

  // Clean up old sentFor keys (older than 3 days)
  const cutoff = new Date(istNow.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
  for (const sub of subs) {
    if (sub.sentFor) {
      for (const key of Object.keys(sub.sentFor)) {
        const date = key.split("|")[1];
        if (date < cutoff) {
          delete sub.sentFor[key];
          hasChanged = true;
        }
      }
    }
  }

  if (hasChanged) {
    writeTelegramSubscriptions(subs);
  }
}

// Initializer
function initTelegramBot() {
  if (!TELEGRAM_BOT_TOKEN) {
    console.log("[Telegram Bot] TELEGRAM_BOT_TOKEN environment variable not set. Bot is disabled.");
    return;
  }

  console.log("[Telegram Bot] Initializing Telegram Bot...");
  isPolling = true;
  pollTelegramUpdates();
}

module.exports = {
  initTelegramBot,
  notifyTelegramSubscribers
};
