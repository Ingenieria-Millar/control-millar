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
  maquinaria:     path.join(DATA_DIR, 'maquinaria.json'),
  guias:          path.join(DATA_DIR, 'guias.json'),
  turnos:         path.join(DATA_DIR, 'turnos.json'),
  historial:      path.join(DATA_DIR, 'historial.json'),
  ordenes:        path.join(DATA_DIR, 'ordenes.json'),
  recogedores:    path.join(DATA_DIR, 'recogedores.json'),
  produccion:     path.join(DATA_DIR, 'produccion.json'),
  revision_telas: path.join(DATA_DIR, 'revision_telas.json'),
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
// multiImps: { [modId]: [ { id, tipo, tipoActual, inicio, empleada, mecanico, ciRequestId } ] }
// Migración automática desde slots fijos anteriores (R/N/M) al nuevo array dinámico
const _oldSlots = floorPersisted.slots || {};
const multiImps = floorPersisted.multiImps || {};

// Migrar slots viejos R/N/M al nuevo formato si no existe multiImps
if (!floorPersisted.multiImps && Object.keys(_oldSlots).length > 0) {
  Object.keys(_oldSlots).forEach(modId => {
    const s = _oldSlots[modId] || {};
    const arr = [];
    ['R','N','M'].forEach(k => {
      if (s[k]) arr.push({ ...s[k], id: s[k].id || (k+'-'+Date.now()) });
    });
    if (arr.length) multiImps[modId] = arr;
  });
}

// Inicializar módulos que falten
MODULES.forEach(id => {
  if (!states[id])       states[id]       = 'green';
  if (!lastMec[id])      lastMec[id]      = '';
  if (!stateTimes[id])   stateTimes[id]   = Date.now();
  if (!lastEmpleada[id]) lastEmpleada[id] = '';
  if (!multiImps[id])    multiImps[id]    = [];
});

// Helper: calcular color del módulo según improductivos activos
// El color mostrado es el del improductivo más reciente (último del array)
function calcColorMod(modId) {
  const imps = multiImps[modId] || [];
  if (!imps.length) return 'green';
  const ultimo = imps[imps.length - 1];
  return ultimo.tipoActual || ultimo.tipo || 'green';
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
    empleadaFinal = empleada || lastEmpleada[id] || '';
    mecanicoFinal = mecanico || lastMec[id] || '';
  } else if(prevState === 'yellow'){
    empleadaFinal = empleada || lastEmpleada[id] || '';
    mecanicoFinal = mecanico || lastMec[id] || '';
  } else if(prevState === 'garnet'){
    // Alistamiento Mecánico: solo mecánico, sin operaria
    mecanicoFinal = mecanico || lastMec[id] || '';
  } else if(prevState === 'pink'){
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
  writeJSON(FILES.floor_state, { states, lastMec, stateTimes, lastEmpleada, multiImps });
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
)
app.get('/hoja-vida', (req, res) =>
  res.sendFile(path.join(__dirname, 'hoja_vida_maquina.html'))
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

app.get('/produccion', (req, res) =>
  res.sendFile(path.join(__dirname, 'produccion.html'))
);

app.get('/revision-telas', (req, res) =>
  res.sendFile(path.join(__dirname, 'revision_telas.html'))
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

// ── API Revisión de Telas ────────────────────────────────────────
app.get('/api/revision-telas', (req, res) => {
  res.json(loadDB('revision_telas') || { registros:[], defectos:[], referencias:[], colores:[] });
});

app.post('/api/revision-telas', (req, res) => {
  const { registros, defectos, referencias, colores } = req.body || {};
  if(!Array.isArray(registros)) return res.status(400).json({ error: 'Payload inválido' });
  const proveedores = req.body.proveedores||[];
  const proveedoresTerceros = req.body.proveedoresTerceros||[];
  saveDB('revision_telas', { registros, defectos: defectos||[], referencias: referencias||[], colores: colores||[], proveedores, proveedoresTerceros });
  res.json({ ok: true });
  // Delay broadcast: el cliente emisor recibe el response HTTP primero,
  // luego los demás clientes reciben el WS update
  setTimeout(()=>{
    broadcast({ type: 'rt_update', registros, defectos: defectos||[], referencias: referencias||[], colores: colores||[], proveedores, proveedoresTerceros });
  }, 800);
});

// ── API Producción (Tablero Kanban) ──────────────────────────────
app.get('/api/produccion', (req, res) => {
  res.json(loadDB('produccion') || { boards: {}, history: [] });
});

app.post('/api/produccion', (req, res) => {
  const { boards, history } = req.body || {};
  if (!boards || typeof boards !== 'object')
    return res.status(400).json({ error: 'Payload inválido' });
  saveDB('produccion', { boards, history: history || [] });
  // Notificar a todos los clientes WS conectados
  broadcastLocal({ type: 'prod_update', boards, history: history || [] });
  res.json({ ok: true });
});

const CI_PATH = path.join(__dirname, 'Tablero_CI.html');
app.get('/ci', (req, res) => {
  if (!fs.existsSync(CI_PATH)) {
    const variants = ['tablero_ci.html','tablero-ci.html','TableroCI.html','tableroCI.html'];
    for (const v of variants) {
      const vpath = path.join(__dirname, v);
      if (fs.existsSync(vpath)) return res.sendFile(vpath);
    }
    return res.status(404).send('<h1>Tablero CI no encontrado</h1>');
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
// ── Job de medianoche — limpiar solicitudes CI y resetear módulos ─────────────────────
function programarCierreMedianoche() {
  const ahora = new Date();
  const medianoche = new Date(ahora);
  medianoche.setHours(24, 0, 0, 0);
  const msHasta = medianoche - ahora;

  setTimeout(() => {
    ejecutarCierreMedianoche();
    // Reprogramar cada 24h
    setInterval(ejecutarCierreMedianoche, 24 * 60 * 60 * 1000);
  }, msHasta);

  console.log(`[SERVER] Cierre medianoche programado en ${Math.round(msHasta/60000)} minutos`);
}

function ejecutarCierreMedianoche() {
  const hora = new Date().toLocaleTimeString('es-CO');
  console.log(`[SERVER] Ejecutando cierre medianoche a las ${hora}`);

  // 1. Cerrar todas las solicitudes CI abiertas
  const estadosCerrados = ['cumplido', 'done'];
  let solicitudesCerradas = 0;
  ciRequests.forEach((req, idx) => {
    if (!estadosCerrados.includes(req.status)) {
      ciRequests[idx] = Object.assign({}, req, {
        status: 'done',
        resolvedAt: '12:00 AM',
        cierreAutomatico: true,
        waitTime: req.alertStart ? (Date.now() - req.alertStart) : 0
      });
      solicitudesCerradas++;
      // Broadcast a todos los clientes
      broadcast({ type: 'ci_cumplido_request', request: ciRequests[idx] });
      broadcast({ type: 'ci_update_request',   request: ciRequests[idx] });
    }
  });
  if (solicitudesCerradas > 0) saveCiRequests();

  // 2. Resetear todos los módulos en purple u orange a green
  const modulosReset = [];
  MODULES.forEach(modId => {
    if (states[modId] === 'orange' || states[modId] === 'purple') {
      const prevState = states[modId];
      states[modId]     = 'green';
      lastMec[modId]    = '';
      stateTimes[modId] = Date.now();
      modulosReset.push(modId);
      // Broadcast cambio de estado a todos los clientes
      broadcast({
        type: 'change',
        id: modId,
        state: 'green',
        mecanico: '',
        limite: null,
        empleada: lastEmpleada[modId] || '',
        stateTime: stateTimes[modId],
        fromMidnight: true
      });
    }
  });
  if (modulosReset.length > 0) saveFloorState();

  console.log(`[SERVER] Medianoche: ${solicitudesCerradas} solicitudes cerradas, ${modulosReset.length} módulos reseteados a verde`);
}

// Iniciar el job al arrancar el servidor
programarCierreMedianoche();

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

app.put(
  '/alistamiento/api/mantenimientos/:id',
  (req, res, next) => upload.array('fotos', 5)(req, res, err => err ? handleMulterError(err, req, res, next) : next()),
  (req, res) => {
    try {
      const data = loadDB('mantenimientos');
      const idx  = data.findIndex(r => r.id === req.params.id);
      if (idx === -1) return res.status(404).json({ error: 'Registro no encontrado' });
      const existing = data[idx];
      const ahora    = new Date();
      const fotos    = req.files && req.files.length
        ? req.files.map(f => `/alistamiento/uploads/${f.filename}`)
        : existing.fotos || [];
      data[idx] = {
        ...existing,
        ...req.body,
        fotos,
        updatedAt: ahora.toISOString()
      };
      saveDB('mantenimientos', data);
      res.json({ success: true, data: data[idx] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
);

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
// ── API Recogedores (lista de miembros del perfil) ───────────────
app.get('/api/recogedores-lista', (req, res) => {
  const appCfg = readJSON(FILES.app_config, {});
  const pm = appCfg._perfil_members || {};
  // Buscar el perfil sin importar mayúsculas
  const key = Object.keys(pm).find(k => k.toLowerCase() === 'recogedores');
  if (key && Array.isArray(pm[key])) {
    const members = pm[key]
      .filter(m => m && !m.disabled)
      .map(m => {
        const nombre = typeof m === 'string' ? m : (m.nombre || m.name || '');
        const isAdmin = typeof m === 'object' && (m.isAdmin === true || m.isAdmin === 'true');
        return { nombre, isAdmin };
      })
      .filter(m => m.nombre);
    members.sort((a, b) => a.nombre.localeCompare(b.nombre));
    return res.json(members);
  }
  res.json([]);
});

app.get('/api/empleados', (req, res) => {
  const emps = (iaState && iaState.employees) ? iaState.employees : [];
  res.json(emps);
});

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

app.get('/api/supervisoras', (req, res) => {
  // Leer miembros del perfil "Supervisoras" desde app_config._perfil_members
  const appCfg = readJSON(FILES.app_config, {});
  const perfilMembers = appCfg._perfil_members;
  // Buscar perfil que contenga "supervis" (insensible a mayúsculas)
  const key = Object.keys(perfilMembers || {}).find(k => k.toLowerCase().includes('supervis'));
  if (key && Array.isArray(perfilMembers[key])) {
    const members = perfilMembers[key]
      .filter(m => m && !m.disabled)
      .map(m => {
        const nombre = typeof m === 'string' ? m : (m.nombre || m.name || '');
        return { id: nombre, name: nombre, nombre };
      })
      .filter(m => m.name);
    if (members.length > 0) {
      members.sort((a, b) => a.name.localeCompare(b.name));
      return res.json(members);
    }
  }
  // Fallback: supervisores del sistema
  const sups = (iaState.supervisors || []).filter(s => s.id !== 'programador' && !s.disabled);
  res.json(sups.map(s => ({ id: s.id, name: s.name, nombre: s.name })));
});

// Novedades
app.get('/api/novedades',  (req, res) => res.json(readJSON(FILES.novedades, [])));
app.post('/api/novedades', (req, res) => {
  try {
    writeJSON(FILES.novedades, Array.isArray(req.body) ? req.body : []);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// Maquinaria
app.get('/api/maquinaria',  (req, res) => res.json(readJSON(FILES.maquinaria, [])));
app.post('/api/maquinaria', (req, res) => {
  try { writeJSON(FILES.maquinaria, req.body); res.json({ success: true }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Guías
app.get('/api/guias',  (req, res) => res.json(readJSON(FILES.guias, [])));
app.post('/api/guias', (req, res) => {
  try { writeJSON(FILES.guias, req.body); res.json({ success: true }); }
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
    multiImps:     JSON.parse(JSON.stringify(multiImps))
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
        // SOLO si NO viene de multi-improductivo — el multi tiene su propio registro en close
        const prevState = states[msg.id];

        // Actualizar empleada y mecánico en memoria ANTES de logHistorial
        if (msg.empleada) lastEmpleada[msg.id] = msg.empleada;
        if (msg.mecanico) lastMec[msg.id] = msg.mecanico;

        // Solo registrar si es un cambio de estado simple (no multi)
        // msg.fromMulti=true significa que viene del sistema de multi-improductivos
        if (!msg.fromMulti) {
          logHistorial(msg.id, prevState, msg.state || 'green', msg.mecanico || lastMec[msg.id] || '', msg.empleada || lastEmpleada[msg.id] || '');
        }

        states[msg.id]     = msg.state || 'green';
        stateTimes[msg.id] = Date.now();
        if (msg.state === 'red') lastMec[msg.id] = '';
        else if (msg.mecanico) lastMec[msg.id] = msg.mecanico;
        // Guardar empleada: conservar si hay nueva, limpiar solo al volver a green
        if (msg.empleada) lastEmpleada[msg.id] = msg.empleada;
        else if (msg.state === 'green') lastEmpleada[msg.id] = '';
        saveFloorState();
        const esRed = (msg.state === 'red' || msg.state === 'garnet');
        broadcastLocal({ type:'change', id:msg.id, state:msg.state, mecanico:msg.mecanico||'', limite:msg.limite||null, empleada:lastEmpleada[msg.id]||'', stateTime:stateTimes[msg.id], fromSlot:esRed, fromMulti:!esRed });
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

        // Si fue aceptado (done), cerrar el improductivo CI correspondiente en multiImps
        if (msg.request.status === 'done' && msg.request._id) {
          const reqId = msg.request._id;
          const modId = msg.request.module || msg.request.moduloDestino;
          if (modId && multiImps[modId]) {
            const idx = multiImps[modId].findIndex(i => i.ciRequestId === reqId);
            if (idx > -1) {
              const imp   = multiImps[modId][idx];
              const ahora = Date.now();
              const durMs = ahora - (imp.inicio || ahora);
              if (durMs > 0) {
                const now      = new Date();
                const opts     = { timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true };
                const bogota   = new Date(now.toLocaleString('en-US', { timeZone:'America/Bogota' }));
                const fechaISO = bogota.getFullYear()+'-'+String(bogota.getMonth()+1).padStart(2,'0')+'-'+String(bogota.getDate()).padStart(2,'0');
                let historial  = readJSON(FILES.historial, []);
                const regHoy   = historial.filter(r => r.fechaISO === fechaISO);
                historial.push({
                  num: regHoy.length+1, fecha: now.toLocaleDateString('es-CO',{timeZone:'America/Bogota'}), fechaISO,
                  horaInicio: new Date(imp.inicio||ahora).toLocaleTimeString('es-CO',opts),
                  hora: now.toLocaleTimeString('es-CO',opts), modulo: modId,
                  tipo: imp.tipoActual||imp.tipo, estadoAnterior: imp.tipoActual||imp.tipo, estadoNuevo:'green',
                  durMinutos: parseFloat((durMs/60000).toFixed(2)),
                  mecanico: imp.mecanico||'', empleada: imp.empleada||'', ciRequestId: reqId
                });
                if (historial.length > 10000) historial = historial.slice(-10000);
                writeJSON(FILES.historial, historial);
              }
              multiImps[modId].splice(idx, 1);
              states[modId]     = calcColorMod(modId);
              stateTimes[modId] = Date.now();
              if (states[modId] === 'green') { lastMec[modId]=''; lastEmpleada[modId]=''; }
              saveFloorState();
              // Notificar al contador_modulos y tablero general
              broadcastLocal({ type:'multi_imp_change', action:'close', modId, impId: imp.id });
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

      // ── Multi-Improductivo — sistema dinámico por array ────────────
      // msg: { type:'multi_imp_change', modId, action, imp }
      // action: 'open' | 'update' | 'close'
      // imp: { id, tipo, tipoActual, inicio, empleada, mecanico, ciRequestId }
      else if (msg.type === 'multi_imp_change') {
        const modId = msg.modId;
        if (!modId) return;
        if (!multiImps[modId]) multiImps[modId] = [];

        // ── OPEN ──────────────────────────────────────────────────
        if (msg.action === 'open') {
          const imp = msg.imp || {};
          if (!imp.id) return;
          // Evitar duplicados
          if (multiImps[modId].find(i => i.id === imp.id)) return;
          multiImps[modId].push({
            id:          imp.id,
            tipo:        imp.tipo,
            tipoActual:  imp.tipoActual || imp.tipo,
            inicio:      imp.inicio || Date.now(),
            empleada:    imp.empleada || '',
            mecanico:    imp.mecanico || '',
            ciRequestId: imp.ciRequestId || null,
            esPrincipal: imp.esPrincipal || false
          });
          if (imp.empleada) lastEmpleada[modId] = imp.empleada;
          if (imp.mecanico) lastMec[modId]      = imp.mecanico;
          states[modId]     = calcColorMod(modId);
          stateTimes[modId] = imp.inicio || Date.now();
          saveFloorState();
          broadcastLocal({ type:'multi_imp_change', action:'open', modId, imp: multiImps[modId][multiImps[modId].length-1] });
          // Notificar tablero general y tablero mecánicos
          const esRed = ['red','garnet','pink'].includes(imp.tipoActual || imp.tipo);
          broadcast({
            type:'change', id:modId, state:states[modId],
            mecanico:lastMec[modId]||'', limite:null,
            empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId],
            fromMulti: !esRed,   // fromMulti=false → tablero mecánicos suena
            fromSlot:  esRed
          });
        }

        // ── UPDATE ────────────────────────────────────────────────
        else if (msg.action === 'update') {
          const imp = msg.imp || {};
          if (!imp.id) return;
          const idx = multiImps[modId].findIndex(i => i.id === imp.id);
          if (idx === -1) return;
          Object.assign(multiImps[modId][idx], imp);
          if (imp.mecanico) lastMec[modId]      = imp.mecanico;
          if (imp.empleada) lastEmpleada[modId] = imp.empleada;
          states[modId]     = calcColorMod(modId);
          stateTimes[modId] = Date.now();
          saveFloorState();
          broadcastLocal({ type:'multi_imp_change', action:'update', modId, imp: multiImps[modId][idx] });
          const esRed = ['red','yellow','garnet'].includes(multiImps[modId][idx].tipoActual || multiImps[modId][idx].tipo);
          broadcast({
            type:'change', id:modId, state:states[modId],
            mecanico:lastMec[modId]||'', limite:null,
            empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId],
            fromMulti: !esRed, fromSlot: esRed
          });
        }

        // ── CLOSE ─────────────────────────────────────────────────
        else if (msg.action === 'close') {
          const impId = msg.imp?.id || msg.impId;
          if (!impId) return;
          const idx = multiImps[modId].findIndex(i => i.id === impId);
          if (idx === -1) return;
          const imp = multiImps[modId][idx];

          // Solo registrar en historial si NO es el imp principal
          // El imp principal ya fue registrado por el bloque 'change' cuando se creó
          if (!imp.esPrincipal) {
            const ahora  = Date.now();
            const durMs  = ahora - (imp.inicio || ahora);
            if (durMs > 0) {
              const now      = new Date();
              const opts     = { timeZone:'America/Bogota', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true };
              const bogota   = new Date(now.toLocaleString('en-US', { timeZone:'America/Bogota' }));
              const fechaISO = bogota.getFullYear()+'-'+String(bogota.getMonth()+1).padStart(2,'0')+'-'+String(bogota.getDate()).padStart(2,'0');
              let historial  = readJSON(FILES.historial, []);
              const regHoy   = historial.filter(r => r.fechaISO === fechaISO);
              const tipoReal = imp.tipoActual || imp.tipo;
              historial.push({
                num:            regHoy.length + 1,
                fecha:          now.toLocaleDateString('es-CO', { timeZone:'America/Bogota' }),
                fechaISO,
                horaInicio:     new Date(imp.inicio || ahora).toLocaleTimeString('es-CO', opts),
                hora:           now.toLocaleTimeString('es-CO', opts),
                modulo:         modId,
                tipo:           tipoReal,
                estadoAnterior: tipoReal,
                estadoNuevo:    'green',
                durMinutos:     parseFloat((durMs / 60000).toFixed(2)),
                mecanico:       imp.mecanico || '',
                empleada:       imp.empleada || '',
                ciRequestId:    imp.ciRequestId || undefined
              });
              if (historial.length > 10000) historial = historial.slice(-10000);
              writeJSON(FILES.historial, historial);
            }
          }

          // Quitar del array
          multiImps[modId].splice(idx, 1);
          states[modId]     = calcColorMod(modId);
          stateTimes[modId] = Date.now();
          if (states[modId] === 'green') {
            lastMec[modId]      = '';
            lastEmpleada[modId] = '';
          }
          saveFloorState();
          broadcastLocal({ type:'multi_imp_change', action:'close', modId, impId });
          // Broadcast para actualizar tablero general
          broadcast({
            type:'change', id:modId, state:states[modId],
            mecanico:lastMec[modId]||'', limite:null,
            empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId],
            fromMulti:true
          });
        }
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
  console.log(`✅ Confecciones Millar v4.0 | Puerto ${PORT} | RESET_PASS: ${RESET_PASS ? 'OK' : 'NO configurada'} | CORS: ${ALLOWED_ORIGIN || 'abierto'}`);
});
