// src/server.js — Servidor Express principal
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const rateLimit  = require('express-rate-limit');
 
const app = express();
const PORT = process.env.PORT || 3000;
 
// ── Middlewares globales ───────────────────────────────────────────
app.use(cors({
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['GET','POST','PUT','PATCH','DELETE'],
  allowedHeaders: ['Content-Type','Authorization'],
}));
 
app.use(express.json({ limit: '10mb' })); // 10 MB para fotos base64
app.use(express.urlencoded({ extended: true }));
 
// Rate limiting: máximo 200 req/minuto por IP
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: { error: 'Demasiadas solicitudes, espera un momento' },
}));
 
// ── Rutas API ─────────────────────────────────────────────────────
app.use('/api/auth',     require('./routes/auth'));
app.use('/api/products', require('./routes/products'));
app.use('/api/tables',   require('./routes/tables'));
app.use('/api/orders',   require('./routes/orders'));
app.use('/api/days',     require('./routes/days'));
app.use('/api/users',    require('./routes/users'));
 
// ── Health check (Railway lo usa para saber si el servicio está vivo) ─
app.get('/health', (req, res) => res.json({ status: 'ok', timestamp: new Date() }));
 
// ── Sirve el frontend estático desde /frontend/public ────────────
// En Railway: __dirname = /app/backend/src
// 2 niveles arriba = /app → luego frontend/public
const FRONTEND = path.join(__dirname, '..', '..', 'frontend', 'public');
console.log('[Server] Frontend path:', FRONTEND);
 
app.use(express.static(FRONTEND));
 
// Todas las rutas no-API devuelven index.html
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ error: 'Ruta no encontrada' });
  }
  const indexFile = path.join(FRONTEND, 'index.html');
  res.sendFile(indexFile, (err) => {
    if (err) {
      console.error('[Server] index.html no encontrado en:', indexFile);
      res.status(500).json({ error: 'Frontend no encontrado', path: indexFile });
    }
  });
});
 
// ── Global error handler ──────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[Server Error]', err.message);
  res.status(500).json({ error: 'Error interno del servidor' });
});
 
// ── Arrancar ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🍔 Mister Burger POS — Backend`);
  console.log(`   Puerto : ${PORT}`);
  console.log(`   Entorno: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   API    : http://localhost:${PORT}/api\n`);
});
