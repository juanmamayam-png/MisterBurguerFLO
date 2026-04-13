// src/middleware/auth.js — Verificación JWT + sesión única
const jwt   = require('jsonwebtoken');
const { query } = require('../db/pool');

async function auth(req, res, next) {
  const header = req.headers['authorization'];
  if (!header) return res.status(401).json({ error: 'Token requerido' });

  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }

  try {
    // Verificar que la sesión sigue activa en la BD
    const r = await query(
      'SELECT id, username, role, name, active, session_token FROM users WHERE id=$1',
      [payload.id]
    );
    const user = r.rows[0];

    if (!user)        return res.status(401).json({ error: 'Usuario no encontrado' });
    if (!user.active) return res.status(403).json({ error: 'Cuenta desactivada' });

    // Si el token tiene session_token (st), verificar que coincida con el de la BD
    // Tokens viejos sin 'st' se rechazan también para forzar re-login
    if (!payload.st || user.session_token !== payload.st) {
      return res.status(401).json({
        error: 'Tu sesión fue iniciada en otro dispositivo. Por favor inicia sesión de nuevo.',
        code:  'SESSION_DISPLACED'
      });
    }

    req.user = { id: user.id, username: user.username, role: user.role, name: user.name };
    next();
  } catch(err) {
    console.error('[Auth middleware]', err.message);
    res.status(500).json({ error: 'Error interno de autenticación' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role))
      return res.status(403).json({ error: 'Acceso denegado para este rol' });
    next();
  };
}

module.exports = { auth, requireRole };
