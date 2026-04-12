// src/routes/orders.js — Ciclo de vida completo de pedidos
const router = require('express').Router();
const { query }        = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');

// ── Helpers ───────────────────────────────────────────────────────
async function getOrderWithItems(orderId) {
  const [oRes, iRes] = await Promise.all([
    query(`SELECT o.*, t.number AS table_number, t.floor AS table_floor,
                  u.name AS waiter_name
           FROM orders o
           JOIN tables t ON t.id = o.table_id
           JOIN users  u ON u.id = o.waiter_id
           WHERE o.id=$1`, [orderId]),
    query(`SELECT oi.*, p.name AS product_name, p.emoji, p.category, p.image
           FROM order_items oi
           JOIN products p ON p.id = oi.product_id
           WHERE oi.order_id=$1 ORDER BY oi.id`, [orderId]),
  ]);
  if (!oRes.rows[0]) return null;
  return { ...oRes.rows[0], items: iRes.rows };
}

// GET /api/orders — todos los pedidos (filtros opcionales: status, day_id)
router.get('/', auth, async (req, res) => {
  try {
    const { status, day_id } = req.query;
    let sql = `SELECT o.*, t.number AS table_number, t.floor AS table_floor,
                       u.name AS waiter_name,
                       COALESCE(SUM(CASE WHEN oi.status='active' THEN oi.quantity*oi.unit_price ELSE 0 END),0) AS total
               FROM orders o
               JOIN tables t ON t.id = o.table_id
               JOIN users  u ON u.id = o.waiter_id
               LEFT JOIN order_items oi ON oi.order_id = o.id
               WHERE 1=1`;
    const params = [];
    if (status)  sql += ` AND o.status=$${params.push(status)}`;
    if (day_id)  sql += ` AND o.day_id=$${params.push(day_id)}`;
    sql += ' GROUP BY o.id, t.number, t.floor, u.name ORDER BY o.created_at DESC';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener pedidos' });
  }
});

// GET /api/orders/kitchen — pedidos activos y pendientes para cocina
router.get('/kitchen', auth, requireRole('kitchen','boss'), async (req, res) => {
  try {
    const r = await query(`
      SELECT o.id, o.status, o.created_at,
             t.number AS table_number, t.floor AS table_floor,
             json_agg(
               json_build_object(
                 'id', oi.id, 'product_id', oi.product_id,
                 'product_name', p.name, 'emoji', p.emoji,
                 'category', p.category, 'image', p.image,
                 'quantity', oi.quantity, 'notes', oi.notes, 'status', oi.status
               ) ORDER BY oi.id
             ) AS items
      FROM orders o
      JOIN tables t ON t.id = o.table_id
      JOIN order_items oi ON oi.order_id = o.id AND oi.status='active'
      JOIN products p ON p.id = oi.product_id
      WHERE o.status IN ('active','pending')
      GROUP BY o.id, t.number, t.floor
      ORDER BY o.created_at ASC
    `);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener pedidos de cocina' });
  }
});

// GET /api/orders/:id
router.get('/:id', auth, async (req, res) => {
  try {
    const order = await getOrderWithItems(req.params.id);
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener pedido' });
  }
});

// POST /api/orders — crear nuevo pedido en una mesa
router.post('/', auth, requireRole('waiter','boss'), async (req, res) => {
  const { table_id } = req.body;
  if (!table_id) return res.status(400).json({ error: 'table_id requerido' });
  try {
    // Verificar que la mesa existe y está libre
    const tRes = await query('SELECT * FROM tables WHERE id=$1', [table_id]);
    const table = tRes.rows[0];
    if (!table) return res.status(404).json({ error: 'Mesa no encontrada' });
    if (table.status !== 'free') return res.status(409).json({ error: 'La mesa no está libre' });

    // Obtener jornada activa
    const dRes = await query('SELECT id FROM work_days WHERE status=\'open\' ORDER BY id DESC LIMIT 1');
    const day_id = dRes.rows[0]?.id || null;

    const client = await require('../db/pool').pool.connect();
    try {
      await client.query('BEGIN');
      const oRes = await client.query(
        'INSERT INTO orders (table_id, waiter_id, day_id, status) VALUES ($1,$2,$3,\'active\') RETURNING *',
        [table_id, req.user.id, day_id]
      );
      await client.query('UPDATE tables SET status=\'occupied\' WHERE id=$1', [table_id]);
      await client.query('COMMIT');
      res.status(201).json(oRes.rows[0]);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    res.status(500).json({ error: 'Error al crear pedido' });
  }
});

// POST /api/orders/:id/items — agregar ítem al pedido
router.post('/:id/items', auth, requireRole('waiter','boss'), async (req, res) => {
  const { product_id, quantity, notes } = req.body;
  if (!product_id || !quantity) return res.status(400).json({ error: 'product_id y quantity requeridos' });
  try {
    const oRes = await query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    const order = oRes.rows[0];
    if (!order)              return res.status(404).json({ error: 'Pedido no encontrado' });
    if (order.status !== 'active') return res.status(409).json({ error: 'El pedido no está activo' });

    // Solo el mesero dueño o el jefe pueden agregar
    if (req.user.role !== 'boss' && order.waiter_id !== req.user.id)
      return res.status(403).json({ error: 'No tienes permiso para este pedido' });

    const pRes = await query('SELECT price, cost FROM products WHERE id=$1 AND status=\'active\'', [product_id]);
    const prod = pRes.rows[0];
    if (!prod) return res.status(404).json({ error: 'Producto no encontrado o inactivo' });

    const iRes = await query(
      `INSERT INTO order_items (order_id, product_id, quantity, unit_price, unit_cost, notes, status)
       VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING *`,
      [req.params.id, product_id, quantity, prod.price, prod.cost, notes||null]
    );
    res.status(201).json(iRes.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al agregar ítem' });
  }
});

// PATCH /api/orders/:id/items/:itemId — cancelar o reactivar ítem
router.patch('/:id/items/:itemId', auth, requireRole('waiter','boss'), async (req, res) => {
  const { status } = req.body;
  if (!['active','cancelled'].includes(status))
    return res.status(400).json({ error: 'Estado inválido. Usa "active" o "cancelled"' });
  try {
    const r = await query(
      'UPDATE order_items SET status=$1 WHERE id=$2 AND order_id=$3 RETURNING *',
      [status, req.params.itemId, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Ítem no encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar ítem' });
  }
});

// PATCH /api/orders/:id/request-payment — mesero solicita cobro
router.patch('/:id/request-payment', auth, requireRole('waiter','boss'), async (req, res) => {
  try {
    const oRes = await query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (order.status !== 'active') return res.status(409).json({ error: 'El pedido no está activo' });
    if (req.user.role !== 'boss' && order.waiter_id !== req.user.id)
      return res.status(403).json({ error: 'No tienes permiso' });

    const client = await require('../db/pool').pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE orders SET status=\'pending\' WHERE id=$1', [order.id]);
      await client.query('UPDATE tables SET status=\'pending\' WHERE id=$1', [order.table_id]);
      await client.query('COMMIT');
      res.json({ message: 'Pedido enviado a cobro', order_id: order.id });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: 'Error al solicitar cobro' });
  }
});

// PATCH /api/orders/:id/pay — SOLO JEFE confirma el pago
router.patch('/:id/pay', auth, requireRole('boss'), async (req, res) => {
  const { pay_method } = req.body;
  if (!pay_method) return res.status(400).json({ error: 'pay_method requerido' });
  try {
    const oRes = await query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });
    if (order.status !== 'pending') return res.status(409).json({ error: 'El pedido no está pendiente de pago' });

    // Calcular total y costo
    const totRes = await query(`
      SELECT COALESCE(SUM(quantity * unit_price),0) AS total,
             COALESCE(SUM(quantity * unit_cost),0)  AS cost
      FROM order_items WHERE order_id=$1 AND status='active'`, [order.id]);
    const total  = parseInt(totRes.rows[0].total);
    const cost   = parseInt(totRes.rows[0].cost);
    const profit = total - cost;

    const client = await require('../db/pool').pool.connect();
    try {
      await client.query('BEGIN');
      // Marcar pedido como pagado
      await client.query(
        `UPDATE orders SET status='paid', pay_method=$1, total_paid=$2, paid_at=NOW() WHERE id=$3`,
        [pay_method, total, order.id]
      );
      // Liberar mesa
      await client.query('UPDATE tables SET status=\'free\' WHERE id=$1', [order.table_id]);
      // Registrar transacción de ingreso
      if (order.day_id) {
        await client.query(
          `INSERT INTO transactions (day_id, order_id, type, amount, cost, profit, method, description)
           VALUES ($1,$2,'income',$3,$4,$5,$6,$7)`,
          [order.day_id, order.id, total, cost, profit, pay_method,
           `Pedido #${order.id}`]
        );
      }
      await client.query('COMMIT');
      res.json({ message: 'Pago confirmado y mesa liberada', total, profit });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: 'Error al confirmar pago' });
  }
});

// PATCH /api/orders/:id/move — SOLO JEFE cambia la mesa de un pedido
router.patch('/:id/move', auth, requireRole('boss'), async (req, res) => {
  const { new_table_id } = req.body;
  if (!new_table_id) return res.status(400).json({ error: 'new_table_id requerido' });
  try {
    const oRes = await query('SELECT * FROM orders WHERE id=$1', [req.params.id]);
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({ error: 'Pedido no encontrado' });

    const ntRes = await query('SELECT * FROM tables WHERE id=$1', [new_table_id]);
    const newTable = ntRes.rows[0];
    if (!newTable) return res.status(404).json({ error: 'Mesa destino no encontrada' });
    if (newTable.status !== 'free') return res.status(409).json({ error: 'La mesa destino no está libre' });

    const client = await require('../db/pool').pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE tables SET status=\'free\' WHERE id=$1', [order.table_id]);
      await client.query('UPDATE tables SET status=$1 WHERE id=$2', [order.status === 'pending' ? 'pending' : 'occupied', new_table_id]);
      await client.query('UPDATE orders SET table_id=$1 WHERE id=$2', [new_table_id, order.id]);
      await client.query('COMMIT');
      res.json({ message: `Pedido movido a mesa ${newTable.number} piso ${newTable.floor}` });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (err) {
    res.status(500).json({ error: 'Error al mover pedido' });
  }
});

module.exports = router;
