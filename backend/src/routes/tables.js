// src/routes/tables.js — Gestión de mesas
const router = require('express').Router();
const { query }        = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');

// GET /api/tables — todas las mesas con su pedido activo si existe
router.get('/', auth, async (req, res) => {
  try {
    const r = await query(`
      SELECT t.*,
        o.id        AS order_id,
        o.status    AS order_status,
        o.waiter_id AS order_waiter_id,
        COALESCE(SUM(CASE WHEN oi.status='active' THEN oi.quantity * oi.unit_price ELSE 0 END), 0) AS order_total
      FROM tables t
      LEFT JOIN orders o ON o.table_id = t.id AND o.status IN ('active','pending')
      LEFT JOIN order_items oi ON oi.order_id = o.id
      GROUP BY t.id, o.id, o.status, o.waiter_id
      ORDER BY t.floor, t.number
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener mesas' });
  }
});

// PATCH /api/tables/:id/status — cambiar estado (solo boss)
router.patch('/:id/status', auth, requireRole('boss'), async (req, res) => {
  const { status } = req.body;
  if (!['free','occupied','pending'].includes(status))
    return res.status(400).json({ error: 'Estado inválido' });
  try {
    const r = await query(
      'UPDATE tables SET status=$1 WHERE id=$2 RETURNING *',
      [status, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Mesa no encontrada' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar mesa' });
  }
});

module.exports = router;
