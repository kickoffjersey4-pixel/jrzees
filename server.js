require('dotenv').config({ path: __dirname + '/.env' });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const xss = require('xss');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const db = require('./database');

// Ziina payment configuration
const ZIINA_API_TOKEN = process.env.ZIINA_API_TOKEN || '';
const ZIINA_WEBHOOK_SECRET = process.env.ZIINA_WEBHOOK_SECRET || '';
const ZIINA_API_URL = process.env.ZIINA_API_URL || 'https://api-v2.ziina.com/api';
const ZIINA_WEBHOOK_URL = process.env.ZIINA_WEBHOOK_URL || '';
const ziinaConfigured = !!(ZIINA_API_TOKEN && ZIINA_API_TOKEN.length >= 20 && !ZIINA_API_TOKEN.includes('XXXX'));

// Currencies Ziina can process. Amounts are passed in the base (minor) units.
const ZIINA_SUPPORTED = ['AED', 'USD', 'EUR', 'GBP', 'INR', 'SAR', 'QAR', 'KWD', 'OMR', 'BHD'];
const ZIINA_3DECIMAL = new Set(['BHD', 'KWD', 'OMR']);

function ziinaBaseUnits(amountEur, currency) {
  const rate = (exchangeRatesCache.rates && exchangeRatesCache.rates[currency]) || 1;
  const value = amountEur * rate;
  if (ZIINA_3DECIMAL.has(currency)) {
    // Three-decimal currencies must be rounded to the nearest ten (fils)
    return Math.round(Math.round(value * 1000 / 10) * 10);
  }
  return Math.round(value * 100);
}

// Generic authenticated HTTPS call to the Ziina API
function ziinaRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(ZIINA_API_URL + endpoint);
    const payload = body ? JSON.stringify(body) : null;
    const req = https.request(url, {
      method,
      headers: {
        'Authorization': `Bearer ${ZIINA_API_TOKEN}`,
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch (e) { /* non-JSON body */ }
        if (res.statusCode >= 400) {
          return reject(new Error(`Ziina API error ${res.statusCode}: ${data || (json && json.error) || 'unknown'}`));
        }
        resolve(json || data);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const { notifyOrder } = require('./notifications');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-in-production';

// Warn if JWT secret is weak/default
if (!JWT_SECRET || JWT_SECRET === 'dev-secret-change-in-production' || JWT_SECRET.length < 32) {
  console.error('SECURITY RISK: JWT_SECRET is weak, too short, or default. Generate a 64+ char random string.');
}

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// Validate critical env vars
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.includes('change-this')) {
  console.error('SECURITY RISK: JWT_SECRET must be set to a strong random value in production.');
}
if (process.env.ADMIN_PASSWORD && (process.env.ADMIN_PASSWORD.length < 8 || process.env.ADMIN_PASSWORD === 'admin123')) {
  console.error('SECURITY RISK: ADMIN_PASSWORD is weak. Use a strong password (12+ chars).');
}

// ─── SECURITY & BODY PARSING MIDDLEWARE ─────────────────────────────────────

app.use(cors({
  origin: process.env.BASE_URL || '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Session-Id'],
  credentials: true,
}));

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: false,
}));

// Gzip/Brotli compression — cuts bandwidth ~70% for JSON/CSS/JS
app.use(compression({ level: 6, threshold: 512 }));

// Ziina webhook must receive raw body (before any JSON parsing)
app.post('/api/ziina-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!ziinaConfigured) return res.status(503).json({ error: 'Payment not configured' });

  if (ZIINA_WEBHOOK_SECRET) {
    const sig = req.headers['x-hmac-signature'];
    if (!sig) {
      console.error('Ziina webhook signature verification failed: signature header missing.');
      return res.status(401).json({ error: 'Invalid signature' });
    }
    const expected = crypto.createHmac('sha256', ZIINA_WEBHOOK_SECRET).update(req.body).digest('hex');
    const sigBuffer = Buffer.from(sig, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
      console.error('Ziina webhook signature verification failed.');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8') || '{}');
  } catch (err) {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  if (event.event === 'payment_intent.status.updated') {
    const intent = event.data || {};
    if (!intent.id) return res.json({ received: true });

    const order = await db.get(
      'SELECT id FROM orders WHERE stripe_session_id = $1',
      [intent.id]
    );
    if (!order) {
      console.log(`Ziina webhook: no order for payment intent ${intent.id}`);
      return res.json({ received: true });
    }
    const orderId = order.id;

    if (intent.status === 'completed') {
      const updateRes = await db.query(
        `UPDATE orders SET payment_status = 'paid', status = 'confirmed', payment_method = 'ziina', paid_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND payment_status != 'paid'`,
        [orderId]
      );
      if (updateRes.rowCount > 0) {
        console.log(`Order #${orderId} marked as paid via Ziina webhook.`);

        // Decrement variant stock here
        try {
          const items = await db.all(
            'SELECT variant_id, quantity FROM order_items WHERE order_id = $1',
            [orderId]
          );
          for (const item of items) {
            await db.query('UPDATE variants SET stock = stock - $1 WHERE id = $2', [item.quantity, item.variant_id]);
          }
          console.log(`Stock decremented for Order #${orderId} via Ziina webhook.`);
        } catch (stockErr) {
          console.error('Error decrementing stock on Ziina webhook:', stockErr.message);
        }

        try {
          const fullOrder = await db.get(
            `SELECT o.*, c.name as customer_name
             FROM orders o LEFT JOIN customers c ON o.customer_id = c.id
             WHERE o.id = $1`,
            [orderId]
          );
          if (fullOrder) {
            const addr = await db.get(
              `SELECT street, country FROM addresses WHERE id = $1`,
              [fullOrder.shipping_address_id]
            );
            const items = await db.all(
              `SELECT oi.*, j.name as jersey_name, j.season, j.type as category,
                      (SELECT image_url FROM jersey_images WHERE jersey_id = j.id ORDER BY sort_order LIMIT 1) as image_url
               FROM order_items oi JOIN jerseys j ON oi.jersey_id = j.id
               WHERE oi.order_id = $1`,
              [orderId]
            );
            notifyOrder({
              orderId: fullOrder.id,
              customerName: fullOrder.customer_name,
              phone: fullOrder.phone || 'N/A',
              email: fullOrder.email || 'N/A',
              address: addr?.street || 'N/A',
              country: addr?.country || 'N/A',
              total: fullOrder.total,
              currencySymbol: '€',
              paymentStatus: 'Paid',
              paymentMethod: 'Ziina',
              createdTime: new Date().toISOString(),
              items
            }).catch(err => console.error('Ziina webhook notifyOrder error:', err.message));
          }
        } catch (notifErr) {
          console.error('Order notification error:', notifErr.message);
        }
      }
    } else if (['failed', 'canceled'].includes(intent.status)) {
      await db.query(
        `UPDATE orders SET payment_status = 'failed', updated_at = NOW()
         WHERE id = $1 AND payment_status NOT IN ('paid', 'refunded')`,
        [orderId]
      );
      console.log(`Order #${orderId} payment ${intent.status} via Ziina.`);
    }
  }

  res.json({ received: true });
});

app.use(express.json({ limit: '10kb' }));

// Input sanitization
function sanitizeValue(val) {
  if (typeof val === 'string') return xss(val.trim());
  if (Array.isArray(val)) return val.map(sanitizeValue);
  if (val && typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) out[k] = sanitizeValue(v);
    return out;
  }
  return val;
}
app.use((req, res, next) => {
  if (req.body) req.body = sanitizeValue(req.body);
  if (req.query) {
    for (const [k, v] of Object.entries(req.query)) {
      if (typeof v === 'string') req.query[k] = xss(v.trim());
    }
  }
  next();
});

// Rate limiters
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  message: { error: 'Too many requests. Slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);

// Health check / keep-alive ping (prevents Render free tier sleep)
app.get('/ping', (req, res) => res.status(200).send('ok'));

// Block sensitive files from being served
app.use((req, res, next) => {
  const blocked = ['.env', 'server.js', 'database.js', 'package.json', 'package-lock.json', '.gitignore', 'notifications.js', 'render.yaml'];
  if (blocked.some(f => req.path.endsWith('/' + f) || req.path === '/' + f)) {
    return res.status(404).send('Not found');
  }
  next();
});

app.use(express.static(__dirname, {
  etag: true,
  lastModified: true,
  maxAge: '1y',
  setHeaders: (res, filePath) => {
    // HTML and service worker never cached long (so new deploys + sw updates show immediately)
    if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else {
      // css/js/images/fonts — immutable for 1 year (use ?v= query bust on deploy)
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// Prevent caching of API responses (sensitive data)
app.use('/api/', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});

// Simple session middleware
app.use((req, res, next) => {
  let sessionId = req.headers['x-session-id'];
  if (!sessionId) {
    sessionId = crypto.randomUUID();
  }
  req.sessionId = sessionId;
  res.setHeader('X-Session-Id', sessionId);
  next();
});

// Auth middleware: verifies JWT from Authorization header
function authRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    req.user = jwt.verify(header.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Admin middleware: verifies JWT and is_admin flag
function adminRequired(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  try {
    const decoded = jwt.verify(header.slice(7), JWT_SECRET);
    if (!decoded.is_admin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth: attaches user if token present, continues regardless
function authOptional(req, res, next) {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    try {
      req.user = jwt.verify(header.slice(7), JWT_SECRET);
    } catch { /* token invalid, continue without user */ }
  }
  next();
}

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }
    if (password.length > 128) {
      return res.status(400).json({ error: 'Password is too long (max 128 characters)' });
    }

    const existing = await db.get('SELECT id FROM customers WHERE email = $1', [email]);
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const hash = await bcrypt.hash(password, 10);
    const c = await db.query(
      'INSERT INTO customers (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, is_admin, created_at',
      [name, email, hash]
    );
    const user = c.rows[0];
    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '24h' });

    res.json({ success: true, user, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const user = await db.get('SELECT * FROM customers WHERE email = $1', [email]);
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.password_hash) {
      return res.status(401).json({ error: 'This account uses a legacy login method. Please register again.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign({ id: user.id, name: user.name, email: user.email, is_admin: user.is_admin }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, user: { id: user.id, name: user.name, email: user.email, is_admin: user.is_admin, created_at: user.created_at }, token });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login error' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true });
});

app.get('/api/auth/me', authOptional, async (req, res) => {
  try {
    if (!req.user) {
      return res.json({ user: null, orders: [] });
    }

    const user = await db.get('SELECT id, name, email, is_admin, created_at FROM customers WHERE id = $1', [req.user.id]);
    if (!user) {
      return res.json({ user: null, orders: [] });
    }

    const orders = await db.all(
      `SELECT o.*, 
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
       FROM orders o 
       WHERE o.customer_id = $1 
       ORDER BY o.created_at DESC`,
      [user.id]
    );

    res.json({ user, orders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Auth query error' });
  }
});

// ─── EXCHANGE RATES ──────────────────────────────────────────────────────────

const DEFAULT_RATES = {
  EUR: 1.0,
  USD: 1.08,
  GBP: 0.85,
  CAD: 1.48,
  AUD: 1.65,
  JPY: 165.0,
  INR: 90.0,
  AED: 3.97,
  SAR: 4.05,
  CHF: 0.96,
  BRL: 6.0,
  MXN: 20.0
};

const CURRENCY_SYMBOLS = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  CAD: 'CA$',
  AUD: 'A$',
  JPY: '¥',
  INR: '₹',
  AED: 'AED ',
  SAR: 'SAR ',
  CHF: 'CHF ',
  BRL: 'R$',
  MXN: 'MEX$'
};

let exchangeRatesCache = {
  base: 'EUR',
  rates: { ...DEFAULT_RATES },
  timestamp: 0
};

function fetchLiveExchangeRates() {
  return new Promise((resolve) => {
    https.get('https://open.er-api.com/v6/latest/EUR', (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json && json.rates) {
            json.rates.EUR = 1.0;
            exchangeRatesCache = {
              base: 'EUR',
              rates: { ...DEFAULT_RATES, ...json.rates },
              timestamp: Date.now()
            };
            console.log('[ExchangeRates] Live rates updated from Open Exchange Rates API');
            return resolve(exchangeRatesCache);
          }
        } catch (e) {}
        resolve(exchangeRatesCache);
      });
    }).on('error', () => {
      resolve(exchangeRatesCache);
    });
  });
}

app.get('/api/exchange-rates', async (req, res) => {
  const ONE_HOUR = 3600000;
  if (Date.now() - exchangeRatesCache.timestamp > ONE_HOUR) {
    await fetchLiveExchangeRates();
  }
  res.json({
    base: 'EUR',
    rates: exchangeRatesCache.rates,
    symbols: CURRENCY_SYMBOLS,
    updated_at: new Date(exchangeRatesCache.timestamp || Date.now()).toISOString()
  });
});

// ─── ZIINA PAYMENT ──────────────────────────────────────────────────────────

// Return payment configuration to frontend
app.get('/api/ziina-config', (req, res) => {
  res.json({ configured: ziinaConfigured });
});

// Create a Ziina Payment Intent for a new order
app.post('/api/create-payment-intent', async (req, res) => {
  if (!ziinaConfigured) return res.status(503).json({ error: 'Ziina not configured. Use the legacy checkout endpoint /api/checkout instead.' });
  try {
    const { customer_name, email, phone, address, country, notes, items, currency, checkout_id } = req.body;
    if (!customer_name || !email || !address || !items || !items.length || !checkout_id) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Ziina charges in the customer's selected currency when supported, else EUR
    const currencyCode = (currency || 'EUR').toUpperCase();
    const chargeCurrency = ZIINA_SUPPORTED.includes(currencyCode) ? currencyCode : 'EUR';

    // Resolve variants and compute totals (base currency: EUR)
    let subtotal = 0;
    let namePrintingCount = 0;

    for (const item of items) {
      const variant = await db.get(
        'SELECT * FROM variants WHERE jersey_id = $1 AND version = $2 AND size = $3 AND active = 1',
        [item.jersey_id, item.version, item.size]
      );
      if (!variant) return res.status(400).json({ error: `Variant not found for jersey ${item.jersey_id}` });
      if (variant.stock < item.quantity) return res.status(400).json({ error: `Insufficient stock for ${item.version} - ${item.size}` });

      item.variant_id = variant.id;
      item.price = variant.price;
      subtotal += variant.price * item.quantity;
      if (item.name_text && item.name_text.trim()) namePrintingCount++;
    }

    const deliveryFee = 5;
    const namePrintFee = namePrintingCount * 5;
    const total = subtotal + deliveryFee + namePrintFee;
    const amount = ziinaBaseUnits(total, chargeCurrency);

    // Create or find customer & address
    let customer = await db.get('SELECT id FROM customers WHERE email = $1', [email]);
    if (!customer) {
      const c = await db.query(
        'INSERT INTO customers (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
        [customer_name, email, phone || null]
      );
      customer = c.rows[0];
    }

    const countryName = country || 'United Kingdom';
    const addr = await db.query(
      `INSERT INTO addresses (customer_id, label, street, city, country, is_default)
       VALUES ($1, 'Shipping', $2, '', $3, 1) RETURNING id`,
      [customer.id, address, countryName]
    );

    let orderId;
    let existingOrder = await db.get(
      'SELECT id, stripe_session_id, total FROM orders WHERE checkout_id = $1',
      [checkout_id]
    );

    if (existingOrder) {
      orderId = existingOrder.id;
      // If payment intent was already created and is valid, return it to prevent double intents
      if (existingOrder.stripe_session_id && existingOrder.stripe_session_id !== checkout_id) {
        try {
          const intent = await ziinaRequest('GET', `/payment_intent/${encodeURIComponent(existingOrder.stripe_session_id)}`);
          if (intent && intent.redirect_url) {
            return res.json({ url: intent.redirect_url, intent_id: intent.id, order_id: orderId });
          }
        } catch (err) {
          console.error('Failed to retrieve existing Ziina intent:', err.message);
        }
      }
    } else {
      // Create order (status: pending, unpaid)
      const orderRes = await db.query(
        `INSERT INTO orders (customer_id, email, phone, shipping_address_id, notes, subtotal, delivery_fee, name_printing_fee, total, status, payment_status, payment_method, checkout_id, stripe_session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending', 'unpaid', 'ziina', $10, $10) RETURNING id`,
        [customer.id, email, phone || null, addr.rows[0].id, notes || null, subtotal, deliveryFee, namePrintFee, total, checkout_id]
      );
      orderId = orderRes.rows[0].id;

      // Insert order items (but DO NOT decrement stock yet!)
      for (const item of items) {
        await db.query(
          `INSERT INTO order_items (order_id, jersey_id, variant_id, size, version, name_text, quantity, unit_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [orderId, item.jersey_id, item.variant_id, item.size, item.version, item.name_text || null, item.quantity, item.price]
        );
      }
    }

    // Create Ziina Payment Intent (hosted page redirect)
    const intent = await ziinaRequest('POST', '/payment_intent', {
      amount,
      currency_code: chargeCurrency,
      message: `Kickoff Jerseys - Order #${orderId}`,
      success_url: `${BASE_URL}/?checkout=success&order_id=${orderId}`,
      cancel_url: `${BASE_URL}/?checkout=cancel&order_id=${orderId}`,
      failure_url: `${BASE_URL}/?checkout=failed&order_id=${orderId}`,
      operation_id: checkout_id,
      ...(process.env.NODE_ENV !== 'production' ? { test: true } : {}),
    });

    // Store Ziina payment intent ID on the order
    await db.query('UPDATE orders SET stripe_session_id = $1 WHERE id = $2', [intent.id, orderId]);

    res.json({ url: intent.redirect_url, intent_id: intent.id, order_id: orderId });
  } catch (err) {
    console.error('Ziina payment intent error:', err.message);
    res.status(500).json({ error: 'Failed to create payment. Please try again or contact support.' });
  }
});

// ─── TEAMS ───────────────────────────────────────────────────────────────────

app.get('/api/teams', async (req, res) => {
  try {
    const teams = await db.all(
      `SELECT t.*, (SELECT COUNT(*) FROM jerseys WHERE team_id = t.id) as jersey_count
       FROM teams t ORDER BY t.name`
    );
    res.json(teams);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/teams/:slug', async (req, res) => {
  try {
    const param = req.params.slug;
    const isNumericId = /^\d+$/.test(param);
    const team = await db.get(
      isNumericId
        ? `SELECT t.*, (SELECT COUNT(*) FROM jerseys WHERE team_id = t.id) as jersey_count FROM teams t WHERE t.id = $1`
        : `SELECT t.*, (SELECT COUNT(*) FROM jerseys WHERE team_id = t.id) as jersey_count FROM teams t WHERE t.slug = $1`,
      [param]
    );
    if (!team) return res.status(404).json({ error: 'Team not found' });
    res.json(team);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── JERSEYS ─────────────────────────────────────────────────────────────────

app.get('/api/jerseys', async (req, res) => {
  try {
    const { team_id, featured, type, category, search } = req.query;
    let sql = `
      SELECT j.*, t.name as team_name, t.slug as team_slug,
        (SELECT MIN(price) FROM variants WHERE jersey_id = j.id AND active = 1) as price_from,
        (SELECT MAX(price) FROM variants WHERE jersey_id = j.id AND active = 1) as price_to,
        (SELECT image_url FROM jersey_images WHERE jersey_id = j.id ORDER BY sort_order LIMIT 1) as image_url
      FROM jerseys j JOIN teams t ON j.team_id = t.id
    `;
    const params = [];
    const conditions = [];

    if (team_id) {
      conditions.push(`j.team_id = $${params.length + 1}`);
      params.push(team_id);
    }
    if (featured) {
      conditions.push('j.featured = 1');
    }

    const catFilter = (category || type || '').toLowerCase();
    if (catFilter && catFilter !== 'all') {
      if (catFilter === 'retro') {
        conditions.push(`(
          j.type = 'retro' OR 
          j.name ILIKE '%retro%' OR 
          j.description ILIKE '%retro%' OR 
          (j.season IS NOT NULL AND j.season != '' AND 
           j.season NOT ILIKE '%2024%' AND j.season NOT ILIKE '%2025%' AND j.season NOT ILIKE '%2026%' AND 
           j.season NOT ILIKE '%24/%' AND j.season NOT ILIKE '%25/%' AND j.season NOT ILIKE '%26/%')
        )`);
      } else if (catFilter === 'new' || catFilter === 'new drops' || catFilter === 'new-drops') {
        conditions.push(`(
          j.type = 'new' OR
          j.name ILIKE '%new%' OR
          j.season ILIKE '%2024%' OR
          j.season ILIKE '%2025%' OR
          j.season ILIKE '%2026%' OR
          j.season ILIKE '%24/%' OR
          j.season ILIKE '%25/%' OR
          j.season ILIKE '%26/%'
        )`);
      } else if (catFilter === 'training') {
        conditions.push(`(j.type = 'training' OR j.name ILIKE '%training%' OR j.description ILIKE '%training%')`);
      } else if (catFilter === 'tracksuit') {
        conditions.push(`(j.type = 'tracksuit' OR j.name ILIKE '%tracksuit%' OR j.description ILIKE '%tracksuit%')`);
      } else {
        conditions.push(`j.type = $${params.length + 1}`);
        params.push(catFilter);
      }
    }

    if (search) {
      const term = `%${search.trim()}%`;
      const pIdx = params.length + 1;
      conditions.push(`(
        j.name ILIKE $${pIdx} OR
        t.name ILIKE $${pIdx} OR
        t.country ILIKE $${pIdx} OR
        j.description ILIKE $${pIdx} OR
        j.season ILIKE $${pIdx} OR
        j.type ILIKE $${pIdx}
      )`);
      params.push(term);
    }

    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY j.featured DESC, t.name, j.name';

    const jerseys = await db.all(sql, params);

    const result = jerseys.map(j => ({
      ...j,
      version_fan: 20,
      version_player: 25,
      version_retro: 25,
    }));

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/jerseys/:id', async (req, res) => {
  try {
    const jersey = await db.get(
      `SELECT j.*, t.name as team_name, t.slug as team_slug,
        (SELECT MIN(price) FROM variants WHERE jersey_id = j.id AND active = 1) as price_from,
        (SELECT MAX(price) FROM variants WHERE jersey_id = j.id AND active = 1) as price_to
       FROM jerseys j JOIN teams t ON j.team_id = t.id
       WHERE j.id = $1`,
      [req.params.id]
    );
    if (!jersey) return res.status(404).json({ error: 'Jersey not found' });

    const images = await db.all(
      'SELECT * FROM jersey_images WHERE jersey_id = $1 ORDER BY sort_order',
      [jersey.id]
    );

    const variants = await db.all(
      'SELECT * FROM variants WHERE jersey_id = $1 AND active = 1 ORDER BY version, size',
      [jersey.id]
    );

    const versionPrices = {};
    const sizeMap = {};
    const sizeSet = new Set();
    for (const v of variants) {
      versionPrices[v.version] = v.price;
      sizeSet.add(v.size);
      if (!sizeMap[v.version]) sizeMap[v.version] = [];
      sizeMap[v.version].push(v.size);
    }

    res.json({
      ...jersey,
      version_fan: versionPrices.fan || 20,
      version_player: versionPrices.player || 25,
      version_retro: versionPrices.retro || 25,
      image_url: images.length ? images[0].image_url : null,
      images,
      variants,
      sizes: [...sizeSet].sort(),
      size_map: sizeMap,
      stock: variants.reduce((acc, v) => { acc[v.id] = v.stock; return acc; }, {})
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── VARIANTS ────────────────────────────────────────────────────────────────

app.get('/api/variants', async (req, res) => {
  try {
    const { jersey_id, version, size } = req.query;
    let sql = 'SELECT v.*, j.name as jersey_name FROM variants v JOIN jerseys j ON v.jersey_id = j.id WHERE v.active = 1';
    const params = [];

    if (jersey_id) { params.push(jersey_id); sql += ` AND v.jersey_id = $${params.length}`; }
    if (version) { params.push(version); sql += ` AND v.version = $${params.length}`; }
    if (size) { params.push(size); sql += ` AND v.size = $${params.length}`; }

    sql += ' ORDER BY v.jersey_id, v.version, v.size';
    const variants = await db.all(sql, params);
    res.json(variants);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CART ────────────────────────────────────────────────────────────────────

app.get('/api/cart', async (req, res) => {
  try {
    const items = await db.all(
      `SELECT ci.*, v.version, v.size, v.price, v.stock,
        j.name as jersey_name, j.team_id, t.name as team_name, t.slug as team_slug,
        (SELECT image_url FROM jersey_images WHERE jersey_id = j.id ORDER BY sort_order LIMIT 1) as image_url
       FROM cart_items ci
       JOIN variants v ON ci.variant_id = v.id
       JOIN jerseys j ON v.jersey_id = j.id
       JOIN teams t ON j.team_id = t.id
       WHERE ci.session_id = $1
       ORDER BY ci.created_at`,
      [req.sessionId]
    );
    res.json(items);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/cart', async (req, res) => {
  try {
    const { variant_id, name_text, quantity } = req.body;
    if (!variant_id) return res.status(400).json({ error: 'variant_id required' });

    const variant = await db.get('SELECT * FROM variants WHERE id = $1 AND active = 1', [variant_id]);
    if (!variant) return res.status(404).json({ error: 'Variant not found' });
    if (variant.stock < (quantity || 1)) return res.status(400).json({ error: 'Insufficient stock' });

    const existing = await db.get(
      'SELECT * FROM cart_items WHERE session_id = $1 AND variant_id = $2 AND COALESCE(name_text, \'\') = COALESCE($3, \'\')',
      [req.sessionId, variant_id, name_text || '']
    );

    if (existing) {
      await db.query('UPDATE cart_items SET quantity = quantity + $1 WHERE id = $2',
        [quantity || 1, existing.id]);
    } else {
      await db.query(
        'INSERT INTO cart_items (session_id, variant_id, name_text, quantity) VALUES ($1, $2, $3, $4)',
        [req.sessionId, variant_id, name_text || null, quantity || 1]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/cart/:id', async (req, res) => {
  try {
    const { quantity } = req.body;
    if (quantity < 1) {
      await db.query('DELETE FROM cart_items WHERE id = $1 AND session_id = $2',
        [req.params.id, req.sessionId]);
    } else {
      await db.query('UPDATE cart_items SET quantity = $1 WHERE id = $2 AND session_id = $3',
        [quantity, req.params.id, req.sessionId]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/cart/:id', async (req, res) => {
  try {
    await db.query('DELETE FROM cart_items WHERE id = $1 AND session_id = $2',
      [req.params.id, req.sessionId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/cart/clear', async (req, res) => {
  try {
    await db.query('DELETE FROM cart_items WHERE session_id = $1', [req.sessionId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── CHECKOUT (convert cart → order) ─────────────────────────────────────────

app.post('/api/checkout', async (req, res) => {
  try {
    const { customer_name, email, phone, address, country, notes, currency_symbol, checkout_id, payment_method } = req.body;
    if (!customer_name || !email || !address) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // COD Idempotency Check
    if (checkout_id) {
      const existingOrder = await db.get(
        `SELECT id, total FROM orders WHERE checkout_id = $1`,
        [checkout_id]
      );
      if (existingOrder) {
        return res.json({ order_id: existingOrder.id, total: existingOrder.total, delivery_fee: 5, name_printing_fee: 0, already_placed: true });
      }
    }

    let cartItems = await db.all(
      `SELECT ci.*, v.version, v.size, v.price, v.stock, v.jersey_id
       FROM cart_items ci JOIN variants v ON ci.variant_id = v.id
       WHERE ci.session_id = $1`,
      [req.sessionId]
    );

    // Fallback: if DB cart is empty, use items from request body
    if (!cartItems.length && req.body.items && req.body.items.length) {
      cartItems = [];
      for (const item of req.body.items) {
        const variant = await db.get(
          'SELECT v.*, v.jersey_id FROM variants v WHERE v.jersey_id = $1 AND v.version = $2 AND v.size = $3 AND v.active = 1',
          [item.jersey_id, item.version, item.size]
        );
        if (!variant) continue;
        cartItems.push({
          variant_id: variant.id,
          jersey_id: variant.jersey_id,
          version: variant.version,
          size: variant.size,
          price: variant.price,
          stock: variant.stock,
          quantity: item.quantity || 1,
          name_text: item.name_text || null,
        });
      }
    }

    if (!cartItems.length) return res.status(400).json({ error: 'Cart is empty' });

    // Validate stock
    for (const item of cartItems) {
      if (item.stock < item.quantity) {
        return res.status(400).json({
          error: `Insufficient stock for ${item.version} - size ${item.size}`
        });
      }
    }

    // Create or find customer
    let customer = await db.get('SELECT id FROM customers WHERE email = $1', [email]);
    if (!customer) {
      const c = await db.query(
        'INSERT INTO customers (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
        [customer_name, email, phone || null]
      );
      customer = c.rows[0];
    }

    // Create address
    const countryName = country || 'United Kingdom';
    const addr = await db.query(
      `INSERT INTO addresses (customer_id, label, street, city, country, is_default)
       VALUES ($1, 'Shipping', $2, '', $3, 1) RETURNING id`,
      [customer.id, address, countryName]
    );
    const addressId = addr.rows[0].id;

    // Calculate
    let subtotal = 0;
    let namePrintingCount = 0;
    for (const item of cartItems) {
      subtotal += item.price * item.quantity;
      if (item.name_text && item.name_text.trim()) namePrintingCount++;
    }
    const deliveryFee = 5;
    const namePrintFee = namePrintingCount * 5;
    const total = subtotal + deliveryFee + namePrintFee;

    const pMethod = payment_method || 'COD';
    const status = pMethod === 'COD' ? 'pending' : 'confirmed';
    const paymentStatus = pMethod === 'COD' ? 'unpaid' : 'paid';

    // Create order
    const orderRes = await db.query(
      `INSERT INTO orders (customer_id, email, phone, shipping_address_id, notes, subtotal, delivery_fee, name_printing_fee, total, status, payment_status, payment_method, checkout_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [customer.id, email, phone || null, addressId, notes || null, subtotal, deliveryFee, namePrintFee, total, status, paymentStatus, pMethod, checkout_id || null]
    );
    const orderId = orderRes.rows[0].id;

    // Create order items and decrement stock (COD confirms immediately)
    for (const item of cartItems) {
      await db.query(
        `INSERT INTO order_items (order_id, jersey_id, variant_id, size, version, name_text, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, item.jersey_id, item.variant_id, item.size, item.version, item.name_text || null, item.quantity, item.price]
      );
      await db.query('UPDATE variants SET stock = stock - $1 WHERE id = $2', [item.quantity, item.variant_id]);
    }

    // Clear cart
    await db.query('DELETE FROM cart_items WHERE session_id = $1', [req.sessionId]);

    res.json({ order_id: orderId, total, delivery_fee: deliveryFee, name_printing_fee: namePrintFee });

    // Send complete structured notification
    try {
      const notifItems = await db.all(
        `SELECT oi.*, j.name as jersey_name, j.season, j.type as category, t.name as club,
                (SELECT image_url FROM jersey_images WHERE jersey_id = j.id ORDER BY sort_order LIMIT 1) as image_url
         FROM order_items oi
         JOIN jerseys j ON oi.jersey_id = j.id
         JOIN teams t ON j.team_id = t.id
         WHERE oi.order_id = $1`,
        [orderId]
      );
      notifyOrder({
        orderId,
        customerName: customer_name,
        phone: phone || 'N/A',
        email,
        address,
        country: countryName,
        total,
        currencySymbol: currency_symbol || '€',
        paymentStatus: pMethod === 'COD' ? 'Unpaid' : 'Paid',
        paymentMethod: pMethod,
        createdTime: new Date().toISOString(),
        items: notifItems
      }).catch(err => console.error('notifyOrder error:', err.message));
    } catch (notifErr) {
      console.error('Checkout notification error:', notifErr.message);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── LEGACY ORDERS (frontend compatibility) ──────────────────────────────────

app.post('/api/orders', async (req, res) => {
  try {
    const { customer_name, email, phone, address, country, notes, items, currency_symbol, checkout_id, payment_method } = req.body;
    if (!customer_name || !email || !address || !items || !items.length) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (checkout_id) {
      const existingOrder = await db.get(
        `SELECT id, total FROM orders WHERE checkout_id = $1`,
        [checkout_id]
      );
      if (existingOrder) {
        return res.json({ order_id: existingOrder.id, total: existingOrder.total, delivery_fee: 5, name_printing_fee: 0, already_placed: true });
      }
    }

    let subtotal = 0;
    let namePrintingCount = 0;

    for (const item of items) {
      const variant = await db.get(
        'SELECT * FROM variants WHERE jersey_id = $1 AND version = $2 AND size = $3 AND active = 1',
        [item.jersey_id, item.version, item.size]
      );
      if (!variant) return res.status(400).json({ error: `Variant not found for jersey ${item.jersey_id}` });
      if (variant.stock < item.quantity) return res.status(400).json({ error: `Insufficient stock for ${item.version} - ${item.size}` });

      item.variant_id = variant.id;
      item.price = variant.price;
      subtotal += variant.price * item.quantity;
      if (item.name_text && item.name_text.trim()) namePrintingCount++;
    }

    const deliveryFee = 5;
    const namePrintFee = namePrintingCount * 5;
    const total = subtotal + deliveryFee + namePrintFee;

    let customer = await db.get('SELECT id FROM customers WHERE email = $1', [email]);
    if (!customer) {
      const c = await db.query(
        'INSERT INTO customers (name, email, phone) VALUES ($1, $2, $3) RETURNING id',
        [customer_name, email, phone || null]
      );
      customer = c.rows[0];
    }

    const countryName = country || 'United Kingdom';
    const addr = await db.query(
      `INSERT INTO addresses (customer_id, label, street, city, country, is_default)
       VALUES ($1, 'Shipping', $2, '', $3, 1) RETURNING id`,
      [customer.id, address, countryName]
    );

    const pMethod = payment_method || 'COD';
    const status = pMethod === 'COD' ? 'pending' : 'confirmed';
    const paymentStatus = pMethod === 'COD' ? 'unpaid' : 'paid';

    const orderRes = await db.query(
      `INSERT INTO orders (customer_id, email, phone, shipping_address_id, notes, subtotal, delivery_fee, name_printing_fee, total, status, payment_status, payment_method, checkout_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
      [customer.id, email, phone || null, addr.rows[0].id, notes || null, subtotal, deliveryFee, namePrintFee, total, status, paymentStatus, pMethod, checkout_id || null]
    );
    const orderId = orderRes.rows[0].id;

    for (const item of items) {
      await db.query(
        `INSERT INTO order_items (order_id, jersey_id, variant_id, size, version, name_text, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, item.jersey_id, item.variant_id, item.size, item.version, item.name_text || null, item.quantity, item.price]
      );
      await db.query('UPDATE variants SET stock = stock - $1 WHERE id = $2', [item.quantity, item.variant_id]);
    }

    res.json({ order_id: orderId, total, delivery_fee: deliveryFee, name_printing_fee: namePrintFee });

    // Send complete notification
    try {
      const notifItems = await db.all(
        `SELECT oi.*, j.name as jersey_name, j.season, t.name as club
         FROM order_items oi
         JOIN jerseys j ON oi.jersey_id = j.id
         JOIN teams t ON j.team_id = t.id
         WHERE oi.order_id = $1`,
        [orderId]
      );
      notifyOrder({
        orderId,
        customerName: customer_name,
        phone: phone || 'N/A',
        email,
        address,
        country: countryName,
        total,
        currencySymbol: currency_symbol || '€',
        paymentStatus: pMethod === 'COD' ? 'Unpaid' : 'Paid',
        paymentMethod: pMethod,
        createdTime: new Date().toISOString(),
        items: notifItems
      });
    } catch (notifErr) {
      console.error('Orders endpoint notification error:', notifErr.message);
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  try {
    // Support lookup by numeric order ID or by payment intent ID
    const isPaymentIntent = !/^\d+$/.test(req.params.id) && req.params.id.length > 8;
    const order = await db.get(
      `SELECT o.*, c.name as customer_name, c.email as customer_email,
              a.street as address, a.country as address_country
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       LEFT JOIN addresses a ON o.shipping_address_id = a.id
       WHERE ${isPaymentIntent ? 'o.stripe_session_id' : 'o.id'} = $1`,
      [req.params.id]
    );
    if (!order) return res.status(404).json({ error: 'Order not found' });

    // When looked up by payment intent, sync the latest status from Ziina
    if (isPaymentIntent && ziinaConfigured) {
      try {
        const intent = await ziinaRequest('GET', `/payment_intent/${encodeURIComponent(req.params.id)}`);
        if (intent && intent.status === 'completed' && order.payment_status !== 'paid') {
          const updateRes = await db.query(
            `UPDATE orders SET payment_status = 'paid', status = 'confirmed', payment_method = 'ziina', paid_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND payment_status != 'paid'`,
            [order.id]
          );
          if (updateRes.rowCount > 0) {
            const orderItems = await db.all(
              'SELECT variant_id, quantity FROM order_items WHERE order_id = $1',
              [order.id]
            );
            for (const item of orderItems) {
              await db.query('UPDATE variants SET stock = stock - $1 WHERE id = $2', [item.quantity, item.variant_id]);
            }
          }
          order.payment_status = 'paid';
          order.status = 'confirmed';
          order.payment_method = 'ziina';
        } else if (intent && ['failed', 'canceled'].includes(intent.status) && order.payment_status !== 'paid') {
          await db.query(
            `UPDATE orders SET payment_status = 'failed', updated_at = NOW() WHERE id = $1`,
            [order.id]
          );
          order.payment_status = 'failed';
        }
      } catch (intentErr) {
        console.error('Ziina intent lookup error:', intentErr.message);
      }
    }

    const items = await db.all(
      `SELECT oi.*, j.name as jersey_name, t.name as team_name, t.slug as team_slug
       FROM order_items oi
       JOIN jerseys j ON oi.jersey_id = j.id
       JOIN teams t ON j.team_id = t.id
       WHERE oi.order_id = $1`,
      [order.id]
    );

    res.json({ ...order, items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: ALL ORDERS ───────────────────────────────────────────────────────

app.get('/api/admin/orders', adminRequired, async (req, res) => {
  try {
    const orders = await db.all(
      `SELECT o.*, c.name as customer_name,
        (SELECT COUNT(*) FROM order_items WHERE order_id = o.id) as item_count
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       ORDER BY o.created_at DESC LIMIT 50`
    );
    res.json(orders);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.patch('/api/admin/orders/:id/status', async (req, res) => {
  try {
    const { status, payment_status } = req.body;
    if (status) {
      await db.query('UPDATE orders SET status = $1, updated_at = NOW() WHERE id = $2', [status, req.params.id]);
    }
    if (payment_status) {
      await db.query('UPDATE orders SET payment_status = $1, updated_at = NOW() WHERE id = $2', [payment_status, req.params.id]);
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: JERSEY MANAGEMENT ──────────────────────────────────────────────

app.get('/api/admin/jerseys', adminRequired, async (req, res) => {
  try {
    const jerseys = await db.all(
      `SELECT j.*, t.name as team_name, t.slug as team_slug,
        (SELECT image_url FROM jersey_images WHERE jersey_id = j.id ORDER BY sort_order LIMIT 1) as image_url
       FROM jerseys j
       JOIN teams t ON j.team_id = t.id
       ORDER BY j.created_at DESC`
    );
    res.json(jerseys);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/admin/jerseys', adminRequired, async (req, res) => {
  try {
    const { team_id, name, season, type, description, featured, image_urls } = req.body;
    if (!team_id || !name) {
      return res.status(400).json({ error: 'team_id and name are required' });
    }
    const result = await db.query(
      `INSERT INTO jerseys (team_id, name, season, type, description, featured)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [team_id, name, season || null, type || null, description || null, featured || 0]
    );
    const jersey = result.rows[0];

    // Add image URLs
    if (image_urls && image_urls.length) {
      for (let i = 0; i < image_urls.length; i++) {
        await db.query(
          'INSERT INTO jersey_images (jersey_id, image_url, sort_order) VALUES ($1, $2, $3)',
          [jersey.id, image_urls[i], i]
        );
      }
    }

    // Create default variants if none exist
    const existing = await db.get('SELECT id FROM variants WHERE jersey_id = $1 LIMIT 1', [jersey.id]);
    if (!existing) {
      const versions = ['fan', 'player', 'retro'];
      const sizes = ['S', 'M', 'L', 'XL', '2XL'];
      const prices = { fan: 20, player: 23, retro: 25 };
      for (const ver of versions) {
        for (const sz of sizes) {
          const sku = `${jersey.id}-${ver}-${sz}`;
          await db.query(
            'INSERT INTO variants (jersey_id, version, size, price, stock, sku) VALUES ($1, $2, $3, $4, 100, $5)',
            [jersey.id, ver, sz, prices[ver], sku]
          );
        }
      }
    }

    res.json({ success: true, jersey });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.delete('/api/admin/jerseys/:id', adminRequired, async (req, res) => {
  try {
    await db.query('DELETE FROM jersey_images WHERE jersey_id = $1', [req.params.id]);
    await db.query('DELETE FROM variants WHERE jersey_id = $1', [req.params.id]);
    await db.query('DELETE FROM jerseys WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: REORDER JERSEY IMAGES ───────────────────────────────────────────
app.get('/api/admin/jerseys/:id/images', adminRequired, async (req, res) => {
  try {
    const images = await db.all(
      'SELECT * FROM jersey_images WHERE jersey_id = $1 ORDER BY sort_order',
      [req.params.id]
    );
    res.json(images);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/admin/jerseys/:id/images/reorder', adminRequired, async (req, res) => {
  try {
    const { imageIds } = req.body;
    if (!Array.isArray(imageIds) || imageIds.length === 0) {
      return res.status(400).json({ error: 'imageIds array required' });
    }
    for (let i = 0; i < imageIds.length; i++) {
      await db.query(
        'UPDATE jersey_images SET sort_order = $1 WHERE id = $2 AND jersey_id = $3',
        [i, imageIds[i], req.params.id]
      );
    }
    const images = await db.all(
      'SELECT * FROM jersey_images WHERE jersey_id = $1 ORDER BY sort_order',
      [req.params.id]
    );
    res.json({ success: true, images });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/teams', adminRequired, async (req, res) => {
  try {
    const teams = await db.all('SELECT * FROM teams ORDER BY name ASC');
    res.json(teams);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── ADMIN: SALES & ANALYTICS ─────────────────────────────────────────────

app.get('/api/admin/sales', adminRequired, async (req, res) => {
  try {
    const period = req.query.period || 'month'; // day, week, month

    let interval;
    if (period === 'day') interval = '24 hours';
    else if (period === 'week') interval = '7 days';
    else interval = '30 days';

    const cutoffDate = new Date(Date.now() - (period === 'day' ? 24 : period === 'week' ? 7 : 30) * 3600000 * 24).toISOString();
    const dailySales = await db.all(
      `SELECT DATE(created_at) as date, COUNT(*) as order_count, COALESCE(SUM(total), 0) as revenue
       FROM orders
       WHERE payment_status = 'paid' AND created_at >= $1
       GROUP BY DATE(created_at)
       ORDER BY date ASC`,
      [cutoffDate]
    );

    const totalRevenue = await db.get(
      `SELECT COALESCE(SUM(total), 0) as total_revenue,
              COUNT(*) as total_orders,
              COALESCE(AVG(total), 0) as avg_order_value
       FROM orders WHERE payment_status = 'paid'`
    );

    const topSellers = await db.all(
      `SELECT j.id, j.name, t.name as team_name, COUNT(oi.id) as units_sold, COALESCE(SUM(oi.unit_price * oi.quantity), 0) as revenue
       FROM order_items oi
       JOIN jerseys j ON oi.jersey_id = j.id
       JOIN teams t ON j.team_id = t.id
       JOIN orders o ON oi.order_id = o.id
       WHERE o.payment_status = 'paid'
       GROUP BY j.id, t.name
       ORDER BY units_sold DESC
       LIMIT 10`
    );

    const statusBreakdown = await db.all(
      `SELECT status, COUNT(*) as count FROM orders GROUP BY status`
    );

    const recentOrders = await db.all(
      `SELECT o.id, o.total, o.status, o.payment_status, o.created_at, c.name as customer_name
       FROM orders o
       LEFT JOIN customers c ON o.customer_id = c.id
       ORDER BY o.created_at DESC LIMIT 10`
    );

    res.json({ dailySales, totalRevenue, topSellers, statusBreakdown, recentOrders });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/admin/sales/summary', adminRequired, async (req, res) => {
  try {
    const today = await db.get(
      `SELECT COUNT(*) as orders_today, COALESCE(SUM(total), 0) as revenue_today
       FROM orders WHERE payment_status = 'paid' AND DATE(created_at) = CURRENT_DATE`
    );

    const thisMonth = await db.get(
      `SELECT COUNT(*) as orders_month, COALESCE(SUM(total), 0) as revenue_month
       FROM orders WHERE payment_status = 'paid'
       AND DATE_TRUNC('month', created_at) = DATE_TRUNC('month', CURRENT_DATE)`
    );

    const total = await db.get(
      `SELECT COUNT(*) as total_orders, COALESCE(SUM(total), 0) as total_revenue
       FROM orders WHERE payment_status = 'paid'`
    );

    const pendingOrders = await db.get(
      `SELECT COUNT(*) as count FROM orders WHERE status = 'pending'`
    );

    res.json({ today, thisMonth, total, pendingOrders: pendingOrders.count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ─── IMAGE PROXY + LOCAL CACHE ──────────────────────────────────────────────

const IMAGE_CACHE_DIR = path.join(__dirname, 'data', 'images');

// Rate limiter: max 60 proxy requests per minute per IP
const proxyHits = new Map();
setInterval(() => { proxyHits.clear(); }, 60000);

function getCachedImagePath(url) {
  const hash = crypto.createHash('md5').update(url).digest('hex');
  return path.join(IMAGE_CACHE_DIR, hash);
}

app.get('/api/img-proxy', (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('url required');

  // Rate limit per IP
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const hits = (proxyHits.get(ip) || 0) + 1;
  proxyHits.set(ip, hits);
  if (hits > 60) return res.status(429).send('rate limit exceeded');

  let target;
  try { target = new URL(url); } catch { return res.status(400).send('invalid url'); }

  const allowed = ['photo.yupoo.com', 'images.footballfanatics.com', 'classicfootballshirts.co.uk', 'assets.adidas.com', 'upload.wikimedia.org'];
  if (!allowed.some(h => target.hostname === h || target.hostname.endsWith('.' + h))) {
    return res.status(403).send('host not allowed');
  }

  const cachedPath = getCachedImagePath(url);
  const ext = path.extname(target.pathname).split('?')[0] || '.jpg';

  // Serve from local cache if available
  if (fs.existsSync(cachedPath)) {
    return res.sendFile(cachedPath);
  }

  // Download and cache
  const mod = target.protocol === 'https:' ? https : http;
  const options = {
    hostname : target.hostname,
    path     : target.pathname + target.search,
    headers  : {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer'   : `https://${target.hostname}/`,
      'Accept'    : 'image/webp,image/apng,image/*,*/*;q=0.8',
    },
  };

  const proxy = mod.get(options, upstream => {
    if ((upstream.statusCode === 301 || upstream.statusCode === 302) && upstream.headers.location) {
      const loc = upstream.headers.location;
      upstream.destroy();
      return res.redirect('/api/img-proxy?url=' + encodeURIComponent(loc));
    }
    if (upstream.statusCode !== 200) {
      upstream.destroy();
      return res.status(upstream.statusCode).send('upstream error');
    }

    const contentType = upstream.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=2592000, s-maxage=2592000');
    res.setHeader('CDN-Cache-Control', 'public, max-age=2592000');

    // Save to disk while streaming to client
    if (!fs.existsSync(IMAGE_CACHE_DIR)) fs.mkdirSync(IMAGE_CACHE_DIR, { recursive: true });
    const fileStream = fs.createWriteStream(cachedPath);
    upstream.pipe(fileStream);
    upstream.pipe(res);
    upstream.on('error', () => { fileStream.close(); if (!res.headersSent) res.status(502).send('upstream stream error'); });
    fileStream.on('error', () => { upstream.destroy(); if (!res.headersSent) res.status(500).send('cache write error'); });
  });
  proxy.setTimeout(8000, () => { proxy.destroy(); if (!res.headersSent) res.status(504).send('upstream timeout'); });
  proxy.on('error', err => { console.error('img-proxy err:', err.message); if (!res.headersSent) res.status(502).send('proxy error'); });
});

// ─── SPA FALLBACK & ERROR HANDLER ─────────────────────────────────────────

// Version endpoint to easily verify live deployment
app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache');
  res.json({ version: '3.9.0', deployedAt: new Date().toISOString() });
});

// Serve index.html for any unmatched non-API route (SPA client-side routing)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body too large. Max 10KB.' });
  }
  if (err.name === 'SyntaxError' && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'Invalid JSON in request body.' });
  }
  res.status(err.status || 500).json({ error: 'Internal server error' });
});

// ─── START ───────────────────────────────────────────────────────────────────

async function start() {
  try {
    await db.initialize();
  } catch (err) {
    console.error('Database connection failed:', err.message);
    console.error('Server will start but database features will be unavailable.');
  }
  if (ziinaConfigured && ZIINA_WEBHOOK_URL) {
    try {
      await ziinaRequest('POST', '/webhook', {
        url: ZIINA_WEBHOOK_URL,
        ...(ZIINA_WEBHOOK_SECRET ? { secret: ZIINA_WEBHOOK_SECRET } : {}),
      });
      console.log(`Ziina webhook registered at ${ZIINA_WEBHOOK_URL}`);
    } catch (err) {
      console.error('Failed to register Ziina webhook:', err.message);
    }
  }
  app.listen(PORT, () => {
    console.log(`Kickoff Jerseys ecommerce running on http://localhost:${PORT}`);
  });
}

start().catch(err => { console.error(err); process.exit(1); });
