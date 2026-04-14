// src/routes/days.js — Con validaciones completas
'use strict';
const router = require('express').Router();
const { query, pool }       = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');
const { validators, validId } = require('../middleware/validate');

// GET /api/days/status — estado público del local (SIN autenticación)
// Solo indica si está abierto o cerrado, sin datos financieros
router.get('/status', async (req, res) => {
  try {
    const r = await query(
      `SELECT id, date_label, opened_at FROM work_days WHERE status='open' ORDER BY id DESC LIMIT 1`
    );
    const day = r.rows[0];
    res.json({ open: !!day, date_label: day?.date_label || null, opened_at: day?.opened_at || null });
  } catch(err) {
    res.json({ open: false });
  }
});

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


// GET /api/days/:id/products — ventas por producto en la jornada (solo boss)
router.get('/:id/products', auth, requireRole('boss'), validId, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const r = await query(`
      SELECT
        p.id           AS product_id,
        p.name         AS product_name,
        p.category,
        p.emoji,
        SUM(oi.quantity)                       AS units_sold,
        SUM(oi.quantity * oi.unit_price)       AS total_revenue,
        SUM(oi.quantity * oi.unit_cost)        AS total_cost,
        SUM(oi.quantity * (oi.unit_price - oi.unit_cost)) AS total_profit
      FROM order_items oi
      JOIN products p  ON p.id  = oi.product_id
      JOIN orders   o  ON o.id  = oi.order_id
      JOIN tables   t  ON t.id  = o.table_id
      WHERE o.day_id = $1
        AND o.status  = 'paid'
        AND oi.status = 'active'
        AND t.table_type != 'cena_empleados'
      GROUP BY p.id, p.name, p.category, p.emoji
      ORDER BY units_sold DESC, total_revenue DESC
    `, [id]);
    res.json(r.rows);
  } catch(err) {
    console.error('[Days GET /:id/products]', err.message);
    res.status(500).json({ error: 'Error al obtener ventas por producto' });
  }
});

// GET /api/days/:id/cena — resumen de cenas de empleados de la jornada
router.get('/:id/cena', auth, requireRole('boss'), validId, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const r = await query(`
      SELECT
        o.id           AS order_id,
        o.employee_name,
        o.paid_at,
        COALESCE(SUM(oi.quantity * oi.unit_price),0) AS total,
        COALESCE(json_agg(json_build_object(
          'name', p.name, 'qty', oi.quantity, 'price', oi.unit_price
        ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
      FROM orders o
      JOIN tables t    ON t.id  = o.table_id
      LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.status = 'active'
      LEFT JOIN products p     ON p.id = oi.product_id
      WHERE o.day_id = $1
        AND t.table_type = 'cena_empleados'
        AND o.status = 'paid'
      GROUP BY o.id, o.employee_name, o.paid_at
      ORDER BY o.paid_at ASC
    `, [id]);
    const totalGasto = r.rows.reduce((s,x) => s + parseInt(x.total), 0);
    res.json({ cenas: r.rows, total_gasto: totalGasto });
  } catch(err) {
    console.error('[Days GET /:id/cena]', err.message);
    res.status(500).json({ error: 'Error al obtener cenas' });
  }
});


// ══════════════════════════════════════════════════════════════
// GET /api/days/summary/weekly  — Resumen semanal (últimas 12 semanas)
// GET /api/days/summary/monthly — Resumen mensual (últimos 24 meses)
// GET /api/days/summary/annual  — Resumen anual
// ══════════════════════════════════════════════════════════════

// Helper: agrega métricas de un grupo de jornadas
async function aggregatePeriod(rows) {
  return {
    total_sales:      rows.reduce((s,d) => s + parseInt(d.total_sales||0), 0),
    total_cost:       rows.reduce((s,d) => s + parseInt(d.total_cost||0), 0),
    gross_profit:     rows.reduce((s,d) => s + parseInt(d.gross_profit||0), 0),
    total_investment: rows.reduce((s,d) => s + parseInt(d.total_investment||0), 0),
    net_profit:       rows.reduce((s,d) => s + parseInt(d.net_profit||0), 0),
    paid_orders:      rows.reduce((s,d) => s + parseInt(d.paid_orders_count||0), 0),
    days_count:       rows.length,
    cena_gasto:       rows.reduce((s,d) => s + parseInt(d.cena_gasto||0), 0),
  };
}

// Query base: todas las jornadas cerradas con sus métricas
async function getAllDaysMetrics() {
  const r = await query(`
    SELECT d.id, d.opened_at, d.closed_at, d.status,
      COALESCE(SUM(CASE WHEN t.type='income'  THEN t.amount ELSE 0 END),0) AS total_sales,
      COALESCE(SUM(CASE WHEN t.type='income'  THEN t.cost   ELSE 0 END),0) AS total_cost,
      COALESCE(SUM(CASE WHEN t.type='income'  THEN t.profit ELSE 0 END),0) AS gross_profit,
      COALESCE(SUM(CASE WHEN t.type='expense' AND t.method='cena_empleados' THEN t.amount ELSE 0 END),0) AS cena_gasto,
      COALESCE(SUM(CASE WHEN t.type='expense' AND t.method!='cena_empleados' THEN t.amount ELSE 0 END),0) AS total_investment,
      COUNT(CASE WHEN t.type='income' THEN 1 END) AS paid_orders_count
    FROM work_days d
    LEFT JOIN transactions t ON t.day_id = d.id
    WHERE d.status = 'closed'
    GROUP BY d.id
    ORDER BY d.opened_at ASC
  `);
  return r.rows.map(d => ({
    ...d,
    net_profit: parseInt(d.gross_profit) - parseInt(d.total_investment) - parseInt(d.cena_gasto),
  }));
}

// Productos más vendidos de un conjunto de day_ids
async function getTopProducts(dayIds, limit=10) {
  if (!dayIds.length) return [];
  const placeholders = dayIds.map((_,i) => `$${i+1}`).join(',');
  const r = await query(`
    SELECT p.name, p.emoji, p.category,
      SUM(oi.quantity) AS units_sold,
      SUM(oi.quantity * oi.unit_price) AS total_revenue,
      SUM(oi.quantity * (oi.unit_price - oi.unit_cost)) AS total_profit
    FROM order_items oi
    JOIN orders   o ON o.id = oi.order_id
    JOIN products p ON p.id = oi.product_id
    JOIN tables   t ON t.id = o.table_id
    WHERE o.day_id IN (${placeholders})
      AND o.status  = 'paid'
      AND oi.status = 'active'
      AND t.table_type != 'cena_empleados'
    GROUP BY p.id, p.name, p.emoji, p.category
    ORDER BY units_sold DESC, total_revenue DESC
    LIMIT ${limit}
  `, dayIds);
  return r.rows;
}

// GET /api/days/summary/weekly
router.get('/summary/weekly', auth, requireRole('boss'), async (req, res) => {
  try {
    const days = await getAllDaysMetrics();
    // Agrupar por semana ISO (lunes a domingo)
    const weeks = {};
    for (const d of days) {
      const dt = new Date(d.opened_at);
      // Calcular lunes de esa semana
      const dow = dt.getDay() === 0 ? 6 : dt.getDay() - 1; // 0=lun
      const monday = new Date(dt);
      monday.setDate(dt.getDate() - dow);
      monday.setHours(0,0,0,0);
      const key = monday.toISOString().slice(0,10);
      if (!weeks[key]) weeks[key] = { week_start: key, days: [] };
      weeks[key].days.push(d);
    }
    // Convertir a array con métricas y los últimos 12 periodos
    const result = [];
    for (const [key, w] of Object.entries(weeks)) {
      const metrics = await aggregatePeriod(w.days);
      const dayIds  = w.days.map(d => d.id);
      const top     = await getTopProducts(dayIds, 5);
      const endDate = new Date(key);
      endDate.setDate(endDate.getDate() + 6);
      result.push({
        label:      `Sem. ${key} — ${endDate.toISOString().slice(0,10)}`,
        week_start: key,
        week_end:   endDate.toISOString().slice(0,10),
        day_ids:    dayIds,
        top_products: top,
        ...metrics,
      });
    }
    result.sort((a,b) => b.week_start.localeCompare(a.week_start));
    res.json(result.slice(0, 12));
  } catch(err) {
    console.error('[Days GET /summary/weekly]', err.message);
    res.status(500).json({ error: 'Error al obtener resumen semanal' });
  }
});

// GET /api/days/summary/monthly
router.get('/summary/monthly', auth, requireRole('boss'), async (req, res) => {
  try {
    const days = await getAllDaysMetrics();
    const months = {};
    for (const d of days) {
      const dt  = new Date(d.opened_at);
      const key = `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`;
      if (!months[key]) months[key] = { key, days: [] };
      months[key].days.push(d);
    }
    const MONTH_NAMES = ['Enero','Febrero','Marzo','Abril','Mayo','Junio',
                         'Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
    const result = [];
    for (const [key, m] of Object.entries(months)) {
      const [yr, mo] = key.split('-').map(Number);
      const metrics  = await aggregatePeriod(m.days);
      const dayIds   = m.days.map(d => d.id);
      const top      = await getTopProducts(dayIds, 5);
      result.push({
        label:    `${MONTH_NAMES[mo-1]} ${yr}`,
        year:     yr, month: mo, key,
        day_ids:  dayIds,
        top_products: top,
        ...metrics,
      });
    }
    result.sort((a,b) => b.key.localeCompare(a.key));
    res.json(result.slice(0, 24));
  } catch(err) {
    console.error('[Days GET /summary/monthly]', err.message);
    res.status(500).json({ error: 'Error al obtener resumen mensual' });
  }
});

// GET /api/days/summary/annual
router.get('/summary/annual', auth, requireRole('boss'), async (req, res) => {
  try {
    const days = await getAllDaysMetrics();
    const years = {};
    for (const d of days) {
      const yr = new Date(d.opened_at).getFullYear();
      if (!years[yr]) years[yr] = { year: yr, days: [] };
      years[yr].days.push(d);
    }
    const result = [];
    for (const [yr, y] of Object.entries(years)) {
      const metrics = await aggregatePeriod(y.days);
      const dayIds  = y.days.map(d => d.id);
      const top     = await getTopProducts(dayIds, 10);
      result.push({
        label: `Año ${yr}`,
        year:  parseInt(yr),
        day_ids: dayIds,
        top_products: top,
        ...metrics,
      });
    }
    result.sort((a,b) => b.year - a.year);
    res.json(result);
  } catch(err) {
    console.error('[Days GET /summary/annual]', err.message);
    res.status(500).json({ error: 'Error al obtener resumen anual' });
  }
});

module.exports = router;
