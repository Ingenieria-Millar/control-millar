'use strict';
/* Autorización de Punto Seguro, del lado del servidor.

   Tres niveles (ver ps-api.js):
   · Sesión + permiso del módulo (`punto_seguro`): lo que necesita el trabajador para recorrer su
     inducción, firmar y presentar la evaluación. Lo exige server.js al montar el router.
   · Administrador de Punto Seguro: panel de trabajadores, resultados, planes, sesiones, plantillas,
     evaluaciones. Se logra de dos maneras: un administrador del MES (Configuraciones), o haber escrito
     bien la contraseña de administrador de Punto Seguro (queda un "permiso" firmado de 2 horas).
   · La contraseña de administrador NO tiene valor por defecto. Se guarda con bcrypt.

   Todo es lógica pura (sin Express ni disco) para poder probarla. */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const COOKIE = 'ps_admin';
const TTL_ADMIN_MS = 2 * 60 * 60 * 1000;
const CLAVE_MIN = 8, CLAVE_MAX = 72;               // bcrypt solo mira los primeros 72 bytes
const PROHIBIDAS = new Set(['millar2024', '12345678', '123456789', 'password', 'contraseña', 'millar123', 'admin1234']);

const firmar = (secreto, texto) => crypto.createHmac('sha256', String(secreto)).update(texto).digest('base64url');
const igual = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

// ── El permiso firmado: { u: usuario de la sesión, exp } ─────────────────────────
// Va en una cookie HttpOnly: el navegador la manda solo, sin tocar la pantalla, y sobrevive a los
// reinicios del servidor (se firma con el mismo SESSION_SECRET de las sesiones).
function crearGrant(secreto, usuario, { ahora = Date.now(), ttlMs = TTL_ADMIN_MS } = {}) {
  const cuerpo = Buffer.from(JSON.stringify({ u: String(usuario), exp: ahora + ttlMs })).toString('base64url');
  return cuerpo + '.' + firmar(secreto, cuerpo);
}
function validarGrant(secreto, valor, usuario, ahora = Date.now()) {
  if (!valor || typeof valor !== 'string' || valor.indexOf('.') < 1) return false;
  const [cuerpo, firma] = valor.split('.');
  if (!igual(firma || '', firmar(secreto, cuerpo))) return false;
  try {
    const p = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
    return p && p.u === String(usuario) && typeof p.exp === 'number' && ahora <= p.exp;
  } catch (e) { return false; }
}
function leerCookie(cabecera, nombre) {
  for (const parte of String(cabecera || '').split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) return decodeURIComponent(parte.slice(i + 1).trim());
  }
  return '';
}
const cookieGrant = (valor, { seguro = false, ttlMs = TTL_ADMIN_MS } = {}) =>
  `${COOKIE}=${encodeURIComponent(valor)}; Path=/punto-seguro/api; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}` + (seguro ? '; Secure' : '');
const cookieBorrar = () => `${COOKIE}=; Path=/punto-seguro/api; HttpOnly; SameSite=Strict; Max-Age=0`;

// ── La contraseña de administrador ───────────────────────────────────────────────
// cfg es el contenido de ps_config.json: { adminPassHash } o, de antes, { adminPass } en texto plano.
function claveAceptable(clave) {
  if (typeof clave !== 'string') return 'Escribe una contraseña.';
  if (clave.length < CLAVE_MIN) return `La contraseña debe tener al menos ${CLAVE_MIN} caracteres.`;
  if (Buffer.byteLength(clave) > CLAVE_MAX) return `La contraseña es demasiado larga (máximo ${CLAVE_MAX}).`;
  if (PROHIBIDAS.has(clave.toLowerCase())) return 'Esa contraseña es demasiado común. Elige otra.';
  return null;
}
const hayClave = cfg => !!(cfg && (cfg.adminPassHash || (typeof cfg.adminPass === 'string' && cfg.adminPass)));
// → { ok, cfgNuevo? }. Si estaba en texto plano y es correcta, devuelve cfgNuevo ya con hash (sin el texto).
function comprobarClave(cfg, clave) {
  if (typeof clave !== 'string' || !clave || Buffer.byteLength(clave) > 200 || !hayClave(cfg)) return { ok: false };
  if (cfg.adminPassHash) {
    let ok = false;
    try { ok = bcrypt.compareSync(clave, cfg.adminPassHash); } catch (e) { ok = false; }
    return { ok };
  }
  if (!igual(clave, cfg.adminPass)) return { ok: false };
  const { adminPass, ...resto } = cfg;
  return { ok: true, cfgNuevo: { ...resto, adminPassHash: bcrypt.hashSync(clave, 10), claveCambiadaEn: new Date().toISOString() } };
}
const cfgConClave = (cfg, clave) => {
  const { adminPass, ...resto } = cfg || {};
  return { ...resto, adminPassHash: bcrypt.hashSync(clave, 10), claveCambiadaEn: new Date().toISOString() };
};

module.exports = { COOKIE, TTL_ADMIN_MS, crearGrant, validarGrant, leerCookie, cookieGrant, cookieBorrar, claveAceptable, hayClave, comprobarClave, cfgConClave };
