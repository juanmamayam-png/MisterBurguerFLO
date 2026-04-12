// src/routes/auth.js — Login y perfil
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt    = require('jsonwebtoken');
const { query } = require('../db/pool');
const { auth }  = require('../middleware/auth');

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  try {
    const result = await query(
      'SELECT * FROM users WHERE username=$1 AND active=true',
      [username]
    );
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok)   return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });

    const payload = { id: user.id, username: user.username, role: user.role, name: user.name };
    const token   = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });

    res.json({ token, user: payload });
  } catch (err) {
    res.status(500).json({ error: 'Error interno del servidor' });
  }
});

// GET /api/auth/me — devuelve el usuario autenticado
router.get('/me', auth, async (req, res) => {
  try {
    const r = await query(
      'SELECT id, username, role, name, active, created_at FROM users WHERE id=$1',
      [req.user.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error interno' });
  }
});

module.exports = router;
