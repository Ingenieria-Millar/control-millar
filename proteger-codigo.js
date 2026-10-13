'use strict';
/* Entrega las pantallas "apretadas": sin comentarios, sin saltos de línea y con los nombres internos de las
   variables cambiados por letras. Con Ctrl+U se ve una pared de texto difícil de leer.

   OJO: esto dificulta leer el código, NO lo esconde. El navegador siempre recibe lo que necesita para dibujar la
   pantalla y con una herramienta de "embellecer código" se puede volver a ordenar. La seguridad de verdad está en el
   servidor (sesión y permisos en cada /api).

   Los archivos del repositorio NO cambian: esto se hace al enviar la pantalla y queda guardado en memoria (una vez
   por archivo, hasta que el archivo cambie). Si algo falla en un archivo, se envía tal cual, nunca una pantalla rota.
   Los nombres de las funciones y variables globales se conservan a propósito: los botones (onclick="guardar()") los
   llaman por su nombre. PROTEGER_CODIGO=0 en el entorno lo apaga sin tocar el código. */

const fs = require('fs');
const { minify } = require('terser');

const ACTIVO = process.env.PROTEGER_CODIGO !== '0';
const cache = new Map();            // ruta -> { mtime, html }

// Solo los <script> de código en línea: los que traen src, o son JSON/plantillas, se dejan como están.
const RE_SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const RE_STYLE = /<style\b([^>]*)>([\s\S]*?)<\/style>/gi;
const esCodigo = attrs => !/\bsrc\s*=/i.test(attrs) && !/\btype\s*=\s*["']?(?!text\/javascript|application\/javascript|module)/i.test(attrs);

async function apretarScript(js) {
  try {
    const r = await minify(js, { compress: true, mangle: true, format: { comments: false } });
    return r && typeof r.code === 'string' && r.code.length ? r.code : js;
  } catch (e) { return js; }                                       // si no se puede, el bloque se queda igual
}

const apretarCss = css => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\s*([{};:,>])\s*/g, '$1').trim();

async function apretar(html) {
  // 1) los scripts (uno por uno, y de a uno para no gastar memoria)
  const bloques = [];
  let m;
  RE_SCRIPT.lastIndex = 0;
  while ((m = RE_SCRIPT.exec(html))) bloques.push({ ini: m.index, fin: RE_SCRIPT.lastIndex, attrs: m[1], js: m[2] });
  let out = '', pos = 0;
  for (const b of bloques) {
    out += html.slice(pos, b.ini);
    if (esCodigo(b.attrs) && b.js.trim()) out += '<script' + b.attrs + '>' + await apretarScript(b.js) + '</script>';
    else out += html.slice(b.ini, b.fin);
    pos = b.fin;
  }
  out += html.slice(pos);
  // 2) los estilos y los comentarios de HTML (fuera de los scripts, que ya no los llevan)
  out = out.replace(RE_STYLE, (t, a, css) => '<style' + a + '>' + apretarCss(css) + '</style>');
  const partes = out.split(/(<script\b[\s\S]*?<\/script>)/i);
  return partes.map((p, i) => i % 2 ? p : p.replace(/<!--(?!\[if)[\s\S]*?-->/g, '')).join('');
}

// El HTML que se envía para un archivo (apretado y guardado), o null si no hay que tocarlo.
async function pantalla(ruta) {
  if (!ACTIVO) return null;
  const mtime = fs.statSync(ruta).mtimeMs;
  const c = cache.get(ruta);
  if (c && c.mtime === mtime) return c.html;
  const original = fs.readFileSync(ruta, 'utf8');
  let html = null;
  try { html = await apretar(original); } catch (e) { console.warn('[CODIGO] no se pudo apretar ' + ruta + ': ' + e.message); }
  if (!html) html = null;
  cache.set(ruta, { mtime, html });
  return html;
}

// Responde con la pantalla apretada; si no se puede, con el archivo de siempre.
async function enviar(res, ruta) {
  try {
    const html = await pantalla(ruta);
    if (html) { res.set('Content-Type', 'text/html; charset=utf-8'); res.set('Cache-Control', 'public, max-age=0'); return res.send(html); }
  } catch (e) { console.warn('[CODIGO] ' + e.message); }
  return res.sendFile(ruta);
}

module.exports = { enviar, apretar, pantalla };
