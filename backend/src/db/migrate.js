// src/db/migrate.js — Crea todas las tablas en PostgreSQL
require('dotenv').config();
const { pool } = require('./pool');

const SQL = `

-- ═══════════════════════════════════════════════════
--  MISTER BURGER POS — Esquema de base de datos
-- ═══════════════════════════════════════════════════

-- Extensión para UUIDs (opcional, usamos SERIAL por simplicidad)
-- CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── USUARIOS ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  username    VARCHAR(60)  UNIQUE NOT NULL,
  password    VARCHAR(200) NOT NULL,   -- bcrypt hash
  role        VARCHAR(20)  NOT NULL CHECK (role IN ('boss','waiter','kitchen')),
  name        VARCHAR(100) NOT NULL,
  active      BOOLEAN      NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── PRODUCTOS ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100) NOT NULL,
  description TEXT,
  emoji       VARCHAR(10)  DEFAULT '🍔',
  image       TEXT,                        -- base64 o URL
  category    VARCHAR(50)  NOT NULL,
  price       INTEGER      NOT NULL,       -- en pesos COP
  cost        INTEGER      NOT NULL DEFAULT 0,
  status      VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── MESAS ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tables (
  id          SERIAL PRIMARY KEY,
  number      INTEGER      NOT NULL,
  floor       INTEGER      NOT NULL DEFAULT 1,
  status      VARCHAR(30)  NOT NULL DEFAULT 'free'
                CHECK (status IN ('free','occupied','pending')),
  UNIQUE (number, floor)
);

-- ── JORNADAS (DÍAS DE TRABAJO) ──────────────────────
CREATE TABLE IF NOT EXISTS work_days (
  id          SERIAL PRIMARY KEY,
  date_label  VARCHAR(50)  NOT NULL,   -- ej: "15/4/2025"
  opened_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  closed_at   TIMESTAMPTZ,
  open_notes  TEXT,
  close_notes TEXT,
  status      VARCHAR(20)  NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  opened_by   INTEGER REFERENCES users(id)
);

-- ── INVERSIONES (al abrir jornada) ─────────────────
CREATE TABLE IF NOT EXISTS investments (
  id          SERIAL PRIMARY KEY,
  day_id      INTEGER NOT NULL REFERENCES work_days(id) ON DELETE CASCADE,
  description VARCHAR(200) NOT NULL,
  amount      INTEGER      NOT NULL DEFAULT 0
);

-- ── PEDIDOS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
  id          SERIAL PRIMARY KEY,
  table_id    INTEGER NOT NULL REFERENCES tables(id),
  waiter_id   INTEGER NOT NULL REFERENCES users(id),
  day_id      INTEGER REFERENCES work_days(id),
  status      VARCHAR(30)  NOT NULL DEFAULT 'active'
                CHECK (status IN ('active','pending','paid')),
  pay_method  VARCHAR(30),
  total_paid  INTEGER,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  paid_at     TIMESTAMPTZ
);

-- ── ÍTEMS DE PEDIDO ─────────────────────────────────
CREATE TABLE IF NOT EXISTS order_items (
  id          SERIAL PRIMARY KEY,
  order_id    INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  quantity    INTEGER      NOT NULL DEFAULT 1,
  unit_price  INTEGER      NOT NULL,   -- precio al momento del pedido
  unit_cost   INTEGER      NOT NULL DEFAULT 0,
  notes       TEXT,
  status      VARCHAR(20)  NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled'))
);

-- ── TRANSACCIONES (contabilidad) ────────────────────
CREATE TABLE IF NOT EXISTS transactions (
  id          SERIAL PRIMARY KEY,
  day_id      INTEGER NOT NULL REFERENCES work_days(id) ON DELETE CASCADE,
  order_id    INTEGER REFERENCES orders(id),
  type        VARCHAR(20)  NOT NULL CHECK (type IN ('income','expense')),
  amount      INTEGER      NOT NULL,
  cost        INTEGER      NOT NULL DEFAULT 0,
  profit      INTEGER      NOT NULL DEFAULT 0,
  method      VARCHAR(30),
  description TEXT,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- ── ÍNDICES para rendimiento ─────────────────────────
CREATE INDEX IF NOT EXISTS idx_orders_table    ON orders(table_id, status);
CREATE INDEX IF NOT EXISTS idx_orders_day      ON orders(day_id);
CREATE INDEX IF NOT EXISTS idx_items_order     ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_trans_day       ON transactions(day_id);
CREATE INDEX IF NOT EXISTS idx_products_status ON products(status);

-- ── Trigger: actualiza updated_at en products ────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS products_updated_at ON products;
CREATE TRIGGER products_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

`;

async function migrate() {
  const client = await pool.connect();
  try {
    console.log('[Migrate] Ejecutando migraciones…');
    await client.query(SQL);
    console.log('[Migrate] ✅ Tablas creadas/actualizadas correctamente');
  } catch (err) {
    console.error('[Migrate] ❌ Error:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
