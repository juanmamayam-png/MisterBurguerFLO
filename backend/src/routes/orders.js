// src/routes/orders.js — Con validaciones y reglas de negocio completas
'use strict';
const router = require('express').Router();
const { query, pool }       = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');
const { validators, validId } = require('../middleware/validate');

async function getOrderWithItems(orderId) {
  const id = parseInt(orderId);
  if (!id || id < 1) return null;
  const [oRes, iRes] = await Promise.all([
    query(`SELECT o.*, t.number AS table_number, t.floor AS table_floor, u.name AS waiter_name
           FROM orders o JOIN tables t ON t.id=o.table_id JOIN users u ON u.id=o.waiter_id
           WHERE o.id=$1`, [id]),
    query(`SELECT oi.*, p.name AS product_name, p.emoji, p.category, p.image
           FROM order_items oi JOIN products p ON p.id=oi.product_id
           WHERE oi.order_id=$1 ORDER BY oi.id ASC`, [id]),
  ]);
  if (!oRes.rows[0]) return null;
  return { ...oRes.rows[0], items: iRes.rows };
}

async function rollbackRes(client, res, status, message) {
  await client.query('ROLLBACK').catch(()=>{});
  client.release();
  return res.status(status).json({ error: message });
}

// GET /api/orders
router.get('/', auth, async (req, res) => {
  try {
    const { status, day_id } = req.query;
    const ALLOWED = ['active','pending','paid'];
    if (status && !ALLOWED.includes(status)) return res.status(400).json({ error: 'status inválido' });
    if (day_id && (isNaN(day_id) || parseInt(day_id)<1)) return res.status(400).json({ error: 'day_id inválido' });
    let sql = `SELECT o.*, t.number AS table_number, t.floor AS table_floor, t.table_type, u.name AS waiter_name,
               COALESCE(SUM(CASE WHEN oi.status='active' THEN oi.quantity*oi.unit_price ELSE 0 END),0) AS total
               FROM orders o JOIN tables t ON t.id=o.table_id JOIN users u ON u.id=o.waiter_id
               LEFT JOIN order_items oi ON oi.order_id=o.id WHERE 1=1`;
    const p = [];
    if (status) sql += ` AND o.status=$${p.push(status)}`;
    if (day_id) sql += ` AND o.day_id=$${p.push(parseInt(day_id))}`;
    if (req.user.role==='waiter') sql += ` AND o.waiter_id=$${p.push(req.user.id)}`;
    sql += ' GROUP BY o.id,t.number,t.floor,t.table_type,u.name,o.employee_name ORDER BY o.created_at DESC LIMIT 500';
    res.json((await query(sql,p)).rows);
  } catch(err){ console.error('[Orders GET /]',err.message); res.status(500).json({error:'Error al obtener pedidos'}); }
});

// GET /api/orders/kitchen
router.get('/kitchen', auth, requireRole('kitchen','boss'), async (req,res) => {
  try {
    const r = await query(`
      SELECT o.id, o.status, o.created_at, o.employee_name,
             t.number AS table_number, t.floor AS table_floor, t.table_type,
        COALESCE(json_agg(json_build_object(
          'id',oi.id,'product_id',oi.product_id,'product_name',p.name,'emoji',p.emoji,
          'category',p.category,'image',p.image,'quantity',oi.quantity,'notes',oi.notes,
          'bread_type',oi.bread_type,'status',oi.status
        ) ORDER BY oi.id) FILTER (WHERE oi.id IS NOT NULL), '[]') AS items
      FROM orders o JOIN tables t ON t.id=o.table_id
      LEFT JOIN order_items oi ON oi.order_id=o.id AND oi.status='active'
      LEFT JOIN products p ON p.id=oi.product_id
      WHERE o.status IN ('active','pending') GROUP BY o.id,t.number,t.floor,t.table_type,o.employee_name ORDER BY o.created_at ASC`);
    res.json(r.rows);
  } catch(err){ console.error('[Orders GET /kitchen]',err.message); res.status(500).json({error:'Error cocina'}); }
});

// GET /api/orders/:id
router.get('/:id', auth, validId, async (req,res) => {
  try {
    const order = await getOrderWithItems(req.params.id);
    if (!order) return res.status(404).json({error:'Pedido no encontrado'});
    if (req.user.role==='waiter' && order.waiter_id!==req.user.id)
      return res.status(403).json({error:'No tienes acceso a este pedido'});
    res.json(order);
  } catch(err){ console.error('[Orders GET /:id]',err.message); res.status(500).json({error:'Error al obtener pedido'}); }
});

// POST /api/orders — crear pedido
router.post('/', auth, requireRole('waiter','boss'), validators.createOrder, async (req,res) => {
  const table_id     = parseInt(req.body.table_id);
  const employee_name = (req.body.employee_name || '').trim().slice(0,100) || null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tRes = await client.query('SELECT * FROM tables WHERE id=$1 FOR UPDATE',[table_id]);
    const table = tRes.rows[0];
    if (!table) return await rollbackRes(client,res,404,'Mesa no encontrada');
    if (table.status!=='free') return await rollbackRes(client,res,409,`La mesa ${table.number} (Piso ${table.floor}) no está libre`);
    const dup = await client.query(`SELECT id FROM orders WHERE table_id=$1 AND status IN ('active','pending') LIMIT 1`,[table_id]);
    if (dup.rows.length>0) return await rollbackRes(client,res,409,'Ya existe un pedido activo en esta mesa');

    // Verificar que el local esté abierto (excepto para jefe y mesa cena empleados)
    const dRes = await client.query(`SELECT id FROM work_days WHERE status='open' ORDER BY id DESC LIMIT 1`);
    const day_id = dRes.rows[0]?.id || null;
    if (!day_id && req.user.role !== 'boss') {
      return await rollbackRes(client,res,409,'El local está cerrado. No se pueden tomar pedidos.');
    }

    // Mesa CENA EMPLEADOS requiere nombre del empleado
    if (table.table_type === 'cena_empleados' && !employee_name) {
      return await rollbackRes(client,res,400,'Debes ingresar tu nombre para la Cena de Empleados.');
    }

    const oRes = await client.query(
      `INSERT INTO orders (table_id,waiter_id,day_id,status,employee_name)
       VALUES ($1,$2,$3,'active',$4) RETURNING *`,
      [table_id, req.user.id, day_id, employee_name]);
    await client.query(`UPDATE tables SET status='occupied' WHERE id=$1`,[table_id]);
    await client.query('COMMIT');
    res.status(201).json(oRes.rows[0]);
  } catch(err){
    await client.query('ROLLBACK').catch(()=>{});
    console.error('[Orders POST /]',err.message);
    res.status(500).json({error:'Error al crear pedido'});
  } finally { client.release(); }
});

// POST /api/orders/:id/items — agregar ítem (soporta bread_type y recargo plátano)
router.post('/:id/items', auth, requireRole('waiter','boss'), validId, validators.addItem, async (req,res) => {
  const order_id   = parseInt(req.params.id);
  const product_id = parseInt(req.body.product_id);
  const quantity   = parseInt(req.body.quantity);
  const notes      = req.body.notes || null;
  const bread_type = req.body.bread_type || null; // 'pan' | 'platano' | null

  // Validar bread_type
  if (bread_type && !['pan','platano'].includes(bread_type))
    return res.status(400).json({error:'bread_type debe ser "pan" o "platano"'});

  try {
    const oRes = await query('SELECT * FROM orders WHERE id=$1',[order_id]);
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({error:'Pedido no encontrado'});
    if (order.status!=='active') return res.status(409).json({error:'No se pueden agregar ítems: el pedido no está activo'});
    if (req.user.role!=='boss' && order.waiter_id!==req.user.id) return res.status(403).json({error:'Solo puedes modificar tus propios pedidos'});
    const pRes = await query(`SELECT id,price,cost,name,category FROM products WHERE id=$1 AND status='active'`,[product_id]);
    const prod = pRes.rows[0];
    if (!prod) return res.status(404).json({error:'Producto no encontrado o no disponible'});
    if (prod.price<=0) return res.status(409).json({error:`El producto "${prod.name}" no tiene precio válido`});

    // Recargo de $1.000 si es plátano (solo en categorías que aplican)
    const BURGER_CATS = ['Hamburguesas','Especiales','Hot Dog'];
    const platanoExtra = (bread_type === 'platano' && BURGER_CATS.includes(prod.category)) ? 1000 : 0;
    const finalPrice   = prod.price + platanoExtra;

    const iRes = await query(
      `INSERT INTO order_items (order_id,product_id,quantity,unit_price,unit_cost,notes,bread_type,status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active') RETURNING *`,
      [order_id, product_id, quantity, finalPrice, prod.cost, notes, bread_type]);
    res.status(201).json({...iRes.rows[0], platano_extra: platanoExtra});
  } catch(err){ console.error('[Orders POST /:id/items]',err.message); res.status(500).json({error:'Error al agregar ítem'}); }
});

// PATCH /api/orders/:id/items/:itemId — cancelar/reactivar ítem
router.patch('/:id/items/:itemId', auth, requireRole('waiter','boss'), validators.updateItemStatus, async (req,res) => {
  const order_id = parseInt(req.params.id);
  const item_id  = parseInt(req.params.itemId);
  const status   = req.body.status;
  if (!order_id||order_id<1||!item_id||item_id<1) return res.status(400).json({error:'IDs inválidos'});
  try {
    const oRes = await query('SELECT * FROM orders WHERE id=$1',[order_id]);
    const order = oRes.rows[0];
    if (!order) return res.status(404).json({error:'Pedido no encontrado'});
    if (order.status!=='active') return res.status(409).json({error:'No se pueden modificar ítems de un pedido en cobro o pagado'});
    if (req.user.role!=='boss' && order.waiter_id!==req.user.id) return res.status(403).json({error:'Solo puedes modificar tus propios pedidos'});
    const r = await query(`UPDATE order_items SET status=$1 WHERE id=$2 AND order_id=$3 RETURNING *`,[status,item_id,order_id]);
    if (!r.rows[0]) return res.status(404).json({error:'Ítem no encontrado en este pedido'});
    res.json(r.rows[0]);
  } catch(err){ console.error('[Orders PATCH items]',err.message); res.status(500).json({error:'Error al actualizar ítem'}); }
});

// PATCH /api/orders/:id/request-payment
router.patch('/:id/request-payment', auth, requireRole('waiter','boss'), validId, async (req,res) => {
  const order_id = parseInt(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oRes = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[order_id]);
    const order = oRes.rows[0];
    if (!order) return await rollbackRes(client,res,404,'Pedido no encontrado');
    if (order.status!=='active') return await rollbackRes(client,res,409,'El pedido ya no está activo');
    if (req.user.role!=='boss' && order.waiter_id!==req.user.id) return await rollbackRes(client,res,403,'Solo puedes cobrar tus propios pedidos');
    const itemRes = await client.query(`SELECT COUNT(*) FROM order_items WHERE order_id=$1 AND status='active'`,[order_id]);
    if (parseInt(itemRes.rows[0].count)===0) return await rollbackRes(client,res,409,'No puedes solicitar cobro de un pedido sin ítems');
    const totRes = await client.query(`SELECT COALESCE(SUM(quantity*unit_price),0) AS total FROM order_items WHERE order_id=$1 AND status='active'`,[order_id]);
    const total = parseInt(totRes.rows[0].total);
    if (total<1000) return await rollbackRes(client,res,409,`El total ($${total.toLocaleString('es-CO')}) es menor al mínimo permitido ($1.000)`);
    await client.query(`UPDATE orders SET status='pending' WHERE id=$1`,[order_id]);
    await client.query(`UPDATE tables SET status='pending' WHERE id=$1`,[order.table_id]);
    await client.query('COMMIT');
    res.json({message:'Pedido enviado a cobro',order_id,total});
  } catch(err){
    await client.query('ROLLBACK').catch(()=>{});
    console.error('[Orders PATCH /request-payment]',err.message);
    res.status(500).json({error:'Error al solicitar cobro'});
  } finally { client.release(); }
});

// PATCH /api/orders/:id/pay — SOLO JEFE
router.patch('/:id/pay', auth, requireRole('boss'), validId, validators.confirmPayment, async (req,res) => {
  const order_id   = parseInt(req.params.id);
  const pay_method = req.body.pay_method;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oRes = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[order_id]);
    const order = oRes.rows[0];
    if (!order) return await rollbackRes(client,res,404,'Pedido no encontrado');
    if (order.status!=='pending') return await rollbackRes(client,res,409,'El pedido no está en estado de cobro pendiente');
    // Calcular desde DB — nunca confiar en el frontend
    const totRes = await client.query(
      `SELECT COALESCE(SUM(quantity*unit_price),0) AS total, COALESCE(SUM(quantity*unit_cost),0) AS cost
       FROM order_items WHERE order_id=$1 AND status='active'`,[order_id]);
    const total  = parseInt(totRes.rows[0].total);
    const cost   = parseInt(totRes.rows[0].cost);
    const profit = total - cost;
    if (total<=0) return await rollbackRes(client,res,409,'El pedido no tiene ítems activos para cobrar');
    // No aplicar mínimo para cena de empleados
    const tableTypeRes2 = await client.query('SELECT table_type FROM tables WHERE id=(SELECT table_id FROM orders WHERE id=$1)',[order_id]);
    const isEmp = tableTypeRes2.rows[0]?.table_type === 'cena_empleados';
    if (!isEmp && total<1000) return await rollbackRes(client,res,409,`El total ($${total.toLocaleString('es-CO')}) es menor al mínimo permitido`);
    await client.query(`UPDATE orders SET status='paid',pay_method=$1,total_paid=$2,paid_at=NOW() WHERE id=$3`,[pay_method,total,order_id]);
    // Liberar mesa de forma segura (puede ya estar libre si hubo un error previo)
    await client.query(`UPDATE tables SET status='free' WHERE id=$1`,[order.table_id]);
    if (order.day_id) {
      // Cena Empleados: gasto de la empresa (expense), no ingreso
      const tableRes = await client.query('SELECT table_type FROM tables WHERE id=$1',[order.table_id]);
      const isCena   = tableRes.rows[0]?.table_type === 'cena_empleados';
      if (isCena) {
        // Registrar como GASTO — resta de la ganancia
        await client.query(
          `INSERT INTO transactions (day_id,order_id,type,amount,cost,profit,method,description)
           VALUES ($1,$2,'expense',$3,0,0,'cena_empleados',$4)`,
          [order.day_id, order_id, total,
           `Cena empleado${order.employee_name?' — '+order.employee_name:''}`]);
      } else {
        await client.query(
          `INSERT INTO transactions (day_id,order_id,type,amount,cost,profit,method,description)
           VALUES ($1,$2,'income',$3,$4,$5,$6,$7)`,
          [order.day_id,order_id,total,cost,profit,pay_method,`Pedido #${order_id}`]);
      }
    }
    await client.query('COMMIT');
    res.json({message:'Pago confirmado y mesa liberada',total,cost,profit,pay_method});
  } catch(err){
    await client.query('ROLLBACK').catch(()=>{});
    console.error('[Orders PATCH /pay]',err.message);
    res.status(500).json({error:'Error al confirmar pago'});
  } finally { client.release(); }
});

// PATCH /api/orders/:id/move — SOLO JEFE
router.patch('/:id/move', auth, requireRole('boss'), validId, validators.moveOrder, async (req,res) => {
  const order_id     = parseInt(req.params.id);
  const new_table_id = parseInt(req.body.new_table_id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oRes = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[order_id]);
    const order = oRes.rows[0];
    if (!order) return await rollbackRes(client,res,404,'Pedido no encontrado');
    if (order.status==='paid') return await rollbackRes(client,res,409,'No se puede mover un pedido ya pagado');
    if (order.table_id===new_table_id) return await rollbackRes(client,res,409,'El pedido ya está en esa mesa');
    const ntRes = await client.query('SELECT * FROM tables WHERE id=$1 FOR UPDATE',[new_table_id]);
    const newTable = ntRes.rows[0];
    if (!newTable) return await rollbackRes(client,res,404,'Mesa destino no encontrada');
    if (newTable.status!=='free') return await rollbackRes(client,res,409,`La mesa ${newTable.number} (Piso ${newTable.floor}) no está libre`);
    await client.query(`UPDATE tables SET status='free' WHERE id=$1`,[order.table_id]);
    await client.query(`UPDATE tables SET status=$1 WHERE id=$2`,[order.status==='pending'?'pending':'occupied',new_table_id]);
    await client.query(`UPDATE orders SET table_id=$1 WHERE id=$2`,[new_table_id,order_id]);
    await client.query('COMMIT');
    res.json({message:`Pedido movido a mesa ${newTable.number} (Piso ${newTable.floor})`});
  } catch(err){
    await client.query('ROLLBACK').catch(()=>{});
    console.error('[Orders PATCH /move]',err.message);
    res.status(500).json({error:'Error al mover pedido'});
  } finally { client.release(); }
});


// PATCH /api/orders/:id/cancel — SOLO JEFE: cancela y libera mesa sin importar estado
router.patch('/:id/cancel', auth, requireRole('boss'), validId, async (req,res) => {
  const order_id = parseInt(req.params.id);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oRes = await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[order_id]);
    const order = oRes.rows[0];
    if (!order) return await rollbackRes(client,res,404,'Pedido no encontrado');
    if (order.status==='paid') return await rollbackRes(client,res,409,'No se puede cancelar un pedido ya pagado');

    // Cancelar todos los ítems activos
    await client.query(`UPDATE order_items SET status='cancelled' WHERE order_id=$1 AND status='active'`,[order_id]);
    // Marcar pedido como cancelado (usamos paid con total 0 para no romper FK, o mejor: eliminarlo)
    // Mejor: eliminamos el pedido y liberamos la mesa
    await client.query(`DELETE FROM orders WHERE id=$1`,[order_id]);
    // Liberar la mesa
    await client.query(`UPDATE tables SET status='free' WHERE id=$1`,[order.table_id]);
    await client.query('COMMIT');
    res.json({message:'Pedido cancelado y mesa liberada'});
  } catch(err){
    await client.query('ROLLBACK').catch(()=>{});
    console.error('[Orders PATCH /cancel]',err.message);
    res.status(500).json({error:'Error al cancelar pedido'});
  } finally { client.release(); }
});

module.exports = router;
