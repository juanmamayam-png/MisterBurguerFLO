// src/routes/auth.js — Login con sesión única por usuario
'use strict';
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const crypto  = require('crypto');
const { query }      = require('../db/pool');
const { auth }       = require('../middleware/auth');
const { validators } = require('../middleware/validate');

// POST /api/auth/login
router.post('/login', validators.login, async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await query(
      'SELECT * FROM users WHERE username=$1',
      [username.toLowerCase().trim()]
    );
    const user = result.rows[0];

    if (!user) {
      await bcrypt.hash('dummy_prevent_timing_attack', 10);
      return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
    }
    if (!user.active)
      return res.status(403).json({ error: 'Esta cuenta está desactivada. Contacta al Jefe.' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    // Generar token único de sesión
    const sessionToken = crypto.randomBytes(32).toString('hex');

    // Guardar en BD — invalida cualquier sesión anterior del mismo usuario
    await query(
      'UPDATE users SET session_token=$1 WHERE id=$2',
      [sessionToken, user.id]
    );

    // Incluir sessionToken en el JWT para verificarlo en cada request
    const payload = {
      id: user.id, username: user.username,
      role: user.role, name: user.name,
      st: sessionToken   // session token corto en el payload
    };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '24h' });

    res.json({ token, user: { id:user.id, username:user.username, role:user.role, name:user.name } });
  } catch(err) {
    console.error('[Auth POST /login]', err.message);
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// POST /api/auth/logout — invalida la sesión en el servidor
router.post('/logout', auth, async (req, res) => {
  try {
    await query('UPDATE users SET session_token=NULL WHERE id=$1', [req.user.id]);
    res.json({ message: 'Sesión cerrada' });
  } catch(err) {
    res.status(500).json({ error: 'Error al cerrar sesión' });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  try {
    const r = await query(
      'SELECT id,username,role,name,active,created_at FROM users WHERE id=$1 AND active=true',
      [req.user.id]
    );
    if (!r.rows[0]) return res.status(401).json({ error: 'Usuario no encontrado o desactivado' });
    res.json(r.rows[0]);
  } catch(err) {
    console.error('[Auth GET /me]', err.message);
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
