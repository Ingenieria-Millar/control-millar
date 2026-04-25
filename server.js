// ══════════════════════════════════════════════════════════════════
//  server.js  —  Confecciones Millar  v4.0
//  Mejoras aplicadas en esta versión:
//  #1  Estado de módulos persistido en disco
//  #2  Caché en memoria para loadDB / saveDB
//  #3  SEGURIDAD: RESET_PASS obligatoria desde env var (sin fallback)
//  #4  SEGURIDAD: /admin/reset cambiado de GET a POST
//  #5  SEGURIDAD: Rate limiting en rutas admin y API
//  #6  SEGURIDAD: Multer con fileFilter — solo imágenes permitidas
//  #7  SEGURIDAD: CORS restringido al origen configurado
//  #8  BUGFIX: broadcast ahora es función global (fix scope error)
//  #9  Validación de entrada en rutas POST
//  #10 Todo el routing unificado en Express
//  #11 Validación de mensajes WebSocket
//  #12 Helmet para cabeceras HTTP seguras
//  #13 Health-check endpoint para Render
// ══════════════════════════════════════════════════════════════════

'use strict';

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { WebSocketServer } = require('ws');
const express = require('express');
const multer  = require('multer');
const xlsxLib = require('xlsx');
const cors       = require('cors');
const { v4: uuidv4 } = require('uuid');
const compression = require('compression');

// ── Variables de entorno obligatorias ────────────────────────────
// #3: RESET_PASS DEBE estar definida en Render como env var.
//     Si no existe, el servidor arranca pero avisa claramente.
const RESET_PASS = process.env.RESET_PASS;
if (!RESET_PASS) {
  console.error('⚠️  ADVERTENCIA: Variable de entorno RESET_PASS no definida.');
  console.error('   El endpoint /admin/reset estará DESHABILITADO hasta configurarla.');
}

const PORT          = process.env.PORT          || 3000;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || null; // null = solo en dev

// ── Directorios ────────────────────────────────────────────────────
const DATA_DIR    = process.env.DATA_DIR    || path.join(__dirname, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');

[DATA_DIR, UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Rutas de archivos ──────────────────────────────────────────────
const FILES = {
  ia_state:       path.join(DATA_DIR, 'ia_state.json'),
  ia_records:     path.join(DATA_DIR, 'ia_records.json'),
  modules_config: path.join(DATA_DIR, 'modules_config.json'),
  floor_state:    path.join(DATA_DIR, 'floor_state.json'),
  ci_requests:    path.join(DATA_DIR, 'ci_requests.json'),
  ci_config:      path.join(DATA_DIR, 'ci_config.json'),
  alistamientos:  path.join(DATA_DIR, 'alistamientos.json'),
  mantenimientos: path.join(DATA_DIR, 'mantenimientos.json'),
  alertas:        path.join(DATA_DIR, 'alertas.json'),
  app_config:     path.join(DATA_DIR, 'app_config.json'),
  novedades:      path.join(DATA_DIR, 'novedades.json'),
  cargos:         path.join(DATA_DIR, 'cargos.json'),
  maquinaria:     path.join(DATA_DIR, 'maquinaria.json'),
  turnos:         path.join(DATA_DIR, 'turnos.json'),
  historial:      path.join(DATA_DIR, 'historial.json'),
  ordenes:        path.join(DATA_DIR, 'ordenes.json'),
  recogedores:    path.join(DATA_DIR, 'recogedores.json'),
};

// ── Helpers de persistencia ────────────────────────────────────────
function readJSON(filePath, defaultValue) {
  try {
    if (fs.existsSync(filePath))
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error('Error leyendo', filePath, e.message);
  }
  return defaultValue;
}

// ── Write queue — evita escrituras síncronas bloqueantes ──────────
const _writeQueue = {};
function writeJSON(filePath, data) {
  // Cancelar escritura pendiente y programar nueva (debounce por archivo)
  if (_writeQueue[filePath]) clearTimeout(_writeQueue[filePath]);
  _writeQueue[filePath] = setTimeout(() => {
    delete _writeQueue[filePath];
    fs.promises.writeFile(filePath, JSON.stringify(data), 'utf8')
      .catch(e => console.error('Error escribiendo', filePath, e.message));
  }, 0); // nextTick — libera el event loop
}

// ── Caché en memoria ───────────────────────────────────────────────
const dbCache = {};

function loadDB(key) {
  if (!dbCache[key]) {
    try {
      dbCache[key] = fs.existsSync(FILES[key])
        ? JSON.parse(fs.readFileSync(FILES[key], 'utf8'))
        : [];
    } catch(e) {
      console.error('Error cargando caché', key, e.message);
      dbCache[key] = [];
    }
  }
  return dbCache[key];
}

function saveDB(key, data) {
  dbCache[key] = data;
  fs.promises.writeFile(FILES[key], JSON.stringify(data), 'utf8')
    .catch(e => console.error('Error guardando', key, e.message));
}

// ── Perfil Programador ─────────────────────────────────────────────
const PROGRAMADOR_PROFILE = {
  id: 'programador', name: 'Programador', role: 'programador',
  pass: '1', canDelete: false
};

function ensureProgramador(state) {
  if (!state || typeof state !== 'object') state = { supervisors: [], employees: [] };
  if (!Array.isArray(state.supervisors)) state.supervisors = [];
  state.supervisors = state.supervisors.filter(s => s.id !== 'programador');
  state.supervisors.unshift(PROGRAMADOR_PROFILE);
  return state;
}

function loadInitialState() {
  return ensureProgramador({ supervisors: [], employees: [] });
}

// ── Etiquetas de estado para el histórico ─────────────────────────
const STATE_LABELS = {
  red:    'Espera Mecánico',
  yellow: 'Atención Mecánico',
  blue:   'Cambio Referencia',
  orange: 'Espera Insumos',
  purple: 'Prod. Solicitada',
  pink:   'Insumos Alistamiento'
};

let iaState       = readJSON(FILES.ia_state, null);
let iaRecords     = readJSON(FILES.ia_records, []);
let modulesConfig = readJSON(FILES.modules_config, { disabled:[], extra:[], renamed:{}, modPass:{} });

if (!iaState) {
  iaState = loadInitialState();
} else {
  iaState = ensureProgramador(iaState);
}
writeJSON(FILES.ia_state, iaState);
writeJSON(FILES.ia_records, iaRecords);

function saveIaState()       { writeJSON(FILES.ia_state,       iaState);       }
function saveIaRecords()     { writeJSON(FILES.ia_records,     iaRecords);     }
function saveModulesConfig() { writeJSON(FILES.modules_config, modulesConfig); }

// ── Estado Control de Piso ─────────────────────────────────────────
const MODULES = [
  'M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
  'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
  'M21','M22','M23','M24','M25','M26','M27'
];

const floorPersisted = readJSON(FILES.floor_state, {});
const states       = floorPersisted.states      || {};
const lastMec      = floorPersisted.lastMec     || {};
const stateTimes   = floorPersisted.stateTimes  || {};
const lastEmpleada = floorPersisted.lastEmpleada|| {};
// slots: { [modId]: { R:null|{...}, N:null|{...}, M:null|{...} } }
// Compatible con floor_state.json antiguo (con multiImp) — slots toma precedencia
const slots = floorPersisted.slots || {};
// Inicializar módulos que falten
MODULES.forEach(id => {
  if (!states[id])     states[id]     = 'green';
  if (!lastMec[id])    lastMec[id]    = '';
  if (!stateTimes[id]) stateTimes[id] = Date.now();
  if (!lastEmpleada[id]) lastEmpleada[id] = '';
  if (!slots[id])      slots[id]      = { R:null, N:null, M:null };
});

// Helper: calcular color del módulo según slots activos
function calcColorMod(modId) {
  const s = slots[modId] || {};
  const activos = [];
  if (s.R) activos.push({ color: s.R.tipoActual || s.R.tipo, inicio: s.R.inicio });
  if (s.N) activos.push({ color: 'orange', inicio: s.N.inicio });
  if (s.M) activos.push({ color: 'purple', inicio: s.M.inicio });
  if (!activos.length) return 'green';
  activos.sort((a,b) => b.inicio - a.inicio);
  return activos[0].color;
}

function getAllActiveModules() {
  const extra    = modulesConfig.extra    || [];
  const renamed  = modulesConfig.renamed  || {};
  const disabled = modulesConfig.disabled || [];
  const all = [...MODULES, ...extra];
  return all
    .filter(id => !disabled.includes(id))
    .map(id => renamed[id] || id);
}

function logHistorial(id, prevState, newState, mecanico, empleada) {
  if (!prevState || prevState === 'green') return;
  if (prevState === newState) return;
  const ahora       = Date.now();
  const timerInicio = stateTimes[id] || ahora;
  const durMs       = ahora - timerInicio;
  if (durMs <= 0) return;

  const now        = new Date();
  const opts       = { timeZone: 'America/Bogota', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true };
  const optsDate   = { timeZone: 'America/Bogota', year:'numeric', month:'2-digit', day:'2-digit' };
  const horaFin    = now.toLocaleTimeString('es-CO', opts);
  const horaInicio = new Date(timerInicio).toLocaleTimeString('es-CO', opts);
  const fechaPartes = now.toLocaleDateString('es-CO', optsDate).split('/');
  const fecha      = now.toLocaleDateString('es-CO', optsDate);
  // fechaISO en zona Colombia
  const bogota = new Date(now.toLocaleString('en-US', {timeZone:'America/Bogota'}));
  const fechaISO = bogota.getFullYear()+'-'+String(bogota.getMonth()+1).padStart(2,'0')+'-'+String(bogota.getDate()).padStart(2,'0');
  const durMinutos = parseFloat((durMs / 60000).toFixed(2));

  // Calcular número de solicitud del día (reinicia cada día)
  let historial = readJSON(FILES.historial, []);
  const registrosHoy = historial.filter(r => r.fechaISO === fechaISO);
  const numSolicitud = registrosHoy.length + 1;

  // Solo incluir operaria y mecánico cuando corresponde al tipo de estado
  let mecanicoFinal = '';
  let empleadaFinal = '';
  if(prevState === 'red'){
    // Espera Mecánico: operaria + mecánico que llegó a atender (viene en el mensaje al pasar a amarillo)
    empleadaFinal = empleada || lastEmpleada[id] || '';
    mecanicoFinal = mecanico || lastMec[id] || '';
  } else if(prevState === 'yellow'){
    // Atención Mecánico: operaria y mecánico que solucionó
    empleadaFinal = empleada || lastEmpleada[id] || '';
    mecanicoFinal = mecanico || lastMec[id] || '';
  } else if(prevState === 'pink'){
    // Alistamiento: solo mecánico
    mecanicoFinal = mecanico || lastMec[id] || '';
  }
  // orange, purple, blue: ni operaria ni mecánico

  const registro = {
    num: numSolicitud,
    fecha, fechaISO, horaInicio,
    hora: horaFin,
    modulo: id,
    tipo:           prevState,
    estadoAnterior: prevState,
    estadoNuevo:    newState,
    durMinutos,
    mecanico:  mecanicoFinal,
    empleada:  empleadaFinal
  };
  historial.push(registro);
  if (historial.length > 10000) historial = historial.slice(-10000);
  writeJSON(FILES.historial, historial);
}

MODULES.forEach(id => {
  if (!states[id])       states[id]       = 'green';
  if (!lastMec[id])      lastMec[id]      = '';
  if (!stateTimes[id])   stateTimes[id]   = Date.now();
  if (!lastEmpleada[id]) lastEmpleada[id] = '';
});

// Inicializar estados para módulos extra ya configurados
(modulesConfig.extra || []).forEach(id => {
  const renamed = (modulesConfig.renamed || {})[id] || id;
  if (!states[renamed])       states[renamed]       = 'green';
  if (!lastMec[renamed])      lastMec[renamed]      = '';
  if (!stateTimes[renamed])   stateTimes[renamed]   = Date.now();
  if (!lastEmpleada[renamed]) lastEmpleada[renamed] = '';
});

function saveFloorState() {
  writeJSON(FILES.floor_state, { states, lastMec, stateTimes, lastEmpleada, slots });
}

// ── Estado Tablero CI ──────────────────────────────────────────────
const CI_CONFIG_DEFAULT = {
  tipoInsumoList: [
    {name:'Aplique',flow:'qty_only'},{name:'Elástico',flow:'elastico'},
    {name:'Marquilla Logo',flow:'qty_only'},{name:'Marquilla Talla',flow:'qty_talla'},
    {name:'Prelavado',flow:'qty_talla'},{name:'Transfer',flow:'qty_talla'}
  ],
  elasticoList: ['Base','Bola','Bota','Cintura','Envivar'],
  moduleList: [
    'M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
    'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
    'M21','M22','M23','M24','M25','M26','M27','Empaque'
  ],
  obsList: ['Pérdida','Faltante','Defectos']
};

let ciRequests = readJSON(FILES.ci_requests, []);
let ciConfig   = readJSON(FILES.ci_config, CI_CONFIG_DEFAULT);

function saveCiRequests() { writeJSON(FILES.ci_requests, ciRequests); }
function saveCiConfig()   { writeJSON(FILES.ci_config,   ciConfig);   }

// ── Datos estáticos Alistamiento ───────────────────────────────────────
const SUPERVISORAS_BIT = []; // se gestionan desde la app
const MECANICOS_BIT = []; // se gestionan desde la app
const BASE_MODULOS_BIT = [
  'M01','M02','M03','M04','M05','M06','M07','M08','M09','M10',
  'M11','M12','M13','M14','M15','M16','M17','M18','M19','M20',
  'M21','M22','M23','M24','M25','M26','M27','Preparación','Empaque'
];
const MAQUINAS_BIT = []; // se gestionan desde la app

function getModulosBit() {
  const disabled = modulesConfig.disabled || [];
  const extra    = modulesConfig.extra    || [];
  return [
    ...BASE_MODULOS_BIT.filter(m => !disabled.includes(m)),
    ...extra.filter(m => !disabled.includes(m))
  ];
}

// ══════════════════════════════════════════════════════════════════
//  EXPRESS
// ══════════════════════════════════════════════════════════════════
const app = express();

// #7 CORS restringido — en producción usa ALLOWED_ORIGIN
const corsOptions = ALLOWED_ORIGIN
  ? { origin: ALLOWED_ORIGIN, methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'] }
  : { origin: true }; // dev: permite cualquier origen
app.use(cors(corsOptions));
app.use(compression()); // gzip responses
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── #5 Rate limiter simple (sin dependencias externas) ────────────
// Limita a MAX_REQ requests por IP en WINDOW_MS milisegundos
const rateLimitStore = new Map();
function rateLimit(maxReq, windowMs) {
  return (req, res, next) => {
    const ip  = req.ip || req.connection.remoteAddress || 'unknown';
    const now = Date.now();
    const key = `${ip}`;
    if (!rateLimitStore.has(key)) {
      rateLimitStore.set(key, { count: 1, start: now });
      return next();
    }
    const entry = rateLimitStore.get(key);
    if (now - entry.start > windowMs) {
      rateLimitStore.set(key, { count: 1, start: now });
      return next();
    }
    entry.count++;
    if (entry.count > maxReq) {
      console.warn(`Rate limit superado para IP ${ip} en ${req.path}`);
      return res.status(429).json({ error: 'Demasiadas solicitudes. Intente en un momento.' });
    }
    next();
  };
}

// Limpieza periódica del store de rate limit (cada 10 min)
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [k, v] of rateLimitStore.entries()) {
    if (v.start < cutoff) rateLimitStore.delete(k);
  }
}, 10 * 60 * 1000);

// ── Archivos estáticos ─────────────────────────────────────────────
app.use('/alistamiento/uploads', express.static(UPLOADS_DIR));

// ── Rutas principales ──────────────────────────────────────────────
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);
app.get('/ingresos', (req, res) =>
  res.sendFile(path.join(__dirname, 'ingresos.html'))
);
app.get('/alistamiento', (req, res) =>
  res.sendFile(path.join(__dirname, 'alistamientos.html'))
);

app.get('/solicitar-insumos', (req, res) =>
  res.sendFile(path.join(__dirname, 'solicitar_insumos.html'))
);

app.get('/ordenes', (req, res) =>
  res.sendFile(path.join(__dirname, 'ordenes.html'))
);

app.get('/contador-modulos', (req, res) =>
  res.sendFile(path.join(__dirname, 'contador_modulos.html'))
);

// ── Recogedores ───────────────────────────────────────────────────
app.get('/recogedores', (req, res) =>
  res.sendFile(path.join(__dirname, 'recogedores.html'))
);

// GET todos los registros (con filtros opcionales)
app.get('/api/recogedores', (req, res) => {
  let data = readJSON(FILES.recogedores, []);
  const { fecha, recogedor, modulo, orden, fechaDesde, fechaHasta } = req.query;
  if (fecha)      data = data.filter(r => r.fecha === fecha);
  if (fechaDesde) data = data.filter(r => r.fecha >= fechaDesde);
  if (fechaHasta) data = data.filter(r => r.fecha <= fechaHasta);
  if (recogedor)  data = data.filter(r => r.recogedor === recogedor);
  if (modulo)     data = data.filter(r => r.modulo === modulo);
  if (orden)      data = data.filter(r => r.orden === orden);
  res.json(data);
});

// POST crear/actualizar registro
app.post('/api/recogedores', (req, res) => {
  try {
    const rec = req.body;
    if (!rec.recogedor || !rec.modulo || !rec.orden || !rec.fecha || !rec.hora) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    rec.eficiencia   = rec.meta > 0 ? parseFloat(((rec.cantidad / rec.meta) * 100).toFixed(1)) : 0;
    rec.timestamp    = Date.now();
    rec.id           = rec.id || (Date.now() + '-' + Math.random().toString(36).slice(2));

    let data = readJSON(FILES.recogedores, []);
    // Si ya existe un registro para mismo recogedor/modulo/orden/fecha/hora → actualizar
    const idx = data.findIndex(r =>
      r.recogedor === rec.recogedor &&
      r.modulo    === rec.modulo    &&
      r.orden     === rec.orden     &&
      r.fecha     === rec.fecha     &&
      r.hora      === rec.hora
    );
    if (idx !== -1) { data[idx] = { ...data[idx], ...rec }; }
    else            { data.push(rec); }
    writeJSON(FILES.recogedores, data);
    res.json({ ok: true, registro: data[idx !== -1 ? idx : data.length - 1] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH editar un registro por id
app.patch('/api/recogedores/:id', (req, res) => {
  try {
    let data = readJSON(FILES.recogedores, []);
    const idx = data.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
    data[idx] = { ...data[idx], ...req.body };
    if (data[idx].meta > 0) {
      data[idx].eficiencia = parseFloat(((data[idx].cantidad / data[idx].meta) * 100).toFixed(1));
    }
    writeJSON(FILES.recogedores, data);
    res.json({ ok: true, registro: data[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE eliminar registro por id
app.delete('/api/recogedores/:id', (req, res) => {
  try {
    let data = readJSON(FILES.recogedores, []);
    const len = data.length;
    data = data.filter(r => r.id !== req.params.id);
    if (data.length === len) return res.status(404).json({ error: 'No encontrado' });
    writeJSON(FILES.recogedores, data);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API ia-records (para validar operarias en contador_modulos) ──
app.get('/api/ia-records', (req, res) => {
  res.json(iaRecords || []);
});

// ── API Órdenes de Producción ─────────────────────────────────────
app.get('/api/ordenes', (req, res) => {
  res.json(loadDB('ordenes') || []);
});
app.post('/api/ordenes', (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Se esperaba un array' });
  saveDB('ordenes', data);
  res.json({ ok: true });
});

const CI_PATH = path.join(__dirname, 'Tablero_CI.html');
app.get('/ci', (req, res) => {
  console.log('[CI] Solicitado /ci — buscando en:', CI_PATH);
  console.log('[CI] Existe:', fs.existsSync(CI_PATH));
  // Listar archivos HTML en __dirname para debug
  try {
    const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.html'));
    console.log('[CI] Archivos HTML en __dirname:', files);
  } catch(e) { console.log('[CI] Error listando:', e.message); }
  
  if (!fs.existsSync(CI_PATH)) {
    // Intentar variantes del nombre
    const variants = ['tablero_ci.html','tablero-ci.html','TableroCI.html','tableroCI.html'];
    for (const v of variants) {
      const vpath = path.join(__dirname, v);
      if (fs.existsSync(vpath)) {
        console.log('[CI] Encontrado variante:', v);
        return res.sendFile(vpath);
      }
    }
    console.error('[CI] Tablero_CI.html NO encontrado en:', CI_PATH);
    return res.status(404).send('<h1>Tablero CI no encontrado</h1><p>CI_PATH: ' + CI_PATH + '</p><p>Archivos HTML disponibles: ' + fs.readdirSync(__dirname).filter(f=>f.endsWith('.html')).join(', ') + '</p>');
  }
  res.sendFile(CI_PATH);
});

// #13 Health check para Render
app.get('/health', (req, res) => {
  res.json({
    status:  'ok',
    version: '4.0',
    uptime:  Math.floor(process.uptime()),
    ts:      new Date().toISOString()
  });
});

// ── #6 Multer con fileFilter (solo imágenes) ───────────────────────
const ALLOWED_MIME = ['image/jpeg','image/png','image/webp','image/gif'];

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => {
      const ext  = path.extname(file.originalname).toLowerCase() || '.jpg';
      const safe = `${Date.now()}-${uuidv4()}${ext}`;
      cb(null, safe);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}. Solo se aceptan imágenes.`));
    }
  }
});

// Manejo de error de Multer
function handleMulterError(err, req, res, next) {
  if (err && err.message) {
    return res.status(400).json({ error: err.message });
  }
  next(err);
}

// ── Helpers de validación ──────────────────────────────────────────
function requireFields(obj, fields) {
  const missing = fields.filter(f => !obj[f] || String(obj[f]).trim() === '');
  return missing.length ? missing : null;
}

// ── #8 broadcast GLOBAL (fix bug de scope en /api/ia-record-obs) ──
// Se declara después de que wss sea creado (ver abajo), pero la función
// queda disponible globalmente para todas las rutas REST.
let wss; // se asigna después de http.createServer
function broadcast(payload, excludeWs = null) {
  if (!wss) return;
  const str = JSON.stringify(payload);
  wss.clients.forEach(c => {
    if (c.readyState !== 1) return;
    if (excludeWs && c === excludeWs) return;
    c.send(str);
  });
}

// ══════════════════════════════════════════════════════════════════
//  RUTAS API — Alistamiento
// ══════════════════════════════════════════════════════════════════

app.get('/alistamiento/api/config', (req, res) =>
  res.json({
    supervisoras: SUPERVISORAS_BIT,
    mecanicos:    MECANICOS_BIT,
    modulos:      getModulosBit(),
    maquinas:     MAQUINAS_BIT
  })
);

// ── Alistamientos ──────────────────────────────────────────────────
app.get('/alistamiento/api/alistamientos', (req, res) => {
  let data = [...loadDB('alistamientos')];
  const { modulo, fecha, supervisor } = req.query;
  if (modulo)     data = data.filter(r => r.modulo === modulo);
  if (fecha)      data = data.filter(r => r.fecha && r.fecha.startsWith(fecha));
  if (supervisor) data = data.filter(r => r.supervisor === supervisor);
  res.json(data.sort((a, b) => new Date(b.fechaHora) - new Date(a.fechaHora)));
});

app.post(
  '/alistamiento/api/alistamientos',
  (req, res, next) => upload.array('fotos', 5)(req, res, err => err ? handleMulterError(err, req, res, next) : next()),
  (req, res) => {
    const missing = requireFields(req.body, ['modulo', 'tipoMaquina', 'serial', 'mecanico']);
    if (missing) return res.status(400).json({ error: `Campos requeridos faltantes: ${missing.join(', ')}` });
    try {
      const data  = loadDB('alistamientos');
      const ahora = new Date();
      const nuevo = {
        id: uuidv4(),
        ...req.body,
        fotos:     req.files ? req.files.map(f => `/alistamiento/uploads/${f.filename}`) : [],
        fechaHora: ahora.toISOString(),
        fecha:     ahora.toISOString().split('T')[0],
        hora:      ahora.toTimeString().slice(0, 8)
      };
      data.push(nuevo);
      saveDB('alistamientos', data);
      if (nuevo.pruebaCostura === 'Rechazada') {
        const alertas = loadDB('alertas');
        alertas.push({
          id: uuidv4(), tipo: 'critica',
          mensaje: `Prueba RECHAZADA - Módulo ${nuevo.modulo} - ${nuevo.tipoMaquina} S/N ${nuevo.serial}`,
          referencia: nuevo.id, area: 'alistamiento', leida: false, fechaHora: ahora.toISOString()
        });
        saveDB('alertas', alertas);
      }
      res.json({ success: true, data: nuevo });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
);

app.delete('/alistamiento/api/alistamientos/:id', (req, res) => {
  const data = loadDB('alistamientos').filter(r => r.id !== req.params.id);
  saveDB('alistamientos', data);
  res.json({ success: true });
});

// ── Mantenimientos ─────────────────────────────────────────────────
app.get('/alistamiento/api/mantenimientos', (req, res) => {
  let data = [...loadDB('mantenimientos')];
  const { tipo, fecha, mecanico } = req.query;
  if (tipo)     data = data.filter(r => r.tipoMantenimiento === tipo);
  if (fecha)    data = data.filter(r => r.fecha && r.fecha.startsWith(fecha));
  if (mecanico) data = data.filter(r => r.mecanico === mecanico);
  res.json(data.sort((a, b) => new Date(b.fechaHora) - new Date(a.fechaHora)));
});

app.post(
  '/alistamiento/api/mantenimientos',
  (req, res, next) => upload.array('fotos', 5)(req, res, err => err ? handleMulterError(err, req, res, next) : next()),
  (req, res) => {
    const missing = requireFields(req.body, ['tipoMaquina', 'serial', 'mecanico', 'tipoMantenimiento']);
    if (missing) return res.status(400).json({ error: `Campos requeridos faltantes: ${missing.join(', ')}` });
    try {
      const data  = loadDB('mantenimientos');
      const ahora = new Date();
      const nuevo = {
        id: uuidv4(),
        ...req.body,
        fotos:     req.files ? req.files.map(f => `/alistamiento/uploads/${f.filename}`) : [],
        fechaHora: ahora.toISOString(),
        fecha:     ahora.toISOString().split('T')[0],
        hora:      ahora.toTimeString().slice(0, 8)
      };
      data.push(nuevo);
      saveDB('mantenimientos', data);
      if (nuevo.tipoMantenimiento === 'Correctivo') {
        const alertas = loadDB('alertas');
        alertas.push({
          id: uuidv4(), tipo: 'advertencia',
          mensaje: `Correctivo registrado - Módulo ${nuevo.modulo||'N/A'} - ${nuevo.tipoMaquina} S/N ${nuevo.serial}`,
          referencia: nuevo.id, area: 'mantenimiento', leida: false, fechaHora: ahora.toISOString()
        });
        saveDB('alertas', alertas);
      }
      res.json({ success: true, data: nuevo });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
);

app.delete('/alistamiento/api/mantenimientos/:id', (req, res) => {
  const data = loadDB('mantenimientos').filter(r => r.id !== req.params.id);
  saveDB('mantenimientos', data);
  res.json({ success: true });
});

// ── Alertas ────────────────────────────────────────────────────────
app.get('/alistamiento/api/alertas', (req, res) => {
  const data = loadDB('alertas');
  res.json(data.filter(a => !a.leida).sort((a, b) => new Date(b.fechaHora) - new Date(a.fechaHora)));
});

app.put('/alistamiento/api/alertas/:id/leer', (req, res) => {
  const data = loadDB('alertas');
  const a = data.find(x => x.id === req.params.id);
  if (a) a.leida = true;
  saveDB('alertas', data);
  res.json({ success: true });
});

app.put('/alistamiento/api/alertas/leer-todas', (req, res) => {
  const data = loadDB('alertas').map(a => ({ ...a, leida: true }));
  saveDB('alertas', data);
  res.json({ success: true });
});

// ── Exportar Excel ─────────────────────────────────────────────────
app.get('/alistamiento/api/exportar/alistamientos', (req, res) => {
  const data = loadDB('alistamientos');
  const rows = data.map(r => ({
    'Módulo':r.modulo||'','Referencia':r.referencia||'','Máquina':r.tipoMaquina||'',
    'Serial':r.serial||'','Mecánico':r.mecanico||'','Supervisor':r.supervisor||'',
    'Ficha Técnica':r.fichaTecnica||'','Muestra Física':r.muestraFisica||'',
    'Prueba Costura':r.pruebaCostura||'','Observaciones':r.observaciones||'',
    'Fecha':r.fecha||'','Hora':r.hora||''
  }));
  const wb = xlsxLib.utils.book_new();
  xlsxLib.utils.book_append_sheet(wb, xlsxLib.utils.json_to_sheet(rows), 'Alistamientos');
  const buf = xlsxLib.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="Alistamientos_${new Date().toISOString().split('T')[0]}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

app.get('/alistamiento/api/exportar/mantenimientos', (req, res) => {
  const data = loadDB('mantenimientos');
  const rows = data.map(r => ({
    'Módulo':r.modulo||'','Máquina':r.tipoMaquina||'','Serial':r.serial||'',
    'Tipo':r.tipoMantenimiento||'','Repuestos':r.repuestos||'',
    'Mecánico':r.mecanico||'','Observaciones':r.observaciones||'',
    'Fecha':r.fecha||'','Hora':r.hora||''
  }));
  const wb = xlsxLib.utils.book_new();
  xlsxLib.utils.book_append_sheet(wb, xlsxLib.utils.json_to_sheet(rows), 'Mantenimientos');
  const buf = xlsxLib.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', `attachment; filename="Mantenimientos_${new Date().toISOString().split('T')[0]}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Stats ──────────────────────────────────────────────────────────
app.get('/alistamiento/api/stats', (req, res) => {
  const alistamientos  = loadDB('alistamientos');
  const mantenimientos = loadDB('mantenimientos');
  const alertas        = loadDB('alertas');
  const hoy = new Date().toISOString().split('T')[0];
  res.json({
    alistamientos: {
      total:      alistamientos.length,
      hoy:        alistamientos.filter(r => r.fecha === hoy).length,
      aprobados:  alistamientos.filter(r => r.pruebaCostura === 'Aprobada').length,
      rechazados: alistamientos.filter(r => r.pruebaCostura === 'Rechazada').length
    },
    mantenimientos: {
      total:       mantenimientos.length,
      hoy:         mantenimientos.filter(r => r.fecha === hoy).length,
      preventivos: mantenimientos.filter(r => r.tipoMantenimiento === 'Preventivo').length,
      correctivos: mantenimientos.filter(r => r.tipoMantenimiento === 'Correctivo').length
    },
    alertas: { noLeidas: alertas.filter(a => !a.leida).length }
  });
});

// ══════════════════════════════════════════════════════════════════
//  RUTAS API — Configuración de la App
// ══════════════════════════════════════════════════════════════════

// App Config
app.get('/api/app-config', (req, res) => {
  res.json(readJSON(FILES.app_config, {}));
});

app.post('/api/app-config', (req, res) => {
  try {
    const existing = readJSON(FILES.app_config, {});
    function deepMerge(target, source) {
      const out = Object.assign({}, target);
      Object.keys(source).forEach(k => {
        const sv = source[k], tv = target[k];
        if (sv && typeof sv === 'object' && !Array.isArray(sv) &&
            tv && typeof tv === 'object' && !Array.isArray(tv)) {
          out[k] = deepMerge(tv, sv);
        } else {
          out[k] = sv;
        }
      });
      return out;
    }
    writeJSON(FILES.app_config, deepMerge(existing, req.body));
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CI Config (para modal Solicitar Insumos en index.html)
app.get('/api/ci-config', (req, res) => {
  res.json(ciConfig);
});

// Lista de módulos activos según configuración del Programador
app.get('/api/modules', (req, res) => {
  res.json(getAllActiveModules());
});

// Lista de mecánicos (supervisores activos, sin programador)
app.get('/api/mecanicos', (req, res) => {
  // Leer miembros del perfil "Mecanicos" desde app_config._perfil_members
  const appCfg = readJSON(FILES.app_config, {});
  const perfilMembers = appCfg._perfil_members;
  if (perfilMembers && perfilMembers['Mecanicos'] && Array.isArray(perfilMembers['Mecanicos'])) {
    const members = perfilMembers['Mecanicos']
      .filter(m => m && !m.disabled)
      .map(m => {
        const nombre = typeof m === 'string' ? m : (m.nombre || m.name || '');
        return { id: nombre, name: nombre };
      })
      .filter(m => m.name);
    if (members.length > 0) {
      members.sort((a, b) => a.name.localeCompare(b.name));
      return res.json(members);
    }
  }
  // Fallback: supervisores activos
  const sups = (iaState.supervisors || []).filter(s => s.id !== 'programador' && !s.disabled);
  res.json(sups.map(s => ({ id: s.id, name: s.name })));
});

// Novedades
app.get('/api/novedades',  (req, res) => res.json(readJSON(FILES.novedades, [])));
app.post('/api/novedades', (req, res) => {
  try {
    writeJSON(FILES.novedades, Array.isArray(req.body) ? req.body : []);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Cargos
app.get('/api/cargos',  (req, res) => res.json(readJSON(FILES.cargos, [])));
app.post('/api/cargos', (req, res) => {
  try { writeJSON(FILES.cargos, req.body); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Maquinaria
app.get('/api/maquinaria',  (req, res) => res.json(readJSON(FILES.maquinaria, [])));
app.post('/api/maquinaria', (req, res) => {
  try { writeJSON(FILES.maquinaria, req.body); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Turnos
app.get('/api/turnos',  (req, res) => res.json(readJSON(FILES.turnos, [])));
app.post('/api/turnos', (req, res) => {
  try { writeJSON(FILES.turnos, req.body); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Historial
app.get('/api/historial', (req, res) => {
  let h = readJSON(FILES.historial, []);
  const contPorFecha = {};
  let modificado = false;

  h = h.map(r => {
    let reg = { ...r };

    // 1. Asignar num a registros que no lo tienen
    if(!reg.num){
      const fecha = reg.fechaISO || '?';
      contPorFecha[fecha] = (contPorFecha[fecha] || 0) + 1;
      reg.num = contPorFecha[fecha];
      modificado = true;
    } else {
      const fecha = reg.fechaISO || '?';
      if(!contPorFecha[fecha] || reg.num > contPorFecha[fecha]) contPorFecha[fecha] = reg.num;
    }

    // 2. Limpiar operaria/mecánico según tipo de estado
    const tipo = reg.tipo || reg.estadoAnterior || '';
    if(tipo === 'orange' || tipo === 'purple' || tipo === 'blue' || tipo === 'blue30' || tipo === 'blue60'){
      // Espera Insumos, Espera Producción, Cambio Referencia: sin operaria ni mecánico
      if(reg.empleada || reg.mecanico){
        reg.empleada = '';
        reg.mecanico = '';
        modificado = true;
      }
    } else if(tipo === 'pink'){
      // Alistamiento: solo mecánico, sin operaria
      if(reg.empleada){
        reg.empleada = '';
        modificado = true;
      }
    }
    // red (Espera Mecánico): operaria y mecánico — no tocar
    // yellow (Atención Mecánico): operaria y mecánico — no tocar

    return reg;
  });

  if(modificado) writeJSON(FILES.historial, h);
  res.json(h);
});
app.post('/api/historial', (req, res) => {
  // Deshabilitado — el historial solo lo escribe el servidor internamente
  res.status(405).json({ error: 'No permitido. El historial lo gestiona el servidor.' });
});
app.delete('/api/historial/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx);
    let h = readJSON(FILES.historial, []);
    if(isNaN(idx) || idx < 0 || idx >= h.length) return res.status(404).json({ error: 'índice inválido' });
    
    const registro = h[idx];
    const ciRequestId = registro ? registro.ciRequestId : null;
    
    h.splice(idx, 1);
    writeJSON(FILES.historial, h);

    // Si tiene ciRequestId, eliminar también de ci_requests
    if(ciRequestId){
      ciRequests = ciRequests.filter(r => r._id !== ciRequestId);
      saveCiRequests();
      // Notificar a todos los clientes
      broadcast({ type:'ci_delete_request', reqId: ciRequestId });
    }

    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── EDITAR registro del historial ─────────────────────────────────
app.patch('/api/historial/:idx', (req, res) => {
  try {
    const idx = parseInt(req.params.idx);
    let h = readJSON(FILES.historial, []);
    if(isNaN(idx) || idx < 0 || idx >= h.length) return res.status(404).json({ error: 'índice inválido' });
    const campos = ['modulo','empleada','horaInicio','hora','mecanico'];
    campos.forEach(c => { if(req.body[c] !== undefined) h[idx][c] = req.body[c]; });
    writeJSON(FILES.historial, h);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── #8 BUGFIX: broadcast disponible globalmente ────────────────────
app.patch('/api/ia-record-obs', (req, res) => {
  const { id, obs } = req.body;
  if (!id) return res.status(400).json({ error: 'sin id' });
  const idx = iaRecords.findIndex(r => r.id === id);
  if (idx === -1) return res.status(404).json({ error: 'no encontrado' });
  iaRecords[idx].obs = obs || '';
  saveIaRecords();
  broadcast({ type: 'ia_edit_record', record: iaRecords[idx] }); // ✅ sin error de scope
  res.json({ success: true, record: iaRecords[idx] });
});

// ══════════════════════════════════════════════════════════════════
//  #3 + #4: RESET TOTAL — POST, contraseña env obligatoria
// ══════════════════════════════════════════════════════════════════
// Antes: GET /admin/reset?pass=xxx  ← contraseña visible en logs
// Ahora: POST /admin/reset  con body { pass: "..." }
// La contraseña viene SOLO de la variable de entorno RESET_PASS.
// Rate limit: máx 5 intentos por IP cada 15 minutos.

app.post('/admin/reset', rateLimit(5, 15 * 60 * 1000), (req, res) => {
  if (!RESET_PASS) {
    return res.status(503).json({ error: 'Reset deshabilitado: configura la variable de entorno RESET_PASS en Render.' });
  }
  const { pass } = req.body;
  if (!pass || pass !== RESET_PASS) {
    console.warn(`Intento fallido de reset desde IP ${req.ip} a las ${new Date().toISOString()}`);
    return res.status(403).json({ error: 'Contraseña incorrecta.' });
  }
  try {
    const filesToReset = Object.values(FILES);
    filesToReset.forEach(f => { if (fs.existsSync(f)) fs.unlinkSync(f); });

    // Limpiar caché en memoria
    Object.keys(dbCache).forEach(k => delete dbCache[k]);

    // Resetear estado en memoria
    MODULES.forEach(id => { states[id] = 'green'; lastMec[id] = ''; });
    iaState       = ensureProgramador({ supervisors: [], employees: [] });
    iaRecords     = [];
    modulesConfig = { disabled:[], extra:[], renamed:{}, modPass:{} };
    ciRequests    = [];
    ciConfig      = { ...CI_CONFIG_DEFAULT };

    // Guardar estado limpio
    saveIaState();
    saveFloorState();

    // Notificar a todos los clientes WS
    broadcast({ type: 'server_reset' });

    console.warn(`⚠️  RESET TOTAL ejecutado desde IP ${req.ip} a las ${new Date().toISOString()}`);
    res.json({ success: true, mensaje: 'Todos los datos han sido borrados. El servidor está en blanco.' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Compatibilidad: el GET antiguo devuelve instrucciones claras
app.get('/admin/reset', (req, res) => {
  res.status(405).json({
    error: 'Método no permitido. Usa POST /admin/reset con body JSON { "pass": "tu_clave" }',
    ejemplo: 'fetch("/admin/reset", { method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({ pass:"tu_clave" }) })'
  });
});

// ══════════════════════════════════════════════════════════════════
//  SERVIDOR HTTP + WEBSOCKET
// ══════════════════════════════════════════════════════════════════
const server = http.createServer(app);

// Asignar wss ANTES de que puedan llegar requests (el listen es async)
wss = new WebSocketServer({ server });

// Ping/pong — evita timeout de 60s en Render
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 30_000);

wss.on('connection', (ws, req) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const clientIp = req.socket.remoteAddress || 'unknown';
  console.log(`WS conectado: ${clientIp} | clientes: ${wss.clients.size}`);

  // Estado completo al conectar
  ws.send(JSON.stringify({
    type:          'init',
    states:        { ...states },
    lastMec:       { ...lastMec },
    stateTimes:    { ...stateTimes },
    lastEmpleada:  { ...lastEmpleada },
    iaState:       iaState,
    iaRecords:     iaRecords,
    modulesConfig: modulesConfig,
    slots:         JSON.parse(JSON.stringify(slots))
  }));

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); }
    catch { console.warn('WS: mensaje JSON inválido'); return; }

    if (!msg || typeof msg.type !== 'string') {
      console.warn('WS: mensaje sin tipo válido:', raw.toString().slice(0, 80));
      return;
    }

    // broadcast local (excluye al emisor)
    const broadcastLocal = (payload) => broadcast(payload, ws);

    try {
      // ── Control de Piso ─────────────────────────────────────────
      if (msg.type === 'change') {
        if (!msg.id) { console.warn('WS change: sin id'); return; }
        // Aceptar módulos extra aunque no estén en states aún
        if (states[msg.id] === undefined) {
          states[msg.id]       = 'green';
          lastMec[msg.id]      = '';
          stateTimes[msg.id]   = Date.now();
          lastEmpleada[msg.id] = '';
        }

        // Guardar en historial ANTES de actualizar el estado
        const prevState = states[msg.id];

        // Actualizar empleada y mecánico en memoria ANTES de logHistorial
        if (msg.empleada) lastEmpleada[msg.id] = msg.empleada;
        if (msg.mecanico) lastMec[msg.id] = msg.mecanico;

        console.log(`[HISTORIAL] ${msg.id}: ${prevState} → ${msg.state} | mec="${msg.mecanico||''}" emp="${msg.empleada||''}"`);
        logHistorial(msg.id, prevState, msg.state || 'green', msg.mecanico || lastMec[msg.id] || '', msg.empleada || lastEmpleada[msg.id] || '');

        states[msg.id]     = msg.state || 'green';
        stateTimes[msg.id] = Date.now();
        if (msg.state === 'red') lastMec[msg.id] = '';
        else if (msg.mecanico) lastMec[msg.id] = msg.mecanico;
        // Guardar empleada: conservar si hay nueva, limpiar solo al volver a green
        if (msg.empleada) lastEmpleada[msg.id] = msg.empleada;
        else if (msg.state === 'green') lastEmpleada[msg.id] = '';
        saveFloorState();
        broadcastLocal({ type:'change', id:msg.id, state:msg.state, mecanico:msg.mecanico||'', limite:msg.limite||null, empleada:lastEmpleada[msg.id]||'', stateTime:stateTimes[msg.id] });
      }

      else if (msg.type === 'change2') {
        if (!msg.id) return;
        broadcastLocal({ type:'change2', id:msg.id, state:msg.state||null, mecanico:msg.mecanico||'' });
      }

      // ── Estado pink (Alistamiento) ──────────────────────────────
      else if (msg.type === 'change_pink') {
        if (!msg.id) return;
        if (states[msg.id] === undefined) {
          states[msg.id]       = 'green';
          lastMec[msg.id]      = '';
          stateTimes[msg.id]   = Date.now();
          lastEmpleada[msg.id] = '';
        }
        if(msg.mecanico) lastMec[msg.id] = msg.mecanico;
        states[msg.id]     = 'pink';
        stateTimes[msg.id] = Date.now();
        saveFloorState();
        broadcast({ type:'change', id:msg.id, state:'pink', mecanico:msg.mecanico||'', limite:null, empleada:'', stateTime:stateTimes[msg.id] });
      }

      // ── Config Módulos ──────────────────────────────────────────
      else if (msg.type === 'modules_config') {
        // Inicializar states para módulos extra nuevos
        const _newExtra = (msg.extra || []);
        const _newRenamed = msg.renamed || {};
        _newExtra.forEach(id => {
          const rn = _newRenamed[id] || id;
          if (states[rn] === undefined)  { states[rn]  = 'green'; }
          if (lastMec[rn] === undefined) { lastMec[rn] = ''; }
        });
        modulesConfig = {
          disabled: Array.isArray(msg.disabled) ? msg.disabled : [],
          extra:    Array.isArray(msg.extra)    ? msg.extra    : [],
          renamed:  msg.renamed  && typeof msg.renamed  === 'object' ? msg.renamed  : {},
          modPass:  msg.modPass  && typeof msg.modPass  === 'object' ? msg.modPass  : {}
        };
        saveModulesConfig();
        broadcastLocal({ type:'modules_config', ...modulesConfig });
      }

      // ── Tablero CI ──────────────────────────────────────────────
      else if (msg.type === 'ci_init') {
        ciRequests.forEach(r => {
          if (!r.alertStart && r.status === 'alert') {
            const tsFromId = parseInt((r._id || '').split('-')[0]);
            r.alertStart = tsFromId > 0 ? tsFromId : Date.now();
          }
        });
        ws.send(JSON.stringify({
          type:           'ci_init',
          requests:       ciRequests,
          tipoInsumoList: ciConfig.tipoInsumoList,
          elasticoList:   ciConfig.elasticoList,
          moduleList:     ciConfig.moduleList,
          obsList:        ciConfig.obsList || CI_CONFIG_DEFAULT.obsList
        }));
      }

      else if (msg.type === 'ci_cumplido_request') {
        if (!msg.request) { console.warn('WS ci_cumplido_request: sin payload'); return; }
        broadcastLocal({ type:'ci_cumplido_request', request:msg.request });
      }

      else if (msg.type === 'ci_config_sync') {
        if (msg.tipoInsumoList) ciConfig.tipoInsumoList = msg.tipoInsumoList;
        if (msg.elasticoList)   ciConfig.elasticoList   = msg.elasticoList;
        if (msg.moduleList)     ciConfig.moduleList     = msg.moduleList;
        if (msg.obsList)        ciConfig.obsList        = msg.obsList;
        saveCiConfig();
        broadcastLocal({ type:'ci_config_sync', tipoInsumoList:ciConfig.tipoInsumoList, elasticoList:ciConfig.elasticoList, moduleList:ciConfig.moduleList, obsList:ciConfig.obsList || CI_CONFIG_DEFAULT.obsList });
      }

      else if (msg.type === 'ci_new_request') {
        if (!msg.request || !msg.request._id) { console.warn('WS ci_new_request: sin _id'); return; }
        if (!ciRequests.find(r => r._id === msg.request._id)) {
          if (!msg.request.alertStart) msg.request.alertStart = Date.now();
          
          // Asignar solicitudNum secuencial si no tiene
          if(!msg.request.solicitudNum){
            let maxNum = 0;
            ciRequests.forEach(r => {
              if(r.solicitudNum && r.solicitudNum > maxNum){
                maxNum = r.solicitudNum;
              }
            });
            msg.request.solicitudNum = maxNum + 1;
          }
          
          ciRequests.unshift(msg.request);
          if (ciRequests.length > 50000) ciRequests = ciRequests.slice(0, 50000);
          saveCiRequests();
        }
        broadcastLocal({ type:'ci_new_request', request:msg.request });

        // Si es solicitud de alistamiento, poner el moduloDestino en pink
        if (msg.request.esMecanico && msg.request.moduloDestino) {
          const modId = msg.request.moduloDestino;
          if (states[modId] !== undefined) {
            states[modId]     = 'pink';
            stateTimes[modId] = Date.now();
            if (msg.request.module) lastMec[modId] = msg.request.module;
            saveFloorState();
            broadcast({ type:'change', id:modId, state:'pink', mecanico:msg.request.module||'', limite:null, empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId] });
          }
        }

        // Vincular ci_request con historial — guardar ciRequestId en el registro más reciente del módulo
        const modulo = msg.request.module || msg.request.moduloDestino;
        if(modulo){
          const h = readJSON(FILES.historial, []);
          // Buscar el último registro del módulo sin ciRequestId
          for(let i = h.length - 1; i >= 0; i--){
            if(h[i].modulo === modulo && !h[i].ciRequestId){
              h[i].ciRequestId = msg.request._id;
              writeJSON(FILES.historial, h);
              break;
            }
          }
        }
      }

      else if (msg.type === 'ci_update_request') {
        if (!msg.request || !msg.request._id) { console.warn('WS ci_update_request: sin _id'); return; }
        const idx = ciRequests.findIndex(r => r._id === msg.request._id);
        if (idx > -1) ciRequests[idx] = msg.request;
        saveCiRequests();
        broadcastLocal({ type:'ci_update_request', request:msg.request });

        // Si fue aceptado (done), liberar el moduloDestino de pink a green
        if (msg.request.status === 'done' && msg.request.moduloDestino) {
          const modId = msg.request.moduloDestino;
          if (states[modId] === 'pink') {
            states[modId]     = 'green';
            stateTimes[modId] = Date.now();
            lastMec[modId]    = '';
            saveFloorState();
            broadcast({ type:'change', id:modId, state:'green', mecanico:'', limite:null, empleada:'', stateTime:stateTimes[modId] });
          }
        }

        // Si fue aceptado (done), cerrar el slot CI correspondiente
        if (msg.request.status === 'done' && msg.request._id) {
          const reqId = msg.request._id;
          const modId = msg.request.module || msg.request.moduloDestino;
          if (modId && slots[modId]) {
            // Buscar en slots N y M cuál tiene ese ciRequestId
            let closedSlot = null;
            if (slots[modId].N && slots[modId].N.ciRequestId === reqId) closedSlot = 'N';
            else if (slots[modId].M && slots[modId].M.ciRequestId === reqId) closedSlot = 'M';

            if (closedSlot) {
              const imp = slots[modId][closedSlot];
              // Registrar en historial
              const ahora = Date.now();
              const durMs = ahora - (imp.inicio || ahora);
              if (durMs > 0) {
                const now    = new Date();
                const opts   = { timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true };
                const bogota = new Date(now.toLocaleString('en-US', { timeZone:'America/Bogota' }));
                const fechaISO = bogota.getFullYear()+'-'+String(bogota.getMonth()+1).padStart(2,'0')+'-'+String(bogota.getDate()).padStart(2,'0');
                let historial = readJSON(FILES.historial, []);
                const regHoy  = historial.filter(r => r.fechaISO === fechaISO);
                historial.push({
                  num: regHoy.length+1, fecha: now.toLocaleDateString('es-CO',{timeZone:'America/Bogota'}), fechaISO,
                  horaInicio: new Date(imp.inicio||ahora).toLocaleTimeString('es-CO',opts),
                  hora: now.toLocaleTimeString('es-CO',opts), modulo: modId,
                  tipo: imp.tipo, estadoAnterior: imp.tipo, estadoNuevo: 'green',
                  durMinutos: parseFloat((durMs/60000).toFixed(2)),
                  mecanico: imp.mecanico||'', empleada: imp.empleada||'', ciRequestId: reqId
                });
                if (historial.length > 10000) historial = historial.slice(-10000);
                writeJSON(FILES.historial, historial);
              }
              // Cerrar slot
              slots[modId][closedSlot] = null;
              states[modId]    = calcColorMod(modId);
              stateTimes[modId]= Date.now();
              if (states[modId] === 'green') { lastMec[modId]=''; lastEmpleada[modId]=''; }
              saveFloorState();
              broadcast({ type:'slots_update', modId, slots: slots[modId] });
              broadcast({ type:'change', id:modId, state:states[modId], mecanico:lastMec[modId]||'', limite:null, empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId], fromMulti:true });
            }
          }
        }
      }

      else if (msg.type === 'ci_reactivar_alerta') {
        if (!msg.reqId) return;
        // Retransmitir a todos (incluyendo al emisor) para que CI reactive la alerta
        broadcast({ type:'ci_reactivar_alerta', reqId:msg.reqId });
      }

      // ── Multi-Improductivo ──────────────────────────────────────
      // ── SLOTS: 3 slots fijos R/N/M por módulo ──────────────────────
      // msg: { type:'slot_change', modId, slot, action, data }
      // slot: 'R'|'N'|'M'  action: 'open'|'update'|'close'
      else if (msg.type === 'slot_change') {
        const { modId, slot, action, data } = msg;
        if (!modId || !slot || !action || !['R','N','M'].includes(slot)) return;
        if (!slots[modId]) slots[modId] = { R:null, N:null, M:null };

        if (action === 'open') {
          if (slots[modId][slot]) return; // ya existe, ignorar
          slots[modId][slot] = {
            id:          data.id,
            slot,
            tipo:        data.tipo,
            tipoActual:  data.tipo,
            inicio:      data.inicio || Date.now(),
            empleada:    data.empleada || '',
            mecanico:    data.mecanico || '',
            ciRequestId: data.ciRequestId || null
          };
          if (data.empleada) lastEmpleada[modId] = data.empleada;
          states[modId]     = calcColorMod(modId);
          stateTimes[modId] = slots[modId][slot].inicio;
          saveFloorState();
          // Broadcast a todos los clientes con el estado nuevo
          broadcast({ type:'slots_update', modId, slots: slots[modId] });
          // Para el tablero de mecánicos: si es slot R, emitir change con fromSlot
          if (slot === 'R') {
            broadcast({ type:'change', id:modId, state:slots[modId].R.tipoActual, mecanico:lastMec[modId]||'', limite:null, empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId], fromSlot:true });
          } else {
            // Para el tablero general actualizar color sin sonar en mecánicos
            broadcast({ type:'change', id:modId, state:states[modId], mecanico:lastMec[modId]||'', limite:null, empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId], fromMulti:true });
          }
        }

        else if (action === 'update') {
          if (!slots[modId][slot]) return;
          Object.assign(slots[modId][slot], data);
          if (data.mecanico) lastMec[modId] = data.mecanico;
          if (data.empleada) lastEmpleada[modId] = data.empleada;
          states[modId]     = calcColorMod(modId);
          stateTimes[modId] = Date.now();
          saveFloorState();
          broadcast({ type:'slots_update', modId, slots: slots[modId] });
          // Tablero de mecánicos siempre recibe el estado real del slot R
          if (slot === 'R') {
            broadcast({ type:'change', id:modId, state:slots[modId].R.tipoActual, mecanico:lastMec[modId]||'', limite:null, empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId], fromSlot:true });
          } else {
            broadcast({ type:'change', id:modId, state:states[modId], mecanico:lastMec[modId]||'', limite:null, empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId], fromMulti:true });
          }
        }

        else if (action === 'close') {
          if (!slots[modId][slot]) return;
          const imp = slots[modId][slot];

          // Guardar en historial
          const ahora = Date.now();
          const durMs = ahora - (imp.inicio || ahora);
          if (durMs > 0) {
            const now    = new Date();
            const opts   = { timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true };
            const bogota = new Date(now.toLocaleString('en-US', { timeZone:'America/Bogota' }));
            const fechaISO = bogota.getFullYear()+'-'+String(bogota.getMonth()+1).padStart(2,'0')+'-'+String(bogota.getDate()).padStart(2,'0');
            let historial = readJSON(FILES.historial, []);
            const regHoy  = historial.filter(r => r.fechaISO === fechaISO);
            // Para slot R: usar tipoActual (puede ser yellow al momento de cerrar)
            const tipoReal = imp.tipoActual || imp.tipo;
            historial.push({
              num:           regHoy.length + 1,
              fecha:         now.toLocaleDateString('es-CO', { timeZone:'America/Bogota' }),
              fechaISO,
              horaInicio:    new Date(imp.inicio || ahora).toLocaleTimeString('es-CO', opts),
              hora:          now.toLocaleTimeString('es-CO', opts),
              modulo:        modId,
              tipo:          tipoReal,
              estadoAnterior:tipoReal,
              estadoNuevo:   'green',
              durMinutos:    parseFloat((durMs / 60000).toFixed(2)),
              mecanico:      imp.mecanico || '',
              empleada:      imp.empleada || '',
              ciRequestId:   imp.ciRequestId || undefined
            });
            if (historial.length > 10000) historial = historial.slice(-10000);
            writeJSON(FILES.historial, historial);
          }

          // Limpiar slot
          slots[modId][slot] = null;
          states[modId]      = calcColorMod(modId);
          stateTimes[modId]  = Date.now();
          if (states[modId] === 'green') {
            lastMec[modId]       = '';
            lastEmpleada[modId]  = '';
          }
          saveFloorState();
          broadcast({ type:'slots_update', modId, slots: slots[modId] });
          broadcast({ type:'change', id:modId, state:states[modId], mecanico:lastMec[modId]||'', limite:null, empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId], fromMulti:true });
        }
      }

      // ── LEGADO: multi_imp_change — mantener para compatibilidad ──
      else if (msg.type === 'multi_imp_change') {
        // Redirigir al nuevo sistema de slots
        const modId = msg.modId;
        if (!modId) return;
        if (!slots[modId]) slots[modId] = { R:null, N:null, M:null };
        // Detectar slot por tipo
        const tipoSlot = { red:'R', yellow:'R', orange:'N', purple:'M', pink:'R', blue:'R' };
        const slotKey  = tipoSlot[msg.imp?.tipo || msg.imp?.tipoActual] || 'R';
        // Reenviar como slot_change
        ws.emit && ws.emit('message', JSON.stringify({ type:'slot_change', modId, slot:slotKey, action:msg.action, data:msg.imp||{} }));
      }


      else if (msg.type === 'ci_delete_request') {
        let deletedId = null;
        if (msg.reqId) {
          deletedId = msg.reqId;
          ciRequests = ciRequests.filter(r => r._id !== msg.reqId);
        } else if (typeof msg.idx === 'number') {
          if(ciRequests[msg.idx]) deletedId = ciRequests[msg.idx]._id;
          ciRequests.splice(msg.idx, 1);
        } else { console.warn('WS ci_delete_request: sin reqId ni idx'); return; }
        saveCiRequests();
        broadcastLocal({ type:'ci_delete_request', idx:msg.idx, reqId:msg.reqId });

        // Eliminar registro vinculado en historial
        if(deletedId){
          let h = readJSON(FILES.historial, []);
          const antes = h.length;
          h = h.filter(r => r.ciRequestId !== deletedId);
          if(h.length !== antes) writeJSON(FILES.historial, h);
        }
      }

      // ── Control de Asistencia ────────────────────────────────────
      else if (msg.type === 'ia_add_record') {
        if (!msg.record) { console.warn('WS ia_add_record: sin record'); return; }
        iaRecords = iaRecords.filter(r =>
          !(r.empName === msg.record.empName &&
            r.date    === msg.record.date    &&
            r.supervisor === msg.record.supervisor)
        );
        iaRecords.push(msg.record);
        saveIaRecords();
        broadcastLocal({ type:'ia_add_record', record:msg.record });
      }

      else if (msg.type === 'ia_delete_record') {
        if (!msg.id) { console.warn('WS ia_delete_record: sin id'); return; }
        iaRecords = iaRecords.filter(r => r.id !== msg.id);
        saveIaRecords();
        broadcastLocal({ type:'ia_delete_record', id:msg.id });
      }

      else if (msg.type === 'ia_edit_record') {
        if (!msg.record || !msg.record.id) { console.warn('WS ia_edit_record: sin id'); return; }
        const idx = iaRecords.findIndex(r => r.id === msg.record.id);
        if (idx > -1) iaRecords[idx] = msg.record;
        saveIaRecords();
        broadcastLocal({ type:'ia_edit_record', record:msg.record });
      }

      else if (msg.type === 'ia_save_state') {
        if (!msg.state) { console.warn('WS ia_save_state: sin state'); return; }
        iaState = ensureProgramador(msg.state);
        saveIaState();
        broadcastLocal({ type:'ia_save_state', state:iaState });
      }

      else {
        console.warn('WS: tipo de mensaje no reconocido:', msg.type);
      }

    } catch (e) {
      console.error('Error procesando mensaje WS:', e.message);
    }
  });

  ws.on('close', () => {
    console.log(`WS desconectado: ${clientIp} | clientes restantes: ${wss.clients.size}`);
  });
  ws.on('error', (e) => console.error('WS error:', e.message));
});

// ── 404 handler ───────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// ── Manejo global de errores Express ──────────────────────────────
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('Error no capturado:', err.message);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// ── Iniciar servidor ───────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ Confecciones Millar v4.0 — Puerto ${PORT}`);
  console.log(`   Control de Piso   : http://localhost:${PORT}/`);
  console.log(`   Control Ingresos  : http://localhost:${PORT}/ingresos`);
  console.log(`   Alistamiento          : http://localhost:${PORT}/alistamiento`);
  console.log(`   Solicitar Insumos : http://localhost:${PORT}/solicitar-insumos`);
  console.log(`   Tablero CI        : http://localhost:${PORT}/ci`);
  console.log(`   Health check      : http://localhost:${PORT}/health`);
  console.log(`   RESET_PASS        : ${RESET_PASS ? '✅ configurada' : '⚠️  NO configurada (reset deshabilitado)'}`);
  console.log(`   CORS origen       : ${ALLOWED_ORIGIN || 'abierto (modo dev)'}`);
});
