// src/db/pool.js — Conexión a PostgreSQL usando pg
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway ya provee SSL en producción
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  console.error('[DB] Error inesperado en el pool:', err.message);
});

// Helper: ejecutar query con manejo de errores
async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[DB] ${Date.now() - start}ms — ${text.substring(0, 60)}`);
    }
    return res;
  } catch (err) {
    console.error('[DB] Query error:', err.message, '|', text);
    throw err;
  }
}

module.exports = { pool, query };
