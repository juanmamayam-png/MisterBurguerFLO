/* ═══════════════════════════════════════════════════════════════
   api.js — Cliente HTTP + Sistema anti-apagón completo
   
   Estrategia ante corte de luz / internet:
   1. Token JWT guardado en localStorage (sobrevive recargas)
   2. Cache de tablas, productos, jornada y usuario en localStorage
   3. Cola offline: todas las operaciones POST/PATCH se encolan
      y se ejecutan automáticamente al reconectar
   4. Auto-reintento: si la petición falla por red se reintenta
   5. Indicador visual rojo cuando no hay conexión
   6. Al recuperar conexión: sincroniza cola + refresca pantalla
   7. Heartbeat: ping cada 15s para detectar reconexión
═══════════════════════════════════════════════════════════════ */

const API_BASE = '/api';

/* ── Token JWT ──────────────────────────────────────────────── */
const TokenStore = {
  get()   { return localStorage.getItem('mb_jwt'); },
  set(t)  { localStorage.setItem('mb_jwt', t); },
  clear() { localStorage.removeItem('mb_jwt'); },
};

/* ── Cache local ────────────────────────────────────────────── */
const Cache = {
  K: {
    tables:  'mb_tables',
    products:'mb_products',
    day:     'mb_day',
    user:    'mb_user',
    queue:   'mb_queue',
    orders:  'mb_orders_cache',
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify({ v, t: Date.now() })); } catch(e) {}
  },
  get(k, maxMs = 86400000) {
    try {
      const r = localStorage.getItem(k);
      if (!r) return null;
      const { v, t } = JSON.parse(r);
      return (Date.now() - t > maxMs) ? null : v;
    } catch { return null; }
  },
  del(k) { try { localStorage.removeItem(k); } catch(e) {} },

  // Guardar pedido individual con sus ítems
  setOrder(id, order) {
    try {
      const all = JSON.parse(localStorage.getItem(Cache.K.orders) || '{}');
      all[id] = { order, t: Date.now() };
      localStorage.setItem(Cache.K.orders, JSON.stringify(all));
    } catch(e) {}
  },
  getOrder(id) {
    try {
      const all = JSON.parse(localStorage.getItem(Cache.K.orders) || '{}');
      const entry = all[id];
      if (!entry) return null;
      if (Date.now() - entry.t > 3600000) return null; // 1h max
      return entry.order;
    } catch { return null; }
  },
  delOrder(id) {
    try {
      const all = JSON.parse(localStorage.getItem(Cache.K.orders) || '{}');
      delete all[id];
      localStorage.setItem(Cache.K.orders, JSON.stringify(all));
    } catch(e) {}
  },
};

/* ── Cola offline ───────────────────────────────────────────── */
const Queue = {
  _q: [],

  load() {
    try { this._q = JSON.parse(localStorage.getItem(Cache.K.queue) || '[]'); }
    catch { this._q = []; }
  },

  save() {
    try { localStorage.setItem(Cache.K.queue, JSON.stringify(this._q)); } catch(e) {}
  },

  push(op) {
    this._q.push({ ...op, qid: `q_${Date.now()}_${Math.random().toString(36).slice(2)}` });
    this.save();
    Net.renderBar();
  },

  remove(qid) {
    this._q = this._q.filter(o => o.qid !== qid);
    this.save();
    Net.renderBar();
  },

  clear() { this._q = []; this.save(); Net.renderBar(); },
  all()   { return [...this._q]; },
  size()  { return this._q.length; },
};

/* ── Estado de red ──────────────────────────────────────────── */
const Net = {
  online: navigator.onLine,
  _hb: null,   // heartbeat interval
  _bar: null,  // barra DOM

  init() {
    Queue.load();
    window.addEventListener('online',  () => this._goOnline());
    window.addEventListener('offline', () => this._goOffline());
    this.renderBar();
    this._startHeartbeat();
  },

  _startHeartbeat() {
    // Ping cada 15 segundos para detectar reconexión aunque el browser no lo detecte
    this._hb = setInterval(async () => {
      if (this.online) return;
      try {
        const r = await fetch('/health', { method: 'GET', cache: 'no-store' });
        if (r.ok) this._goOnline();
      } catch {}
    }, 15000);
  },

  _goOnline() {
    if (this.online) return;
    this.online = true;
    this.renderBar();
    toast('🌐 Conexión restaurada — sincronizando…', 'success');
    setTimeout(() => this._flush(), 1200);
  },

  _goOffline() {
    this.online = false;
    this.renderBar();
    toast('⚠️ Sin conexión — modo offline activo', 'warning');
  },

  renderBar() {
    if (!this._bar) {
      this._bar = document.createElement('div');
      this._bar.id = 'net-bar';
      this._bar.style.cssText =
        'position:fixed;bottom:0;left:0;right:0;z-index:9999;' +
        'padding:10px 18px;font-size:12px;font-weight:700;' +
        'display:flex;align-items:center;justify-content:space-between;' +
        'gap:10px;transition:all .3s ease;';
      document.body.appendChild(this._bar);
    }
    if (this.online && Queue.size() === 0) {
      this._bar.style.display = 'none';
      return;
    }
    this._bar.style.display = 'flex';
    if (!this.online) {
      this._bar.style.background = '#B71C1C';
      this._bar.style.color = '#fff';
      const n = Queue.size();
      this._bar.innerHTML =
        `<span><i class="fa-solid fa-wifi-slash" style="margin-right:8px"></i>` +
        `SIN CONEXIÓN — Modo Offline${n > 0 ? ` · ${n} operación(es) guardadas` : ''}</span>` +
        `<span style="font-size:11px;opacity:.8">Los datos NO se pierden</span>`;
    } else if (Queue.size() > 0) {
      this._bar.style.background = '#E65100';
      this._bar.style.color = '#fff';
      this._bar.innerHTML =
        `<span><i class="fa-solid fa-rotate" style="margin-right:8px"></i>` +
        `Sincronizando ${Queue.size()} operación(es)…</span>`;
    }
  },

  async _flush() {
    const ops = Queue.all();
    if (!ops.length) { this.renderBar(); return; }
    let ok = 0, fail = 0;
    for (const op of ops) {
      try {
        await apiFetch(op.method, op.path, op.body);
        Queue.remove(op.qid);
        ok++;
      } catch (err) {
        // Error de negocio (4xx): descartar (ya no es válido)
        if (err.status && err.status >= 400 && err.status < 500) {
          Queue.remove(op.qid);
        }
        fail++;
      }
    }
    this.renderBar();
    if (ok > 0)   toast(`✅ ${ok} operación(es) sincronizadas`, 'success');
    if (fail > 0) toast(`⚠️ ${fail} no se pudieron sincronizar`, 'warning');
    // Refrescar toda la UI
    window.dispatchEvent(new CustomEvent('mb:refresh'));
  },
};

/* ── Fetch con retry y cola offline ────────────────────────── */
async function apiFetch(method, path, body = null) {
  const headers = { 'Content-Type': 'application/json' };
  const token = TokenStore.get();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);

  // Sin conexión: encolar mutaciones, servir cache para lecturas
  if (!Net.online) {
    if (method !== 'GET') {
      Queue.push({ method, path, body });
      return _optimistic(path, body);
    }
    return _fromCache(path);
  }

  try {
    const res = await fetch(`${API_BASE}${path}`, opts);

    if (res.status === 401) {
      TokenStore.clear();
      window.dispatchEvent(new CustomEvent('auth:expired'));
      const err = new Error('Sesión expirada'); err.status = 401; throw err;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(data.error || `Error ${res.status}`);
      err.status = res.status; throw err;
    }

    // Cachear GETs importantes
    if (method === 'GET') _toCache(path, data);
    return data;

  } catch (err) {
    // Error de red (no de lógica) → encolar y modo offline
    const isNetErr = err instanceof TypeError || !err.status;
    if (isNetErr) {
      Net.online = false;
      Net.renderBar();
      if (method !== 'GET') {
        Queue.push({ method, path, body });
        toast('Sin conexión — operación guardada', 'warning');
        return _optimistic(path, body);
      }
      const cached = _fromCache(path);
      if (cached !== null) return cached;
    }
    throw err;
  }
}

function _toCache(path, data) {
  if (path.startsWith('/tables'))       Cache.set(Cache.K.tables,   data);
  if (path.startsWith('/products'))     Cache.set(Cache.K.products,  data);
  if (path === '/days/current')         Cache.set(Cache.K.day,       data);
  if (path.match(/^\/orders\/\d+$/)) {
    const id = path.split('/')[2];
    if (data && data.id) Cache.setOrder(data.id, data);
  }
}

function _fromCache(path) {
  if (path.startsWith('/tables'))   return Cache.get(Cache.K.tables)   ?? [];
  if (path.startsWith('/products')) return Cache.get(Cache.K.products)  ?? [];
  if (path === '/days/current')     return Cache.get(Cache.K.day);
  if (path.match(/^\/orders\/\d+$/)) {
    const id = parseInt(path.split('/')[2]);
    return Cache.getOrder(id);
  }
  if (path.startsWith('/orders'))   return [];
  return null;
}

function _optimistic(path, body) {
  if (path === '/orders')           return { id: `tmp_${Date.now()}`, status:'active', items:[], created_at: new Date().toISOString() };
  if (path.includes('/items'))      return { id: `tmp_${Date.now()}`, status:'active', quantity: body?.quantity||1, unit_price: body?.price||0 };
  if (path.includes('/request-pay'))return { ok:true };
  return { ok:true, offline:true };
}

const get   = (p)    => apiFetch('GET',    p);
const post  = (p, b) => apiFetch('POST',   p, b);
const put   = (p, b) => apiFetch('PUT',    p, b);
const patch = (p, b) => apiFetch('PATCH',  p, b);
const del   = (p)    => apiFetch('DELETE', p);

/* ── API pública ────────────────────────────────────────────── */
const API = {
  // AUTH
  async login(username, password) {
    const data = await post('/auth/login', { username, password });
    TokenStore.set(data.token);
    Cache.set(Cache.K.user, data.user);
    return data.user;
  },
  logout() { TokenStore.clear(); Cache.del(Cache.K.user); },
  async me() {
    try {
      const u = await get('/auth/me');
      Cache.set(Cache.K.user, u);
      return u;
    } catch {
      const c = Cache.get(Cache.K.user, 43200000); // 12h
      if (c) return c;
      throw new Error('No autenticado');
    }
  },

  // PRODUCTS
  getProducts(p = {}) {
    const qs = new URLSearchParams(p).toString();
    return get('/products' + (qs ? '?' + qs : ''));
  },
  createProduct(d)     { return post('/products', d); },
  updateProduct(id, d) { return put(`/products/${id}`, d); },
  deleteProduct(id)    { return del(`/products/${id}`); },

  // TABLES
  getTables()              { return get('/tables'); },
  setTableStatus(id, status) { return patch(`/tables/${id}/status`, { status }); },

  // ORDERS
  getOrders(p = {}) {
    const qs = new URLSearchParams(p).toString();
    return get('/orders' + (qs ? '?' + qs : ''));
  },
  async getOrder(id) {
    try {
      const o = await get(`/orders/${id}`);
      if (o && o.id) Cache.setOrder(o.id, o);
      return o;
    } catch (err) {
      // Si falla por red, intentar desde cache
      const c = Cache.getOrder(id);
      if (c) { toast('Mostrando pedido desde cache local','info'); return c; }
      throw err;
    }
  },
  createOrder(table_id)            { return post('/orders', { table_id }); },
  addItem(orderId, data)           { return post(`/orders/${orderId}/items`, data); },
  updateItem(orderId, itemId, st)  { return patch(`/orders/${orderId}/items/${itemId}`, { status: st }); },
  requestPayment(orderId)          { return patch(`/orders/${orderId}/request-payment`); },
  confirmPayment(orderId, method)  { return patch(`/orders/${orderId}/pay`, { pay_method: method }); },
  moveOrder(orderId, new_table_id) { return patch(`/orders/${orderId}/move`, { new_table_id }); },
  cancelOrder(orderId)             { return patch(`/orders/${orderId}/cancel`); },
  getKitchenOrders()               { return get('/orders/kitchen'); },

  // WORK DAYS
  getDays()                       { return get('/days'); },
  getCurrentDay()                 { return get('/days/current'); },
  openDay(investments, open_notes){ return post('/days', { investments, open_notes }); },
  closeDay(id, close_notes)       { return patch(`/days/${id}/close`, { close_notes }); },

  // USERS
  getUsers()               { return get('/users'); },
  createUser(d)            { return post('/users', d); },
  changePassword(id, pass) { return patch(`/users/${id}/password`, { password: pass }); },
  toggleUser(id)           { return patch(`/users/${id}/toggle`); },
};

/* ── State en memoria ───────────────────────────────────────── */
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
  tableType:      'mesa',
  kitchTableType: null,
  orderCache:     {},
};

function invalidateOrder(orderId) { delete State.orderCache[orderId]; }

/* ── Helpers de formato ─────────────────────────────────────── */
function fmtCOP(n) { return '$' + Number(n||0).toLocaleString('es-CO'); }
function fmtTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('es-CO', { hour:'2-digit', minute:'2-digit' });
}
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-CO', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
}
function elapsed(iso)    { return Math.floor((Date.now() - new Date(iso)) / 60000); }
function elapsedStr(iso) {
  const m = elapsed(iso);
  return m < 60 ? `${m}m` : `${Math.floor(m/60)}h ${m%60}m`;
}
function timerClass(iso) {
  const m = elapsed(iso);
  return m < 10 ? 'ok' : m < 20 ? 'warn' : 'late';
}
function orderTotal(items = []) {
  return items.filter(i => i.status==='active').reduce((s,i) => s + i.quantity * i.unit_price, 0);
}
function orderCost(items = []) {
  return items.filter(i => i.status==='active').reduce((s,i) => s + i.quantity * i.unit_cost, 0);
}
function getCatClass(c) {
  return { Hamburguesas:'cc-hamburguesas', Especiales:'cc-especiales', 'Hot Dog':'cc-hot-dog',
           Bebidas:'cc-bebidas', Infantil:'cc-infantil', Entradas:'cc-entradas' }[c] || 'cc-entradas';
}
const DRINK_CATS = ['Bebidas'];
function isBev(cat) { return DRINK_CATS.includes(cat); }

/* ── Inicializar al cargar ──────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  Net.init();

  // Al reconectar, refrescar todo automáticamente
  window.addEventListener('mb:refresh', async () => {
    try {
      if (State.user) {
        State.tables  = await API.getTables().catch(() => State.tables);
        State.products= await API.getProducts({ status:'active' }).catch(() => State.products);
        await loadCurrentDay().catch(()=>{});
        updateLocalBadges();
        // Refrescar la sección actual
        const sec = document.querySelector('.st-nav__item.active')?.id?.replace('nav-','');
        if (sec && typeof staffSection === 'function') staffSection(sec);
      }
    } catch(e) {}
  });
});
