/* ═══════════════════════════════════════════════
   api.js — Cliente HTTP para el backend
   Reemplaza la capa localStorage del app.js
   Todas las funciones retornan Promesas
═══════════════════════════════════════════════ */

const API_BASE = '/api'; // mismo origen → Railway sirve front y back juntos

// ── Token JWT ─────────────────────────────────────────────────────
const TokenStore = {
  get()        { return sessionStorage.getItem('mb_jwt') || localStorage.getItem('mb_jwt'); },
  set(t, remember) {
    sessionStorage.setItem('mb_jwt', t);
    if (remember) localStorage.setItem('mb_jwt', t);
  },
  clear()      { sessionStorage.removeItem('mb_jwt'); localStorage.removeItem('mb_jwt'); },
};

// ── Fetch helper ──────────────────────────────────────────────────
async function apiFetch(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = TokenStore.get();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, opts);

  if (res.status === 401) {
    TokenStore.clear();
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new Error('Sesión expirada');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

const get    = (path)        => apiFetch('GET',    path);
const post   = (path, body)  => apiFetch('POST',   path, body);
const put    = (path, body)  => apiFetch('PUT',    path, body);
const patch  = (path, body)  => apiFetch('PATCH',  path, body);
const del    = (path)        => apiFetch('DELETE', path);

// ── API pública ───────────────────────────────────────────────────
const API = {

  // AUTH
  async login(username, password, remember = false) {
    const data = await post('/auth/login', { username, password });
    TokenStore.set(data.token, remember);
    return data.user;
  },
  logout() { TokenStore.clear(); },
  async me() { return get('/auth/me'); },

  // PRODUCTS
  getProducts(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return get('/products' + (qs ? '?' + qs : ''));
  },
  createProduct(data)    { return post('/products', data); },
  updateProduct(id, data){ return put(`/products/${id}`, data); },
  deleteProduct(id)      { return del(`/products/${id}`); },

  // TABLES
  getTables() { return get('/tables'); },
  setTableStatus(id, status) { return patch(`/tables/${id}/status`, { status }); },

  // ORDERS
  getOrders(params = {}) {
    const qs = new URLSearchParams(params).toString();
    return get('/orders' + (qs ? '?' + qs : ''));
  },
  getOrder(id)          { return get(`/orders/${id}`); },
  createOrder(table_id) { return post('/orders', { table_id }); },
  addItem(orderId, data){ return post(`/orders/${orderId}/items`, data); },
  updateItem(orderId, itemId, status) {
    return patch(`/orders/${orderId}/items/${itemId}`, { status });
  },
  requestPayment(orderId) { return patch(`/orders/${orderId}/request-payment`); },
  confirmPayment(orderId, pay_method) {
    return patch(`/orders/${orderId}/pay`, { pay_method });
  },
  moveOrder(orderId, new_table_id) {
    return patch(`/orders/${orderId}/move`, { new_table_id });
  },
  getKitchenOrders() { return get('/orders/kitchen'); },

  // WORK DAYS
  getDays()    { return get('/days'); },
  getCurrentDay() { return get('/days/current'); },
  openDay(investments, open_notes) { return post('/days', { investments, open_notes }); },
  closeDay(id, close_notes) { return patch(`/days/${id}/close`, { close_notes }); },

  // USERS
  getUsers()    { return get('/users'); },
  createUser(data) { return post('/users', data); },
  changePassword(id, password) { return patch(`/users/${id}/password`, { password }); },
  toggleUser(id)   { return patch(`/users/${id}/toggle`); },
};

// ── Estado en memoria (reemplaza S.* del app.js) ──────────────────
const State = {
  user:           null,
  tables:         [],
  products:       [],
  currentDay:     null,
  selectedTable:  null,
  activeOrder:    null,
  floor:          1,
  kitchTimer:     null,
  kitchTab:       'food',
  // Cache de pedido activo con sus ítems
  orderCache:     {},  // { [orderId]: { ...order, items: [] } }
};

// Invalidar caché de un pedido
function invalidateOrder(orderId) {
  delete State.orderCache[orderId];
}

// ── Helpers de formato ────────────────────────────────────────────
function fmtCOP(n) { return '$' + Number(n || 0).toLocaleString('es-CO'); }
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-CO', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}
function elapsed(iso) {
  return Math.floor((Date.now() - new Date(iso)) / 60000);
}
function elapsedStr(iso) {
  const m = elapsed(iso);
  return m < 60 ? `${m}m` : `${Math.floor(m/60)}h ${m%60}m`;
}
function timerClass(iso) {
  const m = elapsed(iso);
  if (m < 10) return 'ok';
  if (m < 20) return 'warn';
  return 'late';
}
function orderTotal(items = []) {
  return items.filter(i => i.status === 'active').reduce((s, i) => s + i.quantity * i.unit_price, 0);
}
function orderCost(items = []) {
  return items.filter(i => i.status === 'active').reduce((s, i) => s + i.quantity * i.unit_cost, 0);
}
function getCatClass(c) {
  return { Hamburguesas:'cc-hamburguesas', Especiales:'cc-especiales', 'Hot Dog':'cc-hot-dog',
           Bebidas:'cc-bebidas', Infantil:'cc-infantil', Entradas:'cc-entradas' }[c] || 'cc-entradas';
}
const DRINK_CATS = ['Bebidas'];
function isBev(cat) { return DRINK_CATS.includes(cat); }
