// src/middleware/validate.js
// Validaciones centralizadas para todos los endpoints

// ── Helpers ──────────────────────────────────────────────────────
const VALID_ROLES      = ['boss', 'waiter', 'kitchen'];
const VALID_STATUSES   = ['active', 'inactive'];
const VALID_PAY_METHODS= ['efectivo', 'nequi', 'bancolombia', 'tarjeta'];
const VALID_CATEGORIES = ['Hamburguesas', 'Especiales', 'Hot Dog', 'Bebidas', 'Infantil', 'Entradas'];
const VALID_TABLE_ST   = ['free', 'occupied', 'pending'];
const VALID_ITEM_ST    = ['active', 'cancelled'];

function isInt(v)      { return Number.isInteger(Number(v)) && !isNaN(v); }
function isPositive(v) { return isInt(v) && Number(v) > 0; }
function isSafeStr(v)  { return typeof v === 'string' && v.trim().length > 0 && v.length < 500; }
function isBase64Img(v){ return !v || (typeof v === 'string' && (v.startsWith('data:image') || v === '')); }

// Sanitize string: trim + strip HTML tags
function clean(s) {
  if (typeof s !== 'string') return s;
  return s.trim().replace(/<[^>]*>/g, '').substring(0, 2000);
}

// ── Validation factory ────────────────────────────────────────────
function validate(rules) {
  return (req, res, next) => {
    const errors = [];

    for (const [field, checks] of Object.entries(rules)) {
      const value = req.body[field] ?? req.params[field] ?? req.query[field];

      for (const [rule, arg] of Object.entries(checks)) {
        switch (rule) {

          case 'required':
            if (arg && (value === undefined || value === null || value === ''))
              errors.push(`${field} es requerido`);
            break;

          case 'string':
            if (value !== undefined && value !== null && typeof value !== 'string')
              errors.push(`${field} debe ser texto`);
            break;

          case 'minLength':
            if (value !== undefined && String(value).trim().length < arg)
              errors.push(`${field} debe tener al menos ${arg} caracteres`);
            break;

          case 'maxLength':
            if (value !== undefined && String(value).length > arg)
              errors.push(`${field} no puede superar ${arg} caracteres`);
            break;

          case 'integer':
            if (value !== undefined && value !== null && !isInt(value))
              errors.push(`${field} debe ser un número entero`);
            break;

          case 'positive':
            if (value !== undefined && value !== null && !isPositive(value))
              errors.push(`${field} debe ser un número mayor a 0`);
            break;

          case 'min':
            if (value !== undefined && value !== null && Number(value) < arg)
              errors.push(`${field} debe ser al menos ${arg}`);
            break;

          case 'max':
            if (value !== undefined && value !== null && Number(value) > arg)
              errors.push(`${field} no puede superar ${arg}`);
            break;

          case 'oneOf':
            if (value !== undefined && value !== null && value !== '' && !arg.includes(value))
              errors.push(`${field} debe ser uno de: ${arg.join(', ')}`);
            break;

          case 'base64img':
            if (value && !isBase64Img(value))
              errors.push(`${field} debe ser una imagen en formato base64 válido`);
            break;

          case 'noScript':
            if (value && typeof value === 'string' &&
                (/<script/i.test(value) || /javascript:/i.test(value)))
              errors.push(`${field} contiene contenido no permitido`);
            break;
        }
      }
    }

    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    // Sanitize all string fields in body
    for (const key of Object.keys(req.body)) {
      if (typeof req.body[key] === 'string' && key !== 'image' && key !== 'password') {
        req.body[key] = clean(req.body[key]);
      }
    }

    next();
  };
}

// ── ID param validator ────────────────────────────────────────────
function validId(req, res, next) {
  const id = req.params.id || req.params.itemId;
  if (!id || !isPositive(id)) {
    return res.status(400).json({ error: 'ID inválido' });
  }
  next();
}

// ── Pre-built validators ──────────────────────────────────────────
const validators = {

  login: validate({
    username: { required: true, string: true, minLength: 2, maxLength: 60, noScript: true },
    password: { required: true, string: true, minLength: 1, maxLength: 200 },
  }),

  createProduct: validate({
    name:        { required: true,  string: true, minLength: 2, maxLength: 100, noScript: true },
    category:    { required: true,  oneOf: VALID_CATEGORIES },
    price:       { required: true,  integer: true, positive: true, max: 500000 },
    cost:        { integer: true,   min: 0, max: 500000 },
    status:      { oneOf: VALID_STATUSES },
    description: { string: true,    maxLength: 1000, noScript: true },
    emoji:       { string: true,    maxLength: 10 },
    image:       { base64img: true },
  }),

  updateProduct: validate({
    name:        { required: true,  string: true, minLength: 2, maxLength: 100, noScript: true },
    category:    { required: true,  oneOf: VALID_CATEGORIES },
    price:       { required: true,  integer: true, positive: true, max: 500000 },
    cost:        { integer: true,   min: 0, max: 500000 },
    status:      { required: true,  oneOf: VALID_STATUSES },
    description: { string: true,    maxLength: 1000, noScript: true },
  }),

  createOrder: validate({
    table_id: { required: true, integer: true, positive: true },
  }),

  addItem: validate({
    product_id: { required: true, integer: true, positive: true },
    quantity:   { required: true, integer: true, positive: true, max: 99 },
    notes:      { string: true, maxLength: 300, noScript: true },
    bread_type: { oneOf: ['pan','platano'] },
  }),

  updateItemStatus: validate({
    status: { required: true, oneOf: VALID_ITEM_ST },
  }),

  requestPayment: validate({}), // no body needed, all validation in route

  confirmPayment: validate({
    pay_method: { required: true, oneOf: VALID_PAY_METHODS },
  }),

  moveOrder: validate({
    new_table_id: { required: true, integer: true, positive: true },
  }),

  updateTableStatus: validate({
    status: { required: true, oneOf: VALID_TABLE_ST },
  }),

  openDay: validate({
    open_notes: { string: true, maxLength: 500, noScript: true },
  }),

  closeDay: validate({
    close_notes: { string: true, maxLength: 500, noScript: true },
  }),

  createUser: validate({
    username: { required: true, string: true, minLength: 3, maxLength: 60, noScript: true },
    password: { required: true, string: true, minLength: 4, maxLength: 200 },
    role:     { required: true, oneOf: VALID_ROLES },
    name:     { required: true, string: true, minLength: 2, maxLength: 100, noScript: true },
  }),

  changePassword: validate({
    password: { required: true, string: true, minLength: 4, maxLength: 200 },
  }),

};

module.exports = { validate, validId, validators, clean,
  VALID_ROLES, VALID_PAY_METHODS, VALID_CATEGORIES };
