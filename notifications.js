const https = require('https');
const http = require('http');

// Telegram config (free)
const TG_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT_IDS = (process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);

console.log(`[Telegram] Bot token: ${TG_BOT_TOKEN ? '✓ SET' : '✗ NOT SET'}`);
console.log(`[Telegram] Chat IDs: ${TG_CHAT_IDS.length ? TG_CHAT_IDS.join(', ') : 'NONE'}`);

// Twilio config (paid fallback)
const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const FROM_SMS = process.env.TWILIO_PHONE_NUMBER;
const FROM_WHATSAPP = process.env.TWILIO_WHATSAPP_NUMBER || 'whatsapp:+14155238886';
const TO_NUMBERS = [
  process.env.NOTIFY_PHONE || '+8613418092985',
  '+919987199973',
];

let client = null;
if (ACCOUNT_SID && AUTH_TOKEN && !ACCOUNT_SID.includes('XXXXX')) {
  try {
    client = require('twilio')(ACCOUNT_SID, AUTH_TOKEN);
  } catch (err) {
    console.error('Twilio initialization failed:', err.message);
  }
}

const notifiedOrders = new Set();

const SEPARATOR = '━━━━━━━━━━━━━━━━━━━━';

function formatTime(createdTime) {
  return createdTime ? new Date(createdTime).toLocaleString('en-US', { timeZone: 'UTC' }) + ' UTC' : new Date().toISOString();
}

function versionLabel(v) {
  if (v === 'player') return 'Player';
  if (v === 'retro') return 'Retro';
  return 'Fan';
}

function categoryLabel(item) {
  if (item.category) return item.category;
  if (item.version === 'retro') return 'Retro';
  if (item.club || item.team_name) return 'Club';
  return 'National';
}

function itemFields(item, currencySymbol) {
  const price = `${currencySymbol}${Number(item.unit_price || item.price || 0).toFixed(2)}`;
  return {
    name: item.jersey_name || 'Jersey',
    version: versionLabel(item.version),
    size: item.size || 'N/A',
    category: categoryLabel(item),
    season: item.season || 'N/A',
    qty: item.quantity || 1,
    price,
    player: item.name_text || item.player_name || null,
  };
}

function formatNotificationMessage(orderData) {
  const {
    orderId,
    customerName,
    phone,
    email,
    address,
    country,
    total,
    currencySymbol = '€',
    paymentStatus = 'Paid',
    paymentMethod = 'Online',
    createdTime,
    items = []
  } = orderData;

  const productBlocks = items.map((item, idx) => {
    const f = itemFields(item, currencySymbol);
    const header = items.length > 1 ? `📦 Product #${idx + 1}` : '📦 Product';
    let block = `${header}

• Jersey:
${f.name}

• Version:
${f.version}

• Size:
${f.size}

• Category:
${f.category}

• Season:
${f.season}

• Quantity:
${f.qty}

• Price:
${f.price}`;
    if (f.player) block += `

• Player Name:
${f.player}`;
    return block;
  }).join(`\n\n${SEPARATOR}\n\n`);

  return `🛒 NEW ORDER RECEIVED

${SEPARATOR}

${productBlocks}

${SEPARATOR}

👤 Customer

Name:
${customerName || 'N/A'}

Phone:
${phone || 'N/A'}

Email:
${email || 'N/A'}

${SEPARATOR}

📍 Shipping Address

${customerName || 'N/A'}

${address || 'N/A'}

${country || 'N/A'}

${SEPARATOR}

💳 Payment

Method:
${paymentMethod || 'Online'}

Status:
${paymentStatus || 'Paid'}

Order Total:
${currencySymbol}${typeof total === 'number' ? total.toFixed(2) : total}

Order ID:
${orderId}

Date:
${formatTime(createdTime)}

${SEPARATOR}`;
}

function shortPhotoCaption(item, currencySymbol, index, total) {
  const f = itemFields(item, currencySymbol);
  const label = total > 1 ? ` (${index + 1}/${total})` : '';
  return `🛒 NEW ORDER RECEIVED${label}\n${f.name}\n${f.version} • ${f.size} • Qty ${f.qty}\n${f.price}`;
}

function tgPost(method, body) {
  return new Promise((resolve, reject) => {
    const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/${method}`;
    const data = JSON.stringify(body);
    const opts = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: 20000
    };
    const req = https.request(url, opts, res => {
      let r = '';
      res.on('data', c => r += c);
      res.on('end', () => { try { resolve(JSON.parse(r)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram request timed out')); });
    req.write(data);
    req.end();
  });
}

function isRetryable(result) {
  if (!result.ok) {
    const code = result.error_code;
    if (code === 429 || (code >= 500 && code < 600)) return true;
  }
  return false;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tgCall(action) {
  const attempt = async () => {
    try {
      return await action();
    } catch (err) {
      return { ok: false, networkError: true, description: err.message };
    }
  };
  const first = await attempt();
  if (first.ok) return first;
  if (first.networkError || isRetryable(first)) {
    console.warn(`[Notification] Telegram request failed (${first.description || first.error_code}), retrying once...`);
    await sleep(2000);
    return attempt();
  }
  return first;
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch { return reject(new Error('Invalid URL')); }
    const mod = target.protocol === 'https:' ? https : http;
    const opts = {
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': `https://${target.hostname}/`,
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
      timeout: 20000
    };
    const chunks = [];
    const req = mod.get(opts, res => {
      if (res.statusCode !== 200) {
        res.destroy();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Image download timed out')); });
  });
}

function detectMime(buffer) {
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return 'image/png';
  if (buffer[0] === 0x47 && buffer[1] === 0x49) return 'image/gif';
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return 'image/webp';
  if (buffer[0] === 0x42 && buffer[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}

function tgUploadPhoto(chatId, imageBuffer, mimeType, caption) {
  return new Promise((resolve, reject) => {
    const boundary = '----KickoffJerseys' + Math.random().toString(16).slice(2);
    const CRLF = '\r\n';
    const extension = mimeType === 'image/png' ? 'png' : mimeType === 'image/gif' ? 'gif' : 'jpg';
    const parts = [
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="chat_id"${CRLF}${CRLF}`,
      `${chatId}${CRLF}`,
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="caption"${CRLF}${CRLF}`,
      `${caption}${CRLF}`,
      `--${boundary}${CRLF}`,
      `Content-Disposition: form-data; name="photo"; filename="jersey.${extension}"${CRLF}`,
      `Content-Type: ${mimeType}${CRLF}${CRLF}`,
    ];
    const header = Buffer.from(parts.join(''), 'utf8');
    const footer = Buffer.from(`${CRLF}--${boundary}--${CRLF}`, 'utf8');
    const body = Buffer.concat([header, imageBuffer, footer]);

    const opts = {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length,
      },
      timeout: 30000
    };
    const req = https.request(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto`, opts, res => {
      let r = '';
      res.on('data', c => r += c);
      res.on('end', () => { try { resolve(JSON.parse(r)); } catch { resolve({ ok: false }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Telegram upload timed out')); });
    req.write(body);
    req.end();
  });
}

async function sendTelegram(orderData) {
  if (!TG_BOT_TOKEN || !TG_CHAT_IDS.length) return false;

  const message = formatNotificationMessage(orderData);
  const items = orderData.items || [];
  const imageItems = items.filter(item => item.image_url);

  console.log(`[Notification] Images to send: ${imageItems.length} of ${items.length} items`);

  let anySuccess = false;

  for (const chatId of TG_CHAT_IDS) {
    try {
      // 1) Send the full details as plain-text FIRST so the owner is notified instantly.
      //    No parse_mode → can never fail due to entity/HTML parsing.
      const msgResult = await tgCall(() => tgPost('sendMessage', { chat_id: chatId, text: message }));
      if (msgResult.ok) {
        console.log(`[Notification] Telegram details sent to ${chatId}`);
        anySuccess = true;
      } else {
        console.warn(`[Notification] sendMessage to ${chatId} failed:`, msgResult.description || msgResult.error_code || 'unknown');
      }

      // 2) Then attach an image for EVERY ordered jersey via multipart upload.
      //    NOTE: Telegram does NOT accept data: URIs — must upload raw bytes.
      for (let i = 0; i < imageItems.length; i++) {
        const item = imageItems[i];
        try {
          console.log(`[Notification] Downloading image for ${item.jersey_name}...`);
          const imgBuffer = await downloadImage(item.image_url);
          const mime = detectMime(imgBuffer);
          const caption = shortPhotoCaption(item, orderData.currencySymbol || '€', i, imageItems.length);
          const photoResult = await tgCall(() => tgUploadPhoto(chatId, imgBuffer, mime, caption));
          if (photoResult.ok) {
            console.log(`[Notification] Telegram image sent to ${chatId} for ${item.jersey_name}`);
          } else {
            console.warn(`[Notification] sendPhoto to ${chatId} failed for ${item.jersey_name}:`, photoResult.description || photoResult.error_code || 'unknown');
          }
        } catch (imgErr) {
          console.warn(`[Notification] Image processing error for ${item.jersey_name}:`, imgErr.message);
        }
      }
    } catch (err) {
      console.warn(`[Notification] Telegram to ${chatId} error:`, err.message);
    }
  }
  return anySuccess;
}

async function sendWhatsApp(message) {
  if (!client || !FROM_WHATSAPP) return false;
  let anySuccess = false;
  for (const num of TO_NUMBERS) {
    try {
      const target = num.startsWith('whatsapp:') ? num : `whatsapp:${num}`;
      await client.messages.create({
        body: message,
        from: FROM_WHATSAPP,
        to: target,
      });
      console.log(`[Notification] WhatsApp sent to ${target}`);
      anySuccess = true;
    } catch (err) {
      console.warn(`[Notification] WhatsApp to ${num} failed:`, err.message);
    }
  }
  return anySuccess;
}

async function sendSMS(message) {
  if (!client || !FROM_SMS) return false;
  let anySuccess = false;
  for (const num of TO_NUMBERS) {
    try {
      await client.messages.create({
        body: message,
        from: FROM_SMS,
        to: num,
      });
      console.log(`[Notification] SMS sent to ${num}`);
      anySuccess = true;
    } catch (err) {
      console.warn(`[Notification] SMS to ${num} failed:`, err.message);
    }
  }
  return anySuccess;
}

async function notifyOrder(orderData) {
  if (!orderData || !orderData.orderId) {
    console.warn('[Notification] Invalid orderData:', orderData);
    return;
  }

  const orderIdKey = String(orderData.orderId);
  if (notifiedOrders.has(orderIdKey)) {
    console.log(`[Notification] Order #${orderIdKey} already notified. Skipping.`);
    return;
  }
  notifiedOrders.add(orderIdKey);

  const message = formatNotificationMessage(orderData);
  console.log(`\n--- [ORDER NOTIFICATION - ORD-${orderIdKey}] ---`);
  console.log(message);
  console.log('-----------------------------------------------\n');

  // Priority 1: Telegram (free) — sendPhoto with image + full caption
  const tgSuccess = await sendTelegram(orderData);
  console.log(`[Notification] Telegram result for ORD-${orderIdKey}: ${tgSuccess ? 'SENT' : 'FAILED (no channel configured or all failed)'}`);
  if (tgSuccess) return;

  // Priority 2: WhatsApp (paid)
  console.log('[Notification] Falling back to WhatsApp...');
  const waSuccess = await sendWhatsApp(message);
  console.log(`[Notification] WhatsApp result: ${waSuccess ? 'SENT' : 'FAILED'}`);
  if (waSuccess) return;

  // Priority 3: SMS (paid)
  console.log('[Notification] Falling back to SMS...');
  await sendSMS(message);
  console.log('[Notification] SMS attempted');
}

module.exports = { notifyOrder, formatNotificationMessage };