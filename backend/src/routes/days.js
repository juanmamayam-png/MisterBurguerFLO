// src/routes/days.js — Con validaciones completas
'use strict';
const router = require('express').Router();
const { query, pool }       = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');
const { validators, validId } = require('../middleware/validate');

// GET /api/days
router.get('/', auth, requireRole('boss'), async (req, res) => {
  try {
    const r = await query(`
      SELECT d.*,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.amount ELSE 0 END),0) AS total_sales,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.cost   ELSE 0 END),0) AS total_cost,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.profit ELSE 0 END),0) AS gross_profit,
        COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END),0) AS total_investment,
        COUNT(CASE WHEN t.type='income' THEN 1 END) AS paid_orders_count
      FROM work_days d LEFT JOIN transactions t ON t.day_id=d.id
      GROUP BY d.id ORDER BY d.opened_at DESC`);
    const days = r.rows;
    for (const day of days) {
      const inv = await query('SELECT * FROM investments WHERE day_id=$1 ORDER BY id',[day.id]);
      day.investments = inv.rows;
      day.net_profit  = parseInt(day.gross_profit) - parseInt(day.total_investment);
    }
    res.json(days);
  } catch(err){ console.error('[Days GET /]',err.message); res.status(500).json({error:'Error al obtener jornadas'}); }
});

// GET /api/days/current
router.get('/current', auth, async (req, res) => {
  try {
    const r = await query(`
      SELECT d.*,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.amount ELSE 0 END),0) AS total_sales,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.cost   ELSE 0 END),0) AS total_cost,
        COALESCE(SUM(CASE WHEN t.type='income'  THEN t.profit ELSE 0 END),0) AS gross_profit,
        COALESCE(SUM(CASE WHEN t.type='expense' THEN t.amount ELSE 0 END),0) AS total_investment
      FROM work_days d LEFT JOIN transactions t ON t.day_id=d.id
      WHERE d.status='open' GROUP BY d.id ORDER BY d.opened_at DESC LIMIT 1`);
    const day = r.rows[0] || null;
    if (day) {
      const inv = await query('SELECT * FROM investments WHERE day_id=$1 ORDER BY id',[day.id]);
      day.investments = inv.rows;
      day.net_profit  = parseInt(day.gross_profit) - parseInt(day.total_investment);
    }
    res.json(day);
  } catch(err){ console.error('[Days GET /current]',err.message); res.status(500).json({error:'Error al obtener jornada actual'}); }
});

// POST /api/days — abrir jornada
router.post('/', auth, requireRole('boss'), validators.openDay, async (req, res) => {
  const { investments=[], open_notes='' } = req.body;
  // Validar inversiones
  if (!Array.isArray(investments)) return res.status(400).json({error:'investments debe ser un array'});
  for (const inv of investments) {
    if (inv.amount !== undefined && (isNaN(inv.amount) || Number(inv.amount)<0))
      return res.status(400).json({error:'Los montos de inversión deben ser números positivos'});
    if (inv.amount > 50000000)
      return res.status(400).json({error:'Monto de inversión excede el límite permitido'});
    if (inv.description && String(inv.description).length>200)
      return res.status(400).json({error:'La descripción de inversión es muy larga (máx 200 caracteres)'});
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(`SELECT id FROM work_days WHERE status='open' LIMIT 1`);
    if (existing.rows.length>0) {
      await client.query('ROLLBACK');
      return res.status(409).json({error:'Ya hay una jornada abierta. Ciérrala antes de abrir una nueva.'});
    }
    const dRes = await client.query(
      `INSERT INTO work_days (date_label,open_notes,status,opened_by) VALUES ($1,$2,'open',$3) RETURNING *`,
      [new Date().toLocaleDateString('es-CO'), open_notes.trim(), req.user.id]);
    const day = dRes.rows[0];
    const savedInv = [];
    for (const inv of investments) {
      const amt = parseInt(inv.amount)||0;
      const desc = String(inv.description||'').trim();
      if (desc && amt>0) {
        await client.query('INSERT INTO investments (day_id,description,amount) VALUES ($1,$2,$3)',[day.id,desc,amt]);
        await client.query(`INSERT INTO transactions (day_id,type,amount,cost,profit,description) VALUES ($1,'expense',$2,0,0,$3)`,[day.id,amt,desc]);
        savedInv.push({description:desc,amount:amt});
      }
    }
    await client.query('COMMIT');
    res.status(201).json({...day, investments:savedInv});
  } catch(err){
    await client.query('ROLLBACK').catch(()=>{});
    console.error('[Days POST /]',err.message);
    res.status(500).json({error:'Error al abrir jornada'});
  } finally { client.release(); }
});

// PATCH /api/days/:id/close
router.patch('/:id/close', auth, requireRole('boss'), validId, validators.closeDay, async (req, res) => {
  const id = parseInt(req.params.id);
  const { close_notes='' } = req.body;
  try {
    // Verificar que la jornada existe y está abierta
    const dayRes = await query('SELECT * FROM work_days WHERE id=$1',[id]);
    const day = dayRes.rows[0];
    if (!day) return res.status(404).json({error:'Jornada no encontrada'});
    if (day.status!=='open') return res.status(409).json({error:'Esta jornada ya está cerrada'});

    // Verificar pedidos sin cobrar
    const pending = await query(
      `SELECT COUNT(*) FROM orders WHERE day_id=$1 AND status IN ('active','pending')`,[id]);
    const pendingCount = parseInt(pending.rows[0].count);
    if (pendingCount>0)
      return res.status(409).json({
        error:`Hay ${pendingCount} pedido(s) sin cobrar. Ciérralos antes de terminar la jornada.`,
        pending_count: pendingCount
      });

    const r = await query(
      `UPDATE work_days SET status='closed',closed_at=NOW(),close_notes=$1 WHERE id=$2 AND status='open' RETURNING *`,
      [close_notes.trim(), id]);
    if (!r.rows[0]) return res.status(409).json({error:'La jornada ya fue cerrada por otro proceso'});
    res.json(r.rows[0]);
  } catch(err){ console.error('[Days PATCH /close]',err.message); res.status(500).json({error:'Error al cerrar jornada'}); }
});

module.exports = router;
