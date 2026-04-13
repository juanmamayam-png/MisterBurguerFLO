// src/db/seed.js — Datos iniciales
require('dotenv').config();
const { pool, query } = require('./pool');
const bcrypt = require('bcryptjs');

async function seed() {
  console.log('[Seed] Insertando datos iniciales…');

  // ── Usuarios por defecto ────────────────────────────
  const users = [
    { username: 'jefe',   password: 'admin', role: 'boss',    name: 'Jefe Admin' },
    { username: 'mesero', password: '1234',  role: 'waiter',  name: 'Carlos M.'  },
    { username: 'maria',  password: '1234',  role: 'waiter',  name: 'María G.'   },
    { username: 'cocina', password: '1234',  role: 'kitchen', name: 'Cocina'     },
  ];

  for (const u of users) {
    const existing = await query('SELECT id FROM users WHERE username=$1', [u.username]);
    if (existing.rows.length === 0) {
      const hash = await bcrypt.hash(u.password, 10);
      await query(
        'INSERT INTO users (username, password, role, name) VALUES ($1,$2,$3,$4)',
        [u.username, hash, u.role, u.name]
      );
      console.log(`  [User] ✅ ${u.username} (${u.role})`);
    } else {
      console.log(`  [User] — ${u.username} ya existe, omitido`);
    }
  }

  // ── Mesas físicas (14 en Piso 1, 23 en Piso 2) ─────────
  for (let n = 1; n <= 14; n++) {
    const ex = await query('SELECT id FROM tables WHERE number=$1 AND floor=1 AND table_type=$2', [n,'mesa']);
    if (ex.rows.length === 0) {
      await query("INSERT INTO tables (number, floor, table_type, status) VALUES ($1,1,'mesa','free')", [n]);
    }
  }
  for (let n = 1; n <= 23; n++) {
    const ex = await query('SELECT id FROM tables WHERE number=$1 AND floor=2 AND table_type=$2', [n,'mesa']);
    if (ex.rows.length === 0) {
      await query("INSERT INTO tables (number, floor, table_type, status) VALUES ($1,2,'mesa','free')", [n]);
    }
  }
  console.log('  [Tables] ✅ 37 mesas físicas (Piso 1: 14, Piso 2: 23)');

  // ── Domicilios (100) ──────────────────────────────────
  for (let n = 1; n <= 100; n++) {
    const ex = await query('SELECT id FROM tables WHERE number=$1 AND table_type=$2', [n,'domicilio']);
    if (ex.rows.length === 0) {
      await query("INSERT INTO tables (number, floor, table_type, status) VALUES ($1,0,'domicilio','free')", [n]);
    }
  }
  console.log('  [Tables] ✅ 100 domicilios');

  // ── Para llevar (100) ─────────────────────────────────
  for (let n = 1; n <= 100; n++) {
    const ex = await query('SELECT id FROM tables WHERE number=$1 AND table_type=$2', [n,'para_llevar']);
    if (ex.rows.length === 0) {
      await query("INSERT INTO tables (number, floor, table_type, status) VALUES ($1,0,'para_llevar','free')", [n]);
    }
  }
  console.log('  [Tables] ✅ 100 para llevar');

  // ── Productos del menú ──────────────────────────────
  const products = [
    // HAMBURGUESAS
    { name:'Clásica',           desc:'Pan artesanal, queso, 150g carne 100% res, tomate, cebolla y lechuga',                                   emoji:'🍔', cat:'Hamburguesas', price:15000, cost:6000  },
    { name:'Tocineta',          desc:'Pan artesanal, queso, 150g carne 100% res, tocineta ahumada, tomate, cebolla y lechuga',                  emoji:'🥓', cat:'Hamburguesas', price:17500, cost:7500  },
    { name:'Mexicana',          desc:'Pan artesanal, queso, 150g carne, jalapeños, salsa de guacamole, tomate, cebolla y lechuga',              emoji:'🌶️',cat:'Hamburguesas', price:18500, cost:8000  },
    { name:'Vaquera',           desc:'Pan artesanal, queso, 150g carne 100% res, costilla ahumada a la plancha',                               emoji:'🤠', cat:'Hamburguesas', price:21500, cost:9500  },
    { name:'Campesina',         desc:'Pan artesanal, queso, 150g res maduro, huevo frito, chorizo, tocineta ahumada, maíz tierno',             emoji:'🌽', cat:'Hamburguesas', price:22000, cost:10000 },
    { name:'Criolla',           desc:'Pan artesanal, queso, 150g carne 100% res, tocineta ahumada, huevo frito, maíz tierno',                  emoji:'🥚', cat:'Hamburguesas', price:20500, cost:9000  },
    { name:'Cheddar',           desc:'Pan artesanal, queso, 150g carne 100% res, queso cheddar, tomate, cebolla y lechuga',                    emoji:'🧀', cat:'Hamburguesas', price:16000, cost:7000  },
    { name:'Ranchera',          desc:'Pan artesanal, queso, 150g carne 100% res, tocineta, chorizo, tomate, cebolla y lechuga',                emoji:'🔥', cat:'Hamburguesas', price:19000, cost:8500  },
    { name:'Paisa',             desc:'Arepa paisa, queso, 150g carne 100% res, huevo frito, chorizo, pimentón, cebolla, maíz tierno y tomate', emoji:'🫓', cat:'Hamburguesas', price:20000, cost:9000  },
    { name:'Callejera',         desc:'Pan artesanal, doble queso, 150g carne 100% res, tocineta ahumada, cebolla con salsa rosada',            emoji:'🌆', cat:'Hamburguesas', price:20000, cost:9000  },
    { name:'Hawaiana',          desc:'Pan artesanal, queso, 150g carne 100% res, piña melada, tomate, cebolla y lechuga',                     emoji:'🍍', cat:'Hamburguesas', price:17500, cost:8000  },
    { name:'Tentación',         desc:'Plátano maduro, doble queso, tocineta, carne 150g, huevo frito, lechuga y salsa dulce maíz',            emoji:'🍌', cat:'Hamburguesas', price:21000, cost:9500  },
    { name:'Trifásica',         desc:'Pan artesanal, triple carne (res, cerdo, pollo), triple queso crema, tomate, cebolla y lechuga',        emoji:'🏆', cat:'Hamburguesas', price:27000, cost:13000 },
    { name:'Marinera',          desc:'Pan artesanal, queso, 150g carne 100% res, camarones salteados con salsa especial',                     emoji:'🦐', cat:'Hamburguesas', price:21500, cost:10000 },
    { name:'Extrema Queso',     desc:'Pan artesanal, queso, 150g carne 100% res, tocineta ahumada, queso cheddar fundido, doble crema',       emoji:'🫕', cat:'Hamburguesas', price:25000, cost:11000 },
    { name:'Jumanji',           desc:'Pan artesanal, queso crema y cheddar, doble carne 100% res, doble porción de tocineta ahumada',         emoji:'🦁', cat:'Hamburguesas', price:22000, cost:10000 },
    { name:'Mister Burger',     desc:'Pan artesanal, doble queso, doble carne 100% res, tocineta ahumada, chorizo, huevo frito, maíz tierno', emoji:'⭐', cat:'Hamburguesas', price:25000, cost:12000 },
    { name:'Caqueteña',         desc:'Plátano, doble queso, 150g carne 100% res, pollo apanado, tocineta ahumada, chorizo, huevo frito',      emoji:'🌿', cat:'Hamburguesas', price:25000, cost:12000 },
    { name:'Ropa Vieja',        desc:'Pan artesanal, queso, 150g carne 100% res, carne desmechada bañada en salsa bolonesa',                 emoji:'🥘', cat:'Hamburguesas', price:21500, cost:9500  },
    { name:'Crunch',            desc:'Pan artesanal, queso, doble carne pollo apanado, tomate, cebolla y lechuga',                           emoji:'🍗', cat:'Hamburguesas', price:20500, cost:9000  },
    // ESPECIALES
    { name:'Parrillada',        desc:'Lomo fino de res, pechuga, lomo de cerdo, chorizo, patacón, papas a la francesa y ensalada',           emoji:'🥩', cat:'Especiales',   price:32000, cost:15000 },
    { name:'Pechuga Plancha',   desc:'Acompañamiento de papas a la francesa, ensalada. 2 opciones para el plato',                           emoji:'🍖', cat:'Especiales',   price:35000, cost:16000 },
    { name:'Baby Beef',         desc:'Lomo fino con papas a la francesa, pataconas, tocineta y ensalada',                                   emoji:'🥗', cat:'Especiales',   price:42000, cost:20000 },
    { name:'Patacón Especial',  desc:'Lomo fino de res, pechuga, lomo de cerdo, chorizo, patacón, maíz tierno, queso gratinado',            emoji:'🫔', cat:'Especiales',   price:32000, cost:14000 },
    { name:'Maicito',           desc:'Carne mixta, pollo, lomo fino de res, lomo de cerdo, cebolla grillé, papas a la francesa, 2 yucas',   emoji:'🌽', cat:'Especiales',   price:32000, cost:14000 },
    { name:'Chicharronuda',     desc:'Porción de costilla con chicharrón, patacón, papas a la francesa y ensalada',                         emoji:'🥓', cat:'Especiales',   price:42000, cost:19000 },
    { name:'Costillas BBQ',     desc:'Costillitas bañadas en salsa BBQ, papas a la francesa, patacón y ensalada',                           emoji:'🍖', cat:'Especiales',   price:32000, cost:14000 },
    { name:'Burrito',           desc:'Tortilla de trigo, queso, trozos de lomo fino, pechuga y lomo de cerdo, salsas y verduras',           emoji:'🌯', cat:'Especiales',   price:25000, cost:11000 },
    { name:'Alitas BBQ',        desc:'Alas de pollo bañadas en salsa BBQ, papas a la francesa y ensalada',                                  emoji:'🍗', cat:'Especiales',   price:23000, cost:10000 },
    { name:'Punta de Anca',     desc:'Corte fino de picaña a la plancha, papas a la francesa, yuquitas y ensalada',                         emoji:'🥩', cat:'Especiales',   price:43000, cost:20000 },
    { name:'Ensalada Mister',   desc:'Trocitos de pollo, piña, huevos de codorniz, patacón, queso, lechuga, maíz tierno',                   emoji:'🥗', cat:'Especiales',   price:22000, cost:9000  },
    { name:'Lomo de Cerdo',     desc:'Cerdo a la plancha, papas a la francesa y ensalada',                                                  emoji:'🐷', cat:'Especiales',   price:43000, cost:19000 },
    { name:'Churrasco',         desc:'Lomo ancho a la plancha, chimichurri, papas a la francesa y ensalada',                               emoji:'🥩', cat:'Especiales',   price:43000, cost:19000 },
    { name:'Bistec a Caballo',  desc:'Lomo de res a la plancha con hogao, papas a la francesa, 2 huevos fritos y ensalada',                emoji:'🍳', cat:'Especiales',   price:43000, cost:19000 },
    // HOT DOGS
    { name:'Hot Dog Sencillo',  desc:'Pan, salchicha, queso, papa ripio',                              emoji:'🌭', cat:'Hot Dog',    price:12500, cost:4500  },
    { name:'Hot Dog Hawaiano',  desc:'Con melao de piña',                                              emoji:'🍍', cat:'Hot Dog',    price:14000, cost:5500  },
    { name:'Hot Dog Especial',  desc:'Con tocineta y cebolla grillé',                                  emoji:'🌭', cat:'Hot Dog',    price:15000, cost:6000  },
    { name:'Hot Dog Mexicano',  desc:'Con jalapeños y salsa guacamole',                                emoji:'🌶️',cat:'Hot Dog',    price:15000, cost:6000  },
    { name:'Hot Dog Mister',    desc:'Con tocineta, chorizo, maíz, huevos de codorniz',                emoji:'⭐', cat:'Hot Dog',    price:18500, cost:7500  },
    // BEBIDAS
    { name:'Limonada Natural',  desc:'Fresca y natural',           emoji:'🍋', cat:'Bebidas', price:6000,  cost:2000 },
    { name:'Limonada de Coco',  desc:'Refrescante con coco',       emoji:'🥥', cat:'Bebidas', price:11000, cost:4000 },
    { name:'Limonada Yerbabuena',desc:'Con hierbabuena fresca',    emoji:'🌿', cat:'Bebidas', price:11000, cost:4000 },
    { name:'Mandarinada',       desc:'Jugo natural de mandarina',  emoji:'🍊', cat:'Bebidas', price:11000, cost:4000 },
    { name:'Naranjada',         desc:'Jugo natural de naranja',    emoji:'🍊', cat:'Bebidas', price:11000, cost:4000 },
    { name:'Piña Colada',       desc:'Piña colada tropical',       emoji:'🍹', cat:'Bebidas', price:12000, cost:4500 },
    { name:'Cerveza Nacional',  desc:'Fría y refrescante',         emoji:'🍺', cat:'Bebidas', price:6000,  cost:3000 },
    { name:'Jugo Arazá',        desc:'Exótico jugo amazónico',     emoji:'🍹', cat:'Bebidas', price:11000, cost:4000 },
    // INFANTIL
    { name:'Hot Dog Kids',      desc:'Mini perro americano, papitas, jugo hit o pony mini y nucita',   emoji:'🌭', cat:'Infantil',  price:18500, cost:7000  },
    { name:'Burger Kids',       desc:'Hamburguesa mini, papitas, jugo hit o pony mini y nucita',       emoji:'🍔', cat:'Infantil',  price:18500, cost:7000  },
    { name:'Nuggets Kids',      desc:'Nuggets de pollo, papitas, jugo hit o pony mini y nucita',       emoji:'🍗', cat:'Infantil',  price:16500, cost:6000  },
    { name:'Papitas Cheddar',   desc:'Papitas con queso cheddar, tocineta, jugo hit o pony y nucita',  emoji:'🧀', cat:'Infantil',  price:16500, cost:6000  },
    // ENTRADAS
    { name:'Patacones Hogao',   desc:'Patacones con hogao casero',         emoji:'🫓', cat:'Entradas', price:7000, cost:2500 },
    { name:'Arepas Hogao',      desc:'Arepas tradicionales con hogao',     emoji:'🫓', cat:'Entradas', price:7000, cost:2500 },
    { name:'Papas Criollas',    desc:'Papas criollas fritas',              emoji:'🥔', cat:'Entradas', price:7000, cost:2500 },
    { name:'Aritos de Cebolla', desc:'Anillos de cebolla fritos',          emoji:'🧅', cat:'Entradas', price:8000, cost:3000 },
    { name:'Deditos',           desc:'Deditos de queso fritos',            emoji:'🧆', cat:'Entradas', price:7000, cost:2500 },
    { name:'Yuquitas',          desc:'Yuca frita crujiente',               emoji:'🌿', cat:'Entradas', price:7000, cost:2500 },
  ];

  let inserted = 0;
  for (const p of products) {
    const ex = await query('SELECT id FROM products WHERE name=$1 AND category=$2', [p.name, p.cat]);
    if (ex.rows.length === 0) {
      await query(
        'INSERT INTO products (name, description, emoji, category, price, cost, status) VALUES ($1,$2,$3,$4,$5,$6,\'active\')',
        [p.name, p.desc, p.emoji, p.cat, p.price, p.cost]
      );
      inserted++;
    }
  }
  console.log(`  [Products] ✅ ${inserted} productos insertados (${products.length - inserted} ya existían)`);

  console.log('[Seed] ✅ Datos iniciales listos');
  await pool.end();
}

seed().catch(err => { console.error('[Seed] ❌', err); process.exit(1); });
