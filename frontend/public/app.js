'use strict';

const CAT_EMOJI = { Hamburguesas:'🍔', Especiales:'🥩', 'Hot Dog':'🌭', Bebidas:'🥤', Infantil:'🍟', Entradas:'🥗' };
const BURGER_CATS_BREAD = ['Hamburguesas','Especiales','Hot Dog']; // categorías con opción pan/plátano
const TABLE_TYPE_LABELS = { mesa:'Mesa', domicilio:'Domicilio', para_llevar:'Para llevar' };
const TABLE_TYPE_ICONS  = { mesa:'🪑', domicilio:'🛵', para_llevar:'🥡' };
const $ = id => document.getElementById(id);

/* ─────────────────────────────────────────────
   TOAST
───────────────────────────────────────────── */
function toast(msg, type = 'default') {
  const icons = { success:'fa-circle-check', error:'fa-circle-exclamation', info:'fa-circle-info', warning:'fa-triangle-exclamation', default:'fa-bell' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<i class="fa-solid ${icons[type]||'fa-bell'}"></i><span>${msg}</span>`;
  $('toasts').appendChild(el);
  setTimeout(() => { el.style.animation = 'toastOut .3s ease forwards'; setTimeout(() => el.remove(), 300); }, 3200);
}

/* ─────────────────────────────────────────────
   APP ROUTING
───────────────────────────────────────────── */
function showApp(which) {
  ['client','staff','login','kitchen'].forEach(a => {
    const el = $(`app-${a}`); if (el) el.classList.toggle('hidden', a !== which);
  });
}
function showLogin() { showApp('login'); }

/* ─────────────────────────────────────────────
   INIT
───────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  // Si la sesión expiró, volver al login
  window.addEventListener('auth:expired', () => {
    toast('Sesión expirada. Por favor inicia sesión de nuevo.', 'error');
    logout();
  });

  // Sesión desplazada — otro dispositivo inició sesión con el mismo usuario
  window.addEventListener('auth:displaced', () => {
    // Mostrar modal de aviso antes de cerrar sesión
    const msg = '⚠️ Tu sesión fue iniciada en otro dispositivo.\n\nSolo se permite una sesión activa por usuario.\n\nSerás desconectado de este dispositivo.';
    alert(msg);
    logout();
  });

  // Cuando se recupera la conexión, refrescar la pantalla activa
  window.addEventListener('mb:refresh', async () => {
    if (!State.user) return;
    try {
      State.tables = await API.getTables();
      await loadCurrentDay();
      updateLocalBadges();
      // Refrescar la sección activa
      const activeNav = document.querySelector('.st-nav__item.active');
      if (activeNav) {
        const id = activeNav.id?.replace('nav-','');
        if (id && id !== 'local') staffSection(id);
      }
    } catch(e) {}
  });

  // Intentar restaurar sesión con token guardado
  const token = TokenStore.get();
  if (token) {
    API.me().then(user => {
      State.user = user;
      // Restaurar caché de productos y tablas inmediatamente
      const cachedProducts = Cache.get(Cache.K.products);
      const cachedTables   = Cache.get(Cache.K.tables);
      if (cachedProducts) State.products = cachedProducts;
      if (cachedTables)   State.tables   = cachedTables;
      bootUser();
    }).catch(() => {
      TokenStore.clear();
      showApp('client');
      loadPublicMenu();
    });
  } else {
    showApp('client');
    loadPublicMenu();
  }

  // Splash
  setTimeout(() => {
    $('splash').classList.add('out');
    setTimeout(() => { $('splash').style.display = 'none'; }, 500);
  }, 1800);
});

let _statusPollTimer = null;

function bootUser() {
  if (State.user.role === 'kitchen') {
    bootKitchen();
  } else {
    showApp('staff');
    renderStaffNav();
    renderStaffProfile();
    updateStaffUser();
    loadCurrentDay().then(() => {
      updateLocalBadges();
      if (!State.products.length) {
        const cached = Cache.get(Cache.K.products);
        if (cached) State.products = cached;
      }
      if (State.user.role === 'boss') staffSection('dashboard');
      else                            staffSection('tables');
    });
    // Iniciar polling del estado del local (cada 20 segundos)
    _startStatusPoll();
    // Iniciar heartbeat de sesión (cada 10 segundos)
    _startSessionHeartbeat();
  }
}

let _heartbeatTimer = null;
function _startSessionHeartbeat() {
  if (_heartbeatTimer) clearInterval(_heartbeatTimer);
  _heartbeatTimer = setInterval(async () => {
    if (!State.user) { clearInterval(_heartbeatTimer); return; }
    try {
      const token = TokenStore.get();
      if (!token) { logout(); return; }
      const res = await fetch('/api/auth/me', {
        headers: { 'Authorization': `Bearer ${token}` },
        cache: 'no-store'
      });
      if (res.status === 401) {
        const data = await res.json().catch(() => ({}));
        TokenStore.clear();
        if (data.code === 'SESSION_DISPLACED') {
          window.dispatchEvent(new CustomEvent('auth:displaced'));
        } else {
          window.dispatchEvent(new CustomEvent('auth:expired'));
        }
      }
    } catch { /* sin conexión — silencioso */ }
  }, 10000); // cada 10 segundos
}

function _startStatusPoll() {
  if (_statusPollTimer) clearInterval(_statusPollTimer);
  _statusPollTimer = setInterval(async () => {
    if (!State.user || State.user.role === 'boss') return; // El jefe no necesita polling
    try {
      const prevOpen = !!State.currentDay;
      await loadCurrentDay();
      const nowOpen  = !!State.currentDay;
      // Si el estado cambió, actualizar la UI
      if (prevOpen !== nowOpen) {
        updateLocalBadges();
        renderStaffNav();
        if (nowOpen) {
          toast('🏪 El local fue abierto por el Jefe', 'success');
        } else {
          toast('🔒 El local fue cerrado por el Jefe', 'info');
        }
      }
    } catch { /* silencioso — puede ser offline */ }
  }, 20000); // cada 20 segundos
}

/* ─────────────────────────────────────────────
   AUTH
───────────────────────────────────────────── */
async function doLogin() {
  const username  = $('l-user').value.trim();
  const password  = $('l-pass').value.trim();
  if (!username || !password) { toast('Completa usuario y contraseña', 'error'); return; }
  try {
    State.user = await API.login(username, password);
    // Si no es admin, verificar que el local esté abierto
    if (State.user.role !== 'boss') {
      const day = await API.getCurrentDay().catch(() => null);
      if (!day) {
        API.logout();
        State.user = null;
        toast('El local está cerrado. Solo el Jefe puede ingresar cuando está cerrado. 🔒', 'error');
        return;
      }
    }
    toast(`Bienvenido, ${State.user.name} 👋`, 'success');
    bootUser();
  } catch (err) {
    toast(err.message || 'Error al iniciar sesión', 'error');
  }
}

function logout() {
  API.logout();
  State.user = null; State.selectedTable = null; State.activeOrder = null;
  if (State.kitchTimer)  { clearInterval(State.kitchTimer);  State.kitchTimer  = null; }
  if (_statusPollTimer)  { clearInterval(_statusPollTimer);  _statusPollTimer  = null; }
  if (_clientPollTimer)  { clearInterval(_clientPollTimer);  _clientPollTimer  = null; }
  if (_heartbeatTimer)   { clearInterval(_heartbeatTimer);   _heartbeatTimer   = null; }
  toast('Sesión cerrada', 'info');
  showApp('client');
  loadPublicMenu();
  updateLocalBadges();
}

/* ─────────────────────────────────────────────
   LOCAL STATE HELPERS
───────────────────────────────────────────── */
async function loadCurrentDay() {
  try {
    // Llamada directa al servidor — sin caché intermedia
    const headers = { 'Content-Type': 'application/json' };
    const token = TokenStore.get();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch('/api/days/current', { headers, cache: 'no-store' });
    if (res.ok) {
      const data = await res.json().catch(() => null);
      State.currentDay = data;
      // Guardar en cache para uso offline
      try { localStorage.setItem('mb_day_fresh', JSON.stringify({ v: data, t: Date.now() })); } catch(e) {}
    } else {
      State.currentDay = null;
    }
  } catch {
    // Solo en error de RED usar el cache guardado
    try {
      const raw = localStorage.getItem('mb_day_fresh');
      if (raw) {
        const { v, t } = JSON.parse(raw);
        // Solo usar si es de las últimas 12 horas
        State.currentDay = (Date.now() - t < 43200000) ? v : null;
      } else {
        State.currentDay = null;
      }
    } catch { State.currentDay = null; }
  }
}

function updateLocalBadges() {
  // Soporta dos formatos: objeto completo de jornada, o { open: true/false } del endpoint público
  const open = State.currentDay
    ? (typeof State.currentDay.open === 'boolean' ? State.currentDay.open : true)
    : false;
  const cls  = open ? 'status-pill open' : 'status-pill closed';
  const html = open ? '<span class="dot"></span><span>Abierto</span>' : '<span class="dot"></span><span>Cerrado</span>';
  ['cn-status','st-status','kitch-status'].forEach(id => { const el=$(id); if(el){ el.className=cls; el.innerHTML=html; }});
  const stxt = $('st-status-txt'); if (stxt) stxt.textContent = open ? 'Abierto' : 'Cerrado';
  const cb   = $('closed-banner');  if (cb) cb.classList.toggle('hidden', open);
  const lb   = $('nav-local'); const lt = $('nav-local-txt');
  if (lb) { lb.className = `st-nav__item ${open ? 'local-open' : ''}`; }
  if (lt) lt.textContent = open ? 'Cerrar Local' : 'Abrir Local';
}

/* ─────────────────────────────────────────────
   STAFF NAV
───────────────────────────────────────────── */
const WAITER_NAV = [
  { label:'Operación' },
  { id:'tables',   icon:'fa-table-cells', text:'Mesas' },
  { id:'order',    icon:'fa-receipt',     text:'Pedido Activo' },
  { label:'Menú' },
  { id:'menuview', icon:'fa-utensils',    text:'Ver Menú' },
];
const BOSS_NAV = [
  { label:'Dashboard' },
  { id:'dashboard',icon:'fa-chart-pie',   text:'Resumen' },
  { label:'Operación' },
  { id:'tables',   icon:'fa-table-cells', text:'Todas las Mesas' },
  { id:'orders',   icon:'fa-list-check',  text:'Todos los Pedidos' },
  { label:'Administración' },
  { id:'products', icon:'fa-box',         text:'Productos' },
  { id:'users',    icon:'fa-users',       text:'Usuarios' },
  { id:'reports',  icon:'fa-chart-line',  text:'Reporte Diario' },
  { label:'Local', bottom:true },
  { id:'local',    icon:'fa-store',       text:'Abrir/Cerrar Local', dynamic:true },
];

function renderStaffNav() {
  const nav = $('st-nav'); if (!nav) return;
  const items = State.user.role === 'boss' ? BOSS_NAV : WAITER_NAV;
  nav.innerHTML = items.map(item => {
    if (item.label) return `<div class="st-nav__label">${item.label}</div>`;
    const dy = item.dynamic ? ` id="nav-local"` : '';
    const tx = item.dynamic ? `<span id="nav-local-txt">${State.currentDay ? 'Cerrar Local' : 'Abrir Local'}</span>` : `<span>${item.text}</span>`;
    return `<button class="st-nav__item${item.dynamic&&State.currentDay?' local-open':''}"${dy} id="nav-${item.id}" onclick="navClick('${item.id}')">
      <i class="fa-solid ${item.icon}"></i>${tx}
    </button>`;
  }).join('');
}
function navClick(id) {
  const map = { dashboard:'dashboard', tables:'tables', order:'order', orders:'orders',
    menuview:'menuview', products:'products', users:'users', reports:'reports' };
  if (id === 'local') { toggleLocal().catch(e => toast('Error al cambiar estado del local','error')); return; }
  if (map[id]) staffSection(map[id]);
}
function setActiveNav(id) {
  document.querySelectorAll('.st-nav__item').forEach(el => {
    el.classList.toggle('active', el.id === `nav-${id}`);
  });
}
function renderStaffProfile() {
  const p = $('st-profile'); if (!p || !State.user) return;
  p.innerHTML = `<div class="sp-av">${State.user.name[0]}</div>
    <div><div class="sp-name">${State.user.name}</div>
    <div class="sp-role">${{boss:'Jefe / Admin',waiter:'Mesero',kitchen:'Cocina'}[State.user.role]||State.user.role}</div></div>`;
}
function updateStaffUser() {
  const el = $('st-user'); if (!el || !State.user) return;
  el.innerHTML = `<div class="av">${State.user.name[0]}</div><span>${State.user.name}</span>
    <span class="badge ${State.user.role==='boss'?'badge-acc':'badge-blue'}">${State.user.role==='boss'?'Jefe':'Mesero'}</span>`;
}

let sidebarCollapsed = false;
function toggleSidebar() {
  const sb = $('st-sidebar'), sc = $('st-content'), ov = $('sb-overlay');
  if (!sb) return;
  if (window.innerWidth <= 900) {
    const open = sb.classList.toggle('mobile-open');
    if (ov) ov.classList.toggle('hidden', !open);
  } else {
    sidebarCollapsed = !sidebarCollapsed;
    sb.classList.toggle('collapsed', sidebarCollapsed);
    sc && sc.classList.toggle('expanded', sidebarCollapsed);
  }
}
function closeSidebarMobile() {
  $('st-sidebar')?.classList.remove('mobile-open');
  $('sb-overlay')?.classList.add('hidden');
}

/* ─────────────────────────────────────────────
   STAFF SEARCH
───────────────────────────────────────────── */
function staffSearch(q) {
  const drop = $('ss-drop'); if (!drop) return;
  if (!q || q.length < 2) { drop.classList.add('hidden'); return; }
  const qL = q.toLowerCase();
  const prods  = State.products.filter(p => p.status==='active' && (p.name.toLowerCase().includes(qL) || p.category.toLowerCase().includes(qL))).slice(0,6);
  const tables = State.tables.filter(t => String(t.number).includes(q) || `piso ${t.floor}`.includes(qL)).slice(0,5);
  let html = '';
  if (prods.length) {
    html += `<div class="ss-group"><i class="fa-solid fa-burger"></i> Productos</div>`;
    html += prods.map(p => `
      <div class="ss-item" onmousedown="ssPickProduct(${p.id})">
        <span class="ss-em">${p.image ? `<img src="${p.image}" style="width:22px;height:22px;object-fit:cover;border-radius:4px">` : p.emoji}</span>
        <div class="ss-txt"><div class="ss-name">${p.name}</div><div class="ss-sub">${p.category}</div></div>
        <span class="ss-val">${fmtCOP(p.price)}</span>
      </div>`).join('');
  }
  if (tables.length) {
    html += `<div class="ss-group"><i class="fa-solid fa-table-cells"></i> Mesas</div>`;
    html += tables.map(t => {
      const ic = {free:'🟢',occupied:'🔴',pending:'💛'}[t.status]||'⚪';
      return `<div class="ss-item" onmousedown="ssPickTable(${t.id})">
        <span class="ss-em">${ic}</span>
        <div class="ss-txt"><div class="ss-name">Mesa ${t.number} · Piso ${t.floor}</div>
        <div class="ss-sub">${{free:'Libre',occupied:'Ocupada',pending:'Pago pendiente'}[t.status]||t.status}${t.order_total>0?' · '+fmtCOP(t.order_total):''}</div></div>
      </div>`;
    }).join('');
  }
  if (!html) html = `<div class="ss-empty"><i class="fa-solid fa-magnifying-glass"></i> Sin resultados</div>`;
  drop.innerHTML = html; drop.classList.remove('hidden');
}
function openSSearch() { const v=$('st-search')?.value; if(v&&v.length>=2) staffSearch(v); }
function closeSSearch() { setTimeout(()=>{ $('ss-drop')?.classList.add('hidden'); }, 200); }
function ssPickProduct(pid) {
  $('st-search').value=''; $('ss-drop').classList.add('hidden');
  if (State.activeOrder) openAdd(pid);
  else toast('Selecciona una mesa primero','info');
}
function ssPickTable(tid) {
  $('st-search').value=''; $('ss-drop').classList.add('hidden');
  const t = State.tables.find(x=>x.id===tid); if (!t) return;
  State.floor = t.floor;
  staffSection('tables');
  setTimeout(() => pickTable(tid), 100);
}

/* ─────────────────────────────────────────────
   CLIENT MENU (público)
───────────────────────────────────────────── */
let _mFilter = 'all', _mSearch = '';

let _clientPollTimer = null;

async function loadPublicMenu() {
  try {
    // Consultar estado del local directamente — sin auth, sin cache
    const res = await fetch('/api/days/status', { cache: 'no-store' });
    const s = res.ok ? await res.json().catch(() => ({})) : {};
    State.currentDay = s.open ? s : null;
  } catch { State.currentDay = null; }

  try {
    State.products = await API.getProducts({ status: 'active' });
    Cache.set(Cache.K.products, State.products);
  } catch {
    const cached = Cache.get(Cache.K.products);
    if (cached) State.products = cached;
  }

  renderClientMenu();
  updateLocalBadges();

  // Polling para la página pública: verificar estado del local cada 20 segundos
  // Limpiar timer anterior siempre para evitar duplicados
  if (_clientPollTimer) { clearInterval(_clientPollTimer); _clientPollTimer = null; }
  _clientPollTimer = setInterval(async () => {
    if (State.user) { clearInterval(_clientPollTimer); _clientPollTimer = null; return; }
    try {
      const prevOpen = !!State.currentDay;
      const res = await fetch('/api/days/status', { cache: 'no-store' });
      const s = res.ok ? await res.json().catch(() => ({})) : {};
      State.currentDay = s.open ? s : null;
      if (prevOpen !== !!State.currentDay) updateLocalBadges();
    } catch { /* sin conexión — silencioso */ }
  }, 20000);
}

function filterMenu(cat, btn, search) {
  if (cat !== null && cat !== undefined) _mFilter = cat;
  if (search !== undefined) _mSearch = search;
  if (btn) { document.querySelectorAll('.mf').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); }
  renderClientMenu();
}

function clientNav(page, btn) {
  document.querySelectorAll('.c-page').forEach(p=>p.classList.remove('active'));
  const el = $(`cp-${page}`); if (el) el.classList.add('active');
  document.querySelectorAll('.cn__link').forEach(b=>b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  if (page === 'menu') loadPublicMenu();
}
function toggleMob() { $('mob-menu')?.classList.toggle('hidden'); }

function renderClientMenu() {
  const grid = $('menu-grid'); if (!grid) return;
  const products = State.products.filter(p => {
    if (p.status !== 'active') return false;
    if (_mFilter !== 'all' && p.category !== _mFilter) return false;
    if (_mSearch) { const q = _mSearch.toLowerCase(); return p.name.toLowerCase().includes(q) || p.category.toLowerCase().includes(q); }
    return true;
  }).sort((a, b) => a.price - b.price);  // ordenar de menor a mayor precio
  grid.innerHTML = products.map((p,i) => `
    <div class="pc" style="animation-delay:${Math.min(i,8)*.05}s">
      <div class="pc__img">
        ${p.image ? `<img class="prod-img-real" src="${p.image}" alt="${p.name}" loading="lazy">` : `<div class="pc__img-emoji">${p.emoji}</div>`}
        <span class="pc__cat ${getCatClass(p.category)}">${p.category}</span>
      </div>
      <div class="pc__body">
        <div class="pc__name">${p.name}</div>
        <div class="pc__desc">${p.description||''}</div>
        <div class="pc__footer"><span class="pc__price">${fmtCOP(p.price)}</span><span class="pc__combo">Combo +$10.000</span></div>
      </div>
    </div>`).join('');
}

/* ─────────────────────────────────────────────
   SECTIONS ROUTER
───────────────────────────────────────────── */
function staffSection(sec) {
  setActiveNav(sec);
  const c = $('st-content'); if (!c) return;
  const fn = {
    dashboard: renderDashboard, tables: renderTables, order: renderOrderSection,
    orders: renderAllOrders, menuview: renderMenuView, products: renderProductsAdmin,
    users: renderUsersAdmin, reports: renderReports,
  }[sec];
  if (fn) fn(c);
}

/* ─────────────────────────────────────────────
   FLOOR TABS
───────────────────────────────────────────── */
function tableTypeTabs(ctx) {
  const c = {
    mesa:       State.tables.filter(t=>t.table_type==='mesa'&&t.status!=='free').length,
    domicilio:  State.tables.filter(t=>t.table_type==='domicilio'&&t.status!=='free').length,
    para_llevar:State.tables.filter(t=>t.table_type==='para_llevar'&&t.status!=='free').length,
  };
  const total = {
    mesa: State.tables.filter(t=>t.table_type==='mesa').length,
    domicilio: 100, para_llevar: 100,
  };
  return `<div class="floor-tabs" style="flex-wrap:wrap">
    <button class="ft ${State.tableType==='mesa'?'active':''}" onclick="switchTableType('mesa','${ctx}')">
      🪑 Mesas <span class="fc">${c.mesa}/${total.mesa}</span>
    </button>
    <button class="ft ${State.tableType==='domicilio'?'active':''}" onclick="switchTableType('domicilio','${ctx}')">
      🛵 Domicilios <span class="fc">${c.domicilio}/100</span>
    </button>
    <button class="ft ${State.tableType==='para_llevar'?'active':''}" onclick="switchTableType('para_llevar','${ctx}')">
      🥡 Para llevar <span class="fc">${c.para_llevar}/100</span>
    </button>
  </div>
  ${State.tableType==='mesa' ? `<div class="floor-tabs" style="margin-top:6px">
    <button class="ft ${State.floor===1?'active':''}" onclick="switchFloor(1,'${ctx}')"><i class="fa-solid fa-1"></i>Piso 1</button>
    <button class="ft ${State.floor===2?'active':''}" onclick="switchFloor(2,'${ctx}')"><i class="fa-solid fa-2"></i>Piso 2</button>
  </div>` : ''}`;
}
function floorTabsHTML(ctx) { return tableTypeTabs(ctx); } // alias for dashboard
function switchFloor(f, ctx) { State.floor = f; staffSection(ctx==='boss'?'tables':ctx); }
function switchTableType(type, ctx) {
  State.tableType = type;
  State.selectedTable = null; State.activeOrder = null;
  staffSection(ctx==='boss'?'tables':ctx);
}

/* ─────────────────────────────────────────────
   TABLES SECTION
───────────────────────────────────────────── */
async function renderTables(c) {
  c.innerHTML = `<div class="ph-row"><div class="ph"><h2>${State.user.role==='boss'?'Todas las Mesas':'Mis Mesas'}</h2><p>Cargando…</p></div></div>`;
  try {
    State.tables = await API.getTables();
    if (!State.products.length) {
      State.products = await API.getProducts({ status:'active' });
    }
    // Guardar en caché local para sobrevivir apagones
    Cache.set(Cache.K.tables, State.tables);
    Cache.set(Cache.K.products, State.products);
  } catch (err) { toast('Error cargando mesas','error'); return; }

  const isBoss   = State.user.role === 'boss';
  const myTids   = State.tables.filter(t => t.order_waiter_id === State.user.id && t.order_id).map(t=>t.id);
  // Filter by table type; for mesas also filter by floor
  const flTables = State.tables.filter(t => {
    if (t.table_type !== State.tableType) return false;
    if (State.tableType === 'mesa') return t.floor === State.floor;
    return true;
  });

  c.innerHTML = `
    <div class="ph-row">
      <div class="ph"><h2>${isBoss?'Todas las Mesas':'Mis Mesas'}</h2><p>🟢 Libre · 🔴 Ocupada · 💛 Pago pendiente</p></div>
    </div>
    <div class="tables-order-layout">
      <div class="tables-panel">
        ${tableTypeTabs('tables')}
        <div class="floor-label"><h3>${TABLE_TYPE_ICONS[State.tableType]||'🪑'} ${State.tableType==='mesa'?`Piso ${State.floor}`:TABLE_TYPE_LABELS[State.tableType]||State.tableType}</h3></div>
        <div class="tables-grid" id="tables-grid">
          ${flTables.map(t => {
            const mine = myTids.includes(t.id);
            const st   = {free:'Libre',occupied:mine&&!isBoss?'Mi pedido':'Ocupada',pending:'Cobro pend.'}[t.status]||t.status;
            return `<div class="table-card ${t.status} ${State.selectedTable===t.id?'selected':''}" data-tid="${t.id}" onclick="pickTable(${t.id})">
              <div class="tc-icon">${{free:'🟢',occupied:'🍽️',pending:'💛'}[t.status]||'⚪'}</div>
              <div class="tc-num" style="font-size:${t.table_type!=='mesa'?'14px':'24px'};line-height:1.2">${t.table_type==='mesa'?t.number:(TABLE_TYPE_LABELS[t.table_type]||t.table_type)+' '+t.number}</div>
              <div class="tc-status">${st}</div>
              ${t.order_total > 0 ? `<div class="tc-total">${fmtCOP(t.order_total)}</div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>
      <div class="order-side-panel" id="order-side-panel">
        ${State.selectedTable
          ? '<div style="display:flex;align-items:center;justify-content:center;height:100px"><i class="fa-solid fa-spinner fa-spin" style="font-size:28px;color:var(--text-dim)"></i></div>'
          : '<div class="order-side-empty"><i class="fa-solid fa-hand-pointer"></i><p>Selecciona una mesa<br>para ver su pedido</p></div>'}
      </div>
    </div>`;

  if (State.selectedTable) {
    pickTable(State.selectedTable, true); // restaurar panel sin cambiar selección
  }
}

async function pickTable(tid, restore = false) {
  const isBoss = State.user.role === 'boss';
  const t = State.tables.find(x => x.id === tid);
  if (!t) return;

  // Restricciones para mesero
  if (!isBoss) {
    if (t.status === 'pending') { toast('Mesa en espera de cobro · Solo el Jefe puede liberarla','error'); return; }
    if (t.order_id && t.order_waiter_id !== State.user.id) { toast('Esta mesa tiene un pedido de otro mesero','error'); return; }
  }

  if (!restore) {
    State.selectedTable = tid;
    document.querySelectorAll('.table-card').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.table-card').forEach(el => {
      if (el.dataset.tid && parseInt(el.dataset.tid) === tid) el.classList.add('selected');
    });
  }

  const osp = $('order-side-panel'); if (!osp) return;

  // Cargar pedido si existe
  if (t.order_id) {
    try {
      const order = await API.getOrder(t.order_id);
      State.activeOrder = order;
      osp.innerHTML = renderOrderPanelHTML(t, order, isBoss);
      if (order.status !== 'pending') renderOrderProds();
    } catch (e) {
      // Si no se puede cargar el pedido, mostrar estado limpio
      State.activeOrder = null;
      osp.innerHTML = renderOrderPanelHTML(t, null, isBoss);
      if (isBoss) toast('No se pudo cargar el pedido de esta mesa','warning');
    }
  } else {
    State.activeOrder = null;
    // Edge case: table shows occupied/pending but no order found
    // Give boss a way to force-free the table
    if (isBoss && t.status !== 'free') {
      osp.innerHTML = renderOrderPanelHTML(t, null, isBoss) +
        `<div style="margin-top:10px;padding:12px;background:rgba(232,67,26,.08);border:1px solid rgba(232,67,26,.25);border-radius:10px;text-align:center">
          <p style="font-size:12px;color:var(--text-m);margin-bottom:8px">⚠ La mesa aparece ocupada sin pedido activo</p>
          <button class="pill-btn pill-btn--danger pill-btn--sm" onclick="forceFreeTabe(${t.id})">
            <i class="fa-solid fa-unlock"></i> Forzar liberación
          </button>
        </div>`;
    } else {
      osp.innerHTML = renderOrderPanelHTML(t, null, isBoss);
    }
  }
}

/* ─────────────────────────────────────────────
   ORDER PANEL HTML
───────────────────────────────────────────── */
function renderOrderPanelHTML(table, order, isBoss) {
  const isPending = order && order.status === 'pending';
  return `
    <div class="order-side-header">
      <div>
        <h3>${table.table_type==='mesa'?`Mesa ${table.number}`:(TABLE_TYPE_LABELS[table.table_type]||table.table_type)+' '+table.number} <span style="font-size:13px;color:var(--text-m)">${table.table_type==='mesa'?`Piso ${table.floor}`:''}</span></h3>
        <p style="font-size:12px;color:var(--text-m);margin-top:2px">
          ${order ? `Pedido #${order.id}` : 'Sin pedido activo'}
          ${isPending ? `<span class="badge badge-yellow" style="margin-left:6px"><i class="fa-solid fa-lock"></i> Cobro pendiente</span>` : ''}
        </p>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${!order ? `<button class="pill-btn pill-btn--green pill-btn--sm" onclick="createOrder(${table.id})"><i class="fa-solid fa-plus"></i> Nuevo</button>` : ''}
        ${isBoss&&order ? `<button class="pill-btn pill-btn--sm" style="background:var(--blue);border-color:var(--blue);color:#fff" onclick="openMoveModal()"><i class="fa-solid fa-arrows-alt"></i></button>` : ''}
        ${order&&!isPending ? `<button class="pill-btn pill-btn--danger pill-btn--sm" onclick="doRequestPay(${order.id})"><i class="fa-solid fa-money-bill-wave"></i> Cobrar</button>` : ''}
        ${isBoss&&isPending ? `<button class="pill-btn pill-btn--green pill-btn--sm" onclick="openPayModal(${order.id})"><i class="fa-solid fa-circle-check"></i> Pagar</button>` : ''}
        ${isBoss&&order ? `<button class="pill-btn pill-btn--sm pill-btn--danger" style="opacity:.7" onclick="cancelOrderAndFree(${order.id},${table.id})" title="Cancelar pedido y liberar mesa"><i class="fa-solid fa-ban"></i> Liberar</button>` : ''}
      </div>
    </div>
    ${order && !isPending ? `
      <div class="order-search-bar">
        <input class="field-c" id="op-search" placeholder="🔍 Buscar…" oninput="renderOrderProds()" style="flex:1">
        <select class="field-c" id="op-cat" style="max-width:130px" onchange="renderOrderProds()">
          <option value="">Todas</option><option>Hamburguesas</option><option>Especiales</option>
          <option>Hot Dog</option><option>Bebidas</option><option>Infantil</option><option>Entradas</option>
        </select>
      </div>
      <div class="order-prods-grid" id="op-grid" style="max-height:180px;overflow-y:auto;margin-bottom:10px"></div>` :
      isPending ? `<div class="locked-state"><i class="fa-solid fa-lock"></i><h4>Bloqueado</h4><p>Esperando cobro por el Jefe</p></div>` : ''}
    <div class="cart-panel" style="flex:1;min-height:0">
      <div class="cart-head">
        <h3 style="font-size:16px"><i class="fa-solid fa-receipt"></i> Pedido</h3>
        ${order ? `<span class="badge badge-acc">#${order.id}</span>` : `<span class="badge badge-green">Nuevo</span>`}
      </div>
      <div class="cart-items" id="cart-items">${renderCartItems(order?.items, isPending)}</div>
      <div class="cart-foot">${renderCartFoot(order?.items, order, table?.table_type)}</div>
    </div>`;
}

function renderOrderProds() {
  const grid = $('op-grid'); if (!grid) return;
  const q   = ($('op-search')?.value || '').toLowerCase();
  const cat = $('op-cat')?.value || '';
  grid.innerHTML = State.products.filter(p => p.status==='active' && (!cat||p.category===cat) && (!q||p.name.toLowerCase().includes(q)||p.category.toLowerCase().includes(q)))
    .map(p => p.image ? `
      <div class="opc with-img" onclick="openAdd(${p.id})">
        <img src="${p.image}" alt="${p.name}" loading="lazy">
        <div class="oi"><div class="on">${p.name}</div><div class="oc">${p.category}</div><div class="op">${fmtCOP(p.price)}</div></div>
      </div>` : `
      <div class="opc" onclick="openAdd(${p.id})">
        <span class="oe">${p.emoji}</span><span class="on">${p.name}</span>
        <span class="oc">${p.category}</span><span class="op">${fmtCOP(p.price)}</span>
      </div>`).join('');
}

function renderCartItems(items = [], locked = false) {
  if (!items?.length) return `<div class="cart-empty"><i class="fa-solid fa-${items===null?'receipt':'plus-circle'}"></i><p>${items===null?'Crea un pedido':'Agrega productos'}</p></div>`;
  return items.map(it => {
    const c = it.status === 'cancelled';
    return `<div class="ci ${c?'cancelled':''}" id="ci-${it.id}">
      ${it.image ? `<img src="${it.image}" style="width:26px;height:26px;border-radius:5px;object-fit:cover;flex-shrink:0">` : `<span class="ci-em">${it.emoji||'🍔'}</span>`}
      <div class="ci-info">
        <div class="ci-name">${it.product_name||'Producto'} ${it.quantity>1?`×${it.quantity}`:''}${it.bread_type?` <span style="font-size:10px;color:var(--acc);font-weight:700">${it.bread_type==='platano'?'🍌 Plátano':'🍞 Pan'}</span>`:''}</div>
        <div class="ci-price">${fmtCOP(it.unit_price * it.quantity)}</div>
        ${it.notes ? `<div class="ci-note">${it.notes}</div>` : ''}
        ${c ? '<span class="ci-cbadge">Cancelado</span>' : ''}
      </div>
      ${!locked ? (!c
        ? `<button class="ci-btn" onclick="doCancelItem(${State.activeOrder?.id},${it.id})"><i class="fa-solid fa-xmark"></i></button>`
        : `<button class="ci-btn rev" onclick="doReviveItem(${State.activeOrder?.id},${it.id})"><i class="fa-solid fa-rotate-left"></i></button>`)
      : ''}
    </div>`;
  }).join('');
}

function renderCartFoot(items, order, tableType) {
  if (!items?.length) return `<div class="cr total"><span>TOTAL</span><span>${fmtCOP(0)}</span></div>`;
  const active    = items.filter(i => i.status === 'active');
  const cancelled = items.filter(i => i.status === 'cancelled');
  const total     = orderTotal(items);
  // Mostrar nombre del mesero solo en mesas físicas
  const showWaiter = tableType === 'mesa' && order?.waiter_name;
  return `
    <div class="cr"><span>Activos</span><span>${active.length}</span></div>
    ${cancelled.length ? `<div class="cr"><span style="color:var(--red)">Cancelados</span><span style="color:var(--red)">${cancelled.length}</span></div>` : ''}
    <div class="cr total"><span>TOTAL</span><span>${fmtCOP(total)}</span></div>
    ${showWaiter ? `<div class="cr" style="margin-top:6px;padding-top:6px;border-top:1px solid var(--border)"><span style="color:var(--text-m);font-size:11px"><i class="fa-solid fa-user" style="color:var(--acc)"></i> Atendido por</span><span style="font-size:11px;font-weight:700;color:var(--text)">${order.waiter_name}</span></div>` : ''}`;
}

async function refreshOrderPanel() {
  if (!State.selectedTable) return;
  const t = State.tables.find(x => x.id === State.selectedTable); if (!t) return;
  if (State.activeOrder) {
    try {
      const order = await API.getOrder(State.activeOrder.id);
      State.activeOrder = order;
      // Guardar en cache local por si hay apagón
      if (order && order.id) Cache.setOrder(order.id, order);
    } catch {
      // Si falla, usar lo que tenemos en memoria (puede estar en cache ya)
    }
    const ci = $('cart-items'), cf = document.querySelector('.cart-foot');
    const tbl = State.tables.find(x => x.id === State.selectedTable);
    if (ci) ci.innerHTML = renderCartItems(State.activeOrder.items, State.activeOrder.status === 'pending');
    if (cf) cf.innerHTML = renderCartFoot(State.activeOrder.items, State.activeOrder, tbl?.table_type);
  }
}

function renderOrderSection(c) {
  if (!State.selectedTable) {
    c.innerHTML = `<div class="ph"><h2>Pedido Activo</h2></div><div style="display:flex;align-items:center;justify-content:center;height:200px;color:var(--text-m);font-size:15px;gap:10px"><i class="fa-solid fa-table-cells"></i> Selecciona una mesa</div>`;
    return;
  }
  const isBoss = State.user.role === 'boss';
  const t = State.tables.find(x => x.id === State.selectedTable);
  c.innerHTML = `
    <div class="ph-row">
      <div class="ph"><h2>Pedido Activo</h2></div>
      <button class="pill-btn pill-btn--sm" onclick="staffSection('tables')"><i class="fa-solid fa-arrow-left"></i> Volver</button>
    </div>
    <div id="order-side-panel" style="display:flex;flex-direction:column;gap:12px">
      ${State.activeOrder ? renderOrderPanelHTML(t, State.activeOrder, isBoss) : renderOrderPanelHTML(t, null, isBoss)}
    </div>`;
  if (State.activeOrder?.status !== 'pending') renderOrderProds();
}

/* ─────────────────────────────────────────────
   ORDER MANAGEMENT
───────────────────────────────────────────── */
async function createOrder(tableId) {
  try {
    const order = await API.createOrder(tableId);
    State.activeOrder = { ...order, items: [] };
    State.tables = await API.getTables();
    toast('Pedido creado ✅','success');
    const t = State.tables.find(x => x.id === tableId);
    const osp = $('order-side-panel'); if (osp && t) { osp.innerHTML = renderOrderPanelHTML(t, State.activeOrder, State.user.role==='boss'); renderOrderProds(); }
  } catch (err) { toast(err.message,'error'); }
}

// Forzar liberación de mesa — SOLO JEFE (estado inconsistente)
async function forceFreeTabe(tableId) {
  if (!confirm('¿Forzar la liberación de esta mesa?\nUsa esto solo si la mesa quedó bloqueada por error.')) return;
  try {
    await API.setTableStatus(tableId, 'free');
    State.tables = await API.getTables();
    State.selectedTable = null; State.activeOrder = null;
    toast('Mesa liberada forzosamente ✅','success');
    staffSection('tables');
  } catch (err) { toast(err.message || 'Error al liberar mesa','error'); }
}

// Cancelar pedido activo y liberar la mesa — SOLO JEFE
async function cancelOrderAndFree(orderId, tableId) {
  if (!confirm('¿Cancelar este pedido y liberar la mesa?\n\nEsta acción no se puede deshacer.')) return;
  try {
    await API.cancelOrder(orderId);
    State.tables = await API.getTables();
    State.selectedTable = null;
    State.activeOrder   = null;
    toast('Mesa liberada correctamente ✅','success');
    staffSection('tables');
  } catch (err) { toast(err.message || 'Error al liberar mesa','error'); }
}

async function doRequestPay(orderId) {
  // Verificar en el frontend que haya ítems antes de llamar al API
  const order = State.activeOrder;
  const activeItems = order?.items?.filter(i => i.status === 'active') || [];
  if (activeItems.length === 0) {
    toast('No puedes solicitar cobro de un pedido vacío. Agrega productos primero.','error');
    return;
  }
  if (!confirm('¿Marcar como listo para cobrar?')) return;
  try {
    await API.requestPayment(orderId);
    State.selectedTable = null; State.activeOrder = null;
    State.tables = await API.getTables();
    toast('Pedido enviado a cobro 💛','info');
    staffSection('tables');
  } catch (err) { toast(err.message,'error'); }
}

/* ─────────────────────────────────────────────
   ADD ITEM MODAL
───────────────────────────────────────────── */
let _addPid = null, _addQty = 1;
function openAdd(pid) {
  if (!State.activeOrder) { toast('Primero crea un pedido','error'); return; }
  const p = State.products.find(x => x.id === pid); if (!p) return;
  _addPid = pid; _addQty = 1;
  $('ma-title').textContent = p.name;
  $('ma-vis').innerHTML = p.image ? `<img src="${p.image}" alt="${p.name}" style="width:100%;height:100%;object-fit:cover">` : `<div class="ma-em">${p.emoji}</div>`;
  $('ma-desc').textContent  = p.description || '';
  $('ma-price').textContent = fmtCOP(p.price);
  $('ma-qty').textContent   = '1';
  $('ma-notes').value       = '';
  $('ma-pid').value         = pid;
  // Mostrar selector de pan/plátano si aplica
  const breadSect = $('ma-bread-section');
  if (breadSect) {
    const showBread = BURGER_CATS_BREAD.includes(p.category);
    breadSect.style.display = showBread ? 'block' : 'none';
    // Reset selection
    document.querySelectorAll('.bread-btn').forEach(b => b.classList.remove('active'));
    const defaultBtn = document.querySelector('.bread-btn[data-val="pan"]');
    if (defaultBtn && showBread) defaultBtn.classList.add('active');
    $('ma-bread').value = showBread ? 'pan' : '';
    // Update price display
    updateBreadPrice(p.price, showBread ? 'pan' : null);
  }
  openModal('modal-add');
}

function selectBread(val, btn) {
  document.querySelectorAll('.bread-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  $('ma-bread').value = val;
  const pid = parseInt($('ma-pid').value);
  const p = State.products.find(x => x.id === pid);
  if (p) updateBreadPrice(p.price, val);
}

function updateBreadPrice(basePrice, breadVal) {
  const extra = breadVal === 'platano' ? 1000 : 0;
  const priceEl = $('ma-price');
  if (priceEl) {
    priceEl.innerHTML = fmtCOP(basePrice + extra) +
      (extra > 0 ? ' <span style="font-size:13px;color:var(--green)">+$1.000 plátano</span>' : '');
  }
}
function changeQty(d) { _addQty = Math.max(1, _addQty + d); $('ma-qty').textContent = _addQty; }
async function confirmAdd() {
  const pid        = parseInt($('ma-pid').value);
  const notes      = $('ma-notes').value.trim();
  const bread_type = $('ma-bread')?.value || null;
  try {
    await API.addItem(State.activeOrder.id, { product_id: pid, quantity: _addQty, notes, bread_type: bread_type || undefined });
    closeModal('modal-add');
    const p = State.products.find(x=>x.id===pid);
    const breadLabel = bread_type === 'platano' ? ' 🍌 plátano' : bread_type === 'pan' ? ' 🍞 pan' : '';
    toast(`${p?.emoji||''} ${p?.name||'Producto'}${breadLabel} agregado`,'success');
    await refreshOrderPanel();
  } catch (err) { toast(err.message,'error'); }
}
async function doCancelItem(orderId, itemId) {
  try { await API.updateItem(orderId, itemId, 'cancelled'); toast('Ítem cancelado','error'); await refreshOrderPanel(); }
  catch (err) { toast(err.message,'error'); }
}
async function doReviveItem(orderId, itemId) {
  try { await API.updateItem(orderId, itemId, 'active'); toast('Ítem reactivado','success'); await refreshOrderPanel(); }
  catch (err) { toast(err.message,'error'); }
}

/* ─────────────────────────────────────────────
   PAY MODAL
───────────────────────────────────────────── */
async function openPayModal(orderId) {
  try {
    const order = await API.getOrder(orderId);
    const total = orderTotal(order.items);
    $('pay-sum').innerHTML = `
      <div class="pt-title">${order.table_type==='mesa'?`Mesa ${order.table_number} · Piso ${order.table_floor}`:order.table_type==='domicilio'?`Domicilio ${order.table_number}`:`Para llevar ${order.table_number}`} · Pedido #${orderId}</div>
      ${order.items.map(i => `<div class="pi ${i.status==='cancelled'?'cancelled':''}"><span>${i.emoji||''} ${i.product_name}${i.bread_type?` (${i.bread_type==='platano'?'🍌 plátano':'🍞 pan'})`:''} ×${i.quantity}</span><span>${fmtCOP(i.unit_price*i.quantity)}</span></div>`).join('')}
      <div class="ptotal"><span>TOTAL</span><span>${fmtCOP(total)}</span></div>`;
    $('pay-recv').value = ''; $('pay-change').classList.add('hidden');
    $('pay-meth').value = 'efectivo'; $('pay-oid').value = orderId;
    $('pay-print-opt').value = 'none';
    document.querySelectorAll('.print-opt-btn').forEach(b => b.classList.remove('active'));
    const noneBtn = document.getElementById('print-none');
    if (noneBtn) noneBtn.classList.add('active');
    // Guardar datos del pedido para impresión posterior
    State._lastPaidOrder = order;
    openModal('modal-pay');
  } catch (err) { toast(err.message,'error'); }
}
function calcChange() {
  const oid = parseInt($('pay-oid').value);
  const order = State.activeOrder?.id === oid ? State.activeOrder : null;
  if (!order) return;
  const total   = orderTotal(order.items);
  const recv    = parseFloat($('pay-recv').value) || 0;
  const el      = $('pay-change');
  if (recv >= total) { el.textContent = `💵 Cambio: ${fmtCOP(recv-total)}`; el.classList.remove('hidden'); }
  else el.classList.add('hidden');
}
async function confirmPay() {
  const orderId  = parseInt($('pay-oid').value);
  const method   = $('pay-meth').value;
  const printOpt = $('pay-print-opt')?.value || 'none';  // 'none' | 'receipt' | 'invoice'
  try {
    await API.confirmPayment(orderId, method);
    // Guardar el pedido antes de limpiar el estado
    const lastOrder = State._lastPaidOrder;
    State.selectedTable = null; State.activeOrder = null;
    closeModal('modal-pay');
    State.tables = await API.getTables();
    await loadCurrentDay();
    updateLocalBadges();
    toast('Pago confirmado — Mesa liberada', 'success');
    // Imprimir si se seleccionó
    if ((printOpt === 'receipt' || printOpt === 'invoice') && lastOrder) {
      printDocument(lastOrder, method, printOpt);
    }
    staffSection('tables');
  } catch (err) { toast(err.message,'error'); }
}

/* ─────────────────────────────────────────────
   MOVE TABLE MODAL
───────────────────────────────────────────── */
let _moveTarget = null;
async function openMoveModal() {
  _moveTarget = null;
  if (!State.tables.length) State.tables = await API.getTables();
  const renderSm = fl => `
    <div class="move-floor"><i class="fa-solid fa-${fl}"></i> Piso ${fl}</div>
    <div class="move-grid-inner">
      ${State.tables.filter(t=>t.floor===fl&&t.id!==State.selectedTable).map(t =>
        `<div class="mt-sm ${t.status!=='free'?'occupied':''}" onclick="pickMoveTarget(${t.id},this)">
          <div class="mts-n">${t.number}</div><div class="mts-s">${{free:'Libre',occupied:'Ocupada',pending:'Cobro'}[t.status]||t.status}</div>
        </div>`).join('')}
    </div>`;
  $('move-grid').innerHTML = renderSm(1) + renderSm(2);
  openModal('modal-move');
}
function pickMoveTarget(tid, el) { document.querySelectorAll('.mt-sm').forEach(x=>x.classList.remove('selected')); el.classList.add('selected'); _moveTarget=tid; }
async function confirmMove() {
  if (!_moveTarget) { toast('Selecciona una mesa destino','error'); return; }
  try {
    const r = await API.moveOrder(State.activeOrder.id, _moveTarget);
    State.tables = await API.getTables();
    State.selectedTable = _moveTarget;
    const newT = State.tables.find(x=>x.id===_moveTarget);
    if (newT) State.floor = newT.floor;
    closeModal('modal-move');
    toast(r.message,'success');
    staffSection('tables');
  } catch (err) { toast(err.message,'error'); }
}

/* ─────────────────────────────────────────────
   LOCAL (JORNADAS)
───────────────────────────────────────────── */
let _tempInv = [{ description:'', amount:'' }];
async function toggleLocal() {
  // Deshabilitar el botón mientras carga para evitar doble click
  const btn = $('nav-local');
  if (btn) btn.style.pointerEvents = 'none';
  try {
    await loadCurrentDay();
    if (State.currentDay) {
      openCloseDayModal();
    } else {
      openOpenModal();
    }
  } catch(e) {
    toast('Error al consultar el estado del local. Intenta de nuevo.', 'error');
  } finally {
    if (btn) btn.style.pointerEvents = '';
  }
}

function openOpenModal() {
  _tempInv = [{ description:'', amount:'' }];
  renderInvRows();
  const openNotes = $('open-notes');
  if (openNotes) openNotes.value = '';
  recalcInv();
  // Forzar que el modal sea visible
  const modal = $('modal-open');
  if (!modal) { toast('Error: modal no encontrado. Recarga la página.','error'); return; }
  modal.classList.remove('hidden');
}
function renderInvRows() {
  $('inv-rows').innerHTML = _tempInv.map((inv,i) => `
    <div class="inv-row">
      <input class="field-c" placeholder="Descripción (Carne de res…)" value="${inv.description}" oninput="_tempInv[${i}].description=this.value">
      <input class="field-c inv-amt" type="number" placeholder="$ Monto" value="${inv.amount}" oninput="_tempInv[${i}].amount=this.value;recalcInv()">
      <button class="inv-del" onclick="removeInv(${i})"><i class="fa-solid fa-trash"></i></button>
    </div>`).join('');
}
function addInvRow() { _tempInv.push({ description:'', amount:'' }); renderInvRows(); }
function removeInv(i) { _tempInv.splice(i,1); if(!_tempInv.length)_tempInv=[{description:'',amount:''}]; renderInvRows(); recalcInv(); }
function recalcInv() { $('inv-total').textContent = fmtCOP(_tempInv.reduce((s,x)=>s+(parseFloat(x.amount)||0),0)); }
async function confirmOpen() {
  const btn = document.querySelector('#modal-open .pill-btn--green');
  if (btn) { btn.disabled = true; btn.textContent = 'Abriendo…'; }
  const investments = _tempInv
    .filter(x => x.description || parseFloat(x.amount))
    .map(x => ({ description: x.description || 'Inversión', amount: parseFloat(x.amount) || 0 }));
  const notes = ($('open-notes')?.value || '').trim();
  try {
    await API.openDay(investments, notes);
    // Limpiar cache viejo de jornada
    try { localStorage.removeItem('mb_day_fresh'); } catch(e) {}
    await loadCurrentDay();
    $('modal-open').classList.add('hidden');
    toast('¡Local abierto! 🏪 Buena jornada', 'success');
    updateLocalBadges();
    renderStaffNav();
    staffSection('dashboard');
  } catch (err) {
    if (err.message && err.message.includes('Ya hay una jornada')) {
      try { localStorage.removeItem('mb_day_fresh'); } catch(e) {}
      await loadCurrentDay();
      $('modal-open').classList.add('hidden');
      updateLocalBadges();
      renderStaffNav();
      toast('Ya hay una jornada abierta — sincronizado', 'info');
      staffSection('dashboard');
    } else {
      toast(err.message || 'Error al abrir jornada', 'error');
    }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fa-solid fa-store"></i> Abrir Local y Comenzar'; }
  }
}

async function openCloseDayModal() {
  if (!State.currentDay) return;
  try {
    const [activeOrders, pendingOrders] = await Promise.all([
      API.getOrders({ status:'active' }),
      API.getOrders({ status:'pending' }),
    ]);
    if (activeOrders.length + pendingOrders.length > 0) {
      toast(`${activeOrders.length + pendingOrders.length} pedido(s) sin cobrar. Ciérralos primero.`, 'error');
      return;
    }

    const d   = State.currentDay;
    const inv = parseInt(d.total_investment) || 0;
    const net = (parseInt(d.gross_profit)||0) - inv;

    // Resumen financiero
    $('close-sum').innerHTML = `
      <div class="cds-grid">
        <div class="cds-box yellow"><div class="cds-l">Inversión del día</div><div class="cds-v">${fmtCOP(inv)}</div></div>
        <div class="cds-box acc"><div class="cds-l">Total vendido</div><div class="cds-v">${fmtCOP(d.total_sales||0)}</div></div>
        <div class="cds-box"><div class="cds-l" style="color:var(--text-m)">Costo producción</div><div class="cds-v" style="color:var(--text-m)">${fmtCOP(d.total_cost||0)}</div></div>
        <div class="cds-box ${net>=0?'green':'red'}"><div class="cds-l">Ganancia neta</div><div class="cds-v">${fmtCOP(net)}</div></div>
      </div>
      <p style="font-size:12px;color:var(--text-m);margin-top:8px">
        <i class="fa-solid fa-clock"></i> Apertura: ${fmtTime(d.opened_at)}
      </p>`;

    // Cargar ventas por producto
    const cpEl = $('close-products');
    if (cpEl) {
      cpEl.innerHTML = `<div style="color:var(--text-m);font-size:13px;padding:8px 0"><i class="fa-solid fa-spinner fa-spin"></i> Cargando detalle de productos…</div>`;
      try {
        const products = await API.getDayProducts(d.id);
        if (products.length === 0) {
          cpEl.innerHTML = `<div style="color:var(--text-m);font-size:13px;padding:8px 0">Sin ventas registradas en esta jornada.</div>`;
        } else {
          const totalVentas = products.reduce((s,p) => s + parseInt(p.total_revenue), 0);
          cpEl.innerHTML = `
            <div style="margin-top:4px;margin-bottom:8px">
              <h4 style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:6px">
                <i class="fa-solid fa-chart-bar" style="color:var(--acc)"></i>
                Ventas por producto — ${products.length} producto(s)
              </h4>
            </div>
            <div style="overflow-x:auto">
              <table style="width:100%;border-collapse:collapse;font-size:13px">
                <thead>
                  <tr style="background:var(--bg-2)">
                    <th style="padding:7px 10px;text-align:left;color:var(--text-m);font-weight:600;border-bottom:1px solid var(--border)">Producto</th>
                    <th style="padding:7px 10px;text-align:center;color:var(--text-m);font-weight:600;border-bottom:1px solid var(--border)">Categoría</th>
                    <th style="padding:7px 10px;text-align:center;color:var(--text-m);font-weight:600;border-bottom:1px solid var(--border)">Vendidos</th>
                    <th style="padding:7px 10px;text-align:right;color:var(--text-m);font-weight:600;border-bottom:1px solid var(--border)">Total vendido</th>
                    <th style="padding:7px 10px;text-align:right;color:var(--text-m);font-weight:600;border-bottom:1px solid var(--border)">Ganancia</th>
                  </tr>
                </thead>
                <tbody>
                  ${products.map((p,i) => `
                    <tr style="background:${i%2===0?'transparent':'var(--bg-2)'}">
                      <td style="padding:7px 10px;font-weight:600;color:var(--text)">${p.emoji||''} ${p.product_name}</td>
                      <td style="padding:7px 10px;text-align:center;color:var(--text-m)">${p.category}</td>
                      <td style="padding:7px 10px;text-align:center;font-weight:700;color:var(--acc)">${p.units_sold}</td>
                      <td style="padding:7px 10px;text-align:right;font-family:'DM Mono',monospace;color:var(--text)">${fmtCOP(p.total_revenue)}</td>
                      <td style="padding:7px 10px;text-align:right;font-family:'DM Mono',monospace;font-weight:700;color:${parseInt(p.total_profit)>=0?'var(--green)':'var(--red)'}">${fmtCOP(p.total_profit)}</td>
                    </tr>`).join('')}
                </tbody>
                <tfoot>
                  <tr style="background:var(--bg-1);border-top:2px solid var(--border)">
                    <td colspan="3" style="padding:8px 10px;font-weight:700;color:var(--text)">TOTAL JORNADA</td>
                    <td style="padding:8px 10px;text-align:right;font-weight:700;font-family:'Bebas Neue',sans-serif;font-size:16px;color:var(--acc)">${fmtCOP(totalVentas)}</td>
                    <td style="padding:8px 10px;text-align:right;font-weight:700;font-family:'Bebas Neue',sans-serif;font-size:16px;color:${net>=0?'var(--green)':'var(--red)'}">${fmtCOP(net)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>`;
        }
      } catch {
        cpEl.innerHTML = `<div style="color:var(--red);font-size:13px;padding:8px 0">No se pudo cargar el detalle de productos.</div>`;
      }
    }

    $('close-notes').value = '';
    openModal('modal-close-day');
  } catch (err) { toast(err.message, 'error'); }
}
async function confirmClose() {
  try {
    await API.closeDay(State.currentDay.id, ($('close-notes')?.value || '').trim());
    State.currentDay = null;
    // Limpiar cache de jornada al cerrar
    try { localStorage.removeItem('mb_day_fresh'); } catch(e) {}
    try { localStorage.removeItem(Cache.K.day); } catch(e) {}
    closeModal('modal-close-day');
    toast('Jornada cerrada 🔒', 'info');
    updateLocalBadges();
    renderStaffNav();
    staffSection('reports');
  } catch (err) { toast(err.message,'error'); }
}

/* ─────────────────────────────────────────────
   DASHBOARD
───────────────────────────────────────────── */
async function renderDashboard(c) {
  c.innerHTML = `<div class="ph"><h2>Dashboard</h2><p>Cargando…</p></div>`;
  try {
    const [tables, orders, pendOrders] = await Promise.all([
      API.getTables(),
      API.getOrders({ status:'active' }),
      API.getOrders({ status:'pending' }),
    ]);
    State.tables = tables;
    const d = State.currentDay;
    const occ  = tables.filter(t=>t.status!=='free').length;
    const prods = State.products.length || (await API.getProducts({status:'active'})).length;

    c.innerHTML = `
      <div class="ph"><h2>Dashboard</h2><p>${d?`Jornada abierta · ${fmtTime(d.opened_at)}`:'Sin jornada activa'}</p></div>
      ${!d ? `<div class="warn-bar"><p><strong>El local está cerrado.</strong> Abre la jornada para operar.</p>
        <button class="pill-btn pill-btn--green" onclick="openOpenModal()"><i class="fa-solid fa-store"></i> Abrir Local</button></div>` : ''}
      <div class="stats-row">
        <div class="stat-card"><div class="sc-label">Productos Activos</div><div class="sc-val">${prods}</div></div>
        <div class="stat-card"><div class="sc-label">Mesas Ocupadas</div><div class="sc-val">${occ}</div><div class="sc-sub">de 37</div></div>
        <div class="stat-card"><div class="sc-label">Pedidos Activos</div><div class="sc-val">${orders.length}</div></div>
        <div class="stat-card" style="border-color:rgba(240,192,64,.3)"><div class="sc-label" style="color:var(--yellow)">Cobro Pendiente</div><div class="sc-val" style="color:var(--yellow)">${pendOrders.length}</div></div>
        ${d ? `<div class="stat-card"><div class="sc-label">Ventas Hoy</div><div class="sc-val" style="font-size:24px">${fmtCOP(d.total_sales||0)}</div></div>
               <div class="stat-card"><div class="sc-label">Ganancia Neta</div><div class="sc-val" style="font-size:22px;color:${(d.net_profit||0)>=0?'var(--green)':'var(--red)'}">${fmtCOP(d.net_profit||0)}</div></div>` : ''}
      </div>
      ${pendOrders.length ? `<div class="pend-box"><h4><i class="fa-solid fa-triangle-exclamation"></i> Mesas esperando cobro</h4><div class="pend-btns">
        ${pendOrders.map(o=>`<button class="pend-btn" onclick="openPayModal(${o.id})"><i class="fa-solid fa-money-bill-wave"></i> ${o.table_type==='mesa'?`Mesa ${o.table_number} P${o.table_floor}`:o.table_type==='domicilio'?`Domicilio ${o.table_number}`:`Para llevar ${o.table_number}`} · ${fmtCOP(o.total)}</button>`).join('')}
      </div></div>` : ''}
      <div class="ph-row" style="margin-top:8px"><h2 style="font-size:28px">Mesas en vivo</h2></div>
      ${floorTabsHTML('boss')}
      <div class="floor-label"><h3><i class="fa-solid fa-building"></i> Piso ${State.floor}</h3></div>
      <div class="tables-grid">
        ${tables.filter(t=>t.floor===State.floor).map(t=>`
          <div class="table-card ${t.status}" onclick="pickTableDash(${t.id})">
            <div class="tc-icon">${{free:'🟢',occupied:'🍽️',pending:'💛'}[t.status]||'⚪'}</div>
            <div class="tc-num" style="font-size:${t.table_type!=='mesa'?'12px':'24px'};line-height:1.2">${t.table_type==='mesa'?t.number:(TABLE_TYPE_LABELS[t.table_type]||t.table_type)+' '+t.number}</div>
            <div class="tc-status">${{free:'Libre',occupied:'Ocupada',pending:'Cobro pend.'}[t.status]||t.status}</div>
            ${t.order_total>0?`<div class="tc-total">${fmtCOP(t.order_total)}</div>`:''}
          </div>`).join('')}
      </div>`;
  } catch (err) { c.innerHTML = `<div class="ph"><h2>Dashboard</h2></div><p style="color:var(--red)">Error: ${err.message}</p>`; }
}
function pickTableDash(tid) { State.selectedTable = tid; staffSection('tables'); }

/* ─────────────────────────────────────────────
   ALL ORDERS
───────────────────────────────────────────── */
async function renderAllOrders(c) {
  c.innerHTML = `<div class="ph"><h2>Todos los Pedidos</h2></div><p style="color:var(--text-m)">Cargando…</p>`;
  try {
    const [pending, active, paid] = await Promise.all([
      API.getOrders({ status:'pending' }),
      API.getOrders({ status:'active' }),
      API.getOrders({ status:'paid' }),
    ]);
    const card = o => `<div class="oc">
      <div class="oc-head">
        <h4>Pedido #${o.id} · ${o.table_type==='mesa'?`Mesa ${o.table_number} P${o.table_floor}`:o.table_type==='domicilio'?`Domicilio ${o.table_number}`:`Para llevar ${o.table_number}`}</h4>
        <div style="display:flex;gap:8px;align-items:center">
          <span class="badge ${{active:'badge-green',pending:'badge-yellow',paid:'badge-acc'}[o.status]||'badge-acc'}">${{active:'Activo',pending:'Pago Pend.',paid:'Cobrado'}[o.status]||o.status}</span>
          <span style="font-family:'Bebas Neue',sans-serif;font-size:18px;color:var(--acc)">${fmtCOP(o.total)}</span>
          ${o.status==='pending'?`<button class="pill-btn pill-btn--green pill-btn--sm" onclick="openPayModal(${o.id})"><i class="fa-solid fa-money-bill-wave"></i> Cobrar</button>`:''}
        </div>
      </div>
      <div class="oc-meta">${o.waiter_name||'?'} · ${fmtTime(o.created_at)}${o.pay_method?' · '+o.pay_method:''}</div>
    </div>`;
    c.innerHTML = `
      <div class="ph"><h2>Todos los Pedidos</h2></div>
      <h3 style="font-size:20px;color:var(--yellow);margin-bottom:8px"><i class="fa-solid fa-clock"></i> Cobro Pendiente (${pending.length})</h3>
      <div class="orders-section">${pending.length?pending.map(card).join(''):'<p style="color:var(--text-m);font-size:13px;margin-bottom:16px">Ninguno</p>'}</div>
      <h3 style="font-size:20px;color:var(--acc);margin:16px 0 8px"><i class="fa-solid fa-fire"></i> Activos (${active.length})</h3>
      <div class="orders-section">${active.length?active.map(card).join(''):'<p style="color:var(--text-m);font-size:13px;margin-bottom:16px">Ninguno</p>'}</div>
      <h3 style="font-size:20px;color:var(--green);margin:16px 0 8px"><i class="fa-solid fa-circle-check"></i> Cobrados</h3>
      <div class="orders-section">${paid.length?paid.slice(0,20).map(card).join(''):'<p style="color:var(--text-m);font-size:13px">Ninguno aún</p>'}</div>`;
  } catch (err) { c.innerHTML += `<p style="color:var(--red)">Error: ${err.message}</p>`; }
}

/* ─────────────────────────────────────────────
   MENU VIEW (staff)
───────────────────────────────────────────── */
async function renderMenuView(c) {
  c.innerHTML = `<div class="ph"><h2>Menú Completo</h2></div>`;
  if (!State.products.length) State.products = await API.getProducts({ status:'active' });
  const g = document.createElement('div'); g.className = 'menu-grid';
  g.innerHTML = State.products.filter(p=>p.status==='active').map(p => `
    <div class="pc">
      <div class="pc__img">${p.image?`<img class="prod-img-real" src="${p.image}" alt="${p.name}" loading="lazy">`:`<div class="pc__img-emoji">${p.emoji}</div>`}
        <span class="pc__cat ${getCatClass(p.category)}">${p.category}</span></div>
      <div class="pc__body"><div class="pc__name">${p.name}</div><div class="pc__desc">${p.description||''}</div>
        <div class="pc__footer"><span class="pc__price">${fmtCOP(p.price)}</span></div></div>
    </div>`).join('');
  c.appendChild(g);
}

/* ─────────────────────────────────────────────
   PRODUCTS ADMIN
───────────────────────────────────────────── */
async function renderProductsAdmin(c) {
  c.innerHTML = `<div class="ph-row"><div class="ph"><h2>Productos</h2></div>
    <button class="pill-btn pill-btn--accent" onclick="openProdModal()"><i class="fa-solid fa-plus"></i> Nuevo</button></div>
    <div class="admin-tbar">
      <input class="field-c" id="pt-search" style="max-width:220px" placeholder="Buscar…" oninput="renderProdTable()">
      <select class="field-c" id="pt-cat" style="max-width:160px" onchange="renderProdTable()">
        <option value="">Todas</option><option>Hamburguesas</option><option>Especiales</option>
        <option>Hot Dog</option><option>Bebidas</option><option>Infantil</option><option>Entradas</option>
      </select>
    </div>
    <div style="overflow-x:auto">
      <table class="pt"><thead><tr>
        <th></th><th>Nombre</th><th>Categoría</th><th>Costo</th><th>Precio</th><th>Margen</th><th>Estado</th><th>Acciones</th>
      </tr></thead><tbody id="pt-body"></tbody></table>
    </div>`;
  try {
    State.products = await API.getProducts();
    renderProdTable();
  } catch (err) { toast(err.message,'error'); }
}
function renderProdTable() {
  const tbody = $('pt-body'); if (!tbody) return;
  const q = ($('pt-search')?.value||'').toLowerCase();
  const cat = $('pt-cat')?.value||'';
  tbody.innerHTML = State.products.filter(p=>(!cat||p.category===cat)&&(!q||p.name.toLowerCase().includes(q))).map(p => {
    const mg = p.price>0 ? Math.round(((p.price-p.cost)/p.price)*100) : 0;
    const th = p.image ? `<div class="pt-thumb"><img src="${p.image}" alt="${p.name}"></div>` : `<div class="pt-thumb">${p.emoji}</div>`;
    return `<tr>
      <td>${th}</td>
      <td><strong>${p.name}</strong><br><span style="font-size:11px;color:var(--text-m)">${(p.description||'').substring(0,50)}…</span></td>
      <td><span class="badge ${getCatClass(p.category)}">${p.category}</span></td>
      <td style="font-family:'DM Mono',monospace;font-size:13px;color:var(--yellow)">${fmtCOP(p.cost)}</td>
      <td style="font-family:'Bebas Neue',sans-serif;font-size:18px;color:var(--acc)">${fmtCOP(p.price)}</td>
      <td><span class="badge ${mg>=40?'badge-green':mg>=20?'badge-acc':'badge-red'}">${mg}%</span></td>
      <td><span class="badge ${p.status==='active'?'badge-green':'badge-red'}">${p.status==='active'?'Activo':'Inactivo'}</span></td>
      <td><div style="display:flex;gap:6px">
        <button class="pill-btn pill-btn--sm" onclick="openProdModal(${p.id})"><i class="fa-solid fa-pen"></i></button>
        <button class="pill-btn pill-btn--sm ${p.status==='active'?'pill-btn--danger':''}" onclick="toggleProdStatus(${p.id})">
          <i class="fa-solid ${p.status==='active'?'fa-eye-slash':'fa-eye'}"></i></button>
        <button class="pill-btn pill-btn--sm pill-btn--danger" onclick="deleteProd(${p.id})"><i class="fa-solid fa-trash"></i></button>
      </div></td>
    </tr>`;
  }).join('');
}
function openProdModal(id) {
  const modal = $('modal-product');
  $('mp-id').value = id || '';
  $('mp-title').textContent = id ? 'Editar Producto' : 'Nuevo Producto';
  if (id) {
    const p = State.products.find(x=>x.id===id); if (!p) return;
    $('mp-name').value = p.name; $('mp-desc').value = p.description||'';
    $('mp-emoji').value = p.emoji; $('mp-cat').value = p.category;
    $('mp-price').value = p.price; $('mp-cost').value = p.cost||0;
    $('mp-status').value = p.status; $('mp-img').value = p.image||'';
    setProdImgPrev(p.image||null, p.emoji||'🍔');
  } else {
    ['mp-name','mp-desc','mp-emoji','mp-price','mp-cost'].forEach(k=>$(k).value='');
    $('mp-cat').value='Hamburguesas'; $('mp-status').value='active'; $('mp-img').value='';
    setProdImgPrev(null,'🍔');
  }
  modal.classList.remove('hidden');
}
async function saveProduct() {
  const id = $('mp-id').value;
  const data = {
    name: $('mp-name').value.trim(), description: $('mp-desc').value.trim(),
    emoji: $('mp-emoji').value.trim() || CAT_EMOJI[$('mp-cat').value] || '🍔',
    image: $('mp-img').value || null, category: $('mp-cat').value,
    price: parseInt($('mp-price').value), cost: parseInt($('mp-cost').value)||0,
    status: $('mp-status').value,
  };
  if (!data.name || !data.price) { toast('Nombre y precio son obligatorios','error'); return; }
  try {
    if (id) { await API.updateProduct(parseInt(id), data); toast(`${data.name} actualizado ✅`,'success'); }
    else    { await API.createProduct(data);               toast(`${data.name} creado ✅`,'success'); }
    State.products = await API.getProducts();
    closeModal('modal-product'); renderProdTable();
  } catch (err) { toast(err.message,'error'); }
}
async function toggleProdStatus(id) {
  const p = State.products.find(x=>x.id===id); if (!p) return;
  try {
    await API.updateProduct(id, { ...p, status: p.status==='active'?'inactive':'active' });
    State.products = await API.getProducts();
    toast(`${p.name} ${p.status==='active'?'desactivado':'activado'}`, p.status==='active'?'info':'success');
    renderProdTable();
  } catch (err) { toast(err.message,'error'); }
}
async function deleteProd(id) {
  if (!confirm('¿Eliminar este producto?')) return;
  try {
    await API.deleteProduct(id);
    State.products = await API.getProducts();
    toast('Producto eliminado','error'); renderProdTable();
  } catch (err) { toast(err.message,'error'); }
}
function setProdImgPrev(img, emoji) {
  const prev=$('img-prev'), up=$('img-up');
  if (img) { prev.innerHTML=`<img src="${img}" alt="preview">`; up?.classList.add('has-img'); }
  else     { prev.innerHTML=`<span style="font-size:44px">${emoji||'🍔'}</span>`; up?.classList.remove('has-img'); }
}
function loadImg(input) {
  const file = input.files[0]; if (!file) return;
  if (file.size > 2*1024*1024) { toast('La imagen no debe superar 2 MB','error'); input.value=''; return; }
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const max=800; let w=img.width, h=img.height;
      if(w>max||h>max){ if(w>h){h=Math.round(h*max/w);w=max;}else{w=Math.round(w*max/h);h=max;} }
      const cv=document.createElement('canvas'); cv.width=w; cv.height=h;
      cv.getContext('2d').drawImage(img,0,0,w,h);
      const b64=cv.toDataURL('image/jpeg',.82);
      $('mp-img').value=b64; setProdImgPrev(b64,'🍔');
      toast('Imagen cargada ✅','success');
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file); input.value='';
}
function clearImg() { $('mp-img').value=''; setProdImgPrev(null,$('mp-emoji')?.value||'🍔'); toast('Imagen eliminada','info'); }

/* ─────────────────────────────────────────────
   USERS ADMIN
───────────────────────────────────────────── */
async function renderUsersAdmin(c) {
  c.innerHTML = `<div class="ph-row">
    <div class="ph"><h2>Usuarios</h2></div>
    <button class="pill-btn pill-btn--accent" onclick="promptNewUser()"><i class="fa-solid fa-plus"></i> Nuevo Usuario</button>
  </div><p style="color:var(--text-m)">Cargando…</p>`;
  try {
    const users = await API.getUsers();
    c.innerHTML = `<div class="ph-row">
      <div class="ph"><h2>Usuarios</h2></div>
      <button class="pill-btn pill-btn--accent" onclick="promptNewUser()"><i class="fa-solid fa-plus"></i> Nuevo Usuario</button>
    </div>
    <div style="overflow-x:auto"><table class="pt">
      <thead><tr><th>Usuario</th><th>Nombre</th><th>Rol</th><th>Estado</th><th>Acciones</th></tr></thead>
      <tbody>
        ${users.map(u=>`<tr>
          <td><span style="font-family:'DM Mono',monospace;font-size:12px;color:var(--acc)">${u.username}</span></td>
          <td><strong>${u.name}</strong></td>
          <td><span class="badge ${u.role==='boss'?'badge-acc':u.role==='kitchen'?'badge-green':'badge-blue'}">${{boss:'Jefe',waiter:'Mesero',kitchen:'Cocina'}[u.role]||u.role}</span></td>
          <td><span class="badge ${u.active?'badge-green':'badge-red'}">${u.active?'Activo':'Inactivo'}</span></td>
          <td><div style="display:flex;gap:6px">
            <button class="pill-btn pill-btn--sm" onclick="changeUserPass(${u.id})"><i class="fa-solid fa-key"></i></button>
            ${u.id!==State.user.id?`<button class="pill-btn pill-btn--sm ${u.active?'pill-btn--danger':''}" onclick="doToggleUser(${u.id})">${u.active?'Desactivar':'Activar'}</button>`:''}
          </div></td>
        </tr>`).join('')}
      </tbody>
    </table></div>`;
  } catch (err) { c.innerHTML += `<p style="color:var(--red)">Error: ${err.message}</p>`; }
}
async function changeUserPass(id) {
  const np = prompt('Nueva contraseña (mínimo 4 caracteres):'); if (!np||np.length<4) return;
  try { await API.changePassword(id, np); toast('Contraseña actualizada ✅','success'); }
  catch (err) { toast(err.message,'error'); }
}
async function doToggleUser(id) {
  try { const r=await API.toggleUser(id); toast(`Usuario ${r.active?'activado':'desactivado'}`,r.active?'success':'info'); renderUsersAdmin($('st-content')); }
  catch (err) { toast(err.message,'error'); }
}
async function promptNewUser() {
  const name     = prompt('Nombre completo:'); if (!name) return;
  const username = prompt('Nombre de acceso (sin espacios):'); if (!username) return;
  const password = prompt('Contraseña:'); if (!password||password.length<4) { toast('Contraseña mínimo 4 caracteres','error'); return; }
  const roleNum  = prompt('Rol:\n1 = Mesero\n2 = Jefe\n3 = Cocina'); 
  const role = { '1':'waiter','2':'boss','3':'kitchen' }[roleNum];
  if (!role) { toast('Rol inválido','error'); return; }
  try { await API.createUser({ username, password, role, name }); toast(`${name} creado ✅`,'success'); renderUsersAdmin($('st-content')); }
  catch (err) { toast(err.message,'error'); }
}

/* ─────────────────────────────────────────────
   REPORTS
───────────────────────────────────────────── */
// ── Helper: render una tarjeta de jornada con productos ──────────
function _renderDayCard(d, prods) {
  const net = d.net_profit || 0;
  const prodsHTML = prods && prods.length ? `
    <div class="rcard-prods">
      <div class="rcard-prods-title">
        <i class="fa-solid fa-chart-bar"></i> Productos vendidos en esta jornada
      </div>
      <table class="rcard-prods-table">
        <thead>
          <tr>
            <th style="text-align:left">Producto</th>
            <th style="text-align:left">Categoría</th>
            <th style="text-align:center">Cant. vendida</th>
            <th style="text-align:right">Ingresos</th>
            <th style="text-align:right">Ganancia</th>
          </tr>
        </thead>
        <tbody>
          ${prods.map((p,i) => `
            <tr class="${i%2===0?'':'rp-alt'}">
              <td class="rp-name">${p.emoji||''} ${p.product_name}</td>
              <td class="rp-cat">${p.category}</td>
              <td class="rp-qty">${p.units_sold}</td>
              <td class="rp-rev">${fmtCOP(p.total_revenue)}</td>
              <td class="rp-profit" style="color:${parseInt(p.total_profit)>=0?'var(--green)':'var(--red)'}">${fmtCOP(p.total_profit)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>` : '';

  return `<div class="rcard">
    <div class="rcard-head">
      <div>
        <h4>${d.date_label||fmtDate(d.opened_at)}</h4>
        <span style="font-size:12px;color:var(--text-m)">Apertura: ${fmtTime(d.opened_at)}${d.closed_at?` · Cierre: ${fmtTime(d.closed_at)}`:''}</span>
      </div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <span class="badge ${d.status==='open'?'badge-green':'badge-acc'}">${d.status==='open'?'🟢 Abierta':'🔒 Cerrada'}</span>
        ${d.status==='open'?`<button class="pill-btn pill-btn--sm pill-btn--danger" onclick="openCloseDayModal()"><i class="fa-solid fa-lock"></i> Cerrar</button>`:''}
      </div>
    </div>
    <div class="rcard-metrics">
      <div class="rm"><div class="rm-l">Inversión</div><div class="rm-v" style="color:var(--yellow)">${fmtCOP(d.total_investment||0)}</div></div>
      <div class="rm"><div class="rm-l">Ventas</div><div class="rm-v" style="color:var(--acc)">${fmtCOP(d.total_sales||0)}</div></div>
      <div class="rm"><div class="rm-l">Costo prod.</div><div class="rm-v" style="color:var(--text-m)">${fmtCOP(d.total_cost||0)}</div></div>
      <div class="rm"><div class="rm-l">Gan. bruta</div><div class="rm-v" style="color:${(d.gross_profit||0)>=0?'var(--green)':'var(--red)'}">${fmtCOP(d.gross_profit||0)}</div></div>
      <div class="rm"><div class="rm-l">Gan. neta</div><div class="rm-v" style="color:${net>=0?'var(--green)':'var(--red)'}; font-size:24px">${fmtCOP(net)}</div></div>
      <div class="rm"><div class="rm-l">Pedidos</div><div class="rm-v">${d.paid_orders_count||0}</div></div>
    </div>
    ${d.investments?.length?`<div class="rcard-inv"><h5><i class="fa-solid fa-boxes-stacking"></i> Inversiones</h5>
      ${d.investments.map(i=>`<div class="ri"><span>${i.description}</span><span style="color:var(--yellow);font-family:'DM Mono',monospace">${fmtCOP(i.amount)}</span></div>`).join('')}
    </div>`:''}
    ${prodsHTML}
  </div>`;
}

async function renderReports(c) {
  c.innerHTML = `<div class="ph-row"><div class="ph"><h2>Reporte Diario</h2><p>Cargando…</p></div></div>`;
  try {
    const days = await API.getDays();

    // Renderizar estructura base
    c.innerHTML = `
      <div class="ph-row">
        <div class="ph"><h2>Reporte Diario</h2><p>Historial de jornadas · inversión, ventas y ganancias</p></div>
        ${!State.currentDay?`<button class="pill-btn pill-btn--green" onclick="openOpenModal()"><i class="fa-solid fa-store"></i> Nueva Jornada</button>`:''}
      </div>
      ${days.length
        ? `<div class="report-list" id="report-list-inner">
            ${days.map(d => `<div id="rcard-${d.id}" class="rcard-loading">
              <div style="padding:20px;color:var(--text-m);font-size:13px">
                <i class="fa-solid fa-spinner fa-spin"></i> Cargando jornada ${d.date_label||''}…
              </div></div>`).join('')}
           </div>`
        : `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:300px;gap:14px;color:var(--text-m)">
            <i class="fa-solid fa-chart-line" style="font-size:48px;color:var(--text-dim)"></i>
            <p style="font-size:15px;font-weight:600">No hay jornadas registradas aún</p>
            <button class="pill-btn pill-btn--green" onclick="openOpenModal()"><i class="fa-solid fa-store"></i> Abrir Primera Jornada</button>
           </div>`
      }`;

    // Cargar productos de cada jornada de forma asíncrona y renderizar una a una
    for (const d of days) {
      const slot = document.getElementById(`rcard-${d.id}`);
      if (!slot) continue;
      try {
        const prods = await API.getDayProducts(d.id).catch(() => []);
        slot.outerHTML = _renderDayCard(d, prods);
      } catch {
        slot.outerHTML = _renderDayCard(d, []);
      }
    }

  } catch (err) {
    c.innerHTML += `<p style="color:var(--red);padding:16px">Error al cargar reportes: ${err.message}</p>`;
  }
}

/* ─────────────────────────────────────────────
   KITCHEN VIEW
───────────────────────────────────────────── */
function bootKitchen() {
  showApp('kitchen');
  State.knownOrders = [];

  // ── Función independiente para actualizar el badge del local ──
  async function kitchCheckStatus() {
    try {
      const r = await fetch('/api/days/status', { cache:'no-store' });
      const s = r.ok ? await r.json().catch(()=>({})) : {};
      const prevOpen = !!State.currentDay;
      State.currentDay = s.open ? s : null;
      if (prevOpen !== !!State.currentDay) updateLocalBadges();
    } catch {}
  }

  // Consultar estado inmediatamente al arrancar
  kitchCheckStatus().then(() => updateLocalBadges());

  renderKitchen();
  if (State.kitchTimer) clearInterval(State.kitchTimer);

  // Timer de pedidos (cada 8s) — independiente del estado del local
  State.kitchTimer = setInterval(async () => {
    // 1. Siempre actualizar el estado del local primero (no necesita token)
    await kitchCheckStatus();

    // 2. Luego intentar cargar pedidos (necesita token)
    try {
      const orders = await API.getKitchenOrders();
      if (!Array.isArray(orders)) return;
      Cache.set('mb_kitch_orders', orders);
      const newIds = orders.map(o=>o.id).filter(id => !State.knownOrders.includes(id));
      if (newIds.length) { if (_kitchSound) playKitchBeep(); toast(`¡${newIds.length} pedido(s) nuevo(s)!`,'warning'); }
      State.knownOrders = orders.map(o=>o.id);
      _renderKitchenOrders(orders);
    } catch {
      const cached = Cache.get('mb_kitch_orders', 60 * 60 * 1000);
      if (cached) _renderKitchenOrders(cached);
    }
  }, 8000);
  // Initial load
  API.getKitchenOrders()
    .then(orders => {
      if (!Array.isArray(orders)) return;
      Cache.set('mb_kitch_orders', orders);
      State.knownOrders = orders.map(o=>o.id);
      _renderKitchenOrders(orders);
    })
    .catch(() => {
      const cached = Cache.get('mb_kitch_orders', 60 * 60 * 1000);
      if (cached) { State.knownOrders = cached.map(o=>o.id); _renderKitchenOrders(cached); }
    });
}
function kitchTab(tab, btn) {
  State.kitchTab = tab;
  document.querySelectorAll('.kitch-tab').forEach(b=>b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  API.getKitchenOrders().then(orders => _renderKitchenOrders(orders)).catch(()=>{});
}
function kitchTypeFilter(type, btn) {
  State.kitchTableType = type || null; // null = all types
  document.querySelectorAll('.kitch-type-btn').forEach(b=>b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  API.getKitchenOrders().then(orders => _renderKitchenOrders(orders)).catch(()=>{});
}
async function renderKitchen() {
  try { const orders = await API.getKitchenOrders(); _renderKitchenOrders(orders); } catch {}
}
function _renderKitchenOrders(orders) {
  // Filter by table type if selected
  const typeFiltered = State.kitchTableType
    ? orders.filter(o => o.table_type === State.kitchTableType)
    : orders;

  // Counts for tabs
  const fc = orders.filter(o=>(o.items||[]).filter(i=>i.status==='active').some(i=>!isBev(i.category))).length;
  const dc = orders.filter(o=>(o.items||[]).filter(i=>i.status==='active').some(i=>isBev(i.category))).length;
  const kc1=$('kc-food');    if(kc1)kc1.textContent=fc;
  const kc2=$('kc-drinks');  if(kc2)kc2.textContent=dc;
  const tm=$('kc-mesa'); const td=$('kc-dom'); const tpl=$('kc-llevar');
  if(tm)  tm.textContent=orders.filter(o=>o.table_type==='mesa').length;
  if(td)  td.textContent=orders.filter(o=>o.table_type==='domicilio').length;
  if(tpl) tpl.textContent=orders.filter(o=>o.table_type==='para_llevar').length;

  const container = $('kitch-content'); if (!container) return;

  // Filtrar pedidos que tengan al menos algún ítem activo
  const visible = typeFiltered.filter(o => (o.items||[]).some(i=>i.status==='active'));
  if (!visible.length) {
    container.innerHTML = `<div class="kitch-empty"><i class="fa-solid fa-check-circle"></i><h3>Sin pedidos</h3><p>No hay pedidos pendientes</p></div>`;
    return;
  }

  // Función para renderizar una tarjeta de pedido mostrando comida y/o bebidas
  function renderKoCard(o, showFood, showDrinks) {
    const ttype = o.table_type || 'mesa';
    const tLabel = ttype==='mesa' ? `Mesa ${o.table_number} · Piso ${o.table_floor}`
                  : ttype==='domicilio' ? `Domicilio ${o.table_number}`
                  : `Para llevar ${o.table_number}`;
    const tIcon = {mesa:'🪑', domicilio:'🛵', para_llevar:'🥡'}[ttype] || '🪑';
    const allActive = (o.items||[]).filter(i => i.status==='active');
    const foodItems  = allActive.filter(i => !isBev(i.category));
    const drinkItems = allActive.filter(i =>  isBev(i.category));
    const itemsToShow = [
      ...(showFood   ? foodItems  : []),
      ...(showDrinks ? drinkItems : []),
    ];
    if (!itemsToShow.length) return '';
    const mins = elapsed(o.created_at); const isNew = mins < 2;
    const foodHtml  = showFood  ? foodItems.map(it  => renderKoItem(it)).join('') : '';
    const divider   = (showFood && showDrinks && foodItems.length && drinkItems.length)
      ? '<div class="ki-divider"><i class="fa-solid fa-wine-glass"></i> Bebidas</div>' : '';
    const drinkHtml = showDrinks ? drinkItems.map(it => renderKoItem(it)).join('') : '';
    return `<div class="ko${isNew?' new-order':''} ko-type-${ttype}">
      <div class="ko-head">
        <div>
          <h4>${tIcon} ${tLabel}</h4>
          <div class="ko-meta">Pedido #${o.id} · ${fmtTime(o.created_at)}${o.status==='pending'?' · <span style="color:var(--yellow)">Listo para cobrar</span>':''}</div>
        </div>
        <div class="ko-timer ${timerClass(o.created_at)}">${elapsedStr(o.created_at)}</div>
      </div>
      <div class="ko-items">${foodHtml}${divider}${drinkHtml}</div>
    </div>`;
  }

  function renderKoItem(it) {
    return `<div class="ko-item ${isBev(it.category)?'ko-item--drink':''}">
      ${it.image?`<img src="${it.image}" style="width:36px;height:36px;border-radius:6px;object-fit:cover;flex-shrink:0">`:`<span class="ki-em">${it.emoji||'🍔'}</span>`}
      <div class="ki-info">
        <div class="ki-name">${it.product_name||'?'} ${it.bread_type?`<span class="ki-bread">${it.bread_type==='platano'?'🍌 Plátano':'🍞 Pan'}</span>`:''}</div>
        ${it.notes?`<div class="ki-notes">${it.notes}</div>`:''}
      </div>
      <div class="ki-qty">×${it.quantity}</div>
    </div>`;
  }

  // Mostrar todo: comida arriba, bebidas abajo dentro de cada tarjeta
  container.innerHTML = `<div class="kitch-grid">${visible.map(o => renderKoCard(o, true, true)).join('')}</div>`;
}

/* ─────────────────────────────────────────────
   IMPRESIÓN DE RECIBO / FACTURA
───────────────────────────────────────────── */
function printDocument(order, payMethod, type) {
  const isInvoice = type === 'invoice';
  const items     = order.items.filter(i => i.status === 'active');
  const total     = orderTotal(order.items);
  const now       = new Date();
  const dateStr   = now.toLocaleDateString('es-CO', { year:'numeric', month:'long', day:'numeric' });
  const timeStr   = now.toLocaleTimeString('es-CO', { hour:'2-digit', minute:'2-digit' });
  const tableName = order.table_type === 'mesa'
    ? `Mesa ${order.table_number} · Piso ${order.table_floor}`
    : order.table_type === 'domicilio'
    ? `Domicilio ${order.table_number}`
    : `Para llevar ${order.table_number}`;
  const payLabels = { efectivo:'Efectivo', nequi:'Nequi', bancolombia:'Bancolombia', tarjeta:'Tarjeta' };

  const win = window.open('', '_blank', 'width=400,height=600');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>${isInvoice ? 'Factura' : 'Recibo'} #${order.id}</title>
    <style>
      * { margin:0; padding:0; box-sizing:border-box; }
      body { font-family: 'Courier New', monospace; font-size: 13px; color: #000; padding: 16px; max-width: 320px; margin: 0 auto; }
      .center { text-align: center; }
      .bold   { font-weight: bold; }
      .big    { font-size: 18px; font-weight: bold; }
      .line   { border-top: 1px dashed #000; margin: 8px 0; }
      .line2  { border-top: 2px solid #000; margin: 8px 0; }
      .row    { display: flex; justify-content: space-between; margin: 3px 0; }
      .row .name { flex: 1; margin-right: 8px; }
      .total-row { display: flex; justify-content: space-between; font-weight: bold; font-size: 15px; margin-top: 4px; }
      .footer { text-align: center; margin-top: 12px; font-size: 11px; }
      @media print { body { padding: 4px; } button { display: none; } }
    </style>
  </head><body>
    <div class="center big">MISTER BURGER</div>
    <div class="center" style="font-size:11px;margin-top:2px">Florencia, Caquetá</div>
    ${isInvoice ? '<div class="center bold" style="margin-top:6px;font-size:14px">FACTURA DE VENTA</div>' : '<div class="center" style="margin-top:6px">** RECIBO DE PAGO **</div>'}
    <div class="line2"></div>
    <div class="row"><span>${isInvoice ? 'Factura' : 'Recibo'} N°:</span><span><b>${order.id}</b></span></div>
    <div class="row"><span>Fecha:</span><span>${dateStr}</span></div>
    <div class="row"><span>Hora:</span><span>${timeStr}</span></div>
    <div class="row"><span>Mesa/Pedido:</span><span>${tableName}</span></div>
    ${order.waiter_name ? `<div class="row"><span>Atendido por:</span><span>${order.waiter_name}</span></div>` : ''}
    <div class="line"></div>
    <div class="bold" style="margin-bottom:4px">DETALLE DEL PEDIDO:</div>
    ${items.map(it => `
      <div class="row">
        <span class="name">${it.product_name}${it.bread_type ? ` (${it.bread_type === 'platano' ? 'Plátano' : 'Pan'})` : ''}</span>
        <span>${it.quantity} x ${fmtCOP(it.unit_price)}</span>
      </div>
      <div class="row" style="color:#555">
        <span></span>
        <span>${fmtCOP(it.unit_price * it.quantity)}</span>
      </div>`).join('')}
    <div class="line"></div>
    <div class="total-row"><span>TOTAL:</span><span>${fmtCOP(total)}</span></div>
    <div class="row"><span>Método de pago:</span><span>${payLabels[payMethod] || payMethod}</span></div>
    <div class="line2"></div>
    ${isInvoice ? `
      <div style="font-size:11px;margin:6px 0">
        <div>Régimen simplificado</div>
        <div>No somos responsables de IVA</div>
      </div>
      <div class="line"></div>` : ''}
    <div class="footer">
      ¡Gracias por su preferencia!<br>
      Vuelva pronto a Mister Burger
    </div>
    <div style="margin-top:16px;text-align:center">
      <button onclick="window.print()" style="padding:8px 20px;font-size:13px;cursor:pointer;border:1px solid #000;background:#fff">
        Imprimir
      </button>
    </div>
  </body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 500);
}

/* ─────────────────────────────────────────────
   MODALES — abrir / cerrar
───────────────────────────────────────────── */
function openModal(id) {
  const el = $(id);
  if (el) el.classList.remove('hidden');
}
function closeModal(id) {
  const el = $(id);
  if (el) el.classList.add('hidden');
}
// Cerrar modal al hacer click en el fondo oscuro
document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-wrap')) {
    e.target.classList.add('hidden');
  }
});

/* ─────────────────────────────────────────────
   LAYOUT CSS inline
───────────────────────────────────────────── */
(function injectCSS() {
  const s = document.createElement('style');
  s.textContent = `
    .tables-order-layout{display:grid;grid-template-columns:1fr 360px;gap:16px;align-items:start}
    .tables-panel{min-width:0}
    .order-side-panel{background:var(--bg-1);border:1px solid var(--border);border-radius:14px;padding:14px;display:flex;flex-direction:column;gap:10px;position:sticky;top:calc(var(--bar-h)+12px);max-height:calc(100vh - var(--bar-h) - 24px);overflow-y:auto}
    .order-side-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:180px;gap:10px;color:var(--text-dim);text-align:center}
    .order-side-empty i{font-size:36px}
    .order-side-empty p{font-size:12px;font-weight:600;line-height:1.5}
    .order-side-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;flex-wrap:wrap}
    .order-side-header h3{font-size:18px}
    .orders-section{display:flex;flex-direction:column;gap:10px;margin-bottom:8px}
    @media(max-width:900px){.tables-order-layout{grid-template-columns:1fr}.order-side-panel{position:static;max-height:none}}
  `;
  document.head.appendChild(s);
})();

/* ─────────────────────────────────────────────
   SONIDO COCINA
───────────────────────────────────────────── */
let _kitchSound = true;
function toggleKitchSound() {
  _kitchSound = !_kitchSound;
  const btn = $('kitch-sound-btn');
  if (btn) btn.innerHTML = _kitchSound
    ? '<i class="fa-solid fa-bell"></i>'
    : '<i class="fa-solid fa-bell-slash"></i>';
  toast(_kitchSound ? 'Sonido activado' : 'Sonido desactivado', 'info');
}
function playKitchBeep() {
  try {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.frequency.value = 880;
    osc.type = 'sine';
    gain.gain.setValueAtTime(0.4, ac.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + 0.4);
    osc.start(ac.currentTime);
    osc.stop(ac.currentTime + 0.4);
  } catch {}
}


/* ─────────────────────────────────────────────
   SELECTOR DE IMPRESIÓN EN COBRO
───────────────────────────────────────────── */
function selectPrintOpt(val, btn) {
  document.querySelectorAll('.print-opt-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  const el = $('pay-print-opt');
  if (el) el.value = val;
}
