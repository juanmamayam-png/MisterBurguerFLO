// src/routes/users.js — Gestión de usuarios (solo boss)
const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const { query }        = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');

// GET /api/users
router.get('/', auth, requireRole('boss'), async (req, res) => {
  try {
    const r = await query(
      'SELECT id, username, role, name, active, created_at FROM users ORDER BY id'
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener usuarios' });
  }
});

// POST /api/users — crear usuario
router.post('/', auth, requireRole('boss'), async (req, res) => {
  const { username, password, role, name } = req.body;
  if (!username || !password || !role || !name)
    return res.status(400).json({ error: 'Todos los campos son requeridos' });
  if (!['boss','waiter','kitchen'].includes(role))
    return res.status(400).json({ error: 'Rol inválido' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await query(
      'INSERT INTO users (username, password, role, name) VALUES ($1,$2,$3,$4) RETURNING id, username, role, name, active',
      [username, hash, role, name]
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'El nombre de usuario ya existe' });
    res.status(500).json({ error: 'Error al crear usuario' });
  }
});

// PATCH /api/users/:id/password — cambiar contraseña
router.patch('/:id/password', auth, requireRole('boss'), async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 4)
    return res.status(400).json({ error: 'Contraseña mínimo 4 caracteres' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await query(
      'UPDATE users SET password=$1 WHERE id=$2 RETURNING id, username',
      [hash, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json({ message: 'Contraseña actualizada', id: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar contraseña' });
  }
});

// PATCH /api/users/:id/toggle — activar/desactivar
router.patch('/:id/toggle', auth, requireRole('boss'), async (req, res) => {
  // No se puede desactivar a sí mismo
  if (parseInt(req.params.id) === req.user.id)
    return res.status(403).json({ error: 'No puedes desactivarte a ti mismo' });
  try {
    const r = await query(
      'UPDATE users SET active = NOT active WHERE id=$1 RETURNING id, username, active',
      [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Usuario no encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar usuario' });
  }
});

module.exports = router;
