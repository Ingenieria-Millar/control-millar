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
const bcrypt   = require('bcryptjs');
const crypto   = require('crypto');

// ── WhatsApp via Baileys (sin Chrome) ─────────────────────────────
let waClient = null, waQrDataUrl = null, waReady = false, waStatus = 'desconectado';
let _Baileys, _QRCode;
try {
  _Baileys = require('@whiskeysockets/baileys');
  _QRCode  = require('qrcode');
  console.log('[WA] Módulos cargados OK');
} catch(e) {
  console.error('[WA] Error cargando módulos:', e.message);
}

async function initWhatsApp() {
  if (!_Baileys) { waStatus = 'módulo no instalado'; console.error('[WA] Módulo no disponible — no se inicia'); return; }
  // Limpiar cliente anterior antes de crear uno nuevo
  if (waClient) { try { waClient.end(undefined); } catch {} waClient = null; }
  try {
    const WA_DIR = path.join(fs.existsSync('/var/data') ? '/var/data' : path.join(__dirname, 'data'), 'wwa-session');
    if (!fs.existsSync(WA_DIR)) fs.mkdirSync(WA_DIR, { recursive: true });

    const { state, saveCreds } = await _Baileys.useMultiFileAuthState(WA_DIR);
    const pino = require('pino');

    let waVersion;
    try {
      const fetched = await _Baileys.fetchLatestBaileysVersion();
      waVersion = fetched.version;
      console.log('[WA] Versión WA Web:', waVersion.join('.'));
    } catch {
      waVersion = [2, 3000, 1019032649];
      console.log('[WA] Versión WA Web (fallback):', waVersion.join('.'));
    }

    waClient = _Baileys.default({
      version: waVersion,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: 'silent' }),
      browser: _Baileys.Browsers.ubuntu('Chrome'),
      syncFullHistory: false,
    });

    const thisClient = waClient;

    waClient.ev.on('creds.update', saveCreds);

    waClient.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
      if (thisClient !== waClient) return; // cliente obsoleto, ignorar
      if (qr) {
        try { waQrDataUrl = await _QRCode.toDataURL(qr); } catch { waQrDataUrl = null; }
        waReady = false; waStatus = 'esperando QR';
        console.log('[WA] QR generado');
      }
      if (connection === 'open') {
        waReady = true; waQrDataUrl = null; waStatus = 'conectado';
        console.log('[WA] Conectado');
      }
      if (connection === 'close') {
        waReady = false; waQrDataUrl = null; waClient = null;
        const { Boom } = require('@hapi/boom');
        const code = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : 0;
        const { DisconnectReason } = _Baileys;
        console.log('[WA] Conexión cerrada, código:', code);
        if (code === DisconnectReason.loggedOut) {
          waStatus = 'sesión cerrada — escanea QR de nuevo';
          console.log('[WA] Sesión cerrada');
          setTimeout(initWhatsApp, 3000);
        } else {
          waStatus = 'reconectando…';
          setTimeout(initWhatsApp, 5000);
        }
      }
    });

    waStatus = 'iniciando';
  } catch(e) {
    waStatus = 'error: ' + e.message;
    console.error('[WA] Error init:', e.message);
  }
}
if (process.env.ENABLE_WHATSAPP === 'true') {
  console.log('[WA] ENABLE_WHATSAPP=true detectado — iniciando...');
  initWhatsApp();
} else {
  console.log('[WA] ENABLE_WHATSAPP no es true — WA desactivado');
}

async function enviarWhatsApp(telefono, mensaje) {
  if (!waReady || !waClient) throw new Error('WhatsApp no conectado');
  const digits = String(telefono).replace(/\D/g, '');
  const jid = (digits.startsWith('57') ? digits : '57' + digits) + '@s.whatsapp.net';
  await waClient.sendMessage(jid, { text: mensaje });
}

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

// ── Secreto para firmar tokens de sesión (Paso 1 — auth server) ──
// En producción DEFINIR SESSION_SECRET en Render. Si falta, se genera uno
// efímero por arranque (las sesiones no sobreviven a un reinicio, pero el
// servidor sigue operando — degradación segura, no se rompe nada).
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET no definida — usando secreto efímero (configúrala en Render para sesiones persistentes).');
}

// ── Interruptor de seguridad de la "puerta de atrás" ──────────────
// AUTH_ENFORCE=false (por defecto): las rutas API y el WebSocket NO exigen
//   sesión → comportamiento idéntico al actual, no rompe nada.
// AUTH_ENFORCE=true: exige token válido para /api/* y el WebSocket.
//   Activar SOLO después de definir SESSION_SECRET. Si algo falla, volver a
//   poner false en Render y todo regresa a la normalidad al instante.
const AUTH_ENFORCE = process.env.AUTH_ENFORCE === 'true';
console.log(`[AUTH] Puerta de atrás (AUTH_ENFORCE): ${AUTH_ENFORCE ? 'ENCENDIDA (exige sesión)' : 'apagada (abierta)'}`);

// ── Directorios ────────────────────────────────────────────────────
// Red de seguridad: si no se define DATA_DIR pero existe el disco persistente
// de Render montado en /var/data, usarlo automáticamente. Así, aunque se borre
// por error la variable DATA_DIR, la app sigue leyendo/guardando en el disco
// (no se pierden los datos).
const _RENDER_DISK = '/var/data';
const _DISK_OK     = (() => { try { return fs.existsSync(_RENDER_DISK); } catch (e) { return false; } })();
const DATA_DIR    = process.env.DATA_DIR    || (_DISK_OK ? _RENDER_DISK : path.join(__dirname, 'data'));
// Las fotos también van al disco permanente (antes se perdían en cada deploy).
const UPLOADS_DIR = process.env.UPLOADS_DIR || (_DISK_OK ? path.join(_RENDER_DISK, 'uploads') : path.join(__dirname, 'uploads'));
console.log(`[INIT] DATA_DIR = ${DATA_DIR}${(!process.env.DATA_DIR && _DISK_OK) ? ' (auto: disco Render)' : ''}`);

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
  incentivos:     path.join(DATA_DIR, 'incentivos.json'),
  incentivos_disp: path.join(DATA_DIR, 'incentivos_disponibilidad.json'),
  incentivos_config: path.join(DATA_DIR, 'incentivos_config.json'),
  users:          path.join(DATA_DIR, 'users.json'),
  multitareas:    path.join(DATA_DIR, 'multitareas.json'),
  tareas:         path.join(DATA_DIR, 'tareas.json'),
  visitantes:     path.join(DATA_DIR, 'visitantes.json'),
  turnos_asignados: path.join(DATA_DIR, 'turnos_asignados.json'),
  consultas_contrato: path.join(DATA_DIR, 'consultas_contrato.json'),
  corte_solicitudes: path.join(DATA_DIR, 'corte_solicitudes.json'),
  mmt_locativo:   path.join(DATA_DIR, 'mmt_locativo.json'),
};

// ══════════════════════════════════════════════════════════════════
//  ALMACENAMIENTO — SQLite opcional (Paso 2-B)
//  Interruptor: STORAGE=sqlite → guarda en una base de datos SQLite
//  (un solo archivo robusto en el disco). Sin la variable = archivos
//  JSON, igual que siempre. La primera vez migra solo los JSON existentes.
//  Si SQLite falla al cargar, cae de forma segura a JSON.
// ══════════════════════════════════════════════════════════════════
const USE_SQLITE = (process.env.STORAGE || '').toLowerCase() === 'sqlite';
const DB_PATH    = process.env.SQLITE_PATH || path.join(DATA_DIR, 'millar.db');
let _sqlite = null, _stmtGet = null, _stmtSet = null;

function keyFromPath(p) {
  return path.basename(String(p)).replace(/\.json$/i, '');
}

if (USE_SQLITE) {
  try {
    const Database = require('better-sqlite3');
    _sqlite = new Database(DB_PATH);
    _sqlite.pragma('journal_mode = WAL');    // más resistente ante cortes
    _sqlite.pragma('synchronous = FULL');    // cada guardado se graba en disco de inmediato (máxima durabilidad, nada se queda "en borrador")
    _sqlite.pragma('busy_timeout = 5000');   // si la BD está ocupada, espera hasta 5s en vez de fallar al instante (evita fallos falsos por choques)
    _sqlite.exec('CREATE TABLE IF NOT EXISTS store (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER)');
    _stmtGet = _sqlite.prepare('SELECT value FROM store WHERE key = ?');
    _stmtSet = _sqlite.prepare('INSERT INTO store (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at');

    // Migración única: sembrar la base con los archivos JSON existentes
    const yaMigrado = _stmtGet.get('__migrated__');
    if (!yaMigrado) {
      const tx = _sqlite.transaction(() => {
        Object.values(FILES).forEach(f => {
          const k = keyFromPath(f);
          if (_stmtGet.get(k)) return;            // no pisar lo que ya esté
          if (fs.existsSync(f)) {
            try {
              const raw = fs.readFileSync(f, 'utf8');
              JSON.parse(raw);                     // validar que sea JSON válido
              _stmtSet.run(k, raw, Date.now());
            } catch (e) { console.error('[SQLITE] No se pudo migrar', f, e.message); }
          }
        });
        _stmtSet.run('__migrated__', JSON.stringify({ ts: Date.now() }), Date.now());
      });
      tx();
      console.log('[SQLITE] Migración inicial completada desde archivos JSON.');
    }
    console.log(`[SQLITE] Almacenamiento en base de datos ACTIVO (${DB_PATH}).`);
  } catch (e) {
    console.error('[SQLITE] Error iniciando SQLite — se usará JSON:', e.message);
    _sqlite = null;
  }
}
const SQLITE_ON = !!(USE_SQLITE && _sqlite);

function sqliteGet(key, defaultValue) {
  try { const row = _stmtGet.get(key); return row ? JSON.parse(row.value) : defaultValue; }
  catch (e) { console.error('[SQLITE] get', key, e.message); return defaultValue; }
}
// Devuelve true/false según si la escritura REALMENTE quedó guardada.
// Antes este error se tragaba en silencio y las rutas respondían "ok" igual
// aunque el guardado hubiera fallado (disco lleno, bloqueo, etc.) — el
// navegador nunca se enteraba. Ahora el llamador puede saber si falló.
function sqliteSet(key, data) {
  try { _stmtSet.run(key, JSON.stringify(data), Date.now()); return true; }
  catch (e) { console.error('[SQLITE] set', key, e.message); return false; }
}

// ── Helpers de persistencia ────────────────────────────────────────
function readJSON(filePath, defaultValue) {
  if (SQLITE_ON) return sqliteGet(keyFromPath(filePath), defaultValue);
  try {
    if (fs.existsSync(filePath))
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.error('Error leyendo', filePath, e.message);
  }
  return defaultValue;
}

// ── Write queue — evita escrituras síncronas bloqueantes ──────────
// Devuelve true/false (con SQLite activo la escritura es inmediata y
// síncrona, así que el resultado real ya se conoce al momento de llamar).
const _writeQueue = {};
function writeJSON(filePath, data) {
  if (SQLITE_ON) return sqliteSet(keyFromPath(filePath), data);
  // Cancelar escritura pendiente y programar nueva (debounce por archivo)
  if (_writeQueue[filePath]) clearTimeout(_writeQueue[filePath]);
  _writeQueue[filePath] = setTimeout(() => {
    delete _writeQueue[filePath];
    fs.promises.writeFile(filePath, JSON.stringify(data), 'utf8')
      .catch(e => console.error('Error escribiendo', filePath, e.message));
  }, 0); // nextTick — libera el event loop
  return true; // encolada; modo archivo local (no producción) — no crítico
}

// Escritura SÍNCRONA que respeta la MISMA bodega que readJSON.
// Si SQLite está activo, guarda en SQLite (no en archivo suelto), para que
// el guardado y la lectura usen el mismo almacén y el dato no "desaparezca".
// Devuelve true/false según si realmente quedó guardado.
function writeJSONSync(filePath, data) {
  if (SQLITE_ON) return sqliteSet(keyFromPath(filePath), data);
  try { fs.writeFileSync(filePath, JSON.stringify(data), 'utf8'); return true; }
  catch (e) { console.error('Error escribiendo (sync)', filePath, e.message); return false; }
}

// ── Caché en memoria ───────────────────────────────────────────────
const dbCache = {};

function loadDB(key) {
  if (!dbCache[key]) {
    if (SQLITE_ON) {
      dbCache[key] = sqliteGet(key, []);
    } else {
      try {
        dbCache[key] = fs.existsSync(FILES[key])
          ? JSON.parse(fs.readFileSync(FILES[key], 'utf8'))
          : [];
      } catch(e) {
        console.error('Error cargando caché', key, e.message);
        dbCache[key] = [];
      }
    }
  }
  return dbCache[key];
}

// Devuelve true/false según si el guardado realmente quedó persistido.
// El caché en memoria (dbCache) se actualiza siempre para que la app
// siga respondiendo rápido, pero el llamador debe revisar el resultado
// antes de decirle al usuario "guardado" — si es false, el dato SOLO
// quedó en memoria (se pierde si el servidor se reinicia).
function saveDB(key, data) {
  dbCache[key] = data;
  if (SQLITE_ON) return sqliteSet(key, data);
  try {
    fs.writeFileSync(FILES[key], JSON.stringify(data), 'utf8');
    return true;
  } catch (e) {
    console.error('Error guardando', key, e.message);
    return false;
  }
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

function saveIaState()       { const ok = writeJSON(FILES.ia_state,       iaState);       if (!ok) notifySaveError('Control de Asistencia'); return ok; }
function saveIaRecords()     { const ok = writeJSON(FILES.ia_records,     iaRecords);     if (!ok) notifySaveError('Control de Asistencia'); return ok; }
function saveModulesConfig() { const ok = writeJSON(FILES.modules_config, modulesConfig); if (!ok) notifySaveError('Configuración de módulos'); return ok; }

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
  if (historial.length > HISTORIAL_MAX) historial = historial.slice(-HISTORIAL_MAX);
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
  const ok = writeJSON(FILES.floor_state, { states, lastMec, stateTimes, lastEmpleada, multiImps });
  if (!ok) notifySaveError('Tablero de Piso');
  return ok;
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

function saveCiRequests() { const ok = writeJSON(FILES.ci_requests, ciRequests); if (!ok) notifySaveError('Tablero CI'); return ok; }
function saveCiConfig()   { const ok = writeJSON(FILES.ci_config,   ciConfig);   if (!ok) notifySaveError('Tablero CI'); return ok; }

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
//  AUTENTICACIÓN SERVIDOR (Paso 1 — endurecimiento)
//  ADITIVO: agrega login server-side con contraseñas hasheadas (bcrypt).
//  No reemplaza todavía el login client-side; convive hasta que el
//  cliente se migre. Cierra la base para quitar las contraseñas en claro.
// ══════════════════════════════════════════════════════════════════

const BCRYPT_ROUNDS = 10;

// Construye el almacén de usuarios hasheado a partir de las fuentes
// actuales (app_config._usuarios_extra + Programador). Idempotente: si
// users.json ya existe, no lo regenera (evita re-hashear en cada arranque).
function ensureUsersFile() {
  // Debe respetar SQLite: mirar el archivo físico no sirve (con SQLite nunca se crea).
  // Revisamos si ya hay usuarios en el almacén real (archivo o SQLite) antes de re-crear.
  const _existentes = readJSON(FILES.users, null);
  if (_existentes && _existentes.users && Object.keys(_existentes.users).length) return _existentes;

  const appCfg = readJSON(FILES.app_config, {});
  const extra  = Array.isArray(appCfg._usuarios_extra) ? appCfg._usuarios_extra : [];
  const users  = {};

  // Programador — contraseña histórica '1' (hasheada). Cambiar cuanto antes.
  users['Programador'] = {
    passHash: bcrypt.hashSync('1', BCRYPT_ROUNDS),
    perms:    ['*'],
    rol:      'programador',
    disabled: false
  };

  // Usuarios creados por el Programador
  extra.forEach(u => {
    if (!u || !u.nombre || u.nombre === 'Programador') return;
    // Preferir passHash guardado (persiste reinicios). Fallback: hashear pass en claro.
    const passHash = u.passHash
      || bcrypt.hashSync(String(u.pass == null ? '' : u.pass), BCRYPT_ROUNDS);
    users[u.nombre] = {
      passHash,
      perms:    Array.isArray(u.perms) ? u.perms : [],
      rol:      '',
      disabled: !!u.disabled
    };
  });

  const store = { version: 1, migratedAt: new Date().toISOString(), users };
  try {
    writeJSONSync(FILES.users, store);   // usa SQLite si está activo (no solo archivo suelto)
    console.log(`[AUTH] users.json creado — ${Object.keys(users).length} usuario(s) migrados a hash.`);
  } catch (e) {
    console.error('[AUTH] Error creando users.json:', e.message);
  }
  return store;
}

function loadUsers() {
  return readJSON(FILES.users, null) || ensureUsersFile();
}

// Sincroniza users.json con los usuarios definidos en app_config._usuarios_extra.
// Se llama cuando el admin crea/edita/deshabilita usuarios. Re-hashea solo si
// la contraseña cambió (bcrypt.compare contra el hash existente). Así el login
// server-side queda al día sin romper el panel de administración actual.
function syncUsersFromConfig(appCfg) {
  try {
    const store = loadUsers();
    const extra = Array.isArray(appCfg && appCfg._usuarios_extra) ? appCfg._usuarios_extra : [];
    let changed = false;
    extra.forEach(u => {
      if (!u || !u.nombre) return;
      const esProg = u.nombre === 'Programador';
      const cur = store.users[u.nombre];
      // Contraseña en blanco al editar = "no cambiar". Solo se re-hashea si
      // llega una contraseña nueva no vacía (y distinta de la actual).
      const hasNewPass = u.pass != null && String(u.pass) !== '';
      let passHash;
      if (hasNewPass) {
        passHash = (cur && bcrypt.compareSync(String(u.pass), cur.passHash))
          ? cur.passHash
          : bcrypt.hashSync(String(u.pass), BCRYPT_ROUNDS);
      } else if (u.passHash) {
        // Hash guardado en app_config (sobrevive reinicios sin contraseña en claro)
        passHash = u.passHash;
      } else {
        passHash = cur ? cur.passHash : bcrypt.hashSync('', BCRYPT_ROUNDS);
      }
      store.users[u.nombre] = {
        passHash,
        // El Programador conserva siempre acceso total; el resto usa sus permisos.
        perms:    esProg ? ['*'] : (Array.isArray(u.perms) ? u.perms : (cur ? cur.perms : [])),
        rol:      esProg ? 'programador' : (cur ? cur.rol : ''),
        disabled: esProg ? false : !!u.disabled,
        // Conservar el perfil (correo / nombre visible) que el usuario edita en "Mi perfil".
        email:       (u.email != null ? String(u.email) : (cur ? cur.email : '')) || '',
        displayName: (u.displayName != null ? String(u.displayName) : (cur ? cur.displayName : '')) || ''
      };
      changed = true;
    });
    if (changed) {
      store.updatedAt = new Date().toISOString();
      writeJSONSync(FILES.users, store);   // usa SQLite si está activo (login lee del mismo almacén)
    }
  } catch (e) {
    console.error('[AUTH] syncUsersFromConfig falló:', e.message);
  }
}

// Devuelve una copia de app_config SIN contraseñas (ni cleartext ni hash).
// El cliente nunca debe recibir credenciales; los hashes viven en app_config
// en disco y en users.json para login rápido.
function stripUserPasswords(cfg) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  const out = Object.assign({}, cfg);
  if (Array.isArray(cfg._usuarios_extra)) {
    out._usuarios_extra = cfg._usuarios_extra.map(u => {
      if (u && typeof u === 'object') {
        const { pass, passHash, ...rest } = u;
        return rest;
      }
      return u;
    });
  }
  return out;
}

// Token de sesión firmado (HMAC). Formato: base64url(payload).hmac
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  // Comparación en tiempo constante
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && Date.now() > payload.exp) return null; // expirado
    return payload;
  } catch { return null; }
}

// Crear el almacén al arrancar (migración única)
ensureUsersFile();

// ══════════════════════════════════════════════════════════════════
//  COPIAS DE SEGURIDAD AUTOMÁTICAS (Paso 2 — Parte A)
//  Copia todos los archivos de datos a una carpeta con fecha, cada
//  cierto tiempo, y conserva solo las últimas N (rotación). Protege
//  contra archivos dañados, borrados accidentales o malas ediciones.
// ══════════════════════════════════════════════════════════════════
const BACKUP_DIR     = process.env.BACKUP_DIR   || path.join(DATA_DIR, '_backups');
const BACKUP_KEEP    = parseInt(process.env.BACKUP_KEEP    || '6',  10); // cuántas conservar (6 = 1.5 días con copias cada 6h — evita llenar discos pequeños)
const BACKUP_EVERY_H = parseInt(process.env.BACKUP_EVERY_H || '6',  10); // cada cuántas horas

// ── Topes máximos de registros (rotación en memoria) ───────────────
// Cuando una lista supera el tope, se descartan los más antiguos para no
// crecer sin fin. Se subieron 10x respecto a los valores originales y son
// configurables por variable de entorno si algún día se necesita más.
const HISTORIAL_MAX = parseInt(process.env.HISTORIAL_MAX || '100000', 10); // improductivos (antes 10.000)
const CI_MAX        = parseInt(process.env.CI_MAX        || '100000', 10); // solicitudes CI (antes 50.000)

let _lastBackup = { ts: null, ok: false, files: 0, error: null };
function hacerBackup() {
  try {
    if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(BACKUP_DIR, ts);
    fs.mkdirSync(dest, { recursive: true });
    let copiados = 0;
    Object.values(FILES).forEach(f => {
      if (fs.existsSync(f)) { fs.copyFileSync(f, path.join(dest, path.basename(f))); copiados++; }
    });
    // Si SQLite está activo, respaldar también la base de datos (consistente)
    if (SQLITE_ON && _sqlite) {
      try { _sqlite.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) {}
      if (fs.existsSync(DB_PATH)) { fs.copyFileSync(DB_PATH, path.join(dest, path.basename(DB_PATH))); copiados++; }
    }
    // Rotación: conservar solo las últimas BACKUP_KEEP copias
    let carpetas = fs.readdirSync(BACKUP_DIR)
      .filter(n => { try { return fs.statSync(path.join(BACKUP_DIR, n)).isDirectory(); } catch(e){ return false; } })
      .sort();
    while (carpetas.length > BACKUP_KEEP) {
      const vieja = carpetas.shift();
      fs.rmSync(path.join(BACKUP_DIR, vieja), { recursive: true, force: true });
    }
    _lastBackup = { ts: Date.now(), ok: true, files: copiados, error: null };
    console.log(`[BACKUP] Copia creada (${copiados} archivos). Conservadas: ${carpetas.length}`);
  } catch (e) {
    _lastBackup = { ts: Date.now(), ok: false, files: 0, error: e.message };
    console.error('[BACKUP] Error:', e.message);
  }
}
// Primera copia al minuto de arrancar, y luego cada BACKUP_EVERY_H horas
const _backupFirst = setTimeout(hacerBackup, 60 * 1000);
setInterval(hacerBackup, BACKUP_EVERY_H * 60 * 60 * 1000);

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
  // Forzar HTTPS en navegadores (seguro en Render, que ya usa HTTPS).
  res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  next();
});

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// ── Saneamiento anti-XSS de toda entrada (Paso 1) ─────────────────
// Limpia contenido peligroso (scripts, etiquetas activas, manejadores de
// eventos, javascript:) de TODO lo que llega en el body, SIN alterar el
// texto normal. Cubre todos los formularios sin tocar las páginas. Solo
// neutraliza ataques; el texto común (nombres, observaciones) pasa intacto.
function sanitizeString(s) {
  if (typeof s !== 'string') return s;
  return s
    .replace(/<\s*script[^>]*>[\s\S]*?<\s*\/\s*script\s*>/gi, '')              // <script>...</script>
    .replace(/<\s*\/?\s*(script|iframe|object|embed|form|link|meta|base)\b[^>]*>/gi, '') // etiquetas activas
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')                  // onclick=, onerror=, ...
    .replace(/javascript\s*:/gi, '');                                          // javascript:
}
function sanitizeDeep(val) {
  if (typeof val === 'string') return sanitizeString(val);
  if (Array.isArray(val)) return val.map(sanitizeDeep);
  if (val && typeof val === 'object') {
    const out = {};
    for (const k in val) if (Object.prototype.hasOwnProperty.call(val, k)) out[k] = sanitizeDeep(val[k]);
    return out;
  }
  return val;
}
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    try { req.body = sanitizeDeep(req.body); } catch (e) { /* ante cualquier duda, no bloquear */ }
  }
  next();
});

// ── Guardia de la "puerta de atrás" ───────────────────────────────
// Solo actúa cuando AUTH_ENFORCE=true. Protege /api/* y /alistamiento/api/*.
// Deja públicas: páginas HTML, imágenes, login, /api/me y /health.
const AUTH_PUBLIC = new Set(['/api/login', '/api/me', '/health', '/api/buscar-contrato']);
app.use((req, res, next) => {
  if (!AUTH_ENFORCE) return next();                          // interruptor apagado
  const esApi = req.path.startsWith('/api') || req.path.startsWith('/alistamiento/api');
  if (!esApi) return next();                                 // páginas/archivos estáticos: libres
  if (AUTH_PUBLIC.has(req.path)) return next();              // rutas públicas
  const hdr   = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7)
              : (req.headers['x-session-token'] || req.query.token || '');
  if (verifyToken(token)) return next();
  return res.status(401).json({ error: 'No autenticado' });
});

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

// Evita que el navegador se quede con una copia vieja en caché de las
// pantallas HTML — obliga a revalidar con el servidor en cada carga, para
// que todos los equipos (PC y celulares) reciban el código actualizado
// sin necesitar un refresco forzado manual.
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api') && !req.path.startsWith('/punto-seguro')) {
    res.set('Cache-Control', 'no-cache');
  }
  next();
});

// ── Rutas principales ──────────────────────────────────────────────
// Los archivos de cada pantalla viven en modulos/<nombre>/ — las URLs no cambian,
// solo dónde vive el archivo en disco.
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/index/index.html'))
);
app.get('/ingresos', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/ingresos/ingresos.html'))
);
// Registro Mecánicos (antes "Alistamiento"). Servido en la ruta nueva y la vieja (alias).
app.get(['/registro-mecanicos', '/alistamiento'], (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/registro-mecanicos/registro-mecanicos.html'))
);

app.get('/solicitar-insumos', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/solicitar-insumos/solicitar_insumos.html'))
)
app.get('/hoja-vida', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/hoja-vida-maquina/hoja_vida_maquina.html'))
);

app.get('/ordenes', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/ordenes/ordenes.html'))
);

app.get('/contador-modulos', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/contador-modulos/contador_modulos.html'))
);

// ── Recogedores ───────────────────────────────────────────────────
app.get('/recogedores', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/recogedores/recogedores.html'))
);

app.get('/produccion', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/produccion/produccion.html'))
);

app.get('/revision-telas', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/revision-telas/revision_telas.html'))
);
app.get('/corte', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/corte/corte.html'))
);
app.get('/tablero', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/tablero/tablero.html'))
);

app.get('/incentivos', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/incentivos/incentivos.html'))
);

app.get('/visitantes', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/control-visitantes-sst/control-visitantes-sst.html'))
);

app.get('/permisos', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/control-permisos/control_permisos.html'))
);

app.get('/mantenimiento', (req, res) =>
  res.sendFile(path.join(__dirname, 'modulos/mantenimiento/mantenimiento.html'))
);

// ── PUNTO SEGURO — SG-SST ────────────────────────────────────────────────────
const psApi = require('./ps-api');
app.use('/punto-seguro/api', psApi);

const PS_DIST = path.join(__dirname, 'punto-seguro', 'client', 'dist');
if (fs.existsSync(PS_DIST)) {
  app.use('/punto-seguro', require('express').static(PS_DIST));
  app.get('/punto-seguro/*', (_req, res) =>
    res.sendFile(path.join(PS_DIST, 'index.html'))
  );
} else {
  app.get('/punto-seguro*', (_req, res) =>
    res.status(503).send('<h2>Punto Seguro aún no construido. Ejecuta: npm run build</h2>')
  );
}

app.get('/api/visitantes/db', (req, res) => {
  const data = readJSON(FILES.visitantes, null);
  res.json({ ok: true, data });
});

app.post('/api/visitantes/db', (req, res) => {
  try {
    if (!writeJSON(FILES.visitantes, req.body)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Logo corporativo (usado en el header del módulo de incentivos)
app.get('/logo.png', (req, res) => {
  // El archivo real se llama "logo.png.jpeg"; probamos varios nombres.
  const candidatos = ['logo.png', 'logo.png.jpeg', 'logo.jpeg', 'logo.jpg'];
  for (const nombre of candidatos) {
    const p = path.join(__dirname, 'compartido', nombre);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).end();
});

// Archivos compartidos entre módulos (logo, CSS, plantillas) — servidos tal
// cual desde compartido/, así las páginas los siguen pidiendo con /nombre.css etc.
app.use(express.static(path.join(__dirname, 'compartido')));

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
    if (!writeJSON(FILES.recogedores, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
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
    if (!writeJSON(FILES.recogedores, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
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
    if (!writeJSON(FILES.recogedores, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── API Corte — solicitudes de tela a Revisión de Telas ────────────
app.get('/api/corte-solicitudes', (req, res) => {
  let data = readJSON(FILES.corte_solicitudes, []);
  // Rellena el número consecutivo a solicitudes antiguas que se crearon antes de
  // tener este campo — se asigna por orden real de creación (ts), nunca se reinicia,
  // y nunca repite un número que ya esté en uso.
  if (data.some(s => !s.solicitudNum)) {
    let maxNum = 0;
    data.forEach(s => { if (s.solicitudNum && s.solicitudNum > maxNum) maxNum = s.solicitudNum; });
    const faltantes = data.filter(s => !s.solicitudNum).sort((a, b) => (a.ts || 0) - (b.ts || 0));
    faltantes.forEach(s => { maxNum++; s.solicitudNum = maxNum; });
    writeJSON(FILES.corte_solicitudes, data);
  }
  const { solicitadoPor, estado } = req.query;
  if (solicitadoPor) data = data.filter(s => s.solicitadoPor === solicitadoPor);
  if (estado)        data = data.filter(s => s.estado === estado);
  res.json(data);
});

app.post('/api/corte-solicitudes', (req, res) => {
  try {
    const { op, codigoTela, color, metros, solicitadoPor } = req.body || {};
    if (!op || !codigoTela || !color || !metros || !solicitadoPor) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }
    const data = readJSON(FILES.corte_solicitudes, []);
    // Número consecutivo único, igual al patrón ya usado en Tablero CI (solicitudNum).
    let maxNum = 0;
    data.forEach(s => { if (s.solicitudNum && s.solicitudNum > maxNum) maxNum = s.solicitudNum; });
    const sol = {
      id: Date.now() + '-' + Math.random().toString(36).slice(2),
      solicitudNum: maxNum + 1,
      op, codigoTela, color, metros,
      solicitadoPor,
      estado: 'pendiente',
      fecha: new Date().toISOString().slice(0, 10),
      hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true }),
      ts: Date.now() // marca exacta para calcular el contador de tiempo en la tarjeta
    };
    data.unshift(sol);
    if (!writeJSON(FILES.corte_solicitudes, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    broadcast({ type: 'corte_new_request', solicitud: sol });
    res.json({ ok: true, solicitud: sol });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/corte-solicitudes/:id/entregar', (req, res) => {
  try {
    const entregadoPor = (req.body && req.body.entregadoPor || '').trim();
    if (!entregadoPor) return res.status(400).json({ error: 'Falta indicar quién entrega' });
    const data = readJSON(FILES.corte_solicitudes, []);
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
    if (data[idx].estado !== 'pendiente') return res.status(400).json({ error: 'Esta solicitud ya fue procesada' });
    data[idx].estado = 'entregada';
    data[idx].entregadoPor = entregadoPor;
    data[idx].fechaEntrega = new Date().toISOString().slice(0, 10);
    data[idx].tsEntregada = Date.now();
    if (!writeJSON(FILES.corte_solicitudes, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    broadcast({ type: 'corte_update_request', solicitud: data[idx] });
    res.json({ ok: true, solicitud: data[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/corte-solicitudes/:id/aceptar', (req, res) => {
  try {
    const data = readJSON(FILES.corte_solicitudes, []);
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
    if (data[idx].estado !== 'entregada') return res.status(400).json({ error: 'Aún no ha sido entregada' });
    data[idx].estado = 'aceptada';
    data[idx].fechaAceptada = new Date().toISOString().slice(0, 10);
    data[idx].tsAceptada = Date.now();
    if (!writeJSON(FILES.corte_solicitudes, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    broadcast({ type: 'corte_update_request', solicitud: data[idx] });
    res.json({ ok: true, solicitud: data[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Corte rechaza una entrega marcada por Telas (en realidad no le llegó el rollo):
// la solicitud vuelve a "pendiente" para que Telas la entregue de verdad.
app.post('/api/corte-solicitudes/:id/rechazar', (req, res) => {
  try {
    const data = readJSON(FILES.corte_solicitudes, []);
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
    if (data[idx].estado !== 'entregada') return res.status(400).json({ error: 'Solo se puede rechazar una solicitud entregada' });
    data[idx].estado = 'pendiente';
    delete data[idx].entregadoPor;
    delete data[idx].fechaEntrega;
    delete data[idx].tsEntregada;
    if (!writeJSON(FILES.corte_solicitudes, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    broadcast({ type: 'corte_update_request', solicitud: data[idx] });
    res.json({ ok: true, solicitud: data[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/corte-solicitudes/:id', (req, res) => {
  try {
    const data = readJSON(FILES.corte_solicitudes, []);
    const len = data.length;
    const restante = data.filter(s => s.id !== req.params.id);
    if (restante.length === len) return res.status(404).json({ error: 'No encontrada' });
    if (!writeJSON(FILES.corte_solicitudes, restante)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    broadcast({ type: 'corte_delete_request', id: req.params.id });
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
  if (!saveDB('ordenes', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
  res.json({ ok: true });
});

// ── API Revisión de Telas ────────────────────────────────────────
app.get('/api/revision-telas', (req, res) => {
  try {
    res.json(loadDB('revision_telas') || { registros:[], defectos:[], referencias:[], colores:[] });
  } catch(e) {
    console.error('Error no capturado [GET revision-telas]:', (e && e.stack) || e);
    res.status(500).json({ error: String((e && e.message) || e), donde: 'GET revision-telas' });
  }
});

app.post('/api/revision-telas', (req, res) => {
  try {
    const { registros, defectos, referencias, colores } = req.body || {};
    if(!Array.isArray(registros)) return res.status(400).json({ error: 'Payload inválido' });
    const proveedores        = req.body.proveedores        || [];
    const proveedoresTerceros= req.body.proveedoresTerceros|| [];
    const tareas             = req.body.tareas             || [];
    const igJustificaciones  = req.body.igJustificaciones  || {};
    const deletedIds         = Array.isArray(req.body.deletedIds) ? req.body.deletedIds : [];

    const prev = loadDB('revision_telas') || {};

    // ── Registros: merge por id (upsert + borrados explícitos) ──────
    const byId = new Map();
    (Array.isArray(prev.registros) ? prev.registros : []).forEach(r => { if(r && r.id != null) byId.set(r.id, r); });
    registros.forEach(r => { if(r && r.id != null) byId.set(r.id, r); });
    deletedIds.forEach(id => byId.delete(id));
    const mergedRegistros = [...byId.values()];

    // ── Respaldo: un mismo revisador nunca debe tener 2+ actividades abiertas ──
    // El cliente ya bloquea esto antes de crear una nueva, pero una condición de
    // carrera entre dos dispositivos podría colarla igual. Si después del merge
    // aparece más de una sin finalizar para el mismo revisador, se cierran
    // automáticamente todas menos la más reciente (se detecta por el timestamp
    // incluido en el id, ej: "rt_1731000000000_ab12").
    const idTs = id => { const m = String(id).match(/_(\d+)_/); return m ? parseInt(m[1], 10) : 0; };
    const abiertasPorRevisador = new Map();
    mergedRegistros.forEach(r => {
      if (r && !r.finalizado && r.revisador) {
        if (!abiertasPorRevisador.has(r.revisador)) abiertasPorRevisador.set(r.revisador, []);
        abiertasPorRevisador.get(r.revisador).push(r);
      }
    });
    abiertasPorRevisador.forEach(lista => {
      if (lista.length <= 1) return;
      lista.sort((a, b) => idTs(b.id) - idTs(a.id)); // más reciente primero, se deja abierta
      for (let i = 1; i < lista.length; i++) {
        const idx = mergedRegistros.findIndex(r => r.id === lista[i].id);
        if (idx === -1) continue;
        const r = mergedRegistros[idx];
        mergedRegistros[idx] = {
          ...r,
          finalizado: true,
          hora_fin: r.hora_fin || new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true }),
          observaciones: (r.observaciones ? r.observaciones + ' — ' : '') + 'Cerrado automáticamente: se detectó una segunda actividad abierta para este revisador.',
          cierreAutomatico: true
        };
      }
    });

    // ── Referencias: merge por id (igual que registros) — así ningún
    // navegador con datos desactualizados puede borrar lo que otro acaba
    // de agregar; solo se pierde una referencia si se borra explícitamente.
    const flattenRefs = (obj) => {
      const map = new Map();
      Object.keys(obj || {}).forEach(prov => {
        (Array.isArray(obj[prov]) ? obj[prov] : []).forEach(r => {
          if (r && typeof r === 'object' && r.id != null) map.set(r.id, { ...r, _prov: prov });
        });
      });
      return map;
    };
    const refsById = flattenRefs(prev.referencias);
    flattenRefs(referencias).forEach((r, id) => refsById.set(id, r));
    deletedIds.forEach(id => refsById.delete(id));
    const mergedReferencias = {};
    refsById.forEach(r => {
      const { _prov, ...entry } = r;
      const prov = _prov || 'Sin proveedor';
      if (!mergedReferencias[prov]) mergedReferencias[prov] = [];
      mergedReferencias[prov].push(entry);
    });

    // ── Config arrays: conservar lo que ya hay si el cliente envía vacío ──
    // Nunca se pierde información por un deploy o recarga parcial.
    const mergedDefectos          = defectos           && defectos.length           ? defectos            : (Array.isArray(prev.defectos)            ? prev.defectos            : []);
    const mergedColores            = colores            && colores.length            ? colores             : (Array.isArray(prev.colores)             ? prev.colores             : []);
    const mergedProveedores        = proveedores        && proveedores.length        ? proveedores         : (Array.isArray(prev.proveedores)         ? prev.proveedores         : []);
    const mergedProvTerceros       = proveedoresTerceros && proveedoresTerceros.length ? proveedoresTerceros: (Array.isArray(prev.proveedoresTerceros)  ? prev.proveedoresTerceros  : []);
    const mergedTareas             = tareas             && tareas.length             ? tareas              : (Array.isArray(prev.tareas)              ? prev.tareas              : []);
    // Justificaciones de baches (Informe Gerencial): unión simple por clave —
    // nunca se reemplaza todo el objeto, solo se agregan/actualizan las claves enviadas.
    const mergedIgJustificaciones = { ...(prev.igJustificaciones && typeof prev.igJustificaciones==='object' ? prev.igJustificaciones : {}), ...igJustificaciones };

    const data = {
      registros: mergedRegistros,
      defectos:  mergedDefectos,
      referencias: mergedReferencias,
      colores:   mergedColores,
      proveedores: mergedProveedores,
      proveedoresTerceros: mergedProvTerceros,
      igJustificaciones: mergedIgJustificaciones,
      tareas:    mergedTareas
    };

    if (!saveDB('revision_telas', data)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true });
    setTimeout(()=>{
      try {
        broadcast({ type: 'rt_update', ...data });
      } catch(eb) { console.error('Error no capturado [broadcast rt_update]:', (eb && eb.stack) || eb); }
    }, 800);
  } catch(e) {
    console.error('Error no capturado [POST revision-telas]:', (e && e.stack) || e);
    if(!res.headersSent) res.status(500).json({ error: String((e && e.message) || e), donde: 'POST revision-telas' });
  }
});

// ── API MMT Locativo (mantenimiento de planta) ─────────────────────
// Un solo bundle {tareas, miembros, historial, alertas}, igual patrón que
// revision-telas: merge por id en cada guardado para que dos dispositivos
// nunca se pisen los datos entre sí. El historial es de solo agregar
// (nunca se borra), tareas/miembros/alertas sí admiten borrado explícito.
app.get('/api/mantenimiento', (req, res) => {
  try {
    res.json(loadDB('mmt_locativo') || { tareas: [], miembros: [], historial: [], alertas: [] });
  } catch(e) {
    console.error('Error no capturado [GET mantenimiento]:', (e && e.stack) || e);
    res.status(500).json({ error: String((e && e.message) || e), donde: 'GET mantenimiento' });
  }
});

app.post('/api/mantenimiento', (req, res) => {
  try {
    const { tareas, miembros, historial, alertas } = req.body || {};
    if (!Array.isArray(tareas) || !Array.isArray(miembros)) return res.status(400).json({ error: 'Payload inválido' });
    const deletedTaskIds   = Array.isArray(req.body.deletedTaskIds)   ? req.body.deletedTaskIds   : [];
    const deletedMemberIds = Array.isArray(req.body.deletedMemberIds) ? req.body.deletedMemberIds : [];
    const deletedAlertIds  = Array.isArray(req.body.deletedAlertIds)  ? req.body.deletedAlertIds  : [];

    const prev = loadDB('mmt_locativo') || {};

    const mergeById = (prevArr, incomingArr, idKey, deletedIds) => {
      const byId = new Map();
      (Array.isArray(prevArr) ? prevArr : []).forEach(r => { if (r && r[idKey] != null) byId.set(r[idKey], r); });
      (Array.isArray(incomingArr) ? incomingArr : []).forEach(r => { if (r && r[idKey] != null) byId.set(r[idKey], r); });
      deletedIds.forEach(id => byId.delete(id));
      return [...byId.values()];
    };

    const mergedTareas    = mergeById(prev.tareas, tareas, 'id', deletedTaskIds);
    const mergedMiembros  = mergeById(prev.miembros, miembros, 'id', deletedMemberIds);
    // Historial: nunca se borra (registro permanente de ejecuciones aprobadas).
    const mergedHistorial = mergeById(prev.historial, historial, 'historyId', []);
    const mergedAlertas   = mergeById(prev.alertas, alertas, 'id', deletedAlertIds);

    const data = { tareas: mergedTareas, miembros: mergedMiembros, historial: mergedHistorial, alertas: mergedAlertas };
    if (!saveDB('mmt_locativo', data)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true });
  } catch(e) {
    console.error('Error no capturado [POST mantenimiento]:', (e && e.stack) || e);
    if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e), donde: 'POST mantenimiento' });
  }
});

// ── API Producción (Tablero Kanban) ──────────────────────────────
app.get('/api/produccion', (req, res) => {
  res.json(loadDB('produccion') || { boards: {}, history: [] });
});

app.post('/api/produccion', (req, res) => {
  const { boards, history } = req.body || {};
  if (!boards || typeof boards !== 'object')
    return res.status(400).json({ error: 'Payload inválido' });
  if (!saveDB('produccion', { boards, history: history || [] })) {
    return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
  }
  // Notificar clientes prod — sin history (payload grande, no es tiempo real)
  broadcastProdUpdate({ type: 'prod_update', boards });
  res.json({ ok: true });
});

// ── API Incentivos (consulta por número de contrato) ──────────────
// Registro: { id, mes, contrato, nombre, valor, ts }.
// La carga de Excel hace upsert por mes+contrato; la edición/borrado usan id.
function normContrato(v){ return String(v == null ? '' : v).trim(); }
function normMes(v){ return String(v == null ? '' : v).trim(); }
// Valor en pesos COP (enteros). Texto "$150.000": el punto es separador de
// miles colombiano, no decimal → se eliminan no-dígitos.
function normValor(v){
  return typeof v === 'number'
    ? Math.round(v)
    : parseInt(String(v == null ? '' : v).replace(/[^0-9-]/g, ''), 10) || 0;
}

app.get('/api/incentivos', (req, res) => {
  let data = loadDB('incentivos') || [];
  const contrato = req.query.contrato != null ? normContrato(req.query.contrato) : null;
  const mes      = req.query.mes      != null ? normMes(req.query.mes)           : null;
  if (contrato) data = data.filter(r => normContrato(r.contrato) === contrato);
  if (mes)      data = data.filter(r => normMes(r.mes) === mes);
  res.json(data);
});

// Resumen por mes (conteo). Evita descargar todos los registros en el panel admin.
app.get('/api/incentivos/resumen', (req, res) => {
  const data = loadDB('incentivos') || [];
  const byMes = {};
  data.forEach(r => { const m = normMes(r.mes); if (m) byMes[m] = (byMes[m] || 0) + 1; });
  res.json(Object.keys(byMes).map(mes => ({ mes, count: byMes[mes] })));
});

// POST: carga de Excel (admin). Body = { rows: [{mes,contrato,nombre,valor}] }.
// Upsert por mes+contrato; no borra meses ya cargados.
app.post('/api/incentivos', (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : (req.body && req.body.rows);
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'Se esperaba { rows: [...] }' });

    const data = loadDB('incentivos') || [];
    const byKey = new Map();
    data.forEach(r => byKey.set(normMes(r.mes) + '|' + normContrato(r.contrato), r));

    let upserts = 0;
    rows.forEach(r => {
      const mes      = normMes(r.mes);
      const contrato = normContrato(r.contrato);
      if (!mes || !contrato) return; // fila inválida, omitir
      const prev = byKey.get(mes + '|' + contrato);
      byKey.set(mes + '|' + contrato, {
        id:     (prev && prev.id) || uuidv4(),  // conservar id si ya existía
        mes, contrato,
        nombre: String(r.nombre == null ? '' : r.nombre).trim(),
        cedula: String(r.cedula == null ? '' : r.cedula).trim(),
        valor:  normValor(r.valor),
        ts:     Date.now()
      });
      upserts++;
    });

    const merged = [...byKey.values()];
    if (!saveDB('incentivos', merged)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, recibidos: rows.length, guardados: upserts, total: merged.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// PATCH: editar una fila por id (sin reimportar el archivo)
app.patch('/api/incentivos/:id', (req, res) => {
  try {
    const data = loadDB('incentivos') || [];
    const idx = data.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Registro no encontrado' });
    const b = req.body || {};
    if (b.mes      !== undefined) data[idx].mes      = normMes(b.mes);
    if (b.contrato !== undefined) data[idx].contrato = normContrato(b.contrato);
    if (b.nombre   !== undefined) data[idx].nombre   = String(b.nombre == null ? '' : b.nombre).trim();
    if (b.cedula   !== undefined) data[idx].cedula   = String(b.cedula == null ? '' : b.cedula).trim();
    if (b.valor    !== undefined) data[idx].valor    = normValor(b.valor);
    data[idx].ts = Date.now();
    if (!saveDB('incentivos', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, registro: data[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE por id: borrar una fila
app.delete('/api/incentivos/:id', (req, res) => {
  try {
    const data = loadDB('incentivos') || [];
    const filtrado = data.filter(r => r.id !== req.params.id);
    if (filtrado.length === data.length) return res.status(404).json({ error: 'Registro no encontrado' });
    if (!saveDB('incentivos', filtrado)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE: borrar por mes (?mes=) o todo (?all=1)
app.delete('/api/incentivos', (req, res) => {
  try {
    const data = loadDB('incentivos') || [];
    if (req.query.all === '1' || req.query.all === 'true') {
      if (!saveDB('incentivos', [])) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      return res.json({ ok: true, eliminados: data.length });
    }
    const mes = req.query.mes != null ? normMes(req.query.mes) : null;
    if (!mes) return res.status(400).json({ error: 'Falta parámetro mes o all=1' });
    const filtrado = data.filter(r => normMes(r.mes) !== mes);
    if (!saveDB('incentivos', filtrado)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, eliminados: data.length - filtrado.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Disponibilidad de incentivos por mes (global para todos)
app.get('/api/incentivos-disponibilidad', (req, res) => {
  const data = readJSON(FILES.incentivos_disp, {});
  res.json({ ok: true, data: data && !Array.isArray(data) ? data : {} });
});
app.post('/api/incentivos-disponibilidad', (req, res) => {
  try {
    if (!writeJSON(FILES.incentivos_disp, req.body)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Configuración editable de Incentivos (ej. link de la plataforma de retiro) —
// se guarda en el servidor para no dejar nada de esto escrito en el código.
app.get('/api/incentivos-config', (req, res) => {
  const data = readJSON(FILES.incentivos_config, {});
  res.json({ ok: true, data: data && !Array.isArray(data) ? data : {} });
});
app.post('/api/incentivos-config', (req, res) => {
  try {
    if (!writeJSON(FILES.incentivos_config, req.body)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});


// Busca número de contrato por cédula.
// 1a vez (cédula NO en la tabla): guarda cédula+fecha+celular como "llave".
// 2a vez (cédula YA en la tabla): NO guarda; exige que fecha Y celular
//   coincidan con lo guardado. Si no coinciden → 'no_coincide'.
// El código (contrato) siempre se saca fresco de la lista de incentivos.
app.post('/api/buscar-contrato', (req, res) => {
  try {
    const { cedula, fechaExpedicion, celular } = req.body || {};
    if (!cedula) return res.status(400).json({ ok: false, error: 'Cédula requerida' });
    const norm = s => String(s || '').trim().replace(/\s+/g, '').toLowerCase();

    const incentivos = loadDB('incentivos') || [];
    const match = incentivos.find(r => norm(r.cedula) === norm(cedula));

    const lista = readJSON(FILES.consultas_contrato, []);
    const previo = lista.find(r => norm(r.cedula) === norm(cedula));

    // ── Caso 2: ya existe registro para esa cédula ──
    if (previo) {
      const coincide = norm(previo.fechaExpedicion) === norm(fechaExpedicion)
                    && norm(previo.celular)         === norm(celular);
      if (!coincide) return res.json({ ok: true, estado: 'no_coincide' });
      if (!match)    return res.json({ ok: true, estado: 'sin_incentivos' });
      return res.json({ ok: true, estado: 'ok', contrato: match.contrato, nombre: match.nombre });
    }

    // ── Caso 1: primera vez → guarda la llave ──
    lista.push({
      id:              uuidv4(),
      cedula:          String(cedula).trim(),
      nombre:          match ? (match.nombre || '') : '',
      contrato:        match ? (match.contrato || '') : '',
      fechaExpedicion: String(fechaExpedicion || '').trim(),
      celular:         String(celular || '').trim(),
      encontrado:      !!match,
      fecha:           new Date().toISOString(),
    });
    if (!writeJSONSync(FILES.consultas_contrato, lista)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    }

    if (!match) return res.json({ ok: true, estado: 'sin_incentivos' });
    return res.json({ ok: true, estado: 'ok', contrato: match.contrato, nombre: match.nombre });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.get('/api/buscar-contrato', (req, res) => {
  try { res.json(readJSON(FILES.consultas_contrato, [])); }
  catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Editar un registro: cédula, fecha de expedición y celular.
// Nombre y contrato se RECALCULAN frescos desde incentivos según la cédula.
app.put('/api/buscar-contrato/:id', (req, res) => {
  try {
    const { cedula, fechaExpedicion, celular } = req.body || {};
    const lista = readJSON(FILES.consultas_contrato, []);
    const idx = lista.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ ok: false });

    const norm = s => String(s || '').trim().replace(/\s+/g, '').toLowerCase();
    const nuevaCedula = cedula !== undefined ? String(cedula).trim() : lista[idx].cedula;

    // Recalcular nombre/contrato con la cédula (posiblemente nueva)
    const incentivos = loadDB('incentivos') || [];
    const match = incentivos.find(r => norm(r.cedula) === norm(nuevaCedula));

    lista[idx] = {
      ...lista[idx],
      cedula:          nuevaCedula,
      fechaExpedicion: fechaExpedicion !== undefined ? String(fechaExpedicion).trim() : lista[idx].fechaExpedicion,
      celular:         celular         !== undefined ? String(celular).trim()         : lista[idx].celular,
      nombre:          match ? (match.nombre || '')   : '',
      contrato:        match ? (match.contrato || '') : '',
      encontrado:      !!match,
    };
    if (!writeJSONSync(FILES.consultas_contrato, lista)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true, registro: lista[idx] });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

app.delete('/api/buscar-contrato/:id', (req, res) => {
  try {
    const lista = readJSON(FILES.consultas_contrato, []);
    const nueva = lista.filter(s => s.id !== req.params.id);
    if (nueva.length === lista.length) return res.status(404).json({ ok: false });
    if (!writeJSONSync(FILES.consultas_contrato, nueva)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ ok: false, error: e.message }); }
});

// ── WhatsApp admin endpoints ────────────────────────────────────────
app.get('/api/wa/status', requireAuth, (_req, res) => {
  res.json({ ready: waReady, status: waStatus, hasQr: !!waQrDataUrl });
});
app.get('/api/wa/qr', requireAuth, (_req, res) => {
  if (!waQrDataUrl) return res.json({ ok: false, message: waReady ? 'Ya conectado' : 'QR aún no disponible' });
  res.json({ ok: true, qr: waQrDataUrl });
});
app.post('/api/wa/reinit', requireAuth, (_req, res) => {
  if (process.env.ENABLE_WHATSAPP !== 'true') return res.json({ ok: false, message: 'WhatsApp no habilitado (ENABLE_WHATSAPP != true)' });
  if (waClient) { try { waClient.end(undefined); } catch {} waClient = null; }
  waReady = false; waQrDataUrl = null;
  initWhatsApp();
  res.json({ ok: true });
});

const CI_PATH = path.join(__dirname, 'modulos/tablero-ci/Tablero_CI.html');
app.get('/ci', (req, res) => {
  if (!fs.existsSync(CI_PATH)) {
    const variants = ['tablero_ci.html','tablero-ci.html','TableroCI.html','tableroCI.html'];
    for (const v of variants) {
      const vpath = path.join(__dirname, 'modulos/tablero-ci', v);
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

  // Módulos que todavía tienen una solicitud "cumplido" sin confirmar por el
  // módulo (el paso 1 las deja así a propósito, no se auto-aceptan) — a esos
  // NO se les debe resetear el color, o quedarían en verde mientras la
  // solicitud sigue abierta: la misma inconsistencia que se busca evitar.
  const modulosConCumplidoPendiente = new Set(
    ciRequests.filter(r => r.status === 'cumplido').map(r => r.module || r.moduloDestino)
  );

  // 2. Resetear todos los módulos en purple u orange a green (excepto los que
  // aún tienen una solicitud "cumplido" esperando confirmación)
  const modulosReset = [];
  MODULES.forEach(modId => {
    if (modulosConCumplidoPendiente.has(modId)) return;
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

// ── Job de fin de turno — cierra automáticamente actividades que quedaron
// abiertas cuando termina el turno (mismos límites que usa el Informe Gerencial:
// noche 5:45pm–5:15am, día 5:15am–5:45pm). Un revisador no puede seguir "en
// revisión" después de que su turno ya terminó.
function programarCierreTurno(horaMin, minMin, turnoQueTermina) {
  function msHastaProxima() {
    const ahora = new Date();
    const target = new Date(ahora);
    target.setHours(horaMin, minMin, 0, 0);
    if (target <= ahora) target.setDate(target.getDate() + 1);
    return target - ahora;
  }
  function ejecutar() {
    cerrarActividadesAbiertasDeTurno(turnoQueTermina);
    setTimeout(ejecutar, 24 * 60 * 60 * 1000);
  }
  const ms = msHastaProxima();
  setTimeout(ejecutar, ms);
  console.log(`[SERVER] Cierre de turno "${turnoQueTermina}" programado en ${Math.round(ms / 60000)} minutos`);
}

function cerrarActividadesAbiertasDeTurno(turno) {
  try {
    const data = loadDB('revision_telas') || {};
    const registros = Array.isArray(data.registros) ? data.registros : [];
    const horaFinTxt = new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true });
    let cerrados = 0;
    const nuevos = registros.map(r => {
      if (r && !r.finalizado && r.turno === turno) {
        cerrados++;
        return {
          ...r,
          finalizado: true,
          hora_fin: horaFinTxt,
          observaciones: (r.observaciones ? r.observaciones + ' — ' : '') + 'Cerrado automáticamente: quedó abierto al terminar el turno.',
          cierreAutomatico: true
        };
      }
      return r;
    });
    if (cerrados > 0) {
      data.registros = nuevos;
      if (saveDB('revision_telas', data)) {
        broadcast({ type: 'rt_update', ...data });
      }
    }
    console.log(`[SERVER] Cierre de turno "${turno}": ${cerrados} actividad(es) cerrada(s) automáticamente`);
  } catch (e) {
    console.error('[SERVER] Error en cierre de turno:', e.message);
  }
}

programarCierreTurno(17, 45, 'dia');    // 5:45pm → termina el turno día
programarCierreTurno(5, 15, 'noche');   // 5:15am → termina el turno noche

// Mapa: tipo de mensaje → topic. Sin entry = enviar a todos (init, server_reset, etc.)
const MSG_TOPICS = {
  'change':              'modulos',
  'change2':             'modulos',
  'change_pink':         'modulos',
  'multi_imp_change':    'modulos',
  'modules_config':      'modulos',
  'ci_new_request':      'ci',
  'ci_update_request':   'ci',
  'ci_delete_request':   'ci',
  'ci_cumplido_request': 'ci',
  'ci_config_sync':      'ci',
  'ci_reactivar_alerta': 'ci',
  'corte_new_request':   'corte',
  'corte_update_request':'corte',
  'corte_delete_request':'corte',
  'ia_add_record':       'ia',
  'ia_delete_record':    'ia',
  'ia_edit_record':      'ia',
  'ia_save_state':       'ia',
  'prod_update':         'prod',
  'rt_update':           'rt',
};

function broadcast(payload, excludeWs = null) {
  if (!wss) return;
  const str   = JSON.stringify(payload);
  const topic = MSG_TOPICS[payload.type] || null;
  wss.clients.forEach(c => {
    if (c.readyState !== 1) return;
    if (excludeWs && c === excludeWs) return;
    // Filtrar por topic solo si el cliente ya se suscribió (tiene topics definidos)
    if (topic && c.topics && c.topics.size > 0 && !c.topics.has(topic)) return;
    c.send(str);
  });
}

// ── Aviso de fallo de guardado (tiempo real) ───────────────────────
// Cuando un guardado por WebSocket falla (disco lleno, BD bloqueada…),
// avisa a TODAS las pantallas conectadas para que muestren una alerta
// visible. Antes esto se tragaba en silencio: el cambio se veía en
// pantalla pero nunca quedaba guardado. Throttled para no saturar.
let _lastSaveErrorTs = 0;
function notifySaveError(area) {
  console.error(`[GUARDADO] FALLÓ el guardado de "${area}" — avisando a las pantallas.`);
  const now = Date.now();
  if (now - _lastSaveErrorTs < 1500) return; // evitar avalancha de avisos
  _lastSaveErrorTs = now;
  try { broadcast({ type: 'save_error', area: area || '', ts: now }); } catch (e) {}
}

// Debounce para prod_update: evita floods si varios cambios llegan en <300ms
let _prodUpdateTimer = null;
let _prodUpdatePending = null;
function broadcastProdUpdate(payload, excludeWs) {
  _prodUpdatePending = { payload, excludeWs };
  if (_prodUpdateTimer) return;
  _prodUpdateTimer = setTimeout(() => {
    _prodUpdateTimer = null;
    if (_prodUpdatePending) broadcast(_prodUpdatePending.payload, _prodUpdatePending.excludeWs);
    _prodUpdatePending = null;
  }, 300);
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
      if (!saveDB('alistamientos', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
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
  if (!saveDB('alistamientos', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
  res.json({ success: true });
});

// PUT: editar/actualizar un alistamiento existente (faltaba esta ruta → al editar daba error)
app.put(
  '/alistamiento/api/alistamientos/:id',
  (req, res, next) => upload.array('fotos', 5)(req, res, err => err ? handleMulterError(err, req, res, next) : next()),
  (req, res) => {
    try {
      const data = loadDB('alistamientos');
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
      if (!saveDB('alistamientos', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      res.json({ success: true, data: data[idx] });
    } catch(e) { res.status(500).json({ error: e.message }); }
  }
);

// ── Multitareas (Registro Mecánicos) ───────────────────────────────
app.get('/alistamiento/api/multitareas', (req, res) => {
  let data = [...loadDB('multitareas')];
  const { fecha, mecanico } = req.query;
  if (fecha)    data = data.filter(r => r.fecha && r.fecha.startsWith(fecha));
  if (mecanico) data = data.filter(r => r.mecanico === mecanico);
  res.json(data.sort((a, b) => new Date(b.fechaHora) - new Date(a.fechaHora)));
});
app.post('/alistamiento/api/multitareas', (req, res) => {
  try {
    const missing = requireFields(req.body, ['tarea', 'mecanico']);
    if (missing) return res.status(400).json({ error: `Campos requeridos faltantes: ${missing.join(', ')}` });
    const data  = loadDB('multitareas');
    const ahora = new Date();
    const nuevo = {
      id: uuidv4(), ...req.body,
      fechaHora: ahora.toISOString(),
      fecha:     ahora.toISOString().split('T')[0],
      hora:      ahora.toTimeString().slice(0, 8)
    };
    data.push(nuevo);
    if (!saveDB('multitareas', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true, data: nuevo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/alistamiento/api/multitareas/:id', (req, res) => {
  try {
    const data = loadDB('multitareas');
    const idx  = data.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
    data[idx] = { ...data[idx], ...req.body, id: data[idx].id };
    if (!saveDB('multitareas', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true, data: data[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/alistamiento/api/multitareas/:id', (req, res) => {
  const data = loadDB('multitareas').filter(r => r.id !== req.params.id);
  if (!saveDB('multitareas', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
  res.json({ success: true });
});

// ── Tareas asignadas (Registro Mecánicos) ──────────────────────────
app.get('/alistamiento/api/tareas', (req, res) => {
  let data = [...readJSON(FILES.tareas, [])];
  const { mecanico, estado } = req.query;
  if (mecanico) data = data.filter(r => r.mecanico === mecanico);
  if (estado)   data = data.filter(r => r.estado === estado);
  res.json(data.sort((a,b) => (b.fechaAsignada||'').localeCompare(a.fechaAsignada||'')));
});
app.post('/alistamiento/api/tareas', (req, res) => {
  try {
    const { mecanico, descripcion } = req.body;
    if (!mecanico || !descripcion) return res.status(400).json({ error: 'mecanico y descripcion requeridos' });
    const data  = readJSON(FILES.tareas, []);
    const ahora = new Date();
    const nueva = {
      id:             require('crypto').randomUUID(),
      mecanico:       mecanico,
      maquina:        req.body.maquina        || '',
      descripcion:    descripcion,
      ppp:            req.body.ppp            || '',
      tipoAguja:      req.body.tipoAguja      || '',
      observaciones:  req.body.observaciones  || '',
      estado:         'pendiente',
      fechaAsignada:  ahora.toISOString(),
      fechaFinalizada: null,
      observacionFinal: '',
      asignadoPor:    req.body.asignadoPor || 'ADMINISTRADOR'
    };
    data.push(nueva);
    if (!writeJSON(FILES.tareas, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true, data: nueva });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/alistamiento/api/tareas/:id', (req, res) => {
  try {
    const data = readJSON(FILES.tareas, []);
    const idx  = data.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
    const campos = ['maquina','descripcion','ppp','tipoAguja','observaciones','estado','observacionFinal','mecanico'];
    campos.forEach(c => { if (req.body[c] !== undefined) data[idx][c] = req.body[c]; });
    if (req.body.estado === 'en_proceso' && !data[idx].fechaInicio)
      data[idx].fechaInicio = new Date().toISOString();
    if (req.body.estado === 'finalizada' && !data[idx].fechaFinalizada)
      data[idx].fechaFinalizada = new Date().toISOString();
    if (!writeJSON(FILES.tareas, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true, data: data[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/alistamiento/api/tareas/:id', (req, res) => {
  try {
    const data = readJSON(FILES.tareas, []).filter(r => r.id !== req.params.id);
    if (!writeJSON(FILES.tareas, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
      if (!saveDB('mantenimientos', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
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
  if (!saveDB('mantenimientos', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
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
      if (!saveDB('mantenimientos', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
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
  if (!saveDB('alertas', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
  res.json({ success: true });
});

app.put('/alistamiento/api/alertas/leer-todas', (req, res) => {
  const data = loadDB('alertas').map(a => ({ ...a, leida: true }));
  if (!saveDB('alertas', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
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

// App Config — nunca expone contraseñas (viven hasheadas en users.json)
app.get('/api/app-config', (req, res) => {
  res.json(stripUserPasswords(readJSON(FILES.app_config, {})));
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
    const merged = deepMerge(existing, req.body);
    // Mantener users.json (login server-side) al día con los usuarios del panel.
    // Se llama ANTES de quitar las contraseñas, porque necesita la nueva pass.
    if (req.body && req.body._usuarios_extra) syncUsersFromConfig(merged);
    // No persistir contraseñas en claro. Guardar passHash para sobrevivir reinicios.
    if (Array.isArray(merged._usuarios_extra)) {
      merged._usuarios_extra = merged._usuarios_extra.map(u => {
        if (!u || typeof u !== 'object') return u;
        const { pass, ...rest } = u;
        if (pass != null && String(pass) !== '') {
          // Convertir cleartext → hash para persistencia entre reinicios del servidor
          const existing = (loadUsers().users[u.nombre] || {}).passHash;
          rest.passHash = (existing && bcrypt.compareSync(String(pass), existing))
            ? existing
            : bcrypt.hashSync(String(pass), BCRYPT_ROUNDS);
        }
        return rest;
      });
    }
    if (!writeJSON(FILES.app_config, merged)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Auth: login server-side con hash (Paso 1) ─────────────────────
// POST /api/login { user, pass } → { ok, token, user, perms, rol }
// Rate-limit: 10 intentos por IP / minuto.
app.post('/api/login', rateLimit(20, 60 * 1000), (req, res) => {
  try {
    const { user, pass } = req.body || {};
    if (!user || typeof user !== 'string') {
      return res.status(400).json({ ok: false, error: 'Usuario requerido' });
    }
    const store = loadUsers();
    const u = store.users[user];
    // Respuesta genérica para no revelar si el usuario existe
    const fail = () => res.status(401).json({ ok: false, error: 'Usuario o contraseña incorrectos' });
    if (!u) return fail();
    if (u.disabled) return res.status(403).json({ ok: false, error: 'Usuario deshabilitado' });
    if (!bcrypt.compareSync(String(pass == null ? '' : pass), u.passHash)) {
      console.warn(`[AUTH] Login fallido para "${user}" desde IP ${req.ip}`);
      return fail();
    }
    const exp     = Date.now() + 30 * 24 * 60 * 60 * 1000; // 30 días
    const token   = signToken({ user, rol: u.rol || '', exp });
    res.json({ ok: true, token, user, perms: u.perms || [], rol: u.rol || '', exp });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Middleware reutilizable: exige token válido (Bearer o cookie). Aún no
// se aplica a las rutas existentes — disponible para el endurecimiento
// gradual de cada endpoint sin romper a los clientes que aún no migran.
function requireAuth(req, res, next) {
  const hdr   = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-session-token'] || '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'No autenticado' });
  req.auth = payload;
  next();
}

// Verifica una sesión existente (lo usará el cliente al recargar)
app.get('/api/me', (req, res) => {
  const hdr   = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-session-token'] || '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ ok: false });
  const store = loadUsers();
  const u = store.users[payload.user];
  if (!u || u.disabled) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: payload.user, perms: u.perms || [], rol: u.rol || '', displayName: u.displayName || '', email: u.email || '' });
});

// ── Mi perfil: cada usuario ve y edita SOLO su propio perfil ───────
// La identidad sale del token de sesión (no de un parámetro), para que
// nadie pueda editar el perfil de otro. Reutiliza el mismo almacén seguro.
function _authUser(req) {
  const hdr   = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-session-token'] || '');
  return verifyToken(token);
}
// GET /api/mi-perfil → datos del usuario actual (sin contraseña)
app.get('/api/mi-perfil', (req, res) => {
  const payload = _authUser(req);
  if (!payload) return res.status(401).json({ ok: false, error: 'No autenticado' });
  const store = loadUsers();
  const u = store.users[payload.user];
  if (!u || u.disabled) return res.status(401).json({ ok: false });
  res.json({ ok: true, user: payload.user, displayName: u.displayName || '', email: u.email || '', rol: u.rol || '' });
});
// POST /api/mi-perfil { displayName?, email?, currentPass?, newPass? }
// Para cambiar la contraseña exige la actual (bcrypt.compare). Guarda con
// writeJSONSync (respeta SQLite). Nunca almacena texto plano.
app.post('/api/mi-perfil', rateLimit(20, 60 * 1000), (req, res) => {
  try {
    const payload = _authUser(req);
    if (!payload) return res.status(401).json({ ok: false, error: 'No autenticado' });
    const store = loadUsers();
    const u = store.users[payload.user];
    if (!u || u.disabled) return res.status(401).json({ ok: false });
    const { displayName, email, currentPass, newPass } = req.body || {};

    if (newPass != null && String(newPass) !== '') {
      if (!bcrypt.compareSync(String(currentPass == null ? '' : currentPass), u.passHash)) {
        return res.status(400).json({ ok: false, error: 'La contraseña actual no es correcta' });
      }
      u.passHash = bcrypt.hashSync(String(newPass), BCRYPT_ROUNDS);
    }
    if (displayName != null) u.displayName = String(displayName).trim().slice(0, 80);
    if (email != null)       u.email       = String(email).trim().slice(0, 120);

    store.users[payload.user] = u;
    store.updatedAt = new Date().toISOString();
    if (!writeJSONSync(FILES.users, store)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true, user: payload.user, displayName: u.displayName || '', email: u.email || '' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Verifica una contraseña contra cualquier usuario habilitado (gate de borrado).
// Replica el comportamiento actual: cualquier contraseña válida del sistema
// (incluida la del Programador) autoriza la acción. Rate-limit para frenar fuerza bruta.
app.post('/api/verify-pass', rateLimit(20, 60 * 1000), (req, res) => {
  try {
    const { pass } = req.body || {};
    if (pass == null) return res.status(400).json({ ok: false });
    const store = loadUsers();
    const p = String(pass);
    const ok = Object.values(store.users).some(u => u && !u.disabled && bcrypt.compareSync(p, u.passHash));
    if (!ok) console.warn(`[AUTH] verify-pass fallido desde IP ${req.ip}`);
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
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

// MMT Locativo: roster de técnicos del perfil "Mantenimiento" (mismo patrón que /api/mecanicos)
app.get('/api/mmt-miembros', (req, res) => {
  const appCfg = readJSON(FILES.app_config, {});
  const perfilMembers = appCfg._perfil_members || {};
  const key = Object.keys(perfilMembers).find(k => k.toLowerCase().includes('manten'));
  if (key && Array.isArray(perfilMembers[key])) {
    const members = perfilMembers[key]
      .filter(m => m && !m.disabled)
      .map(m => {
        const nombre = typeof m === 'string' ? m : (m.nombre || m.name || '');
        return { id: nombre, name: nombre };
      })
      .filter(m => m.name);
    members.sort((a, b) => a.name.localeCompare(b.name));
    return res.json(members);
  }
  res.json([]);
});

// Novedades
app.get('/api/novedades',  (req, res) => res.json(readJSON(FILES.novedades, [])));
app.post('/api/novedades', (req, res) => {
  try {
    if (!writeJSON(FILES.novedades, Array.isArray(req.body) ? req.body : [])) {
      return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// Maquinaria
app.get('/api/maquinaria',  (req, res) => res.json(readJSON(FILES.maquinaria, [])));
app.post('/api/maquinaria', (req, res) => {
  try {
    if (!writeJSON(FILES.maquinaria, req.body)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Guías
app.get('/api/guias',  (req, res) => res.json(readJSON(FILES.guias, [])));
app.post('/api/guias', (req, res) => {
  try {
    if (!writeJSON(FILES.guias, req.body)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Turnos
app.get('/api/turnos',  (req, res) => res.json(readJSON(FILES.turnos, [])));
app.post('/api/turnos', (req, res) => {
  try {
    if (!writeJSON(FILES.turnos, req.body)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Turnos Asignados — asignación manual de turno por revisador y rango de fechas
app.get('/api/turnos-asignados', (req, res) => {
  res.json(readJSON(FILES.turnos_asignados, []));
});
app.post('/api/turnos-asignados', (req, res) => {
  try {
    const { revisador, turno, desde, hasta } = req.body || {};
    if (!revisador || !turno || !desde || !hasta)
      return res.status(400).json({ error: 'Faltan campos: revisador, turno, desde, hasta' });
    const data = readJSON(FILES.turnos_asignados, []);
    const nueva = {
      id: uuidv4(),
      revisador, turno, desde, hasta,
      fechaAsignado: new Date().toISOString().split('T')[0]
    };
    data.push(nueva);
    if (!writeJSON(FILES.turnos_asignados, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, asignacion: nueva });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/turnos-asignados/:id', (req, res) => {
  try {
    const data = readJSON(FILES.turnos_asignados, []);
    const idx = data.findIndex(a => a.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
    const { revisador, turno, desde, hasta } = req.body || {};
    if (revisador !== undefined) data[idx].revisador = revisador;
    if (turno !== undefined) data[idx].turno = turno;
    if (desde !== undefined) data[idx].desde = desde;
    if (hasta !== undefined) data[idx].hasta = hasta;
    if (!writeJSON(FILES.turnos_asignados, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, asignacion: data[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    if (!writeJSON(FILES.historial, h)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });

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
    if (!writeJSON(FILES.historial, h)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
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

// Página simple con botón para descargar el respaldo (fácil de usar).
app.get('/admin/backup', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const lb = _lastBackup;
  const estado = lb.ts
    ? (lb.ok
        ? `<div class="st ok2">✓ Última copia automática: ${new Date(lb.ts).toLocaleString('es-CO',{timeZone:'America/Bogota'})} (${lb.files} archivos)</div>`
        : `<div class="st bad">⚠ La última copia automática FALLÓ: ${lb.error}</div>`)
    : `<div class="st">La primera copia automática se hace al minuto de arrancar.</div>`;
  res.send(`<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Descargar respaldo — Millar</title>
<style>
body{font-family:system-ui,Segoe UI,sans-serif;background:#f1f5f9;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{background:#fff;padding:32px;border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.1);max-width:360px;width:90%}
h1{font-size:20px;margin:0 0 6px;color:#0f172a}p{color:#64748b;font-size:14px;margin:0 0 18px}
input{width:100%;padding:11px 12px;border:1.5px solid #e2e8f0;border-radius:9px;font-size:15px;box-sizing:border-box;margin-bottom:12px}
button{width:100%;padding:12px;background:#2563eb;color:#fff;border:none;border-radius:9px;font-size:15px;font-weight:700;cursor:pointer}
button:hover{background:#1d4ed8}.err{color:#dc2626;font-size:13px;margin-top:10px;min-height:18px}
.ok{color:#16a34a}
.st{font-size:12.5px;padding:9px 11px;border-radius:8px;background:#f1f5f9;color:#475569;margin-bottom:16px}
.st.ok2{background:#dcfce7;color:#15803d}.st.bad{background:#fee2e2;color:#b91c1c}
</style></head><body>
<div class="card">
<h1>📥 Descargar respaldo</h1>
<p>Guardá una copia de todos tus datos en tu computadora.</p>
${estado}
<input type="password" id="p" placeholder="Contraseña de administrador" autocomplete="off">
<button onclick="dl()">Descargar copia</button>
<div class="err" id="m"></div>
</div>
<script>
async function dl(){
  var m=document.getElementById('m'); m.className='err'; m.textContent='Generando...';
  try{
    var r=await fetch('/admin/backup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pass:document.getElementById('p').value})});
    if(!r.ok){ m.textContent = r.status===403?'Contraseña incorrecta':'Error al generar la copia'; return; }
    var blob=await r.blob(), a=document.createElement('a');
    a.href=URL.createObjectURL(blob);
    a.download='respaldo-millar-'+new Date().toISOString().slice(0,10)+'.json';
    document.body.appendChild(a); a.click(); a.remove();
    m.className='err ok'; m.textContent='✓ Copia descargada';
  }catch(e){ m.textContent='Error de conexión'; }
}
</script></body></html>`);
});

// Descargar TODOS los datos en un solo archivo (respaldo a tu computadora).
// Protegido con RESET_PASS. Uso: POST /admin/backup  body { pass }
app.post('/admin/backup', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  if (!RESET_PASS) return res.status(503).json({ error: 'Configura RESET_PASS en Render para usar el respaldo.' });
  if (!req.body || req.body.pass !== RESET_PASS) {
    console.warn(`[BACKUP] Intento de descarga con clave incorrecta desde IP ${req.ip}`);
    return res.status(403).json({ error: 'Contraseña incorrecta.' });
  }
  const bundle = { _meta: { ts: new Date().toISOString(), version: '4.0' } };
  Object.keys(FILES).forEach(k => { bundle[k] = readJSON(FILES[k], null); });
  res.setHeader('Content-Disposition', `attachment; filename="respaldo-millar-${new Date().toISOString().split('T')[0]}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(bundle, null, 2));
});

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

    // Si SQLite está activo, vaciar también la base de datos
    if (SQLITE_ON && _sqlite) {
      try {
        _sqlite.exec('DELETE FROM store');
        _stmtSet.run('__migrated__', JSON.stringify({ ts: Date.now(), reset: true }), Date.now());
      } catch (e) { console.error('[SQLITE] Error en reset:', e.message); }
    }

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

// Ping/pong — evita timeout de 60s en Render (50s: margen sin desperdiciar ciclos)
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) { ws.terminate(); return; }
    ws.isAlive = false;
    ws.ping();
  });
}, 50_000);

wss.on('connection', (ws, req) => {
  // Puerta de atrás: si el interruptor está encendido, exigir token válido
  if (AUTH_ENFORCE) {
    let ok = false;
    try {
      const u = new URL(req.url, 'http://localhost');
      ok = !!verifyToken(u.searchParams.get('token') || '');
    } catch (e) { ok = false; }
    if (!ok) { try { ws.close(4001, 'No autenticado'); } catch(e){} return; }
  }
  ws.isAlive = true;
  ws.topics  = new Set(); // temas suscritos — vacío = recibe todo (retrocompat.)
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
    multiImps:     JSON.parse(JSON.stringify(multiImps)),
    ciCumplido:    ciRequests.filter(r => r.status === 'cumplido'),
    ciAbiertas:    ciRequests.filter(r => r.status === 'alert')
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
      // ── Suscripción a topics ─────────────────────────────────────
      if (msg.type === 'subscribe') {
        if (Array.isArray(msg.topics)) {
          ws.topics = new Set(msg.topics.filter(t => typeof t === 'string'));
        }
        return;
      }

      // ── MES ──────────────────────────────────────────────────────
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
        // Bloqueo real contra duplicados: si ya hay una solicitud activa (no 'done') para
        // el mismo módulo + categoría, no crear otra — reenviar la que ya existe para que
        // quien la generó no piense que falló y vuelva a intentarlo.
        const dupExistente = ciRequests.find(r =>
          r.module === msg.request.module &&
          r.categoria === msg.request.categoria &&
          r.status !== 'done'
        );
        if (dupExistente) {
          broadcastLocal({ type:'ci_new_request', request:dupExistente, duplicate:true });
          return;
        }
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
          if (ciRequests.length > CI_MAX) ciRequests = ciRequests.slice(0, CI_MAX);
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
        // Fusión por campo (no reemplazo total): dos actualizaciones casi simultáneas
        // (ej. CI marca cumplida mientras el módulo rechaza) ya no se pisan entre sí —
        // cada cliente debe enviar solo los campos que realmente cambió.
        if (idx > -1) {
          ciRequests[idx] = { ...ciRequests[idx], ...msg.request };
          msg.request = ciRequests[idx]; // el resto de esta rama usa ya el resultado fusionado
        }
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
                if (historial.length > HISTORIAL_MAX) historial = historial.slice(-HISTORIAL_MAX);
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
              if (historial.length > HISTORIAL_MAX) historial = historial.slice(-HISTORIAL_MAX);
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

// ── Cierre limpio ──────────────────────────────────────────────────
// Render envía SIGTERM en cada deploy/reinicio. Antes de apagar, se
// vuelca el WAL a la base principal y se cierra la BD ordenadamente, para
// que NINGÚN guardado reciente se quede "en borrador" y se pierda.
let _cerrando = false;
function cierreLimpio(sig) {
  if (_cerrando) return;
  _cerrando = true;
  console.log(`[SHUTDOWN] Señal ${sig} recibida — guardando y cerrando…`);
  try {
    if (SQLITE_ON && _sqlite) {
      try { _sqlite.pragma('wal_checkpoint(TRUNCATE)'); } catch (e) { console.error('[SHUTDOWN] checkpoint:', e.message); }
      try { _sqlite.close(); } catch (e) { console.error('[SHUTDOWN] close:', e.message); }
    }
  } catch (e) { console.error('[SHUTDOWN] error:', e.message); }
  // Cerrar el servidor y salir; forzar salida si algo se cuelga.
  try { server.close(() => process.exit(0)); } catch (e) { process.exit(0); }
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => cierreLimpio('SIGTERM'));
process.on('SIGINT',  () => cierreLimpio('SIGINT'));

// ── Iniciar servidor ───────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ Confecciones Millar v4.0 | Puerto ${PORT} | RESET_PASS: ${RESET_PASS ? 'OK' : 'NO configurada'} | CORS: ${ALLOWED_ORIGIN || 'abierto'}`);
});
