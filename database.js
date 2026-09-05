const { Pool } = require('pg');
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const usePg = Boolean(process.env.DATABASE_URL);

let pgPool = null;
let sqliteDb = null;

if (usePg) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });
}

function getDb() {
  if (usePg) return pgPool;
  if (!sqliteDb) {
    const DATA_DIR = path.join(__dirname, 'data');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    sqliteDb = new DatabaseSync(path.join(DATA_DIR, 'store.sqlite'));
    sqliteDb.exec('PRAGMA journal_mode=WAL');
    sqliteDb.exec('PRAGMA foreign_keys=ON');
  }
  return sqliteDb;
}

// Convert PostgreSQL SQL to SQLite-compatible SQL (for local SQLite mode)
function convertSQL(sql) {
  let s = sql;
  s = s.replace(/\$(\d+)\b/g, '?');
  s = s.replace(/\bSERIAL\s+PRIMARY\s+KEY\b/gi, 'INTEGER PRIMARY KEY AUTOINCREMENT');
  s = s.replace(/\bSERIAL\b/gi, 'INTEGER');
  s = s.replace(/\bILIKE\b/gi, 'LIKE');
  s = s.replace(/\bNOW\(\)/gi, "datetime('now')");
  s = s.replace(/\bCURRENT_DATE\b/gi, "date('now')");
  s = s.replace(/\bCURRENT_TIMESTAMP\b/gi, "datetime('now')");
  s = s.replace(/DATE_TRUNC\s*\(\s*'month'\s*,\s*(\w[\w.]+)\s*\)/gi, "strftime('%Y-%m-01', $1)");

  const returningMatch = s.match(/\s+RETURNING\s+(.+)$/i);
  let returning = null;
  if (returningMatch) {
    returning = returningMatch[1].trim();
    s = s.replace(/\s+RETURNING\s+.+$/i, '');
  }

  return { sql: s, returning };
}

function extractTableName(sql) {
  const match = sql.match(/\bINTO\s+(\w+)/i);
  return match ? match[1] : 'jerseys';
}

async function query(sql, params = []) {
  if (usePg) {
    try {
      const res = await pgPool.query(sql, params);
      return { rows: res.rows, rowCount: res.rowCount };
    } catch (err) {
      console.error('PostgreSQL error:', err.message);
      console.error('SQL:', sql);
      console.error('Params:', params);
      throw err;
    }
  }

  const d = getDb();
  const { sql: convertedSql, returning } = convertSQL(sql);
  const p = params.length ? params : undefined;

  try {
    if (convertedSql.trim().toUpperCase().startsWith('INSERT') && returning) {
      const stmt = d.prepare(convertedSql);
      const result = stmt.run(...(p || []));
      const id = Number(result.lastInsertRowid);
      const tableName = extractTableName(convertedSql);
      const returningCols = returning === '*' ? '*' : returning;
      const selectSql = `SELECT ${returningCols} FROM ${tableName} WHERE rowid = ?`;
      const row = d.prepare(selectSql).get(id);
      return { rows: row ? [row] : [], rowCount: 1, lastInsertRowid: id };
    } else {
      const stmt = d.prepare(convertedSql);
      const upper = convertedSql.trim().toUpperCase();
      if (upper.startsWith('INSERT') || upper.startsWith('UPDATE') || upper.startsWith('DELETE')) {
        const result = stmt.run(...(p || []));
        return { rows: [], rowCount: result.changes, lastInsertRowid: Number(result.lastInsertRowid) };
      } else {
        const rows = stmt.all(...(p || []));
        return { rows, rowCount: rows.length };
      }
    }
  } catch (err) {
    console.error('SQLite error:', err.message);
    console.error('SQL:', convertedSql);
    console.error('Params:', params);
    throw err;
  }
}

async function all(sql, params = []) {
  const result = await query(sql, params);
  return result.rows;
}

async function get(sql, params = []) {
  const rows = await all(sql, params);
  return rows[0] || null;
}

async function initialize() {
  if (usePg) {
    console.log('Connected to PostgreSQL database (Supabase)');
    // Ensure tables exist in PostgreSQL
    await pgPool.query(`
      CREATE TABLE IF NOT EXISTS teams (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        slug TEXT NOT NULL UNIQUE,
        country TEXT,
        logo_url TEXT,
        description TEXT
      );
      CREATE TABLE IF NOT EXISTS jerseys (
        id SERIAL PRIMARY KEY,
        team_id INTEGER NOT NULL REFERENCES teams(id),
        name TEXT NOT NULL,
        season TEXT,
        type TEXT,
        description TEXT,
        featured INTEGER DEFAULT 0,
        has_name_behind INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS jersey_images (
        id SERIAL PRIMARY KEY,
        jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
        image_url TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS variants (
        id SERIAL PRIMARY KEY,
        jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
        version TEXT NOT NULL CHECK(version IN ('fan','player','retro')),
        size TEXT NOT NULL CHECK(size IN ('S','M','L','XL','2XL')),
        price NUMERIC NOT NULL DEFAULT 20,
        stock INTEGER NOT NULL DEFAULT 100,
        sku TEXT UNIQUE,
        active INTEGER DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS customers (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        phone TEXT,
        password_hash TEXT,
        is_admin INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS addresses (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
        label TEXT DEFAULT 'Home',
        street TEXT NOT NULL,
        city TEXT NOT NULL DEFAULT '',
        state TEXT,
        zip TEXT,
        country TEXT DEFAULT 'US',
        is_default INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        customer_id INTEGER REFERENCES customers(id),
        email TEXT NOT NULL,
        phone TEXT,
        shipping_address_id INTEGER REFERENCES addresses(id),
        notes TEXT,
        subtotal NUMERIC NOT NULL DEFAULT 0,
        delivery_fee NUMERIC NOT NULL DEFAULT 5,
        name_printing_fee NUMERIC NOT NULL DEFAULT 0,
        total NUMERIC NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','confirmed','processing','shipped','delivered','cancelled')),
        payment_status TEXT NOT NULL DEFAULT 'unpaid'
          CHECK(payment_status IN ('unpaid','paid','refunded','failed')),
        payment_method TEXT,
        shipping_method TEXT,
        tracking_number TEXT,
        stripe_session_id TEXT,
        paid_at TIMESTAMP,
        checkout_id TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS order_items (
        id SERIAL PRIMARY KEY,
        order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
        jersey_id INTEGER NOT NULL REFERENCES jerseys(id),
        variant_id INTEGER REFERENCES variants(id),
        size TEXT NOT NULL,
        version TEXT NOT NULL,
        name_text TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price NUMERIC NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cart_items (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL,
        customer_id INTEGER REFERENCES customers(id),
        variant_id INTEGER NOT NULL REFERENCES variants(id),
        name_text TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Fix type check constraint to include all valid jersey types
    try {
      await pgPool.query('ALTER TABLE jerseys DROP CONSTRAINT IF EXISTS jerseys_type_check');
      await pgPool.query(`ALTER TABLE jerseys ADD CONSTRAINT jerseys_type_check CHECK (type IN ('home','away','third','special','retro','training','tracksuit'))`);
    } catch(e) { /* constraint may already be correct */ }

    // Ensure has_name_behind column exists
    try { await pgPool.query('ALTER TABLE jerseys ADD COLUMN has_name_behind INTEGER DEFAULT 0'); } catch(e){}

    // ─── NEW TABLES: categories, reviews, coupons, banners, contact_messages, wishlist_items ─────
    try {
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS categories (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          slug TEXT NOT NULL UNIQUE,
          image TEXT,
          description TEXT
        );
        CREATE TABLE IF NOT EXISTS reviews (
          id SERIAL PRIMARY KEY,
          jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
          comment TEXT,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS coupons (
          id SERIAL PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          discount_type TEXT NOT NULL CHECK(discount_type IN ('percentage','fixed')),
          discount_value NUMERIC NOT NULL,
          minimum_purchase NUMERIC DEFAULT 0,
          expiry_date TIMESTAMP,
          usage_limit INTEGER DEFAULT 0,
          used_count INTEGER DEFAULT 0,
          active INTEGER DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS banners (
          id SERIAL PRIMARY KEY,
          title TEXT,
          subtitle TEXT,
          image TEXT,
          button_text TEXT,
          link TEXT,
          active INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS contact_messages (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL,
          subject TEXT,
          message TEXT NOT NULL,
          is_read INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS wishlist_items (
          id SERIAL PRIMARY KEY,
          customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
          jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(customer_id, jersey_id)
        );
      `);
    } catch(e) { console.error('Error creating new tables:', e.message); }

    // ─── NEW COLUMNS ON EXISTING TABLES ───
    try { await pgPool.query('ALTER TABLE customers ADD COLUMN avatar TEXT'); } catch(e){}
    try { await pgPool.query('ALTER TABLE jerseys ADD COLUMN slug TEXT'); } catch(e){}
    try { await pgPool.query('ALTER TABLE jerseys ADD COLUMN brand TEXT'); } catch(e){}
    try { await pgPool.query('ALTER TABLE jerseys ADD COLUMN league TEXT'); } catch(e){}
    try { await pgPool.query("ALTER TABLE jerseys ADD COLUMN gender TEXT DEFAULT 'Unisex'"); } catch(e){}
    try { await pgPool.query('ALTER TABLE jerseys ADD COLUMN discount_price NUMERIC'); } catch(e){}
    try { await pgPool.query('ALTER TABLE jerseys ADD COLUMN rating NUMERIC DEFAULT 0'); } catch(e){}
    try { await pgPool.query('ALTER TABLE jerseys ADD COLUMN num_reviews INTEGER DEFAULT 0'); } catch(e){}
    try { await pgPool.query('ALTER TABLE orders ADD COLUMN tax NUMERIC DEFAULT 0'); } catch(e){}
    try { await pgPool.query('ALTER TABLE orders ADD COLUMN shipping_cost NUMERIC DEFAULT 0'); } catch(e){}
    try { await pgPool.query('ALTER TABLE orders ADD COLUMN paid_at TIMESTAMP'); } catch(e){}
    try { await pgPool.query('ALTER TABLE orders ADD COLUMN checkout_id TEXT UNIQUE'); } catch(e){}

    // Ensure admin exists in PG
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@kickoff.com';
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
    const existingAdmin = (await pgPool.query('SELECT id FROM customers WHERE email = $1', [adminEmail])).rows[0];
    if (!existingAdmin) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash(adminPassword, 10);
      await pgPool.query('INSERT INTO customers (name, email, password_hash, is_admin) VALUES ($1, $2, $3, 1)', ['Admin', adminEmail, hash]);
    }
    return;
  }

  const d = getDb();
  console.log('Connected to SQLite database');

  d.exec(`
    CREATE TABLE IF NOT EXISTS teams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      country TEXT,
      logo_url TEXT,
      description TEXT
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS jerseys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL REFERENCES teams(id),
      name TEXT NOT NULL,
      season TEXT,
      type TEXT,
      description TEXT,
      featured INTEGER DEFAULT 0,
      has_name_behind INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  try { d.exec('ALTER TABLE jerseys ADD COLUMN has_name_behind INTEGER DEFAULT 0'); } catch(e){}

  d.exec(`
    CREATE TABLE IF NOT EXISTS jersey_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS variants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
      version TEXT NOT NULL CHECK(version IN ('fan','player','retro')),
      size TEXT NOT NULL CHECK(size IN ('S','M','L','XL','2XL')),
      price REAL NOT NULL DEFAULT 20,
      stock INTEGER NOT NULL DEFAULT 100,
      sku TEXT UNIQUE,
      active INTEGER DEFAULT 1
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      phone TEXT,
      password_hash TEXT,
      is_admin INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS addresses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      label TEXT DEFAULT 'Home',
      street TEXT NOT NULL,
      city TEXT NOT NULL DEFAULT '',
      state TEXT,
      zip TEXT,
      country TEXT DEFAULT 'US',
      is_default INTEGER DEFAULT 0
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER REFERENCES customers(id),
      email TEXT NOT NULL,
      phone TEXT,
      shipping_address_id INTEGER REFERENCES addresses(id),
      notes TEXT,
      subtotal REAL NOT NULL DEFAULT 0,
      delivery_fee REAL NOT NULL DEFAULT 5,
      name_printing_fee REAL NOT NULL DEFAULT 0,
      total REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','confirmed','processing','shipped','delivered','cancelled')),
      payment_status TEXT NOT NULL DEFAULT 'unpaid'
        CHECK(payment_status IN ('unpaid','paid','refunded','failed')),
      payment_method TEXT,
      shipping_method TEXT,
      tracking_number TEXT,
      stripe_session_id TEXT,
      paid_at TEXT,
      checkout_id TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      jersey_id INTEGER NOT NULL REFERENCES jerseys(id),
      variant_id INTEGER REFERENCES variants(id),
      size TEXT NOT NULL,
      version TEXT NOT NULL,
      name_text TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      unit_price REAL NOT NULL
    )
  `);

  d.exec(`
    CREATE TABLE IF NOT EXISTS cart_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      customer_id INTEGER REFERENCES customers(id),
      variant_id INTEGER NOT NULL REFERENCES variants(id),
      name_text TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  d.exec('CREATE INDEX IF NOT EXISTS idx_jerseys_team ON jerseys(team_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_jerseys_featured ON jerseys(featured)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_variants_jersey ON variants(jersey_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_cart_session ON cart_items(session_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_orders_customer ON orders(customer_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_orders_stripe ON orders(stripe_session_id)');

  // ─── NEW TABLES (SQLite) ───
  d.exec(`
    CREATE TABLE IF NOT EXISTS categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      slug TEXT NOT NULL UNIQUE,
      image TEXT,
      description TEXT
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
      comment TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      discount_type TEXT NOT NULL CHECK(discount_type IN ('percentage','fixed')),
      discount_value REAL NOT NULL,
      minimum_purchase REAL DEFAULT 0,
      expiry_date TEXT,
      usage_limit INTEGER DEFAULT 0,
      used_count INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS banners (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      subtitle TEXT,
      image TEXT,
      button_text TEXT,
      link TEXT,
      active INTEGER DEFAULT 0
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS contact_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      subject TEXT,
      message TEXT NOT NULL,
      is_read INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS wishlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      jersey_id INTEGER NOT NULL REFERENCES jerseys(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(customer_id, jersey_id)
    )
  `);

  // ─── NEW COLUMNS ON EXISTING TABLES (SQLite) ───
  try { d.exec('ALTER TABLE customers ADD COLUMN avatar TEXT'); } catch(e){}
  try { d.exec('ALTER TABLE jerseys ADD COLUMN slug TEXT'); } catch(e){}
  try { d.exec('ALTER TABLE jerseys ADD COLUMN brand TEXT'); } catch(e){}
  try { d.exec('ALTER TABLE jerseys ADD COLUMN league TEXT'); } catch(e){}
  try { d.exec("ALTER TABLE jerseys ADD COLUMN gender TEXT DEFAULT 'Unisex'"); } catch(e){}
  try { d.exec('ALTER TABLE jerseys ADD COLUMN discount_price REAL'); } catch(e){}
  try { d.exec('ALTER TABLE jerseys ADD COLUMN rating REAL DEFAULT 0'); } catch(e){}
  try { d.exec('ALTER TABLE jerseys ADD COLUMN num_reviews INTEGER DEFAULT 0'); } catch(e){}
  try { d.exec('ALTER TABLE orders ADD COLUMN tax REAL DEFAULT 0'); } catch(e){}
  try { d.exec('ALTER TABLE orders ADD COLUMN shipping_cost REAL DEFAULT 0'); } catch(e){}
  try { d.exec('ALTER TABLE orders ADD COLUMN paid_at TEXT'); } catch(e){}
  try { d.exec('ALTER TABLE orders ADD COLUMN checkout_id TEXT UNIQUE'); } catch(e){}

  const adminEmail = process.env.ADMIN_EMAIL || 'admin@kickoff.com';
  const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
  const existingAdmin = d.prepare('SELECT id FROM customers WHERE email = ?').get(adminEmail);
  if (!existingAdmin) {
    const bcrypt = require('bcryptjs');
    const hash = await bcrypt.hash(adminPassword, 10);
    d.prepare('INSERT INTO customers (name, email, password_hash, is_admin) VALUES (?, ?, ?, 1)').run('Admin', adminEmail, hash);
  }

  // Normalize variant pricing rules: Fan = €20, Player = €25, Retro = €25
  d.exec("UPDATE variants SET price = 20 WHERE version = 'fan'");
  d.exec("UPDATE variants SET price = 25 WHERE version = 'player'");
  d.exec("UPDATE variants SET price = 25 WHERE version = 'retro'");
  d.exec("UPDATE jerseys SET featured = 1 WHERE id IN (SELECT id FROM jerseys ORDER BY id LIMIT 36)");
  d.exec("UPDATE jerseys SET season = '2025-26' WHERE id IN (SELECT id FROM jerseys WHERE season LIKE '%2023%' OR season LIKE '%2022%' OR season = '' OR season IS NULL LIMIT 40)");
  d.exec("UPDATE jerseys SET type = 'training', name = REPLACE(name, 'Home Kit', 'Training Kit') WHERE id IN (SELECT id FROM jerseys WHERE id % 10 = 3 LIMIT 12)");
  d.exec("UPDATE jerseys SET type = 'tracksuit', name = REPLACE(name, 'Home Kit', 'Full Tracksuit') WHERE id IN (SELECT id FROM jerseys WHERE id % 10 = 7 LIMIT 12)");
  d.exec("UPDATE jerseys SET type = 'third' WHERE id IN (SELECT id FROM jerseys WHERE id % 10 = 5 LIMIT 15)");
}

async function getClient() {
  return getDb();
}

function savepoint(client, name) {}
function rollbackToSavepoint(client, name) {}
function releaseSavepoint(client, name) {}

module.exports = {
  getDb,
  query,
  initialize,
  all,
  get,
  getClient,
  savepoint,
  rollbackToReleaseSavepoint: releaseSavepoint,
  rollbackToSavepoint,
  releaseSavepoint
};
