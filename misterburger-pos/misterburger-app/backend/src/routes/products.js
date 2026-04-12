// src/routes/products.js — CRUD de productos
const router = require('express').Router();
const { query }        = require('../db/pool');
const { auth, requireRole } = require('../middleware/auth');

// GET /api/products — todos (público para el menú)
router.get('/', async (req, res) => {
  try {
    const { status, category } = req.query;
    let sql = 'SELECT * FROM products WHERE 1=1';
    const params = [];
    if (status)   { sql += ` AND status=$${params.push(status)}`; }
    if (category) { sql += ` AND category=$${params.push(category)}`; }
    sql += ' ORDER BY category, name';
    const r = await query(sql, params);
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener productos' });
  }
});

// GET /api/products/:id
router.get('/:id', async (req, res) => {
  try {
    const r = await query('SELECT * FROM products WHERE id=$1', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener producto' });
  }
});

// POST /api/products — crear (solo boss)
router.post('/', auth, requireRole('boss'), async (req, res) => {
  const { name, description, emoji, image, category, price, cost, status } = req.body;
  if (!name || !category || !price)
    return res.status(400).json({ error: 'name, category y price son requeridos' });
  try {
    const r = await query(
      `INSERT INTO products (name, description, emoji, image, category, price, cost, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [name, description||'', emoji||'🍔', image||null, category, price, cost||0, status||'active']
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al crear producto' });
  }
});

// PUT /api/products/:id — editar (solo boss)
router.put('/:id', auth, requireRole('boss'), async (req, res) => {
  const { name, description, emoji, image, category, price, cost, status } = req.body;
  try {
    const r = await query(
      `UPDATE products SET
        name=$1, description=$2, emoji=$3, image=$4,
        category=$5, price=$6, cost=$7, status=$8
       WHERE id=$9 RETURNING *`,
      [name, description, emoji, image, category, price, cost, status, req.params.id]
    );
    if (!r.rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar producto' });
  }
});

// DELETE /api/products/:id — eliminar (solo boss)
router.delete('/:id', auth, requireRole('boss'), async (req, res) => {
  try {
    const r = await query('DELETE FROM products WHERE id=$1 RETURNING id', [req.params.id]);
    if (!r.rows[0]) return res.status(404).json({ error: 'Producto no encontrado' });
    res.json({ message: 'Producto eliminado', id: r.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Error al eliminar producto' });
  }
});

module.exports = router;
