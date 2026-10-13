'use strict';
/* Archivos subidos (fotos de mecánicos y fichas técnicas en PDF): ya no se publican como carpeta.

   Antes, `/alistamiento/uploads` y `/fichas-tecnicas` entregaban CUALQUIER archivo de la carpeta a
   cualquiera que conociera el nombre, sin sesión. Ahora todo sale por `GET /api/archivos/:nombre`, que:
     1. exige sesión: la del encabezado (fetch) o la cookie `cm_arch`, que el servidor deja sola en la
        primera llamada autenticada. Las etiquetas <img> y los enlaces no pueden mandar encabezados,
        por eso la cookie (HttpOnly, SameSite=Strict, y solo viaja a /api/archivos);
     2. exige el permiso del módulo que usa ese tipo de archivo (fotos → area_montajes,
        fichas → ordenes_produccion; un administrador pasa siempre);
     3. entrega solo archivos que algún registro usa (o que se subieron hace menos de 1 hora y su
        registro aún se está guardando); un archivo huérfano solo lo ve un administrador;
     4. rechaza nombres con carpetas o caracteres raros, y solo sirve imágenes y PDF. */
const fs = require('fs');
const path = require('path');
const { leerCookie } = require('./ps-autorizacion');

const COOKIE = 'cm_arch';
const TIPOS = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };
const NOMBRE_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,150}$/;
const esFicha = nombre => /^ficha-.+\.pdf$/i.test(nombre);
// Foto de un mecánico (Configuraciones → Perfiles → Mecánicos): dato personal, solo para quien ve el Estado de mecánicos.
const esFotoMecanico = nombre => /^mec-.+\.jpg$/i.test(nombre);
const RECIENTE_MS = 60 * 60 * 1000;

// El nombre de archivo de lo que guarda un registro ("/alistamiento/uploads/x.jpg", "x.jpg", URL vieja…).
function nombreDeRuta(valor) {
  let t = String(valor == null ? '' : valor).split('?')[0].split('#')[0];
  try { t = decodeURIComponent(t); } catch (e) { /* se queda como vino */ }
  return t.split('/').pop().trim();
}

function cookieSesion(token, { seguro = false, ttlMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  return `${COOKIE}=${encodeURIComponent(token)}; Path=/api/archivos; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(ttlMs / 1000)}` + (seguro ? '; Secure' : '');
}

function crearArchivosPrivados({ carpeta, verificarToken, tienePermiso, esAdmin, referenciados, exigirSesion = true,
                                  permisosFoto = ['area_montajes'], permisosFicha = ['ordenes_produccion'], permisosMecanico = ['estado_mecanicos', 'configuraciones'] }) {
  const base = path.resolve(carpeta);
  const recientes = new Map();      // nombre → cuándo se subió

  function anotarSubida(nombre) {
    const ahora = Date.now();
    for (const [k, t] of recientes) if (ahora - t > RECIENTE_MS) recientes.delete(k);
    recientes.set(String(nombre), ahora);
  }
  const esReciente = nombre => { const t = recientes.get(nombre); return !!t && Date.now() - t <= RECIENTE_MS; };

  // Encabezado primero (llamadas con fetch); si no, la cookie (imágenes y enlaces).
  function tokenDe(req) {
    const hdr = req.headers.authorization || '';
    if (hdr.startsWith('Bearer ')) return hdr.slice(7);
    return req.headers['x-session-token'] || leerCookie(req.headers.cookie, COOKIE) || '';
  }

  function servir(req, res) {
    const nombre = String(req.params.nombre || '');
    if (!NOMBRE_OK.test(nombre) || nombre.includes('..')) return res.status(400).json({ error: 'Nombre de archivo no válido' });
    const tipo = TIPOS[path.extname(nombre).toLowerCase()];
    if (!tipo) return res.status(404).json({ error: 'Archivo no encontrado' });

    let admin = false;
    if (exigirSesion) {
      const payload = verificarToken(tokenDe(req));
      if (!payload) return res.status(401).json({ error: 'No autenticado' });
      const ficha = esFicha(nombre), mecanico = esFotoMecanico(nombre);
      if (!tienePermiso(payload, ficha ? permisosFicha : mecanico ? permisosMecanico : permisosFoto)) return res.status(403).json({ error: 'No tienes permiso para ver este archivo' });
      admin = !!esAdmin(payload);
      const { fotos, fichas, mecanicos } = referenciados();
      const lo_usa_un_registro = (ficha ? fichas : mecanico ? (mecanicos || new Set()) : fotos).has(nombre) || esReciente(nombre);
      if (!lo_usa_un_registro && !admin) return res.status(404).json({ error: 'Archivo no encontrado' });
    }

    const ruta = path.resolve(base, nombre);
    if (path.dirname(ruta) !== base || !fs.existsSync(ruta) || !fs.statSync(ruta).isFile()) return res.status(404).json({ error: 'Archivo no encontrado' });
    res.set({ 'Content-Type': tipo, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600',
              'Content-Disposition': 'inline; filename="' + nombre + '"' });
    res.sendFile(ruta);
  }

  return { servir, anotarSubida, tokenDe };
}

module.exports = { crearArchivosPrivados, cookieSesion, nombreDeRuta, esFicha, esFotoMecanico, COOKIE };
