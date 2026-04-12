// src/routes/days.js — Jornadas de trabajo y reportes
const router = require('express').Router();
const { query, pool }  = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');

// GET /api/days — historial de jornadas
router.get('/', auth, requireRole('boss'), async (req, res) => {
  try {
    const r = await query(`
      SELECT d.*,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.amount ELSE 0 END),0) AS total_sales,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.cost   ELSE 0 END),0) AS total_cost,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.profit ELSE 0 END),0) AS gross_profit,
        COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END),0) AS total_investment,
        COUNT(CASE WHEN t.type='income' THEN 1 END) AS paid_orders_count
      FROM work_days d
      LEFT JOIN transactions t ON t.day_id = d.id
      GROUP BY d.id
      ORDER BY d.opened_at DESC
    `);

    // Adjuntar inversiones de cada jornada
    const days = r.rows;
    for (const day of days) {
      const inv = await query('SELECT * FROM investments WHERE day_id=$1', [day.id]);
      day.investments = inv.rows;
      day.net_profit  = day.gross_profit - day.total_investment;
    }
    res.json(days);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener jornadas' });
  }
});

// GET /api/days/current — jornada actualmente abierta
router.get('/current', auth, async (req, res) => {
  try {
    const r = await query(`
      SELECT d.*,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.amount ELSE 0 END),0) AS total_sales,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.profit ELSE 0 END),0) AS gross_profit,
        COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END),0) AS total_investment
      FROM work_days d
      LEFT JOIN transactions t ON t.day_id = d.id
      WHERE d.status='open'
      GROUP BY d.id
      ORDER BY d.opened_at DESC LIMIT 1
    `);
    const day = r.rows[0] || null;
    if (day) {
      const inv = await query('SELECT * FROM investments WHERE day_id=$1', [day.id]);
      day.investments = inv.rows;
      day.net_profit  = day.gross_profit - day.total_investment;
    }
    res.json(day);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener jornada actual' });
  }
});

// POST /api/days — abrir jornada (solo boss)
router.post('/', auth, requireRole('boss'), async (req, res) => {
  const { investments = [], open_notes = '' } = req.body;
  try {
    // Verificar que no haya jornada abierta
    const existing = await query('SELECT id FROM work_days WHERE status=\'open\'');
    if (existing.rows.length > 0)
      return res.status(409).json({ error: 'Ya hay una jornada abierta' });

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const dRes = await client.query(
        `INSERT INTO work_days (date_label, open_notes, status, opened_by)
         VALUES ($1,$2,'open',$3) RETURNING *`,
        [new Date().toLocaleDateString('es-CO'), open_notes, req.user.id]
      );
      const day = dRes.rows[0];

      // Insertar inversiones
      for (const inv of investments) {
        if (inv.description && inv.amount > 0) {
          await client.query(
            'INSERT INTO investments (day_id, description, amount) VALUES ($1,$2,$3)',
            [day.id, inv.description, inv.amount]
          );
          // También como transacción de gasto
          await client.query(
            `INSERT INTO transactions (day_id, type, amount, cost, profit, description)
             VALUES ($1,'expense',$2,0,0,$3)`,
            [day.id, inv.amount, inv.description]
          );
        }
      }
      await client.query('COMMIT');
      res.status(201).json({ ...day, investments });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (err) {
    if (err.status === 409) return res.status(409).json(err);
    res.status(500).json({ error: 'Error al abrir jornada' });
  }
});

// PATCH /api/days/:id/close — cerrar jornada (solo boss)
router.patch('/:id/close', auth, requireRole('boss'), async (req, res) => {
  const { close_notes = '' } = req.body;
  try {
    // Verificar que no haya pedidos sin cobrar
    const pending = await query(
      'SELECT COUNT(*) FROM orders WHERE day_id=$1 AND status IN (\'active\',\'pending\')',
      [req.params.id]
    );
    if (parseInt(pending.rows[0].count) > 0)
      return res.status(409).json({ error: 'Hay pedidos sin cobrar. Ciérralos antes de terminar la jornada.' });

    const r = await query(
      `UPDATE work_days SET status='closed', closed_at=NOW(), close_notes=$1
       WHERE id=$2 AND status='open' RETURNING *`,
      [close_notes, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Jornada no encontrada o ya cerrada' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al cerrar jornada' });
  }
});

module.exports = router;
