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
const mqtt     = require('mqtt');
const { valorProxyConfiable, crearLimitador } = require('./limitador');
const { crearArchivosPrivados, cookieSesion, nombreDeRuta } = require('./archivos-privados');
const { leerCookie } = require('./ps-autorizacion');
const { crearGuardiaGet } = require('./permisos-get');
const { leerConfigLuces, validarOrden, direccionSegura } = require('./mqtt-luces');
const { calcularEstadoMecanicos, mecanicosDelPerfil } = require('./estado-mecanicos');

/* La hora en cada linea del registro. Sin esto, cuando algo falla en la planta
   no hay manera de saber a que hora paso ni si dos mensajes son del mismo
   momento: son cientos de lineas seguidas sin una sola referencia de tiempo.
   Se envuelve console UNA vez en lugar de tocar las 140 llamadas que hay
   repartidas por el archivo. Asi ninguna se queda sin hora, no hay 140 sitios
   donde equivocarse, y ps-api.js queda cubierto sin tocarlo.
   Va aqui arriba a proposito: cualquier mensaje anterior se quedaria sin hora. */
(function laHoraEnElRegistro() {
  const real = { log: console.log, warn: console.warn, error: console.error };
  const sello = () => '[' + new Date().toLocaleString('es-CO', {
    timeZone: 'America/Bogota', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  }) + ']';
  console.log   = (...x) => real.log(sello(), ...x);
  console.warn  = (...x) => real.warn(sello(), ...x);
  console.error = (...x) => real.error(sello(), ...x);
})();

// ── MQTT: Pick-to-Light (ESP32) ────────────────────────────────────
// Broker, usuario, clave y tema salen de variables de entorno (ver mqtt-luces.js). Si la configuracion
// falta o es insegura, las luces quedan apagadas y se dice por que. Si el broker no responde o se cae,
// la app sigue normal: publicarLuz() nunca bloquea ni lanza, solo intenta avisarle al ESP32.
const luces = leerConfigLuces(process.env);
let mqttClient = null;
if (luces.modo === 'apagado') {
  console.error('[MQTT] Luces APAGADAS: ' + luces.motivo);
} else {
  if (luces.aviso) console.error('⚠️  [MQTT] ' + luces.aviso);
  try {
    mqttClient = mqtt.connect(luces.url, luces.opciones);
    mqttClient.on('connect',   () => console.log('[MQTT] Conectado a', direccionSegura(luces)));
    mqttClient.on('reconnect', () => console.log('[MQTT] Reintentando conexión...'));
    mqttClient.on('close',     () => console.warn('[MQTT] Conexión cerrada'));
    mqttClient.on('error',     (e) => console.error('[MQTT] Error:', e.message));
  } catch (e) {
    console.error('[MQTT] No se pudo iniciar el cliente:', e.message);
  }
}
function publicarLuz(canal, accion) {
  try {
    if (!mqttClient || !mqttClient.connected) return;
    const orden = validarOrden(canal, accion, luces.canalMax);
    if (!orden.ok) { console.warn('[MQTT] Orden de luz rechazada: ' + orden.motivo); return; }
    mqttClient.publish(luces.topic, JSON.stringify(orden.payload), err => {
      if (err) console.error('[MQTT] Error publicando:', err.message);
    });
  } catch (e) { console.error('[MQTT] Error en publicarLuz:', e.message); }
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
if (AUTH_ENFORCE) {
  console.log('[AUTH] Puerta de atrás (AUTH_ENFORCE): ENCENDIDA (exige sesión)');
} else {
  /* Apagar esto deja TODAS las rutas /api/* abiertas a quien sepa la direccion:
     cedulas, nombres, contratos, y las rutas que borran. Es util en el PC de
     casa; en produccion no. El aviso va gritado a proposito: antes era una
     linea mas entre veinte y nadie la veia en el arranque. */
  console.warn('════════════════════════════════════════════════════');
  console.warn('⚠️  ATENCIÓN: AUTH_ENFORCE=false');
  console.warn('   TODAS las rutas /api/* están ABIERTAS: cualquiera');
  console.warn('   que sepa la dirección lee y borra sin contraseña.');
  console.warn('   Usar SOLO en pruebas. Nunca en producción.');
  console.warn('════════════════════════════════════════════════════');
}

// ── Directorios ────────────────────────────────────────────────────
// Red de seguridad: si no se define DATA_DIR pero existe el disco persistente
// de Render montado en /var/data, usarlo automáticamente. Así, aunque se borre
// por error la variable DATA_DIR, la app sigue leyendo/guardando en el disco
// (no se pierden los datos).
// ── La fecha de hoy, en hora de Colombia ───────────────────────────
// toISOString() devuelve la fecha de Londres. A partir de las 7 de la noche
// eso adelanta un dia, y el servidor buscaba la asistencia del dia siguiente:
// el modulo aparecia con 0 personas y la meta salia mal toda la noche.
function fechaHoyCO(){ return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); }
// Cuantos dias de asistencia viajan en el paquete de arranque del tiempo real.
const IA_VENTANA_DIAS = 14;
function fechaIaVentanaDesde(){
  return new Date(Date.now() - IA_VENTANA_DIAS * 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}
function fechaCO(d){ const x = (d instanceof Date) ? d : new Date(d); return isNaN(x) ? '' : x.toLocaleDateString('en-CA', { timeZone: 'America/Bogota' }); }

const _RENDER_DISK = '/var/data';
const _DISK_OK     = (() => { try { return fs.existsSync(_RENDER_DISK); } catch (e) { return false; } })();
const DATA_DIR    = process.env.DATA_DIR    || (_DISK_OK ? _RENDER_DISK : path.join(__dirname, 'data'));
// Las fotos también van al disco permanente (antes se perdían en cada deploy).
const UPLOADS_DIR = process.env.UPLOADS_DIR || (_DISK_OK ? path.join(_RENDER_DISK, 'uploads') : path.join(__dirname, 'uploads'));
console.log(`[INIT] DATA_DIR = ${DATA_DIR}${(!process.env.DATA_DIR && _DISK_OK) ? ' (auto: disco Render)' : ''}`);

/* ── Red de seguridad ────────────────────────────────────────────────
   El servidor no tenia ningun manejo de errores a nivel de proceso: en Node
   moderno, un error o una promesa rechazada que se escape de una tarea en
   segundo plano MATA el servidor entero, y las ~200 pantallas reconectan de golpe.
   Ahora se registra el error con su hora y su pila —en el registro y en un archivo
   que no se pierde al reiniciar— y se sigue. Esto tambien deja por fin la
   evidencia de QUE era lo que tumbaba al servidor.
   Si fallara muchas veces seguidas (algo de verdad roto), se sale para que el
   supervisor lo levante limpio en vez de quedarse a medias. */
const _ERRORES_LOG = path.join(DATA_DIR, '_errores.log');
const _erroresRecientes = [];
function _anotarError(tipo, e) {
  const detalle = (e && e.stack) || String(e);
  console.error('[ERROR ' + tipo + '] ' + detalle);
  try {
    // El archivo no crece sin limite: pasado 2 MB se parte en dos.
    try { if (fs.statSync(_ERRORES_LOG).size > 2 * 1024 * 1024) fs.renameSync(_ERRORES_LOG, _ERRORES_LOG + '.1'); } catch (x) {}
    fs.appendFileSync(_ERRORES_LOG, new Date().toISOString() + ' [' + tipo + '] ' + detalle + '\n');
  } catch (x) { /* si ni el registro se puede escribir, ya quedo en la consola */ }
  const ahora = Date.now();
  _erroresRecientes.push(ahora);
  while (_erroresRecientes.length && ahora - _erroresRecientes[0] > 60000) _erroresRecientes.shift();
  if (_erroresRecientes.length >= 25) {
    console.error('[ERROR] 25 errores en un minuto: algo esta roto de verdad. Se reinicia el servidor.');
    process.exit(1);
  }
}
process.on('uncaughtException',  e => _anotarError('excepcion sin atrapar', e));
process.on('unhandledRejection', e => _anotarError('promesa sin atrapar', e));

[DATA_DIR, UPLOADS_DIR].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

// ── Rutas de archivos ──────────────────────────────────────────────
const FILES = {
  ia_state:       path.join(DATA_DIR, 'ia_state.json'),
  ia_records:     path.join(DATA_DIR, 'ia_records.json'),
  modules_config: path.join(DATA_DIR, 'modules_config.json'),
  tp_ocultos:     path.join(DATA_DIR, 'tablero_prod_ocultos.json'),
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
  accesos:        path.join(DATA_DIR, 'accesos.json'),
  sesiones_corte: path.join(DATA_DIR, 'sesiones_corte.json'),
  multitareas:    path.join(DATA_DIR, 'multitareas.json'),
  tareas:         path.join(DATA_DIR, 'tareas.json'),
  visitantes:     path.join(DATA_DIR, 'visitantes.json'),
  turnos_asignados: path.join(DATA_DIR, 'turnos_asignados.json'),
  consultas_contrato: path.join(DATA_DIR, 'consultas_contrato.json'),
  corte_solicitudes: path.join(DATA_DIR, 'corte_solicitudes.json'),
  mmt_locativo:   path.join(DATA_DIR, 'mmt_locativo.json'),
  ubicaciones:    path.join(DATA_DIR, 'ubicaciones.json'),
  // Recepción de telas (bodega de rollos): lo vivo, el historial de movimientos
  // y el catálogo de rendimientos kg → metros, cada uno aparte para no reescribir todo.
  bodega_telas:           path.join(DATA_DIR, 'bodega_telas.json'),
  bodega_telas_historial: path.join(DATA_DIR, 'bodega_telas_historial.json'),
  bodega_telas_catalogo:  path.join(DATA_DIR, 'bodega_telas_catalogo.json'),
  lotes:          path.join(DATA_DIR, 'lotes.json'),
  lt_clientes:    path.join(DATA_DIR, 'lt_clientes.json'),
  lt_tipos_prenda: path.join(DATA_DIR, 'lt_tipos_prenda.json'),
  lt_colores:     path.join(DATA_DIR, 'lt_colores.json'),
  lt_defectos:    path.join(DATA_DIR, 'lt_defectos.json'),
  lt_improductivos: path.join(DATA_DIR, 'lt_improductivos.json'),
  lt_centros_trabajo: path.join(DATA_DIR, 'lt_centros_trabajo.json'),
  almacen_insumos:     path.join(DATA_DIR, 'almacen_insumos.json'),
  almacen_movimientos: path.join(DATA_DIR, 'almacen_movimientos.json'),
  contador_produccion: path.join(DATA_DIR, 'contador_produccion.json'),
  // Auditorías de Calidad: qué módulos tiene cada auditora y las tareas que se le dan.
  auditorias_asignaciones: path.join(DATA_DIR, 'auditorias_asignaciones.json'),
  auditorias_tareas:       path.join(DATA_DIR, 'auditorias_tareas.json'),
  // Calificaciones manuales (Preparación): el % de eficiencia de cada persona y día.
  eficiencias_manuales: path.join(DATA_DIR, 'eficiencias_manuales.json'),
  config_produccion:   path.join(DATA_DIR, 'config_produccion.json'),
  // Ficha de cada prenda, indexada por referencia. Las operaciones y sus
  // balanceos son de la PRENDA, no de la orden: la misma referencia entra a la
  // planta decenas de veces (62301 lleva 42 ordenes) y cargarlas cada vez seria
  // repetir el mismo trabajo. Las ordenes solo apuntan a su ficha.
  fichas:         path.join(DATA_DIR, 'fichas.json'),
};

/* ══ Versión de la aplicación ══════════════════════════════════════
   Una huella del código que está corriendo. Se calcula UNA vez al arrancar,
   con el tamaño y la fecha de cada archivo de pantalla.

   Para qué: la app vive en unos 40 dispositivos —tablets, televisores, PCs—
   y hasta ahora, al subir un cambio, había que ir hasta cada uno a
   refrescarlo a mano. Con esto cada pantalla sabe con qué versión abrió y,
   cuando se reconecta al servidor y ve otra distinta, se recarga sola.

   Se usan tamaño y fecha, no el contenido: es igual de fiable para saber si
   algo cambió y no obliga a leer todos los archivos en cada arranque.

   Si el servidor se reinicia SIN cambios (un reinicio de PM2, por ejemplo),
   la huella es la misma y nadie se recarga: solo molesta a los dispositivos
   cuando de verdad hay algo nuevo que mostrar. */
const VERSION_APP = (() => {
  try {
    const h = crypto.createHash('md5');
    const anotar = f => {
      try { const st = fs.statSync(f); h.update(f + '|' + st.size + '|' + st.mtimeMs + ';'); }
      catch (e) { /* archivo que no está: no cuenta */ }
    };
    const recorrer = dir => {
      let entradas = [];
      try { entradas = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
      entradas.sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
        // node_modules y dist son de terceros o generados: no son "la app".
        if (e.isDirectory()) {
          if (e.name !== 'node_modules' && e.name !== 'dist') recorrer(path.join(dir, e.name));
        } else if (/\.(html|js|css)$/i.test(e.name)) {
          anotar(path.join(dir, e.name));
        }
      });
    };
    anotar(path.join(__dirname, 'server.js'));
    recorrer(path.join(__dirname, 'modulos'));
    recorrer(path.join(__dirname, 'compartido'));
    return h.digest('hex').slice(0, 12);
  } catch (e) {
    // Si algo falla, la hora de arranque: peor es quedarse sin la señal.
    return 'arranque-' + Date.now();
  }
})();

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

/* Listas que se leen muchas veces por minuto y se guardan pocas: se quedan en
   memoria después de la primera lectura y se actualizan al guardar. Antes cada
   consulta volvía a leer y descifrar el historial completo (~60 ms cada vez). */
const CACHE_LECTURA = new Set(['historial']);
const _cacheLectura = {};
function sqliteGet(key, defaultValue) {
  if (CACHE_LECTURA.has(key) && _cacheLectura[key] !== undefined) return _cacheLectura[key];
  try {
    const row = _stmtGet.get(key);
    if (!row) return defaultValue;
    const v = JSON.parse(row.value);
    if (CACHE_LECTURA.has(key)) _cacheLectura[key] = v;
    return v;
  }
  catch (e) { console.error('[SQLITE] get', key, e.message); return defaultValue; }
}
// Devuelve true/false según si la escritura REALMENTE quedó guardada.
// Antes este error se tragaba en silencio y las rutas respondían "ok" igual
// aunque el guardado hubiera fallado (disco lleno, bloqueo, etc.) — el
// navegador nunca se enteraba. Ahora el llamador puede saber si falló.
function sqliteSet(key, data) {
  try {
    _stmtSet.run(key, JSON.stringify(data), Date.now());
    if (CACHE_LECTURA.has(key)) _cacheLectura[key] = data;
    return true;
  }
  catch (e) {
    delete _cacheLectura[key];          // la próxima lectura trae lo que de verdad quedó guardado
    console.error('[SQLITE] set', key, e.message); return false;
  }
}

/* ── Listas grandes guardadas por día ──────────────────────────────────
   contador_produccion tiene una fila por marcación (unas 7.000 al día). Como
   UNA sola lista, cada marcación reescribía todo (28 MB, cerca de medio segundo)
   y mientras tanto todas las pantallas esperaban. Ahora se guarda un pedazo por
   día en el mismo almacén ("contador_produccion@2026-09-15") y al guardar solo
   se reescriben los días que cambiaron. Para el resto del código es la misma
   lista de siempre: loadDB la arma y saveDB la parte.

   Qué días se reescriben: los que tienen marcaciones nuevas, quitadas o
   reemplazadas (se comparan por objeto, sin volver a escribir todo), siempre
   el de hoy, y todos si quien guarda avisa que cambió registros por dentro
   (saveDB(key, lista, { todos: true })). Si el contenido quedó igual, no se
   escribe. La primera vez parte la lista única de antes y la deja guardada
   aparte como respaldo. */
const PARTIDAS = {
  contador_produccion: r => String((r && r.fecha) || '').slice(0, 10) || 'sin-fecha',
  auditorias_calidad:  r => String((r && r.fecha) || '').slice(0, 10) || 'sin-fecha'
};
const _particion = {};        // key → Map(dia → { refs, hash })
const _partidaApagada = {};   // si la primera partición falló, se sigue guardando como antes
const hashDe = s => crypto.createHash('md5').update(s).digest('base64');

function cargarPartida(key) {
  const filas = _sqlite.prepare('SELECT key, value FROM store WHERE key >= ? AND key < ? ORDER BY key')
    .all(key + '@', key + 'A');
  const dias = new Map();
  _particion[key] = dias;
  if (!filas.length) {
    const vieja = sqliteGet(key, []);
    const lista = Array.isArray(vieja) ? vieja : [];
    if (!lista.length) return lista;
    if (!escribirPartida(key, lista, { todos: true })) {
      console.error('[SQLITE] No se pudo partir por día', key, '— se sigue guardando como una sola lista');
      _partidaApagada[key] = true;
      delete _particion[key];
      return lista;
    }
    try {
      _sqlite.prepare('UPDATE store SET key = ? WHERE key = ?').run('respaldo_lista_unica_' + key + '_' + Date.now(), key);
    } catch (e) { console.error('[SQLITE] No se pudo apartar la lista única de', key, e.message); }
    console.log('[SQLITE]', key, 'quedó guardada por día:', dias.size, 'días,', lista.length, 'registros');
    return lista;
  }
  const lista = [];
  for (const fila of filas) {
    const items = JSON.parse(fila.value);
    dias.set(fila.key.slice(key.length + 1), { refs: items.slice(), hash: hashDe(fila.value) });
    for (const r of items) lista.push(r);
  }
  return lista;
}

function escribirPartida(key, lista, opciones) {
  const dias = _particion[key];
  const hoy = fechaHoyServidor();
  const grupos = new Map();
  for (const r of lista) {
    const d = PARTIDAS[key](r);
    let g = grupos.get(d);
    if (!g) grupos.set(d, g = []);
    g.push(r);
  }
  const escribir = [], borrar = [];
  grupos.forEach((items, dia) => {
    const antes = dias.get(dia);
    const tocado = !antes || opciones.todos || dia === hoy
      || antes.refs.length !== items.length || items.some((r, i) => r !== antes.refs[i]);
    if (!tocado) return;
    const json = JSON.stringify(items);
    const hash = hashDe(json);
    if (antes && antes.hash === hash) { antes.refs = items.slice(); return; }
    escribir.push({ dia, items, json, hash });
  });
  dias.forEach((_, dia) => { if (!grupos.has(dia)) borrar.push(dia); });
  if (!escribir.length && !borrar.length) return true;
  try {
    const quitar = _sqlite.prepare('DELETE FROM store WHERE key = ?');
    _sqlite.transaction(() => {
      const ahora = Date.now();
      escribir.forEach(e => _stmtSet.run(key + '@' + e.dia, e.json, ahora));
      borrar.forEach(dia => quitar.run(key + '@' + dia));
    })();
  } catch (e) { console.error('[SQLITE] set', key, e.message); return false; }
  escribir.forEach(e => dias.set(e.dia, { refs: e.items.slice(), hash: e.hash }));
  borrar.forEach(dia => dias.delete(dia));
  return true;
}

// ── Helpers de persistencia ────────────────────────────────────────
/* ── Memoria común ─────────────────────────────────────────────────
   Lo que ya se leyó no se vuelve a leer del disco. La usan readJSON y
   loadDB, que leen del mismo sitio: si cada una tuviera la suya, guardar
   por un lado no se vería por el otro. */
const dbCache = {};

function readJSON(filePath, defaultValue) {
  if (SQLITE_ON) {
    const key = keyFromPath(filePath);
    // undefined y no "vacío": una lista vacía guardada es un dato válido.
    if (dbCache[key] === undefined) dbCache[key] = sqliteGet(key, defaultValue);
    return dbCache[key];
  }
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
  if (SQLITE_ON) {
    const key = keyFromPath(filePath);
    dbCache[key] = data;                  // lo que se acaba de guardar es lo que vale
    return sqliteSet(key, data);
  }
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
  if (SQLITE_ON) {
    const key = keyFromPath(filePath);
    dbCache[key] = data;
    return sqliteSet(key, data);
  }
  try { fs.writeFileSync(filePath, JSON.stringify(data), 'utf8'); return true; }
  catch (e) { console.error('Error escribiendo (sync)', filePath, e.message); return false; }
}

function loadDB(key) {
  if (!dbCache[key]) {
    if (SQLITE_ON) {
      dbCache[key] = (PARTIDAS[key] && !_partidaApagada[key]) ? cargarPartida(key) : sqliteGet(key, []);
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
// opciones.todos: quien guarda cambió registros por dentro (no solo agregó o
// quitó), así que en las listas guardadas por día se revisan todos los días.
/* Las fichas pesan ~3 MB (casi todo son fotos) y las piden todos los tableros
   y pantallas de órdenes. Armar ese texto cada vez costaba ~120 ms de servidor.
   Se guarda ya armado y se tira en cuanto alguien guarda fichas (saveDB). */
let _fichasCache = { arr: null, len: -1, json: null, gz: null };
function saveDB(key, data, opciones) {
  if (key === 'fichas') { _fichasCache.json = null; _fichasCache.gz = null; }
  if (SQLITE_ON && PARTIDAS[key] && !_partidaApagada[key]) {
    if (!_particion[key]) cargarPartida(key);
    dbCache[key] = data;
    return escribirPartida(key, data, opciones || {});
  }
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

// ── Estado de Control de Asistencia ────────────────────────────────
/* Antes aqui se metia siempre a un supervisor "Programador" con todos los
   permisos. Ya no existe: quien administra es cualquier persona marcada como
   administradora en su cuenta de acceso, y Control de Ingresos arma a quien
   entra con su propia sesion. Se quita tambien de lo ya guardado. */
function normalizarEstadoIa(state) {
  if (!state || typeof state !== 'object') state = { supervisors: [], employees: [] };
  if (!Array.isArray(state.supervisors)) state.supervisors = [];
  state.supervisors = state.supervisors.filter(s => s && s.id !== 'programador');
  return state;
}

function loadInitialState() {
  return normalizarEstadoIa({ supervisors: [], employees: [] });
}

let iaState       = readJSON(FILES.ia_state, null);
let iaRecords     = readJSON(FILES.ia_records, []);
let modulesConfig = readJSON(FILES.modules_config, { disabled:[], extra:[], renamed:{}, modPass:{} });

if (!iaState) {
  iaState = loadInitialState();
} else {
  iaState = normalizarEstadoIa(iaState);
}
writeJSON(FILES.ia_state, iaState);

function saveIaState()       { const ok = writeJSON(FILES.ia_state,       iaState);       if (!ok) notifySaveError('Control de Asistencia'); return ok; }
// La asistencia vive en su propia variable (iaRecords), pero la meta de
// produccion la consulta por el otro camino (loadDB), que guarda una copia en
// memoria la primera vez y no la vuelve a leer. Resultado: si la supervisora
// agregaba gente a mitad del turno, la meta seguia con la gente que hubiera al
// arrancar el servidor. Aqui se refresca esa copia para que las dos vias vean
// siempre lo mismo.
function saveIaRecords()     { dbCache['ia_records'] = iaRecords; const ok = writeJSON(FILES.ia_records, iaRecords); if (!ok) notifySaveError('Control de Asistencia'); else programarRecalculoPorAsistencia(); return ok; }
function saveModulesConfig() { const ok = writeJSON(FILES.modules_config, modulesConfig); if (!ok) notifySaveError('Configuración de módulos'); return ok; }

// ── Estado Control de Piso ─────────────────────────────────────────
// Los modulos base salen del archivo compartido, el mismo que usan las
// pantallas. Antes esta lista estaba escrita a mano aqui y en 4 archivos mas.
const { BASE: MODULOS_BASE } = require("./compartido/millar-modulos.js");
// La misma cuenta de eficiencia que usan las pantallas (tiempo del día, turnos).
const MillarEficiencia = require("./compartido/millar-eficiencia.js");
const MillarPreparacion = require("./compartido/millar-preparacion.js");
const MODULES = MODULOS_BASE.slice();

const floorPersisted = readJSON(FILES.floor_state, {});
const states       = floorPersisted.states      || {};
const lastMec      = floorPersisted.lastMec     || {};
const stateTimes   = floorPersisted.stateTimes  || {};
const lastEmpleada = floorPersisted.lastEmpleada|| {};
// Qué está trabajando cada módulo ahora mismo:
//   trabajoActual[modulo] = { operaria, op, ref, operacion, meta, personas, desde }
//
// Antes esto vivía SOLO en el navegador de la tablet (una clave cp_sesion_M26
// en su localStorage). Eso traía tres problemas: el servidor no sabía qué
// trabajaba cada módulo —así que ningún tablero podía mostrarlo—, la operaria
// que cambiaba de tablet empezaba de cero, y si se borraban los datos del
// navegador no quedaba copia en ninguna parte.
const trabajoActual = floorPersisted.trabajoActual || {};
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
// Los improductivos que se crean en Configuraciones -> Produccion viven solo
// dentro del Contador de Produccion: no pintan el modulo en Tablero CI, Tablero
// General ni Tablero Mecanicos. Se reconocen por la clave "custom:".
function esImpPropio(imp) {
  return String((imp && (imp.tipoActual || imp.tipo)) || '').startsWith('custom:');
}
/* De qué color se ve el módulo cuando tiene varias cosas abiertas a la vez.

   El mecánico manda: si el módulo está esperando un mecánico, se ve ROJO
   aunque encima hayan pedido insumos. Antes ganaba el último en abrirse, así
   que una solicitud de insumos tapaba un fallo mecánico y el Tablero de
   Mecánicos dejaba de mostrarlo — el mecánico no se enteraba.

   El resto conserva la regla de siempre: manda el último que se abrió. */
// El improductivo que pinta la tarjeta del módulo en los tableros: el último
// del mecánico si hay alguno; si no, el último que se abrió.
function impQuePintaMod(modId) {
  const imps = (multiImps[modId] || []).filter(i => !esImpPropio(i));
  if (!imps.length) return null;
  const tipoDe = i => i.tipoActual || i.tipo || '';
  const mecanico = imps.filter(i => ['red', 'yellow'].includes(tipoDe(i)));
  return mecanico.length ? mecanico[mecanico.length - 1] : imps[imps.length - 1];
}
function calcColorMod(modId) {
  const imp = impQuePintaMod(modId);
  return (imp && (imp.tipoActual || imp.tipo)) || 'green';
}
/* El reloj y el nombre de la tarjeta salen de ese mismo improductivo.

   Antes el reloj volvía a cero con cada cambio en el módulo. Si Olga y
   Katherine tenían cada una su espera de mecánico y se cerraba la de Olga, la
   tarjeta seguía en rojo con el nombre de Katherine pero decía "1m 15s",
   aunque su espera llevaba más de una hora. */
function ponerRelojMod(modId) {
  const imp = impQuePintaMod(modId);
  stateTimes[modId] = (imp && imp.inicio) || Date.now();
  if (imp) {
    lastEmpleada[modId] = imp.empleada || '';
    lastMec[modId]      = imp.mecanico || '';
  }
}

/* Cuántos milisegundos le faltan a un improductivo de tiempo definido.
   0 si no tiene tiempo definido o si ya se cumplió. */
function faltaTiempo(imp) {
  const min = Number(imp && imp.minutos) || 0;
  if (!(min > 0)) return 0;
  const falta = (imp.inicio || 0) + min * 60000 - Date.now();
  return falta > 0 ? falta : 0;
}

/* La hora en que TERMINA un improductivo.

   Si tiene tiempo definido, termina EXACTAMENTE cuando se cumple: un desayuno
   de 15 minutos dura 15:00.000, ni un milisegundo más. Antes se guardaba la
   hora en que el barrido alcanzaba a cerrarlo —revisa cada 10 segundos—, así
   que quedaban 15,08 minutos y el informe mostraba 16. Que el barrido pase
   unos segundos después es cosa del programa, no del desayuno: al módulo se le
   cobran los 15 que se le definieron.

   Vale igual si el servidor estuvo caído: al volver, el improductivo se cierra
   a la hora en que le tocaba, no a la hora en que el servidor despertó. */
function finDeImp(imp) {
  const min = Number(imp && imp.minutos) || 0;
  const ahora = Date.now();
  if (!(min > 0) || !imp.inicio) return ahora;
  return Math.min(ahora, imp.inicio + min * 60000);
}

/* Cierra de verdad un improductivo: lo guarda en el historial, lo saca de la
   lista del módulo y avisa a las pantallas.
   Lo llaman el cierre a mano y el barrido que cierra los de tiempo definido. */
function finalizarImp(modId, idx, wsOrigen, forzar) {
  const imp = (multiImps[modId] || [])[idx];
  if (!imp) return;

  /* ── LA REGLA, EN EL ÚNICO SITIO POR DONDE SE CIERRA ──────────────

     Una espera de mecánico NO se cierra. Termina de una sola forma: cuando
     alguien dice qué mecánico llegó, y ahí pasa a "atención de mecánico".
     Nunca queda una espera sin su atención.

     La regla estaba escrita en cada camino por separado —el de la tablet, el
     del tablero, el de CI— y bastaba con que apareciera un camino nuevo para
     que se colara otra vez. Por eso ahora vive aquí: este es el embudo por el
     que pasa TODO cierre, así que ningún camino, ni los que se inventen
     mañana, puede saltársela. */
  if (!forzar && (imp.tipoActual || imp.tipo) === 'red') {
    console.warn(`[ESPERA] ${modId}: se rechazó cerrar una espera de mecánico sin su atención.`);
    return false;   // quien llame avisa: un rechazo mudo deja chips fantasma
  }
  // El principal ya lo registró el bloque 'change' cuando se creó.
  if (!imp.esPrincipal) {
    guardarImproductivo(modId, imp.tipoActual || imp.tipo,
      imp.inicio || Date.now(), finDeImp(imp), {
        mecanico:    imp.mecanico,
        empleada:    imp.empleada,
        operacion:   imp.operacion,
        ciRequestId: imp.ciRequestId,
        descripcion: imp.descripcion
      });
  }
  const eraPropio = esImpPropio(imp);
  multiImps[modId].splice(idx, 1);
  states[modId] = calcColorMod(modId);
  broadcast({ type: 'multi_imp_change', action: 'close', modId, impId: imp.id }, wsOrigen || null);
  // Cerrar uno propio no cambia nada en los tableros: nunca los pintó.
  if (eraPropio) { saveFloorState(); return true; }
  ponerRelojMod(modId);
  if (states[modId] === 'green') {
    lastMec[modId]      = '';
    lastEmpleada[modId] = '';
  }
  saveFloorState();
  broadcast({
    type: 'change', id: modId, state: states[modId],
    mecanico: lastMec[modId] || '', limite: null,
    empleada: lastEmpleada[modId] || '', stateTime: stateTimes[modId],
    fromMulti: true
  });
  return true;
}

/* Los improductivos de tiempo definido se cierran SOLOS al cumplirse.
   Se barre cada 10 segundos en vez de programar un temporizador por cada uno:
   así un reinicio del servidor no deja ninguno colgado para siempre —al volver,
   el primer barrido cierra los que se pasaron mientras estaba caído. */
setInterval(() => {
  try {
    Object.keys(multiImps).forEach(modId => {
      for (let i = (multiImps[modId] || []).length - 1; i >= 0; i--) {
        const imp = multiImps[modId][i];
        if (Number(imp.minutos) > 0 && faltaTiempo(imp) === 0) finalizarImp(modId, i, null);
      }
    });
  } catch (e) { console.error('[TIEMPOS] barrido de improductivos:', e.message); }
}, 10000);

function getAllActiveModules() {
  const extra    = modulesConfig.extra    || [];
  const renamed  = modulesConfig.renamed  || {};
  const disabled = modulesConfig.disabled || [];
  const all = [...MODULES, ...extra];
  return all
    .filter(id => !disabled.includes(id))
    .map(id => renamed[id] || id);
}

/* Escribe en el historial una parada que ya terminó.
   La usan los DOS caminos por los que se cierra un improductivo: el del tablero
   (logHistorial) y el de varios improductivos a la vez. Antes cada uno armaba el
   registro por su cuenta y no hacían lo mismo — el segundo dejaba la persona y
   la operación en blanco porque no las buscaba si no se las mandaban. */
function guardarImproductivo(modId, tipoReal, inicioMs, finMs, extra) {
  const durMs = finMs - inicioMs;
  if (!(durMs > 0)) return null;
  const opts     = { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true };
  const fin      = new Date(finMs);
  const bogota   = new Date(fin.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
  const fechaISO = bogota.getFullYear() + '-' + String(bogota.getMonth() + 1).padStart(2, '0')
                 + '-' + String(bogota.getDate()).padStart(2, '0');
  let historial  = readJSON(FILES.historial, []);
  const reg = {
    num:            historial.filter(r => r.fechaISO === fechaISO).length + 1,
    fecha:          fin.toLocaleDateString('es-CO', { timeZone: 'America/Bogota' }),
    fechaISO,
    horaInicio:     new Date(inicioMs).toLocaleTimeString('es-CO', opts),
    hora:           fin.toLocaleTimeString('es-CO', opts),
    modulo:         modId,
    tipo:           tipoReal,
    estadoAnterior: tipoReal,
    estadoNuevo:    'green',
    durMinutos:     parseFloat((durMs / 60000).toFixed(2)),
    mecanico:       (extra && extra.mecanico) || lastMec[modId] || '',
    // Si no viene, se busca: la operaria que abrió la parada y la operación que
    // el módulo tenía abierta. Una atención sin persona no debería existir.
    empleada:       (extra && extra.empleada) || lastEmpleada[modId] || '',
    operacion:      (extra && extra.operacion)
                    || (trabajoActual[modId] && trabajoActual[modId].operacion) || '',
    // Se graba el nombre, no solo la clave: si mañana borran ese improductivo
    // del catálogo, este registro sigue diciendo qué fue.
    nombreTipo:     nombreDeImproductivo(tipoReal)
  };
  if (extra && extra.ciRequestId) reg.ciRequestId = extra.ciRequestId;
  // En OTROS, lo que pasó según la operaria. Donde se muestre el tipo, se
  // muestra esto en su lugar.
  if (extra && extra.descripcion) reg.descripcion = String(extra.descripcion).trim().toUpperCase();
  historial.push(reg);
  if (historial.length > HISTORIAL_MAX) historial = historial.slice(-HISTORIAL_MAX);
  writeJSON(FILES.historial, historial);
  return reg;
}

function logHistorial(id, prevState, newState, mecanico, empleada, operacion) {
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

  // La operaria se guarda SIEMPRE que se sepa quien es.
  //
  // Antes solo se guardaba en "espera mecanico" y "atendiendo", porque eran los
  // unicos donde se preguntaba a quien atender. En los demas la lista de
  // improductivos salia con la columna Persona vacia, y no habia forma de saber
  // quien estaba en el modulo cuando se paro.
  //
  // Ahora el Contador manda quien esta en la tablet en todos los casos, y eso no
  // es una suposicion: para entrar al Contador hay que elegir el nombre. Si el
  // improductivo se reporto desde el Control de Piso, que no lo sabe, sigue
  // llegando vacio y se guarda vacio — mejor eso que inventarlo.
  //
  // El mecanico sigue guardandose solo donde interviene uno.
  const empleadaFinal = empleada || lastEmpleada[id] || '';
  let mecanicoFinal = '';
  if(prevState === 'red' || prevState === 'yellow' || prevState === 'garnet' || prevState === 'pink'){
    mecanicoFinal = mecanico || lastMec[id] || '';
  }
  // La operación no se pregunta: es la que la operaria tiene abierta en el
  // Contador de Producción para este módulo en este momento. No es una
  // suposición — trabajoActual[id] es lo mismo que ya usa el Tablero de
  // Producción para mostrar "qué está haciendo" cada módulo.
  const operacionFinal = operacion || (trabajoActual[id] && trabajoActual[id].operacion) || '';

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
    empleada:  empleadaFinal,
    operacion: operacionFinal
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
  const ok = writeJSON(FILES.floor_state, { states, lastMec, stateTimes, lastEmpleada, multiImps, trabajoActual });
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
  moduleList: MODULOS_BASE.slice().concat(['Empaque']),
  obsList: ['Pérdida','Faltante','Defectos']
};

let ciRequests = readJSON(FILES.ci_requests, []);
let ciConfig   = readJSON(FILES.ci_config, CI_CONFIG_DEFAULT);

function saveCiRequests() { const ok = writeJSON(FILES.ci_requests, ciRequests); if (!ok) notifySaveError('Tablero CI'); return ok; }
function saveCiConfig()   { const ok = writeJSON(FILES.ci_config,   ciConfig);   if (!ok) notifySaveError('Tablero CI'); return ok; }

// ── Datos estáticos Alistamiento ───────────────────────────────────────
const SUPERVISORAS_BIT = []; // se gestionan desde la app
const MECANICOS_BIT = []; // se gestionan desde la app
const BASE_MODULOS_BIT = MODULOS_BASE.slice().concat(['Preparación','Empaque']);
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

  /* Solo en una instalacion NUEVA, para que haya con que entrar la primera vez.
     Se retira solo en cuanto exista un administrador por cedula (ver
     retirarPerfilesAdmin). En la planta ya no existe. */
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
    const retirados = perfilesRetiradosVigente();
    extra.forEach(u => {
      if (!u || !u.nombre) return;
      if (retirados && esPerfilRetirado(u.nombre)) return;   // una pantalla vieja no los revive
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
      /* Si le cambiaron la contrasena o lo dieron de baja, sus sesiones
         abiertas dejan de servir en el acto, sin esperar a que caduquen. */
      // Solo cuenta si alguien ESCRIBIO una clave nueva. Antes bastaba con que el hash
      // guardado en el panel fuera distinto del de users.json, y eso podia pasar sin
      // que nadie cambiara nada.
      const claveCambio = !!(hasNewPass && cur && cur.passHash && passHash !== cur.passHash);
      const reciénDeBaja = !!(cur && !cur.disabled && !esProg && !!u.disabled);
      if (claveCambio || reciénDeBaja) cortarSesiones(u.nombre);

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
  // Las contraseñas de los miembros (Mecánicos, Supervisoras, Telas…) tampoco
  // salen: la pantalla solo sabe si el miembro TIENE clave. La revisa el
  // servidor en /api/miembros/verificar.
  if (cfg._perfil_members && typeof cfg._perfil_members === 'object') {
    out._perfil_members = {};
    Object.keys(cfg._perfil_members).forEach(perfil => {
      const lista = cfg._perfil_members[perfil];
      out._perfil_members[perfil] = Array.isArray(lista) ? lista.map(m => {
        if (!m || typeof m !== 'object') return m;
        const { pass, ...rest } = m;
        rest.tieneClave = !!(pass && String(pass) !== '');
        return rest;
      }) : lista;
    });
  }
  return out;
}

// La pantalla ya no recibe las claves de los miembros, asi que cuando guarda la
// lista las manda vacias. Vacio = "no la cambie": se conserva la que habia.
function conservarClavesMiembros(anteriores, nuevos) {
  if (!nuevos || typeof nuevos !== 'object') return nuevos;
  const out = {};
  Object.keys(nuevos).forEach(perfil => {
    const lista = nuevos[perfil];
    const antes = Array.isArray((anteriores || {})[perfil]) ? anteriores[perfil] : [];
    out[perfil] = Array.isArray(lista) ? lista.map(m => {
      if (!m || typeof m !== 'object') return m;
      const { tieneClave, nombreAnterior, ...rest } = m;
      if (rest.pass != null && String(rest.pass) !== '') return rest;
      const buscado = nombreAnterior || rest.nombre || rest.name;
      const previo = antes.find(x => x && typeof x === 'object' && compararNombres(x.nombre || x.name, buscado));
      if (previo && previo.pass) rest.pass = previo.pass; else delete rest.pass;
      // La foto de un miembro solo se quita mandando foto:'' a propósito; si simplemente no viene, se conserva.
      if (rest.foto === undefined && previo && previo.foto) rest.foto = previo.foto;
      return rest;
    }) : lista;
  });
  return out;
}

// Token de sesión firmado (HMAC). Formato: base64url(payload).hmac
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig  = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
/* Corte de sesiones. Un token vale hasta que a su dueño se le corta la sesion:
   al cambiarle la contrasena, al darlo de baja o al quitarle el acceso. Antes
   nada de eso cerraba nada: la sesion vieja seguia entrando por su cuenta
   hasta caducar sola, semanas despues.
   Se guarda aparte y no dentro de users.json ni de accesos.json: esas dos las
   reescriben pantallas enteras de una sola vez, y un dato de sesion no tiene
   por que viajar junto a las contrasenas.
   Los tokens de antes de este cambio no traen 'iat'. Se siguen aceptando
   mientras a su dueño no se le haya cortado nada, asi que nadie tiene que
   volver a entrar el dia que esto se suba. */
function cortesDeSesion() {
  const c = loadDB('sesiones_corte');
  return (c && typeof c === 'object' && !Array.isArray(c)) ? c : {};
}
function cortarSesiones(user) {
  if (!user) return;
  const c = cortesDeSesion();
  c[String(user)] = Date.now();
  saveDB('sesiones_corte', c);
  console.log(`[AUTH] Sesiones cerradas para "${user}"`);
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
    const corte = cortesDeSesion()[String(payload.user || '')];
    if (corte && (!payload.iat || payload.iat < corte)) return null;  // sesion cortada
    return payload;
  } catch { return null; }
}


// ══════════════════════════════════════════════════════════════════
//  CUENTAS DE ACCESO POR CEDULA
// ══════════════════════════════════════════════════════════════════
// Una cuenta es el permiso de una PERSONA para entrar. La identidad (nombre,
// cargo, si esta activa) sale siempre de la ficha de empleados; aqui solo
// vive lo del acceso. Se unen por la cedula.
//
//   accesos = {
//     version: 1,
//     cuentas: {
//       "1035880246": {
//         clave: "<cifrada>",      // para que el administrador pueda verla
//         hash:  "<bcrypt>",       // contra esto se comprueba al entrar
//         perms: ["modulos", ...],
//         admin: true,
//         disabled: false,
//         creado: "...", creadoPor: "...", cambiado: "..."
//       }
//     }
//   }

// La llave con la que se cifran las contrasenas. Vive fuera de la base a
// proposito: quien se lleve una copia de la base se lleva texto ilegible.
// Si no esta puesta se usa una derivada del secreto de sesion, y se avisa.
const CLAVE_MAESTRA = process.env.CLAVE_MAESTRA || '';
const LLAVE_CIFRADO = crypto.createHash('sha256')
  .update(CLAVE_MAESTRA || ('derivada:' + SESSION_SECRET)).digest();
if (!CLAVE_MAESTRA) {
  console.warn('[ACCESOS] CLAVE_MAESTRA no esta puesta: las contrasenas se cifran con una llave derivada del secreto de sesion. Ponla en el servidor para separarlas.');
}

/* Cifrar y descifrar. AES-256-GCM: ademas de ocultar, avisa si el texto fue
   manipulado. Se guarda "iv.tag.texto", todo en base64. */
function cifrarClave(texto) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', LLAVE_CIFRADO, iv);
  const out = Buffer.concat([c.update(String(texto), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), out.toString('base64')].join('.');
}
function descifrarClave(guardado) {
  try {
    const [iv, tag, txt] = String(guardado || '').split('.');
    if (!iv || !tag || !txt) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', LLAVE_CIFRADO, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(txt, 'base64')), d.final()]).toString('utf8');
  } catch (e) {
    // Llave cambiada o dato danado: no se puede ensenar, pero entrar si se puede.
    return null;
  }
}

const soloDigitos = (v) => String(v == null ? '' : v).replace(/\D+/g, '');
/* Para comparar cargos: sin tildes, sin espacios de mas y en mayusculas.
   Asi "Operaria", "OPERARIA " y "operaria" son el mismo cargo. */
const cargoIgual = (v) => String(v == null ? '' : v)
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ').trim().toUpperCase();

function cargarAccesos() {
  const a = readJSON(FILES.accesos, null);
  if (a && a.cuentas) return a;
  return { version: 1, cuentas: {} };
}
function guardarAccesos(a) { return writeJSON(FILES.accesos, a); }

/* La persona detras de una cedula, sacada SIEMPRE de la ficha de empleados. */
function empleadoPorCedula(cedula) {
  const c = soloDigitos(cedula);
  if (!c) return null;
  const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
  return (st.employees || []).find(e => e && soloDigitos(e.cedula) === c) || null;
}

/* Quien puede entrar y con que. Devuelve null si no puede, y dice por que en
   el registro del servidor — nunca al navegador. */
function cuentaDeCedula(cedula) {
  const c = soloDigitos(cedula);
  const emp = empleadoPorCedula(c);
  if (!emp) return { no: 'esa cedula no esta en la ficha' };
  if (emp.disabled) return { no: 'la persona esta inactiva en la ficha' };
  const cuenta = cargarAccesos().cuentas[c];
  if (!cuenta) return { no: 'la persona no tiene acceso autorizado' };
  if (cuenta.disabled) return { no: 'el acceso esta deshabilitado' };
  return { ok: true, cedula: c, emp, cuenta };
}

/* Los permisos de quien hace la peticion, venga por perfil o por cedula. */
function permisosDeLaPeticion(auth) {
  if (!auth) return { perms: [], admin: false };
  if (auth.tipo === 'persona') {
    const r = cuentaDeCedula(auth.user);
    if (!r.ok) return { perms: [], admin: false };
    return { perms: r.cuenta.perms || [], admin: r.cuenta.admin === true };
  }
  const u = (loadUsers().users || {})[auth.user];
  if (!u || u.disabled) return { perms: [], admin: false };
  const perms = u.perms || [];
  return { perms, admin: perms.includes('*') || perms.includes('configuraciones') || perms.includes('fix') };
}
/* Los modulos donde se puede afinar por accion. En el resto, el permiso del
   modulo sigue siendo un interruptor: entras o no entras. */
const MODULOS_CON_ACCIONES = ['ordenes_produccion', 'consulta_incentivos', 'registros_produccion', 'configuraciones'];
const ACCIONES = ['ver', 'crear', 'editar', 'borrar'];

/* Puede una persona hacer ESTO en ESTE modulo? */
function puedeAccion(auth, modulo, accion) {
  const { perms, admin } = permisosDeLaPeticion(auth);
  if (perms.includes('*') || admin) return true;
  const finas = ACCIONES.filter(a => perms.includes(modulo + ':' + a));
  // Sin permisos de accion marcados: se comporta como siempre.
  if (!finas.length) return perms.includes(modulo);
  return perms.includes(modulo + ':' + accion);
}

/* Guardia por accion. Admite varios modulos: basta con poder en uno. */
function requireAccion(accion, ...modulos) {
  return (req, res, next) => requireAuth(req, res, () => {
    if (modulos.some(m => puedeAccion(req.auth, m, accion))) return next();
    const comoSeLlama = { ver: 'ver', crear: 'crear', editar: 'modificar', borrar: 'eliminar' }[accion] || accion;
    return res.status(403).json({ error: 'No tienes permiso para ' + comoSeLlama + ' aquí' });
  });
}

/* Un administrador pasa todos los guardias de modulo. Es lo que ya hacia
   antes de poner los guardias —las rutas estaban abiertas— y es lo que se
   espera de un administrador: que pueda administrar. La separacion sigue
   valiendo para todos los demas. */
function tienePermiso(auth, claves) {
  const { perms, admin } = permisosDeLaPeticion(auth);
  if (perms.includes('*') || admin) return true;
  return claves.some(k => perms.includes(k));
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

// La IP real del visitante. Detrás de nginx Express veía siempre 127.0.0.1 y todos
// compartían el mismo cupo de intentos. Solo se cree en X-Forwarded-For lo que escribe
// nginx (conexión local); lo que mande el visitante se ignora. Ver limitador.js.
app.set('trust proxy', valorProxyConfiable(process.env.TRUST_PROXY));

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

// Cuanto texto se acepta de una sola vez. Estaba en 50 MB: cualquiera con
// sesion podia mandar 50 MB y dejar al servidor masticando eso mientras la
// planta espera. Lo normal aqui son unos pocos cientos de kilobytes.
// Dos rutas se salen de la norma porque mandan la configuracion o la pizarra
// enteras, asi que tienen su propio cupo mas holgado. Si algun dia otra ruta
// necesita mas, se agrega a esta lista; no hay que volver a subir el general.
/* /api/revision-telas: la pantalla mandaba TODOS los registros en cada guardado (más de 10 MB) y el
   servidor los rechazaba con "cuerpo demasiado grande": nada se guardaba. Ahora la pantalla manda solo
   lo que cambió, y además la ruta tiene cupo de sobra por si algún equipo manda todo. */
const RUTAS_CON_MAS_CUPO = new Set(['/api/app-config', '/api/produccion', '/api/revision-telas', '/punto-seguro/api/paquete/induccion']);
const jsonNormal = express.json({ limit: '10mb' });
const jsonGrande = express.json({ limit: '25mb' });
app.use((req, res, next) =>
  (RUTAS_CON_MAS_CUPO.has(req.path) ? jsonGrande : jsonNormal)(req, res, next));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Si alguien se pasa del cupo, que lo diga en cristiano y no con un error
// suelto que la pantalla no sabe mostrar.
app.use((err, req, res, next) => {
  if (err && (err.type === 'entity.too.large' || err.status === 413)) {
    console.warn(`[LIMITE] cuerpo demasiado grande en ${req.method} ${req.path} desde IP ${req.ip}`);
    return res.status(413).json({ error: 'Los datos enviados son demasiado grandes.' });
  }
  return next(err);
});

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
// Rutas accesibles sin sesion. Mantener al minimo: todo lo que entre aqui
// queda expuesto a internet.
//   /api/login  arranca la sesion, no puede exigirla
//   /api/me     es la comprobacion de sesion; responde 401 si no hay
//   /health     no devuelve ningun dato
// /api/buscar-contrato SALIO de esta lista: devolvia nombre, cedula, celular
// y numero de contrato de 133 personas sin pedir credenciales. Solo lo usa
// incentivos.html, que si envia el token.
// /api/perfiles solo devuelve los nombres de los perfiles: es lo que la
// pantalla de inicio de sesion necesita para armar la lista, y no puede pedir
// token porque todavia no hay sesion.
//   /api/entrar es el /api/login de las personas: tampoco puede exigir sesion
const AUTH_PUBLIC = new Set(['/api/login', '/api/entrar', '/api/me', '/api/perfiles', '/health']);
app.use((req, res, next) => {
  if (!AUTH_ENFORCE) return next();                          // interruptor apagado
  // Punto Seguro va incluido: su router no traia ninguna comprobacion propia.
  // Su POST /auth solo le respondia al navegador si la contrasena era correcta,
  // pero ninguna ruta de datos lo verificaba, y PUT /config/admin-pass permitia
  // cambiar la contrasena de administrador sin credencial alguna.
  const esApi = req.path.startsWith('/api')
             || req.path.startsWith('/alistamiento/api')
             || req.path.startsWith('/punto-seguro/api');
  if (!esApi) return next();                                 // páginas/archivos estáticos: libres
  if (AUTH_PUBLIC.has(req.path)) return next();              // rutas públicas
  if (req.path.startsWith('/api/archivos/')) return next();  // se autentica sola (cookie o encabezado)
  const hdr   = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7)
              : (req.headers['x-session-token'] || req.query.token || '');
  if (verifyToken(token)) {
    // Para que las fotos y fichas (<img>, enlaces) puedan viajar con la sesión sin mandar encabezados.
    if (hdr.startsWith('Bearer ') && leerCookie(req.headers.cookie, 'cm_arch') !== token)
      res.append('Set-Cookie', cookieSesion(token, { seguro: req.secure }));
    return next();
  }
  return res.status(401).json({ error: 'No autenticado' });
});

// ── Permisos de lectura por módulo (permisos-get.js) ───────────────
// PERMISOS_GET_MODO=observar (por defecto): no bloquea, solo anota "habria negado a X en GET /ruta" para
// ajustar la tabla con el uso real. =aplicar: responde 403 a quien no tenga ningún permiso de la regla.
const guardiaGet = crearGuardiaGet({
  tienePermiso, verificarToken: verifyToken,
  modo: process.env.PERMISOS_GET_MODO || 'observar',
  registrar: m => console.warn(m)
});
app.use(guardiaGet);
console.log(`[PERMISOS-GET] modo ${guardiaGet.modo} (${guardiaGet.reglas} reglas)`);

// ── #5 Frenos de intentos (limitador.js) ──────────────────────────
// rateLimit(max, ventanaMs): cada IP real y cada ruta llevan su propia cuenta, y los contadores
// no crecen sin límite. Las claves equivocadas se cuentan aparte (bloqueadoPorFallos / anotarFallo).
const { rateLimit, bloqueadoPorFallos, anotarFallo } = crearLimitador();

// ── Archivos subidos (fotos de mecánicos, fichas técnicas) ────────────
// Ya NO se publican como carpeta: salen por /api/archivos/:nombre con sesión, permiso del módulo y
// comprobando que algún registro los usa (ver archivos-privados.js). Las direcciones viejas se
// redirigen a la nueva para que los registros antiguos sigan mostrando su foto.
let _refArchivos = { t: 0, fotos: new Set(), fichas: new Set() };
function archivosReferenciados() {
  if (Date.now() - _refArchivos.t < 60 * 1000) return _refArchivos;       // se rearma cada minuto
  const fotos = new Set(), fichas = new Set();
  ['alistamientos', 'mantenimientos'].forEach(k => (loadDB(k) || []).forEach(r =>
    (Array.isArray(r && r.fotos) ? r.fotos : []).forEach(x => { const n = nombreDeRuta(x); if (n) fotos.add(n); })));
  (loadDB('fichas') || []).forEach(fi => { const n = nombreDeRuta(fi && fi.fichaTecnica); if (n) fichas.add(n); });
  const mecanicos = new Set();
  const miembros = (readJSON(FILES.app_config, {}) || {})._perfil_members || {};
  Object.keys(miembros).forEach(p => (Array.isArray(miembros[p]) ? miembros[p] : []).forEach(m => {
    const n = nombreDeRuta(m && typeof m === 'object' ? m.foto : ''); if (n) mecanicos.add(n);
  }));
  return (_refArchivos = { t: Date.now(), fotos, fichas, mecanicos });
}
const archivos = crearArchivosPrivados({
  carpeta: UPLOADS_DIR,
  verificarToken: verifyToken,
  tienePermiso,
  esAdmin: payload => permisosDeLaPeticion(payload).admin,
  referenciados: archivosReferenciados,
  exigirSesion: AUTH_ENFORCE            // con el interruptor apagado (pruebas locales) se comporta como antes
});
app.get('/api/archivos/:nombre', archivos.servir);
app.get(['/alistamiento/uploads/:nombre', '/fichas-tecnicas/:nombre'], (req, res) =>
  res.redirect(302, '/api/archivos/' + encodeURIComponent(req.params.nombre)));

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

// Las pantallas se entregan "apretadas" (ver proteger-codigo.js); PROTEGER_CODIGO=0 lo apaga.
const { enviar: enviarPantalla } = require('./proteger-codigo');
// ── Rutas principales ──────────────────────────────────────────────
// Los archivos de cada pantalla viven en modulos/<nombre>/ — las URLs no cambian,
// solo dónde vive el archivo en disco.
app.get('/', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/index/index.html'))
);
app.get('/ingresos', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/ingresos/ingresos.html'))
);
// Registro Mecánicos (antes "Alistamiento"). Servido en la ruta nueva y la vieja (alias).
app.get(['/registro-mecanicos', '/alistamiento'], (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/registro-mecanicos/registro-mecanicos.html'))
);

app.get('/solicitar-insumos', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/solicitar-insumos/solicitar_insumos.html'))
)
app.get('/hoja-vida', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/hoja-vida-maquina/hoja_vida_maquina.html'))
);

app.get('/ordenes', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/ordenes/ordenes.html'))
);

app.get('/contador-produccion', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/contador-produccion/contador_produccion.html'))
);
app.get('/contador-produccion/admin', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/contador-produccion/contador_produccion_admin.html'))
);
app.get('/configuracion-produccion', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/contador-produccion/configuracion_produccion.html'))
);
// Las tres pantallas de consulta comparten archivo: la tabla, los filtros por
// columna, el rango de fechas, la edición y la exportación son los mismos en las
// tres. Lo único que cambia son las columnas, y eso lo decide la ruta.
['registros-produccion', 'tiempos-improductivos', 'reporte-calidad'].forEach(ruta =>
  app.get('/' + ruta, (req, res) =>
    enviarPantalla(res, path.join(__dirname, 'modulos/registros/registros.html')))
);

// ── Recogedores ───────────────────────────────────────────────────
app.get('/recogedores', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/recogedores/recogedores.html'))
);

app.get('/produccion', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/produccion/produccion.html'))
);

app.get('/revision-telas', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/revision-telas/revision_telas.html'))
);

app.get('/estado-mecanicos', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/estado-mecanicos/estado_mecanicos.html'))
);

app.get('/bodega-telas', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/bodega-telas/bodega_telas.html'))
);
app.get('/corte', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/corte/corte.html'))
);
// El tablero es la misma pantalla del menu principal: antes era una copia
// aparte (tablero.html) que se iba quedando atras en cada arreglo.
app.get('/tablero', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/index/index.html'))
);
app.get('/tablero-produccion', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/tablero-produccion/tablero_produccion.html'))
);
// El mismo tablero, pero una tarjeta por persona en vez de una por módulo.
app.get('/tablero-individual', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/tablero-individual/tablero_individual.html'))
);
app.get('/almacen-insumos', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/almacen-insumos/almacen_insumos.html'))
);
app.get('/informes', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/informes/informes.html'))
);

app.get('/auditorias-calidad', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/auditorias-calidad/auditorias_calidad.html'))
);
app.get('/preparacion', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/preparacion/preparacion.html'))
);
app.get('/incentivos', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/incentivos/incentivos.html'))
);

app.get('/visitantes', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/control-visitantes-sst/control-visitantes-sst.html'))
);

app.get('/permisos', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/control-permisos/control_permisos.html'))
);

app.get('/mantenimiento', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/mantenimiento/mantenimiento.html'))
);

app.get('/ubicaciones', (req, res) =>
  enviarPantalla(res, path.join(__dirname, 'modulos/ubicaciones/ubicaciones.html'))
);

// ── PUNTO SEGURO — SG-SST ────────────────────────────────────────────────────
// Punto Seguro guarda sus propios datos, pero los empleados de la empresa
// viven en Configuraciones (ia_state). En vez de duplicar esa lista, se le
// presta una función para buscar por cédula: así el trabajador entra con su
// número y el módulo ya sabe su nombre, su cargo y su módulo.
const psApi = require('./ps-api');
psApi.buscarEmpleadoPorCedula = (cedula) => {
  const limpia = s => String(s || '').replace(/\D/g, '');
  const buscada = limpia(cedula);
  if (!buscada) return null;
  const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
  const emp = (st.employees || []).find(e => e && !e.disabled && limpia(e.cedula) === buscada);
  if (!emp) return null;
  return {
    nombre:   emp.name || '',
    documento: String(emp.cedula || ''),
    cargo:    emp.cargo || '',
    area:     emp.modulo || emp.module || '',
    numeroContrato: emp.numeroContrato || ''
  };
};
// Punto Seguro: la sesion y el permiso del modulo se exigen AQUI; lo de administrador se decide dentro
// del router (ps-api.js / ps-autorizacion.js). Antes bastaba cualquier sesion para todo.
psApi.enlazar({
  secreto: SESSION_SECRET,
  esAdminApp: req => permisosDeLaPeticion(req.auth).admin,
  rateLimit, bloqueadoPorFallos, anotarFallo
});
app.use('/punto-seguro/api', requirePermiso('punto_seguro'), psApi);

// La carpeta vive dentro de modulos/, como el resto de pantallas. Antes se
// apuntaba a la raiz y Punto Seguro respondia "aun no construido" a todo el
// mundo, aunque estuviera perfectamente construido.
const PS_DIST = path.join(__dirname, 'modulos', 'punto-seguro', 'client', 'dist');
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

app.post('/api/visitantes/db', requirePermiso('visitantes_sst'), (req, res) => {
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
/* El logo de la pestaña del navegador. Es el mismo logo, pero de 64 px:
   el original pesa 100 KB y no tiene sentido bajarlo para un iconito. El
   navegador pide /favicon.ico por su cuenta aunque la página no lo diga, así
   que se responden los dos nombres. */
app.get(['/favicon.ico', '/favicon.png'], (req, res) => {
  const p = path.join(__dirname, 'compartido', 'favicon.png');
  if (!fs.existsSync(p)) return res.status(404).end();
  res.type('image/png');
  /* Sin 'immutable': si algun dia cambia el logo, el navegador lo vuelve a
     pedir al dia siguiente. Para forzarlo ya mismo se le cambia el ?v= a la
     direccion en las pantallas. */
  res.set('Cache-Control', 'public, max-age=86400');
  res.sendFile(p);
});

app.get('/logo.png', (req, res) => {
  // El archivo real se llama "logo.png.jpeg"; probamos varios nombres.
  const candidatos = ['logo.png', 'logo.png.jpeg', 'logo.jpeg', 'logo.jpg'];
  for (const nombre of candidatos) {
    const p = path.join(__dirname, 'compartido', nombre);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).end();
});

// ── El lector de Excel, servido desde aquí ─────────────────────────
// Antes cada pantalla lo bajaba de internet, y de tres sitios distintos con
// dos versiones. Si la planta se queda sin salida —ya pasó, cuando el
// firewall bloqueó la IP— se caían las 16 pantallas que exportan a Excel.
//
// El paquete ya es una dependencia del proyecto (xlsx en package.json), así
// que el despliegue lo instala solo con npm ci. No se copia al repositorio.
app.get('/xlsx.full.min.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'));
});

// Igual que xlsx.full.min.js: es una dependencia del proyecto (html2canvas en
// package.json), no un archivo copiado a mano. La usa Informes para el botón
// "copiar como imagen".
app.get('/html2canvas.min.js', (req, res) => {
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'node_modules', 'html2canvas', 'dist', 'html2canvas.min.js'));
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
app.post('/api/recogedores', requirePermiso('conteo_recogedores'), (req, res) => {
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
app.patch('/api/recogedores/:id', requirePermiso('conteo_recogedores'), (req, res) => {
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
app.delete('/api/recogedores/:id', requirePermiso('conteo_recogedores'), (req, res) => {
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

app.post('/api/corte-solicitudes', requirePermiso('corte'), (req, res) => {
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
      fecha: fechaHoyCO(),
      hora: new Date().toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', hour12: true }),
      ts: Date.now() // marca exacta para calcular el contador de tiempo en la tarjeta
    };
    data.unshift(sol);
    if (!writeJSON(FILES.corte_solicitudes, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    broadcast({ type: 'corte_new_request', solicitud: sol });
    res.json({ ok: true, solicitud: sol });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/corte-solicitudes/:id/entregar', requirePermiso('corte', 'almacen_insumos'), (req, res) => {
  try {
    const entregadoPor = (req.body && req.body.entregadoPor || '').trim();
    if (!entregadoPor) return res.status(400).json({ error: 'Falta indicar quién entrega' });
    const data = readJSON(FILES.corte_solicitudes, []);
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
    if (data[idx].estado !== 'pendiente') return res.status(400).json({ error: 'Esta solicitud ya fue procesada' });
    data[idx].estado = 'entregada';
    data[idx].entregadoPor = entregadoPor;
    data[idx].fechaEntrega = fechaHoyCO();
    data[idx].tsEntregada = Date.now();
    if (!writeJSON(FILES.corte_solicitudes, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    broadcast({ type: 'corte_update_request', solicitud: data[idx] });
    res.json({ ok: true, solicitud: data[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/corte-solicitudes/:id/aceptar', requirePermiso('corte', 'almacen_insumos'), (req, res) => {
  try {
    const data = readJSON(FILES.corte_solicitudes, []);
    const idx = data.findIndex(s => s.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrada' });
    if (data[idx].estado !== 'entregada') return res.status(400).json({ error: 'Aún no ha sido entregada' });
    data[idx].estado = 'aceptada';
    data[idx].fechaAceptada = fechaHoyCO();
    data[idx].tsAceptada = Date.now();
    if (!writeJSON(FILES.corte_solicitudes, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    broadcast({ type: 'corte_update_request', solicitud: data[idx] });
    res.json({ ok: true, solicitud: data[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Corte rechaza una entrega marcada por Telas (en realidad no le llegó el rollo):
// la solicitud vuelve a "pendiente" para que Telas la entregue de verdad.
app.post('/api/corte-solicitudes/:id/rechazar', requirePermiso('corte', 'almacen_insumos'), (req, res) => {
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

app.delete('/api/corte-solicitudes/:id', requirePermiso('corte'), (req, res) => {
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

// ── API ia-records (para validar operarias en el Contador de Producción) ──
// ── Importar la asistencia de un día desde Excel ───────────────────
// La pantalla ya podía registrar uno por uno (por WebSocket, un mensaje por
// persona). Para una lista de 80 empleados eso serían 80 guardados completos
// de un archivo que hoy pesa varios megas: lento y castigando el disco sin
// necesidad. Aquí entra la lista entera y se guarda UNA vez.
app.post('/api/ia-records/importar', requirePermiso('area_asistencia'), (req, res) => {
  try {
    const lista = (req.body || {}).registros;
    if (!Array.isArray(lista) || !lista.length) {
      return res.status(400).json({ error: 'No llegó ningún registro' });
    }
    if (lista.length > 5000) {
      return res.status(400).json({ error: 'Demasiados registros en un solo archivo' });
    }

    const ESTADOS = ['presente', 'falto', 'novedad'];
    const limpios = [];
    const rechazados = [];

    lista.forEach((r, i) => {
      const empName = String((r && r.empName) || '').trim();
      const date    = String((r && r.date)    || '').trim();
      const status  = String((r && r.status)  || '').trim().toLowerCase();
      if (!empName)                        return rechazados.push({ fila: i + 2, por: 'sin nombre' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return rechazados.push({ fila: i + 2, por: 'fecha inválida', empName });
      if (!ESTADOS.includes(status))       return rechazados.push({ fila: i + 2, por: 'estado inválido', empName });
      limpios.push({
        id:         uuidv4(),
        empName:    empName,
        area:       String((r.area || '')).trim() || '—',
        status:     status,
        date:       date,
        supervisor: String((r.supervisor || '')).trim()
      });
    });

    if (!limpios.length) {
      return res.status(400).json({ error: 'Ninguna fila era válida', rechazados });
    }

    // Una persona no puede tener dos asistencias el mismo día: lo que llega
    // reemplaza lo que hubiera. Así reimportar el archivo corregido arregla,
    // en vez de duplicar.
    const llaves = new Set(limpios.map(r => r.empName + '|' + r.date));
    const antes  = iaRecords.length;
    iaRecords = iaRecords.filter(r => !llaves.has(String(r.empName) + '|' + String(r.date)));
    const reemplazados = antes - iaRecords.length;
    iaRecords = iaRecords.concat(limpios);

    if (!saveIaRecords()) {
      return res.status(500).json({ error: 'No se pudo guardar la asistencia' });
    }
    broadcast({ type: 'ia_import', cuantos: limpios.length });

    res.json({
      ok: true,
      importados:   limpios.length,
      reemplazados: reemplazados,
      rechazados:   rechazados
    });
  } catch (e) {
    console.error('Error [POST ia-records/importar]:', e.message);
    res.status(500).json({ error: e.message, donde: 'POST ia-records/importar' });
  }
});

app.get('/api/ia-records', (req, res) => {
  res.json(iaRecords || []);
});

// ── API Órdenes de Producción ─────────────────────────────────────
app.get('/api/ordenes', (req, res) => {
  res.json(loadDB('ordenes') || []);
});
app.get('/api/ordenes/:opoc', (req, res) => {
  const op = String(req.params.opoc || '').trim();
  const orden = (loadDB('ordenes') || []).find(o => String(o.opoc || '').trim() === op);
  if (!orden) return res.status(404).json({ error: 'No existe esa OP' });
  res.json({ ok: true, orden });
});
// El número de orden lo pone el servidor: si lo pusiera cada pantalla con su
// lista vieja, dos podrían crear la misma "365" y una pisaría a la otra.
function siguienteNumOrden(lista) {
  return lista.reduce((m, o) => Math.max(m, Number(o.numOrden) || 0), 0) + 1;
}

/* Una orden que llega nueva pero ya existe (misma OP y misma referencia) no se
   duplica: se le suma la cantidad (y las tallas, y los módulos que traiga).
   Misma OP con otra referencia es un dato mal escrito y no se acepta. */
const opDe  = o => String((o && o.opoc) || '').trim();
const refDe = o => String((o && o.referencia) || '').trim().toUpperCase();
function ordenExistente(lista, nueva) {
  const op = opDe(nueva);
  if (!op) return null;
  const misma = lista.find(o => opDe(o) === op);
  if (!misma) return null;
  return refDe(misma) === refDe(nueva) ? { orden: misma } : { otraRef: refDe(misma) };
}
function sumarOrden(dest, nueva) {
  dest.cantidad = (Number(dest.cantidad) || 0) + (Number(nueva.cantidad) || 0);
  const tallasA = Array.isArray(dest.tallas) ? dest.tallas : [];
  const tallasB = Array.isArray(nueva.tallas) ? nueva.tallas : [];
  if (tallasA.length && tallasB.length) {
    const suma = tallasA.map(t => ({ ...t }));
    tallasB.forEach(t => {
      const ya = suma.find(x => String(x.talla || '').trim().toUpperCase() === String(t.talla || '').trim().toUpperCase());
      if (ya) ya.cantidad = (Number(ya.cantidad) || 0) + (Number(t.cantidad) || 0);
      else suma.push({ ...t });
    });
    dest.tallas = suma;
  }
  const mods = Array.isArray(dest.modulos) ? dest.modulos.slice() : [];
  (Array.isArray(nueva.modulos) ? nueva.modulos : []).forEach(m => {
    if (m && m.modulo && !mods.some(x => x.modulo === m.modulo)) mods.push({ modulo: m.modulo });
  });
  if (mods.length) dest.modulos = mods;
}

// Crear o actualizar UNA orden. Sin numOrden es nueva.
app.post('/api/ordenes/una', requireAccion('crear', 'ordenes_produccion'), (req, res) => {
  try {
    const { sumarSiExiste, ...orden } = req.body || {};
    if (!orden.opoc && !orden.referencia) return res.status(400).json({ error: 'Falta la referencia o la OP' });
    const lista = loadDB('ordenes') || [];
    const num   = Number(orden.numOrden) || 0;
    if (num > 0) {
      const i = lista.findIndex(o => Number(o.numOrden) === num);
      if (i >= 0) lista[i] = { ...orden, numOrden: num };
      else        lista.push({ ...orden, numOrden: num });
    } else {
      // Nueva: si ya existe, se pregunta en pantalla y, si confirma, se suma.
      // Se responde 200 con ok:false para que la pantalla lea el motivo.
      const ya = ordenExistente(lista, orden);
      if (ya && ya.otraRef) {
        return res.json({ ok: false, error: `La OP ${opDe(orden)} ya existe con la referencia ${ya.otraRef}, no con ${refDe(orden)}` });
      }
      if (ya && !sumarSiExiste) {
        return res.json({ ok: false, existe: { numOrden: ya.orden.numOrden, opoc: opDe(ya.orden), referencia: refDe(ya.orden), cantidad: Number(ya.orden.cantidad) || 0 } });
      }
      if (ya) {
        const antes = Number(ya.orden.cantidad) || 0;
        sumarOrden(ya.orden, orden);
        if (!saveDB('ordenes', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
        return res.json({ ok: true, sumada: { opoc: opDe(ya.orden), antes, despues: ya.orden.cantidad }, ordenes: lista });
      }
      lista.push({ ...orden, numOrden: siguienteNumOrden(lista) });
    }
    if (!saveDB('ordenes', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, ordenes: lista });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Borrar una o varias, por su número.
app.post('/api/ordenes/borrar', requireAccion('borrar', 'ordenes_produccion'), (req, res) => {
  try {
    const nums = (Array.isArray(req.body && req.body.numOrden) ? req.body.numOrden : [req.body && req.body.numOrden])
                 .map(Number).filter(n => n > 0);
    if (!nums.length) return res.status(400).json({ error: 'No se dijo cuál orden borrar' });
    const lista = (loadDB('ordenes') || []).filter(o => !nums.includes(Number(o.numOrden)));
    if (!saveDB('ordenes', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, ordenes: lista, borradas: nums.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Agregar varias de una (la importación por Excel).
app.post('/api/ordenes/agregar', requireAccion('crear', 'ordenes_produccion'), (req, res) => {
  try {
    const nuevas = Array.isArray(req.body) ? req.body : (req.body && req.body.ordenes);
    if (!Array.isArray(nuevas) || !nuevas.length) return res.status(400).json({ error: 'No llegó ninguna orden' });
    const lista = loadDB('ordenes') || [];
    // Las que ya existen (misma OP y referencia) se suman; la pantalla ya lo
    // confirmó antes de mandar. Misma OP con otra referencia no se carga.
    const sumadas = [], rechazadas = [];
    let agregadas = 0;
    nuevas.forEach(o => {
      const ya = ordenExistente(lista, o);
      if (ya && ya.otraRef) { rechazadas.push({ opoc: opDe(o), referencia: refDe(o), existeCon: ya.otraRef }); return; }
      if (ya) {
        const antes = Number(ya.orden.cantidad) || 0;
        sumarOrden(ya.orden, o);
        sumadas.push({ opoc: opDe(o), referencia: refDe(o), antes, despues: ya.orden.cantidad });
        return;
      }
      lista.push({ ...o, numOrden: siguienteNumOrden(lista) });
      agregadas++;
    });
    if (!saveDB('ordenes', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, ordenes: lista, agregadas, sumadas, rechazadas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ordenes', requireAccion('editar', 'ordenes_produccion'), (req, res) => {
  const data = req.body;
  if (!Array.isArray(data)) return res.status(400).json({ error: 'Se esperaba un array' });

  /* Red de seguridad para cualquier pantalla vieja que siga mandando la lista
     entera: si trae MENOS órdenes de las guardadas, es que venía
     desactualizada y se la va a llevar por delante. Se rechaza y se avisa.
     Para reemplazar todo a propósito hay que pedirlo: ?reemplazarTodo=1 */
  const actuales = loadDB('ordenes') || [];
  const perdidas = actuales.length - data.length;
  if (perdidas > 0 && req.query.reemplazarTodo !== '1') {
    console.warn('[ORDENES] Se rechazó un guardado que dejaba ' + perdidas + ' órdenes por fuera.');
    return res.status(409).json({
      error: 'Tu pantalla tiene una lista desactualizada: guardar así borraría ' + perdidas +
             ' orden(es) que otra persona subió. Recarga la página y vuelve a intentarlo.',
      guardadas: actuales.length, enviadas: data.length
    });
  }

  if (!saveDB('ordenes', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
  res.json({ ok: true });
});

// ── API Revisión de Telas ────────────────────────────────────────
app.get('/api/revision-telas', (req, res) => {
  try {
    res.json(loadDB('revision_telas') || { registros:[], defectos:[], referencias:[], colores:[], turnosRT:{} });
  } catch(e) {
    console.error('Error no capturado [GET revision-telas]:', (e && e.stack) || e);
    res.status(500).json({ error: String((e && e.message) || e), donde: 'GET revision-telas' });
  }
});

app.post('/api/revision-telas', requirePermiso('revision_telas'), (req, res) => {
  try {
    const { registros, defectos, referencias, colores } = req.body || {};
    if(!Array.isArray(registros)) return res.status(400).json({ error: 'Payload inválido' });
    const proveedores        = req.body.proveedores        || [];
    const proveedoresTerceros= req.body.proveedoresTerceros|| [];
    const tareas             = req.body.tareas             || [];
    const igJustificaciones  = req.body.igJustificaciones  || {};
    const turnosRT           = req.body.turnosRT           || {};
    const deletedIds         = Array.isArray(req.body.deletedIds) ? req.body.deletedIds : [];
    const configFields = Array.isArray(req.body.rtConfigFields) ? new Set(req.body.rtConfigFields) : null;

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
    const mergedConfigArray = (key, incoming) => {
      if (configFields) return configFields.has(key) && Array.isArray(incoming) ? incoming : (Array.isArray(prev[key]) ? prev[key] : []);
      return incoming && incoming.length ? incoming : (Array.isArray(prev[key]) ? prev[key] : []);
    };
    const mergedDefectos = mergedConfigArray('defectos', defectos);
    const mergedColores = mergedConfigArray('colores', colores);
    const mergedProveedores = mergedConfigArray('proveedores', proveedores);
    const mergedProvTerceros = mergedConfigArray('proveedoresTerceros', proveedoresTerceros);
    const mergedTareas = mergedConfigArray('tareas', tareas);
    // Justificaciones de baches (Informe Gerencial): unión simple por clave —
    // nunca se reemplaza todo el objeto, solo se agregan/actualizan las claves enviadas.
    const mergedIgJustificaciones = { ...(prev.igJustificaciones && typeof prev.igJustificaciones==='object' ? prev.igJustificaciones : {}), ...igJustificaciones };
    if (Array.isArray(req.body.igJustificacionesDeleted)) req.body.igJustificacionesDeleted.forEach(k => delete mergedIgJustificaciones[String(k)]);
    // Turnos propios de Telas (Día/Noche versionados por fecha) — unión simple por
    // clave ('dia'/'noche'), nunca se reemplaza todo el objeto de una sola vez.
    const mergedTurnosRT = { ...(prev.turnosRT && typeof prev.turnosRT==='object' ? prev.turnosRT : {}), ...turnosRT };

    const data = {
      registros: mergedRegistros,
      defectos:  mergedDefectos,
      referencias: mergedReferencias,
      colores:   mergedColores,
      proveedores: mergedProveedores,
      proveedoresTerceros: mergedProvTerceros,
      igJustificaciones: mergedIgJustificaciones,
      tareas:    mergedTareas,
      turnosRT:  mergedTurnosRT,
      // Los cierres de turno son del servidor: la pantalla no los manda, solo los recibe.
      cierres:   Array.isArray(prev.cierres) ? prev.cierres : []
    };

    if (!saveDB('revision_telas', data)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true });
    if (req.body.rtBatchFinal !== false) setTimeout(()=>{
      try {
        broadcast({ type: 'rt_update', ...data });
      } catch(eb) { console.error('Error no capturado [broadcast rt_update]:', (eb && eb.stack) || eb); }
    }, 800);
  } catch(e) {
    console.error('Error no capturado [POST revision-telas]:', (e && e.stack) || e);
    if(!res.headersSent) res.status(500).json({ error: String((e && e.message) || e), donde: 'POST revision-telas' });
  }
});


/* ═══════════════════════════════════════════════════════════════════
   CIERRE DE TURNO — Revisión de Telas
   ═══════════════════════════════════════════════════════════════════
   Solo existen dos turnos: TURNO PLANTA (día) y TURNO NOCHE EMPAQUE (noche), los del
   catálogo de Configuraciones → Turnos. Cada revisador CIERRA su turno (con el botón
   "Cerrar sesión", o solo cuando termina la última hora del turno). El tiempo del día
   se mide desde la hora de inicio del turno hasta esa hora de cierre.

   Al cerrar:
    · la hora de cierre baja al cuarto de hora (14:12 → 14:00);
    · lo que haya quedado abierto (rollos y multitareas) se cierra ahí mismo;
    · los descansos que no reportó se agregan solos (día: desayuno 15, almuerzo 20 (solo si
      cierra después de las 12:30 p. m.) y, si trabajó horas extra, cena 15; noche: descanso 60). Se acomodan en los huecos
      de tiempo sin reporte, nunca encima de lo que sí reportó: el día no puede pasar
      de los minutos reales del turno.

   Todo esto vive AQUÍ y no en la pantalla, para que el cierre manual y el automático
   sean exactamente la misma cuenta. */
const RT_TURNO_CATALOGO = { dia: 'TURNO PLANTA', noche: 'TURNO NOCHE EMPAQUE' };
const RT_DESCANSOS = {
  // El almuerzo solo aplica a quien trabaja después de las 12:30 p. m. (despuesDe, en minutos desde medianoche)
  dia:   [ { tarea: 'ALMUERZO', min: 20, despuesDe: 12 * 60 + 30 }, { tarea: 'DESAYUNO', min: 15 }, { tarea: 'CENA', min: 15, soloExtra: true } ],
  noche: [ { tarea: 'DESCANSO NOCHE', min: 60 } ]
};
const RT_DIA_ABR = ['DO', 'LN', 'MR', 'XR', 'JU', 'VI', 'SB'];
const rtSumarDiasISO = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// Reloj de Colombia (UTC-5, sin horario de verano), expresado como "hora de pared".
const rtAhoraCOms = () => Date.now() - 5 * 3600000;
const rtFechaCO = () => new Date(rtAhoraCOms()).toISOString().slice(0, 10);

// "6:08 PM", "06:30 p. m." o "14:30" → minutos desde medianoche.
function rtHoraAMin(v) {
  if (v == null || v === '') return null;
  const t = String(v).replace(/[\u00a0\u202f]/g, ' ').replace(/\b([ap])\.?\s?m\.?/gi, (x, l) => l.toUpperCase() + 'M');
  const m = t.match(/^\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const mn = parseInt(m[2], 10), ap = m[3] ? m[3].toUpperCase() : null;
  if (ap === 'PM' && h !== 12) h += 12;
  if (ap === 'AM' && h === 12) h = 0;
  return (h * 60 + mn) % 1440;
}
const rtMinAHora12 = min => {
  min = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(min / 60), m = min % 60;
  return ((h % 12) || 12) + ':' + String(m).padStart(2, '0') + ' ' + (h >= 12 ? 'PM' : 'AM');
};
const rtMinAHora24 = min => {
  min = ((min % 1440) + 1440) % 1440;
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
};
const rtTiempoTexto = min => min >= 60 ? Math.floor(min / 60) + 'h ' + (min % 60) + 'min' : min + 'min';

/* La ventana del turno para un día, sacada del catálogo: dónde empieza, cuándo termina
   la jornada normal y cuándo la última hora extra (todo en minutos desde el inicio). */
function rtVentanaSrv(turno, fechaTurno) {
  const nombre = RT_TURNO_CATALOGO[turno];
  if (!nombre) return null;
  const t = (turnosLegibles(readJSON(FILES.turnos, [])) || [])
    .find(x => x && !x.disabled && String(x.nombre || '').trim().toUpperCase() === nombre);
  if (!t) return null;
  // El día de la semana es el de cuando EMPIEZA el turno (el de noche empieza el día anterior).
  const inicioFecha = turno === 'noche' ? rtSumarDiasISO(fechaTurno, -1) : fechaTurno;
  const abr = RT_DIA_ABR[new Date(inicioFecha + 'T12:00:00Z').getUTCDay()];
  // Si ese día de la semana no tiene horario (ej. un domingo), se usa el de lunes.
  const horasDe = a => (t.horas || []).filter(h => h && !h.disabled && (h.dias || []).some(d => d === a || (a === 'DO' && d === 'DG')));
  let horas = horasDe(abr);
  if (!horas.some(h => h.iniciaTurno)) horas = horasDe('LN');
  const ini = horas.find(h => h.iniciaTurno);
  const inicioMin = ini ? rtHoraAMin(ini.comienza) : null;
  if (inicioMin == null) return null;
  const el = m => (m - inicioMin + 1440) % 1440 || 1440;
  let normalMin = 0, totalMin = 0;
  horas.forEach(h => {
    const fin = rtHoraAMin(h.termina);
    if (fin == null) return;
    const e = el(fin);
    if (h.tipo === 'NORMAL' && h.finalizaTurno) normalMin = Math.max(normalMin, e);
    totalMin = Math.max(totalMin, e);
  });
  if (!normalMin) return null;
  return { inicioMin, normalMin, totalMin: Math.max(totalMin, normalMin), inicioFecha };
}

/* Cierra UN turno de UN revisador. modo: 'manual' (ahora, bajado al cuarto de hora) o
   'automatico' (terminó la última hora del turno). Con simular=true calcula todo y no toca nada. */
function rtCerrarTurnoDe(data, revisador, fechaTurno, turno, modo, simular, forzarMin) {
  const win = rtVentanaSrv(turno, fechaTurno);
  if (!win) return { error: 'No encuentro el horario de ' + RT_TURNO_CATALOGO[turno] + ' en Configuraciones → Turnos.' };
  const regs = data.registros;
  const idx = [];
  regs.forEach((r, i) => { if (r && r.revisador === revisador && r.fechaTurno === fechaTurno && r.turno === turno) idx.push(i); });
  if (!idx.length) return { error: 'No hay registros de ese turno.' };

  const elDe = h => { const m = rtHoraAMin(h); return m == null ? null : (m - win.inicioMin + 1440) % 1440; };
  let tope = 0;                       // lo más tarde que llegó algo ya reportado o abierto
  const abiertas = [];
  idx.forEach(i => {
    const r = regs[i];
    if (r.finalizado) {
      const b = elDe(r.hora_fin); if (b != null) tope = Math.max(tope, b);
    } else {
      abiertas.push(i);
      const a = elDe(r.hora_inicio); if (a != null) tope = Math.max(tope, a);
    }
  });

  // Hora de cierre (minutos desde el inicio del turno)
  const ahoraEl = Math.floor((rtAhoraCOms() - (Date.UTC(+win.inicioFecha.slice(0, 4), +win.inicioFecha.slice(5, 7) - 1, +win.inicioFecha.slice(8, 10)) + win.inicioMin * 60000)) / 60000);
  let cierreEl;
  if (forzarMin != null) cierreEl = forzarMin;
  else if (modo === 'manual') cierreEl = Math.floor(ahoraEl / 15) * 15;                              // baja al cuarto
  else cierreEl = Math.ceil(Math.max(win.normalMin, tope) / 15) * 15;                                // sin cierre: la jornada normal o hasta lo último que hizo
  cierreEl = Math.max(cierreEl, Math.ceil(tope / 15) * 15);                                           // nunca antes de lo que ya reportó
  cierreEl = Math.min(cierreEl, win.totalMin);

  const copia = {};                    // índice → registro ya cerrado
  const intervalos = [];               // [inicio, fin] de todo lo reportado, ya con lo abierto cerrado
  let revisionMin = 0, multiMin = 0;
  idx.forEach(i => {
    let r = regs[i];
    if (!r.finalizado) {
      const a = elDe(r.hora_inicio);
      const fin = (a != null && a <= cierreEl) ? cierreEl : (a != null ? a : cierreEl);
      const horaFin = rtMinAHora12(win.inicioMin + fin);
      r = { ...r, finalizado: true, hora_fin: horaFin,
            tiempo: rtTiempoTexto(Math.max(0, fin - (a == null ? fin : a))),
            observaciones: (r.observaciones ? r.observaciones + ' — ' : '') + 'Cerrado automáticamente al cerrar el turno.',
            cierreAutomatico: true };
      copia[i] = r;
    }
    const a = elDe(r.hora_inicio), b = elDe(r.hora_fin);
    if (a == null || b == null || b < a) return;
    intervalos.push([a, b]);
    if (r.tipo === 'multitarea') multiMin += b - a; else revisionMin += b - a;
  });

  // Los descansos que faltan
  const reportados = new Set(idx.map(i => regs[i]).filter(r => r.tipo === 'multitarea').map(r => String(r.tarea || '').trim().toUpperCase()));
  const faltan = (RT_DESCANSOS[turno] || []).filter(d => (!d.soloExtra || cierreEl > win.normalMin) && (d.despuesDe == null || win.inicioMin + cierreEl > d.despuesDe) && !reportados.has(d.tarea));
  // Huecos: lo que queda libre entre 0 y la hora de cierre
  const ordenados = intervalos.slice().sort((x, y) => x[0] - y[0]);
  let huecos = [], cursor = 0;
  ordenados.forEach(([a, b]) => { if (a > cursor) huecos.push([cursor, Math.min(a, cierreEl)]); cursor = Math.max(cursor, b); });
  if (cursor < cierreEl) huecos.push([cursor, cierreEl]);
  huecos = huecos.filter(h => h[1] > h[0]);

  const nuevos = [], descansos = [];
  faltan.forEach(d => {
    // el último hueco donde cabe entero; si ninguno, el más grande (con lo que alcance)
    let elegido = null;
    for (let k = huecos.length - 1; k >= 0; k--) { if (huecos[k][1] - huecos[k][0] >= d.min) { elegido = k; break; } }
    if (elegido == null) { let mayor = 0; huecos.forEach((h, k) => { if (h[1] - h[0] > mayor) { mayor = h[1] - h[0]; elegido = k; } }); }
    if (elegido == null) return;
    const h = huecos[elegido];
    const dur = Math.min(d.min, h[1] - h[0]);
    if (dur <= 0) return;
    const fin = h[1], ini = fin - dur;
    h[1] = ini;                                    // ese pedazo ya no está libre
    huecos = huecos.filter(x => x[1] > x[0]);
    const reloj = win.inicioMin + ini;
    const fechaReloj = new Date(Date.UTC(+win.inicioFecha.slice(0, 4), +win.inicioFecha.slice(5, 7) - 1, +win.inicioFecha.slice(8, 10)) + (win.inicioMin + ini) * 60000).toISOString().slice(0, 10);
    nuevos.push({
      id: 'rt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), tipo: 'multitarea', fecha: fechaReloj, revisador,
      tarea: d.tarea, factura: '', lote: '', proveedor: '', referencia: d.tarea, rollo: '', ancho: '', peso: '', mts: '', metros: '',
      color: '', lote_prov: '', hora_inicio: rtMinAHora12(reloj), hora_fin: rtMinAHora12(reloj + dur), tiempo: rtTiempoTexto(dur),
      defectos: [], resultado: 'Completado', observaciones: 'Descanso agregado automáticamente al cerrar el turno.',
      finalizado: true, turno, fechaTurno, cierreAutomatico: true, descansoAutomatico: true
    });
    descansos.push({ tarea: d.tarea, minutos: dur });
    multiMin += dur;
  });

  const reportadoMin = revisionMin + multiMin;
  const resumen = {
    horaCierre: rtMinAHora12(win.inicioMin + cierreEl), minutosTurno: cierreEl,
    reportadoMin, revisionMin, multitareaMin: multiMin, tiempoMuertoMin: Math.max(0, cierreEl - reportadoMin),
    eficiencia: cierreEl ? Math.round(reportadoMin / cierreEl * 100) : 0,
    productividad: cierreEl ? Math.round(revisionMin / cierreEl * 100) : 0,
    descansos, abiertas: abiertas.length, horaInicio: rtMinAHora12(win.inicioMin)
  };
  if (simular) return { ok: true, resumen };

  const cierre = {
    id: 'cierre_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), revisador, fechaTurno, turno,
    minutos: cierreEl, hora: rtMinAHora24(win.inicioMin + cierreEl), tipo: modo, descansos,
    abiertasCerradas: abiertas.length, creadoEn: new Date().toISOString()
  };
  const modificados = Object.keys(copia).map(i => { regs[i] = copia[i]; return copia[i]; });
  nuevos.forEach(n => regs.push(n));
  data.cierres = (Array.isArray(data.cierres) ? data.cierres : [])
    .filter(c => !(c.revisador === revisador && c.fechaTurno === fechaTurno && c.turno === turno));
  data.cierres.push(cierre);
  return { ok: true, resumen, cierre, modificados, nuevos };
}

// Los turnos de este revisador que todavía no se han cerrado, del más viejo al más nuevo.
function rtTurnosSinCierre(data, revisador) {
  const hechos = new Set((Array.isArray(data.cierres) ? data.cierres : []).map(c => c.revisador + '|' + c.fechaTurno + '|' + c.turno));
  const grupos = new Map();
  (Array.isArray(data.registros) ? data.registros : []).forEach(r => {
    if (!r || r.revisador !== revisador || !r.fechaTurno || (r.turno !== 'dia' && r.turno !== 'noche')) return;
    const k = r.revisador + '|' + r.fechaTurno + '|' + r.turno;
    if (hechos.has(k) || grupos.has(k)) return;
    grupos.set(k, { revisador: r.revisador, fechaTurno: r.fechaTurno, turno: r.turno });
  });
  return [...grupos.values()].sort((a, b) => a.fechaTurno.localeCompare(b.fechaTurno) || (a.turno === 'dia' ? -1 : 1));
}

app.post('/api/revision-telas/cerrar-turno', requirePermiso('revision_telas'), (req, res) => {
  try {
    const revisador = String((req.body && req.body.revisador) || '').trim();
    const simular = !!(req.body && req.body.simular);
    if (!revisador) return res.status(400).json({ error: 'Falta el revisador.' });
    const data = loadDB('revision_telas') || {};
    if (!Array.isArray(data.registros)) return res.json({ ok: true, nada: true });
    const pendientes = rtTurnosSinCierre(data, revisador);
    if (!pendientes.length) return res.json({ ok: true, nada: true });
    const actual = pendientes[pendientes.length - 1];
    let modificados = [], nuevos = [], cierres = [], resumen = null;
    // Los turnos viejos que quedaron sin cerrar se cierran solos; el de ahora, como corresponde.
    for (const g of pendientes) {
      const esActual = g === actual;
      const r = rtCerrarTurnoDe(data, g.revisador, g.fechaTurno, g.turno, esActual ? 'manual' : 'automatico', simular);
      if (r.error) { if (esActual) return res.status(409).json({ error: r.error }); continue; }
      if (esActual) resumen = r.resumen;
      if (!simular) { modificados = modificados.concat(r.modificados); nuevos = nuevos.concat(r.nuevos); cierres.push(r.cierre); }
    }
    if (simular) return res.json({ ok: true, resumen, turno: actual.turno, fechaTurno: actual.fechaTurno });
    if (!saveDB('revision_telas', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    console.log('[REVISION-TELAS] ' + revisador + ' cerró su turno (' + actual.turno + ' ' + actual.fechaTurno + ') a las ' + resumen.horaCierre + '; ' + resumen.abiertas + ' abierta(s), ' + resumen.descansos.length + ' descanso(s) agregado(s)');
    res.json({ ok: true, resumen, modificados, nuevos, cierres });
    setTimeout(() => { try { broadcast({ type: 'rt_update', ...data }); } catch (e) { console.error('[REVISION-TELAS] broadcast:', e.message); } }, 300);
  } catch (e) {
    console.error('Error no capturado [cerrar-turno]:', (e && e.stack) || e);
    if (!res.headersSent) res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Un administrador corrige la hora de un cierre (por ejemplo, se fue y olvidó cerrar).
app.put('/api/revision-telas/cierres/:id', requirePermiso('revision_telas'), (req, res) => {
  try {
    const data = loadDB('revision_telas') || {};
    const cierres = Array.isArray(data.cierres) ? data.cierres : [];
    const c = cierres.find(x => x.id === req.params.id);
    if (!c) return res.status(404).json({ error: 'Ese cierre ya no existe.' });
    const win = rtVentanaSrv(c.turno, c.fechaTurno);
    const hm = rtHoraAMin(req.body && req.body.hora);
    if (!win || hm == null) return res.status(400).json({ error: 'Escribe una hora válida.' });
    const el = (hm - win.inicioMin + 1440) % 1440;
    if (el <= 0 || el > win.totalMin) return res.status(400).json({ error: 'Esa hora está fuera del turno (' + rtMinAHora12(win.inicioMin) + ' a ' + rtMinAHora12(win.inicioMin + win.totalMin) + ').' });
    c.minutos = el;
    c.hora = rtMinAHora24(hm);
    c.editadoEn = new Date().toISOString();
    c.editadoPor = (req.auth && req.auth.user) || '';
    if (!saveDB('revision_telas', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    console.warn('[REVISION-TELAS] ' + c.editadoPor + ' corrigió el cierre de ' + c.revisador + ' (' + c.fechaTurno + ' ' + c.turno + ') a ' + c.hora);
    res.json({ ok: true, cierre: c });
    setTimeout(() => { try { broadcast({ type: 'rt_update', ...data }); } catch (e) {} }, 300);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Cierre automático: cada 5 minutos se revisa si a alguien se le acabó el turno (la
   última hora extra) sin cerrarlo; se cierra solo, como si hubiera dado el botón. Solo mira
   ayer y hoy: lo anterior ya quedó como estaba. Si el servidor se reinicia, no se pierde nada
   (se revisa de nuevo al arrancar). */
function rtRevisarCierresAutomaticos() {
  try {
    const data = loadDB('revision_telas');
    if (!data || !Array.isArray(data.registros)) return;
    const desde = rtSumarDiasISO(rtFechaCO(), -1);
    const hechos = new Set((Array.isArray(data.cierres) ? data.cierres : []).map(c => c.revisador + '|' + c.fechaTurno + '|' + c.turno));
    const grupos = new Map();
    data.registros.forEach(r => {
      if (!r || !r.revisador || !r.fechaTurno || r.fechaTurno < desde || (r.turno !== 'dia' && r.turno !== 'noche')) return;
      const k = r.revisador + '|' + r.fechaTurno + '|' + r.turno;
      if (!hechos.has(k) && !grupos.has(k)) grupos.set(k, { revisador: r.revisador, fechaTurno: r.fechaTurno, turno: r.turno });
    });
    let cambios = 0;
    grupos.forEach(g => {
      const win = rtVentanaSrv(g.turno, g.fechaTurno);
      if (!win) return;
      const inicioMs = Date.UTC(+win.inicioFecha.slice(0, 4), +win.inicioFecha.slice(5, 7) - 1, +win.inicioFecha.slice(8, 10)) + win.inicioMin * 60000;
      if (rtAhoraCOms() < inicioMs + win.totalMin * 60000) return;          // todavía está dentro del turno
      const r = rtCerrarTurnoDe(data, g.revisador, g.fechaTurno, g.turno, 'automatico', false);
      if (r.error) return;
      cambios++;
      console.log('[REVISION-TELAS] Cierre automático de ' + g.revisador + ' (' + g.turno + ' ' + g.fechaTurno + ') a las ' + r.resumen.horaCierre);
    });
    if (cambios && saveDB('revision_telas', data)) broadcast({ type: 'rt_update', ...data });
  } catch (e) { console.error('[REVISION-TELAS] Error en el cierre automático:', e.message); }
}
setInterval(rtRevisarCierresAutomaticos, 5 * 60 * 1000).unref();
setTimeout(rtRevisarCierresAutomaticos, 30 * 1000).unref();

// ── API Recepción de telas (bodega de rollos) ────────────────────
/* Todo lo de la bodega vive en el servidor: así todos ven los mismos rollos.
   La pantalla no manda el estado entero cada vez: manda solo lo que cambió
   (rollos, órdenes, proveedores, salidas, movimientos) y los borrados
   explícitos. El servidor lo mezcla por código/id sobre lo que ya hay, así dos
   personas trabajando a la vez no se pisan, salvo sobre el MISMO rollo.
   Los consecutivos (R000001, OR-0001, SAL-0001) los entrega el servidor
   ("reservar") para que nunca se repitan entre dos computadores. */
const BT_PROCESOS = ['Tintorería', 'Lavandería', 'Corte', 'Estampación', 'Sublimación', 'Bordados'];
const BT_PERMISO  = 'bodega_telas';
const btVacio = () => ({ seq: { roll: 0, salida: 0, order: 0 }, orders: [], rolls: {}, providers: [],
                         procesos: BT_PROCESOS.slice(), salidas: [], rend: { manual: {} }, facLog: [] });
const esObj = x => x && typeof x === 'object' && !Array.isArray(x);
const btClon = x => JSON.parse(JSON.stringify(x));
function btCargar() {
  const d = loadDB('bodega_telas');
  const b = btVacio();
  if (!esObj(d)) return b;
  const e = Object.assign(b, btClon(d));
  e.seq = Object.assign({ roll: 0, salida: 0, order: 0 }, e.seq || {});
  e.rend = Object.assign({ manual: {} }, e.rend || {});
  /* Version de cada rollo (rev). La pone SOLO el servidor, cada vez que acepta
     un cambio en ese rollo. Sirve para que un guardado hecho con una copia vieja
     no pise lo que otra persona hizo despues: la pantalla manda la version que
     vio, y si ya no es la actual, el cambio se rechaza.
     Los rollos que se guardaron antes de existir esto no la traen: se les da 1,
     para que "rollo que el servidor ya tiene" y "rollo nuevo que la pantalla
     acaba de crear" (que llega sin version) nunca se confundan. */
  Object.keys(e.rolls || {}).forEach(c => {
    const r = e.rolls[c];
    if (esObj(r) && !(Number(r.rev) >= 1)) r.rev = 1;
  });
  return e;
}
function btHistorial() {
  const h = loadDB('bodega_telas_historial');
  return Array.isArray(h) ? h : [];
}
const btGuardarEstado = est => saveDB('bodega_telas', est);

app.get('/api/bodega-telas', requirePermiso(BT_PERMISO), (req, res) => {
  try {
    res.json(Object.assign(btCargar(), { moves: btHistorial() }));
  } catch (e) {
    console.error('Error no capturado [GET bodega-telas]:', (e && e.stack) || e);
    res.status(500).json({ error: String((e && e.message) || e), donde: 'GET bodega-telas' });
  }
});

// Entrega un bloque de consecutivos: { roll:n, order:n, salida:n } → los "últimos usados".
// La pantalla sigue desde ahí (++), y nadie más recibe esos números.
app.post('/api/bodega-telas/reservar', requirePermiso(BT_PERMISO), (req, res) => {
  try {
    const est = btCargar();
    const b = req.body || {};
    const antes = {};
    ['roll', 'order', 'salida'].forEach(k => {
      const n = Math.max(0, Math.min(100000, parseInt(b[k], 10) || 0));
      antes[k] = Number(est.seq[k]) || 0;
      est.seq[k] = antes[k] + n;
    });
    if (!btGuardarEstado(est)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, antes });
  } catch (e) {
    console.error('Error no capturado [POST bodega-telas/reservar]:', (e && e.stack) || e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

app.post('/api/bodega-telas/guardar', requirePermiso(BT_PERMISO), (req, res) => {
  try {
    const b = req.body || {};
    const cam = esObj(b.cambios) ? b.cambios : {};
    const bor = esObj(b.borrados) ? b.borrados : {};
    const lista = x => (Array.isArray(x) ? x : []);
    const est = btCargar();

    /* ── Version por rollo ──────────────────────────────────────────────
       Cada pantalla manda la version del rollo que ella vio. Si el servidor ya
       tiene otra, es que alguien lo cambio entre medias: se rechaza TODO el
       guardado, sin escribir nada. Antes ganaba el que guardaba ultimo y, con
       una pantalla de hace unos segundos, un rollo que otra persona acababa de
       sacar a proceso volvia a "En bodega" sin que nadie lo notara.
       Se rechaza todo y no solo ese rollo porque un guardado es una operacion
       (mover tres rollos, cerrar una orden): aceptarla a medias dejaria la
       bodega a medio camino.
       Toda la comprobacion va antes del primer cambio, asi nada queda a medias. */
    const revDe = r => (esObj(r) ? Number(r.rev) || 0 : 0);
    const conflictos = [];
    if (esObj(cam.rolls)) {
      Object.keys(cam.rolls).forEach(c => {
        const nuevo = cam.rolls[c];
        if (!esObj(nuevo) || String(nuevo.code) !== c) return;
        const actual = est.rolls[c];
        // Un rollo nuevo llega sin version y no existe; uno ya guardado llega con la que vio.
        if (revDe(nuevo) !== revDe(actual)) conflictos.push(c);
      });
    }
    const revsBorrados = esObj(bor.rollRevs) ? bor.rollRevs : {};
    lista(bor.rolls).map(String).forEach(c => {
      // Si ya no esta, alguien lo borro antes: no hay nada que pisar.
      if (est.rolls[c] && revDe(est.rolls[c]) !== (Number(revsBorrados[c]) || 0)) conflictos.push(c);
    });
    if (conflictos.length) {
      const codigos = [...new Set(conflictos)];
      console.warn('[BODEGA-TELAS] ' + ((req.auth && req.auth.user) || '?') + ' intento guardar con copia vieja de: ' + codigos.join(', '));
      return res.status(409).json({
        ok: false, conflicto: true, codigos,
        error: 'Otra persona cambió ' + (codigos.length === 1 ? 'el rollo ' : 'los rollos ') +
               codigos.slice(0, 6).join(', ') + (codigos.length > 6 ? ' y ' + (codigos.length - 6) + ' más' : '') +
               ' mientras trabajabas. No se guardó nada de esta operación: la pantalla se actualizó con lo último, repítela.'
      });
    }

    // ── Borrados explícitos ──
    const codigosBorrados = new Set(lista(bor.rolls).map(String));
    codigosBorrados.forEach(c => { delete est.rolls[c]; });
    const ordenesBorradas = new Set(lista(bor.orders).map(String));
    if (ordenesBorradas.size) {
      est.orders = est.orders.filter(o => !ordenesBorradas.has(String(o.id)));
      est.facLog = est.facLog.filter(x => !ordenesBorradas.has(String(x.orderId)));
    }
    const provBorrados = new Set(lista(bor.providers).map(String));
    if (provBorrados.size) est.providers = est.providers.filter(p => !provBorrados.has(String(p.id)));
    lista(bor.rendManual).forEach(k => { delete est.rend.manual[String(k)]; });

    // ── Cambios: mezcla por código / id ──
    const porId = (arr, nuevos) => {
      const m = new Map(arr.map(x => [String(x.id), x]));
      lista(nuevos).forEach(x => { if (esObj(x) && x.id != null) m.set(String(x.id), x); });
      return [...m.values()];
    };
    // La version nueva la pone el servidor, nunca la pantalla: lo que mande en
    // "rev" solo sirvio para comprobar, y aqui se descarta.
    const revsNuevas = {};
    if (esObj(cam.rolls)) {
      Object.keys(cam.rolls).forEach(c => {
        const r = cam.rolls[c];
        if (esObj(r) && String(r.code) === c) {
          const rev = revDe(est.rolls[c]) + 1;
          est.rolls[c] = Object.assign({}, r, { rev });
          revsNuevas[c] = rev;
        }
      });
    }
    est.orders    = porId(est.orders,    cam.orders);
    est.providers = porId(est.providers, cam.providers);
    est.salidas   = porId(est.salidas,   cam.salidas);
    if (esObj(cam.rendManual)) {
      Object.keys(cam.rendManual).forEach(k => { if (esObj(cam.rendManual[k])) est.rend.manual[k] = cam.rendManual[k]; });
    }
    const clave = x => [x.ts, x.orderId, x.despues].join('|');
    const vistos = new Set(est.facLog.map(clave));
    lista(cam.facLog).forEach(x => { if (esObj(x) && !vistos.has(clave(x))) { est.facLog.push(x); vistos.add(clave(x)); } });

    const proc = lista(b.procesos).map(x => String(x).trim()).filter(Boolean);
    if (proc.length) est.procesos = [...new Set(proc)];

    // Los consecutivos nunca retroceden.
    if (esObj(b.seq)) ['roll', 'order', 'salida'].forEach(k => {
      est.seq[k] = Math.max(Number(est.seq[k]) || 0, Number(b.seq[k]) || 0);
    });

    // ── Historial: solo se agrega (lo que no tenga id ya guardado) ──
    let hist = btHistorial();
    let cambioHist = false;
    if (codigosBorrados.size) { hist = hist.filter(m => !codigosBorrados.has(String(m.code))); cambioHist = true; }
    const ids = new Set(hist.map(m => m.id));
    lista(cam.moves).forEach(m => {
      if (esObj(m) && m.id && !ids.has(m.id)) { hist.push(m); ids.add(m.id); cambioHist = true; }
    });

    if (cambioHist && !saveDB('bodega_telas_historial', hist)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar el historial. Intenta de nuevo.' });
    }
    if (!btGuardarEstado(est)) return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    // La pantalla necesita la version nueva para su siguiente guardado: si no, el
    // segundo cambio que hiciera esta misma persona se rechazaria como si fuera ajeno.
    res.json({ ok: true, revs: revsNuevas });
  } catch (e) {
    console.error('Error no capturado [POST bodega-telas/guardar]:', (e && e.stack) || e);
    if (!res.headersSent) res.status(500).json({ ok: false, error: String((e && e.message) || e) });
  }
});

// Catálogo de rendimientos (kg → metros). Si nadie lo ha actualizado, sale el inicial.
let _btSemilla = null;
function btSemilla() {
  if (_btSemilla) return _btSemilla;
  try { _btSemilla = JSON.parse(fs.readFileSync(path.join(__dirname, 'modulos/bodega-telas/catalogo_inicial.json'), 'utf8')); }
  catch (e) { console.error('No se pudo leer el catálogo inicial de la bodega:', e.message); _btSemilla = null; }
  return _btSemilla;
}
app.get('/api/bodega-telas/catalogo', requirePermiso(BT_PERMISO), (req, res) => {
  const c = loadDB('bodega_telas_catalogo');
  if (esObj(c) && Array.isArray(c.rows)) return res.json({ cat: c });
  res.json({ cat: null, semilla: btSemilla() });
});
app.post('/api/bodega-telas/catalogo', requirePermiso(BT_PERMISO), (req, res) => {
  const c = req.body || {};
  if (!Array.isArray(c.rows) || !c.rows.length) return res.status(400).json({ error: 'El catálogo viene vacío.' });
  if (!saveDB('bodega_telas_catalogo', { rows: c.rows, updated: c.updated || new Date().toISOString(), src: String(c.src || '') })) {
    return res.status(500).json({ error: 'No se pudo guardar el catálogo. Intenta de nuevo.' });
  }
  res.json({ ok: true });
});

// Carga única del respaldo (.json) que se hacía en el navegador. Solo entra si la
// bodega del servidor está vacía: nunca reemplaza datos que ya se están usando.
app.post('/api/bodega-telas/importar', requirePermiso(BT_PERMISO), (req, res) => {
  try {
    const d = (req.body || {}).estado;
    if (!esObj(d) || !esObj(d.rolls) || !Array.isArray(d.orders)) {
      return res.status(400).json({ error: 'El archivo no es un respaldo de la bodega de telas.' });
    }
    const actual = btCargar();
    if (Object.keys(actual.rolls).length || actual.orders.length) {
      return res.status(409).json({ error: 'La bodega ya tiene datos en el servidor. El respaldo solo se puede cargar cuando está vacía.' });
    }
    const est = btVacio();
    est.seq = Object.assign(est.seq, esObj(d.seq) ? d.seq : {});
    est.orders = d.orders; est.rolls = d.rolls;
    est.providers = Array.isArray(d.providers) ? d.providers : [];
    est.procesos = Array.isArray(d.procesos) && d.procesos.length ? d.procesos : est.procesos;
    est.salidas = Array.isArray(d.salidas) ? d.salidas : [];
    est.facLog = Array.isArray(d.facLog) ? d.facLog : [];
    est.rend.manual = esObj(d.rend) && esObj(d.rend.manual) ? d.rend.manual : {};
    const hist = (Array.isArray(d.moves) ? d.moves : []).map((m, i) =>
      Object.assign({}, m, { id: m.id || ('imp' + i + '_' + Date.now().toString(36)) }));
    if (!saveDB('bodega_telas_historial', hist) || !btGuardarEstado(est)) {
      return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true, rollos: Object.keys(est.rolls).length, ordenes: est.orders.length });
  } catch (e) {
    console.error('Error no capturado [POST bodega-telas/importar]:', (e && e.stack) || e);
    res.status(500).json({ error: String((e && e.message) || e) });
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

app.post('/api/mantenimiento', requirePermiso('mmt_locativo', 'area_montajes'), (req, res) => {
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

// ── API Ubicación Lotes: ubicaciones físicas del almacén + lotes de producción ──
// Dos colecciones independientes (patrón "cargar todo, filtrar en JS" igual
// que el resto de la app — no hay tablas SQL reales, ver CLAUDE.md). La
// relación "1 lote → 1 ubicación" vive como un solo campo `ubicacionId`
// en cada lote: nunca un array, así que no puede tener más de una a la vez.
function ubicGenerarCodigo(calle, zona, punto) {
  return `C${calle}-Z${zona}-P${punto}`.toUpperCase().replace(/\s+/g, '');
}
function ubicComboExiste(lista, calle, zona, punto, excluirId) {
  const norm = v => String(v).trim().toLowerCase();
  return lista.some(u => u.id !== excluirId &&
    norm(u.calle) === norm(calle) && norm(u.zona) === norm(zona) && norm(u.punto) === norm(punto));
}

app.get('/api/ubicaciones', (req, res) => {
  try {
    res.json({ ubicaciones: loadDB('ubicaciones') || [] });
  } catch (e) {
    console.error('Error [GET ubicaciones]:', e.message);
    res.status(500).json({ error: e.message, donde: 'GET ubicaciones' });
  }
});

app.post('/api/ubicaciones', requirePermiso('ubicaciones'), (req, res) => {
  try {
    const { calle, zona, punto, descripcion, canal } = req.body || {};
    const calleN = String(calle == null ? '' : calle).trim();
    const zonaN  = String(zona  == null ? '' : zona).trim();
    const puntoN = String(punto == null ? '' : punto).trim();
    if (!calleN || !zonaN || !puntoN) {
      return res.status(400).json({ error: 'Calle, zona y punto son obligatorios' });
    }
    let canalN = '';
    if (canal !== undefined && canal !== null && String(canal).trim() !== '') {
      canalN = Number(canal);
      if (!Number.isInteger(canalN) || canalN <= 0) {
        return res.status(400).json({ error: 'El canal debe ser un número entero mayor a cero' });
      }
    }
    const lista = loadDB('ubicaciones') || [];
    if (ubicComboExiste(lista, calleN, zonaN, puntoN)) {
      return res.status(409).json({ error: 'Ya existe una ubicación con esa Calle + Zona + Punto' });
    }
    const codigo = ubicGenerarCodigo(calleN, zonaN, puntoN);
    if (lista.some(u => u.codigo === codigo)) {
      return res.status(409).json({ error: 'Ya existe una ubicación con ese código' });
    }
    const nueva = {
      id: uuidv4(), codigo, calle: calleN, zona: zonaN, punto: puntoN,
      descripcion: String(descripcion || '').trim(), activo: true,
      fechaCreacion: new Date().toISOString(),
      // dispositivo queda reservado sin uso; canal = número de ubicación del ESP32 (Pick-to-Light).
      dispositivo: '', canal: canalN, estadoLuz: 'OFF'
    };
    lista.push(nueva);
    if (!saveDB('ubicaciones', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, ubicacion: nueva });
  } catch (e) {
    console.error('Error [POST ubicaciones]:', e.message);
    res.status(500).json({ error: e.message, donde: 'POST ubicaciones' });
  }
});

app.put('/api/ubicaciones/:id', requirePermiso('ubicaciones'), (req, res) => {
  try {
    const { calle, zona, punto, descripcion, canal } = req.body || {};
    const calleN = String(calle == null ? '' : calle).trim();
    const zonaN  = String(zona  == null ? '' : zona).trim();
    const puntoN = String(punto == null ? '' : punto).trim();
    if (!calleN || !zonaN || !puntoN) {
      return res.status(400).json({ error: 'Calle, zona y punto son obligatorios' });
    }
    let canalN = '';
    if (canal !== undefined && canal !== null && String(canal).trim() !== '') {
      canalN = Number(canal);
      if (!Number.isInteger(canalN) || canalN <= 0) {
        return res.status(400).json({ error: 'El canal debe ser un número entero mayor a cero' });
      }
    }
    const lista = loadDB('ubicaciones') || [];
    const idx = lista.findIndex(u => u.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Ubicación no encontrada' });
    if (ubicComboExiste(lista, calleN, zonaN, puntoN, req.params.id)) {
      return res.status(409).json({ error: 'Ya existe una ubicación con esa Calle + Zona + Punto' });
    }
    const codigo = ubicGenerarCodigo(calleN, zonaN, puntoN);
    if (lista.some(u => u.id !== req.params.id && u.codigo === codigo)) {
      return res.status(409).json({ error: 'Ya existe una ubicación con ese código' });
    }
    lista[idx] = { ...lista[idx], calle: calleN, zona: zonaN, punto: puntoN, codigo, descripcion: String(descripcion || '').trim(), canal: canalN };
    if (!saveDB('ubicaciones', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, ubicacion: lista[idx] });
  } catch (e) {
    console.error('Error [PUT ubicaciones]:', e.message);
    res.status(500).json({ error: e.message, donde: 'PUT ubicaciones' });
  }
});

app.patch('/api/ubicaciones/:id/activo', requirePermiso('ubicaciones'), (req, res) => {
  try {
    const lista = loadDB('ubicaciones') || [];
    const idx = lista.findIndex(u => u.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Ubicación no encontrada' });
    lista[idx] = { ...lista[idx], activo: !!(req.body && req.body.activo) };
    if (!saveDB('ubicaciones', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, ubicacion: lista[idx] });
  } catch (e) {
    console.error('Error [PATCH ubicaciones/activo]:', e.message);
    res.status(500).json({ error: e.message, donde: 'PATCH ubicaciones/activo' });
  }
});

app.delete('/api/ubicaciones/:id', requirePermiso('ubicaciones'), (req, res) => {
  try {
    const lista = loadDB('ubicaciones') || [];
    const idx = lista.findIndex(u => u.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Ubicación no encontrada' });
    const lotes = loadDB('lotes') || [];
    if (lotes.some(l => l.ubicacionId === req.params.id)) {
      return res.status(409).json({ error: 'No se puede eliminar: esta ubicación tiene lotes asignados' });
    }
    lista.splice(idx, 1);
    if (!saveDB('ubicaciones', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true });
  } catch (e) {
    console.error('Error [DELETE ubicaciones]:', e.message);
    res.status(500).json({ error: e.message, donde: 'DELETE ubicaciones' });
  }
});

app.get('/api/lotes', (req, res) => {
  try {
    res.json({ lotes: loadDB('lotes') || [] });
  } catch (e) {
    console.error('Error [GET lotes]:', e.message);
    res.status(500).json({ error: e.message, donde: 'GET lotes' });
  }
});

// Código de lote: correlativo legible (L-000001, L-000002, ...) — se calcula
// a partir del mayor consecutivo ya guardado, no de la cantidad de lotes
// (así un lote borrado no hace que un código se repita).
function loteGenerarCodigo(lista) {
  let max = 0;
  lista.forEach(l => {
    const m = /^L-(\d+)$/.exec(l.codigo || '');
    if (m) max = Math.max(max, parseInt(m[1], 10));
  });
  return 'L-' + String(max + 1).padStart(6, '0');
}

app.post('/api/lotes', requirePermiso('ubicaciones'), (req, res) => {
  try {
    const { cliente, referencia, op, tipoPrenda, color, cantidad, ubicacionId } = req.body || {};
    const clienteN = String(cliente || '').trim();
    const referenciaN = String(referencia || '').trim();
    const opN = String(op || '').trim();
    const tipoPrendaN = String(tipoPrenda || '').trim();
    const colorN = String(color || '').trim();
    const cantidadN = Number(cantidad);
    if (!clienteN || !referenciaN || !opN || !tipoPrendaN || !colorN) {
      return res.status(400).json({ error: 'Cliente, referencia, OP, tipo de prenda y color son obligatorios' });
    }
    if (!loteCatalogoValor(clienteN, 'lt_clientes')) return res.status(400).json({ error: `El cliente "${clienteN}" no existe. Agrégalo primero en Configuraciones.` });
    if (!loteCatalogoValor(tipoPrendaN, 'lt_tipos_prenda')) return res.status(400).json({ error: `El tipo de prenda "${tipoPrendaN}" no existe. Agrégalo primero en Configuraciones.` });
    if (!loteCatalogoValor(colorN, 'lt_colores')) return res.status(400).json({ error: `El color "${colorN}" no existe. Agrégalo primero en Configuraciones.` });
    if (!cantidadN || cantidadN <= 0 || !Number.isInteger(cantidadN)) {
      return res.status(400).json({ error: 'La cantidad debe ser un número entero mayor a cero' });
    }
    if (!ubicacionId) return res.status(400).json({ error: 'Selecciona una ubicación' });
    const ubicaciones = loadDB('ubicaciones') || [];
    const ubic = ubicaciones.find(u => u.id === ubicacionId);
    if (!ubic) return res.status(400).json({ error: 'La ubicación seleccionada no existe' });
    if (!ubic.activo) return res.status(400).json({ error: 'La ubicación seleccionada está desactivada' });

    const lista = loadDB('lotes') || [];
    const nuevo = {
      id: uuidv4(), codigo: loteGenerarCodigo(lista),
      cliente: clienteN, referencia: referenciaN, op: opN, tipoPrenda: tipoPrendaN, color: colorN, cantidad: cantidadN,
      cantidadDespachada: 0, salidas: [],
      ubicacionId, ubicacionCodigo: ubic.codigo,
      estado: 'en_ci', fechaCreacion: new Date().toISOString(), fechaSalida: null
    };
    lista.push(nuevo);
    if (!saveDB('lotes', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, lote: nuevo });
  } catch (e) {
    console.error('Error [POST lotes]:', e.message);
    res.status(500).json({ error: e.message, donde: 'POST lotes' });
  }
});

// Da salida a N unidades del lote (acción disparada al escanear su QR o desde
// Buscar Lotes). Admite salidas parciales — un mismo lote puede despacharse en
// varias veces hasta completar la cantidad total. `salidas` guarda el historial
// de cada salida para trazabilidad.
app.post('/api/lotes/:id/despachar', requirePermiso('ubicaciones'), (req, res) => {
  try {
    const cantidad = Number(req.body && req.body.cantidad);
    if (!cantidad || cantidad <= 0 || !Number.isInteger(cantidad)) return res.status(400).json({ error: 'La cantidad debe ser un número entero mayor a cero' });
    const lista = loadDB('lotes') || [];
    const idx = lista.findIndex(l => l.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Lote no encontrado' });
    const lote = lista[idx];
    const yaDespachada = lote.cantidadDespachada || 0;
    const restante = lote.cantidad - yaDespachada;
    if (lote.estado === 'despachado' || restante <= 0) {
      return res.status(409).json({ error: 'Este lote ya fue despachado por completo' });
    }
    if (cantidad > restante) {
      return res.status(400).json({ error: `Solo quedan ${restante} unidades pendientes de salida` });
    }
    const nuevaCantidadDespachada = yaDespachada + cantidad;
    const nuevoEstado = nuevaCantidadDespachada >= lote.cantidad ? 'despachado' : 'parcial';
    const salida = { cantidad, fecha: new Date().toISOString() };
    lista[idx] = {
      ...lote,
      cantidadDespachada: nuevaCantidadDespachada,
      estado: nuevoEstado,
      fechaSalida: salida.fecha,
      salidas: [...(lote.salidas || []), salida]
    };
    if (!saveDB('lotes', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    try {
      const ubicaciones = loadDB('ubicaciones') || [];
      const ubic = ubicaciones.find(u => u.id === lote.ubicacionId);
      if (ubic && ubic.canal) publicarLuz(ubic.canal, 'apagar');
    } catch (e) { console.error('[MQTT] Error al apagar luz tras despachar:', e.message); }
    res.json({ ok: true, lote: lista[idx] });
  } catch (e) {
    console.error('Error [POST lotes/despachar]:', e.message);
    res.status(500).json({ error: e.message, donde: 'POST lotes/despachar' });
  }
});

// Enciende/apaga la luz Pick-to-Light de la ubicación de un lote. Se dispara
// al abrir/cancelar el formulario de "dar salida" (Buscar Lote, Salida de
// Lotes, escaneo QR) — es solo un apoyo visual, nunca condiciona la salida.
app.post('/api/lotes/:id/luz', requirePermiso('ubicaciones'), (req, res) => {
  try {
    const accion = (req.body && req.body.accion) === 'apagar' ? 'apagar' : 'encender';
    const lista = loadDB('lotes') || [];
    const lote = lista.find(l => l.id === req.params.id);
    if (!lote) return res.status(404).json({ error: 'Lote no encontrado' });
    const ubicaciones = loadDB('ubicaciones') || [];
    const ubic = ubicaciones.find(u => u.id === lote.ubicacionId);
    if (ubic && ubic.canal) publicarLuz(ubic.canal, accion);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error [POST lotes/luz]:', e.message);
    res.status(500).json({ error: e.message, donde: 'POST lotes/luz' });
  }
});

// Importa un Excel/CSV para crear lotes en bloque (pestaña "Ingresar Lotes").
// A diferencia del catálogo de insumos que existió antes, aquí cada fila es un
// lote NUEVO (no hay upsert): cada lote de producción es un evento distinto.
// Columnas esperadas (sin importar mayúsculas/acentos): CLIENTE, REFERENCIA, OP,
// PRENDA o TIPO PRENDA, COLOR, CANTIDAD, UBICACION (código exacto, ej. C1-Z2-P3).
function loteNormalizarHeader(h) {
  return String(h || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}
app.post('/api/lotes/importar', requirePermiso('ubicaciones'), (req, res) => {
  uploadExcel.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
      const wb = xlsxLib.read(req.file.buffer, { type: 'buffer' });
      const hoja = wb.Sheets[wb.SheetNames[0]];
      const filas = xlsxLib.utils.sheet_to_json(hoja, { defval: '' });

      const ubicaciones = loadDB('ubicaciones') || [];
      const lista = loadDB('lotes') || [];
      let creados = 0;
      const errores = [];

      filas.forEach((filaCruda, i) => {
        const fila = {};
        Object.keys(filaCruda).forEach(k => { fila[loteNormalizarHeader(k)] = filaCruda[k]; });
        const cliente = String(fila.cliente || '').trim().toUpperCase();
        const referencia = String(fila.referencia || '').trim().toUpperCase();
        const op = String(fila.op || '').trim().toUpperCase();
        const tipoPrenda = String(fila.prenda || fila['tipo prenda'] || fila.tipoprenda || '').trim().toUpperCase();
        const color = String(fila.color || '').trim().toUpperCase();
        const cantidad = Number(fila.cantidad) || 0;
        const ubicacionCodigo = String(fila.ubicacion || fila['ubicación'] || '').trim().toUpperCase();
        const fila_n = i + 2;

        if (!cliente || !referencia || !op || !tipoPrenda || !color) {
          errores.push({ fila: fila_n, error: 'Faltan campos obligatorios (cliente, referencia, OP, prenda o color)' }); return;
        }
        if (!loteCatalogoValor(cliente, 'lt_clientes')) { errores.push({ fila: fila_n, error: `El cliente "${cliente}" no existe en Configuraciones` }); return; }
        if (!loteCatalogoValor(tipoPrenda, 'lt_tipos_prenda')) { errores.push({ fila: fila_n, error: `El tipo de prenda "${tipoPrenda}" no existe en Configuraciones` }); return; }
        if (!loteCatalogoValor(color, 'lt_colores')) { errores.push({ fila: fila_n, error: `El color "${color}" no existe en Configuraciones` }); return; }
        if (!cantidad || cantidad <= 0 || !Number.isInteger(cantidad)) {
          errores.push({ fila: fila_n, error: 'Cantidad inválida (debe ser un número entero mayor a cero)' }); return;
        }
        const ubic = ubicaciones.find(u => u.codigo === ubicacionCodigo);
        if (!ubic) { errores.push({ fila: fila_n, error: `Ubicación "${ubicacionCodigo}" no existe` }); return; }
        if (!ubic.activo) { errores.push({ fila: fila_n, error: `Ubicación "${ubicacionCodigo}" está desactivada` }); return; }

        lista.push({
          id: uuidv4(), codigo: loteGenerarCodigo(lista),
          cliente, referencia, op, tipoPrenda, color, cantidad,
          cantidadDespachada: 0, salidas: [],
          ubicacionId: ubic.id, ubicacionCodigo: ubic.codigo,
          estado: 'en_ci', fechaCreacion: new Date().toISOString(), fechaSalida: null
        });
        creados++;
      });

      if (!saveDB('lotes', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      res.json({ ok: true, creados, errores });
    } catch (e) {
      console.error('Error [POST lotes/importar]:', e.message);
      res.status(500).json({ error: e.message, donde: 'POST lotes/importar' });
    }
  });
});

app.get('/api/lotes/exportar', (req, res) => {
  try {
    const lotes = loadDB('lotes') || [];
    const rows = lotes.map(l => ({
      'Código': l.codigo, 'Cliente': l.cliente, 'Referencia': l.referencia, 'OP': l.op,
      'Tipo de prenda': l.tipoPrenda, 'Color': l.color, 'Cantidad': l.cantidad,
      'Cantidad despachada': l.cantidadDespachada || 0, 'Ubicación': l.ubicacionCodigo || '',
      'Estado': l.estado === 'despachado' ? 'Despachado' : (l.estado === 'parcial' ? 'Parcial' : 'En CI'),
      'Fecha creación': l.fechaCreacion || '', 'Fecha última salida': l.fechaSalida || ''
    }));
    const wb = xlsxLib.utils.book_new();
    xlsxLib.utils.book_append_sheet(wb, xlsxLib.utils.json_to_sheet(rows), 'Inventario Lotes');
    const buf = xlsxLib.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="InventarioLotes_${fechaHoyCO()}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) {
    console.error('Error [GET lotes/exportar]:', e.message);
    res.status(500).json({ error: e.message, donde: 'GET lotes/exportar' });
  }
});

// ── Catálogos cerrados de Ubicación Lotes: Clientes / Tipos de prenda / Colores ──
// Cada uno vive en su propia colección {id, nombre}. El cliente/tipo de prenda/
// color de un lote SOLO puede ser uno de estos valores — se valida al crear el
// lote (a diferencia de Referencia/OP, que siguen siendo texto libre).
function loteCatalogoValor(nombre, filesKey) {
  const n = String(nombre || '').trim().toUpperCase();
  return (loadDB(filesKey) || []).some(x => x.nombre === n);
}
// `enUso` permite comprobar el valor contra algo distinto de los lotes antes de
// borrarlo. Los tipos de defecto, por ejemplo, se usan en los registros de
// produccion: borrar uno que ya se registro dejaria esos registros sin nombre.
// Las listas simples (clientes, tipos de prenda, colores, defectos) solo tienen
// nombre, así que comparten toda la lógica. "donde" dice en qué archivos y en
// qué campo quedó escrito ese nombre; sirve para dos cosas:
//
//  · Al renombrar, arrastra el cambio. Sin esto, corregir "HERMECO S.A" a
//    "HERMECO" dejaría las 9 órdenes viejas apuntando a un cliente que ya no
//    está en la lista.
//  · Al eliminar, no se bloquea: los registros viejos guardan el texto, no una
//    referencia, así que siguen leyéndose igual. La pantalla avisa cuántos hay
//    antes de confirmar.
function registrarCatalogoSimple(rutaBase, filesKey, donde) {
  const objetivos = Array.isArray(donde) ? donde : [];
  const igual = (a, b) => String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();

  const contarUsos = (nombre) => {
    let n = 0;
    for (const t of objetivos) {
      const filas = loadDB(t.db) || [];
      for (const f of filas) if (igual(f[t.campo], nombre)) n++;
    }
    return n;
  };

  const renombrarEnTodo = (viejo, nuevo) => {
    let tocados = 0;
    for (const t of objetivos) {
      const filas = loadDB(t.db) || [];
      let cambio = false;
      for (const f of filas) {
        if (igual(f[t.campo], viejo)) { f[t.campo] = nuevo; cambio = true; tocados++; }
      }
      if (cambio) saveDB(t.db, filas, { todos: true });   // cambió registros por dentro
    }
    return tocados;
  };

  app.get(`/api/${rutaBase}`, (req, res) => {
    try {
      const items = (loadDB(filesKey) || []).slice()
        .sort((a, b) => String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es'));
      res.json({ items });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Sin id crea; con id renombra.
  app.post(`/api/${rutaBase}`, (req, res) => {
    try {
      const b = req.body || {};
      const nombre = String(b.nombre || '').trim().toUpperCase();
      if (!nombre) return res.status(400).json({ error: 'Escribe un nombre' });

      const lista = loadDB(filesKey) || [];
      const choca = lista.find(x => compararNombres(x.nombre, nombre) && String(x.id) !== String(b.id || ''));
      if (choca) return res.status(409).json({ error: `Ya existe "${nombre}" en la lista` });

      if (b.id) {
        const idx = lista.findIndex(x => String(x.id) === String(b.id));
        if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
        const anterior = lista[idx].nombre;
        lista[idx] = { ...lista[idx], nombre };
        if (!saveDB(filesKey, lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
        const arrastrados = (anterior === nombre) ? 0 : renombrarEnTodo(anterior, nombre);
        return res.json({ ok: true, item: lista[idx], arrastrados });
      }

      const nuevo = { id: uuidv4(), nombre };
      lista.push(nuevo);
      if (!saveDB(filesKey, lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      res.json({ ok: true, item: nuevo });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.delete(`/api/${rutaBase}/:id`, (req, res) => {
    try {
      const lista = loadDB(filesKey) || [];
      const idx = lista.findIndex(x => String(x.id) === String(req.params.id));
      if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
      const usos = contarUsos(lista[idx].nombre);
      lista.splice(idx, 1);
      if (!saveDB(filesKey, lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      res.json({ ok: true, usos });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

registrarCatalogoSimple('lt-clientes', 'lt_clientes', [
  { db:'lotes', campo:'cliente' }, { db:'fichas', campo:'cliente' }, { db:'ordenes', campo:'cliente' }
]);
registrarCatalogoSimple('lt-tipos-prenda', 'lt_tipos_prenda', [
  { db:'lotes', campo:'tipoPrenda' }, { db:'fichas', campo:'tipoPrenda' }, { db:'ordenes', campo:'tipoPrenda' }
]);
registrarCatalogoSimple('lt-colores', 'lt_colores', [
  { db:'lotes', campo:'color' }
]);
// Tipos de defecto: los elige la operaria al registrar mala calidad.
registrarCatalogoSimple('lt-defectos', 'lt_defectos', [
  { db:'contador_produccion', campo:'tipoDefecto' }
]);
/* Centros de trabajo: dónde se hace cada operación de la prenda. Se elige en
   la tabla de operaciones de la orden, así que el "uso" no se cuenta contra
   una lista plana sino contra las operaciones de cada ficha — por eso va sin
   objetivos: el contador de usos queda en cero y no estorba. */
registrarCatalogoSimple('lt-centros-trabajo', 'lt_centros_trabajo', []);


// ══════════════════════════════════════════════════════════════════
//  FICHAS DE PRENDA (indexadas por referencia)
// ══════════════════════════════════════════════════════════════════
// La misma referencia vuelve a la planta una y otra vez: de 565 ordenes solo
// hay 111 referencias distintas, y el 95% son de una que se repite (la 62301
// lleva 42 ordenes). Las operaciones, sus metas y sus balanceos son de la
// PRENDA, asi que viven aqui una sola vez y las ordenes las heredan.
//
// Estructura de una ficha:
//   { referencia, tipoPrenda, cliente, foto, fichaTecnica,
//     operaciones: [ { nombre, meta, aplicaBalanceo, balanceo: {"7":100,...} } ] }

const normRef = r => String(r || '').trim().toUpperCase();

function fichaDe(referencia) {
  const ref = normRef(referencia);
  if (!ref) return null;
  return (loadDB('fichas') || []).find(f => normRef(f.referencia) === ref) || null;
}

// Las operaciones que aplican a una orden: las suyas propias si alguien las
// ajusto solo para ella, y si no las de la ficha de su referencia.

// Cuanta gente marco presente hoy en un modulo. Sale del Control de Asistencia,
// asi nadie tiene que escribirlo: si faltaron dos, la meta baja sola.
//
// Quien tiene "no cuenta" marcado en Empleados (Configuraciones) sigue
// apareciendo en la lista de asistencia tal cual — eso no se toca — pero no
// suma aqui: es la cuenta que decide la meta por balanceo, no quien esta
// fisicamente presente. compararNombres esta declarada mas abajo en este
// archivo; las funciones se izan, asi que llamarla aqui es seguro (ya lo hace
// otro punto del codigo mas arriba, linea ~1984).
// Con turno, solo cuenta a quienes son de ese turno: de noche no se mezcla la
// gente de día con la de noche (las de noche tienen su asistencia el día en
// que termina su turno, el mismo día que la gente de día).
function personasDeModulo(modulo, fecha, turno) {
  const mod = String(modulo || '').trim().toUpperCase();
  const dia = String(fecha || '').slice(0, 10);
  if (!mod || !dia) return 0;
  const regs = loadDB('ia_records') || [];
  const lista = Array.isArray(regs) ? regs : (Object.values(regs).find(v => Array.isArray(v)) || []);
  const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
  const noCuentan = (st.employees || []).filter(e => e && e.noCuenta);
  return lista.filter(r =>
    compararNombres(r.area, mod) &&
    String(r.date || '').slice(0, 10) === dia &&
    String(r.status || '').toLowerCase() === 'presente' &&
    !noCuentan.some(e => compararNombres(e.name, r.empName)) &&
    (!turno || mismoTurno(turnoDeOperario(r.empName), turno))
  ).length;
}

// ── El turno de cada persona ───────────────────────────────────────
// El de su ficha (Configuraciones → operarias) o, si no tiene, el primero del
// catálogo (el de día). Ver MillarEficiencia.turnoDePersona.
/* Buscar el turno de alguien obliga a recorrer los 442 empleados. Se hacía
   una vez por cada marcación guardada. Se recuerda durante un minuto: si le
   cambian el turno a una persona, se ve en el siguiente minuto. */
const _turnoVisto = new Map();
let _turnoVistoDesde = 0;
function turnoDeOperario(nombre) {
  const ahora = Date.now();
  if (ahora - _turnoVistoDesde > 60000) { _turnoVisto.clear(); _fechaTurnoVista.clear(); _turnoVistoDesde = ahora; }
  const llave = String(nombre || '');
  if (_turnoVisto.has(llave)) return _turnoVisto.get(llave);
  const r = turnoDeOperarioSinRecordar(nombre);
  _turnoVisto.set(llave, r);
  return r;
}
function turnoDeOperarioSinRecordar(nombre) {
  const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
  return MillarEficiencia.turnoDePersona(readJSON(FILES.turnos, []) || [], st.employees || [], nombre);
}
function mismoTurno(a, b) {
  return !!a && !!b && String(a.nombre || '').trim().toUpperCase() === String(b.nombre || '').trim().toUpperCase();
}
// Fecha del turno de una persona para algo que pasó en fecha/hora (hora de
// reloj "HH:MM"). De noche, lo de antes de medianoche es del día siguiente.
/* El resultado solo depende del turno, del dia y del minuto: no de quien sea.
   En un dia hay 8.400 marcaciones y apenas mil y pico combinaciones distintas,
   asi que el mismo calculo se repetia catorce veces por cada resultado. Era la
   mitad de lo que tardaba en abrir el Informe de Empaque.
   Se recuerda durante el mismo minuto que el turno de cada persona y se borra
   con el, asi que un cambio de horario se ve igual de rapido que antes. */
const _fechaTurnoVista = new Map();
function fechaTurnoDe(operario, fecha, hora) {
  const m = String(hora || '').match(/^(\d{1,2}):(\d{2})/);
  const min = m ? Number(m[1]) * 60 + Number(m[2]) : null;
  const t = turnoDeOperario(operario);
  if (!t) return String(fecha || '').slice(0, 10);
  const llave = t.nombre + '|' + fecha + '|' + min;
  if (_fechaTurnoVista.has(llave)) return _fechaTurnoVista.get(llave);
  const r = MillarEficiencia.fechaDelTurno(t, fecha, min);
  _fechaTurnoVista.set(llave, r);
  return r;
}

// Meta por hora de una operacion segun cuanta gente hay.
//  - Sin balanceo: su meta fija.
//  - Con balanceo: la de la tabla. Si ese numero de personas no esta definido,
//    se calcula proporcional entre los dos valores mas cercanos y se avisa,
//    para que nadie se quede sin medir pero quede claro que falta definirlo.
// ── Cuanto cabe todavia en el lote ────────────────────────────────
// El lote es de la OP y lo comparten todos los modulos: si son 300 y tres
// modulos marcan 100 cada uno, esta completo. El tope es POR OPERACION — si la
// prenda pasa por cinco, cada una tiene que llegar a 300 por su cuenta.
//
// Va en el servidor a proposito. En la pantalla no serviria: hay varias tablets
// marcando a la vez y dos podrian colarse en el mismo segundo. Aqui hay un solo
// juez.
//
// Devuelve null cuando NO hay que topar nada (correcciones en negativo, mala
// calidad, o una orden sin cantidad). Preferimos dejar contar antes que frenar
// un modulo por un dato que falta en la orden.
function cupoDelLote(op, operacion, tipo, cantidad) {
  if (tipo !== 'produccion' || cantidad <= 0) return null;
  const orden = (loadDB('ordenes') || []).find(o => String(o.opoc || '') === String(op));
  const total = Number(orden && orden.cantidad) || 0;
  if (total <= 0) return null;

  const hechas = (loadDB('contador_produccion') || [])
    .filter(r => String(r.op || '') === String(op)
              && r.tipo === 'produccion'
              && String(r.operacion || '').toUpperCase() === String(operacion || '').toUpperCase())
    .reduce((s, r) => s + (Number(r.cantidad) || 0), 0);

  return { total, hechas, restante: Math.max(0, total - hechas) };
}

/* ── La meta del día se recalcula si cambia ─────────────────────────
   Cada marcación guarda la meta con la que se midió. Pero si ese mismo día se
   corrige la meta —en Órdenes de Producción (operaciones o balanceo) o en la
   asistencia, que mueve el balanceo—, TODAS las marcaciones de hoy de esa
   referencia y operación pasan a la meta nueva, de todas las personas y
   módulos. Con balanceo, cada módulo se recalcula con su gente de hoy.
   Los días anteriores no se tocan: quedan con la meta con la que trabajaron.
   "Hoy" es la fecha de la marcación (hora de Colombia). */
function fechaHoyServidor() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
}
function recalcularMetasDeHoy(filtro, motivo) {
  try {
    const hoy = fechaHoyServidor();
    const lista = loadDB('contador_produccion') || [];
    const gente = new Map();
    const fichas = new Map();
    let cambiadas = 0;
    lista.forEach((r, i) => {
      if (r.fecha !== hoy || (filtro && !filtro(r))) return;
      if (r.metaOrigen === 'plantilla') return;   // cargada con la meta escrita a mano: esa se respeta
      const refN = normRef(r.ref);
      if (!fichas.has(refN)) fichas.set(refN, fichaDe(r.ref));
      const opFicha = ((fichas.get(refN) || {}).operaciones || [])
        .find(o => String(o.nombre || '').toUpperCase() === String(r.operacion || '').toUpperCase());
      if (!opFicha) return;                       // sin ficha no hay de dónde sacarla: se deja
      const tR = turnoDeOperario(r.operario);
      const fT = fechaTurnoDe(r.operario, r.fecha, r.hora);
      const kG = r.modulo + '|' + fT + '|' + (tR ? tR.nombre : '');
      if (!gente.has(kG)) gente.set(kG, personasDeModulo(r.modulo, fT, tR));
      const personas = gente.get(kG);
      const nueva = metaDeOperacion(opFicha, personas);
      if (!(nueva.meta > 0)) return;              // sin asistencia todavía: no se borra la que tenía
      if (nueva.meta === r.metaUsada && personas === r.personas) return;
      lista[i] = { ...r, personas, metaUsada: nueva.meta, metaOrigen: nueva.origen,
                   metaRecalculadaEn: new Date().toISOString() };
      cambiadas++;
    });
    if (!cambiadas) return 0;
    if (!saveDB('contador_produccion', lista)) { console.error('[METAS] No se pudo guardar el recálculo'); return 0; }
    console.log(`[METAS] ${cambiadas} marcación(es) de hoy pasaron a la meta nueva (${motivo})`);
    // Las tablets vuelven a traer lo de hoy para que la eficiencia cambie al instante.
    broadcast({ type: 'cp_metas_recalculadas', fecha: hoy });
    return cambiadas;
  } catch (e) {
    console.error('[METAS] Error al recalcular:', e.message);
    return 0;
  }
}
// La asistencia se guarda muchas veces seguidas (una por persona): se espera
// a que termine la ráfaga y se recalcula una sola vez.
let _recalculoAsistencia = null;
function programarRecalculoPorAsistencia() {
  clearTimeout(_recalculoAsistencia);
  _recalculoAsistencia = setTimeout(() => recalcularMetasDeHoy(null, 'asistencia'), 3000);
}

function metaDeOperacion(operacion, personas) {
  if (!operacion) return { meta: 0, origen: 'sin-operacion', aviso: null };
  const fija = Number(operacion.meta) || 0;
  if (!operacion.aplicaBalanceo) return { meta: fija, origen: 'fija', aviso: null };

  const tabla = operacion.balanceo || {};
  const puntos = Object.keys(tabla)
    .map(k => ({ n: Number(k), meta: Number(tabla[k]) }))
    .filter(p => Number.isFinite(p.n) && p.n > 0 && Number.isFinite(p.meta) && p.meta > 0)
    .sort((a, b) => a.n - b.n);

  if (!puntos.length) {
    return { meta: fija, origen: 'fija', aviso: 'Esta operación aplica balanceo pero no tiene tabla cargada. Se usa su meta fija.' };
  }
  const n = Number(personas) || 0;
  if (!n) return { meta: 0, origen: 'sin-personas', aviso: 'Aún no hay asistencia registrada para este módulo hoy.' };

  const exacto = puntos.find(p => p.n === n);
  if (exacto) return { meta: exacto.meta, origen: 'balanceo', personas: n, aviso: null };

  // Fuera de tabla: proporcional entre los vecinos, o extrapolado por el
  // extremo mas cercano si queda por fuera del rango definido.
  let meta;
  if (n < puntos[0].n)                       meta = puntos[0].meta / puntos[0].n * n;
  else if (n > puntos[puntos.length - 1].n)  meta = puntos[puntos.length - 1].meta / puntos[puntos.length - 1].n * n;
  else {
    const bajo = [...puntos].reverse().find(p => p.n < n);
    const alto = puntos.find(p => p.n > n);
    meta = bajo.meta + (alto.meta - bajo.meta) * (n - bajo.n) / (alto.n - bajo.n);
  }
  return {
    meta: Math.round(meta),
    origen: 'balanceo-calculado',
    personas: n,
    aviso: 'El balanceo no tiene definida la meta para ' + n + ' personas. Se calculó proporcionalmente: ' + Math.round(meta) + ' por hora.'
  };
}

app.get('/api/fichas', (req, res) => {
  try {
    const lista = loadDB('fichas') || [];
    if (!_fichasCache.json || _fichasCache.arr !== lista || _fichasCache.len !== lista.length) {
      const json = JSON.stringify({ ok: true, fichas: lista });
      // También se guarda comprimida: comprimir 3 MB en cada pedido costaba ~100 ms.
      _fichasCache = { arr: lista, len: lista.length, json, gz: require('zlib').gzipSync(json, { level: 6 }) };
    }
    res.set('Content-Type', 'application/json; charset=utf-8');
    if (req.acceptsEncodings('gzip')) {
      res.set('Content-Encoding', 'gzip');
      res.vary('Accept-Encoding');
      return res.send(_fichasCache.gz);
    }
    res.send(_fichasCache.json);
  }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Que referencias tienen orden pero no ficha. Alimenta el aviso "faltan N
// fichas" y la plantilla que se descarga ya rellenada.
// Va ANTES de /api/fichas/:referencia para que no la capture esa ruta.
app.get('/api/fichas-faltantes', (req, res) => {
  try {
    const ordenes = loadDB('ordenes') || [];
    const conFicha = new Set((loadDB('fichas') || []).map(f => normRef(f.referencia)));
    const faltan = [...new Set(ordenes.map(o => normRef(o.referencia)).filter(Boolean))]
      .filter(r => !conFicha.has(r))
      .sort();
    res.json({ ok: true, faltan, total: faltan.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Plantilla ya rellenada con las referencias que no tienen ficha, para no
// tener que teclearlas a mano (y que no se cuele un error de dedo).
app.get('/api/fichas/plantilla', (req, res) => {
  try {
    const pedidas = String(req.query.referencias || '').split(',').map(normRef).filter(Boolean);
    let refs = pedidas;
    if (!refs.length) {
      const conFicha = new Set((loadDB('fichas') || []).map(f => normRef(f.referencia)));
      refs = [...new Set((loadDB('ordenes') || []).map(o => normRef(o.referencia)).filter(Boolean))]
        .filter(r => !conFicha.has(r)).sort();
    }
    if (!refs.length) refs = [''];

    // Se arma fila por fila como lista, no como objeto: con objetos, las
    // columnas del balanceo (7, 8, 9...) saldrían primero, porque JavaScript
    // ordena antes las claves que son números.
    const cabecera = ['Referencia', 'Centro de trabajo', 'Operacion', 'Meta', 'Balanceo', 'Cobra', 7, 8, 9, 10, 11];
    const filas = [cabecera, ...refs.map(r => [r, '', '', '', 'NO', 'SI', '', '', '', '', ''])];
    const hoja = xlsxLib.utils.aoa_to_sheet(filas);
    const wb   = xlsxLib.utils.book_new();
    xlsxLib.utils.book_append_sheet(wb, hoja, 'Información');
    const buf = xlsxLib.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename="plantilla-fichas.xlsx"');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/fichas/:referencia', (req, res) => {
  try {
    const f = fichaDe(req.params.referencia);
    if (!f) return res.status(404).json({ error: 'No hay ficha para esa referencia' });
    res.json({ ok: true, ficha: f });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crear o actualizar. Se indexa por referencia: si ya existe, se reemplaza.
app.post('/api/fichas', requirePermiso('ordenes_produccion'), (req, res) => {
  try {
    const b = req.body || {};
    const ref = normRef(b.referencia);
    if (!ref) return res.status(400).json({ error: 'Falta la referencia' });

    const ops = Array.isArray(b.operaciones) ? b.operaciones.map(o => {
      const balanceo = {};
      if (o && o.balanceo && typeof o.balanceo === 'object') {
        for (const [k, v] of Object.entries(o.balanceo)) {
          const n = Number(k), m = Number(v);
          if (Number.isFinite(n) && n > 0 && Number.isFinite(m) && m > 0) balanceo[String(n)] = m;
        }
      }
      return {
        nombre:         String((o && o.nombre) || '').trim().toUpperCase(),
        meta:           Number(o && o.meta) || 0,
        aplicaBalanceo: !!(o && o.aplicaBalanceo),
        seCobra:        !(o && o.seCobra === false),
        centroTrabajo:  String((o && o.centroTrabajo) || '').trim().toUpperCase(),
        balanceo
      };
    }).filter(o => o.nombre) : [];

    const ficha = {
      referencia:   ref,
      tipoPrenda:   String(b.tipoPrenda || '').trim().toUpperCase(),
      cliente:      String(b.cliente || '').trim().toUpperCase(),
      foto:         typeof b.foto === 'string' ? b.foto : '',
      fichaTecnica: String(b.fichaTecnica || '').trim(),
      operaciones:  ops,
      actualizado:  Date.now()
    };

    const lista = loadDB('fichas') || [];
    const idx = lista.findIndex(f => normRef(f.referencia) === ref);
    if (idx >= 0) lista[idx] = ficha; else lista.push(ficha);
    if (!saveDB('fichas', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    const recalculadas = recalcularMetasDeHoy(r => normRef(r.ref) === ref, 'ficha ' + ref);
    res.json({ ok: true, ficha, recalculadas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/fichas/:referencia', requirePermiso('ordenes_produccion'), (req, res) => {
  try {
    const ref = normRef(req.params.referencia);
    const lista = loadDB('fichas') || [];
    const idx = lista.findIndex(f => normRef(f.referencia) === ref);
    if (idx < 0) return res.status(404).json({ error: 'No encontrada' });
    lista.splice(idx, 1);
    if (!saveDB('fichas', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cuanta gente hay hoy en un modulo y, si se pide una orden y una operacion,
// contra que meta se va a medir. Lo consulta el Contador de Producción.
app.get('/api/produccion-meta', (req, res) => {
  try {
    const { modulo, referencia, operacion, fecha, operario } = req.query || {};
    let dia = String(fecha || '').slice(0, 10) || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const turnoOp = operario ? turnoDeOperario(operario) : null;
    if (turnoOp && !fecha) {
      const b = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
      dia = MillarEficiencia.fechaDelTurno(turnoOp, dia, b.getHours() * 60 + b.getMinutes());
    }
    const personas = personasDeModulo(modulo, dia, turnoOp);

    const ops = (fichaDe(referencia) || {}).operaciones || [];
    const op  = ops.find(o => String(o.nombre || '').toUpperCase() === String(operacion || '').trim().toUpperCase());
    const r   = metaDeOperacion(op, personas);

    res.json({ ok: true, personas, fecha: dia, operacion: op ? op.nombre : null, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cuánta gente marcó presente hoy en CADA módulo, de una sola vez. Lo usa la
// pestaña de Módulos para mostrar, antes de asignar la OP, qué meta le tocaría
// a cada uno según su gente. Pedirlo módulo por módulo serían 25 consultas.
app.get('/api/asistencia-modulos', (req, res) => {
  try {
    const dia = String(req.query.fecha || '').slice(0, 10)
      || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
    const regs = loadDB('ia_records') || [];
    const lista = Array.isArray(regs) ? regs : (Object.values(regs).find(v => Array.isArray(v)) || []);
    // Misma regla que personasDeModulo: quien tiene "no cuenta" en Empleados no
    // suma aquí tampoco, para que esta vista previa no prometa una meta distinta
    // a la que de verdad se va a usar.
    const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
    const noCuentan = (st.employees || []).filter(e => e && e.noCuenta);
    const porModulo = {};
    for (const r of lista) {
      if (String(r.date || '').slice(0, 10) !== dia) continue;
      if (String(r.status || '').toLowerCase() !== 'presente') continue;
      if (noCuentan.some(e => compararNombres(e.name, r.empName))) continue;
      const m = String(r.area || '').trim().toUpperCase();
      if (!m) continue;
      porModulo[m] = (porModulo[m] || 0) + 1;
    }
    res.json({ ok: true, fecha: dia, modulos: porModulo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cuántas personas registró control de ingreso en un módulo, día por día.
// Misma regla que personasDeModulo: presentes y sin "no cuenta".
app.get('/api/asistencia-modulos-rango', (req, res) => {
  try {
    const desde = String(req.query.desde || '').slice(0, 10);
    const hasta = String(req.query.hasta || '').slice(0, 10);
    const mod = String(req.query.modulo || '').trim().toUpperCase();
    const regs = loadDB('ia_records') || [];
    const lista = Array.isArray(regs) ? regs : (Object.values(regs).find(v => Array.isArray(v)) || []);
    const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
    const noCuentan = (st.employees || []).filter(e => e && e.noCuenta);
    const fechas = {}, nombres = {};
    for (const r of lista) {
      const dia = String(r.date || '').slice(0, 10);
      if (!dia || (desde && dia < desde) || (hasta && dia > hasta)) continue;
      if (mod && !compararNombres(r.area, mod)) continue;
      if (String(r.status || '').toLowerCase() !== 'presente') continue;
      if (noCuentan.some(e => compararNombres(e.name, r.empName))) continue;
      fechas[dia] = (fechas[dia] || 0) + 1;
      // Quiénes son, para que el Informe pueda quitar a quien pasó el día en apoyo.
      (nombres[dia] = nombres[dia] || []).push(String(r.empName || '').trim());
    }
    res.json({ ok: true, fechas, nombres });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Personas asignadas a un módulo en Control de Ingresos (activas y que
   cuentan) y lo que se registró de cada una, día por día: presente, falto o
   novedad. Lo usa el Incentivo acumulado del Informe de Empaque. */
app.get('/api/asistencia-personas-rango', (req, res) => {
  try {
    const desde = String(req.query.desde || '').slice(0, 10);
    const hasta = String(req.query.hasta || '').slice(0, 10);
    const mod = String(req.query.modulo || '').trim().toUpperCase();
    const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
    // todas=1: también quien tiene "No cuenta para la meta" (Preparación: las manuales).
    const todas = String(req.query.todas || '') === '1';
    const personas = (st.employees || [])
      .filter(e => e && !e.disabled && (todas || !e.noCuenta) && e.name
                && compararNombres(e.module || e.modulo, mod))
      .map(e => String(e.name).trim().toUpperCase());
    const regs = loadDB('ia_records') || [];
    const lista = Array.isArray(regs) ? regs : (Object.values(regs).find(v => Array.isArray(v)) || []);
    const estados = {}, areas = {};
    for (const r of lista) {
      const dia = String(r.date || '').slice(0, 10);
      if (!dia || (desde && dia < desde) || (hasta && dia > hasta)) continue;
      const quien = personas.find(p => compararNombres(p, r.empName));
      if (!quien) continue;
      const k = dia + '|' + quien;
      const status = String(r.status || '').toLowerCase();
      // Si hay más de un registro ese día, gana "presente".
      if (estados[k] !== 'presente') {
        estados[k] = status;
        // En qué módulo la marcaron presente ese día: así se sabe si estuvo prestada.
        if (status === 'presente') areas[k] = String(r.area || '').trim();
      }
    }
    res.json({ ok: true, personas, estados, areas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Qué supervisora tiene cada módulo, para el Tablero de Producción. No es un
// dato del módulo: es de la operaria que lo está trabajando ahora mismo
// (trabajoActual), y de ahí se saca su supId — igual que hace Configuraciones
// al listar Empleados.
app.get('/api/supervisoras-modulos', (req, res) => {
  try {
    const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
    const empleados = st.employees || [];
    const supervisors = st.supervisors || [];
    /* La supervisora DEL MÓDULO, no la de quien esté en la tablet.

       Antes se miraba quién tenía el contador abierto y se sacaba SU
       supervisora. Eso está mal: si una operaria de otro equipo entra a cubrir
       un rato, el módulo aparecía con la supervisora de ella. El módulo tiene
       su propia supervisora, y no cambia porque cambie quién lo trabaja.

       Como no hay una lista de "módulo → supervisora", se deduce de su gente:
       la supervisora a la que reporta la mayoría de las empleadas asignadas a
       ese módulo. Es el mismo dato que se llena en Empleados, así que no hay
       nada nuevo que mantener. */
    const nombreSup = supId => {
      const s = supervisors.find(x => x.id === supId || x.name === supId);
      return s ? s.name : String(supId || '');
    };
    const votos = {};   // módulo → { supervisora: cuántas empleadas }
    empleados.forEach(e => {
      if (!e || e.disabled || !e.supId) return;
      const mod = String(e.module || e.modulo || '').trim().toUpperCase();
      if (!mod) return;
      const sup = nombreSup(e.supId);
      if (!sup) return;
      (votos[mod] = votos[mod] || {})[sup] = (votos[mod][sup] || 0) + 1;
    });

    const out = {};
    Object.keys(votos).forEach(mod => {
      // La más repetida. Con empate, la primera alfabéticamente para que el
      // tablero no cambie de nombre solo porque se recargó.
      const pares = Object.entries(votos[mod])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es'));
      if (pares.length) out[mod] = pares[0][0];
    });
    res.json({ ok: true, modulos: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Ficha técnica en PDF ──────────────────────────────────────────
// El PDF va a disco, no dentro del dato. La foto sí puede ir incrustada porque
// comprimida pesa ~50 KB, pero una ficha técnica de varios MB dentro del
// archivo de fichas lo haría ilegible de leer entero en cada pantallazo.
const uploadPdf = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename:    (req, file, cb) => { const n = `ficha-${Date.now()}-${uuidv4()}.pdf`; archivos.anotarSubida(n); cb(null, n); }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('La ficha técnica debe ser un PDF'));
  }
});

app.post('/api/fichas/tecnica', requirePermiso('ordenes_produccion'), (req, res) => {
  uploadPdf.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
    res.json({ ok: true, archivo: req.file.filename, tamano: req.file.size });
  });
});

// ── Cargar fichas desde Excel ─────────────────────────────────────
// Una fila por operación. Varias referencias pueden ir en el mismo archivo.
// Columnas: Referencia | Operacion | Meta | Balanceo | y una columna por cada
// cantidad de personas (7, 8, 9, 10, 11...) con su meta.
//
// Reemplaza las operaciones de cada referencia que aparezca, tal como se acordó:
// el Excel manda sobre lo que hubiera.
function normHeaderFicha(h) {
  return String(h || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

app.post('/api/fichas/importar', requirePermiso('ordenes_produccion'), (req, res) => {
  uploadExcel.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
      const wb    = xlsxLib.read(req.file.buffer, { type: 'buffer' });
      const hoja  = wb.Sheets[wb.SheetNames[0]];
      const filas = xlsxLib.utils.sheet_to_json(hoja, { defval: '' });
      if (!filas.length) return res.status(400).json({ error: 'El archivo no tiene filas' });

      const porRef  = {};
      const errores = [];

      filas.forEach((cruda, i) => {
        const fila = {};
        const numericas = {};   // columnas que son un número: son el balanceo
        Object.keys(cruda).forEach(k => {
          const limpio = normHeaderFicha(k);
          if (/^\d+$/.test(limpio)) numericas[Number(limpio)] = cruda[k];
          else fila[limpio] = cruda[k];
        });

        const ref    = normRef(fila.referencia);
        const nombre = String(fila.operacion || '').trim().toUpperCase();
        if (!ref && !nombre) return;                       // fila vacía, se ignora
        if (!ref)    { errores.push({ fila: i + 2, error: 'Falta la referencia' }); return; }
        if (!nombre) { errores.push({ fila: i + 2, error: 'Falta el nombre de la operación' }); return; }

        const meta = Number(fila.meta) || 0;
        const marca = String(fila.balanceo || '').trim().toLowerCase();
        const aplicaBalanceo = ['si', 'sí', 'x', '1', 'true', 'verdadero'].includes(marca);

        const centroTrabajo = String(fila.centrodetrabajo || fila.centrotrabajo || fila.centro || '').trim().toUpperCase();
        const marcaCobra = String(fila.cobra || fila.secobra || '').trim().toLowerCase();
        const seCobra = marcaCobra === ''
          ? true
          : !['no', '0', 'false', 'falso'].includes(marcaCobra);

        const balanceo = {};
        for (const [personas, valor] of Object.entries(numericas)) {
          const m = Number(valor);
          if (Number.isFinite(m) && m > 0) balanceo[String(personas)] = m;
        }
        if (aplicaBalanceo && !Object.keys(balanceo).length) {
          errores.push({ fila: i + 2, error: `"${nombre}" dice que aplica balanceo pero no trae ninguna meta por personas` });
          return;
        }
        if (!aplicaBalanceo && !meta) {
          errores.push({ fila: i + 2, error: `"${nombre}" no aplica balanceo, así que necesita una meta fija` });
          return;
        }

        (porRef[ref] = porRef[ref] || []).push({ nombre, centroTrabajo, meta, aplicaBalanceo, seCobra, balanceo });
      });

      /* Una referencia no puede quedar con dos operaciones balanceadas: es la
         que mide el módulo y de la que salen los informes, así que tiene que
         ser una sola. Se avisa con nombre propio para que sepan cuál dejar. */
      Object.entries(porRef).forEach(([ref, ops]) => {
        const bal = ops.filter(o => o.aplicaBalanceo);
        if (bal.length > 1) {
          errores.push({ fila: '-', error: `La referencia ${ref} trae ${bal.length} operaciones con balanceo (${bal.map(o => o.nombre).join(', ')}). Solo puede haber una.` });
        }
      });

      if (errores.length) {
        return res.status(400).json({ error: 'El archivo tiene errores', errores: errores.slice(0, 20), total: errores.length });
      }

      const lista = loadDB('fichas') || [];
      const resumen = [];
      for (const [ref, ops] of Object.entries(porRef)) {
        const idx = lista.findIndex(f => normRef(f.referencia) === ref);
        if (idx >= 0) {
          resumen.push({ referencia: ref, operaciones: ops.length, estado: 'actualizada' });
          lista[idx] = { ...lista[idx], operaciones: ops, actualizado: Date.now() };
        } else {
          resumen.push({ referencia: ref, operaciones: ops.length, estado: 'creada' });
          lista.push({ referencia: ref, tipoPrenda: '', cliente: '', foto: '', fichaTecnica: '', operaciones: ops, actualizado: Date.now() });
        }
      }
      if (!saveDB('fichas', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      const refsCargadas = new Set(Object.keys(porRef));
      recalcularMetasDeHoy(r => refsCargadas.has(normRef(r.ref)), 'importar fichas');
      res.json({ ok: true, referencias: resumen.length, detalle: resumen });
    } catch (e) {
      console.error('Error [POST fichas/importar]:', e.message);
      res.status(500).json({ error: e.message, donde: 'POST fichas/importar' });
    }
  });
});


// ══════════════════════════════════════════════════════════════════
//  CATÁLOGO DE IMPRODUCTIVOS
// ══════════════════════════════════════════════════════════════════
// Hay dos clases y no se comportan igual:
//
//  · Los 5 DEL SISTEMA ya existían con su flujo propio — el de mecánicos pide
//    quién atendió y quién solucionó, los de CI crean solicitudes en el Tablero
//    CI, y los otros dos pintan el módulo en el tablero compartido. De ellos
//    solo se editan los dos interruptores de eficiencia y productividad: tocar
//    su nombre, color o comportamiento rompería esas cuatro pantallas.
//
//  · Los que crea el usuario son simples: arrancan un cronómetro y descuentan
//    (o no) según sus interruptores. Sin color, sin icono, sin avisar a nadie.
//    Viven solo dentro del Contador de Producción.
//
// La "clave" es el identificador que ya usa el resto del código para los del
// sistema (red, blue, garnet…). Los nuevos usan "custom:<id>" para no chocar.
// Los nombres y las claves son los que ya usa el resto de la aplicación
// (el mapa LABELS de Contador Módulos y de Contador Producción) y los que
// quedaron escritos en el campo "tipo" de los 5.393 registros del historial.
// Cambiarlos dejaría los reportes viejos sin nombre. "yellow" no va aquí: no
// es otro improductivo, es el estado "atendiendo" del mismo evento de "red".
// "Alistamiento Mecánico" (pink) NO va aquí: no es un improductivo que se
// reporte o se cuente en informes — es solo el aviso de que un mecánico está
// pidiendo insumos para un alistamiento. Vive aparte, solo en Tablero
// Mecánicos (ver 'change_pink' y la rama esMecanico de ci_new_request).
// El de mecánico se llama FALLO MECÁNICO: es UN improductivo que la operaria
// reporta una vez. Que por dentro tenga dos etapas —espera y atención— es
// detalle del historial, no otro improductivo: los nombres de esas dos etapas
// los pone nombreDeImproductivo(), no este catálogo.
const IMPRODUCTIVOS_SISTEMA = [
  { id:'sys-mecanico',     clave:'red',    nombre:'FALLO MECÁNICO' },
  { id:'sys-insumos',      clave:'orange', nombre:'FALTA DE INSUMOS' },
  { id:'sys-produccion',   clave:'purple', nombre:'SOLICITUD DE PRODUCCIÓN' },
  { id:'sys-referencia',   clave:'blue',   nombre:'CAMBIO DE REFERENCIA' },
  { id:'sys-alist-mec',    clave:'garnet', nombre:'ALISTAMIENTO' }
];

// Dos nombres son el mismo si solo cambian acentos o espacios de más.
/* Solicitud de CI entregada: la hora fin se guarda como hora ("6:09:21 a. m."),
   igual que la de inicio, y el tiempo de espera es fin − inicio. Una versión
   vieja del Contador mandaba la hora fin como fecha completa en hora de Londres
   ("2026-09-16T11:09:21.214Z") y la espera vacía; así se corrige al llegar. */
function normalizarEntregaCI(r) {
  if (!r || typeof r !== 'object') return r;
  let finMs = null;
  if (typeof r.resolvedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(r.resolvedAt)) {
    finMs = Date.parse(r.resolvedAt);
    if (Number.isFinite(finMs)) r.resolvedAt = new Date(finMs).toLocaleTimeString('es-CO', { timeZone: 'America/Bogota' });
  }
  if (r.status === 'done' && r.waitTime == null && Number(r.alertStart) > 0) {
    r.waitTime = Math.max(0, (Number.isFinite(finMs) ? finMs : Date.now()) - Number(r.alertStart));
  }
  return r;
}

/* Normalizar un nombre (mayúsculas, sin tildes) es caro, y los informes y los
   tableros lo repetían cientos de miles de veces por pedido (una por cada uno de
   los ~126.000 registros). Los nombres que se comparan son pocos y se repiten,
   así que el resultado se recuerda. Es el mismo resultado de siempre. */
const _limpiarCache = new Map();
function compararNombres(a, b) {
  const limpiarSinCache = s => String(s || '').trim().toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
  const limpiar = s => {
    const k = s ? String(s) : '';
    let v = _limpiarCache.get(k);
    if (v === undefined) {
      v = limpiarSinCache(k);
      if (_limpiarCache.size > 20000) _limpiarCache.clear();
      _limpiarCache.set(k, v);
    }
    return v;
  };
  return limpiar(a) === limpiar(b);
}

function normalizarImproductivo(x, esSistema) {
  const min = Number(x.minutos);
  return {
    id:                  String(x.id || uuidv4()),
    clave:               String(x.clave || ''),
    nombre:              String(x.nombre || '').trim().toUpperCase(),
    esSistema:           !!esSistema,
    afectaEficiencia:    x.afectaEficiencia    !== false,   // por defecto sí descuenta
    afectaProductividad: x.afectaProductividad === true,    // por defecto no
    // Le quita tiempo a la hora, así que también le baja la META.
    //
    // Es distinto de "descuenta de la eficiencia": ese cambia con qué se
    // compara lo producido; este cambia CUÁNTO se le pide a esa hora. En un
    // desayuno de 15 minutos no se pueden pedir las unidades de una hora
    // entera — solo las de los 45 que quedaron.
    descuentaTiempo:     x.descuentaTiempo === true,        // por defecto no
    // Solo aplican a los que crea el usuario.
    minutos:             (!esSistema && Number.isFinite(min) && min > 0) ? Math.round(min) : 0,
    detienePantalla:     !esSistema && x.detienePantalla === true,
    // En qué módulos sale en el Contador. Vacío = en todos. Aplica también a
    // los del sistema: hay módulos que, por ejemplo, no piden insumos.
    modulos:             normalizarModulosImprod(x.modulos),
    // La operaria escribe qué pasó, y eso reemplaza el nombre en todos lados.
    // Es para OTROS: lo que no está en la lista.
    pideDescripcion:     !esSistema && x.pideDescripcion === true,
    // Cómo se ve en el menú del Contador. Las claves están en
    // compartido/millar-improd-estilo.js; vacío = se sugiere por el nombre.
    icono:               String(x.icono || '').trim().slice(0, 30),
    color:               String(x.color || '').trim().slice(0, 30),
    /* Apoyo (solo los propios): no es una parada, es tiempo trabajado en otra
       cosa. En el Informe de Empaque cuenta al 100%.
         'despachos'  apoyo dentro del área: cuenta para todo.
         'otra_area'  prestada a otra área: solo para su incentivo. */
    apoyo:               (!esSistema && ['despachos', 'otra_area'].includes(x.apoyo)) ? x.apoyo : ''
  };
}
function normalizarModulosImprod(v) {
  const lista = Array.isArray(v) ? v : String(v || '').split(/[,;]/);
  const vistos = new Set();
  // Se guarda con el nombre exacto del módulo ("m03" → "M03").
  const activos = getAllActiveModules().map(String);
  const real = m => activos.find(a => a.toUpperCase() === m.toUpperCase()) || m;
  return lista.map(m => real(String(m || '').trim())).filter(m => {
    const k = m.toUpperCase();
    if (!m || k === 'TODOS' || vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

// Los 5 del sistema siempre están, aunque nadie haya guardado nada todavía.
// Si ya se guardaron con sus interruptores, se respetan.
function getImproductivos() {
  const guardados = loadDB('lt_improductivos') || [];
  const porId = new Map(guardados.map(x => [String(x.id), x]));

  const sistema = IMPRODUCTIVOS_SISTEMA.map(base => {
    const g = porId.get(base.id) || {};
    return normalizarImproductivo({ ...base, ...g, id: base.id, clave: base.clave, nombre: base.nombre }, true);
  });
  // Sobras de un improductivo del sistema que ya no existe (se quitó del
  // catálogo, como pasó con Alistamiento Mecánico). Su configuración se quedó
  // guardada y, al no encontrar su base, aparecía en la lista como si fuera un
  // improductivo "propio" creado a mano — un duplicado fantasma. No es propio
  // de nadie: se ignora.
  const esSobraDelSistema = x => String(x.id || '').startsWith('sys-');
  const propios = guardados
    .filter(x => !IMPRODUCTIVOS_SISTEMA.some(s => s.id === String(x.id)))
    .filter(x => !esSobraDelSistema(x))
    .map(x => normalizarImproductivo(x, false));

  // Los del sistema de primeras porque son los que la operaria usa a diario;
  // dentro de cada grupo, en orden alfabético.
  const porNombre = (a, b) => a.nombre.localeCompare(b.nombre, 'es');
  sistema.sort(porNombre);
  propios.sort(porNombre);
  return [...sistema, ...propios];
}

// Cuántas veces se usa cada valor de cada catálogo. Sirve para avisar antes de
// borrar: sin esto le das a eliminar y sale un error sin saber por qué.
app.get('/api/config-produccion/uso', (req, res) => {
  try {
    const fichas  = loadDB('fichas')  || [];
    const ordenes = loadDB('ordenes') || [];
    const lotes   = loadDB('lotes')   || [];
    const regs    = loadDB('contador_produccion') || [];
    const hist    = loadDB('historial') || [];

    const contar = (lista, campo) => {
      const c = {};
      for (const x of lista) {
        const v = String((x && x[campo]) || '').trim().toUpperCase();
        if (v) c[v] = (c[v] || 0) + 1;
      }
      return c;
    };
    const sumar = (...mapas) => {
      const t = {};
      for (const m of mapas) for (const [k, v] of Object.entries(m)) t[k] = (t[k] || 0) + v;
      return t;
    };

    res.json({
      ok: true,
      tiposPrenda:  contar(fichas, 'tipoPrenda'),
      clientes:     sumar(contar(fichas, 'cliente'), contar(ordenes, 'cliente'), contar(lotes, 'cliente')),
      colores:      contar(lotes, 'color'),
      defectos:     contar(regs.filter(r => r.tipo === 'calidad'), 'tipoDefecto'),
      // El historial guarda la "clave", no el nombre. "yellow" es el mismo
      // evento de "red" (ya lo está atendiendo el mecánico), así que suma allí.
      improductivos: (() => {
        const c = contar(hist, 'tipo');
        if (c.YELLOW) { c.RED = (c.RED || 0) + c.YELLOW; delete c.YELLOW; }
        return c;
      })()
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/lt-improductivos', (req, res) => {
  try { res.json({ ok: true, items: getImproductivos() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// Crear o actualizar. En los del sistema solo se aceptan los dos interruptores.
app.post('/api/lt-improductivos', requireMando, (req, res) => {
  try {
    const b = req.body || {};
    const lista = loadDB('lt_improductivos') || [];
    const esSistema = IMPRODUCTIVOS_SISTEMA.some(s => s.id === String(b.id));

    if (esSistema) {
      const base = IMPRODUCTIVOS_SISTEMA.find(s => s.id === String(b.id));
      const item = normalizarImproductivo({ ...base, ...b, id: base.id, clave: base.clave, nombre: base.nombre }, true);
      const idx = lista.findIndex(x => String(x.id) === base.id);
      if (idx >= 0) lista[idx] = item; else lista.push(item);
      if (!saveDB('lt_improductivos', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      return res.json({ ok: true, item });
    }

    const nombre = String(b.nombre || '').trim().toUpperCase();
    if (!nombre) return res.status(400).json({ error: 'Escribe un nombre' });
    // El nombre es lo que ve la operaria y lo que queda en el histórico: dos
    // iguales serían indistinguibles en los reportes. Se comparan sin acentos
    // ni espacios de más, porque "CAPACITACION" y "CAPACITACIÓN" son el mismo
    // improductivo para quien lo lee, aunque para el código no lo sean.
    const chocaCon = getImproductivos().find(x =>
      compararNombres(x.nombre, nombre) && String(x.id) !== String(b.id || ''));
    if (chocaCon) return res.status(409).json({ error: `Ya existe un improductivo llamado "${chocaCon.nombre}"` });

    const idx = b.id ? lista.findIndex(x => String(x.id) === String(b.id)) : -1;
    const id  = (idx >= 0) ? String(b.id) : uuidv4();
    const item = normalizarImproductivo({ ...b, id, clave: 'custom:' + id, nombre }, false);
    if (idx >= 0) lista[idx] = item; else lista.push(item);
    if (!saveDB('lt_improductivos', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Los del sistema no se borran: el resto del código depende de ellos.
// Los propios sí, aunque tengan registros: el histórico guarda el nombre, no
// una referencia, así que los reportes viejos siguen leyéndose igual.
app.delete('/api/lt-improductivos/:id', requireMando, (req, res) => {
  try {
    const id = String(req.params.id);
    if (IMPRODUCTIVOS_SISTEMA.some(s => s.id === id)) {
      return res.status(409).json({ error: 'Los improductivos del sistema no se pueden eliminar' });
    }
    const lista = loadDB('lt_improductivos') || [];
    const idx = lista.findIndex(x => String(x.id) === id);
    if (idx < 0) return res.status(404).json({ error: 'No encontrado' });
    lista.splice(idx, 1);
    if (!saveDB('lt_improductivos', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Carga por Excel. Solo crea o actualiza los propios; los del sistema que
// aparezcan en el archivo se ignoran, para no romperlos por accidente.
app.post('/api/lt-improductivos/importar', requireMando, (req, res) => {
  uploadExcel.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
      const wb    = xlsxLib.read(req.file.buffer, { type: 'buffer' });
      const filas = xlsxLib.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
      if (!filas.length) return res.status(400).json({ error: 'El archivo no tiene filas' });

      const si = v => ['si','sí','x','1','true','verdadero'].includes(String(v).trim().toLowerCase());
      const lista = loadDB('lt_improductivos') || [];
      const activos = getAllActiveModules().map(String);
      let creados = 0, actualizados = 0;
      const ignorados = [], errores = [];

      filas.forEach((cruda, i) => {
        const fila = {};
        // loteNormalizarHeader conserva los espacios, y aquí las columnas son de
        // dos palabras ("Afecta eficiencia"), así que además se quitan.
        Object.keys(cruda).forEach(k => { fila[loteNormalizarHeader(k).replace(/[^a-z0-9]/g, '')] = cruda[k]; });
        const nombre = String(fila.nombre || '').trim().toUpperCase();
        if (!nombre) return;

        // Módulos: vacío o TODOS = todos. Si la columna no viene, se deja lo que
        // ya tenía. Un módulo que no existe es un error, no se adivina.
        const traeModulos = Object.prototype.hasOwnProperty.call(fila, 'modulos');
        let modulos = null;
        if (traeModulos) {
          modulos = [];
          for (const m of normalizarModulosImprod(fila.modulos)) {
            const real = activos.find(a => a.toUpperCase() === m.toUpperCase());
            if (!real) { errores.push({ fila: i + 2, error: `"${nombre}": el módulo "${m}" no existe` }); return; }
            modulos.push(real);
          }
        }

        // Los del sistema no cambian de nombre ni de comportamiento; solo se les
        // puede cambiar en qué módulos salen.
        const sis = IMPRODUCTIVOS_SISTEMA.find(s => compararNombres(s.nombre, nombre));
        if (sis) {
          if (!traeModulos) { ignorados.push(nombre); return; }
          const idxS = lista.findIndex(x => String(x.id) === sis.id);
          const actual = idxS >= 0 ? lista[idxS] : {};
          const item = normalizarImproductivo({ ...sis, ...actual, id: sis.id, clave: sis.clave, nombre: sis.nombre, modulos }, true);
          if (idxS >= 0) lista[idxS] = item; else lista.push(item);
          actualizados++;
          return;
        }

        const min = Number(fila.minutos);
        if (fila.minutos !== '' && (!Number.isFinite(min) || min < 0)) {
          errores.push({ fila: i + 2, error: `"${nombre}": los minutos deben ser un número` });
          return;
        }
        const existente = lista.find(x => compararNombres(x.nombre, nombre)
                                       && !IMPRODUCTIVOS_SISTEMA.some(s => s.id === String(x.id)));
        const id = existente ? String(existente.id) : uuidv4();
        const item = normalizarImproductivo({
          id, clave: 'custom:' + id, nombre,
          afectaEficiencia:    si(fila.afectaeficiencia),
          afectaProductividad: si(fila.afectaproductividad),
          descuentaTiempo:     si(fila.descuentatiempo),
          minutos:             min,
          detienePantalla:     si(fila.detienepantalla),
          pideDescripcion:     Object.prototype.hasOwnProperty.call(fila, 'pidedescripcion')
                                 ? si(fila.pidedescripcion) : !!(existente && existente.pideDescripcion),
          modulos:             modulos || (existente && existente.modulos) || [],
          icono:               existente ? existente.icono : '',
          color:               existente ? existente.color : ''
        }, false);

        if (existente) { lista[lista.indexOf(existente)] = item; actualizados++; }
        else { lista.push(item); creados++; }
      });

      if (errores.length) return res.status(400).json({ error: 'El archivo tiene errores', errores: errores.slice(0, 20) });
      if (!saveDB('lt_improductivos', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      res.json({ ok: true, creados, actualizados, ignorados });
    } catch (e) {
      console.error('Error [POST lt-improductivos/importar]:', e.message);
      res.status(500).json({ error: e.message, donde: 'POST lt-improductivos/importar' });
    }
  });
});

// ── Configuración de Producción ──────────────────────────────────
// Parámetros que antes estaban fijos en el código del módulo y que ahora la
// empresa administra sin desarrollo: umbrales del semáforo de eficiencia,
// cómo se calcula la eficiencia y si se aceptan cantidades negativas.
const CONFIG_PRODUCCION_DEFAULT = {
  semaforoRojo: 70,        // por debajo de este % → rojo
  semaforoVerde: 100,      // desde este % → verde (en medio: amarillo)
  baseEficiencia: 'ritmo', // 'ritmo' = contra lo que debería llevar a esta altura de la hora
                           // 'meta'  = contra la meta completa de la hora
  permitirNegativos: true, // permite registrar cantidades en negativo para corregir
  // Valor del minuto para la Calificación del Informe de Empaque. Cada uno
  // aplica desde su fecha hasta que empiece el siguiente: [{ valor, desde }]
  valoresMinuto: [],
  // Líneas de referencia del gráfico de la Calificación (Informe de Empaque)
  califLimiteInferior: 70,
  califLimiteSuperior: 110,
  /* Auditorías de Calidad: desde qué % de aceptación una auditoría queda
     APROBADA. Nace vacío a propósito — el número lo pone producción, no el
     código. Mientras no esté puesto no se puede guardar ninguna auditoría,
     para que ninguna quede sin resultado. */
  minAceptacionCalidad: null,
  // Incentivo de Empaque: el valor del punto según la eficiencia del día.
  // Cada tramo aplica desde su % hasta que empiece el siguiente; por debajo
  // del primero el punto vale 0.
  tramosIncentivo: [
    { desde: 70,  valor: 65 },
    { desde: 101, valor: 74 },
    { desde: 106, valor: 82 },
    { desde: 111, valor: 84 }
  ]
};
function getConfigProduccion() {
  const guardada = loadDB('config_produccion');
  const c = (guardada && !Array.isArray(guardada)) ? guardada : {};
  return { ...CONFIG_PRODUCCION_DEFAULT, ...c };
}
app.get('/api/config-produccion', (req, res) => {
  try { res.json({ ok: true, config: getConfigProduccion() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/config-produccion', requireMando, (req, res) => {
  try {
    const b = req.body || {};
    const rojo  = Number(b.semaforoRojo);
    const verde = Number(b.semaforoVerde);
    if (!Number.isFinite(rojo) || !Number.isFinite(verde) || rojo < 0 || verde < 0) {
      return res.status(400).json({ error: 'Los umbrales deben ser números positivos' });
    }
    if (rojo >= verde) {
      return res.status(400).json({ error: 'El umbral rojo debe ser menor que el verde' });
    }
    const limInf = b.califLimiteInferior == null ? 70  : Number(b.califLimiteInferior);
    const limSup = b.califLimiteSuperior == null ? 110 : Number(b.califLimiteSuperior);
    if (!Number.isFinite(limInf) || !Number.isFinite(limSup) || limInf < 0 || limSup <= 0 || limInf >= limSup) {
      return res.status(400).json({ error: 'En el gráfico de la Calificación, el límite inferior debe ser menor que el superior' });
    }
    // Tramos del incentivo: si no llegan se conservan los que había.
    let tramos = getConfigProduccion().tramosIncentivo || [];
    if (b.tramosIncentivo != null) {
      if (!Array.isArray(b.tramosIncentivo)) return res.status(400).json({ error: 'Los tramos del incentivo no son válidos' });
      tramos = b.tramosIncentivo.map(t => ({ desde: Number(t && t.desde), valor: Number(t && t.valor) }));
      if (tramos.some(t => !Number.isInteger(t.desde) || t.desde < 0 || t.desde > 500 || !Number.isFinite(t.valor) || t.valor < 0 || t.valor > 100)) {
        return res.status(400).json({ error: 'En el incentivo, cada tramo necesita un % de eficiencia (entero) y un valor del punto entre 0 y 100' });
      }
      tramos.sort((x, y) => x.desde - y.desde);
      if (tramos.some((t, i) => i > 0 && t.desde === tramos[i - 1].desde)) {
        return res.status(400).json({ error: 'En el incentivo hay dos tramos que empiezan en el mismo %' });
      }
    }
    if (b.baseEficiencia !== 'ritmo' && b.baseEficiencia !== 'meta') {
      return res.status(400).json({ error: 'Base de eficiencia inválida' });
    }
    // Mínimo de aceptación de las auditorías: si no llega, se conserva el que había.
    let minAcept = getConfigProduccion().minAceptacionCalidad;
    if (b.minAceptacionCalidad !== undefined) {
      if (b.minAceptacionCalidad === null || b.minAceptacionCalidad === '') minAcept = null;
      else {
        const m = Number(b.minAceptacionCalidad);
        if (!Number.isFinite(m) || m < 0 || m > 100) {
          return res.status(400).json({ error: 'El mínimo de aceptación de calidad debe ir entre 0 y 100' });
        }
        minAcept = Math.round(m * 100) / 100;
      }
    }
    const nueva = {
      semaforoRojo: Math.round(rojo),
      semaforoVerde: Math.round(verde),
      baseEficiencia: b.baseEficiencia,
      permitirNegativos: !!b.permitirNegativos,
      valoresMinuto: getConfigProduccion().valoresMinuto || [],
      califLimiteInferior: Math.round(limInf),
      califLimiteSuperior: Math.round(limSup),
      tramosIncentivo: tramos,
      minAceptacionCalidad: minAcept
    };
    if (!saveDB('config_produccion', nueva)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, config: nueva });
  } catch (e) {
    console.error('Error [POST config-produccion]:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Valor minuto: se agrega con la fecha desde la que aplica. Si ya había uno
// con esa misma fecha, se reemplaza. Los días anteriores conservan el suyo.
app.post('/api/config-produccion/valor-minuto', requireMando, (req, res) => {
  try {
    const b = req.body || {};
    const valor = Math.round(Number(b.valor));
    const desde = String(b.desde || '').slice(0, 10);
    if (!(valor > 0)) return res.status(400).json({ error: 'Escribe un valor mayor que cero' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) return res.status(400).json({ error: 'Elige desde qué fecha aplica' });
    const cfg = getConfigProduccion();
    const lista = (cfg.valoresMinuto || []).filter(x => x.desde !== desde);
    lista.push({ valor, desde, creadoPor: (req.auth && req.auth.user) || '', creadoEn: new Date().toISOString() });
    lista.sort((a, c) => String(a.desde).localeCompare(String(c.desde)));
    if (!saveDB('config_produccion', { ...cfg, valoresMinuto: lista })) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, valoresMinuto: lista });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/config-produccion/valor-minuto', requireMando, (req, res) => {
  try {
    const desde = String(req.query.desde || '').slice(0, 10);
    const cfg = getConfigProduccion();
    const lista = (cfg.valoresMinuto || []).filter(x => x.desde !== desde);
    if (!saveDB('config_produccion', { ...cfg, valoresMinuto: lista })) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, valoresMinuto: lista });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── API Contador Producción ──────────────────────────────────────
// Cada registro es un evento inmutable (una toma de producción o de mala
// calidad). El operario SOLO puede crear registros — nunca editar ni borrar
// (condición explícita del usuario). Únicamente el perfil Programador/Admin
// puede corregir, vía PUT/DELETE protegidos con requireAuth + rol.
// Meta/SAM/operarios se leen en vivo de la misma colección que ya usa el
// módulo Producción (Cap = Operarios × 60 × minutos) — no se duplica el dato.
app.get('/api/contador-produccion/meta', (req, res) => {
  try {
    const modulo = String(req.query.modulo || '').trim();
    const op = String(req.query.op || '').trim();
    if (!modulo || !op) return res.status(400).json({ error: 'Faltan modulo y op' });
    const { boards } = loadDB('produccion') || { boards: {} };
    let sam = null, operarios = null, ref = null, cliente = null, cantidad = null;
    Object.values(boards || {}).forEach(b => {
      const md = b.moduleData && b.moduleData[modulo];
      if (!md) return;
      if (operarios == null) operarios = md.operarios || 2;
      const card = (md.cards || []).find(c => (c.op || '').trim() === op);
      if (card) { sam = card.sam; ref = card.ref; cliente = card.cliente || null; cantidad = card.cantidad; }
    });
    if (sam == null) {
      return res.status(404).json({ error: `No se encontró la OP "${op}" en el módulo ${modulo} dentro de Producción. Verifica que esté programada allí con su SAM.` });
    }
    const metaPorHora = sam > 0 ? Math.round((operarios || 2) * 60 / sam) : 0;
    res.json({ ok: true, sam, operarios: operarios || 2, ref, cliente, cantidad, metaPorHora });
  } catch (e) {
    console.error('Error [GET contador-produccion/meta]:', e.message);
    res.status(500).json({ error: e.message, donde: 'GET contador-produccion/meta' });
  }
});

app.get('/api/contador-produccion/registros', (req, res) => {
  try {
    const { modulo, fecha, op, desde, hasta, tipo } = req.query;
    let lista = loadDB('contador_produccion') || [];
    // El módulo se compara sin mayúsculas ni espacios: pedir "empaque" o
    // "EMPAQUE " tiene que traer lo mismo.
    // Los filtros baratos van primero (día, OP, rango, tipo) para que el del
    // módulo, que compara nombres, solo revise lo que ya quedó.
    if (fecha)  lista = lista.filter(r => r.fecha === fecha);
    if (op)     lista = lista.filter(r => r.op === op);
    // Rango de fechas: lo usan las pantallas de consulta, que no miran un solo
    // día. Las fechas van en formato AAAA-MM-DD, así que comparan como texto.
    if (desde)  lista = lista.filter(r => String(r.fecha || '') >= String(desde));
    if (hasta)  lista = lista.filter(r => String(r.fecha || '') <= String(hasta));
    if (tipo)   lista = lista.filter(r => r.tipo === tipo);
    if (modulo) lista = lista.filter(r => compararNombres(r.modulo, modulo));

    const datosPorOperacion = new Map();
    (loadDB('fichas') || []).forEach(f => {
      const ref = normRef(f.referencia);
      (f.operaciones || []).forEach(o => {
        datosPorOperacion.set(ref + '|' + normRef(o.nombre), {
          seCobra: o.seCobra !== false,
          centroTrabajo: String(o.centroTrabajo || '').trim()
        });
      });
    });
    lista = lista.map(r => {
      const d = datosPorOperacion.get(normRef(r.ref) + '|' + normRef(r.operacion));
      if (!d) return r;
      return { ...r, seCobra: d.seCobra, centroTrabajo: d.centroTrabajo };
    });

    res.json({ registros: lista });
  } catch (e) {
    console.error('Error [GET contador-produccion/registros]:', e.message);
    res.status(500).json({ error: e.message, donde: 'GET contador-produccion/registros' });
  }
});

app.post('/api/contador-produccion/registro', requirePermiso('modulos'), (req, res) => {
  try {
    const { modulo, operario, turno, op, ref, cliente, tipo, cantidad, operacion, tipoDefecto } = req.body || {};
    const moduloN = String(modulo || '').trim();
    const operarioN = String(operario || '').trim();
    const opN = String(op || '').trim();
    const operacionN = String(operacion || '').trim().toUpperCase();
    const cantidadN = Number(cantidad);
    if (!moduloN || !operarioN || !opN) {
      return res.status(400).json({ error: 'Módulo, operario y OP son obligatorios' });
    }
    if (tipo !== 'produccion' && tipo !== 'calidad') {
      return res.status(400).json({ error: 'Tipo inválido' });
    }
    // Cada avance es de una operación concreta: la prenda pasa por varias y
    // cada una lleva su propio conteo contra el lote.
    if (!operacionN) {
      return res.status(400).json({ error: 'Falta indicar la operación' });
    }
    // La mala calidad se clasifica por tipo, para saber dónde se está dañando
    // la prenda. Debe existir en el catálogo de Configuraciones.
    let tipoDefectoN = '';
    if (tipo === 'calidad') {
      tipoDefectoN = String(tipoDefecto || '').trim().toUpperCase();
      if (!tipoDefectoN) return res.status(400).json({ error: 'Elige el tipo de defecto' });
      if (!(loadDB('lt_defectos') || []).some(d => d.nombre === tipoDefectoN)) {
        return res.status(400).json({ error: `El tipo de defecto "${tipoDefectoN}" no existe en Configuraciones` });
      }
    }
    // Se aceptan cantidades negativas para corregir un conteo mal registrado
    // (el operario no puede editar registros, así que corrige creando uno en
    // contra). Cero nunca tiene sentido.
    const cfg = getConfigProduccion();
    if (!Number.isInteger(cantidadN) || cantidadN === 0) {
      return res.status(400).json({ error: 'La cantidad debe ser un número entero distinto de cero' });
    }
    if (cantidadN < 0 && !cfg.permitirNegativos) {
      return res.status(400).json({ error: 'Las cantidades negativas están desactivadas en Configuraciones' });
    }
    if (cantidadN < 0) {
      // Una corrección no puede dejar en negativo el acumulado de esa operación
      // dentro de esa OP: cada operación lleva su propio avance del lote.
      const previos = (loadDB('contador_produccion') || [])
        .filter(r => r.modulo === moduloN && r.op === opN && r.tipo === tipo
                  && String(r.operacion || '').toUpperCase() === operacionN)
        .reduce((s, r) => s + (Number(r.cantidad) || 0), 0);
      if (previos + cantidadN < 0) {
        return res.status(400).json({ error: `No se puede descontar ${Math.abs(cantidadN)}: solo hay ${previos} registradas en esta OP` });
      }
    }
    // ── El lote no se pasa ────────────────────────────────────────
    // Si ya esta completo no se acepta nada. Si lo que se marca no cabe entero,
    // se acepta lo que quepa y se avisa cuanto entro de verdad: es mejor
    // guardar 10 de las 20 y decirlo, que rechazar las 20 y que la operaria no
    // sepa si conto o no.
    let cantidadFinal = cantidadN;
    let avisoLote = null;
    const cupo = cupoDelLote(opN, operacionN, tipo, cantidadN);
    if (cupo && cupo.restante <= 0) {
      return res.status(409).json({
        error: `El lote ya está completo: ${cupo.hechas} de ${cupo.total} en ${operacionN}`,
        loteCompleto: true, total: cupo.total, hechas: cupo.hechas
      });
    }
    if (cupo && cantidadN > cupo.restante) {
      cantidadFinal = cupo.restante;
      avisoLote = `Solo se registraron ${cantidadFinal}: el lote quedó completo (${cupo.total} de ${cupo.total})`;
    }

    const ahora = new Date();
    // Fecha y hora en zona Colombia, no en la del servidor: Render corre en UTC
    // y sellar con toISOString() dejaría la hora 5 h adelantada, rompiendo el
    // corte por hora del turno y la eficiencia. Mismo criterio que el resto de
    // la app (ver logHistorial).
    const bogota = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    const p2 = n => String(n).padStart(2, '0');
    const fechaDia = bogota.getFullYear() + '-' + p2(bogota.getMonth() + 1) + '-' + p2(bogota.getDate());

    // La meta con la que se mide esta marcación. Si más tarde, ese mismo día,
    // se corrige la meta (ficha o asistencia), recalcularMetasDeHoy la cambia
    // en todas las marcaciones de hoy. Los días anteriores no se tocan.
    // La gente que se cuenta es la del turno de quien marca: de noche, la de
    // noche del día en que termina ese turno.
    const turnoOp = turnoDeOperario(operarioN);
    const fechaTurnoOp = turnoOp ? MillarEficiencia.fechaDelTurno(turnoOp, fechaDia, bogota.getHours() * 60 + bogota.getMinutes()) : fechaDia;
    const personas = personasDeModulo(moduloN, fechaTurnoOp, turnoOp);
    const opsRef   = (fichaDe(ref) || {}).operaciones || [];
    const opFicha  = opsRef.find(o => String(o.nombre || '').toUpperCase() === operacionN);
    const resuelta = metaDeOperacion(opFicha, personas);

    const nuevo = {
      id: uuidv4(),
      modulo: moduloN, operario: operarioN, turno: String(turno || '').trim(),
      op: opN, ref: String(ref || '').trim(), cliente: String(cliente || '').trim(),
      operacion: operacionN,
      tipo, cantidad: cantidadFinal,
      ...(tipoDefectoN ? { tipoDefecto: tipoDefectoN } : {}),
      personas,
      metaUsada: resuelta.meta,
      metaOrigen: resuelta.origen,
      fecha: fechaDia,
      hora: p2(bogota.getHours()) + ':' + p2(bogota.getMinutes()),
      timestamp: ahora.toISOString()
    };
    const lista = loadDB('contador_produccion') || [];
    lista.push(nuevo);
    if (!saveDB('contador_produccion', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    // Avisar a las demás tablets del mismo módulo para que se actualicen solas.
    broadcast({ type: 'cp_registro', registro: nuevo });
    res.json({ ok: true, registro: nuevo, ...(avisoLote ? { avisoLote } : {}) });
  } catch (e) {
    console.error('Error [POST contador-produccion/registro]:', e.message);
    res.status(500).json({ error: e.message, donde: 'POST contador-produccion/registro' });
  }
});

/* ── Cierre de turno de cada persona ────────────────────────────────
   Lo manda el Contador cuando la operaria toca "Terminar turno" en el aviso
   de fin de jornada. Se guarda uno por fecha · módulo · persona: si lo toca
   dos veces, vale el último. El Informe de Empaque lo muestra como la hora de
   salida. La fecha y la hora son las de Colombia, igual que los registros. */
app.post('/api/contador-produccion/cierre-turno', requirePermiso('modulos'), (req, res) => {
  try {
    const moduloN   = String((req.body || {}).modulo   || '').trim();
    const operarioN = String((req.body || {}).operario || '').trim();
    if (!moduloN || !operarioN) return res.status(400).json({ error: 'Módulo y operario son obligatorios' });
    const ahora  = new Date();
    const bogota = new Date(ahora.toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    const p2 = n => String(n).padStart(2, '0');
    const fechaReloj = bogota.getFullYear() + '-' + p2(bogota.getMonth() + 1) + '-' + p2(bogota.getDate());
    const cierre = {
      fecha:     fechaTurnoDe(operarioN, fechaReloj, p2(bogota.getHours()) + ':' + p2(bogota.getMinutes())),
      modulo:    moduloN,
      operario:  operarioN,
      hora:      p2(bogota.getHours()) + ':' + p2(bogota.getMinutes()),
      timestamp: ahora.toISOString()
    };
    const mismo = c => c.fecha === cierre.fecha && c.modulo === cierre.modulo
                    && String(c.operario || '').toUpperCase() === operarioN.toUpperCase();
    const todos = loadDB('cierres_turno') || [];
    const previo = todos.find(mismo);
    if (previo && previo.horaEditada) {
      cierre.horaEditada = previo.horaEditada;
      cierre.editadoPor  = previo.editadoPor || '';
      cierre.editadoEn   = previo.editadoEn  || '';
    }
    if (previo && previo.horaPlantilla) cierre.horaPlantilla = previo.horaPlantilla;
    // Las horas que pasó en otro módulo (Preparación) tampoco se pierden.
    if (previo && previo.horasModulo) {
      cierre.horasModulo = previo.horasModulo;
      cierre.horasModuloPor = previo.horasModuloPor || '';
      cierre.horasModuloEn  = previo.horasModuloEn  || '';
    }
    // La hora de ingreso corregida en Control de Ingresos tampoco se pierde.
    if (previo && previo.horaIngresoEditada) {
      cierre.horaIngresoEditada = previo.horaIngresoEditada;
      cierre.ingresoEditadoPor  = previo.ingresoEditadoPor || '';
      cierre.ingresoEditadoEn   = previo.ingresoEditadoEn  || '';
    }
    const lista = todos.filter(c => !mismo(c));
    lista.push(cierre);
    if (!saveDB('cierres_turno', lista.slice(-50000))) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, cierre });
  } catch (e) {
    console.error('Error [POST contador-produccion/cierre-turno]:', e.message);
    res.status(500).json({ error: e.message, donde: 'POST contador-produccion/cierre-turno' });
  }
});
/* ── Horas de salida ──────────────────────────────────────────────
   Un solo cálculo para el Informe de Empaque y para Control de Ingresos, así
   las dos pantallas dicen siempre lo mismo. En cuartos de hora:
   - Editada por el administrador: esa, tal cual.
   - Tocó "Terminar turno": la hora del toque, hacia abajo (2:50 → 2:45).
   - Día anterior sin "Terminar turno": el final del turno normal, o el final
     de la última hora extra en la que marcó (MillarEficiencia.tiempoDelDia).
   - Hoy sin "Terminar turno": en blanco. */
function horasDeSalida(desde, hasta, modulo) {
  const may = v => String(v || '').trim().toUpperCase();
  const minDe = h => { const m = String(h || '').match(/^(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
  const hhmm = m => String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
  // Cada persona con su turno; lo de un turno de noche va al día en que termina.
  const enRango = f => (!desde || String(f) >= String(desde)) && (!hasta || String(f) <= String(hasta));
  const delModulo = m => !modulo || compararNombres(m, modulo);
  const grupos = new Map();
  const grupo = (fecha, mod, operario) => {
    const k = fecha + '|' + may(mod) + '|' + may(operario);
    if (!grupos.has(k)) grupos.set(k, { fecha, modulo: String(mod || '').trim(), operario: String(operario || '').trim(), marcas: [], cierre: null });
    return grupos.get(k);
  };
  /* Solo las marcaciones del rango pedido. Antes se recorrían las 126.283
     guardadas y se buscaba el turno de cada una para ver si entraba: eso era
     lo que tenía el servidor al tope. Se deja un día de margen hacia atrás
     porque el turno de noche empieza la víspera. */
  const desdeCal = desde ? fechaCO(new Date(new Date(desde + 'T12:00:00Z').getTime() - 86400000)) : null;
  (loadDB('contador_produccion') || []).forEach(r => {
    if (r.tipo !== 'produccion') return;
    const fCal = String(r.fecha || '');
    if (desdeCal && fCal < desdeCal) return;          // muy viejo: ni se mira
    if (hasta && fCal > String(hasta)) return;        // posterior al rango
    if (!String(r.operario || '').trim() || !delModulo(r.modulo)) return;
    const fT = r.fechaTurno || fechaTurnoDe(r.operario, r.fecha, r.hora);
    if (!enRango(fT)) return;
    const g = grupo(fT, r.modulo, r.operario);
    const m = minDe(r.hora);
    if (m != null) g.marcas.push(m);
  });
  (loadDB('cierres_turno') || []).forEach(c => {
    if (!enRango(c.fecha) || !delModulo(c.modulo)) return;
    grupo(c.fecha, c.modulo, c.operario).cierre = c;
  });
  return [...grupos.values()].map(g => {
    const c = g.cierre;
    let hora = '', origen = '';
    if (c && c.horaEditada) { hora = c.horaEditada; origen = 'editada'; }
    else if (c && c.horaPlantilla) { hora = c.horaPlantilla; origen = 'plantilla'; }
    else if (c && minDe(c.hora) != null) { hora = hhmm(Math.floor(minDe(c.hora) / 15) * 15); origen = 'cierre'; }
    const turno = turnoDeOperario(g.operario);
    if (hora) { /* ya está */ }
    else if (g.fecha < hoy && g.marcas.length && turno) {
      const bloques = MillarEficiencia.bloquesDeFechaTurno(turno, g.fecha);
      const t = MillarEficiencia.tiempoDelDia({ bloques, marcasMin: g.marcas, salidaMin: null, ahoraMin: null });
      if (t) { hora = hhmm(t.finMin); origen = 'calculada'; }
    }
    // Hora de ingreso: la editada, o si no, el inicio del turno de ese día.
    // Con ella el Informe de Empaque mide el día desde que la persona entró.
    let ingreso = '', origenIngreso = '';
    if (c && c.horaIngresoEditada) { ingreso = c.horaIngresoEditada; origenIngreso = 'editada'; }
    else if (turno) {
      const bl = MillarEficiencia.bloquesDeFechaTurno(turno, g.fecha);
      if (bl.length) { ingreso = hhmm(bl[0].iniMin); origenIngreso = 'turno'; }
    }
    return { fecha: g.fecha, modulo: g.modulo, operario: g.operario, hora, origen, ingreso, origenIngreso,
             horasModulo: Number(c && c.horasModulo) || 0,
             editadoPor: (c && c.editadoPor) || '', editadoEn: (c && c.editadoEn) || '',
             ingresoEditadoPor: (c && c.ingresoEditadoPor) || '', ingresoEditadoEn: (c && c.ingresoEditadoEn) || '' };
  }).sort((a, b) => String(a.fecha).localeCompare(String(b.fecha)) || a.modulo.localeCompare(b.modulo, 'es', { numeric: true })
                  || a.operario.localeCompare(b.operario, 'es'));
}
app.get('/api/contador-produccion/horas-salida', (req, res) => {
  try {
    const { desde, hasta, modulo } = req.query;
    res.json({ ok: true, filas: horasDeSalida(desde, hasta, modulo) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Editar la hora de salida o la de ingreso (Control de Ingresos). Vacía =
// quitar la edición: la salida vuelve a la de "Terminar turno" o a la
// calculada; el ingreso, al inicio del turno.
const CAMPOS_HORA_CIERRE = {
  salida:  { hora: 'horaEditada',        por: 'editadoPor',        en: 'editadoEn' },
  ingreso: { hora: 'horaIngresoEditada', por: 'ingresoEditadoPor', en: 'ingresoEditadoEn' },
};
function editarHoraDelCierre(cual) {
  const K = CAMPOS_HORA_CIERRE[cual];
  return (req, res) => {
    try {
      const b = req.body || {};
      const fecha = String(b.fecha || '').slice(0, 10);
      const modulo = String(b.modulo || '').trim();
      const operario = String(b.operario || '').trim();
      const hora = String(b.hora || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !modulo || !operario) return res.status(400).json({ error: 'Faltan la fecha, el módulo o la persona' });
      if (hora && !/^([01]\d|2[0-3]):(00|15|30|45)$/.test(hora)) return res.status(400).json({ error: 'La hora debe ir en cuartos de hora (X:00, X:15, X:30 o X:45)' });
      const mismo = c => c.fecha === fecha && String(c.modulo || '').toUpperCase() === modulo.toUpperCase()
                      && String(c.operario || '').toUpperCase() === operario.toUpperCase();
      const lista = loadDB('cierres_turno') || [];
      const idx = lista.findIndex(mismo);
      if (hora) {
        const base = idx >= 0 ? lista[idx] : { fecha, modulo, operario };
        // Quién la corrigió: la supervisora o el administrador que entró a Control
        // de Ingresos. Si no llega, el usuario con el que se abrió la app.
        const por = String(b.editadoPor || '').trim().slice(0, 60) || (req.auth && req.auth.user) || '';
        const nuevo = { ...base, [K.hora]: hora, [K.por]: por, [K.en]: new Date().toISOString() };
        if (idx >= 0) lista[idx] = nuevo; else lista.push(nuevo);
      } else if (idx >= 0) {
        const resto = { ...lista[idx] };
        delete resto[K.hora]; delete resto[K.por]; delete resto[K.en];
        // Si el registro solo existía por ediciones (nunca tocó "Terminar
        // turno" ni se cargó por plantilla) y ya no le queda ninguna, se quita.
        if (resto.hora || resto.horaPlantilla || resto.horaEditada || resto.horaIngresoEditada || resto.horasModulo) lista[idx] = resto;
        else lista.splice(idx, 1);
      }
      if (!saveDB('cierres_turno', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      res.json({ ok: true, filas: horasDeSalida(fecha, fecha, modulo) });
    } catch (e) { res.status(500).json({ error: e.message }); }
  };
}
app.put('/api/contador-produccion/hora-salida', requireAuth, editarHoraDelCierre('salida'));
app.put('/api/contador-produccion/hora-ingreso', requireAuth, editarHoraDelCierre('ingreso'));
/* Horas que la persona pasó en otro módulo ese día (Informe diario de
   Preparación). Se restan al tiempo que se le mide en el módulo; su incentivo
   sigue contando el día completo. Pide la clave de acción, revisada AQUÍ.
   0 o vacío = quitar. Hasta 2 decimales. */
app.put('/api/contador-produccion/horas-modulo', requireAuth, (req, res) => {
  try {
    if (bloqueadoPorFallos(req)) return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.' });
    const b = req.body || {};
    const fecha = String(b.fecha || '').slice(0, 10);
    const modulo = String(b.modulo || '').trim();
    const operario = String(b.operario || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !modulo || !operario) return res.status(400).json({ error: 'Faltan la fecha, el módulo o la persona' });
    if (!claveAccionValida('general', b.clave)) { anotarFallo(req); return res.status(403).json({ error: 'Clave incorrecta' }); }
    const texto = String(b.horas == null ? '' : b.horas).trim().replace(',', '.');
    let horas = texto === '' ? 0 : Number(texto);
    if (!isFinite(horas) || horas < 0 || horas > 24) return res.status(400).json({ error: 'Las horas deben ser un número entre 0 y 24' });
    horas = Math.round(horas * 100) / 100;
    const mismo = c => c.fecha === fecha && compararNombres(c.modulo, modulo) && compararNombres(c.operario, operario);
    const lista = loadDB('cierres_turno') || [];
    const idx = lista.findIndex(mismo);
    const por = (req.auth && req.auth.user) || '';
    if (horas > 0) {
      const baseC = idx >= 0 ? lista[idx] : { fecha, modulo, operario };
      const nuevo = { ...baseC, horasModulo: horas, horasModuloPor: por, horasModuloEn: new Date().toISOString() };
      if (idx >= 0) lista[idx] = nuevo; else lista.push(nuevo);
    } else if (idx >= 0) {
      const resto = { ...lista[idx] };
      delete resto.horasModulo; delete resto.horasModuloPor; delete resto.horasModuloEn;
      if (resto.hora || resto.horaPlantilla || resto.horaEditada || resto.horaIngresoEditada) lista[idx] = resto;
      else lista.splice(idx, 1);
    }
    if (!saveDB('cierres_turno', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    console.log('[HORAS MODULO] ' + fecha + ' ' + operario + ' (' + modulo + '): ' + horas + ' h, por ' + (por || '?'));
    res.json({ ok: true, filas: horasDeSalida(fecha, fecha, modulo) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* ── Registros manuales por plantilla ─────────────────────────────
   Para quien no usa tablet y reporta en papel. Se descarga una plantilla con
   las personas que control de ingreso registró en el módulo ese día y que no
   tienen marcaciones; se llena y se sube. Cada fila es una operación de una
   persona. Si alguna fila tiene un error no se carga NADA y se devuelve la
   lista para corregir. Volver a subir la misma persona y fecha reemplaza lo
   que se había cargado por plantilla. */
// Quienes tienen ingreso "presente" ese día en el módulo (modulo '*' = en
// cualquier área). Sin los marcados "no cuenta" en Control de Ingresos.
/* incluirNoCuentan: en Preparación las personas que se califican a mano (cargo
   MANUAL) tienen marcada "No cuenta para la meta" y aun así hay que poder
   cargarles su %: para ellas la lista las incluye. */
function presentesDelDia(modulo, fecha, incluirNoCuentan) {
  const mod = String(modulo || '').trim().toUpperCase();
  const regs = loadDB('ia_records') || [];
  const lista = Array.isArray(regs) ? regs : (Object.values(regs).find(v => Array.isArray(v)) || []);
  const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
  const noCuentan = (st.employees || []).filter(e => e && e.noCuenta);
  const vistos = new Set(), nombres = [];
  lista.forEach(r => {
    if (mod !== '*' && !compararNombres(r.area, mod)) return;
    if (!incluirNoCuentan && noCuentan.some(e => compararNombres(e.name, r.empName))) return;
    if (String(r.date || '').slice(0, 10) !== fecha) return;
    if (String(r.status || '').toLowerCase() !== 'presente') return;
    const n = String(r.empName || '').trim();
    if (!n || vistos.has(n.toUpperCase())) return;
    vistos.add(n.toUpperCase());
    nombres.push(n);
  });
  return nombres.sort((a, b) => a.localeCompare(b, 'es'));
}
/* Calificación manual: en Preparación hay personas que no reportan producción y
   se califican con un % de eficiencia que cambia todos los días. Se cargan con la
   plantilla (Referencia y OP = MANUAL, Cantidad = el %). Se guardan APARTE de la
   producción del Contador, para que los tableros no cuenten ese % como unidades. */
const MODULOS_CON_MANUALES = ['PREPARACION'];
const permiteManuales = m => MODULOS_CON_MANUALES.some(x => compararNombres(x, m));
app.get('/api/contador-produccion/manuales', (req, res) => {
  try {
    const desde = String(req.query.desde || '').slice(0, 10);
    const hasta = String(req.query.hasta || '').slice(0, 10);
    const modulo = String(req.query.modulo || '').trim();
    const filas = (loadDB('eficiencias_manuales') || [])
      .filter(m => (!modulo || compararNombres(m.modulo, modulo))
                && (!desde || String(m.fecha) >= desde) && (!hasta || String(m.fecha) <= hasta))
      .map(m => ({ fecha: m.fecha, modulo: m.modulo, operario: m.operario, pct: m.pct }));
    res.json({ ok: true, filas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/contador-produccion/plantilla-manual', (req, res) => {
  try {
    const fecha = String(req.query.fecha || '').slice(0, 10);
    const modulo = String(req.query.modulo || 'EMPAQUE').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Elige la fecha' });
    const conRegistros = new Set((loadDB('contador_produccion') || [])
      .filter(r => r.fecha === fecha && compararNombres(r.modulo, modulo))
      .map(r => String(r.operario || '').trim().toUpperCase()));
    res.json({ ok: true, fecha, modulo, personas: presentesDelDia(modulo, fecha, permiteManuales(modulo)).filter(n => !conRegistros.has(n.toUpperCase())) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
/* Quiénes marcaron presente ese día en ese módulo. Lo usa "Registrar a mano":
   antes se bajaba la asistencia entera (más de 1 MB) solo para llenar el
   desplegable de la operaria. Con módulo '*' son los de cualquier área. */
app.get('/api/asistencia-presentes', requireAuth, (req, res) => {
  try {
    const fecha = String(req.query.fecha || '').slice(0, 10);
    const modulo = String(req.query.modulo || '').trim() || '*';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) return res.status(400).json({ error: 'Elige la fecha' });
    res.json({ ok: true, fecha, modulo, personas: presentesDelDia(modulo, fecha) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/contador-produccion/cargar-manual', requireAuth, (req, res) => {
  uploadExcel.single('archivo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    try {
      if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo' });
      const modulo = String(req.query.modulo || 'EMPAQUE').trim();
      const MOD = modulo;
      const wb = xlsxLib.read(req.file.buffer, { type: 'buffer' });
      const crudas = xlsxLib.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: true });
      const p2 = n => String(n).padStart(2, '0');
      const aCO = f => f.split('-').reverse().join('/');
      // Fecha: 14/09/2026, 2026-09-14 o una fecha de Excel.
      const fechaDe = v => {
        if (typeof v === 'number' && v > 20000) {
          const d = new Date(Math.round((v - 25569) * 86400000));
          return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate());
        }
        const t = String(v || '').trim();
        let m = t.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})$/);
        if (m) return m[3] + '-' + p2(m[2]) + '-' + p2(m[1]);
        m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? m[1] + '-' + m[2] + '-' + m[3] : null;
      };
      // Hora: 16:00, 4:00 p. m., 4:00 PM o una hora de Excel. Lo que no se
      // entienda es error: no se adivina.
      const minutosDe = v => {
        if (typeof v === 'number') {
          if (v >= 1 && Number.isInteger(v)) return null;          // "16" a secas no es una hora
          return Math.round((v % 1) * 1440) % 1440;
        }
        const t = String(v || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const m = t.match(/^(\d{1,2})[:.](\d{2})(?::\d{2})?\s*(a\.?\s*m\.?|p\.?\s*m\.?)?$/);
        if (!m) return null;
        let h = Number(m[1]);
        const mi = Number(m[2]);
        if (mi > 59 || h > 23) return null;
        if (m[3]) {
          if (h < 1 || h > 12) return null;
          const pm = m[3].startsWith('p');
          if (pm && h < 12) h += 12;
          if (!pm && h === 12) h = 0;
        }
        return h * 60 + mi;
      };
      const vacio = v => String(v == null ? '' : v).trim() === '';

      const errores = [], avisos = [];
      let metasPropias = 0;   // filas con meta escrita distinta a la del sistema (se usa la escrita)
      // A qué hora empieza el turno cada fecha: una salida antes de eso está mal
      // escrita (4:00 sola es de la madrugada).
      const turnoBase = (readJSON(FILES.turnos, []) || [])[0] || null;
      const inicioTurno = {};
      // Inicio del turno de ESA persona ese día. Para el de noche no se valida
      // (la salida de madrugada es antes que el inicio y es correcta).
      const inicioDe = (fecha, nombre) => {
        const t = nombre ? turnoDeOperario(nombre) : turnoBase;
        if (t && MillarEficiencia.inicioDelTurno(t).cruzaMedianoche) return null;
        const k = fecha + '|' + (t ? t.nombre : '');
        if (!(k in inicioTurno)) {
          const b = t ? MillarEficiencia.bloquesDeFechaTurno(t, fecha) : [];
          inicioTurno[k] = b.length ? b[0].iniMin : null;
        }
        return inicioTurno[k];
      };
      /* Operaciones que no existen en la referencia: se preguntan en pantalla
         (meta y si se cobra) y vuelven en crearOperaciones. Se crean en una copia
         de las referencias, que solo se guarda si toda la carga sale bien. */
      const fichasMem = JSON.parse(JSON.stringify(loadDB('fichas') || []));
      const fichaMem = r => fichasMem.find(x => normRef(x.referencia) === normRef(r)) || null;
      let pedidas = [];
      try { pedidas = JSON.parse((req.body && req.body.crearOperaciones) || '[]'); } catch (e) { pedidas = null; }
      if (!Array.isArray(pedidas)) return res.status(400).json({ error: 'Las operaciones a crear no llegaron bien. Carga el archivo otra vez.' });
      const creadas = [];
      for (const p of pedidas) {
        const refP = normRef(p && p.ref), nombreOp = String((p && p.operacion) || '').trim().toUpperCase();
        const metaP = Number(p && p.meta);
        if (!refP || !nombreOp || !Number.isInteger(metaP) || metaP <= 0 || typeof (p && p.seCobra) !== 'boolean') {
          return res.status(400).json({ error: 'Para crear ' + (nombreOp || 'una operación') + ' falta la meta (número entero) o si se cobra' });
        }
        let ficha = fichaMem(refP);
        if (!ficha) { ficha = { referencia: refP, tipoPrenda: '', cliente: '', foto: '', fichaTecnica: '', operaciones: [] }; fichasMem.push(ficha); }
        if (!Array.isArray(ficha.operaciones)) ficha.operaciones = [];
        if (ficha.operaciones.some(o => String(o.nombre || '').trim().toUpperCase() === nombreOp)) continue;
        ficha.operaciones.push({ nombre: nombreOp, meta: metaP, aplicaBalanceo: false, seCobra: p.seCobra, centroTrabajo: '', balanceo: {} });
        ficha.actualizado = Date.now();
        creadas.push({ ref: refP, operacion: nombreOp });
      }
      const faltantes = new Map();
      const ordenes = loadDB('ordenes') || [];
      const registros = loadDB('contador_produccion') || [];
      const conTablet = new Set(registros
        .filter(r => r.origen !== 'plantilla' && compararNombres(r.modulo, MOD))
        .map(r => r.fecha + '|' + String(r.operario || '').trim().toUpperCase()));
      const presentes = new Map(), presentesM = new Map(), gente = new Map(), porPersona = new Map();
      // Todas las filas de una persona (operaciones e improductivos) comparten
      // la hora de salida.
      const personaDe = (fecha, nombre, salida, n) => {
        const k = fecha + '|' + nombre.toUpperCase();
        if (!porPersona.has(k)) porPersona.set(k, { fecha, nombre, salida, filas: [], imps: [] });
        const pe = porPersona.get(k);
        if (pe.salida !== salida) { errores.push({ fila: n, error: `${nombre} tiene dos horas de salida distintas el ${aCO(fecha)}` }); return null; }
        return pe;
      };

      /* Quien tiene una fila APOYO (prestada a otra área) tiene su ingreso en esa
         área: todas sus filas de ese día (también desayuno y almuerzo) se
         aceptan con el ingreso de cualquier área. */
      const personaFecha = (fecha, nombre) => fecha + '|' + String(nombre || '').trim().toUpperCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/s+/g, ' ');
      const conApoyo = new Set();
      crudas.forEach(cruda => {
        const fila = {};
        Object.keys(cruda).forEach(k => { fila[loteNormalizarHeader(k).replace(/[^a-z0-9]/g, '')] = cruda[k]; });
        const fecha = fechaDe(fila.fecha);
        if (fecha && String(fila.referencia || '').trim().toUpperCase() === 'APOYO') conApoyo.add(personaFecha(fecha, fila.nombre));
      });
      // Quien trae una fila MANUAL ese día: TODAS sus filas de ese día (también sus
      // descansos) se aceptan aunque tenga "No cuenta para la meta".
      const conManual = new Set();
      crudas.forEach(cruda => {
        const fila = {};
        Object.keys(cruda).forEach(k => { fila[loteNormalizarHeader(k).replace(/[^a-z0-9]/g, '')] = cruda[k]; });
        const fecha = fechaDe(fila.fecha);
        if (fecha && String(fila.referencia || '').trim().toUpperCase() === 'MANUAL' && permiteManuales(modulo)) conManual.add(personaFecha(fecha, fila.nombre));
      });
      const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
      const noCuenta = nombre => (st.employees || []).some(e => e && e.noCuenta && compararNombres(e.name, nombre));

      crudas.forEach((cruda, i) => {
        const n = i + 2;
        const fila = {};
        Object.keys(cruda).forEach(k => { fila[loteNormalizarHeader(k).replace(/[^a-z0-9]/g, '')] = cruda[k]; });
        // Fila sin llenar (la persona no trabajó): no se carga.
        if (['horadesalida', 'referencia', 'op', 'operacion', 'meta', 'cantidad'].every(k => vacio(fila[k]))) return;

        const fecha = fechaDe(fila.fecha);
        if (!fecha) { errores.push({ fila: n, error: 'La fecha no se entiende. Escríbela como 14/09/2026' }); return; }
        const nombreTxt = String(fila.nombre || '').trim();
        if (!nombreTxt) { errores.push({ fila: n, error: 'Falta el nombre' }); return; }
        // Una fila MANUAL también acepta a quien tiene "No cuenta para la meta".
        const filaManual = conManual.has(personaFecha(fecha, nombreTxt));
        const cache = filaManual ? presentesM : presentes;
        if (!cache.has(fecha)) cache.set(fecha, presentesDelDia(modulo, fecha, filaManual));
        let nombre = cache.get(fecha).find(x => compararNombres(x, nombreTxt));
        // APOYO (prestada a otra área): su ingreso está registrado en esa área.
        if (!nombre && conApoyo.has(personaFecha(fecha, nombreTxt))) {
          nombre = presentesDelDia('*', fecha).find(x => compararNombres(x, nombreTxt));
        }
        if (!nombre && noCuenta(nombreTxt)) { errores.push({ fila: n, error: `"${nombreTxt}" está marcada como "no cuenta" en Control de Ingresos` }); return; }
        if (!nombre) { errores.push({ fila: n, error: `"${nombreTxt}" no está registrada en control de ingreso en ${modulo} el ${aCO(fecha)}` }); return; }

        const salida = minutosDe(fila.horadesalida);
        if (salida == null) { errores.push({ fila: n, error: `La hora de salida "${fila.horadesalida}" no se entiende. Escríbela como 16:00` }); return; }
        const inicio = inicioDe(fecha, nombre);
        if (inicio != null && salida <= inicio) {
          errores.push({ fila: n, error: 'La hora de salida ' + p2(Math.floor(salida / 60)) + ':' + p2(salida % 60)
            + ' es antes de que empiece el turno. Escríbela en 24 horas: las 4 de la tarde son 16:00' });
          return;
        }
        const ref = String(fila.referencia || '').trim().toUpperCase();
        const op = String(fila.op || '').trim();
        const operacion = String(fila.operacion || '').trim().toUpperCase();

        /* Calificación manual: MANUAL en Referencia y en OP, y en Cantidad el % de
           eficiencia de ese día (entero). La hora de salida es la de siempre. */
        if (ref === 'MANUAL' || op.toUpperCase() === 'MANUAL') {
          if (ref !== 'MANUAL' || op.toUpperCase() !== 'MANUAL') {
            errores.push({ fila: n, error: 'Para una calificación manual escribe MANUAL en Referencia y también en OP' }); return;
          }
          if (!permiteManuales(modulo)) { errores.push({ fila: n, error: 'MANUAL solo se usa en Preparación' }); return; }
          if (vacio(fila.cantidad)) { errores.push({ fila: n, error: 'Falta el % de eficiencia en Cantidad' }); return; }
          const pct = Number(fila.cantidad);
          if (!Number.isInteger(pct) || pct < 1 || pct > 300) {
            errores.push({ fila: n, error: 'En MANUAL la cantidad es el % de eficiencia: un número entero entre 1 y 300 (por ejemplo 85)' }); return;
          }
          const peM = personaDe(fecha, nombre, salida, n);
          if (!peM) return;
          if (peM.manual != null) { errores.push({ fila: n, error: nombre + ' tiene dos filas MANUAL el ' + aCO(fecha) }); return; }
          peM.manual = pct; peM.filaManual = n;
          return;
        }

        const faltan = [];
        if (!ref) faltan.push('referencia');
        if (!op) faltan.push('OP');
        if (!operacion) faltan.push('operación');
        if (vacio(fila.cantidad)) faltan.push('cantidad');
        if (faltan.length) { errores.push({ fila: n, error: 'Falta: ' + faltan.join(', ') }); return; }
        const cantidad = Number(fila.cantidad);
        if (!Number.isInteger(cantidad) || cantidad <= 0) { errores.push({ fila: n, error: 'La cantidad debe ser un número entero mayor que cero' }); return; }

        /* Apoyo: APOYO (prestada a otra área, solo incentivo) o DESPACHOS (apoyo
           dentro del área, cuenta para todo) en Referencia y en OP. En Operación
           lo que hizo o el área que apoyó, y en Cantidad los minutos trabajados
           bien: se miden con meta 60, así que minutos = 100%. */
        const apoyo = ref === 'APOYO' ? 'otra_area' : ref === 'DESPACHOS' ? 'despachos' : '';
        if (apoyo || ['APOYO', 'DESPACHOS'].includes(op.toUpperCase())) {
          if (!apoyo || op.toUpperCase() !== ref) {
            errores.push({ fila: n, error: 'Para un apoyo escribe APOYO (otra área) o DESPACHOS en Referencia y lo mismo en OP' }); return;
          }
          if (cantidad > 1440) { errores.push({ fila: n, error: 'En un apoyo la cantidad son los minutos: no puede pasar de 1440' }); return; }
          const peA = personaDe(fecha, nombre, salida, n);
          if (!peA) return;
          peA.filas.push({ ref, op: ref, cliente: '', operacion, cantidad, meta: 60, metaOrigen: 'apoyo', personas: 0, apoyo });
          return;
        }

        /* Improductivo: IMPRODUCTIVO en Referencia y en OP, el nombre (como está
           en Configuración de Producción) en Operación y los minutos en
           Cantidad. Si pide descripción (OTROS): "OTROS - lo que pasó". */
        if (ref === 'IMPRODUCTIVO' || op.toUpperCase() === 'IMPRODUCTIVO') {
          if (ref !== 'IMPRODUCTIVO' || op.toUpperCase() !== 'IMPRODUCTIVO') {
            errores.push({ fila: n, error: 'Para un improductivo escribe IMPRODUCTIVO en Referencia y también en OP' }); return;
          }
          const catalogo = getImproductivos();
          let item = catalogo.find(i => compararNombres(i.nombre, operacion));
          let descripcion = '';
          const partes = operacion.match(/^(.+?)\s*[-–:]\s*(.+)$/);
          if (!item && partes) {
            item = catalogo.find(i => compararNombres(i.nombre, partes[1]));
            if (item) descripcion = partes[2].trim().toUpperCase();
          }
          if (!item) {
            // No está en la lista: se carga como OTROS con su nombre de descripción.
            const otros = catalogo.find(i => compararNombres(i.nombre, 'OTROS'));
            if (!otros) { errores.push({ fila: n, error: `El improductivo ${operacion} no existe en Configuración de Producción` }); return; }
            item = otros;
            descripcion = operacion;
            avisos.push('Fila ' + n + ': ' + operacion + ' no está en la lista de improductivos; se cargó como OTROS - ' + operacion);
          }
          if (item.pideDescripcion && !descripcion) {
            errores.push({ fila: n, error: `${item.nombre} pide descripción: escríbelo como "${item.nombre} - lo que pasó"` }); return;
          }
          const peImp = personaDe(fecha, nombre, salida, n);
          if (!peImp) return;
          peImp.imps.push({ clave: item.clave, descripcion, minutos: cantidad });
          return;
        }

        const orden = ordenes.find(o => String(o.opoc || '').trim() === op);
        if (!orden) { errores.push({ fila: n, error: `La OP ${op} no existe en Órdenes de Producción` }); return; }
        if (normRef(orden.referencia) !== ref) { errores.push({ fila: n, error: `La OP ${op} es de la referencia ${normRef(orden.referencia)}, no de ${ref}` }); return; }
        const fichaRef = fichaMem(ref);
        const opFicha = ((fichaRef || {}).operaciones || []).find(o => String(o.nombre || '').trim().toUpperCase() === operacion);
        if (!opFicha) {
          const k = ref + '|' + operacion;
          if (!faltantes.has(k)) faltantes.set(k, {
            ref, operacion, meta: Number(fila.meta) || 0, filas: [],
            existentes: ((fichaRef || {}).operaciones || []).map(o => ({
              nombre: String(o.nombre || '').trim().toUpperCase(), meta: Number(o.meta) || 0, seCobra: o.seCobra !== false }))
          });
          faltantes.get(k).filas.push(n);
          return;
        }

        // La meta escrita en la plantilla manda: es con la que se midió ese día
        // en papel. Vacía, se usa la del sistema.
        const turnoFila = turnoDeOperario(nombre);
        const kGente = fecha + '|' + (turnoFila ? turnoFila.nombre : '');
        if (!gente.has(kGente)) gente.set(kGente, personasDeModulo(modulo, fecha, turnoFila));
        const calc = metaDeOperacion(opFicha, gente.get(kGente));
        const escrita = Number(fila.meta) || 0;
        let meta = calc.meta, metaOrigen = calc.origen;
        if (escrita > 0) {
          if (meta > 0 && escrita !== meta) metasPropias++;
          meta = escrita; metaOrigen = 'plantilla';
        } else if (!(meta > 0)) {
          errores.push({ fila: n, error: `${operacion} no tiene meta en el sistema: escríbela en la columna Meta` }); return;
        }

        const pe = personaDe(fecha, nombre, salida, n);
        if (!pe) return;
        pe.filas.push({ ref, op, cliente: String(orden.cliente || '').trim(), operacion, cantidad, meta, metaOrigen, personas: gente.get(fecha) });
      });

      porPersona.forEach(pe => {
        // Con MANUAL sí van los descansos y improductivos (descuentan el tiempo igual que
        // en las demás personas); lo que no puede haber son operaciones ni apoyos.
        if (pe.manual != null && pe.filas.length) {
          errores.push({ fila: pe.filaManual, error: pe.nombre + ' tiene MANUAL y también operaciones o apoyos el ' + aCO(pe.fecha) + ': con MANUAL solo pueden ir los descansos e improductivos' });
        }
      });
      if (metasPropias) avisos.unshift(`${metasPropias} fila(s) con una meta distinta a la del sistema: se usó la escrita en la plantilla`);
      if (errores.length) return res.status(400).json({ error: 'El archivo tiene errores. No se cargó nada.', errores: errores.slice(0, 60) });
      if (faltantes.size) return res.status(409).json({ pideOperaciones: true, faltantes: [...faltantes.values()] });
      if (!porPersona.size) return res.status(400).json({ error: 'El archivo no tiene filas llenas para cargar.' });

      /* Personas que ya tienen marcaciones de la tablet ese día: la plantilla las
         reemplaza (marcaciones e improductivos con su nombre), pero antes se
         pregunta en pantalla. Lo quitado no se borra del todo: queda en
         contador_reemplazados por si hay que revisarlo. */
      const historialActual = historialNormalizado();
      const deTablet = pe => r => r.origen !== 'plantilla' && r.fecha === pe.fecha
        && compararNombres(r.modulo, MOD) && compararNombres(r.operario, pe.nombre);
      const impDeTablet = pe => x => x.origen !== 'plantilla' && x.fechaISO === pe.fecha
        && compararNombres(x.modulo, MOD) && !!x.empleada && compararNombres(x.empleada, pe.nombre);
      const reemplazos = [...porPersona.values()]
        .filter(pe => conTablet.has(pe.fecha + '|' + pe.nombre.toUpperCase()))
        .map(pe => ({ pe, fecha: pe.fecha, nombre: pe.nombre,
                      marcaciones: registros.filter(deTablet(pe)).length,
                      improductivos: historialActual.filter(impDeTablet(pe)).length }));
      if (reemplazos.length && String((req.body && req.body.confirmarReemplazo) || '') !== '1') {
        return res.status(409).json({ pideReemplazo: true, reemplazos: reemplazos.map(({ pe, ...r }) => r) });
      }

      const hhmm = m => p2(Math.floor(m / 60)) + ':' + p2(m % 60);
      const quien = (req.auth && req.auth.user) || '';
      const claves = new Set(porPersona.keys());
      const cargadaAntes = r => r.origen === 'plantilla' && compararNombres(r.modulo, MOD)
                             && claves.has(r.fecha + '|' + String(r.operario || '').trim().toUpperCase());
      const quitados = [];
      const lista = registros.filter(r => {
        if (cargadaAntes(r)) return false;
        if (reemplazos.some(x => deTablet(x.pe)(r))) { quitados.push({ tipo: 'registro', dato: r }); return false; }
        return true;
      });
      const cierres = loadDB('cierres_turno') || [];
      let filas = 0;
      porPersona.forEach(pe => {
        // La salida va en cuartos de hora, hacia abajo, igual que "Terminar turno".
        const hora = hhmm(Math.floor(pe.salida / 15) * 15);
        const cuando = new Date(pe.fecha + 'T' + hora + ':00-05:00').toISOString();
        pe.filas.forEach(f => {
          lista.push({
            id: uuidv4(), modulo, operario: pe.nombre, turno: '',
            op: f.op, ref: f.ref, cliente: f.cliente, operacion: f.operacion,
            tipo: 'produccion', cantidad: f.cantidad, personas: f.personas,
            metaUsada: f.meta, metaOrigen: f.metaOrigen,
            ...(f.apoyo ? { apoyo: f.apoyo } : {}),
            fecha: pe.fecha, fechaTurno: pe.fecha, hora, timestamp: cuando,
            origen: 'plantilla', cargadoPor: quien, cargadoEn: new Date().toISOString()
          });
          filas++;
        });
        const idx = cierres.findIndex(c => c.fecha === pe.fecha && compararNombres(c.modulo, MOD)
                                         && String(c.operario || '').toUpperCase() === pe.nombre.toUpperCase());
        if (idx >= 0) cierres[idx] = { ...cierres[idx], horaPlantilla: hora };
        else cierres.push({ fecha: pe.fecha, modulo, operario: pe.nombre, horaPlantilla: hora });
      });
      // Calificaciones manuales: reemplazan lo que hubiera de esa persona y día
      // (también si ahora el día se carga con operaciones).
      let manuales = (loadDB('eficiencias_manuales') || []).filter(m =>
        !(compararNombres(m.modulo, MOD) && claves.has(String(m.fecha) + '|' + String(m.operario || '').trim().toUpperCase())));
      let nManuales = 0;
      porPersona.forEach(pe => {
        if (pe.manual == null) return;
        manuales.push({ id: uuidv4(), modulo, operario: pe.nombre, fecha: pe.fecha, pct: pe.manual,
                        cargadoPor: quien, cargadoEn: new Date().toISOString() });
        nManuales++;
      });
      /* Improductivos: en el papel no hay horas, solo minutos. Se ponen seguidos
         terminando a la hora de salida (15 min de desayuno y 30 de reunión con
         salida a las 4:00 → reunión 3:15–3:45 y desayuno 3:45–4:00). Las horas
         no son las reales; los minutos sí, y descuentan como los de la tablet. */
      const comoReloj = min => {
        const h24 = Math.floor(min / 60) % 24, mm = min % 60;
        const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
        return `${h12}:${p2(mm)}:00 ${h24 < 12 ? 'a. m.' : 'p. m.'}`;
      };
      let historial = historialActual.filter(r => {
        if (r.origen === 'plantilla' && compararNombres(r.modulo, MOD)
            && claves.has(r.fechaISO + '|' + String(r.empleada || '').trim().toUpperCase())) return false;
        if (reemplazos.some(x => impDeTablet(x.pe)(r))) { quitados.push({ tipo: 'improductivo', dato: r }); return false; }
        return true;
      });
      let improductivos = 0;
      porPersona.forEach(pe => {
        let fin = Math.floor(pe.salida / 15) * 15;
        const [aa, mm, dd] = pe.fecha.split('-');
        // De noche la salida es de madrugada: las paradas pueden quedar antes
        // de medianoche (la hora de reloj da la vuelta; fechaTurno las amarra
        // al día del turno).
        const noche = (() => { const t = turnoDeOperario(pe.nombre); return !!(t && MillarEficiencia.inicioDelTurno(t).cruzaMedianoche); })();
        [...pe.imps].reverse().forEach(im => {
          const ini = noche ? fin - im.minutos : Math.max(0, fin - im.minutos);
          historial.push({
            id: uuidv4(), num: historial.filter(r => r.fechaISO === pe.fecha).length + 1,
            fecha: `${dd}/${mm}/${aa}`, fechaISO: pe.fecha,
            horaInicio: comoReloj((ini + 1440) % 1440), hora: comoReloj((fin + 1440) % 1440), fechaTurno: pe.fecha,
            modulo, tipo: im.clave, estadoAnterior: im.clave, estadoNuevo: 'green',
            durMinutos: im.minutos, mecanico: '', empleada: pe.nombre, operacion: '',
            nombreTipo: nombreDeImproductivo(im.clave),
            ...(im.descripcion ? { descripcion: im.descripcion } : {}),
            origen: 'plantilla', cargadoPor: quien, observacion: 'Cargado por plantilla (horas aproximadas)'
          });
          fin = ini;
          improductivos++;
        });
      });
      if (historial.length > HISTORIAL_MAX) historial = historial.slice(-HISTORIAL_MAX);

      // Primero lo quitado (para que siempre quede rastro) y las operaciones nuevas.
      if (quitados.length) {
        const ahora = new Date().toISOString();
        let archivo = (loadDB('contador_reemplazados') || []).concat(quitados.map(q => ({
          ...q, fecha: q.dato.fecha || q.dato.fechaISO, operario: q.dato.operario || q.dato.empleada,
          modulo, reemplazadoEn: ahora, reemplazadoPor: quien, motivo: 'Reemplazado por plantilla de registros manuales'
        })));
        if (archivo.length > 20000) archivo = archivo.slice(-20000);
        if (!saveDB('contador_reemplazados', archivo)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      }
      if (creadas.length && !saveDB('fichas', fichasMem)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      if (!saveDB('contador_produccion', lista) || !saveDB('cierres_turno', cierres) || !writeJSON(FILES.historial, historial)
          || !saveDB('eficiencias_manuales', manuales)) {
        return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
      }
      if (creadas.length) recalcularMetasDeHoy(r => creadas.some(c => normRef(r.ref) === c.ref), 'plantilla manual');
      res.json({ ok: true, personas: porPersona.size, filas, improductivos, manuales: nManuales, avisos,
                 creadas: creadas.map(c => c.ref + ' · ' + c.operacion),
                 reemplazadas: reemplazos.map(x => x.nombre + ' (' + aCO(x.fecha) + ')') });
    } catch (e) {
      console.error('Error [POST contador-produccion/cargar-manual]:', e.message);
      res.status(500).json({ error: e.message, donde: 'POST contador-produccion/cargar-manual' });
    }
  });
});

app.get('/api/contador-produccion/cierres-turno', (req, res) => {
  try {
    const { desde, hasta, modulo } = req.query;
    let cierres = loadDB('cierres_turno') || [];
    if (desde)  cierres = cierres.filter(c => String(c.fecha) >= String(desde));
    if (hasta)  cierres = cierres.filter(c => String(c.fecha) <= String(hasta));
    if (modulo) cierres = cierres.filter(c => String(c.modulo).toUpperCase() === String(modulo).toUpperCase());
    res.json({ ok: true, cierres });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Autoriza los borrados de las pantallas de Registros (Produccion, Calidad e
   Improductivos). Solo valia la contrasena del perfil Programador, y eso dejaba
   fuera a los administradores: veian el boton de la papelera, escribian SU clave
   y les decia 'incorrecta', sin explicar por que. El servidor ya les dejaba
   borrar (requireMando); era esta puerta la que no.
   Ahora usa la misma regla que /api/verify-pass y /api/verificar-clave-accion:
   la clave de accion, un perfil con mando, o un administrador por cedula. */
app.post('/api/verificar-clave', (req, res) => {
  try {
    if (bloqueadoPorFallos(req)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera un minuto.' });
    const pass = String((req.body || {}).pass == null ? '' : (req.body || {}).pass);
    if (!claveAccionValida('general', pass)) {
      anotarFallo(req);
      console.warn(`[AUTH] verificar-clave fallida desde IP ${req.ip}`);
      return res.status(401).json({ ok: false, error: 'Contraseña incorrecta' });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// Editar y crear registros lo puede hacer quien tenga el permiso de ESA
// pantalla — no solo el Programador. Se comprueba en el servidor y no solo en
// el menu: el candado del menu esconde el boton, pero no cierra la puerta.
// Borrar sigue siendo cosa del Programador (ver requireMando).
// Acepta varias claves porque una misma ruta puede servir a dos pantallas: los
// registros de produccion y el reporte de calidad viven en la misma lista.
function requirePermiso(...claves) {
  return (req, res, next) => requireAuth(req, res, () => {
    // Sirve para los dos caminos: perfil de siempre y cedula de persona.
    if (tienePermiso(req.auth, claves)) return next();
    return res.status(403).json({ error: 'No tienes permiso para esta pantalla' });
  });
}

// ¿Quien hace la peticion puede cambiar perfiles y miembros? El Programador o
// un perfil con permiso de Configuraciones o "fix".
const CLAVES_CONFIG_ADMIN = ['_usuarios_extra', '_perfil_members'];
function esAdministrador(req) {
  const hdr   = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-session-token'] || '');
  const p = verifyToken(token);
  if (!p) return false;
  return permisosDeLaPeticion(p).admin;
}

/* Antes esto exigia literalmente el perfil "Programador". Una persona que
   entra con su cedula tiene el perfil vacio, asi que NINGUN administrador
   pasaba por aqui: catorce operaciones —borrar registros, la configuracion de
   produccion, el valor minuto, el catalogo de improductivos, Preparacion—
   quedaban fuera de su alcance aunque estuviera marcado como administrador.

   Ahora pasa quien tiene el mando: el perfil Programador, que sigue existiendo
   como puerta de emergencia, y cualquier administrador. */
function requireMando(req, res, next) {
  requireAuth(req, res, () => {
    const { admin } = permisosDeLaPeticion(req.auth);
    if (admin) return next();
    return res.status(403).json({ error: 'Solo un administrador puede hacer esto' });
  });
}

// ── Registro creado a mano desde la pantalla de consulta ──────────────
// El registro normal lo sella el Contador con la fecha y la hora del momento.
// Aqui hace falta lo contrario: poder registrar lo que la operaria no alcanzo a
// contar — por ejemplo la 1ra hora de ayer. Por eso es una ruta aparte y no un
// parametro opcional de la otra: las tablets no deben poder cambiar la fecha.
//
// La hora que llega es la del reloj DENTRO del bloque del turno que se eligio,
// para que la fila salga en la hora correcta sin guardar un dato nuevo.
app.post('/api/contador-produccion/registro-manual', requireAccion('crear', 'registros_produccion', 'reporte_calidad'), (req, res) => {
  try {
    const { modulo, operario, op, ref, cliente, tipo, cantidad, operacion, tipoDefecto, fecha, hora } = req.body || {};
    const moduloN    = String(modulo || '').trim();
    const operarioN  = String(operario || '').trim();
    const opN        = String(op || '').trim();
    const operacionN = String(operacion || '').trim().toUpperCase();
    const cantidadN  = Number(cantidad);
    const fechaN     = String(fecha || '').slice(0, 10);
    const horaN      = String(hora || '').trim();

    if (!moduloN || !operarioN || !opN) return res.status(400).json({ error: 'Módulo, operario y OP son obligatorios' });
    if (!operacionN)                    return res.status(400).json({ error: 'Falta indicar la operación' });
    if (tipo !== 'produccion' && tipo !== 'calidad') return res.status(400).json({ error: 'Tipo inválido' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaN))       return res.status(400).json({ error: 'Fecha inválida' });
    if (!/^\d{2}:\d{2}$/.test(horaN))               return res.status(400).json({ error: 'Elige la hora del turno' });
    if (fechaN > fechaHoyCO())                      return res.status(400).json({ error: 'No se puede registrar producción de un día que todavía no llega' });
    if (!Number.isInteger(cantidadN) || cantidadN <= 0) return res.status(400).json({ error: 'La cantidad debe ser un número entero mayor que cero' });

    let tipoDefectoN = '';
    if (tipo === 'calidad') {
      tipoDefectoN = String(tipoDefecto || '').trim().toUpperCase();
      if (!tipoDefectoN) return res.status(400).json({ error: 'Elige el tipo de defecto' });
      if (!(loadDB('lt_defectos') || []).some(d => d.nombre === tipoDefectoN)) {
        return res.status(400).json({ error: `El tipo de defecto "${tipoDefectoN}" no existe en Configuraciones` });
      }
    }

    // El mismo tope que en el Contador: si no, registrar a mano seria la puerta
    // de atras para pasarse del lote.
    let cantidadFinal = cantidadN;
    let avisoLote = null;
    const cupo = cupoDelLote(opN, operacionN, tipo, cantidadN);
    if (cupo && cupo.restante <= 0) {
      return res.status(409).json({
        error: `El lote ya está completo: ${cupo.hechas} de ${cupo.total} en ${operacionN}`,
        loteCompleto: true, total: cupo.total, hechas: cupo.hechas
      });
    }
    if (cupo && cantidadN > cupo.restante) {
      cantidadFinal = cupo.restante;
      avisoLote = `Solo se registraron ${cantidadFinal}: el lote quedó completo (${cupo.total} de ${cupo.total})`;
    }

    // La meta se calcula con la gente que habia ESE dia, no la de hoy.
    const personas = personasDeModulo(moduloN, fechaTurnoDe(operarioN, fechaN, horaN), turnoDeOperario(operarioN));
    const opFicha  = ((fichaDe(ref) || {}).operaciones || [])
      .find(o => String(o.nombre || '').toUpperCase() === operacionN);
    const resuelta = metaDeOperacion(opFicha, personas);

    const nuevo = {
      id: uuidv4(),
      modulo: moduloN, operario: operarioN, turno: '',
      op: opN, ref: String(ref || '').trim(), cliente: String(cliente || '').trim(),
      operacion: operacionN,
      tipo, cantidad: cantidadFinal,
      ...(tipoDefectoN ? { tipoDefecto: tipoDefectoN } : {}),
      personas,
      metaUsada: resuelta.meta,
      metaOrigen: resuelta.origen,
      fecha: fechaN,
      hora: horaN,
      timestamp: new Date().toISOString(),
      // Queda constancia de que no lo conto la operaria en su momento.
      creadoAMano: true,
      creadoPor: (req.auth && req.auth.user) || ''
    };
    const lista = loadDB('contador_produccion') || [];
    lista.push(nuevo);
    if (!saveDB('contador_produccion', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    broadcast({ type: 'cp_registro', registro: nuevo });
    res.json({ ok: true, registro: nuevo, ...(avisoLote ? { avisoLote } : {}) });
  } catch (e) {
    console.error('Error [POST registro-manual]:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/contador-produccion/registro/:id', requireAccion('editar', 'registros_produccion', 'reporte_calidad'), (req, res) => {
  try {
    const lista = loadDB('contador_produccion') || [];
    const idx = lista.findIndex(r => r.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Registro no encontrado' });
    const b = req.body || {};
    const cambios = {};

    if (b.cantidad !== undefined) {
      const cantidad = Number(b.cantidad);
      if (!cantidad || cantidad <= 0 || !Number.isInteger(cantidad)) {
        return res.status(400).json({ error: 'La cantidad debe ser un número entero mayor a cero' });
      }
      cambios.cantidad = cantidad;
    }
    // La operación es lo que decide contra qué avance suma el registro, así que
    // tiene que existir en la ficha de esa referencia; si no, el conteo se
    // quedaría colgado de una operación que nadie mide.
    if (b.operacion !== undefined) {
      const operacion = String(b.operacion || '').trim().toUpperCase();
      if (!operacion) return res.status(400).json({ error: 'La operación no puede quedar vacía' });
      cambios.operacion = operacion;
    }
    if (b.op  !== undefined) {
      const op = String(b.op || '').trim();
      if (!op) return res.status(400).json({ error: 'La OP no puede quedar vacía' });
      cambios.op = op;
    }
    // La meta se congela al registrar, pero a veces se congela mal: si nadie
    // habia pasado asistencia todavia quedo en 0, y esa hora salio sin meta.
    // Por eso se puede corregir a mano. Cambiarla mueve la eficiencia y la
    // productividad de esa hora, que es justo lo que se busca.
    if (b.metaUsada !== undefined) {
      const meta = Number(b.metaUsada);
      if (!Number.isFinite(meta) || meta < 0) return res.status(400).json({ error: 'La meta debe ser un número de cero para arriba' });
      cambios.metaUsada  = Math.round(meta);
      cambios.metaOrigen = 'manual';
    }
    if (b.ref      !== undefined) cambios.ref      = String(b.ref || '').trim().toUpperCase();
    if (b.modulo   !== undefined) {
      const modulo = String(b.modulo || '').trim().toUpperCase();
      if (!modulo) return res.status(400).json({ error: 'El módulo no puede quedar vacío' });
      cambios.modulo = modulo;
    }
    if (b.operario !== undefined) {
      const operario = String(b.operario || '').trim();
      if (!operario) return res.status(400).json({ error: 'La persona no puede quedar vacía' });
      cambios.operario = operario;
    }
    if (b.tipoDefecto !== undefined) {
      const td = String(b.tipoDefecto || '').trim().toUpperCase();
      if (lista[idx].tipo === 'calidad') {
        if (!td) return res.status(400).json({ error: 'Elige el tipo de defecto' });
        if (!(loadDB('lt_defectos') || []).some(d => compararNombres(d.nombre, td))) {
          return res.status(400).json({ error: `El tipo de defecto "${td}" no existe en Configuraciones` });
        }
        cambios.tipoDefecto = td;
      }
    }
    if (!Object.keys(cambios).length) return res.status(400).json({ error: 'No hay nada que cambiar' });

    lista[idx] = { ...lista[idx], ...cambios, editadoPor: req.auth.user, editadoEn: new Date().toISOString() };
    if (!saveDB('contador_produccion', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    // Una corrección del admin también debe verse en las tablets del piso.
    broadcast({ type: 'cp_registro_update', accion: 'editar', registro: lista[idx] });
    res.json({ ok: true, registro: lista[idx] });
  } catch (e) {
    console.error('Error [PUT contador-produccion/registro]:', e.message);
    res.status(500).json({ error: e.message, donde: 'PUT contador-produccion/registro' });
  }
});

// Cambiar la meta de muchos registros de una vez (Registros de Producción →
// "Cambiar meta" o "Todos"). Uno por uno tardaba: cada cambio guardaba el día
// entero otra vez. Aquí se guarda una sola vez.
app.put('/api/contador-produccion/registros/meta', requireAccion('editar', 'registros_produccion'), (req, res) => {
  try {
    const b = req.body || {};
    const ids = new Set((Array.isArray(b.ids) ? b.ids : []).map(String));
    const meta = Number(b.metaUsada);
    if (!ids.size) return res.status(400).json({ error: 'No llegó ningún registro' });
    if (!Number.isFinite(meta) || meta <= 0) return res.status(400).json({ error: 'La meta debe ser un número mayor que cero' });
    const lista = loadDB('contador_produccion') || [];
    const ahora = new Date().toISOString();
    const cambiados = [];
    lista.forEach((r, i) => {
      if (!ids.has(String(r.id)) || r.tipo !== 'produccion') return;
      lista[i] = { ...r, metaUsada: Math.round(meta), metaOrigen: 'manual', editadoPor: req.auth.user, editadoEn: ahora };
      cambiados.push(lista[i]);
    });
    if (!cambiados.length) return res.status(404).json({ error: 'No se encontraron esos registros' });
    if (!saveDB('contador_produccion', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    cambiados.forEach(r => broadcast({ type: 'cp_registro_update', accion: 'editar', registro: r }));
    res.json({ ok: true, cambiados: cambiados.length, noEncontrados: ids.size - cambiados.length });
  } catch (e) {
    console.error('Error [PUT contador-produccion/registros/meta]:', e.message);
    res.status(500).json({ error: e.message, donde: 'PUT contador-produccion/registros/meta' });
  }
});

app.delete('/api/contador-produccion/registro/:id', requireMando, (req, res) => {
  try {
    const lista = loadDB('contador_produccion') || [];
    const idx = lista.findIndex(r => r.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'Registro no encontrado' });
    const borrado = lista[idx];
    lista.splice(idx, 1);
    if (!saveDB('contador_produccion', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    broadcast({ type: 'cp_registro_update', accion: 'eliminar', registro: borrado });
    res.json({ ok: true });
  } catch (e) {
    console.error('Error [DELETE contador-produccion/registro]:', e.message);
    res.status(500).json({ error: e.message, donde: 'DELETE contador-produccion/registro' });
  }
});

// ── API Producción (Tablero Kanban) ──────────────────────────────
app.get('/api/produccion', (req, res) => {
  res.json(loadDB('produccion') || { boards: {}, history: [] });
});

app.post('/api/produccion', requirePermiso('tablero_produccion'), (req, res) => {
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
app.post('/api/incentivos', requireAccion('crear', 'consulta_incentivos'), (req, res) => {
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
app.patch('/api/incentivos/:id', requireAccion('editar', 'consulta_incentivos'), (req, res) => {
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
app.delete('/api/incentivos/:id', requireAccion('borrar', 'consulta_incentivos'), (req, res) => {
  try {
    const data = loadDB('incentivos') || [];
    const filtrado = data.filter(r => r.id !== req.params.id);
    if (filtrado.length === data.length) return res.status(404).json({ error: 'Registro no encontrado' });
    if (!saveDB('incentivos', filtrado)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE: borrar por mes (?mes=) o todo (?all=1)
app.delete('/api/incentivos', requireAccion('borrar', 'consulta_incentivos'), (req, res) => {
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

/* ── Incentivos diarios ───────────────────────────────────────────────
   Los mensuales son por persona (cédula y contrato); estos son por MÓDULO y
   por día. Van aparte, en su propio almacén, porque no se cruzan: uno lo
   consulta la operaria con su contrato y el otro lo ve el módulo en su tablet.

   El servidor no calcula nada: el valor del día y el acumulado se cargan por
   Excel, igual que los mensuales. Aquí solo se guardan y se entregan. */
const normModulo = v => String(v == null ? '' : v).trim().toUpperCase();
// "05/09/2026", "2026-09-05" o una fecha de Excel → "2026-09-05".
function normFechaDia(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date && !isNaN(v)) {
    return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0')
         + '-' + String(v.getDate()).padStart(2, '0');
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (m) return m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0');
  return '';
}
/* Plata escrita como sea → número.

   El punto es la trampa: en Colombia "12.000" son doce mil, pero para el
   código "12.000" es doce con cero. Sin esta distinción un incentivo de
   $12.000 entraba como $12 y el informe quedaba mudo. */
const normPlata = v => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v == null ? '' : v).replace(/[^\d,.-]/g, '');
  if (!s) return 0;
  const negativo = s.trim().startsWith('-');
  s = s.replace(/-/g, '');
  if (s.includes(',')) {
    // Hay coma: la coma son los decimales y los puntos son de miles.
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(s)) {
    // "12.000", "1.234.567": puntos de miles, sin decimales.
    s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? (negativo ? -n : n) : 0;
};

/* El porcentaje escrito como sea → número.
   Acepta "92", "92%", "92,5" y también 0,92 (que en Excel es como queda una
   celda con formato de porcentaje): si llega entre 0 y 1 se entiende que es
   una fracción y se pasa a porcentaje. */
const normPorcentaje = v => {
  if (v === '' || v == null) return null;
  let n = (typeof v === 'number') ? v : normPlata(String(v).replace('%', ''));
  if (!Number.isFinite(n)) return null;
  if (n > 0 && n <= 1) n = n * 100;
  return Math.round(n * 10) / 10;
};

app.get('/api/incentivos-diarios', (req, res) => {
  try {
    let data = loadDB('incentivos_diarios') || [];
    const modulo = req.query.modulo != null ? normModulo(req.query.modulo) : null;
    const desde  = normFechaDia(req.query.desde);
    const hasta  = normFechaDia(req.query.hasta);
    if (modulo) data = data.filter(r => normModulo(r.modulo) === modulo);
    if (desde)  data = data.filter(r => String(r.fecha || '') >= desde);
    if (hasta)  data = data.filter(r => String(r.fecha || '') <= hasta);
    data = data.slice().sort((a, b) =>
      String(a.fecha).localeCompare(String(b.fecha)) || normModulo(a.modulo).localeCompare(normModulo(b.modulo)));
    res.json({ ok: true, registros: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Carga por Excel. Body = { rows: [{fecha, modulo, dia, acumulado}] }.
// Upsert por fecha+módulo: volver a subir el mismo día lo corrige, no lo duplica.
app.post('/api/incentivos-diarios', requireAccion('crear', 'consulta_incentivos'), (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : (req.body && req.body.rows);
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'Se esperaba { rows: [...] }' });

    const data  = loadDB('incentivos_diarios') || [];
    const byKey = new Map();
    data.forEach(r => byKey.set(normFechaDia(r.fecha) + '|' + normModulo(r.modulo), r));

    let guardadas = 0, omitidas = 0;
    rows.forEach(r => {
      const fecha  = normFechaDia(r.fecha);
      const modulo = normModulo(r.modulo);
      if (!fecha || !modulo) { omitidas++; return; }   // fila incompleta
      const reg = {
        id:        (byKey.get(fecha + '|' + modulo) || {}).id || uuidv4(),
        fecha, modulo,
        dia:       normPlata(r.dia),
        acumulado: normPlata(r.acumulado),
        // El porcentaje viene en el Excel, no se calcula aquí: es el mismo
        // dato con el que se liquidó el incentivo de ese día.
        eficiencia: normPorcentaje(r.eficiencia)
      };
      byKey.set(fecha + '|' + modulo, reg);
      guardadas++;
    });

    if (!saveDB('incentivos_diarios', [...byKey.values()])) {
      return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true, guardadas, omitidas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Editar una fila. Se puede cambiar todo, pero la pareja fecha + módulo no
// puede quedar igual a la de OTRA fila: la importación trata esa pareja como
// llave única, y dos filas iguales harían que el siguiente Excel pisara una
// cualquiera de las dos.
//
// El acumulado NO se recalcula al cambiar el valor del día: es la cifra de la
// liquidación que viene en el Excel, y se guarda tal como se escriba.
app.patch('/api/incentivos-diarios/:id', requireAccion('editar', 'consulta_incentivos'), (req, res) => {
  try {
    const data = loadDB('incentivos_diarios') || [];
    const idx  = data.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Ese registro ya no existe. Recarga la página.' });
    const b = req.body || {};
    const actual = data[idx];

    const fecha  = b.fecha  !== undefined ? normFechaDia(b.fecha) : normFechaDia(actual.fecha);
    const modulo = b.modulo !== undefined ? normModulo(b.modulo)  : normModulo(actual.modulo);
    if (!fecha)  return res.status(400).json({ error: 'La fecha no es válida.' });
    if (!modulo) return res.status(400).json({ error: 'Falta el módulo.' });

    const choca = data.find(r => r.id !== actual.id
      && normFechaDia(r.fecha) === fecha && normModulo(r.modulo) === modulo);
    if (choca) {
      const f = fecha.split('-').reverse().join('/');
      return res.status(409).json({ error: 'Ya existe otra fila de ' + modulo + ' el ' + f + '. Corrige esa en vez de repetirla.' });
    }

    data[idx] = {
      ...actual,
      fecha, modulo,
      dia:        b.dia        !== undefined ? normPlata(b.dia)             : actual.dia,
      acumulado:  b.acumulado  !== undefined ? normPlata(b.acumulado)       : actual.acumulado,
      eficiencia: b.eficiencia !== undefined ? normPorcentaje(b.eficiencia) : actual.eficiencia
    };
    if (!saveDB('incentivos_diarios', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, registro: data[idx] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Borrar una sola fila.
app.delete('/api/incentivos-diarios/:id', requireAccion('borrar', 'consulta_incentivos'), (req, res) => {
  try {
    const data = loadDB('incentivos_diarios') || [];
    const quedan = data.filter(r => r.id !== req.params.id);
    if (quedan.length === data.length) return res.status(404).json({ error: 'Ese registro ya no existe. Recarga la página.' });
    if (!saveDB('incentivos_diarios', quedan)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/incentivos-diarios', requireAccion('borrar', 'consulta_incentivos'), (req, res) => {
  try {
    const data = loadDB('incentivos_diarios') || [];
    if (!saveDB('incentivos_diarios', [])) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, eliminados: data.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Carga por Excel de los incentivos que son de la PERSONA, no del módulo
   (Empaque). Body = { rows: [{fecha, persona, modulo, eficiencia, valor}] }.
   Upsert por fecha + persona: volver a subir el mismo día lo corrige. */
app.post('/api/incentivos-individuales', requireAccion('crear', 'consulta_incentivos'), (req, res) => {
  try {
    const rows = Array.isArray(req.body) ? req.body : (req.body && req.body.rows);
    if (!Array.isArray(rows)) return res.status(400).json({ error: 'Se esperaba { rows: [...] }' });
    const data = loadDB('incentivos_individuales') || [];
    const byKey = new Map();
    data.forEach(r => byKey.set(normFechaDia(r.fecha) + '|' + llavePersona(r.persona), r));

    let guardadas = 0, omitidas = 0;
    rows.forEach(r => {
      const fecha = normFechaDia(r.fecha);
      const persona = String(r.persona || '').trim();
      if (!fecha || !persona) { omitidas++; return; }           // fila incompleta
      const k = fecha + '|' + llavePersona(persona);
      byKey.set(k, {
        id: (byKey.get(k) || {}).id || uuidv4(),
        fecha, persona,
        modulo: normModulo(r.modulo),
        eficiencia: normPorcentaje(r.eficiencia),
        valor: normPlata(r.valor)
      });
      guardadas++;
    });
    if (!saveDB('incentivos_individuales', [...byKey.values()])) {
      return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true, guardadas, omitidas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/incentivos-individuales', requireAccion('borrar', 'consulta_incentivos'), (req, res) => {
  try {
    const data = loadDB('incentivos_individuales') || [];
    if (!saveDB('incentivos_individuales', [])) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, eliminados: data.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Incentivos individuales ──────────────────────────────────────────
   Aquí no se carga nada: se cruza lo que ya existe. Control de Asistencia
   dice en qué módulo estuvo cada persona ese día e Incentivos Diarios dice
   cuánto dio ese módulo ese día; quien estuvo PRESENTE en un módulo con
   incentivo cargado tiene su fila con ese valor.

   Si a una persona la registraron el mismo día en dos módulos salen las dos
   filas, a propósito: así se ve el dato raro para corregirlo en Asistencia.
   La gente de Empaque no aparece: su incentivo es individual y vive en el
   Informe de Empaque, no en esta tabla por módulo. */
// El nombre como llave: sin tildes, sin dobles espacios y en mayúsculas.
const llavePersona = v => String(v == null ? '' : v).trim().toUpperCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');

app.get('/api/incentivos-individuales', (req, res) => {
  try {
    const desde = normFechaDia(req.query.desde);
    const hasta = normFechaDia(req.query.hasta);
    const quien = llavePersona(req.query.persona);
    const enRango = fecha => !!fecha && (!desde || fecha >= desde) && (!hasta || fecha <= hasta);
    /* Lo cargado a mano manda sobre lo calculado: si esa persona ya tiene su
       día cargado (Empaque, donde cada una tiene su propio valor), ese es. */
    const cargadas = new Map();
    const filas = [];
    (loadDB('incentivos_individuales') || []).forEach(r => {
      const fecha = normFechaDia(r.fecha);
      const persona = String(r.persona || '').trim();
      if (!fecha || !persona || !enRango(fecha)) return;
      if (quien && llavePersona(persona) !== quien) return;
      cargadas.set(fecha + '|' + llavePersona(persona), true);
      filas.push({
        fecha, persona, modulo: normModulo(r.modulo),
        eficiencia: r.eficiencia == null ? null : Number(r.eficiencia),
        valor: Number(r.valor) || 0, origen: 'cargado'
      });
    });
    const delDia = new Map();
    (loadDB('incentivos_diarios') || []).forEach(r => {
      delDia.set(normFechaDia(r.fecha) + '|' + normModulo(r.modulo), r);
    });
    const regs = loadDB('ia_records') || [];
    const lista = Array.isArray(regs) ? regs : (Object.values(regs).find(v => Array.isArray(v)) || []);
    const vistas = new Set();
    lista.forEach(r => {
      const fecha = String(r.date || '').slice(0, 10);
      if (!enRango(fecha)) return;
      if (String(r.status || '').toLowerCase() !== 'presente') return;
      const modulo = normModulo(r.area);
      const persona = String(r.empName || '').trim();
      if (!modulo || !persona) return;
      if (quien && llavePersona(persona) !== quien) return;
      if (cargadas.has(fecha + '|' + llavePersona(persona))) return;   // ese día ya vino cargado
      const inc = delDia.get(fecha + '|' + modulo);
      if (!inc) return;                                  // ese módulo no tiene incentivo ese día
      const k = fecha + '|' + llavePersona(persona) + '|' + modulo;
      if (vistas.has(k)) return;                         // la misma persona anotada dos veces
      vistas.add(k);
      filas.push({
        fecha, persona, modulo,
        eficiencia: inc.eficiencia == null ? null : inc.eficiencia,
        valor: Number(inc.dia) || 0, origen: 'modulo'
      });
    });
    filas.sort((a, b) => String(a.fecha).localeCompare(String(b.fecha))
                      || a.persona.localeCompare(b.persona, 'es')
                      || String(a.modulo).localeCompare(String(b.modulo)));
    res.json({ ok: true, filas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Calificación de Preparación ──────────────────────────────────────
   Reemplaza el Excel F-PR-30. Una fila por operación, igual que la hoja
   Historico: las horas, los improductivos, la eficiencia, el incentivo y la
   observación van en la PRIMERA fila de cada persona y día.

   El servidor RECALCULA todo (millar-preparacion.js) con los tramos del
   incentivo de Configuración de Producción: lo que manda la pantalla son los
   datos que se digitaron, no los resultados.

   Quien se pasó a un módulo ese día (operación M04, M22...) no tiene meta:
   su porcentaje y su incentivo salen del incentivo diario de ese módulo. */
const PREP_STORE = 'preparacion_registros';
const prepNombre = v => String(v == null ? '' : v).trim();
const prepClave = v => prepNombre(v).toUpperCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ');
const prepNum = v => {
  if (v === '' || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
// El incentivo del módulo ese día, para quien pasó a módulo.
function prepIncentivoDeModulo(fecha, operacion) {
  const modulo = MillarPreparacion.claveModulo(operacion);
  if (!modulo) return null;
  const fila = (loadDB('incentivos_diarios') || [])
    .find(r => normFechaDia(r.fecha) === fecha && normModulo(r.modulo) === modulo);
  if (!fila) return null;
  return {
    modulo,
    eficiencia: fila.eficiencia == null ? null : Number(fila.eficiencia) / 100,
    incentivo: Number(fila.dia) || 0
  };
}

app.get('/api/preparacion/operarias', requireMando, (req, res) => {
  try {
    const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
    const area = String(req.query.area || 'PREPARACIÓN').trim().toUpperCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const suyas = (st.employees || [])
      .filter(e => e && !e.disabled && e.name)
      .filter(e => prepClave(e.module || e.modulo || '') === area)
      .map(e => prepNombre(e.name))
      .sort((a, b) => a.localeCompare(b, 'es'));
    // Todas las demás, por si alguien de otra área se califica aquí.
    const otras = (st.employees || [])
      .filter(e => e && !e.disabled && e.name && prepClave(e.module || e.modulo || '') !== area)
      .map(e => prepNombre(e.name))
      .sort((a, b) => a.localeCompare(b, 'es'));
    res.json({ ok: true, operarias: suyas, otras });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/preparacion/registros', requireMando, (req, res) => {
  try {
    const desde = normFechaDia(req.query.desde), hasta = normFechaDia(req.query.hasta);
    const mes = String(req.query.mes || '').slice(0, 7);
    let data = loadDB(PREP_STORE) || [];
    if (mes) data = data.filter(r => String(r.fecha || '').slice(0, 7) === mes);
    if (desde) data = data.filter(r => String(r.fecha || '') >= desde);
    if (hasta) data = data.filter(r => String(r.fecha || '') <= hasta);
    res.json({ ok: true, registros: data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Guardar el día. Body = { fecha, personas: [{ operaria, salida, impro,
   hrsModulo, obs, operaciones: [{ referencia, operacion, orden, und, meta }] }] }
   Vuelve a guardar la misma persona y fecha: se reemplaza. */
app.put('/api/preparacion/registros', requireMando, (req, res) => {
  try {
    const b = req.body || {};
    const fecha = normFechaDia(b.fecha);
    const personas = Array.isArray(b.personas) ? b.personas : null;
    if (!fecha) return res.status(400).json({ error: 'Falta la fecha de la calificación' });
    if (!personas || !personas.length) return res.status(400).json({ error: 'No llegó ninguna persona para guardar' });

    const tramos = getConfigProduccion().tramosIncentivo || [];
    const quien = (req.auth && req.auth.user) || '';
    const ahora = new Date().toISOString();
    const nuevos = [], sinOperaciones = [];

    personas.forEach(p => {
      const operaria = prepNombre(p.operaria);
      if (!operaria) return;
      const lineas = (Array.isArray(p.operaciones) ? p.operaciones : [])
        .map(l => ({
          referencia: prepNombre(l.referencia), operacion: prepNombre(l.operacion).toUpperCase(),
          orden: prepNombre(l.orden), und: prepNum(l.und), meta: prepNum(l.meta)
        }))
        .filter(l => l.referencia || l.operacion || l.orden || l.und != null || l.meta != null)
        .slice(0, MillarPreparacion.REGLAS.maxOperaciones);
      if (!lineas.length) { sinOperaciones.push(operaria); return; }

      const c = MillarPreparacion.calcularBloque({
        salida: prepNum(p.salida), impro: prepNum(p.impro), hrsModulo: prepNum(p.hrsModulo),
        lines: lineas.map(l => ({ und: l.und, meta: l.meta }))
      }, tramos);

      // Pasó a módulo: el porcentaje y el incentivo son los de ese módulo.
      let pct = c.eficiencia, incent = c.incentivo, deModulo = null;
      if (pct == null && lineas.length === 1) {
        deModulo = prepIncentivoDeModulo(fecha, lineas[0].operacion);
        if (deModulo) { pct = deModulo.eficiencia; incent = deModulo.incentivo; }
      }

      lineas.forEach((l, k) => {
        nuevos.push({
          fecha, operaria,
          hrsModulo: k === 0 ? prepNum(p.hrsModulo) : null,
          horas: k === 0 ? c.horas : null,
          impro: k === 0 ? prepNum(p.impro) : null,
          salida: k === 0 ? prepNum(p.salida) : null,
          referencia: l.referencia, operacion: l.operacion, orden: l.orden,
          und: l.und, meta: l.meta,
          pct: k === 0 ? pct : null,
          incent: k === 0 ? incent : null,
          ...(k === 0 && deModulo ? { origenModulo: deModulo.modulo } : {}),
          obs: k === 0 ? prepNombre(p.obs) : '',
          creadoPor: k === 0 ? quien : '', creadoEn: k === 0 ? ahora : ''
        });
      });
    });

    if (!nuevos.length) {
      return res.status(400).json({ error: 'Ninguna persona tiene operaciones para guardar', sinOperaciones });
    }
    const reemplaza = new Set(nuevos.map(r => r.fecha + '|' + prepClave(r.operaria)));
    const quedan = (loadDB(PREP_STORE) || [])
      .filter(r => !reemplaza.has(String(r.fecha || '') + '|' + prepClave(r.operaria)));
    if (!saveDB(PREP_STORE, quedan.concat(nuevos))) {
      return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ ok: true, personas: reemplaza.size, registros: nuevos.length, sinOperaciones });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Borrar la calificación de una persona en un día.
app.delete('/api/preparacion/registros', requireMando, (req, res) => {
  try {
    const fecha = normFechaDia(req.query.fecha), operaria = prepClave(req.query.operaria);
    if (!fecha || !operaria) return res.status(400).json({ error: 'Falta la fecha o la persona' });
    const data = loadDB(PREP_STORE) || [];
    const quedan = data.filter(r => !(String(r.fecha || '') === fecha && prepClave(r.operaria) === operaria));
    if (quedan.length === data.length) return res.status(404).json({ error: 'No hay nada guardado de esa persona ese día' });
    if (!saveDB(PREP_STORE, quedan)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, eliminados: data.length - quedan.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Auditorías de Calidad ────────────────────────────────────────────
   Quién puede usar el módulo: la PERSONA que entró a la app con su cédula y su
   clave, y tiene marcado el permiso "Auditorías de Calidad" (o es
   administradora). No hay un segundo ingreso: es la misma sesión de siempre,
   como en Control de Ingresos.

   El nombre con el que se firma cada auditoría sale de la FICHA de empleados,
   no de lo que mande la pantalla, así que cada auditora ve solo lo suyo y no
   se puede pedir lo de otra cambiando un dato en la dirección. Quien entra con
   un perfil de equipo (sin cédula) no tiene nombre de persona y no pasa.

   Las administradoras (marcadas así en su cuenta de acceso) pueden auditar y
   ver las auditorías de todas.

   El pase firmado que queda abajo ya no es una entrada: solo sella el
   cronómetro de cada auditoría (ver /iniciar y el guardado). */
const AUD_STORE  = 'auditorias_calidad';
const AUD_PERMISO = 'auditorias_calidad';

const audSoloDigitos = v => String(v == null ? '' : v).replace(/[^0-9]/g, '');
// Secreto propio del sello del cronómetro, derivado del de la app.
const audSecreto = () => crypto.createHmac('sha256', SESSION_SECRET).update('auditorias-calidad/v1').digest();

function audFirmarPase(datos) {
  const cuerpo = Buffer.from(JSON.stringify(datos)).toString('base64url');
  const firma  = crypto.createHmac('sha256', audSecreto()).update(cuerpo).digest('base64url');
  return cuerpo + '.' + firma;
}
function audLeerPase(pase) {
  if (!pase || typeof pase !== 'string' || !pase.includes('.')) return null;
  const [cuerpo, firma] = pase.split('.');
  const esperada = crypto.createHmac('sha256', audSecreto()).update(cuerpo).digest('base64url');
  const a = Buffer.from(firma), b = Buffer.from(esperada);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const d = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    if (!d || d.t !== 'aud' || !d.n) return null;
    if (d.exp && Date.now() > d.exp) return null;
    return d;
  } catch { return null; }
}

/* Quién hace la petición y si puede usar el módulo. Se comprueba en CADA
   petición (cuentaDeCedula mira la ficha y la cuenta de acceso): si le quitan
   el permiso o la dan de baja, deja de servirle al instante. */
function audQuien(auth) {
  if (!auth || auth.tipo !== 'persona') {
    return { no: 401, error: 'Entra a MES Millar con tu cédula y tu contraseña para usar este módulo' };
  }
  const r = cuentaDeCedula(auth.user);
  if (!r.ok) return { no: 401, error: 'Tu sesión se cerró. Vuelve a entrar con tu cédula' };
  if (!tienePermiso(auth, [AUD_PERMISO])) {
    return { no: 403, error: 'No tienes el permiso de Auditorías de Calidad. Pídeselo a un administrador.' };
  }
  const nombre = String(r.emp.name || '').trim();
  if (!nombre) return { no: 403, error: 'Tu ficha de empleado no tiene nombre' };
  return { n: nombre, a: r.cuenta.admin === true, cedula: r.cedula };
}
function requireAuditor(req, res, next) {
  requireAuth(req, res, () => {
    const q = audQuien(req.auth);
    if (q.no) return res.status(q.no).json({ error: q.error });
    req.aud = q;
    next();
  });
}
// Administradora: la marca de administrador de su cuenta de acceso. Se vuelve a
// leer en cada petición, así quitarla o darla tiene efecto de inmediato.
function requireAdminCalidad(req, res, next) {
  requireAuditor(req, res, () => {
    if (req.aud.a !== true) return res.status(403).json({ error: 'Solo una administradora puede ver esto' });
    next();
  });
}

// Quién soy, según la sesión (la pantalla no decide esto).
app.get('/api/auditorias-calidad/yo', requireAuditor, (req, res) => {
  const mias = audTareasDe(req.aud.cedula);
  res.json({ ok: true, auditora: req.aud.n, admin: req.aud.a === true,
    modulos: audModulosDe(req.aud.cedula),
    tareasPendientes: mias.filter(t => t.estado !== 'hecha').length });
});

/* ── Módulos asignados y tareas ───────────────────────────────────────
   Las administradoras le dicen a cada auditora qué módulos le toca auditar y
   le dejan tareas por escrito. Los módulos son ORIENTATIVOS: a la auditora le
   salen primero en "Nueva auditoría", pero puede auditar otros (a veces cubre
   a una compañera). Se guardan por CÉDULA, que no cambia aunque cambie el
   nombre en la ficha. */
const AUD_ASIG   = 'auditorias_asignaciones';   // { [cedula]: { modulos:[...], actualizado, por } }
const AUD_TAREAS = 'auditorias_tareas';         // [ { id, cedula, texto, limite, estado, creadaEn, creadaPor, hechaEn, hechaPor } ]
const audAsignaciones = () => { const a = loadDB(AUD_ASIG); return (a && !Array.isArray(a)) ? a : {}; };
const audTodasLasTareas = () => { const t = loadDB(AUD_TAREAS); return Array.isArray(t) ? t : []; };
/* Quién audita cada módulo se asigna en Configuraciones → Módulos y se guarda en app_config
   (_modulos_auditora: { id del módulo: [nombres de auditoras] }), igual que la supervisora. */
function audMapaModulos() {
  const m = (readJSON(FILES.app_config, {}) || {})._modulos_auditora;
  return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
}
function audModulosDe(ced) {
  const c = audSoloDigitos(ced);
  const emp = empleadoPorCedula(c);
  const nombre = emp ? String(emp.name || '').trim() : '';
  const renamed = (modulesConfig && modulesConfig.renamed) || {};
  const mapa = audMapaModulos();
  const deConfig = nombre
    ? Object.keys(mapa).filter(id => Array.isArray(mapa[id]) && mapa[id].some(n => compararNombres(n, nombre))).map(id => normModulo(renamed[id] || id))
    : [];
  if (deConfig.length) return deConfig;
  const a = audAsignaciones()[c];     // la asignación vieja, solo si Configuraciones no tiene nada para ella
  return (a && Array.isArray(a.modulos)) ? a.modulos : [];
}
const audTareasDe  = ced => audTodasLasTareas().filter(t => t.cedula === audSoloDigitos(ced));

/* Quiénes son las auditoras: las personas con cuenta y el permiso del módulo,
   y también las administradoras que ya hayan hecho auditorías (un administrador
   que nunca audita no tiene por qué aparecer en la lista). */
function audAuditoras() {
  const cuentas = cargarAccesos().cuentas || {};
  const hechas = audLista();
  const pendientes = {};
  audTodasLasTareas().forEach(t => { if (t.estado !== 'hecha') pendientes[t.cedula] = (pendientes[t.cedula] || 0) + 1; });
  const out = [];
  Object.keys(cuentas).forEach(ced => {
    const c = cuentas[ced];
    if (!c || c.disabled) return;
    const emp = empleadoPorCedula(ced);
    if (!emp || emp.disabled) return;
    const nombre = String(emp.name || '').trim();
    const conPermiso = (c.perms || []).includes(AUD_PERMISO);
    if (!conPermiso && !(c.admin === true && hechas.some(r => compararNombres(r.auditora, nombre)))) return;
    out.push({ cedula: ced, nombre, cargo: emp.cargo || '', admin: c.admin === true,
               modulos: audModulosDe(ced), pendientes: pendientes[ced] || 0 });
  });
  return out.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
}

// La lista para el panel: auditoras, módulos que existen y todas las tareas.
app.get('/api/auditorias-calidad/auditoras', requireAdminCalidad, (req, res) => {
  try {
    res.json({ ok: true, auditoras: audAuditoras(),
      modulosDisponibles: [...new Set(getAllActiveModules().map(normModulo))].sort((a, b) => a.localeCompare(b, 'es', { numeric: true })),
      tareas: audTodasLasTareas() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Qué módulos le tocan a una auditora. Llega la lista completa y reemplaza la anterior.
app.put('/api/auditorias-calidad/auditoras/:cedula/modulos', requireAdminCalidad, (req, res) => {
  try {
    const ced = audSoloDigitos(req.params.cedula);
    if (!audAuditoras().some(a => a.cedula === ced)) return res.status(404).json({ error: 'Esa persona no es auditora' });
    const validos = new Set(getAllActiveModules().map(normModulo));
    const pedidos = Array.isArray((req.body || {}).modulos) ? req.body.modulos : null;
    if (!pedidos) return res.status(400).json({ error: 'Falta la lista de módulos' });
    const modulos = [...new Set(pedidos.map(normModulo))].filter(m => m && validos.has(m))
      .sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
    const todas = Object.assign({}, audAsignaciones());
    todas[ced] = { modulos, actualizado: new Date().toISOString(), por: req.aud.n };
    if (!saveDB(AUD_ASIG, todas)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, modulos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const audFechaOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));

// Dejarle una tarea a una auditora.
app.post('/api/auditorias-calidad/tareas', requireAdminCalidad, (req, res) => {
  try {
    const b = req.body || {};
    const ced = audSoloDigitos(b.cedula);
    if (!audAuditoras().some(a => a.cedula === ced)) return res.status(404).json({ error: 'Esa persona no es auditora' });
    const texto = String(b.texto || '').trim();
    if (!texto) return res.status(400).json({ error: 'Escribe la tarea' });
    if (texto.length > 500) return res.status(400).json({ error: 'La tarea es muy larga (máximo 500 letras)' });
    const limite = String(b.limite || '').trim();
    if (limite && !audFechaOk(limite)) return res.status(400).json({ error: 'La fecha límite no es válida' });
    const t = { id: crypto.randomUUID(), cedula: ced, texto, limite, estado: 'pendiente',
                creadaEn: new Date().toISOString(), creadaPor: req.aud.n, hechaEn: '', hechaPor: '' };
    const lista = audTodasLasTareas().concat([t]);
    if (!saveDB(AUD_TAREAS, lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, tarea: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cambiar una tarea: el texto y la fecha son de la administradora; marcarla hecha, de ambas.
function audCambiarTarea(req, res, soloEstado) {
  try {
    const lista = audTodasLasTareas().slice();
    const i = lista.findIndex(t => t.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Esa tarea ya no existe' });
    const t = Object.assign({}, lista[i]);
    if (soloEstado && t.cedula !== req.aud.cedula) return res.status(403).json({ error: 'Esa tarea no es tuya' });
    const b = req.body || {};
    if (b.estado !== undefined) {
      if (b.estado !== 'hecha' && b.estado !== 'pendiente') return res.status(400).json({ error: 'Estado no válido' });
      if (b.estado !== t.estado) {
        t.estado = b.estado;
        t.hechaEn  = b.estado === 'hecha' ? new Date().toISOString() : '';
        t.hechaPor = b.estado === 'hecha' ? req.aud.n : '';
      }
    }
    if (!soloEstado) {
      if (b.texto !== undefined) {
        const texto = String(b.texto || '').trim();
        if (!texto) return res.status(400).json({ error: 'Escribe la tarea' });
        if (texto.length > 500) return res.status(400).json({ error: 'La tarea es muy larga (máximo 500 letras)' });
        t.texto = texto;
      }
      if (b.limite !== undefined) {
        const limite = String(b.limite || '').trim();
        if (limite && !audFechaOk(limite)) return res.status(400).json({ error: 'La fecha límite no es válida' });
        t.limite = limite;
      }
    }
    lista[i] = t;
    if (!saveDB(AUD_TAREAS, lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, tarea: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
app.patch('/api/auditorias-calidad/tareas/:id', requireAdminCalidad, (req, res) => audCambiarTarea(req, res, false));
app.patch('/api/auditorias-calidad/mis-tareas/:id', requireAuditor, (req, res) => audCambiarTarea(req, res, true));

app.delete('/api/auditorias-calidad/tareas/:id', requireAdminCalidad, (req, res) => {
  try {
    const lista = audTodasLasTareas();
    const quedan = lista.filter(t => t.id !== req.params.id);
    if (quedan.length === lista.length) return res.status(404).json({ error: 'Esa tarea ya no existe' });
    if (!saveDB(AUD_TAREAS, quedan)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Lo mío: mis módulos y mis tareas.
app.get('/api/auditorias-calidad/mis-tareas', requireAuditor, (req, res) => {
  res.json({ ok: true, modulos: audModulosDe(req.aud.cedula), tareas: audTareasDe(req.aud.cedula) });
});

const audLista = () => loadDB(AUD_STORE) || [];
/* El resultado (APROBADA / RECHAZADA) se calcula con el mínimo de aceptación
   VIGENTE, no con el que había el día que se registró la auditoría. Así, cuando
   producción cambia el mínimo en Configuración, las auditorías ya registradas se
   ajustan solas: no hay que tocar nada guardado. Lo que quedó guardado en su
   momento se conserva y viaja aparte (resultadoGuardado / minimoGuardado). */
function audConMinimoActual(r) {
  const min = getConfigProduccion().minAceptacionCalidad;
  const pct = Number(r && r.pctAceptacion);
  if (min == null || !r || r.pctAceptacion == null || r.pctAceptacion === '' || !Number.isFinite(pct)) return r;
  const resultado = pct >= min ? 'APROBADA' : 'RECHAZADA';
  if (resultado === r.resultado && Number(r.minimoAplicado) === Number(min)) return r;
  return { ...r, resultado, minimoAplicado: min, resultadoGuardado: r.resultado, minimoGuardado: r.minimoAplicado };
}
const audEnRango = (r, desde, hasta) =>
  (!desde || String(r.fecha || '') >= desde) && (!hasta || String(r.fecha || '') <= hasta);

/* Las auditorias de quien pide. El nombre sale del PASE, no de lo que mande la
   pantalla: por eso cambiar un dato en la direccion no sirve para ver las de
   otra persona. */
app.get('/api/auditorias-calidad/mias', requireAuditor, (req, res) => {
  try {
    const desde = normFechaDia(req.query.desde), hasta = normFechaDia(req.query.hasta);
    res.json({ ok: true, auditora: req.aud.n,
      auditorias: audLista().filter(r => compararNombres(r.auditora, req.aud.n) && audEnRango(r, desde, hasta)).map(audConMinimoActual) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Los datos de una OP: lo que ya está en Órdenes de Producción y las
   operaciones de la ficha de esa referencia. No se copia nada: se lee. */
function audDatosDeOrden(orden) {
  const ref = String(orden.referencia || '').trim();
  const ficha = (loadDB('fichas') || []).find(x => normModulo(x.referencia) === normModulo(ref));
  const operaciones = ((ficha && ficha.operaciones) || [])
    .map(o => String((o && o.nombre) || '').trim()).filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a.localeCompare(b, 'es'));
  /* Los módulos de la orden. Muchas órdenes traen uno solo y otras ninguno:
     cuando no hay, se ofrecen todos para no dejar a la auditora sin elegir. */
  const suyos = [].concat(orden.modulo ? [orden.modulo] : [], (orden.modulos || []).map(m => m && m.modulo))
    .map(m => String(m || '').trim()).filter(Boolean)
    .filter((v, i, a) => a.findIndex(x => normModulo(x) === normModulo(v)) === i);
  return {
    referencia: ref,
    cliente: orden.cliente || '', tipoPrenda: orden.tipoPrenda || '',
    cantidad: Number(orden.cantidad) || 0,
    modulos: suyos.length ? suyos : getAllActiveModules(),
    modulosDeLaOrden: suyos.length > 0,
    operaciones,
    sinFicha: !ficha || !operaciones.length
  };
}

/* La foto de la prenda: vive en la ficha de la referencia (se carga en Órdenes
   de Producción). Si la orden no tiene, va vacía y la pantalla no muestra nada.
   Va aparte de audDatosDeOrden para no cargar la foto cuando solo se piden las
   operaciones (la corrección de auditorías no la necesita). */
function audFotoDeOrden(orden) {
  const ref = String(orden.referencia || '').trim();
  const ficha = (loadDB('fichas') || []).find(x => normModulo(x.referencia) === normModulo(ref));
  const foto = (ficha && ficha.foto) || orden.foto || '';
  return typeof foto === 'string' ? foto : '';
}

/* Los datos de una OP. Un mismo número puede tener MÁS DE UNA orden, con
   referencias distintas (pasa poco, pero pasa). Se devuelven todas y la
   auditora elige cuál está auditando: quedarse con la primera sería adivinar,
   y la auditoría saldría con la referencia equivocada. */
app.get('/api/auditorias-calidad/op/:opoc', requireAuditor, (req, res) => {
  try {
    const buscada = String(req.params.opoc || '').trim();
    if (!buscada) return res.status(400).json({ error: 'Escribe el número de OP' });
    const suyas = (loadDB('ordenes') || []).filter(o => String(o.opoc || '').trim() === buscada);
    if (!suyas.length) return res.status(404).json({ error: 'No existe la OP ' + buscada });
    res.json({ ok: true, op: buscada, varias: suyas.length > 1,
      ordenes: suyas.map(o => ({ ...audDatosDeOrden(o), foto: audFotoDeOrden(o) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Quién puede auditarse: solo quien marcó presente ese día en ese módulo.
   Es la misma lista de Control de Asistencia; si nadie marcó, viene vacía. */
app.get('/api/auditorias-calidad/personas', requireAuditor, (req, res) => {
  try {
    const modulo = String(req.query.modulo || '').trim();
    const fecha = normFechaDia(req.query.fecha) || fechaHoyCO();
    if (!modulo) return res.status(400).json({ error: 'Elige primero el módulo' });
    res.json({ ok: true, modulo, fecha, personas: presentesDelDia(modulo, fecha) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// El catálogo de defectos que ya existe (Configuración de Producción).
app.get('/api/auditorias-calidad/defectos', requireAuditor, (req, res) => {
  try {
    res.json({ ok: true,
      defectos: (loadDB('lt_defectos') || []).map(d => String((d && d.nombre) || '').trim()).filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'es')),
      minAceptacion: getConfigProduccion().minAceptacionCalidad });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* El cronómetro. El servidor devuelve un SELLO firmado con su hora de
   arranque; no crea ningún registro, así que salirse a medias no deja basura.
   Al guardar se lee ese sello y el servidor pone su propia hora de fin: el
   tiempo no depende del reloj del navegador. */
const AUD_SELLO_MAX_MS = 12 * 3600 * 1000;   // un sello más viejo que esto no vale
app.post('/api/auditorias-calidad/iniciar', requireAuditor, (req, res) => {
  const inicio = Date.now();
  res.json({ ok: true, inicio, sello: audFirmarPase({ t: 'aud', n: req.aud.n, i: inicio, exp: inicio + AUD_SELLO_MAX_MS }) });
});

/* Guardar una auditoría. Una auditoría = una OP + un módulo + una persona +
   una operación. Todo se vuelve a comprobar aquí: la pantalla no decide nada. */
/* Comprobar los datos de una auditoria. La usan las DOS puertas: la que crea y
   la que corrige. Estaba escrita solo dentro de la de crear; al anadir la de
   corregir habria quedado la misma regla en dos sitios, y el dia que cambiara
   una, las auditorias nuevas y las corregidas dejarian de medirse igual.
   Devuelve { error } o { datos }. La fecha se pasa aparte porque al corregir una
   auditoria vieja hay que mirar quien estaba presente ESE dia, no hoy. */
function audComprobar(b, fecha) {
  const malo = m => ({ error: m });

  const minimo = getConfigProduccion().minAceptacionCalidad;
  if (minimo == null) return malo('Falta configurar el % mínimo de aceptación en Configuración de Producción');

  const op = String(b.op || '').trim();
  const suyas = (loadDB('ordenes') || []).filter(o => String(o.opoc || '').trim() === op);
  if (!suyas.length) return malo('No existe la OP ' + op);
  // Con varias órdenes en el mismo número de OP, manda la referencia elegida.
  const refPedida = String(b.referencia || '').trim();
  const orden = refPedida
    ? suyas.find(o => normModulo(o.referencia) === normModulo(refPedida))
    : (suyas.length === 1 ? suyas[0] : null);
  if (!orden) {
    return malo(refPedida
      ? 'La referencia ' + refPedida + ' no está en la OP ' + op
      : 'La OP ' + op + ' tiene varias referencias: elige cuál auditaste');
  }
  const referencia = String(orden.referencia || '').trim();

  const modulo = String(b.modulo || '').trim();
  if (!modulo) return malo('Elige el módulo');
  if (!getAllActiveModules().some(m => normModulo(m) === normModulo(modulo))) return malo('Ese módulo no existe');

  const persona = String(b.personaAuditada || '').trim();
  if (!persona) return malo('Elige la persona');
  if (!presentesDelDia(modulo, fecha).some(p => compararNombres(p, persona))) {
    return malo(persona + ' no aparece como presente en ' + modulo + ' el ' + fecha);
  }

  const operacion = String(b.operacion || '').trim().toUpperCase();
  const ficha = (loadDB('fichas') || []).find(x => normModulo(x.referencia) === normModulo(referencia));
  const deLaFicha = ((ficha && ficha.operaciones) || []).map(o => normModulo(o && o.nombre));
  if (!operacion) return malo('Elige la operación');
  if (!deLaFicha.includes(operacion)) return malo('Esa operación no está en la ficha de la referencia ' + referencia);

  const auditadas = Number(b.unidadesAuditadas);
  if (!Number.isInteger(auditadas) || auditadas <= 0) return malo('Las unidades auditadas deben ser un número entero mayor que cero');
  const defectuosas = Number(b.unidadesDefectuosas);
  if (!Number.isInteger(defectuosas) || defectuosas < 0) return malo('Las unidades defectuosas deben ser un número entero');
  if (defectuosas > auditadas) return malo('Las unidades defectuosas no pueden ser más que las auditadas');

  // Los defectos: cada uno del catálogo y con su cantidad.
  const catalogo = (loadDB('lt_defectos') || []).map(d => normModulo(d && d.nombre));
  const defectos = [];
  for (const d of (Array.isArray(b.defectos) ? b.defectos : [])) {
    const nombre = String((d && d.nombre) || '').trim().toUpperCase();
    const cantidad = Number(d && d.cantidad);
    if (!nombre) continue;
    if (!catalogo.includes(nombre)) return malo('El defecto "' + nombre + '" no está en el catálogo');
    if (!Number.isInteger(cantidad) || cantidad <= 0) return malo('El defecto "' + nombre + '" necesita una cantidad entera mayor que cero');
    const ya = defectos.find(x => x.nombre === nombre);
    if (ya) ya.cantidad += cantidad; else defectos.push({ nombre, cantidad });
  }
  const totalDefectos = defectos.reduce((n, d) => n + d.cantidad, 0);
  /* Una prenda mala puede tener varios defectos, así que los defectos nunca
     son MENOS que las prendas malas. Y si no hubo prendas malas, tampoco
     puede haber defectos.
     La pantalla rellena sola las defectuosas con la suma de los defectos, pero
     la auditora las puede corregir: dos defectos en la misma prenda son UNA
     prenda mala. Por eso el numero sigue viniendo de ella y se comprueba. */
  if (defectuosas > 0 && totalDefectos < defectuosas) {
    return malo('Hay ' + defectuosas + ' prendas defectuosas pero solo ' + totalDefectos + ' defectos. Cada prenda mala tiene al menos uno.');
  }
  if (defectuosas === 0 && totalDefectos > 0) return malo('Marcaste defectos pero ninguna prenda defectuosa');

  const buenas = auditadas - defectuosas;
  const pct = Math.round(buenas / auditadas * 10000) / 100;      // 14 de 20 -> 70
  const resultado = pct >= minimo ? 'APROBADA' : 'RECHAZADA';

  /* Una auditoria rechazada tiene que decir por que: ese texto es lo unico que
     despues le explica la decision a quien la lea. La pantalla ya lo pide, pero
     se comprueba aqui tambien: la pantalla se puede saltar. */
  const observaciones = String(b.observaciones || '').trim().slice(0, 1000);
  if (resultado === 'RECHAZADA' && !observaciones) {
    return malo('La auditoría queda RECHAZADA: escribe en las observaciones qué pasó');
  }

  return { datos: {
    op, referencia, cliente: orden.cliente || '', tipoPrenda: orden.tipoPrenda || '',
    modulo, personaAuditada: persona, operacion,
    unidadesAuditadas: auditadas, unidadesDefectuosas: defectuosas, unidadesBuenas: buenas,
    defectos, totalDefectos, pctAceptacion: pct, resultado, minimoAplicado: minimo, observaciones
  } };
}

/* Guardar una auditoría. Una auditoría = una OP + un módulo + una persona +
   una operación. Todo se vuelve a comprobar aquí: la pantalla no decide nada. */
app.post('/api/auditorias-calidad', requireAuditor, (req, res) => {
  try {
    const b = req.body || {};
    const malo = m => res.status(400).json({ error: m });

    // El sello del cronómetro tiene que ser de esta misma auditora.
    const sello = audLeerPase(String(b.sello || ''));
    if (!sello || !sello.i) return malo('Se perdió el cronómetro. Empieza la auditoría de nuevo.');
    if (!compararNombres(sello.n, req.aud.n)) return malo('El cronómetro no es tuyo. Empieza la auditoría de nuevo.');

    const fecha = fechaHoyCO();
    const comprobado = audComprobar(b, fecha);
    if (comprobado.error) return malo(comprobado.error);
    const fin = Date.now();

    const registro = {
      id: crypto.randomUUID(),
      fecha,
      ...comprobado.datos,
      auditora: req.aud.n,
      inicio: new Date(sello.i).toISOString(),
      fin: new Date(fin).toISOString(),
      duracionSegundos: Math.max(0, Math.round((fin - sello.i) / 1000)),
      creadoEn: new Date(fin).toISOString(), creadoPor: req.aud.n,
      cambios: []                                   // las correcciones se anotan aquí
    };

    const lista = audLista();
    lista.push(registro);
    if (!saveDB(AUD_STORE, lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, auditoria: registro });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Todas: solo la administradora.
app.get('/api/auditorias-calidad/todas', requireAdminCalidad, (req, res) => {
  try {
    const desde = normFechaDia(req.query.desde), hasta = normFechaDia(req.query.hasta);
    res.json({ ok: true, auditorias: audLista().filter(r => audEnRango(r, desde, hasta)).map(audConMinimoActual) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Los nombres de las auditoras, para escogerlas en Configuraciones → Módulos. Solo lectura: quien
   administra Configuraciones (o es administrador) la pide; no trae cédulas ni datos de contacto. */
app.get('/api/auditoras-calidad', requirePermiso('configuraciones'), (req, res) => {
  try {
    res.json({ ok: true, auditoras: audAuditoras().map(a => ({ nombre: a.nombre })).sort((x, y) => x.nombre.localeCompare(y.nombre, 'es')) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* El tablero del Panel de Calidad: cada módulo activo con la(s) auditora(s) que tiene asignada(s),
   las auditorías del rango pedido y el mínimo vigente. El promedio y los colores los calcula la pantalla. */
app.get('/api/auditorias-calidad/tablero', requireAdminCalidad, (req, res) => {
  try {
    const desde = normFechaDia(req.query.desde), hasta = normFechaDia(req.query.hasta);
    const renamed = (modulesConfig && modulesConfig.renamed) || {};
    const apagados = new Set((modulesConfig && modulesConfig.disabled) || []);
    const mapa = audMapaModulos();
    const modulos = [...MODULES, ...((modulesConfig && modulesConfig.extra) || [])]
      .filter((id, i, l) => l.indexOf(id) === i && !apagados.has(id))
      .map(id => ({ id, nombre: normModulo(renamed[id] || id),
                    auditoras: Array.isArray(mapa[id]) ? mapa[id].map(n => String(n).trim()).filter(Boolean) : [] }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, 'es', { numeric: true }));
    res.json({ ok: true, minimo: getConfigProduccion().minAceptacionCalidad, modulos,
               auditorias: audLista().filter(r => audEnRango(r, desde, hasta)).map(audConMinimoActual) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Estado de calidad de HOY por módulo, para la tarjeta del Tablero de producción: lo mismo que el Tablero de Calidad
   (promedio simple del % de aceptación de las auditorías de hoy contra el mínimo vigente). 'v' aceptado, 'r' rechazado,
   'g' sin auditar (sin auditorías hoy o sin mínimo configurado). Solo estados, no datos de las auditorías. */
const calNorm = v => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/s+/g, ' ').trim();
app.get('/api/calidad-modulos-hoy', requirePermiso('tablero_produccion', 'tablero_eficiencia'), (req, res) => {
  try {
    const hoy = fechaCO(new Date());
    const minimo = getConfigProduccion().minAceptacionCalidad;
    const pcts = {};
    audLista().filter(r => audEnRango(r, hoy, hoy)).forEach(r => {
      const p = Number(r.pctAceptacion);
      if (r.pctAceptacion == null || r.pctAceptacion === '' || !Number.isFinite(p)) return;
      (pcts[calNorm(r.modulo)] = pcts[calNorm(r.modulo)] || []).push(p);
    });
    const modulos = {};
    Object.keys(pcts).forEach(k => {
      const prom = pcts[k].reduce((a, b) => a + b, 0) / pcts[k].length;
      modulos[k] = minimo == null ? 'g' : (Math.round(prom * 100) / 100 >= minimo ? 'v' : 'r');
    });
    res.json({ ok: true, modulos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Corregir una auditoría ya guardada. Solo la administradora de Calidad: la
   auditora que la hizo no puede volver sobre ella, porque entonces el número
   que decide si un lote pasa o no lo podría cambiar quien lo midió.

   Se corrige TODO menos el sello del tiempo: la fecha, la hora de inicio, la de
   fin y cuánto duró se quedan como estaban. Eso no es un dato que se opine, es
   lo que marcó el cronómetro, y reescribirlo sería reescribir la historia.

   Cada corrección se anota en 'cambios': quién, cuándo, y qué campos cambiaron
   con su valor de antes. Así una auditoría corregida nunca pierde lo que decía
   al principio. */
const AUD_CAMPOS_VISIBLES = {
  op: 'OP', referencia: 'Referencia', modulo: 'Módulo',
  personaAuditada: 'Persona', operacion: 'Operación',
  unidadesAuditadas: 'Unidades auditadas', unidadesDefectuosas: 'Unidades defectuosas',
  totalDefectos: 'Defectos', pctAceptacion: '% de aceptación',
  resultado: 'Resultado', observaciones: 'Observaciones'
};
app.patch('/api/auditorias-calidad/:id', requireAdminCalidad, (req, res) => {
  try {
    const lista = audLista();
    const idx = lista.findIndex(r => String(r.id) === String(req.params.id));
    if (idx < 0) return res.status(404).json({ error: 'Esa auditoría ya no existe' });
    const antes = lista[idx];

    /* Se comprueba contra la fecha de LA AUDITORÍA, no contra hoy: si no, una
       auditoría de la semana pasada no se podría corregir nunca, porque esa
       persona ya no aparece como presente. */
    const comprobado = audComprobar(req.body || {}, antes.fecha);
    if (comprobado.error) return res.status(400).json({ error: comprobado.error });

    const despues = { ...antes, ...comprobado.datos };

    // Qué cambió de verdad. Si no cambió nada, no se anota una corrección vacía.
    const cambiados = Object.keys(AUD_CAMPOS_VISIBLES).filter(k =>
      JSON.stringify(antes[k]) !== JSON.stringify(despues[k]));
    const defectosCambiaron = JSON.stringify(antes.defectos || []) !== JSON.stringify(despues.defectos || []);
    if (!cambiados.length && !defectosCambiaron) {
      return res.json({ ok: true, auditoria: antes, sinCambios: true });
    }

    despues.cambios = (Array.isArray(antes.cambios) ? antes.cambios : []).concat([{
      cuando: new Date().toISOString(),
      quien: req.aud.n,
      motivo: String((req.body || {}).motivo || '').trim().slice(0, 300),
      campos: cambiados.map(k => ({ campo: AUD_CAMPOS_VISIBLES[k], antes: antes[k], despues: despues[k] })),
      defectosAntes: defectosCambiaron ? (antes.defectos || []) : undefined
    }]);

    lista[idx] = despues;
    if (!saveDB(AUD_STORE, lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    console.warn('[AUDITORIAS] ' + req.aud.n + ' corrigió la auditoría de ' + antes.personaAuditada +
      ' (' + antes.fecha + '): ' + cambiados.join(', '));
    res.json({ ok: true, auditoria: despues });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

/* Eliminar una auditoría. Solo la administradora, con SU contraseña (la misma
   con la que entra con su cédula), y dejando constancia en el registro del
   servidor: una auditoría borrada no deja rastro en la app, así que el rastro
   tiene que quedar fuera. La contraseña se comprueba AQUÍ, no en la pantalla. */
app.delete('/api/auditorias-calidad/:id', requireAdminCalidad, (req, res) => {
  try {
    if (bloqueadoPorFallos(req)) return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.' });
    const clave = String((req.body && req.body.clave) || '');
    const r = cuentaDeCedula(req.aud.cedula);
    if (!clave || !r.ok || !bcrypt.compareSync(clave, r.cuenta.hash || '')) {
      if (clave) anotarFallo(req);
      return res.status(403).json({ error: clave ? 'Contraseña incorrecta' : 'Escribe tu contraseña para eliminar' });
    }
    const lista = audLista();
    const idx = lista.findIndex(r => String(r.id) === String(req.params.id));
    if (idx < 0) return res.status(404).json({ error: 'Esa auditoría ya no existe' });
    const b = lista[idx];
    lista.splice(idx, 1);
    if (!saveDB(AUD_STORE, lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    console.warn('[AUDITORIAS] ' + req.aud.n + ' eliminó la auditoría de ' + b.personaAuditada +
      ' en ' + b.modulo + ' del ' + b.fecha + ' (' + b.resultado + ', ' + b.pctAceptacion + '%)');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* Lo que hace falta para corregir: las personas que estaban presentes ESE día
   en ese módulo, y las operaciones de la ficha de esa referencia. Sin esto, la
   pantalla de corrección no tendría de dónde sacar las listas. */
app.get('/api/auditorias-calidad/contexto/:id', requireAdminCalidad, (req, res) => {
  try {
    const a = audLista().find(r => String(r.id) === String(req.params.id));
    if (!a) return res.status(404).json({ error: 'Esa auditoría ya no existe' });
    const suyas = (loadDB('ordenes') || []).filter(o => String(o.opoc || '').trim() === String(a.op || '').trim());
    const orden = suyas.find(o => normModulo(o.referencia) === normModulo(a.referencia)) || suyas[0] || null;
    const datos = orden ? audDatosDeOrden(orden) : { modulos: getAllActiveModules(), operaciones: [] };
    /* Se ofrece también el módulo que ya tiene la auditoría aunque hoy no esté
       activo: si no, corregir otra cosa la obligaría a cambiar el módulo. */
    const modulos = datos.modulos.slice();
    if (a.modulo && !modulos.some(m => normModulo(m) === normModulo(a.modulo))) modulos.unshift(a.modulo);
    const personas = presentesDelDia(a.modulo, a.fecha).slice();
    if (a.personaAuditada && !personas.some(p => compararNombres(p, a.personaAuditada))) {
      personas.unshift(a.personaAuditada);
    }
    res.json({ ok: true, auditoria: a, modulos, personas,
      operaciones: datos.operaciones, referencias: suyas.map(o => String(o.referencia || '').trim()).filter(Boolean),
      defectos: (loadDB('lt_defectos') || []).map(d => String((d && d.nombre) || '').trim()).filter(Boolean).sort((x, y) => x.localeCompare(y, 'es')) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Las personas presentes en un módulo un día concreto. La de arriba sirve para
   los datos que ya tiene la auditoría; esta es para cuando la administradora
   cambia el módulo mientras corrige y hay que traer otra lista. */
app.get('/api/auditorias-calidad/presentes', requireAdminCalidad, (req, res) => {
  try {
    const modulo = String(req.query.modulo || '').trim();
    const fecha = normFechaDia(req.query.fecha) || fechaHoyCO();
    if (!modulo) return res.status(400).json({ error: 'Falta el módulo' });
    res.json({ ok: true, personas: presentesDelDia(modulo, fecha) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
//  ALMACÉN DE INSUMOS
// ══════════════════════════════════════════════════════════════════
const normRefIns = v => String(v == null ? '' : v).trim().toUpperCase();
const enteroIns = v => {
  if (v === '' || v == null) return NaN;
  const n = Math.round(Number(String(v).replace(/[^\d,.-]/g, '').replace(',', '.')));
  return Number.isFinite(n) ? n : NaN;
};
// Quién está haciendo el movimiento. Sale del token, no de lo que mande la
// pantalla: así nadie puede firmar una entrega con otro nombre.
function usuarioDeSesion(req) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-session-token'] || req.query.token || '');
  const p = verifyToken(token);
  return (p && p.user) || 'sin sesión';
}
const hoyCO = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Bogota' });
const horaCO = () => new Date().toLocaleTimeString('es-CO', { timeZone: 'America/Bogota', hour: '2-digit', minute: '2-digit' });

const cargarInsumos = () => loadDB('almacen_insumos') || [];
const buscarInsumo  = (lista, ref) => lista.find(i => normRefIns(i.ref) === normRefIns(ref));

/* Los movimientos se guardan del más nuevo al más viejo y se recortan a
   30.000: es historia de consulta, y sin tope el archivo crecería para
   siempre hasta volver lenta cada carga de la pantalla. */
function anotarMovimientos(nuevos) {
  const lista = loadDB('almacen_movimientos') || [];
  nuevos.forEach(m => lista.unshift(m));
  return saveDB('almacen_movimientos', lista.slice(0, 30000));
}
function nuevoMovimiento(datos) {
  return {
    id: uuidv4(), ts: Date.now(), fecha: hoyCO(), hora: horaCO(),
    tipo: datos.tipo, ref: datos.ref, desc: datos.desc || '',
    cant: datos.cant, persona: datos.persona || '', usuario: datos.usuario,
    quedaron: datos.quedaron, obs: String(datos.obs || '').trim(), anulada: false
  };
}

// La lista de a quién se le puede entregar: los empleados activos de Control
// de Asistencia. No se inventa gente aquí — si alguien no está, se crea allá.
function empleadoActivo(nombre) {
  const n = String(nombre || '').trim().toUpperCase();
  if (!n) return false;
  const emps = (iaState && iaState.employees) ? iaState.employees : [];
  return emps.some(e => !e.disabled && String(e.name || '').trim().toUpperCase() === n);
}

app.get('/api/almacen/insumos', (req, res) => {
  try {
    const items = cargarInsumos().slice().sort((a, b) => String(a.ref).localeCompare(String(b.ref), 'es'));
    res.json({ ok: true, items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Crear una referencia nueva.
app.post('/api/almacen/insumos', requirePermiso('almacen_insumos'), (req, res) => {
  try {
    const b = req.body || {};
    const ref = normRefIns(b.ref), desc = String(b.desc || '').trim().toUpperCase();
    if (!ref)  return res.status(400).json({ error: 'Falta la referencia.' });
    if (!desc) return res.status(400).json({ error: 'Falta la descripción.' });
    const lista = cargarInsumos();
    if (buscarInsumo(lista, ref)) return res.status(409).json({ error: 'La referencia ' + ref + ' ya existe. Usa "Registrar entrada" para sumarle cantidad.' });
    const cant = enteroIns(b.cant), min = enteroIns(b.min);
    const item = {
      ref, desc,
      cant: Number.isFinite(cant) && cant > 0 ? cant : 0,
      min:  Number.isFinite(min)  && min  > 0 ? min  : 0,
      ubi:  String(b.ubi || '').trim().toUpperCase()
    };
    lista.push(item);
    if (!saveDB('almacen_insumos', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    if (item.cant > 0) anotarMovimientos([nuevoMovimiento({
      tipo: 'entrada', ref, desc, cant: item.cant, quedaron: item.cant,
      usuario: usuarioDeSesion(req), obs: 'Insumo nuevo'
    })]);
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Editar. Cambiar la cantidad aquí es CORREGIR el conteo, no sumar: se deja
   exactamente lo que se escriba y la diferencia queda anotada como ajuste,
   para que el inventario siempre pueda explicarse. */
app.patch('/api/almacen/insumos/:ref', requirePermiso('almacen_insumos'), (req, res) => {
  try {
    const lista = cargarInsumos();
    const item = buscarInsumo(lista, req.params.ref);
    if (!item) return res.status(404).json({ error: 'Esa referencia ya no existe. Recarga la página.' });
    const b = req.body || {};
    if (b.desc !== undefined) {
      const d = String(b.desc).trim().toUpperCase();
      if (!d) return res.status(400).json({ error: 'Falta la descripción.' });
      item.desc = d;
    }
    if (b.ubi !== undefined) item.ubi = String(b.ubi).trim().toUpperCase();
    if (b.min !== undefined) {
      const m = enteroIns(b.min);
      if (!Number.isFinite(m) || m < 0) return res.status(400).json({ error: 'El stock mínimo debe ser un número de 0 en adelante.' });
      item.min = m;
    }
    let ajuste = 0;
    if (b.cant !== undefined) {
      const c = enteroIns(b.cant);
      if (!Number.isFinite(c) || c < 0) return res.status(400).json({ error: 'La cantidad debe ser un número de 0 en adelante.' });
      ajuste = c - item.cant;
      item.cant = c;
    }
    if (!saveDB('almacen_insumos', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    if (ajuste !== 0) anotarMovimientos([nuevoMovimiento({
      tipo: 'ajuste', ref: item.ref, desc: item.desc, cant: ajuste, quedaron: item.cant,
      usuario: usuarioDeSesion(req), obs: String(b.obs || 'Corrección de conteo')
    })]);
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Borrar una referencia. Sus movimientos se conservan: son historia.
app.delete('/api/almacen/insumos/:ref', requirePermiso('almacen_insumos'), (req, res) => {
  try {
    const lista = cargarInsumos();
    const quedan = lista.filter(i => normRefIns(i.ref) !== normRefIns(req.params.ref));
    if (quedan.length === lista.length) return res.status(404).json({ error: 'Esa referencia ya no existe.' });
    if (!saveDB('almacen_insumos', quedan)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Llegó mercancía de un insumo: se SUMA.
app.post('/api/almacen/entrada', requirePermiso('almacen_insumos'), (req, res) => {
  try {
    const b = req.body || {};
    const lista = cargarInsumos();
    const item = buscarInsumo(lista, b.ref);
    if (!item) return res.status(404).json({ error: 'Esa referencia no existe.' });
    const cant = enteroIns(b.cant);
    if (!Number.isFinite(cant) || cant < 1) return res.status(400).json({ error: 'Escribe cuántas unidades llegaron.' });
    item.cant += cant;
    if (!saveDB('almacen_insumos', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    anotarMovimientos([nuevoMovimiento({
      tipo: 'entrada', ref: item.ref, desc: item.desc, cant, quedaron: item.cant,
      usuario: usuarioDeSesion(req), obs: b.obs
    })]);
    res.json({ ok: true, item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Carga por Excel. Las cantidades SE SUMAN a lo que ya hay — así se acordó:
   el archivo es lo que llegó, no el conteo total. Por eso la pantalla
   muestra el resumen antes de aplicarlo: subir dos veces el mismo archivo
   suma dos veces, y eso tiene que verse venir. */
app.post('/api/almacen/importar', requirePermiso('almacen_insumos'), (req, res) => {
  try {
    const filas = Array.isArray(req.body) ? req.body : (req.body && req.body.rows);
    if (!Array.isArray(filas) || !filas.length) return res.status(400).json({ error: 'El archivo no trae filas.' });
    const lista = cargarInsumos();
    const usuario = usuarioDeSesion(req);
    const movs = [];
    let nuevas = 0, sumadas = 0, unidades = 0, omitidas = 0;

    filas.forEach(f => {
      const ref = normRefIns(f.ref);
      const cant = enteroIns(f.cant);
      if (!ref || !Number.isFinite(cant) || cant < 1) { omitidas++; return; }
      let item = buscarInsumo(lista, ref);
      if (!item) {
        item = { ref, desc: String(f.desc || '').trim().toUpperCase() || ref, cant: 0, min: 0, ubi: '' };
        lista.push(item); nuevas++;
      } else sumadas++;
      // Descripción, ubicación y mínimo se actualizan SOLO si el archivo los
      // trae: una celda vacía no debe borrar lo que ya estaba bueno.
      const d = String(f.desc || '').trim().toUpperCase(); if (d) item.desc = d;
      const u = String(f.ubi  || '').trim().toUpperCase(); if (u) item.ubi  = u;
      const m = enteroIns(f.min); if (Number.isFinite(m) && m >= 0) item.min = m;
      item.cant += cant; unidades += cant;
      movs.push(nuevoMovimiento({ tipo: 'excel', ref, desc: item.desc, cant, quedaron: item.cant, usuario }));
    });

    if (!movs.length) return res.status(400).json({ error: 'Ninguna fila se pudo usar: revisa REFERENCIA y CANTIDAD.' });
    if (!saveDB('almacen_insumos', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    anotarMovimientos(movs);
    res.json({ ok: true, nuevas, sumadas, unidades, omitidas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Entregar. La resta se hace aquí y no en la pantalla: si dos personas
   entregan la misma referencia al tiempo, cada una parte de lo que hay de
   verdad en ese momento y ninguna se lleva por delante a la otra. */
app.post('/api/almacen/entregar', requirePermiso('almacen_insumos'), (req, res) => {
  try {
    const b = req.body || {};
    const persona = String(b.persona || '').trim().toUpperCase();
    if (!persona) return res.status(400).json({ error: 'Falta decir a quién se le entrega.' });
    if (!empleadoActivo(persona)) return res.status(400).json({ error: persona + ' no está en la lista de empleados activos. Créala primero en Control de Asistencia.' });
    const lista = cargarInsumos();
    const item = buscarInsumo(lista, b.ref);
    if (!item) return res.status(404).json({ error: 'Esa referencia no existe.' });
    const cant = enteroIns(b.cant);
    if (!Number.isFinite(cant) || cant < 1) return res.status(400).json({ error: 'Escribe cuántas unidades vas a entregar.' });
    if (cant > item.cant) return res.status(409).json({ error: 'Solo hay ' + item.cant + ' de ' + item.ref + '. No se puede entregar más.' });

    item.cant -= cant;
    if (!saveDB('almacen_insumos', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    const mov = nuevoMovimiento({
      tipo: 'entrega', ref: item.ref, desc: item.desc, cant: -cant, persona,
      quedaron: item.cant, usuario: usuarioDeSesion(req), obs: b.obs
    });
    anotarMovimientos([mov]);
    res.json({ ok: true, item, movimiento: mov, bajoMinimo: item.min > 0 && item.cant <= item.min });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/almacen/movimientos', (req, res) => {
  try {
    let lista = loadDB('almacen_movimientos') || [];
    const desde = String(req.query.desde || ''), hasta = String(req.query.hasta || '');
    if (desde) lista = lista.filter(m => String(m.fecha || '') >= desde);
    if (hasta) lista = lista.filter(m => String(m.fecha || '') <= hasta);
    const limite = Math.min(Number(req.query.limite) || 500, 5000);
    res.json({ ok: true, movimientos: lista.slice(0, limite), total: lista.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* Anular una entrega mal hecha: le devuelve la cantidad al inventario y deja
   la entrega marcada como anulada. NO se borra — quien la hizo, a quién y
   cuándo tiene que seguir viéndose, que para eso está el historial. */
app.post('/api/almacen/movimientos/:id/anular', requirePermiso('almacen_insumos'), (req, res) => {
  try {
    const movs = loadDB('almacen_movimientos') || [];
    const mov = movs.find(m => m.id === req.params.id);
    if (!mov) return res.status(404).json({ error: 'Ese movimiento ya no existe.' });
    if (mov.tipo !== 'entrega') return res.status(400).json({ error: 'Solo se pueden anular las entregas.' });
    if (mov.anulada) return res.status(409).json({ error: 'Esa entrega ya estaba anulada.' });

    const lista = cargarInsumos();
    const item = buscarInsumo(lista, mov.ref);
    if (!item) return res.status(409).json({ error: 'La referencia ' + mov.ref + ' ya no está en el inventario, así que no hay a dónde devolverle las unidades.' });

    const devueltas = Math.abs(Number(mov.cant) || 0);
    item.cant += devueltas;
    mov.anulada = true;
    mov.anuladaPor = usuarioDeSesion(req);
    mov.anuladaTs = Date.now();
    if (!saveDB('almacen_insumos', lista)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    if (!saveDB('almacen_movimientos', movs)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    anotarMovimientos([nuevoMovimiento({
      tipo: 'entrada', ref: item.ref, desc: item.desc, cant: devueltas, quedaron: item.cant,
      usuario: mov.anuladaPor, obs: 'Devolución: se anuló la entrega a ' + (mov.persona || '—')
    })]);
    res.json({ ok: true, item, devueltas });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Disponibilidad de incentivos por mes (global para todos)
app.get('/api/incentivos-disponibilidad', (req, res) => {
  const data = readJSON(FILES.incentivos_disp, {});
  res.json({ ok: true, data: data && !Array.isArray(data) ? data : {} });
});
app.post('/api/incentivos-disponibilidad', requirePermiso('consulta_incentivos'), (req, res) => {
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
app.post('/api/incentivos-config', requireAccion('editar', 'consulta_incentivos'), (req, res) => {
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
app.post('/api/buscar-contrato', requirePermiso('consulta_incentivos'), (req, res) => {
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
app.put('/api/buscar-contrato/:id', requirePermiso('consulta_incentivos'), (req, res) => {
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

app.delete('/api/buscar-contrato/:id', requirePermiso('consulta_incentivos'), (req, res) => {
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

const CI_PATH = path.join(__dirname, 'modulos/tablero-ci/Tablero_CI.html');
app.get('/ci', (req, res) => {
  if (!fs.existsSync(CI_PATH)) {
    const variants = ['tablero_ci.html','tablero-ci.html','TableroCI.html','tableroCI.html'];
    for (const v of variants) {
      const vpath = path.join(__dirname, 'modulos/tablero-ci', v);
      if (fs.existsSync(vpath)) return enviarPantalla(res, vpath);
    }
    return res.status(404).send('<h1>Tablero CI no encontrado</h1>');
  }
  enviarPantalla(res, CI_PATH);
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
      archivos.anotarSubida(safe);        // su registro se guarda enseguida: que se pueda ver ya
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

// Multer en memoria para importar Excel/CSV (no se guarda el archivo en disco,
// solo se lee el buffer una vez y se descarta) — usado por /api/lotes/importar.
const ALLOWED_EXCEL_MIME = [
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                          // .xls
  'text/csv', 'application/csv'
];
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXCEL_MIME.includes(file.mimetype) || ['.xlsx', '.xls', '.csv'].includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Tipo de archivo no permitido: ${file.mimetype}. Solo se aceptan Excel o CSV.`));
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

  /* 1-B. Cerrar los improductivos que quedaron abiertos.

     Una espera de mecánico solo se cierra nombrando al mecánico, y eso es lo
     correcto durante el turno. Pero si nadie llegó nunca, esa espera se
     quedaría abierta para siempre: el módulo amanecería en rojo y el
     cronómetro llevaría días corriendo.

     Al cerrar el día se cierran todas, incluidas las esperas sin atender.
     Quedan guardadas con el mecánico en blanco, que es la verdad: nadie fue.
     Es el ÚNICO sitio donde se permite cerrar una espera sin mecánico. */
  let impsCerrados = 0;
  Object.keys(multiImps).forEach(modId => {
    for (let i = (multiImps[modId] || []).length - 1; i >= 0; i--) {
      finalizarImp(modId, i, null, true);   // true = cierre de fin de día
      impsCerrados++;
    }
  });
  if (impsCerrados) console.log(`[SERVER] Cierre medianoche: ${impsCerrados} improductivo(s) cerrados.`);

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

// (El cierre de turno de Revisión de Telas —manual y automático— vive junto a /api/revision-telas.)

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
  'ia_import':           'ia',
  'prod_update':         'prod',
  'rt_update':           'rt',
  'cp_registro':         'cp',
  'cp_registro_update':  'cp',
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

// ── Aviso proactivo de disco casi lleno ────────────────────────────
// A diferencia de notifySaveError (avisa DESPUÉS de que algo ya falló), esto
// revisa el disco periódicamente y avisa ANTES de llegar a ese punto — así
// da tiempo de liberar espacio o agrandar el disco sin que nada se rompa.
const DISK_WARN_PCT = parseInt(process.env.DISK_WARN_PCT || '80', 10);
let _lastDiskWarnTs = 0;
function chequearDisco() {
  try {
    const salida = require('child_process').execSync(`df -k "${DATA_DIR}"`).toString();
    const linea = salida.trim().split('\n')[1];
    if (!linea) return;
    const usePct = parseInt(linea.trim().split(/\s+/)[4], 10); // ej. "80%" → 80
    if (isNaN(usePct) || usePct < DISK_WARN_PCT) return;
    const now = Date.now();
    if (now - _lastDiskWarnTs < 30 * 60 * 1000) return; // no repetir antes de 30 min
    _lastDiskWarnTs = now;
    console.warn(`[DISCO] Uso al ${usePct}% (umbral ${DISK_WARN_PCT}%) — avisando a las pantallas.`);
    try { broadcast({ type: 'disk_warning', pct: usePct, ts: now }); } catch (e) {}
  } catch (e) { /* "df" no disponible (ej. desarrollo local en Windows) — se ignora */ }
}
setInterval(chequearDisco, 15 * 60 * 1000); // cada 15 minutos
setTimeout(chequearDisco, 30 * 1000);       // primera revisión poco después de arrancar

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
  requirePermiso('area_montajes', 'mmt_locativo'),
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
        fecha:     fechaCO(ahora),
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

app.delete('/alistamiento/api/alistamientos/:id', requirePermiso('area_montajes'), requireClaveAccion, (req, res) => {
  const data = loadDB('alistamientos').filter(r => r.id !== req.params.id);
  if (!saveDB('alistamientos', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
  res.json({ success: true });
});

// PUT: editar/actualizar un alistamiento existente (faltaba esta ruta → al editar daba error)
app.put(
  '/alistamiento/api/alistamientos/:id',
  requirePermiso('area_montajes', 'mmt_locativo'),
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
app.post('/alistamiento/api/multitareas', requirePermiso('area_montajes'), (req, res) => {
  try {
    const missing = requireFields(req.body, ['tarea', 'mecanico']);
    if (missing) return res.status(400).json({ error: `Campos requeridos faltantes: ${missing.join(', ')}` });
    const data  = loadDB('multitareas');
    const ahora = new Date();
    const nuevo = {
      id: uuidv4(), ...req.body,
      fechaHora: ahora.toISOString(),
      fecha:     fechaCO(ahora),
      hora:      ahora.toTimeString().slice(0, 8)
    };
    data.push(nuevo);
    if (!saveDB('multitareas', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true, data: nuevo });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/alistamiento/api/multitareas/:id', requirePermiso('area_montajes'), (req, res) => {
  try {
    const data = loadDB('multitareas');
    const idx  = data.findIndex(r => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'No encontrado' });
    data[idx] = { ...data[idx], ...req.body, id: data[idx].id };
    if (!saveDB('multitareas', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true, data: data[idx] });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/alistamiento/api/multitareas/:id', requirePermiso('area_montajes'), requireClaveAccion, (req, res) => {
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
app.post('/alistamiento/api/tareas', requirePermiso('area_montajes'), (req, res) => {
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
app.put('/alistamiento/api/tareas/:id', requirePermiso('area_montajes'), (req, res) => {
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
app.delete('/alistamiento/api/tareas/:id', requirePermiso('area_montajes'), (req, res) => {
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
  requirePermiso('area_montajes', 'mmt_locativo'),
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
        fecha:     fechaCO(ahora),
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

app.delete('/alistamiento/api/mantenimientos/:id', requirePermiso('area_montajes'), requireClaveAccion, (req, res) => {
  const data = loadDB('mantenimientos').filter(r => r.id !== req.params.id);
  if (!saveDB('mantenimientos', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
  res.json({ success: true });
});

app.put(
  '/alistamiento/api/mantenimientos/:id',
  requirePermiso('area_montajes', 'mmt_locativo'),
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

app.put('/alistamiento/api/alertas/:id/leer', requirePermiso('area_montajes', 'tablero_planta'), (req, res) => {
  const data = loadDB('alertas');
  const a = data.find(x => x.id === req.params.id);
  if (a) a.leida = true;
  if (!saveDB('alertas', data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
  res.json({ success: true });
});

app.put('/alistamiento/api/alertas/leer-todas', requirePermiso('area_montajes', 'tablero_planta'), (req, res) => {
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
  res.setHeader('Content-Disposition', `attachment; filename="Alistamientos_${fechaHoyCO()}.xlsx"`);
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
  res.setHeader('Content-Disposition', `attachment; filename="Mantenimientos_${fechaHoyCO()}.xlsx"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Stats ──────────────────────────────────────────────────────────
app.get('/alistamiento/api/stats', (req, res) => {
  const alistamientos  = loadDB('alistamientos');
  const mantenimientos = loadDB('mantenimientos');
  const alertas        = loadDB('alertas');
  const hoy = fechaHoyCO();
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
// La pantalla de inicio de sesion necesita saber que perfiles existen ANTES de
// que haya sesion, y /api/app-config esta protegido (con razon: lleva los
// permisos de cada perfil y las contrasenas de los modulos). Sin esto, en un
// equipo recien abierto la lista solo mostraba "Programador".
// Aqui se devuelven unicamente los nombres: nada de permisos ni contrasenas.
app.get('/api/perfiles', (req, res) => {
  try {
    const cfg = readJSON(FILES.app_config, {}) || {};
    const retirados = perfilesRetiradosVigente();
    const nombres = (cfg._usuarios_extra || [])
      .filter(u => u && u.nombre && !u.disabled && u.nombre !== 'Programador' && !(retirados && esPerfilRetirado(u.nombre)))
      .map(u => String(u.nombre))
      .sort((a, b) => a.localeCompare(b, 'es'));
    // El Programador solo aparece mientras exista (instalacion nueva sin administradores).
    const prog = (loadUsers().users || {})['Programador'];
    if (prog && !prog.disabled && !retirados) nombres.unshift('Programador');
    res.json({ ok: true, perfiles: nombres });
  } catch (e) {
    console.error('Error [GET perfiles]:', e.message);
    res.status(500).json({ error: e.message, donde: 'GET perfiles' });
  }
});

app.get('/api/app-config', (req, res) => {
  res.json(stripUserPasswords(readJSON(FILES.app_config, {})));
});

// ══════════════════════════════════════════════════════════════════
//  RECUPERAR PERFILES QUE FALTEN EN EL PANEL
// ══════════════════════════════════════════════════════════════════
// Los perfiles viven en dos sitios: users.json (lo que usa el inicio de sesion)
// y _usuarios_extra dentro de app_config (lo que muestra el panel de
// Configuraciones). El panel manda la lista completa y el servidor la
// reemplaza, asi que una pantalla que no alcanzo a cargar podia dejar la lista
// del panel en uno o dos perfiles. Paso el 25/08/2026.
//
// users.json nunca pierde nada (syncUsersFromConfig solo agrega y actualiza),
// asi que sirve para reconstruir. Esto corre al arrancar, solo AGREGA lo que
// falta, y no toca nada si ya estan todos.
// ══════════════════════════════════════════════════════════════════
//  RED DE SEGURIDAD CONTRA BORRADOS MASIVOS
// ══════════════════════════════════════════════════════════════════
// Estas listas se guardan completas: el panel manda la lista entera y aqui se
// reemplaza. Si una pantalla no alcanzo a cargar sus datos, mandaria una lista
// vacia o casi vacia y se perderia todo. Paso el 25/08/2026 con los perfiles.
//
// El panel borra de a un registro, asi que perder tres o mas de golpe siempre
// es un accidente. La unica excepcion es el boton "Limpiar listado", que ya
// pide contrasena y avisa con ?confirmar=1.
//
// Esto es la ultima linea: el navegador ya no deberia mandar nunca una lista
// que no cargo, pero si algun dia vuelve a fallar, aqui no pasa.
const BORRADO_MASIVO = 3;
function avisoBorradoMasivo(req, antes, despues) {
  if (String((req.query || {}).confirmar) === '1') return null;
  const a = Array.isArray(antes)   ? antes.length   : 0;
  const d = Array.isArray(despues) ? despues.length : 0;
  const perdidos = a - d;
  if (perdidos < BORRADO_MASIVO) return null;
  console.warn(`[PROTECCION] Bloqueado un borrado de ${perdidos} de ${a} registros`);
  return `Se iban a borrar ${perdidos} de ${a} registros de una sola vez. ` +
         `Si no fue a proposito, recarga la pagina con Ctrl+F5 e intentalo de nuevo.`;
}

function recuperarPerfilesFaltantes() {
  try {
    const store = loadUsers();
    const usuarios = Object.keys((store && store.users) || {});
    if (!usuarios.length) return;

    const cfg   = readJSON(FILES.app_config, {}) || {};
    const extra = Array.isArray(cfg._usuarios_extra) ? cfg._usuarios_extra : [];
    const yaEstan = new Set(extra.map(u => u && u.nombre).filter(Boolean));

    const recuperados = [];
    for (const nombre of usuarios) {
      if (nombre === 'Programador' || esPerfilRetirado(nombre) || yaEstan.has(nombre)) continue;
      const u = store.users[nombre] || {};
      extra.push({
        nombre,
        perms:       Array.isArray(u.perms) ? u.perms.filter(p => p !== '*') : [],
        disabled:    !!u.disabled,
        passHash:    u.passHash || undefined,
        email:       u.email || '',
        displayName: u.displayName || ''
      });
      recuperados.push(nombre);
    }
    if (!recuperados.length) return;

    cfg._usuarios_extra = extra;
    if (writeJSONSync(FILES.app_config, cfg)) {
      console.log('[PERFILES] Recuperados desde users.json: ' + recuperados.join(', '));
    } else {
      console.error('[PERFILES] No se pudo guardar la recuperacion');
    }
  } catch (e) {
    console.error('[PERFILES] Recuperacion fallo:', e.message);
  }
}
recuperarPerfilesFaltantes();

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
    // Perfiles, permisos y miembros solo los cambia un administrador. Varias
    // pantallas mandan la configuracion ENTERA al guardar cualquier cosa, asi
    // que a los demas no se les rechaza: simplemente se ignoran esas partes.
    if (req.body && typeof req.body === 'object' && !esAdministrador(req)) {
      CLAVES_CONFIG_ADMIN.forEach(k => { delete req.body[k]; });
    }
    if (req.body && req.body._perfil_members) {
      /* Una pantalla abierta desde hace rato guarda la lista como estaba
         entonces: los miembros nuevos desaparecen y, al volverlos a crear,
         quedan sin clave. Por eso se avisa igual que con los perfiles. */
      const perfilDeMas = Object.keys(req.body._perfil_members)
        .map(p => ({ p, aviso: avisoBorradoMasivo(req, (existing._perfil_members || {})[p], req.body._perfil_members[p]) }))
        .find(x => x.aviso);
      if (perfilDeMas) {
        return res.status(409).json({ error: 'En el perfil ' + perfilDeMas.p + ': ' + perfilDeMas.aviso });
      }
      req.body._perfil_members = conservarClavesMiembros(existing._perfil_members, req.body._perfil_members);
    }
    // Los perfiles son el caso que ya se perdio una vez: se protegen igual.
    if (req.body && Array.isArray(req.body._usuarios_extra)) {
      const aviso = avisoBorradoMasivo(req, existing._usuarios_extra, req.body._usuarios_extra);
      if (aviso) return res.status(409).json({ error: aviso });
    }
    if (req.body && typeof req.body === 'object' && perfilesRetiradosVigente()) {
      if (Array.isArray(req.body._usuarios_extra)) {
        req.body._usuarios_extra = req.body._usuarios_extra.filter(u => !(u && esPerfilRetirado(u.nombre)));
      }
      if (req.body._perfil_members && typeof req.body._perfil_members === 'object') {
        Object.keys(req.body._perfil_members).filter(esPerfilRetirado).forEach(k => { delete req.body._perfil_members[k]; });
      }
    }
    const merged = deepMerge(existing, req.body);
    // Las categorias del menu llegan siempre completas. Mezclarlas con las
    // guardadas impedia borrar o renombrar una: la vieja se quedaba para siempre.
    if (req.body && req.body._menu_categoria_modulos && typeof req.body._menu_categoria_modulos === 'object') {
      merged._menu_categoria_modulos = req.body._menu_categoria_modulos;
    }
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
// Cuanto vive un token. Eran 30 dias: uno robado servia un mes entero. Siete
// bastan, porque la sesion se renueva sola en cada visita (ver /api/me): quien
// entra a diario no nota nada, y quien no aparece en una semana vuelve a
// escribir su clave una vez.
/* 30 dias. Habia bajado a 7, pero la sesion solo se renueva cuando se abre la
   pantalla de inicio; una tablet que se queda dias en una sola pantalla (el
   Contador, el tablero) perdia la sesion pasada la semana y al refrescar la
   deslogeaba. La seguridad que daba el plazo corto ya la da el corte de sesiones
   (cambiar clave, dar de baja, quitar acceso cierran las sesiones al instante). */
const SESSION_TOKEN_TTL = 30 * 24 * 60 * 60 * 1000;
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
    const exp     = Date.now() + SESSION_TOKEN_TTL;
    const token   = signToken({ user, rol: u.rol || '', iat: Date.now(), exp });
    res.json({ ok: true, token, user, perms: u.perms || [], rol: u.rol || '', exp });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});


// ══════════════════════════════════════════════════════════════════
//  ENTRAR CON CEDULA
// ══════════════════════════════════════════════════════════════════
// Convive con /api/login, que sigue sirviendo para los equipos (Televisor,
// Mecanicos, Modulos). Ninguno estorba al otro.
const ERROR_ENTRAR = 'Cédula o contraseña incorrecta';

app.post('/api/entrar', rateLimit(20, 60 * 1000), (req, res) => {
  try {
    if (bloqueadoPorFallos(req)) {
      return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera un minuto.' });
    }
    const cedula = soloDigitos((req.body || {}).cedula);
    const clave  = String((req.body || {}).clave || '');
    if (!cedula || !clave) return res.status(400).json({ ok: false, error: ERROR_ENTRAR });

    const r = cuentaDeCedula(cedula);
    if (!r.ok) {
      anotarFallo(req);
      console.warn('[ACCESOS] entrada rechazada (' + r.no + ') desde IP ' + req.ip);
      return res.status(401).json({ ok: false, error: ERROR_ENTRAR });
    }
    if (!bcrypt.compareSync(clave, r.cuenta.hash || '')) {
      anotarFallo(req);
      console.warn('[ACCESOS] clave incorrecta para una cedula desde IP ' + req.ip);
      return res.status(401).json({ ok: false, error: ERROR_ENTRAR });
    }

    const exp = Date.now() + SESSION_TOKEN_TTL;
    const token = signToken({ user: r.cedula, tipo: 'persona', rol: '', iat: Date.now(), exp });
    res.json({
      ok: true, token, exp,
      cedula: r.cedula,
      nombre: r.emp.name || '',
      cargo:  r.emp.cargo || '',
      admin:  r.cuenta.admin === true,
      perms:  r.cuenta.perms || []
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Administrar quien entra (solo administradores) ──
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (permisosDeLaPeticion(req.auth).admin) return next();
    return res.status(403).json({ error: 'Solo un administrador puede hacer esto' });
  });
}

/* Cuantos administradores quedarian si se aplicara un cambio. Sirve para no
   dejar nunca el sistema sin nadie que pueda administrarlo. */
function administradoresActivos(accesos, cambio) {
  const cuentas = Object.assign({}, accesos.cuentas);
  if (cambio) cuentas[cambio.cedula] = cambio.nueva;   // nueva = null si se borra
  return Object.keys(cuentas).filter(c => {
    const x = cuentas[c];
    if (!x || x.disabled || x.admin !== true) return false;
    const e = empleadoPorCedula(c);
    return !!(e && !e.disabled);
  }).length;
}

/* ── Retiro de los perfiles Programador y Administrador ───────────────
   Decision del dueno: nadie entra "como equipo" con un perfil de administracion;
   quien administra es una PERSONA marcada como administradora en su cuenta de
   acceso (entra con cedula y clave). Estos dos perfiles se borran de todo: del
   almacen de usuarios, de la lista de perfiles y de los miembros, y sus
   sesiones abiertas se cierran.

   Seguridad contra quedarse sin entrada: solo se retiran si existe AL MENOS UN
   administrador activo por cedula, con clave puesta. Si no lo hay, no se toca
   nada y se avisa en el registro; se vuelve a intentar al arrancar y cada vez
   que se guarda una cuenta de acceso. */
// function (no const): el arranque la usa antes de llegar a esta parte del archivo.
function esPerfilRetirado(n) {
  return ['programador', 'administrador'].includes(String(n == null ? '' : n).trim().toLowerCase());
}

function administradoresConClave() {
  const accesos = cargarAccesos();
  return Object.keys(accesos.cuentas || {}).filter(c => {
    const x = accesos.cuentas[c];
    if (!x || x.disabled || x.admin !== true || !x.hash) return false;
    const e = empleadoPorCedula(c);
    return !!(e && !e.disabled);
  }).length;
}
function perfilesRetiradosVigente() {
  try { return administradoresConClave() >= 1; } catch (e) { return false; }
}

function retirarPerfilesAdmin(origen) {
  try {
    const store = loadUsers();
    const users = store.users || {};
    const cfg = readJSON(FILES.app_config, {}) || {};
    const extra = Array.isArray(cfg._usuarios_extra) ? cfg._usuarios_extra : [];
    const miembros = (cfg._perfil_members && typeof cfg._perfil_members === 'object') ? cfg._perfil_members : {};

    const enUsers    = Object.keys(users).filter(esPerfilRetirado);
    const enExtra    = extra.filter(u => u && esPerfilRetirado(u.nombre));
    const enMiembros = Object.keys(miembros).filter(esPerfilRetirado);
    if (!enUsers.length && !enExtra.length && !enMiembros.length) return false;   // nada que retirar

    if (administradoresConClave() < 1) {
      console.warn('[ACCESOS] No se retiran los perfiles Programador/Administrador: todavia no hay ningun administrador activo por cedula con clave. Marca a alguien como administrador en Configuraciones → Usuarios y permisos.');
      return false;
    }

    const nombres = new Set([...enUsers, ...enExtra.map(u => u.nombre)]);
    enUsers.forEach(n => { delete users[n]; });
    store.users = users;
    store.updatedAt = new Date().toISOString();
    writeJSONSync(FILES.users, store);

    cfg._usuarios_extra = extra.filter(u => !(u && esPerfilRetirado(u.nombre)));
    enMiembros.forEach(k => { delete miembros[k]; });
    if (cfg._perfil_members) cfg._perfil_members = miembros;
    writeJSON(FILES.app_config, cfg);

    nombres.forEach(n => cortarSesiones(n));
    console.log('[ACCESOS] Perfiles retirados (' + (origen || 'arranque') + '): ' +
      ([...nombres].concat(enMiembros).join(', ') || '—') + '. Ahora se entra con cedula y clave.');
    return true;
  } catch (e) {
    console.error('[ACCESOS] No se pudieron retirar los perfiles:', e.message);
    return false;
  }
}

/* La lista para Configuraciones. Junta la ficha de empleados con las cuentas,
   para que se vea todo el mundo y quien tiene acceso.
   La contrasena SOLO viaja si quien pregunta es administrador — que es lo que
   pidio el usuario: poder verla desde Configuraciones. */
app.get('/api/accesos', requireAdmin, (req, res) => {
  try {
    const accesos = cargarAccesos();
    const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
    const filas = (st.employees || []).map(e => {
      const c = soloDigitos(e.cedula);
      const x = accesos.cuentas[c];
      return {
        cedula: c,
        nombre: e.name || '',
        cargo:  e.cargo || '',
        modulo: e.module || e.modulo || '',
        activo: !e.disabled,
        entra:  !!x && !x.disabled,
        admin:  !!(x && x.admin),
        perms:  (x && x.perms) || [],
        clave:  x ? (descifrarClave(x.clave) || '(no se puede leer)') : ''
      };
    }).sort((a, b) => String(a.nombre).localeCompare(String(b.nombre), 'es'));
    res.json({ ok: true, filas, administradores: administradoresActivos(accesos) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* Crear o cambiar una cuenta. Si no se manda clave, se deja la que tenia; si
   es cuenta nueva y no se manda, la clave inicial es la cedula. */
app.post('/api/accesos', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const cedula = soloDigitos(b.cedula);
    if (!cedula) return res.status(400).json({ ok: false, error: 'Falta la cédula' });
    const emp = empleadoPorCedula(cedula);
    if (!emp) return res.status(404).json({ ok: false, error: 'Esa cédula no está en la ficha de empleados' });

    const accesos = cargarAccesos();
    const antes = accesos.cuentas[cedula] || null;

    if (b.quitar === true) {
      if (antes && antes.admin && administradoresActivos(accesos, { cedula, nueva: null }) < 1) {
        return res.status(409).json({ ok: false, error: 'No se puede: el sistema quedaría sin ningún administrador activo.' });
      }
      delete accesos.cuentas[cedula];
      guardarAccesos(accesos);
      cortarSesiones(cedula);   // sin esto seguia entrando con la sesion abierta
      return res.json({ ok: true, quitado: true });
    }

    const nueva = Object.assign({
      clave: '', hash: '', perms: [], admin: false, disabled: false,
      creado: new Date().toISOString(), creadoPor: String((req.auth && req.auth.user) || '')
    }, antes || {});

    if (Array.isArray(b.perms)) nueva.perms = b.perms.filter(x => typeof x === 'string');
    if (b.admin !== undefined)    nueva.admin = b.admin === true;
    if (b.disabled !== undefined) nueva.disabled = b.disabled === true;

    // La clave: la que manden, o la cedula si la cuenta es nueva
    const claveNueva = (b.clave != null && String(b.clave) !== '') ? String(b.clave)
                     : (!antes ? cedula : null);
    /* La pantalla de Configuraciones manda SIEMPRE la clave que ve en el formulario,
       aunque solo se haya tocado un permiso. Eso no es una clave nueva: si se
       tomaba como tal, cada vez que un administrador le activaba algo a alguien se
       le cerraba la sesion. Solo cuenta como cambio si la clave es distinta de la
       que ya tiene. */
    const claveCambio = claveNueva !== null &&
      !(antes && antes.hash && bcrypt.compareSync(claveNueva, antes.hash));
    if (claveCambio) {
      nueva.clave = cifrarClave(claveNueva);
      nueva.hash  = bcrypt.hashSync(claveNueva, BCRYPT_ROUNDS);
      nueva.cambiado = new Date().toISOString();
    }

    // Nunca sin administradores
    if (administradoresActivos(accesos, { cedula, nueva }) < 1) {
      return res.status(409).json({ ok: false, error: 'No se puede: el sistema debe mantener al menos un administrador activo.' });
    }

    accesos.cuentas[cedula] = nueva;
    guardarAccesos(accesos);
    /* Clave nueva o cuenta bloqueada: las sesiones abiertas se cierran. Una
       cuenta recien creada no tiene ninguna, asi que no se corta nada. */
    if (antes && (claveCambio || (!antes.disabled && nueva.disabled === true))) {
      cortarSesiones(cedula);
    }
    // Si con esta cuenta ya hay un administrador por cedula, se retiran los perfiles viejos.
    retirarPerfilesAdmin('cuenta guardada');
    res.json({ ok: true, cedula, nombre: emp.name || '' });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/* Autorizar en bloque por cargo. Se usa para dar el Contador de Produccion a
   todas las operarias de una vez. A quien ya tiene cuenta solo se le suma el
   permiso: no se le toca la clave ni lo demas. */
app.post('/api/accesos/por-cargo', requireAdmin, (req, res) => {
  try {
    const b = req.body || {};
    const cargos = (Array.isArray(b.cargos) ? b.cargos : []).map(c => cargoIgual(c)).filter(Boolean);
    const permisos = (Array.isArray(b.perms) ? b.perms : []).filter(x => typeof x === 'string');
    if (!cargos.length || !permisos.length) {
      return res.status(400).json({ ok: false, error: 'Faltan los cargos o los permisos' });
    }
    const st = (typeof iaState === 'object' && iaState) ? iaState : readJSON(FILES.ia_state, {}) || {};
    const accesos = cargarAccesos();
    let nuevas = 0, actualizadas = 0;

    (st.employees || []).forEach(e => {
      if (!e || e.disabled) return;
      if (!cargos.includes(cargoIgual(e.cargo))) return;
      const c = soloDigitos(e.cedula);
      if (!c) return;
      const antes = accesos.cuentas[c];
      if (antes) {
        const tenia = new Set(antes.perms || []);
        const faltan = permisos.filter(p => !tenia.has(p));
        if (!faltan.length) return;
        antes.perms = (antes.perms || []).concat(faltan);
        actualizadas++;
      } else {
        accesos.cuentas[c] = {
          clave: cifrarClave(c),
          hash:  bcrypt.hashSync(c, BCRYPT_ROUNDS),
          perms: permisos.slice(),
          admin: false, disabled: false,
          creado: new Date().toISOString(),
          creadoPor: String((req.auth && req.auth.user) || ''),
          porCargo: e.cargo || ''
        };
        nuevas++;
      }
    });

    guardarAccesos(accesos);
    res.json({ ok: true, nuevas, actualizadas, total: nuevas + actualizadas });
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

// Verifica una sesión existente (usado por el cliente al recargar/reabrir la app).
// Renueva el token (ventana deslizante de 30 días) para que una sesión activa
// nunca expire por sí sola — solo termina con "Cerrar sesión" o si el usuario
// se deshabilita/borra, igual que Gmail/GitHub.
app.get('/api/me', (req, res) => {
  const hdr   = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.headers['x-session-token'] || '');
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ ok: false });

  // Una persona que entro con cedula. Se vuelve a comprobar TODO cada vez: si
  // la dieron de baja en la ficha o le quitaron el acceso, deja de entrar sola.
  if (payload.tipo === 'persona') {
    const r = cuentaDeCedula(payload.user);
    if (!r.ok) return res.status(401).json({ ok: false });
    const exp = Date.now() + SESSION_TOKEN_TTL;
    return res.json({
      ok: true, tipo: 'persona', user: r.cedula,
      nombre: r.emp.name || '', cargo: r.emp.cargo || '',
      admin: r.cuenta.admin === true, perms: r.cuenta.perms || [], rol: '',
      token: signToken({ user: r.cedula, tipo: 'persona', rol: '', iat: Date.now(), exp }), exp
    });
  }

  const store = loadUsers();
  const u = store.users[payload.user];
  if (!u || u.disabled) return res.status(401).json({ ok: false });
  const exp = Date.now() + SESSION_TOKEN_TTL;
  const newToken = signToken({ user: payload.user, rol: u.rol || '', iat: Date.now(), exp });
  res.json({ ok: true, user: payload.user, perms: u.perms || [], rol: u.rol || '', displayName: u.displayName || '', email: u.email || '', token: newToken, exp });
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

  /* Quien entro con su cedula no esta en la tabla de perfiles: sus datos viven
     en su cuenta de acceso. Sin esto la pantalla respondia 'no autenticado' y
     la persona no podia ni ver ni cambiar nada. */
  if (payload.tipo === 'persona') {
    const r = cuentaDeCedula(payload.user);
    if (!r.ok) return res.status(401).json({ ok: false, error: 'No autenticado' });
    return res.json({
      ok: true,
      tipo: 'persona',
      user: r.cedula,
      nombre: r.emp.name || '',
      displayName: r.cuenta.displayName || '',
      email: r.cuenta.email || '',
      rol: r.cuenta.admin === true ? 'Administrador' : ''
    });
  }

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
    const { displayName, email, currentPass, newPass } = req.body || {};
    let claveNuevaPuesta = false;   // para cerrar las demas sesiones si la cambia

    /* Quien entro con su cedula guarda en su cuenta de acceso, no en la tabla
       de perfiles. La contrasena se comprueba contra la suya de verdad, y al
       cambiarla se actualiza tambien la copia cifrada, para que el
       administrador la siga viendo en Configuraciones. */
    if (payload.tipo === 'persona') {
      const r = cuentaDeCedula(payload.user);
      if (!r.ok) return res.status(401).json({ ok: false, error: 'No autenticado' });
      const accesos = cargarAccesos();
      const cuenta  = accesos.cuentas[r.cedula];
      if (!cuenta) return res.status(401).json({ ok: false });

      if (newPass != null && String(newPass) !== '') {
        if (String(newPass).length < 4) {
          return res.status(400).json({ ok: false, error: 'La contraseña nueva es muy corta: al menos 4 caracteres.' });
        }
        if (!bcrypt.compareSync(String(currentPass == null ? '' : currentPass), cuenta.hash || '')) {
          return res.status(400).json({ ok: false, error: 'La contraseña actual no es correcta' });
        }
        cuenta.clave    = cifrarClave(String(newPass));
        cuenta.hash     = bcrypt.hashSync(String(newPass), BCRYPT_ROUNDS);
        cuenta.cambiado = new Date().toISOString();
        claveNuevaPuesta = true;
      }
      if (displayName != null) cuenta.displayName = String(displayName).trim().slice(0, 80);
      if (email != null)       cuenta.email       = String(email).trim().slice(0, 120);

      accesos.cuentas[r.cedula] = cuenta;
      if (!guardarAccesos(accesos)) {
        return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
      }
      /* Cambiar la propia contrasena cierra las demas sesiones: es lo que uno
         espera cuando cree que alguien entro con su clave. La pestaña desde la
         que se cambio recibe una sesion nueva para no quedar fuera. */
      const salida = {
        ok: true, tipo: 'persona', user: r.cedula,
        displayName: cuenta.displayName || '', email: cuenta.email || ''
      };
      if (claveNuevaPuesta) {
        cortarSesiones(r.cedula);
        salida.exp   = Date.now() + SESSION_TOKEN_TTL;
        salida.token = signToken({ user: r.cedula, tipo: 'persona', rol: '', iat: Date.now(), exp: salida.exp });
      }
      return res.json(salida);
    }

    const store = loadUsers();
    const u = store.users[payload.user];
    if (!u || u.disabled) return res.status(401).json({ ok: false });

    if (newPass != null && String(newPass) !== '') {
      if (!bcrypt.compareSync(String(currentPass == null ? '' : currentPass), u.passHash)) {
        return res.status(400).json({ ok: false, error: 'La contraseña actual no es correcta' });
      }
      u.passHash = bcrypt.hashSync(String(newPass), BCRYPT_ROUNDS);
      claveNuevaPuesta = true;
    }
    if (displayName != null) u.displayName = String(displayName).trim().slice(0, 80);
    if (email != null)       u.email       = String(email).trim().slice(0, 120);

    store.users[payload.user] = u;
    store.updatedAt = new Date().toISOString();
    if (!writeJSONSync(FILES.users, store)) {
      return res.status(500).json({ ok: false, error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    const salida = { ok: true, user: payload.user, displayName: u.displayName || '', email: u.email || '' };
    if (claveNuevaPuesta) {
      cortarSesiones(payload.user);
      salida.exp   = Date.now() + SESSION_TOKEN_TTL;
      salida.token = signToken({ user: payload.user, rol: u.rol || '', iat: Date.now(), exp: salida.exp });
    }
    res.json(salida);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Verifica una contraseña contra cualquier usuario habilitado (gate de borrado).
// Replica el comportamiento actual: cualquier contraseña válida del sistema
// (incluida la del Programador) autoriza la acción. Rate-limit para frenar fuerza bruta.
// Autoriza acciones delicadas (borrar, limpiar una seccion entera).
// Antes valia la contrasena de CUALQUIER usuario activo: una operaria con
// acceso solo de lectura podia autorizar un borrado con su propia clave.
// Ahora usa la misma regla que /api/verificar-clave-accion (claveAccionValida):
// la clave de accion, un perfil con mando, o un administrador por cedula.
// No se duplica la comprobacion: se reutiliza la que ya existia.
app.post('/api/verify-pass', rateLimit(20, 60 * 1000), (req, res) => {
  try {
    if (bloqueadoPorFallos(req)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera un minuto.' });
    const { pass } = req.body || {};
    if (pass == null) return res.status(400).json({ ok: false });
    const ok = claveAccionValida('general', pass);
    if (!ok) { anotarFallo(req); console.warn(`[AUTH] verify-pass fallido desde IP ${req.ip}`); }
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── Clave para acciones delicadas (borrar, editar, cerrar a la fuerza) ──
// Antes cada pantalla traia la clave escrita en su codigo ('1', '2', '13') y
// cualquiera podia leerla desde el navegador. Ahora la revisa el servidor.
// Se puede cambiar en el servidor con CLAVE_ACCION_GENERAL / _CIERRE / _CI;
// si no se define, sigue la de siempre. Tambien sirve la contraseña del
// Programador o la de cualquier perfil con el permiso "fix".
const CLAVES_ACCION = {
  general: process.env.CLAVE_ACCION_GENERAL || '1',
  cierre:  process.env.CLAVE_ACCION_CIERRE  || '2',
  ci:      process.env.CLAVE_ACCION_CI      || '13'
};
function claveAccionValida(tipo, clave) {
  const p = String(clave == null ? '' : clave);
  if (!p) return false;
  const fija = CLAVES_ACCION[tipo] || CLAVES_ACCION.general;
  if (p === fija) return true;
  // La contrasena de un perfil con mando (el Programador, o uno con 'fix')
  const users = loadUsers().users || {};
  const valePerfil = Object.keys(users).some(nombre => {
    const u = users[nombre];
    if (!u || u.disabled || !u.passHash) return false;
    const esAdmin = u.rol === 'programador' || nombre === 'Programador' || (u.perms || []).includes('fix');
    return esAdmin && bcrypt.compareSync(p, u.passHash);
  });
  if (valePerfil) return true;
  /* La contrasena de cualquier administrador que entre con su cedula. Sin
     esto, las pantallas que piden "la contrasena del Programador" —quitar una
     foto en Ordenes, borrar un registro— se quedaban cerradas para ellos: no
     tienen perfil, y por tanto no tienen esa contrasena. */
  const cuentas = cargarAccesos().cuentas || {};
  return Object.keys(cuentas).some(ced => {
    const c = cuentas[ced];
    if (!c || c.disabled || c.admin !== true || !c.hash) return false;
    return bcrypt.compareSync(p, c.hash);
  });
}
// Freno contra quien prueba claves al azar: bloqueadoPorFallos / anotarFallo vienen de
// limitador.js (20 equivocadas por minuto, por IP real y por ruta).

app.post('/api/verificar-clave-accion', (req, res) => {
  try {
    if (bloqueadoPorFallos(req)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera un minuto.' });
    const { tipo, clave } = req.body || {};
    const ok = claveAccionValida(String(tipo || 'general'), clave);
    if (!ok) { anotarFallo(req); console.warn(`[AUTH] clave de accion (${tipo || 'general'}) fallida desde IP ${req.ip}`); }
    res.json({ ok });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// CI Config (para modal Solicitar Insumos en index.html)
app.get('/api/ci-config', (req, res) => {
  res.json(ciConfig);
});

// Lista de módulos activos según configuración del Programador
// ── Módulos ocultos del Tablero de Producción ──────────────────────
// Cada perfil decide qué módulos no quiere ver. Se guarda por perfil y en el
// SERVIDOR, no en el navegador: así el televisor de la planta conserva su
// vista aunque se reinicie, y esconder un módulo desde un PC no se lo esconde
// a los demás.
app.get('/api/tablero-produccion/ocultos', (req, res) => {
  const todos  = readJSON(FILES.tp_ocultos, {});
  const perfil = String(req.query.perfil || '').trim();
  res.json({ ocultos: (perfil && todos[perfil]) || [] });
});

app.post('/api/tablero-produccion/ocultos', requirePermiso('tablero_eficiencia', 'tablero_produccion'), (req, res) => {
  try {
    const b = req.body || {};
    const perfil = String(b.perfil || '').trim();
    if (!perfil) return res.status(400).json({ error: 'Falta el perfil' });
    const todos = readJSON(FILES.tp_ocultos, {});
    const lista = Array.isArray(b.ocultos)
      ? b.ocultos.map(x => String(x).trim()).filter(Boolean)
      : [];
    if (lista.length) todos[perfil] = lista;
    else delete todos[perfil];          // sin ocultos, no se guarda nada
    if (!writeJSON(FILES.tp_ocultos, todos)) {
      return res.status(500).json({ error: 'No se pudo guardar' });
    }
    res.json({ ok: true, ocultos: lista });
  } catch (e) {
    console.error('Error [POST tablero-produccion/ocultos]:', e.message);
    res.status(500).json({ error: e.message, donde: 'POST tablero-produccion/ocultos' });
  }
});

// ── Estado de piso de todos los módulos ────────────────────────────
// Quién está parado y desde cuándo. El tablero de improductivos lo recibe por
// WebSocket; esto es para que el de Producción pueda pintarse de una vez, sin
// esperar la conexión, y para que siga sirviendo si el WebSocket no levanta.
app.get('/api/estado-modulos', (req, res) => {
  res.json({ estados: { ...states }, desde: { ...stateTimes } });
});

// ── Qué trabaja cada módulo ────────────────────────────────────────
// Lo reporta el Contador de Producción al elegir orden y operación, y lo leen
// el propio Contador (al refrescar, para volver donde estaba) y el Tablero de
// Producción (para mostrar la referencia de cada módulo).
app.get('/api/modulo-trabajo', (req, res) => {
  const { modulo } = req.query;
  if (modulo) return res.json({ trabajo: trabajoActual[String(modulo).trim()] || null });
  res.json({ trabajos: trabajoActual });
});

app.post('/api/modulo-trabajo', requirePermiso('tablero_produccion', 'modulos'), (req, res) => {
  try {
    const b = req.body || {};
    const modulo = String(b.modulo || '').trim();
    if (!modulo) return res.status(400).json({ error: 'Falta el módulo' });

    const previo = trabajoActual[modulo];

    // Sin OP se entiende que esa tablet cerró. El casillero solo se suelta si
    // era suyo: si sale otra, la del módulo se queda como estaba.
    if (!b.op) {
      const quien = String(b.operaria || '').trim();
      if (previo && quien && previo.operaria && previo.operaria !== quien) {
        return res.json({ ok: true, trabajo: previo });
      }
      delete trabajoActual[modulo];
      saveFloorState();
      broadcast({ type: 'trabajo_change', modulo, trabajo: null });
      return res.json({ ok: true, trabajo: null });
    }

    // Una tablet que no lleva la operación balanceada no le quita el puesto a
    // la que sí: el Tablero mide al módulo por esa.
    if (!b.esBalanceada && previo && previo.esBalanceada) {
      return res.json({ ok: true, trabajo: previo });
    }
    const mismo  = previo && previo.op === String(b.op).trim()
                          && previo.operacion === String(b.operacion || '').trim();
    const trabajo = {
      operaria:  String(b.operaria  || '').trim(),
      op:        String(b.op        || '').trim(),
      ref:       String(b.ref       || '').trim(),
      operacion: String(b.operacion || '').trim(),
      meta:      Number(b.meta)     > 0 ? Number(b.meta)     : 0,
      personas:  Number(b.personas) > 0 ? Number(b.personas) : 0,
      esBalanceada: !!b.esBalanceada,
      // Si sigue en lo mismo se conserva la hora de inicio: cambiar de tablet
      // o refrescar la pantalla no debe reiniciar el contador de tiempo.
      desde:     mismo ? previo.desde : Date.now()
    };
    trabajoActual[modulo] = trabajo;
    saveFloorState();
    broadcast({ type: 'trabajo_change', modulo, trabajo });
    res.json({ ok: true, trabajo });
  } catch (e) {
    console.error('Error [POST modulo-trabajo]:', e.message);
    res.status(500).json({ error: e.message, donde: 'POST modulo-trabajo' });
  }
});

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

/* Estado de cada mecánico: disponible, atendiendo (módulo, persona, desde cuándo) o en alistamiento.
   Sale de lo que el servidor ya sabe de los módulos (estado-mecanicos.js). Pide el permiso del módulo. */
app.get('/api/estado-mecanicos', requirePermiso('estado_mecanicos'), (req, res) => {
  try {
    const miembros = (readJSON(FILES.app_config, {}) || {})._perfil_members || {};
    res.json({ ok: true, ahora: Date.now(),
      mecanicos: calcularEstadoMecanicos({
        mecanicos: mecanicosDelPerfil(miembros), multitareas: loadDB('multitareas'), multiImps, states, lastMec, stateTimes, lastEmpleada, esPropio: esImpPropio
      }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* La foto de un mecánico: la pantalla de Configuraciones la reduce (unos 320 px, JPEG) y la manda aquí.
   Se guarda como archivo en la carpeta de fotos y se devuelve su nombre; el nombre queda en el miembro del perfil.
   Solo JPEG, de verdad (se mira el encabezado del archivo, no lo que diga el navegador), y pequeña. */
app.post('/api/mecanicos/foto', requireAdmin, rateLimit(40, 60 * 1000), (req, res) => {   // los miembros de un perfil solo los cambia un administrador
  try {
    const dato = String((req.body || {}).imagen || '');
    const m = dato.match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
    if (!m) return res.status(400).json({ error: 'La foto debe ser una imagen JPEG.' });
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length < 200 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) return res.status(400).json({ error: 'El archivo no es una imagen JPEG válida.' });
    if (buf.length > 400 * 1024) return res.status(413).json({ error: 'La foto pesa demasiado (máximo 400 KB).' });
    const nombre = 'mec-' + Date.now() + '-' + uuidv4().slice(0, 8) + '.jpg';
    fs.writeFileSync(path.join(UPLOADS_DIR, nombre), buf);
    archivos.anotarSubida(nombre);      // se puede ver ya, antes de guardar el miembro
    res.json({ ok: true, archivo: nombre });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

/* ¿Es este mecánico? En el Contador, al elegir quién llegó a atender, quién
   solucionó o quién hace el alistamiento, se pide su contraseña (la de
   Miembros → Mecánicos). Se revisa aquí para que las contraseñas no viajen a
   las tablets. Si el mecánico todavía no tiene contraseña, pasa sin pedirla. */
// Revisa la clave de un miembro de un perfil (Mecanicos, Supervisoras, Telas…).
// El perfil se busca sin importar mayusculas. Devuelve lo mismo que respondian
// las pantallas cuando comparaban la clave ellas mismas.
function verificarMiembro(perfil, nombre, pass) {
  const pm  = readJSON(FILES.app_config, {})._perfil_members || {};
  const key = Object.keys(pm).find(k => k.toLowerCase() === String(perfil || '').toLowerCase());
  const lista = (key && Array.isArray(pm[key]) ? pm[key] : []).filter(m => m && !m.disabled);
  const m = lista.find(x => compararNombres(typeof x === 'string' ? x : (x.nombre || x.name), nombre));
  if (!m) return { status: 404, ok: false, error: `Esa persona no está en Miembros → ${perfil}` };
  const clave = typeof m === 'string' ? '' : String(m.pass || '');
  if (!clave) return { ok: true, sinClave: true };
  if (!pass)  return { ok: false, pideClave: true };
  return { ok: pass === clave, pideClave: true };
}
function responderVerificarMiembro(perfil, req, res) {
  try {
    const nombre = String((req.body && req.body.nombre) || '').trim();
    const pass   = String((req.body && req.body.pass) || '');
    if (bloqueadoPorFallos(req)) return res.status(429).json({ ok: false, error: 'Demasiados intentos. Espera un minuto.' });
    const r = verificarMiembro(perfil, nombre, pass);
    if (r.ok === false && r.pideClave && pass) { anotarFallo(req); console.warn(`[AUTH] clave de miembro fallida (${perfil}) desde IP ${req.ip}`); }
    res.status(r.status || 200).json(r);
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
}
app.post('/api/mecanicos/verificar',
  (req, res) => responderVerificarMiembro('Mecanicos', req, res));
app.post('/api/miembros/verificar',
  (req, res) => responderVerificarMiembro(String((req.body && req.body.perfil) || ''), req, res));

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
app.post('/api/novedades', requirePermiso('configuraciones', 'area_asistencia'), (req, res) => {
  try {
    const aviso = avisoBorradoMasivo(req, readJSON(FILES.novedades, []), req.body);
    if (aviso) return res.status(409).json({ error: aviso });
    if (!writeJSON(FILES.novedades, Array.isArray(req.body) ? req.body : [])) {
      return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});



// Maquinaria
app.get('/api/maquinaria',  (req, res) => res.json(readJSON(FILES.maquinaria, [])));
app.post('/api/maquinaria', requireAccion('editar', 'configuraciones'), (req, res) => {
  try {
    const aviso = avisoBorradoMasivo(req, readJSON(FILES.maquinaria, []), req.body);
    if (aviso) return res.status(409).json({ error: aviso });
    if (!writeJSON(FILES.maquinaria, req.body)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Guías
app.get('/api/guias',  (req, res) => res.json(readJSON(FILES.guias, [])));
app.post('/api/guias', requireAccion('editar', 'configuraciones'), (req, res) => {
  try {
    const aviso = avisoBorradoMasivo(req, readJSON(FILES.guias, []), req.body);
    if (aviso) return res.status(409).json({ error: aviso });
    if (!writeJSON(FILES.guias, req.body)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Turnos
// ── Las horas del turno, siempre como "HH:MM" ─────────────────────
// Cuando el horario se pega desde Excel, cada hora llega como una fraccion del
// dia: las 6 de la manana son 0.25 y las 12:35 son 0.5243055555555556. La app
// las entiende, pero en Configuraciones se ven asi y no hay forma de editarlas.
//
// Aqui se traducen a "06:00" tanto al leer como al guardar. La conversion es
// exacta, asi que no se pierde nada.
function horaLegible(v) {
  if (v == null || v === '') return v;
  if (typeof v === 'string' && v.includes(':')) return v;   // ya esta bien
  const f = parseFloat(v);
  if (!Number.isFinite(f)) return v;
  if (f < 0 || f > 1) return v;                             // no es una fraccion de dia
  const min = Math.round(f * 1440) % 1440;
  return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0');
}
function turnosLegibles(turnos) {
  if (!Array.isArray(turnos)) return turnos;
  turnos.forEach(t => (t && t.horas || []).forEach(h => {
    if (!h) return;
    h.comienza = horaLegible(h.comienza);
    h.termina  = horaLegible(h.termina);
  }));
  return turnos;
}

app.get('/api/turnos',  (req, res) => res.json(turnosLegibles(readJSON(FILES.turnos, []))));

// Al arrancar se limpia lo que ya estaba guardado. Solo escribe si de verdad
// habia algo que traducir, y traducir dos veces no cambia nada.
(function limpiarHorasDeTurnos() {
  try {
    const turnos = readJSON(FILES.turnos, []);
    if (!Array.isArray(turnos) || !turnos.length) return;
    const antes = JSON.stringify(turnos);
    const despues = JSON.stringify(turnosLegibles(turnos));
    if (antes === despues) return;
    writeJSONSync(FILES.turnos, turnos);
    console.log('[TURNOS] Horas traducidas de formato Excel a HH:MM');
  } catch (e) {
    console.error('[TURNOS] No se pudieron traducir las horas:', e.message);
  }
})();
app.post('/api/turnos', requireAccion('editar', 'configuraciones'), (req, res) => {
  try {
    const aviso = avisoBorradoMasivo(req, readJSON(FILES.turnos, []), req.body);
    if (aviso) return res.status(409).json({ error: aviso });
    // Se guardan ya traducidas: aunque alguien vuelva a pegar de Excel, en el
    // archivo quedan como "06:00" y no como 0.25.
    if (!writeJSON(FILES.turnos, turnosLegibles(req.body))) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true });
  }
  catch(e) { res.status(500).json({ error: e.message }); }
});

// Turnos Asignados — asignación manual de turno por revisador y rango de fechas
app.get('/api/turnos-asignados', (req, res) => {
  res.json(readJSON(FILES.turnos_asignados, []));
});
app.post('/api/turnos-asignados', requirePermiso('configuraciones', 'area_asistencia'), (req, res) => {
  try {
    const { revisador, turno, desde, hasta } = req.body || {};
    if (!revisador || !turno || !desde || !hasta)
      return res.status(400).json({ error: 'Faltan campos: revisador, turno, desde, hasta' });
    const data = readJSON(FILES.turnos_asignados, []);
    const nueva = {
      id: uuidv4(),
      revisador, turno, desde, hasta,
      fechaAsignado: fechaHoyCO()
    };
    data.push(nueva);
    if (!writeJSON(FILES.turnos_asignados, data)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, asignacion: nueva });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/turnos-asignados/:id', requirePermiso('configuraciones', 'area_asistencia'), (req, res) => {
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
  // Filtros opcionales. Sin ellos devuelve todo, como siempre, para no romper
  // a quien ya lo usaba asi.
  const { fecha, desde, hasta, modulo } = req.query;
  const filtrar = fecha || desde || hasta || modulo;
  const contPorFecha = {};
  let modificado = false;

  h = h.map(r => {
    let reg = { ...r };

    // 0. Identificador propio. El historial nunca lo tuvo: se identificaba por
    // posicion en el array, que se corre al borrar y al recortar por
    // HISTORIAL_MAX. La pantalla de Tiempos Improductivos edita y valida
    // registros concretos, y necesita una referencia que no se mueva.
    if(!reg.id){ reg.id = uuidv4(); modificado = true; }

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

    // 2. La persona se conserva SIEMPRE
    //
    // Aquí antes se borraba el nombre de la operaria en Espera Insumos,
    // Producción Solicitada, Cambio de Referencia y Alistamiento. Y no era solo
    // que no se mostrara: el borrado marcaba el archivo como modificado y se
    // guardaba, así que el dato se perdía de verdad, cada vez que alguien abría
    // Tiempos Improductivos.
    //
    // En los improductivos de mecánico la persona es la que ALGUIEN ELIGIÓ: la
    // operaria que necesita el servicio. En los demás nadie elige, así que es
    // quien lo reportó — la que tiene el contador abierto en ese módulo. Las dos
    // cosas son útiles y las dos van en la misma columna.
    //
    // El mecánico sí sigue siendo solo de los suyos, pero eso ya lo decide
    // logHistorial al guardar: para los otros tipos nunca escribe mecánico.
    // yellow (Atención Mecánico): operaria y mecánico — no tocar

    return reg;
  });

  if(modificado) writeJSON(FILES.historial, h);

  /* Apoyos (despachos, otra área): no son tiempo improductivo.
     - Pedido con filtros: se quitan, salvo que la pantalla los pida con
       apoyos=1 (Contador, Informe de Empaque, hora a hora y tableros, que los
       necesitan para que esa hora no baje la eficiencia).
     - Lista completa: NO se quitan, porque el Tablero y la pantalla de inicio
       borran y editan por posición; van marcados (esApoyo) y esas pantallas no
       los muestran. La marca solo va en la respuesta, no se guarda. */
  const apoyos = clavesDeApoyo();
  if (apoyos.size) h = h.map(r => apoyos.has(r.estadoAnterior || r.tipo) ? { ...r, esApoyo: true } : r);
  const conApoyos = String(req.query.apoyos || '') === '1';

  // El filtro va DESPUES de normalizar: los registros viejos sin id o sin num
  // se arreglan y se guardan igual, se pidan o no.
  if(filtrar){
    const f = r => {
      const d = String(r.fechaISO || '');
      if (fecha  && d !== String(fecha))  return false;
      if (desde  && d <  String(desde))   return false;
      if (hasta  && d >  String(hasta))   return false;
      if (modulo && r.modulo !== modulo)  return false;
      if (r.esApoyo && !conApoyos)        return false;
      return true;
    };
    return res.json(h.filter(f));
  }
  res.json(h);
});
// ══════════════════════════════════════════════════════════════════
//  TIEMPOS IMPRODUCTIVOS  (pantalla de consulta)
// ══════════════════════════════════════════════════════════════════
// El historial es la fuente: aqui no se crea nada, solo se lee, se corrige y
// se valida. "validado" ausente significa validado — asi los 5.393 registros
// que ya existian quedan todos validados sin tener que tocarlos.
// Un registro invalidado sigue en la lista, pero deja de descontar de la
// eficiencia; se puede volver a validar las veces que haga falta.
function estaValidado(reg) { return !reg || reg.validado !== false; }

// Las claves de los improductivos marcados como apoyo (despachos, otra área).
// No son tiempo improductivo: son tiempo trabajado en otra cosa.
function clavesDeApoyo() {
  return new Set(getImproductivos().filter(i => i.apoyo).map(i => i.clave));
}

// El historial guarda la clave ("red", "custom:xxx"), no el nombre. Se busca en
// el catalogo; si el improductivo ya se elimino de la lista, se usa el nombre
// que quedo grabado en el propio registro. El usuario lo pidio asi: el registro
// conserva el nombre con el que se reporto, aunque el tipo ya no exista.
// El fallo mecanico son DOS tiempos distintos, no uno partido en dos:
//
//   ESPERA DE MECANICO   desde que se abre el improductivo hasta que llega
//                        el mecanico. Ese tiempo es del taller.
//   ATENCION DE MECANICO desde que llega hasta que lo soluciona. Ese es del
//                        arreglo en si.
//
// Antes los dos salian como "ESPERA MECANICO" —"para no inventar un tipo que
// la gente no reconoce"— y asi no habia forma de saber si el problema fue que
// el mecanico tardo en llegar o que la maquina estaba mal. Son cosas que
// acusan a personas distintas, asi que van separadas.
function nombreDeImproductivo(clave, reg) {
  const c = String(clave || '');
  // Las dos etapas del fallo mecánico llevan su nombre aquí, no en el catálogo:
  // allá el improductivo se llama FALLO MECÁNICO (es lo que la operaria reporta)
  // y en el historial cada etapa tiene que decir cuál de las dos fue.
  if (c === 'yellow') return 'ATENCIÓN DE MECÁNICO';
  if (c === 'red')    return 'ESPERA DE MECÁNICO';
  const item = getImproductivos().find(i => i.clave === c);
  if (item) return item.nombre;
  if (reg && reg.nombreTipo) return reg.nombreTipo;
  // Improductivo propio que ya se borró y que no alcanzó a guardar su nombre:
  // la clave interna ("custom:95f646cd-…") no le dice nada a nadie.
  if (/^custom:/.test(c)) return 'IMPRODUCTIVO ELIMINADO';
  // Colores internos que ya no son improductivos del catálogo. Sin esto salía
  // "PINK" en pantalla, que no significa nada para quien lee el reporte.
  const INTERNOS = { pink:'ALISTAMIENTO MECÁNICO', green:'OPERATIVO' };
  if (INTERNOS[c]) return INTERNOS[c];
  return c ? c.toUpperCase() : '—';
}

// Lee el historial ya con id y num puestos, sin repetir aqui esa logica.
// "9:20:00 a. m." -> 560. Sirve para ordenar por hora de verdad.
function minutosDelReloj(v) {
  const t = String(v || '').trim();
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return 99999;
  let h = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  const suf = t.toLowerCase().replace(/[.\s ]/g, '');
  if (suf.includes('pm') && h !== 12) h += 12;
  if (suf.includes('am') && h === 12) h = 0;
  return h * 60 + mm;
}

function historialNormalizado() {
  let h = readJSON(FILES.historial, []);
  let cambio = false;
  h = h.map(r => {
    if (r.id) return r;
    cambio = true;
    return { ...r, id: uuidv4() };
  });
  if (cambio) writeJSON(FILES.historial, h);
  return h;
}

app.get('/api/improductivos/registros', (req, res) => {
  try {
    const { desde, hasta, modulo } = req.query;
    /* Los apoyos (despachos, otra area) no son tiempo improductivo y por eso no
       salen en el reporte. El efecto secundario era que tampoco habia forma de
       corregir uno mal puesto: ninguna pantalla los mostraba, y solo se puede
       borrar lo que se ve. Con apoyos=1 se incluyen, marcados, para poder
       quitarlos; sin el parametro todo sigue igual que antes. */
    const apoyos = clavesDeApoyo();
    const conApoyos = String(req.query.apoyos || '') === '1';
    const esApoyo = r => apoyos.has(r.estadoAnterior || r.tipo);
    let lista = historialNormalizado().filter(r => (Number(r.durMinutos) || 0) > 0 && (conApoyos || !esApoyo(r)));
    if (desde)  lista = lista.filter(r => String(r.fechaISO || '') >= String(desde));
    if (hasta)  lista = lista.filter(r => String(r.fechaISO || '') <= String(hasta));
    if (modulo) lista = lista.filter(r => r.modulo === modulo);

    // "yellow" es el tramo en que el mecanico ya esta atendiendo. Se muestra con
    // su propio nombre, separado de la espera: ver nombreDeImproductivo.
    const registros = lista.map(r => ({
      id:         r.id,
      fechaISO:   r.fechaISO || '',
      fecha:      r.fecha || '',
      horaInicio: r.horaInicio || '',
      horaFin:    r.hora || '',
      modulo:     r.modulo || '',
      op:         r.op  || '',
      ref:        r.ref || '',
      clave:      r.tipo || r.estadoAnterior || '',
      nombre:     r.descripcion || nombreDeImproductivo(r.tipo || r.estadoAnterior, r),
      descripcion: r.descripcion || '',
      minutos:    Number(r.durMinutos) || 0,
      empleada:   r.empleada || '',
      mecanico:   r.mecanico || '',
      operacion:  r.operacion || '',
      validado:   estaValidado(r),
      editadoPor: r.editadoPor || '',
      observacion: r.observacion || '',
      esApoyo:    esApoyo(r)   // la pantalla lo marca y no lo suma al tiempo perdido
    // Se lee de arriba abajo en el orden en que paso, igual que los registros de
    // produccion. Y por MINUTOS, no por texto: "10:05 a.m." como texto va antes
    // que "9:20 a.m.", que es justo al reves de lo que pasa en el reloj.
    })).sort((a, b) =>
      String(a.fechaISO).localeCompare(String(b.fechaISO)) ||
      (minutosDelReloj(a.horaInicio) - minutosDelReloj(b.horaInicio)));

    res.json({ ok: true, registros, catalogo: getImproductivos().map(i => ({ clave: i.clave, nombre: i.nombre })) });
  } catch (e) {
    console.error('Error [GET improductivos/registros]:', e.message);
    res.status(500).json({ error: e.message, donde: 'GET improductivos/registros' });
  }
});

// Corregir un registro. Solo lo que dijo el usuario: minutos, tipo y a quien
// pertenece. La fecha y las horas no se tocan — son el sello del evento.
// ── Improductivo creado a mano ────────────────────────────────────────
// Los improductivos normales los genera el Control de Piso cuando el modulo
// cambia de color: el evento trae sus horas solo. Aqui se registra el que nadie
// alcanzo a marcar en su momento, indicando el rango a mano.
app.post('/api/improductivos/registro', requirePermiso('tiempos_improductivos'), (req, res) => {
  try {
    const { fecha, horaInicio, horaFin, modulo, clave, empleada, mecanico, operacion, op, ref } = req.body || {};
    const fechaN  = String(fecha || '').slice(0, 10);
    const moduloN = String(modulo || '').trim();
    const claveN  = String(clave || '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaN)) return res.status(400).json({ error: 'Fecha inválida' });
    if (!moduloN) return res.status(400).json({ error: 'Elige el módulo' });
    if (!claveN)  return res.status(400).json({ error: 'Elige el tipo de improductivo' });
    if (!getImproductivos().some(i => i.clave === claveN)) {
      return res.status(400).json({ error: 'Ese tipo de improductivo no existe en Configuraciones' });
    }
    if (fechaN > fechaHoyCO()) return res.status(400).json({ error: 'No se puede registrar un día que todavía no llega' });

    const aMin = (v) => { const m = String(v || '').match(/^(\d{1,2}):(\d{2})$/); return m ? (+m[1]) * 60 + (+m[2]) : null; };
    const iniMin = aMin(horaInicio), finMin = aMin(horaFin);
    if (iniMin == null || finMin == null) return res.status(400).json({ error: 'Indica la hora de inicio y la de fin' });
    // Si el fin es menor, el improductivo cruzo la medianoche (turno de noche).
    const durMinutos = finMin > iniMin ? finMin - iniMin : (1440 - iniMin) + finMin;
    if (durMinutos <= 0)   return res.status(400).json({ error: 'La hora de fin debe ser distinta de la de inicio' });
    if (durMinutos > 1440) return res.status(400).json({ error: 'La duración no puede pasar de un día' });

    // Mismo formato de hora que graba el Control de Piso, para que las dos
    // fuentes se vean igual en la tabla.
    const comoReloj = (min) => {
      const h24 = Math.floor(min / 60) % 24, mm = min % 60;
      const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
      return `${h12}:${String(mm).padStart(2, '0')}:00 ${h24 < 12 ? 'a. m.' : 'p. m.'}`;
    };
    const [aa, mm, dd] = fechaN.split('-');

    const historial = historialNormalizado();
    const registro = {
      id: uuidv4(),
      num: historial.filter(r => r.fechaISO === fechaN).length + 1,
      fecha: `${dd}/${mm}/${aa}`,
      fechaISO: fechaN,
      horaInicio: comoReloj(iniMin),
      hora:       comoReloj(finMin),
      modulo: moduloN,
      tipo: claveN, estadoAnterior: claveN, estadoNuevo: 'green',
      // El nombre queda grabado con el registro, igual que en los que genera el
      // Control de Piso: si mañana borran ese improductivo de Configuraciones,
      // este registro sigue diciendo qué fue.
      nombreTipo: nombreDeImproductivo(claveN),
      durMinutos,
      op:        String(op  || '').trim(),
      ref:       String(ref || '').trim().toUpperCase(),
      empleada:  String(empleada || '').trim(),
      mecanico:  String(mecanico || '').trim(),
      // Si no se escribió, la que el módulo tiene abierta — igual que en los
      // improductivos que genera el Control de Piso.
      operacion: String(operacion || (trabajoActual[moduloN] && trabajoActual[moduloN].operacion) || '').trim().toUpperCase(),
      creadoAMano: true,
      creadoPor: (req.auth && req.auth.user) || ''
    };
    historial.push(registro);
    if (!writeJSON(FILES.historial, historial)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, registro });
  } catch (e) {
    console.error('Error [POST improductivos/registro]:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/improductivos/registro/:id', requirePermiso('tiempos_improductivos'), (req, res) => {
  try {
    const h = historialNormalizado();
    const idx = h.findIndex(r => String(r.id) === String(req.params.id));
    if (idx < 0) return res.status(404).json({ error: 'Registro no encontrado' });

    const b = req.body || {};
    const cambios = {};

    // Los minutos NO se editan: son el tiempo que de verdad paso entre que el
    // modulo se puso en rojo y volvio a verde. Cambiarlos seria inventar.
    if (b.clave !== undefined) {
      const clave = String(b.clave || '');
      if (!getImproductivos().some(i => i.clave === clave)) {
        return res.status(400).json({ error: 'Ese tipo de improductivo no existe en Configuraciones' });
      }
      cambios.tipo = clave;
      cambios.estadoAnterior = clave;
      if (clave !== (h[idx].tipo || h[idx].estadoAnterior)) {
        cambios.descripcion = undefined;
        cambios.nombreTipo = nombreDeImproductivo(clave);
      }
    }
    if (b.modulo    !== undefined) cambios.modulo    = String(b.modulo || '').trim().toUpperCase();
    // La OP dice contra que orden se perdio ese tiempo, y de su referencia salen
    // las operaciones que se pueden elegir.
    if (b.op        !== undefined) cambios.op        = String(b.op || '').trim();
    if (b.ref       !== undefined) cambios.ref       = String(b.ref || '').trim().toUpperCase();
    if (b.empleada  !== undefined) cambios.empleada  = String(b.empleada || '').trim();
    if (b.mecanico  !== undefined) cambios.mecanico  = String(b.mecanico || '').trim();
    if (b.operacion !== undefined) cambios.operacion = String(b.operacion || '').trim().toUpperCase();
    // La nota libre de la fila. A diferencia de los demás campos, sin
    // mayúsculas forzadas: es texto para leer, no un dato para filtrar.
    if (b.observacion !== undefined) cambios.observacion = String(b.observacion || '').trim().slice(0, 500);

    if (!Object.keys(cambios).length) return res.status(400).json({ error: 'No hay nada que cambiar' });

    h[idx] = { ...h[idx], ...cambios, editadoPor: req.auth.user, editadoEn: new Date().toISOString() };
    if (h[idx].descripcion === undefined) delete h[idx].descripcion;
    if (!writeJSON(FILES.historial, h)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, registro: h[idx] });
  } catch (e) {
    console.error('Error [PUT improductivos/registro]:', e.message);
    res.status(500).json({ error: e.message, donde: 'PUT improductivos/registro' });
  }
});

// Validar o invalidar. Se puede ir y volver cuantas veces se quiera: no borra
// nada, solo cambia si ese tiempo cuenta o no.
app.delete('/api/improductivos/registro/:id', requireMando, (req, res) => {
  try {
    const h = historialNormalizado();
    const idx = h.findIndex(r => String(r.id) === String(req.params.id));
    if (idx < 0) return res.status(404).json({ error: 'Registro no encontrado' });
    const borrado = h[idx];
    h.splice(idx, 1);
    if (!writeJSON(FILES.historial, h)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    console.warn(`[HISTORIAL] ${req.auth.user} elimino un improductivo de ${borrado.modulo} (${borrado.durMinutos} min)`);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error [DELETE improductivos/registro]:', e.message);
    res.status(500).json({ error: e.message, donde: 'DELETE improductivos/registro' });
  }
});

app.post('/api/improductivos/registro/:id/validar', requirePermiso('tiempos_improductivos'), (req, res) => {
  try {
    const h = historialNormalizado();
    const idx = h.findIndex(r => String(r.id) === String(req.params.id));
    if (idx < 0) return res.status(404).json({ error: 'Registro no encontrado' });
    const validado = (req.body || {}).validado !== false;
    h[idx] = { ...h[idx], validado, validadoPor: req.auth.user, validadoEn: new Date().toISOString() };
    if (!writeJSON(FILES.historial, h)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ ok: true, validado });
  } catch (e) {
    console.error('Error [POST improductivos/validar]:', e.message);
    res.status(500).json({ error: e.message, donde: 'POST improductivos/validar' });
  }
});

app.post('/api/historial', requirePermiso('tiempos_improductivos', 'modulos'), (req, res) => {
  // Deshabilitado — el historial solo lo escribe el servidor internamente
  res.status(405).json({ error: 'No permitido. El historial lo gestiona el servidor.' });
});
// Borrar y editar piden la clave de acciones y se hacen por el id del registro.
// La posicion en la lista se corre si entra un registro nuevo o se recorta el
// historial mientras la pantalla esta abierta, y se borraba el que no era.
// La posicion (:idx) queda solo para registros viejos que no traigan id.
// Para rutas que borran: la pantalla manda la clave que escribio la persona en
// la cabecera X-Clave-Accion (o en el cuerpo, como 'clave').
function requireClaveAccion(req, res, next) {
  if (bloqueadoPorFallos(req)) return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.' });
  const clave = req.headers['x-clave-accion'] || (req.body && req.body.clave);
  if (!claveAccionValida('general', clave)) { anotarFallo(req); return res.status(403).json({ error: 'Contraseña incorrecta' }); }
  next();
}

function registroDelHistorial(req, res, h) {
  const body = req.body || {};
  if (bloqueadoPorFallos(req)) {
    res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.' });
    return -1;
  }
  if (!claveAccionValida('general', body.clave)) {
    anotarFallo(req);
    res.status(403).json({ error: 'Contraseña incorrecta' });
    return -1;
  }
  const idx = body.id ? h.findIndex(r => r && r.id === body.id) : parseInt(req.params.idx);
  if (isNaN(idx) || idx < 0 || idx >= h.length) {
    res.status(404).json({ error: 'Ese registro ya no existe. Recarga la pantalla.' });
    return -1;
  }
  return idx;
}

app.delete('/api/historial/:idx', requirePermiso('tiempos_improductivos'), (req, res) => {
  try {
    let h = readJSON(FILES.historial, []);
    const idx = registroDelHistorial(req, res, h);
    if (idx < 0) return;
    
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
app.patch('/api/historial/:idx', requirePermiso('tiempos_improductivos'), (req, res) => {
  try {
    let h = readJSON(FILES.historial, []);
    const idx = registroDelHistorial(req, res, h);
    if (idx < 0) return;
    const campos = ['modulo','empleada','horaInicio','hora','mecanico'];
    campos.forEach(c => { if(req.body[c] !== undefined) h[idx][c] = req.body[c]; });
    if (!writeJSON(FILES.historial, h)) return res.status(500).json({ error: 'No se pudo guardar. Intenta de nuevo.' });
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── #8 BUGFIX: broadcast disponible globalmente ────────────────────
app.patch('/api/ia-record-obs', requirePermiso('area_asistencia'), (req, res) => {
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
    a.download='respaldo-millar-'+fechaHoyCO()+'.json';
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
  res.setHeader('Content-Disposition', `attachment; filename="respaldo-millar-${fechaHoyCO()}.json"`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(bundle, null, 2));
});

// Diagnóstico de disco: cuánto ocupa cada cosa, para saber qué es lo que
// realmente lo está llenando (no solo confiar en que "debería" ser tal cosa).
// Uso: POST /admin/diagnostico-disco  body { pass }
function tamanoCarpeta(dir) {
  let total = 0;
  try {
    for (const nombre of fs.readdirSync(dir)) {
      const p = path.join(dir, nombre);
      const st = fs.statSync(p);
      total += st.isDirectory() ? tamanoCarpeta(p) : st.size;
    }
  } catch (e) { /* carpeta no existe o sin permiso — se cuenta como 0 */ }
  return total;
}
function mb(bytes) { return Math.round(bytes / 1024 / 1024 * 10) / 10; }
app.post('/admin/diagnostico-disco', rateLimit(10, 15 * 60 * 1000), (req, res) => {
  if (!RESET_PASS) return res.status(503).json({ error: 'Configura RESET_PASS en Render.' });
  if (!req.body || req.body.pass !== RESET_PASS) return res.status(403).json({ error: 'Contraseña incorrecta.' });
  const resultado = { dataDir: DATA_DIR };
  try {
    resultado.dfKB = require('child_process').execSync(`df -k "${DATA_DIR}"`).toString();
  } catch (e) { resultado.dfError = e.message; }
  try { resultado.millarDbMB = fs.existsSync(DB_PATH) ? mb(fs.statSync(DB_PATH).size) : null; } catch (e) { resultado.dbError = e.message; }
  resultado.backupsMB = mb(tamanoCarpeta(BACKUP_DIR));
  resultado.dataDirTotalMB = mb(tamanoCarpeta(DATA_DIR));
  // Detalle: cuánto pesa cada cosa DENTRO de DATA_DIR, para encontrar exactamente
  // qué archivo/carpeta explica la diferencia entre lo ya contado arriba y el total.
  try {
    resultado.contenido = fs.readdirSync(DATA_DIR).map(nombre => {
      const p = path.join(DATA_DIR, nombre);
      const st = fs.statSync(p);
      return { nombre, tipo: st.isDirectory() ? 'carpeta' : 'archivo', MB: mb(st.isDirectory() ? tamanoCarpeta(p) : st.size) };
    }).sort((a, b) => b.MB - a.MB);
  } catch (e) { resultado.contenidoError = e.message; }
  res.json(resultado);
});

// ── Fotos viejas de Alistamiento (uploads/) — respaldo + borrado por fecha ─
// El nombre de cada archivo empieza con su fecha de subida en milisegundos
// (Date.now()-uuid.ext, ver "multer" arriba), así que no hace falta tocar
// ningún dato/registro para saber qué tan vieja es cada foto.
function cutoffMsDesde(antesDe) {
  const iso = antesDe || '2026-07-01';
  const t = new Date(iso + 'T00:00:00Z').getTime();
  return isNaN(t) ? null : t;
}
function fotosAntesDe(cutoffMs) {
  let archivos;
  try { archivos = fs.readdirSync(UPLOADS_DIR); } catch (e) { return []; }
  return archivos.filter(nombre => {
    const m = nombre.match(/^(\d+)-/);
    const ts = m ? parseInt(m[1], 10) : NaN;
    return !isNaN(ts) && ts < cutoffMs;
  });
}
// Descarga en streaming un .tar.gz con las fotos anteriores a la fecha — nunca
// escribe nada a disco (el disco está lleno), va directo del archivo original
// al navegador, comprimiendo al vuelo. Uso: POST /admin/respaldo-fotos-antes-de
// body { pass, antesDe: 'YYYY-MM-DD' opcional, por defecto 2026-07-01 }
app.post('/admin/respaldo-fotos-antes-de', rateLimit(5, 60 * 60 * 1000), (req, res) => {
  if (!RESET_PASS) return res.status(503).json({ error: 'Configura RESET_PASS en Render.' });
  if (!req.body || req.body.pass !== RESET_PASS) return res.status(403).json({ error: 'Contraseña incorrecta.' });
  const cutoffMs = cutoffMsDesde(req.body.antesDe);
  if (cutoffMs == null) return res.status(400).json({ error: 'Fecha inválida (usa YYYY-MM-DD).' });
  const archivos = fotosAntesDe(cutoffMs);
  if (!archivos.length) return res.status(404).json({ error: 'No hay fotos anteriores a esa fecha.' });

  const tarStream = require('tar-stream');
  const zlib = require('zlib');
  const pack = tarStream.pack();
  res.setHeader('Content-Disposition', `attachment; filename="fotos-antes-de-${req.body.antesDe || '2026-07-01'}.tar.gz"`);
  res.setHeader('Content-Type', 'application/gzip');
  pack.pipe(zlib.createGzip()).pipe(res);

  (async () => {
    for (const nombre of archivos) {
      const p = path.join(UPLOADS_DIR, nombre);
      try {
        const st = fs.statSync(p);
        await new Promise((resolve, reject) => {
          const entry = pack.entry({ name: nombre, size: st.size }, err => err ? reject(err) : resolve());
          fs.createReadStream(p).on('error', reject).pipe(entry);
        });
      } catch (e) { console.error('[RESPALDO-FOTOS] Error empacando', nombre, e.message); }
    }
    pack.finalize();
  })();
});
// Borra ÚNICAMENTE archivos de uploads/ anteriores a la fecha dada — nunca toca
// ningún registro/dato. Ejecutar SOLO después de confirmar el respaldo. Uso:
// POST /admin/eliminar-fotos-antes-de  body { pass, antesDe }
app.post('/admin/eliminar-fotos-antes-de', rateLimit(5, 60 * 60 * 1000), (req, res) => {
  if (!RESET_PASS) return res.status(503).json({ error: 'Configura RESET_PASS en Render.' });
  if (!req.body || req.body.pass !== RESET_PASS) return res.status(403).json({ error: 'Contraseña incorrecta.' });
  const cutoffMs = cutoffMsDesde(req.body.antesDe);
  if (cutoffMs == null) return res.status(400).json({ error: 'Fecha inválida (usa YYYY-MM-DD).' });
  const archivos = fotosAntesDe(cutoffMs);
  let borrados = 0, liberadoBytes = 0;
  archivos.forEach(nombre => {
    const p = path.join(UPLOADS_DIR, nombre);
    try { const st = fs.statSync(p); fs.unlinkSync(p); borrados++; liberadoBytes += st.size; }
    catch (e) { console.error('[ELIMINAR-FOTOS] Error borrando', nombre, e.message); }
  });
  console.log(`[ELIMINAR-FOTOS] ${borrados} archivos borrados, ${mb(liberadoBytes)} MB liberados (antes de ${req.body.antesDe || '2026-07-01'})`);
  res.json({ ok: true, borrados, liberadoMB: mb(liberadoBytes) });
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
    Object.keys(_cacheLectura).forEach(k => delete _cacheLectura[k]);
    Object.keys(_particion).forEach(k => delete _particion[k]);

    // Resetear estado en memoria
    MODULES.forEach(id => { states[id] = 'green'; lastMec[id] = ''; });
    iaState       = normalizarEstadoIa({ supervisors: [], employees: [] });
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
/* NO se comprime el tiempo real (permessage-deflate), aunque parezca buena idea.
   Se probo el 06/10/2026: el paquete de arranque ('init') baja de 3,5 MB a ~0,5 MB,
   pero con 220 pantallas conectandose a la vez —lo que pasa cuando el servidor se
   reinicia y todas reconectan juntas— la memoria del servidor subio de 185 MB a
   1.575 MB, porque ws deja en cola, sin comprimir, cada paquete pendiente. Para un
   servidor que ya se cae, eso es peor que el problema. El arreglo bueno es mandar
   MENOS en el 'init' (sobre todo iaRecords, que es el 97%), no comprimir mas. */
wss = new WebSocketServer({ server });
wss.on('error', e => console.error('[WS] error del servidor de tiempo real:', (e && e.message) || e));

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

  // Estado completo al conectar.
  //
  // No se manda de inmediato: se espera a que la pantalla diga a qué temas se
  // suscribe, cosa que hace en su propio 'onopen' y llega en milisegundos. Con
  // esa información se le pueden ahorrar los registros de asistencia — unos
  // 2,7 MB por conexión — a las pantallas que no los usan, que son casi todas:
  // solo index, tablero e ingresos leen iaRecords del 'init'.
  //
  // Si no llega ninguna suscripción (pantalla antigua, o alguna que no la
  // envía), a los 400 ms se manda el paquete completo: el comportamiento de
  // siempre, sin romper nada.
  let initEnviado = false;
  let temporizadorInit = null;

  const enviarInit = () => {
    if (initEnviado || ws.readyState !== ws.OPEN) return;
    initEnviado = true;
    clearTimeout(temporizadorInit);

    const paquete = {
      type:          'init',
      // Con qué versión está corriendo el servidor. Cada pantalla se queda con
      // la que recibió al abrirse; si al reconectarse le llega otra, es que se
      // subió una versión nueva y se recarga sola. Así no hay que ir hasta los
      // 40 dispositivos a refrescarlos a mano.
      version:       VERSION_APP,
      states:        { ...states },
      lastMec:       { ...lastMec },
      stateTimes:    { ...stateTimes },
      lastEmpleada:  { ...lastEmpleada },
      trabajoActual: { ...trabajoActual },
      modulesConfig: modulesConfig,
      multiImps:     JSON.parse(JSON.stringify(multiImps)),
      ciCumplido:    ciRequests.filter(r => r.status === 'cumplido'),
      ciAbiertas:    ciRequests.filter(r => r.status === 'alert')
    };
    // Sin temas declarados se manda todo, por compatibilidad.
    if (ws.topics.size === 0 || ws.topics.has('ia')) {
      paquete.iaState = iaState;
      /* Solo los ultimos IA_VENTANA_DIAS dias de asistencia. Eran TODOS (22.992
         registros desde marzo = 3,5 MB, el 97% del paquete) y crecian cada dia: por la
         red de la planta no llegaban a tiempo y la pantalla se quedaba en blanco, y
         el servidor retenia varios MB por cada pantalla que se conectaba.
         La pantalla principal solo usa los de hoy. Quien necesite el historial
         (Control de Ingresos) lo pide a /api/ia-records, que va comprimido, y sabe
         desde que fecha tiene todo gracias a iaRecordsDesde. */
      if (Array.isArray(iaRecords)) {
        const desde = fechaIaVentanaDesde();
        paquete.iaRecords        = iaRecords.filter(r => !r || !r.date || String(r.date).slice(0, 10) >= desde);
        paquete.iaRecordsParcial = true;
        paquete.iaRecordsDesde   = desde;
      } else {
        paquete.iaRecords = iaRecords;
      }
    }
    try { ws.send(JSON.stringify(paquete)); } catch (e) { /* se cerró mientras tanto */ }
  };

  temporizadorInit = setTimeout(enviarInit, 400);
  ws.on('close', () => clearTimeout(temporizadorInit));

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
        enviarInit();   // ya se sabe qué necesita: se le manda su estado inicial
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

        /* ── Una espera de mecánico no se cierra por la puerta de atrás ──

           Los improductivos de verdad viven en la lista (multiImps), donde
           caben varios a la vez. Este mensaje es del mecanismo viejo, de "un
           solo color por módulo", y no sabe de esa lista.

           Qué pasaba: la operaria reportaba un fallo mecánico y, segundos
           después, pedía insumos desde la misma tablet. Ese segundo mensaje
           llegaba aquí, veía el módulo en rojo, daba la espera por terminada,
           la escribía en el historial con la persona equivocada y sin
           mecánico — y esa espera quedaba cerrada sin su atención.

           Mientras haya un mecánico pendiente en la lista, este mensaje no
           toca el estado ni escribe nada: el color lo manda la lista, y la
           espera solo termina cuando alguien dice qué mecánico llegó. */
        const listaMod = (multiImps[msg.id] || []).filter(i => !esImpPropio(i));
        const esperaViva = listaMod.some(i => ['red','yellow'].includes(i.tipoActual || i.tipo));
        if (esperaViva && !msg.fromMulti) {
          console.warn(`[ESPERA] ${msg.id}: se ignoró un cambio a "${msg.state}" — hay un mecánico pendiente.`);
          const real = calcColorMod(msg.id);
          states[msg.id] = real;
          if (msg.empleada) lastEmpleada[msg.id] = msg.empleada;
          saveFloorState();
          broadcast({
            type:'change', id:msg.id, state:real, mecanico:lastMec[msg.id]||'', limite:null,
            empleada:lastEmpleada[msg.id]||'', stateTime:stateTimes[msg.id],
            fromSlot:true, fromMulti:false
          });
          return;
        }

        // Guardar en historial ANTES de actualizar el estado
        // SOLO si NO viene de multi-improductivo — el multi tiene su propio registro en close
        const prevState = states[msg.id];

        // ── El flujo del mecánico no se cierra a medias ──────────────
        //
        // "Espera de mecánico" SOLO puede terminar pasando por "Atención de
        // mecánico". Cualquier camino que mandara el módulo directo a verde
        // cerraba la espera sin dejar registrado quién la atendió: en el
        // reporte quedaba la espera suelta, sin su atención y sin mecánico.
        //
        // Se ataja aquí, en el servidor, y no en cada pantalla: así vale para
        // todos los dispositivos y para cualquier camino — el tablero, una
        // solicitud de CI que se cierra, o una tablet con la versión vieja.
        // El módulo queda en atención hasta que alguien la cierre como toca.
        let estadoNuevo = msg.state || 'green';
        const seSaltoAtencion = (prevState === 'red' && estadoNuevo !== 'red' && estadoNuevo !== 'yellow');
        if (seSaltoAtencion) estadoNuevo = 'yellow';

        // Actualizar empleada y mecánico en memoria ANTES de logHistorial
        if (msg.empleada) lastEmpleada[msg.id] = msg.empleada;
        if (msg.mecanico) lastMec[msg.id] = msg.mecanico;

        // Solo registrar si es un cambio de estado simple (no multi)
        // msg.fromMulti=true significa que viene del sistema de multi-improductivos
        if (!msg.fromMulti) {
          logHistorial(msg.id, prevState, estadoNuevo, msg.mecanico || lastMec[msg.id] || '', msg.empleada || lastEmpleada[msg.id] || '',
            (trabajoActual[msg.id] && trabajoActual[msg.id].operacion) || '');
        }

        states[msg.id]     = estadoNuevo;
        stateTimes[msg.id] = Date.now();
        if (estadoNuevo === 'red') lastMec[msg.id] = '';
        else if (msg.mecanico) lastMec[msg.id] = msg.mecanico;
        // Guardar empleada: conservar si hay nueva, limpiar solo al volver a green
        if (msg.empleada) lastEmpleada[msg.id] = msg.empleada;
        else if (estadoNuevo === 'green') lastEmpleada[msg.id] = '';
        saveFloorState();
        const esRed = (estadoNuevo === 'red' || estadoNuevo === 'garnet');
        const aviso = { type:'change', id:msg.id, state:estadoNuevo, mecanico:msg.mecanico||'', limite:msg.limite||null, empleada:lastEmpleada[msg.id]||'', stateTime:stateTimes[msg.id], fromSlot:esRed, fromMulti:!esRed };
        // Si el servidor corrigió el estado, el aviso va TAMBIÉN a quien lo
        // pidió: si no, esa pantalla se quedaría mostrando verde mientras el
        // servidor tiene el módulo en atención.
        if (seSaltoAtencion) broadcast(aviso); else broadcastLocal(aviso);
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
        /* Bloqueo contra duplicados: si ya hay una solicitud activa igual, no se
           crea otra — se reenvía la que ya existe para que quien la generó no
           piense que falló y vuelva a intentarlo.

           "Igual" incluye el MÓDULO DESTINO, y esa parte faltaba. Cuando pide
           un mecánico, "quién pide" es su nombre y la categoría siempre es
           "Alistamiento": sin el destino, su segunda solicitud del día —para
           otro módulo, por otro insumo— se descartaba como repetida. Sonaba la
           alerta pero la tarjeta nunca llegaba a CI. */
        const mismoDestino = (a, b) =>
          String(a || '').trim().toUpperCase() === String(b || '').trim().toUpperCase();
        const dupExistente = ciRequests.find(r =>
          r.module === msg.request.module &&
          r.categoria === msg.request.categoria &&
          mismoDestino(r.moduloDestino, msg.request.moduloDestino) &&
          r.status !== 'done'
        );
        if (dupExistente) {
          broadcastLocal({ type:'ci_new_request', request:dupExistente, duplicate:true });
          try {
            ws.send(JSON.stringify({ type:'ci_solicitud_repetida', existente: dupExistente, reemplaza: msg.request._id }));
          } catch (e) { /* se cerró la conexión */ }
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
          ciRequests[idx] = normalizarEntregaCI({ ...ciRequests[idx], ...msg.request });
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
            // Una espera de mecánico tampoco se cierra desde CI: solo termina
            // nombrando al mecánico. Misma regla que en finalizarImp.
            const esEspera = idx > -1 &&
              ['red','yellow'].includes(multiImps[modId][idx].tipoActual || multiImps[modId][idx].tipo);
            if (idx > -1 && !esEspera) {
              const imp   = multiImps[modId][idx];
              // Misma regla que finalizarImp: si tiene tiempo definido, ese es
              // el que se cobra — cerrar la solicitud en CI no lo alarga.
              const ahora = finDeImp(imp);
              const durMs = ahora - (imp.inicio || ahora);
              if (durMs > 0) {
                /* Se guarda con la MISMA función que todos los demás.

                   Aquí el registro se armaba a mano, y por eso salía distinto
                   de los otros: sin la operación que estaba haciendo el módulo
                   y sin el nombre del improductivo. En la pantalla de Tiempos
                   Improductivos unos traían operación y otros no, según por
                   dónde se hubieran cerrado. Una sola función, un solo
                   resultado. */
                guardarImproductivo(modId, imp.tipoActual || imp.tipo,
                  imp.inicio || ahora, ahora, {
                    mecanico:    imp.mecanico,
                    empleada:    imp.empleada,
                    operacion:   imp.operacion,
                    ciRequestId: reqId
                  });
              }
              multiImps[modId].splice(idx, 1);
              states[modId]     = calcColorMod(modId);
              ponerRelojMod(modId);
              if (states[modId] === 'green') { lastMec[modId]=''; lastEmpleada[modId]=''; }
              saveFloorState();
              // Notificar al tablero general
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
          const quien  = s => String(s || '').trim().toUpperCase();
          const grupo  = t => (t === 'yellow' ? 'red' : t);
          const nuevo  = grupo(imp.tipoActual || imp.tipo);
          const yaEsta = multiImps[modId].find(i =>
            quien(i.empleada) === quien(imp.empleada) && grupo(i.tipoActual || i.tipo) === nuevo);
          if (yaEsta) {
            try {
              ws.send(JSON.stringify({
                type: 'multi_imp_rechazado', modId, impId: imp.id,
                existente: yaEsta, ciRequestId: imp.ciRequestId || null,
                motivo: 'Ese improductivo ya está abierto'
              }));
            } catch (e) { /* se cerró la conexión */ }
            return;
          }
          multiImps[modId].push({
            id:          imp.id,
            tipo:        imp.tipo,
            tipoActual:  imp.tipoActual || imp.tipo,
            inicio:      imp.inicio || Date.now(),
            empleada:    imp.empleada || '',
            // Quien la reporto desde la tablet, que no siempre es la misma para
            // quien es: en el fallo mecanico se escoge a quien se le dano la
            // maquina. Sin esto, quien reporto no podia atenderla ni cerrarla.
            reportadoPor: String(imp.reportadoPor || '').trim(),
            mecanico:    imp.mecanico || '',
            ciRequestId: imp.ciRequestId || null,
            esPrincipal: imp.esPrincipal || false,
            // Solo los propios: cuanto dura la cuenta regresiva y si tapa la
            // pantalla. Se guardan aqui para que sobrevivan a una recarga.
            minutos:         Number(imp.minutos) > 0 ? Math.round(Number(imp.minutos)) : 0,
            detienePantalla: imp.detienePantalla === true,
            operacion:       String(imp.operacion || '').trim().toUpperCase(),
            // Lo que escribió la operaria en OTROS. Reemplaza el nombre.
            descripcion:     String(imp.descripcion || '').trim().toUpperCase().slice(0, 120)
          });
          states[modId] = calcColorMod(modId);
          broadcastLocal({ type:'multi_imp_change', action:'open', modId, imp: multiImps[modId][multiImps[modId].length-1] });
          if (esImpPropio(imp)) { saveFloorState(); return; }   // no sale del Contador
          ponerRelojMod(modId);
          saveFloorState();
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
          const actual = multiImps[modId][idx];

          /* Espera de mecánico que pasa a atención: la espera TERMINA aquí.

             Este es el camino normal del Contador —la operaria dice quién llegó
             a atender—, distinto del 'close' de abajo que usan las solicitudes
             de CI. Los dos tienen que registrar la espera: si no, en el reporte
             sale la atención sola, sin su espera, y cargando todo el tiempo que
             el mecánico tardó en llegar. */
          const pasaAAtencion = (actual.tipoActual || actual.tipo) === 'red'
                             && imp.tipoActual === 'yellow';

          /* Sin mecánico no hay atención, y por lo tanto no se cierra la espera.

             Para pasar a atención hay que decir QUIÉN llegó. Si el mensaje no
             trae nombre se busca el que ya se sepa (el que la operaria eligió
             antes, o el que el Tablero de Mecánicos asignó); y si no hay
             ninguno, la espera se queda abierta.

             Esto es lo que hacía que salieran esperas con el mecánico en
             blanco: se dejaba pasar la atención sin nombre, y al guardar la
             espera no había a quién ponerle. */
          const quienAtiende = (imp.mecanico || actual.mecanico || lastMec[modId] || '').trim();
          if (pasaAAtencion && !quienAtiende) {
            console.warn(`[ESPERA] ${modId}: no se pasa a atención sin decir qué mecánico llegó.`);
            return;
          }
          if (pasaAAtencion) {
            imp.mecanico = quienAtiende;   // queda en la atención y en la espera
            const ahoraMs = Date.now();
            // El mecánico de la espera es el que la operaria ACABA de elegir
            // (imp.mecanico, lo que llega en este mismo mensaje) — no el que
            // ya estaba guardado antes (actual.mecanico), que durante la
            // espera siempre está vacío: nadie sabe quién va a venir hasta
            // que llega. Por eso la espera se guardaba sin mecánico aunque la
            // atención sí lo tuviera.
            guardarImproductivo(modId, 'red', actual.inicio || ahoraMs, ahoraMs, {
              mecanico:    imp.mecanico || actual.mecanico,
              empleada:    actual.empleada,
              operacion:   actual.operacion,
              ciRequestId: actual.ciRequestId
            });
            imp.inicio = ahoraMs;   // la atención empieza a contar de cero
          }

          // El tiempo definido y el arranque no se dejan pisar desde el cliente:
          // si no, mandar minutos:0 saltaría el candado del cierre anticipado.
          const protegidos = { minutos: actual.minutos, esPrincipal: actual.esPrincipal };
          if (!pasaAAtencion) protegidos.inicio = actual.inicio;
          Object.assign(multiImps[modId][idx], imp, protegidos);
          if (imp.mecanico) lastMec[modId]      = imp.mecanico;
          if (imp.empleada) lastEmpleada[modId] = imp.empleada;
          states[modId] = calcColorMod(modId);
          broadcastLocal({ type:'multi_imp_change', action:'update', modId, imp: multiImps[modId][idx] });
          if (esImpPropio(multiImps[modId][idx])) { saveFloorState(); return; }
          ponerRelojMod(modId);
          saveFloorState();
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

          /* Un improductivo con tiempo definido no se cierra antes de tiempo.

             Si el desayuno tiene 20 minutos, son 20 minutos: no se puede cerrar
             a los 5 "porque ya volvieron". Se cierra SOLO cuando se cumplen, y
             de eso se encarga el barrido de más abajo — aquí solo se rechaza el
             cierre anticipado, venga de donde venga (la tablet, el tablero o una
             versión vieja de la app).

             msg.porTiempo lo pone el barrido: es el único que puede cerrarlo. */
          if (!msg.porTiempo && faltaTiempo(imp) > 0) {
            ws.send(JSON.stringify({
              type: 'multi_imp_bloqueado', modId, impId,
              faltanSegundos: Math.ceil(faltaTiempo(imp) / 1000),
              motivo: 'Este improductivo tiene un tiempo definido y se cierra solo cuando se cumpla.'
            }));
            return;
          }

          // Una espera de mecánico no se cierra: pasa a atención.
          //
          // Es la misma regla del bloque 'change' de arriba, aplicada al otro
          // camino por donde se puede cerrar — el de varios improductivos a la
          // vez, que es el que usan las solicitudes de CI. Sin esto, cerrar la
          // solicitud dejaba la espera sin su atención y sin mecánico.
          if ((imp.tipoActual || imp.tipo) === 'red') {
            // La espera TERMINA aquí: se guarda como registro propio y el
            // cronómetro vuelve a cero para la atención.
            //
            // Antes solo se cambiaba la etiqueta y se seguía. Resultado: la
            // espera no quedaba en ningún lado, y la atención se llevaba todo
            // el tiempo desde que se abrió la espera — el reporte culpaba al
            // mecánico por lo que se demoró en llegar.
            const ahoraMs = Date.now();
            /* Sin mecánico no hay atención — misma regla que en UPDATE.

               Si este cierre trae un mecánico nuevo, ese manda; si no, el que
               ya se supiera. Sin ninguno la espera se queda abierta: es
               preferible una espera pendiente que un registro que no dice
               quién atendió. */
            const quienAtiende = ((msg.imp && msg.imp.mecanico) || imp.mecanico || lastMec[modId] || '').trim();
            if (!quienAtiende && !msg.forzar) {
              console.warn(`[ESPERA] ${modId}: no se cierra la espera sin decir qué mecánico llegó.`);
              ws.send(JSON.stringify({
                type: 'multi_imp_bloqueado', modId, impId,
                motivo: 'Una espera de mecánico se cierra diciendo quién llegó a atender. Si toca cerrarla igual, usa "Cierre forzado con clave".'
              }));
              return;
            }
            /* Forzada y sin mecánico: se cierra de una, sin pasar por atención.
               Queda registrada la espera con el mecánico en blanco, que es la
               verdad de lo que pasó: nadie llegó y se cerró a mano. */
            if (!quienAtiende) {
              guardarImproductivo(modId, 'red', imp.inicio || Date.now(), Date.now(), {
                mecanico:  '',
                empleada:  imp.empleada,
                operacion: imp.operacion,
                ciRequestId: imp.ciRequestId
              });
              multiImps[modId].splice(idx, 1);
              states[modId] = calcColorMod(modId);
              ponerRelojMod(modId);
              saveFloorState();
              broadcast({ type:'multi_imp_change', action:'close', modId, impId: imp.id });
              broadcast({
                type:'change', id:modId, state:states[modId],
                mecanico:lastMec[modId]||'', limite:null,
                empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId],
                fromMulti:true
              });
              console.warn(`[ESPERA] ${modId}: cerrada a la fuerza con clave, sin mecánico.`);
              return;
            }
            guardarImproductivo(modId, 'red', imp.inicio || ahoraMs, ahoraMs, {
              mecanico:  quienAtiende,
              empleada:  imp.empleada,
              operacion: imp.operacion,
              ciRequestId: imp.ciRequestId
            });
            imp.tipoActual = 'yellow';
            imp.inicio     = ahoraMs;
            imp.mecanico   = quienAtiende;
            if (imp.mecanico) lastMec[modId] = imp.mecanico;
            states[modId] = calcColorMod(modId);
            ponerRelojMod(modId);
            saveFloorState();
            broadcast({ type:'multi_imp_change', action:'update', modId, imp });
            broadcast({
              type:'change', id:modId, state:states[modId],
              mecanico:lastMec[modId]||'', limite:null,
              empleada:lastEmpleada[modId]||'', stateTime:stateTimes[modId],
              fromMulti:false, fromSlot:true
            });
            return;
          }

          /* msg.forzar viene del "Cierre forzado con clave": ya se pidió
             contraseña, así que es una decisión tomada a propósito y es el
             único escape cuando una espera se queda trabada. */
          if (finalizarImp(modId, idx, ws, !!msg.forzar) === false) {
            ws.send(JSON.stringify({
              type: 'multi_imp_bloqueado', modId, impId,
              motivo: 'Una espera de mecánico se cierra diciendo quién llegó a atender. Si necesitas cerrarla igual, usa "Cierre forzado con clave".'
            }));
          }
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
        iaState = normalizarEstadoIa(msg.state);
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
/* Prueba de humo del despliegue. `node --check` solo mira la ortografia del
   archivo: no se entera de un require() que falta ni de un error al arrancar.
   Con SMOKE_TEST=1 se ejecuta TODO lo de arriba y se sale antes de abrir el
   puerto, asi que el fallo se ve antes de reiniciar la aplicacion y no despues,
   con la planta parada esperando a que el respaldo la devuelva.
   El desplegador lo llama con un DATA_DIR de usar y tirar: esta prueba no debe
   tocar los datos de verdad. */
if (process.env.SMOKE_TEST === '1') {
  console.log('PRUEBA DE HUMO: server.js cargó completo y sin errores');
  process.exit(0);
}

// Se retiran los perfiles Programador y Administrador si ya hay un administrador por cedula.
retirarPerfilesAdmin('arranque');

server.listen(PORT, () => {
  console.log(`✅ Confecciones Millar v4.0 | Puerto ${PORT} | RESET_PASS: ${RESET_PASS ? 'OK' : 'NO configurada'} | CORS: ${ALLOWED_ORIGIN || 'abierto'}`);
});
