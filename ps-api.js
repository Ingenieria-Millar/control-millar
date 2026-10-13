'use strict';
const { Router } = require('express');
const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// ── Dónde viven los datos de Punto Seguro ────────────────────────────────────
// Los datos que la gente crea (PDF firmados, evaluaciones, posiciones de firma)
// van al disco permanente, el mismo que usa el resto de la aplicación. NUNCA
// dentro de la carpeta del proyecto: cada despliegue la restaura al estado
// guardado en GitHub, y todo lo subido desde el servidor desaparecía.
const _DISCO     = '/var/data';
const _HAY_DISCO = (() => { try { return fs.existsSync(_DISCO); } catch (e) { return false; } })();
const PS_BASE    = process.env.PS_DATA_DIR || process.env.DATA_DIR || (_HAY_DISCO ? _DISCO : path.join(__dirname, 'ps-datos'));

const DATA_DIR    = path.join(PS_BASE, 'ps-data');
const UPLOADS_DIR = path.join(PS_BASE, 'ps-uploads');

[DATA_DIR,
 path.join(UPLOADS_DIR, 'presentacion'),
 path.join(UPLOADS_DIR, 'signed'),
 path.join(UPLOADS_DIR, 'templates'),
].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Los documentos de arranque (los cinco formatos de SST que se firman) sí viven
// en el proyecto, pero en una carpeta APARTE que la aplicación solo lee. Así, si
// el disco se pierde o se estrena servidor, vuelven solos — y como nadie escribe
// ahí, ningún despliegue puede pisar el trabajo de nadie.
const SEMILLA = path.join(__dirname, 'modulos', 'punto-seguro', 'documentos-base');

(function copiarDocumentosBaseSiFaltan() {
  try {
    [['ps-data', DATA_DIR], ['ps-uploads', UPLOADS_DIR]].forEach(([nombre, destino]) => {
      const origen = path.join(SEMILLA, nombre);
      if (!fs.existsSync(origen) || path.resolve(origen) === path.resolve(destino)) return;
      let copiados = 0;
      const copiar = (desde, hacia) => {
        if (!fs.existsSync(hacia)) fs.mkdirSync(hacia, { recursive: true });
        for (const item of fs.readdirSync(desde, { withFileTypes: true })) {
          const o = path.join(desde, item.name), d = path.join(hacia, item.name);
          if (item.isDirectory()) copiar(o, d);
          else if (!fs.existsSync(d)) { fs.copyFileSync(o, d); copiados++; }   // nunca pisa
        }
      };
      copiar(origen, destino);
      if (copiados) console.log(`[PUNTO SEGURO] ${copiados} documento(s) base copiados a ${nombre}`);
    });
  } catch (e) {
    console.error('[PUNTO SEGURO] No se pudieron copiar los documentos base:', e.message);
  }
})();
console.log(`[PUNTO SEGURO] Datos en ${DATA_DIR}`);

// ── Soltar los PDF repetidos dentro del archivo de plantillas ────────────────
// Cada plantilla se guardaba dos veces: el PDF en disco y otra copia convertida
// a texto dentro del JSON. El JSON llego a 831 KB para guardar 5 documentos.
//
// El orden importa y es a prueba de sustos: PRIMERO se comprueba que el PDF
// este en disco y, si falta, se escribe desde el texto (o sea, se recupera).
// SOLO cuando existe el archivo se suelta la copia. Una plantilla cuyo PDF no
// se pueda recuperar conserva su texto y no se toca.
(function soltarPdfRepetidos() {
  try {
    const ruta = path.join(DATA_DIR, 'ps_annex_templates.json');
    if (!fs.existsSync(ruta)) return;
    const lista = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (!Array.isArray(lista) || !lista.length) return;

    let soltadas = 0, recuperadas = 0, intactas = 0, kb = 0;
    for (const t of lista) {
      if (!t || !t.pdfBase64) continue;
      const archivo = path.join(UPLOADS_DIR, 'templates', `${t.id}.pdf`);
      if (!fs.existsSync(archivo)) {
        try {
          fs.writeFileSync(archivo, Buffer.from(t.pdfBase64, 'base64'));
          recuperadas++;
        } catch (e) { intactas++; continue; }   // no se pudo: se conserva el texto
      }
      kb += Math.round(t.pdfBase64.length / 1024);
      delete t.pdfBase64;
      soltadas++;
    }
    if (!soltadas) return;
    fs.writeFileSync(ruta, JSON.stringify(lista));
    console.log(`[PUNTO SEGURO] ${soltadas} plantilla(s) ya no se guardan dos veces (${kb} KB liberados)` +
      (recuperadas ? `, ${recuperadas} PDF recuperado(s) al disco` : '') +
      (intactas ? `, ${intactas} sin tocar por precaucion` : ''));
  } catch (e) {
    console.error('[PUNTO SEGURO] No se pudieron soltar los PDF repetidos:', e.message);
  }
})();

const FILES_INDUCTION_RUTA = path.join(DATA_DIR, 'ps_induction.json');
const FILES = {
  workers:        path.join(DATA_DIR, 'ps_workers.json'),
  trainingPlan:   path.join(DATA_DIR, 'ps_training_plan.json'),
  sessions:       path.join(DATA_DIR, 'ps_sessions.json'),
  quizzes:        path.join(DATA_DIR, 'ps_quizzes.json'),
  attempts:       path.join(DATA_DIR, 'ps_attempts.json'),
  annexTemplates: path.join(DATA_DIR, 'ps_annex_templates.json'),
  signaturePos:   path.join(DATA_DIR, 'ps_signature_positions.json'),
  induction:      path.join(DATA_DIR, 'ps_induction.json'),
};

function psRead(filePath, def) {
  try {
    if (!fs.existsSync(filePath)) return def;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch { return def; }
}
function psWrite(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
}
/* ── La presentación de la inducción ──────────────────────────────────
   El PDF vive en un ARCHIVO del disco, no como texto dentro del JSON: pegado
   como "data:application/pdf;base64,…" en un iframe, Chrome no lo muestra si
   pasa de 2 MB (queda en blanco), y cada trabajador descargaba ~9 MB de datos
   solo para abrir el recorrido. En el JSON queda solo { nombre, sizeKb, version }. */
const PRESENTACION_PDF = path.join(UPLOADS_DIR, 'presentacion', 'induccion.pdf');
const esPdf = buf => buf && buf.length > 5 && buf.slice(0, 5).toString('latin1') === '%PDF-';
function guardarPresentacion(base64, nombre) {
  const buf = Buffer.from(String(base64 || ''), 'base64');
  if (!esPdf(buf)) return null;
  fs.writeFileSync(PRESENTACION_PDF, buf);
  return { nombre: String(nombre || 'presentacion.pdf'), sizeKb: Math.round(buf.length / 1024), version: Date.now() };
}
// Al arrancar: si el PDF todavía está pegado como texto en el JSON, se pasa a archivo.
// Primero se escribe y se comprueba el archivo; solo entonces se suelta el texto.
(function pasarPresentacionAArchivo() {
  try {
    const ruta = FILES_INDUCTION_RUTA;
    if (!fs.existsSync(ruta)) return;
    const ind = JSON.parse(fs.readFileSync(ruta, 'utf8'));
    if (!ind || !ind.presentacion || !ind.presentacion.pdfBase64) return;
    const meta = guardarPresentacion(ind.presentacion.pdfBase64, ind.presentacion.nombre);
    if (!meta || !fs.existsSync(PRESENTACION_PDF)) { console.error('[PUNTO SEGURO] La presentación no parece un PDF válido: se deja como estaba.'); return; }
    ind.presentacion = meta;
    fs.writeFileSync(ruta, JSON.stringify(ind), 'utf8');
    console.log('[PUNTO SEGURO] La presentación de la inducción pasó a archivo (' + meta.sizeKb + ' KB)');
  } catch (e) {
    console.error('[PUNTO SEGURO] No se pudo pasar la presentación a archivo:', e.message);
  }
})();

function genId(prefix) {
  return `${prefix}_${Date.now()}_${uuidv4().replace(/-/g,'').slice(0,8)}`;
}
function normalizeAnnexName(name) {
  return String(name || '')
    .toLowerCase().replace(/\.pdf$/i,'')
    .normalize('NFD').replace(/[̀-ͯ]/g,'')
    .replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'');
}

const router = Router();

const PS_CONFIG = path.join(DATA_DIR, 'ps_config.json');

/* ── AUTORIZACIÓN (se decide AQUÍ, en el servidor; la pantalla solo la refleja) ──────────────
   El router se monta detrás de la sesión y del permiso `punto_seguro` (server.js). Dentro hay dos niveles:
     · TRABAJADOR: lo que hace quien recorre su inducción (buscarse por cédula, registrarse, ver el
       paquete, firmar, presentar la evaluación). Basta con la sesión y el permiso del módulo.
     · ADMINISTRADOR (`soloAdmin`): todo lo demás — lista de personas, resultados, documentos firmados,
       planes, sesiones, plantillas, evaluaciones, contenido de la inducción. Lo es un administrador del
       MES o quien escribió bien la contraseña de administrador de Punto Seguro (permiso de 2 horas).
   server.js le presta lo que no puede saber solo con `router.enlazar({...})`. */
const AUT = require('./ps-autorizacion');
const H = {};
router.enlazar = x => Object.assign(H, x);
const usuarioDe = req => String((req.auth && req.auth.user) || '');
const esAdmin = req => !!(req.auth && (
  (H.esAdminApp && H.esAdminApp(req)) ||
  (H.secreto && AUT.validarGrant(H.secreto, AUT.leerCookie(req.headers.cookie, AUT.COOKIE), usuarioDe(req)))));
function soloAdmin(req, res, next) {
  if (esAdmin(req)) return next();
  return res.status(403).json({ success: false, requiereAdmin: true,
    message: 'Esta opción es solo para el administrador de Punto Seguro. Ingresa con la contraseña de administrador.' });
}
// Frenos de intentos prestados por server.js (cuenta por IP real y por ruta). Sin ellos no frena.
const limitar = (max, ms) => { let f; return (req, res, next) => { if (!H.rateLimit) return next(); f = f || H.rateLimit(max, ms); return f(req, res, next); }; };
const bloqueado = req => !!(H.bloqueadoPorFallos && H.bloqueadoPorFallos(req));
const fallo = req => { if (H.anotarFallo) H.anotarFallo(req); };

// Validación de entradas
const ID_OK = /^[A-Za-z0-9_-]{1,100}$/;
['id', 'docId', 'attId', 'fileKey'].forEach(n => router.param(n, (_req, res, next, v) =>
  ID_OK.test(String(v)) ? next() : res.status(400).json({ success: false, message: 'Identificador no válido.' })));
router.param('cedula', (_req, res, next, v) =>
  String(v).length <= 30 ? next() : res.status(400).json({ success: false, message: 'Cédula no válida.' }));
const texto = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const soloDigitos = v => String(v == null ? '' : v).replace(/\D/g, '');
const nombreSeguro = s => String(s || 'documento.pdf').replace(/[^\w .()-]/g, '_').slice(0, 120);
const MAX_PDF_BYTES = 15 * 1024 * 1024;
const correoOk = s => s === '' || /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(s);

// ── HEALTH ───────────────────────────────────────────────────────────────────
router.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── AUTH ADMINISTRADOR ────────────────────────────────────────────────────────
// La contraseña de administrador YA NO tiene valor por defecto. Se guarda con bcrypt (si estaba en texto
// plano, se convierte sola la primera vez que se escribe bien). Si todavía no existe ninguna, la crea un
// administrador del MES (Configuraciones) escribiendo la que quiere en este mismo ingreso.
router.post('/auth', limitar(10, 60 * 1000), (req, res) => {
  if (bloqueado(req)) return res.status(429).json({ success: false, message: 'Demasiados intentos. Espera un minuto.' });
  const pass = (req.body || {}).pass;
  if (typeof pass !== 'string' || !pass) return res.status(400).json({ success: false, message: 'Contraseña requerida.' });
  const cfg = psRead(PS_CONFIG, {});
  const emitir = () => res.append('Set-Cookie', AUT.cookieGrant(
    AUT.crearGrant(H.secreto, usuarioDe(req)), { seguro: req.secure }));
  if (!H.secreto) return res.status(503).json({ success: false, message: 'El servidor no tiene la autorización configurada.' });

  if (!AUT.hayClave(cfg)) {
    if (!(H.esAdminApp && H.esAdminApp(req)))
      return res.status(409).json({ success: false, configurar: true,
        message: 'La contraseña de administrador de Punto Seguro aún no está configurada. Pide a un administrador del MES que la cree.' });
    const motivo = AUT.claveAceptable(pass);
    if (motivo) return res.status(400).json({ success: false, configurar: true, message: motivo });
    psWrite(PS_CONFIG, AUT.cfgConClave(cfg, pass));
    emitir();
    return res.json({ success: true, creada: true });
  }
  const r = AUT.comprobarClave(cfg, pass);
  if (!r.ok) { fallo(req); return res.status(401).json({ success: false, message: 'Contraseña incorrecta.' }); }
  if (r.cfgNuevo) psWrite(PS_CONFIG, r.cfgNuevo);      // estaba en texto plano: ahora queda con hash
  emitir();
  res.json({ success: true });
});

// Cambiar la contraseña: administrador + la contraseña actual (salvo que aún no exista ninguna).
router.put('/config/admin-pass', soloAdmin, limitar(10, 60 * 1000), (req, res) => {
  if (bloqueado(req)) return res.status(429).json({ success: false, message: 'Demasiados intentos. Espera un minuto.' });
  const { actual, nueva } = req.body || {};
  const cfg = psRead(PS_CONFIG, {});
  if (AUT.hayClave(cfg)) {
    if (!AUT.comprobarClave(cfg, actual).ok) { fallo(req); return res.status(401).json({ success: false, message: 'La contraseña actual no es correcta.' }); }
  }
  const motivo = AUT.claveAceptable(nueva);
  if (motivo) return res.status(400).json({ success: false, message: motivo });
  psWrite(PS_CONFIG, AUT.cfgConClave(cfg, nueva));
  res.json({ success: true });
});

// Cierra el permiso de administrador de este navegador (para la próxima persona que use el equipo).
router.post('/auth/salir', (_req, res) => { res.append('Set-Cookie', AUT.cookieBorrar()); res.json({ success: true }); });

// ── TRABAJADORES ─────────────────────────────────────────────────────────────
router.get('/trabajadores', soloAdmin, (_req, res) => {
  const workers = psRead(FILES.workers, []);
  res.json({ success: true, data: workers.map(w => ({
    ...w,
    documentosFirmadosCount: (w.documentosFirmados || []).length,
  })) });
});

// El trabajador entra con su cédula. Si todavía no tiene ficha en Punto
// Seguro, se busca en los empleados de la empresa (Configuraciones) y se le
// crea con su nombre y su cargo. Así nadie tiene que darlos de alta a mano uno
// por uno. Si no está en ninguna de las dos listas, no entra: "vinculado"
// significa que ya trabaja en la empresa.
router.get('/trabajadores/cedula/:cedula', limitar(60, 60 * 1000), (req, res) => {
  const soloNumeros = s => String(s || '').replace(/\D/g, '');
  const cedula = soloNumeros(req.params.cedula);

  const workers = psRead(FILES.workers, []);
  const w = workers.find(x => soloNumeros(x.documento) === cedula);
  if (w) return res.json({ success: true, data: w });

  const emp = typeof router.buscarEmpleadoPorCedula === 'function'
    ? router.buscarEmpleadoPorCedula(cedula)
    : null;
  if (!emp) {
    return res.status(404).json({
      success: false,
      message: 'Esa cédula no está registrada en la empresa. Habla con Gestión Humana.'
    });
  }

  const nuevo = {
    id: genId('w'),
    nombre: emp.nombre, documento: emp.documento,
    cargo: emp.cargo || '', fechaIngreso: null,
    correo: '', celular: '', area: emp.area || '',
    consentimientoFirmaElectronica: false,
    documentosFirmados: [],
    creadoDesdeEmpleados: true,          // se creó solo, no lo registró nadie
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  workers.push(nuevo);
  psWrite(FILES.workers, workers);
  res.json({ success: true, data: nuevo });
});

router.get('/trabajadores/:id', (req, res) => {
  const w = psRead(FILES.workers, []).find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ success: false, message: 'Trabajador no encontrado.' });
  res.json({ success: true, data: w });
});

router.post('/trabajadores', limitar(30, 60 * 1000), (req, res) => {
  const workers = psRead(FILES.workers, []);
  const b = req.body || {};
  const nombre = texto(b.nombre, 120), documento = soloDigitos(b.documento);
  const cargo = texto(b.cargo, 80), correo = texto(b.correo, 120), celular = texto(b.celular, 25);
  const fechaIngreso = /^\d{4}-\d{2}-\d{2}$/.test(String(b.fechaIngreso || '')) ? b.fechaIngreso : null;
  // Quien se registra solo (el público) no elige su área: la fija el sistema. La elige el administrador.
  const area = esAdmin(req) ? texto(b.area, 80) : 'Público';
  if (nombre.length < 3) return res.status(400).json({ success: false, message: 'Escribe el nombre completo.' });
  if (documento.length < 5 || documento.length > 15) return res.status(400).json({ success: false, message: 'La cédula debe tener entre 5 y 15 números.' });
  if (!correoOk(correo)) return res.status(400).json({ success: false, message: 'El correo no es válido.' });
  if (workers.find(x => soloDigitos(x.documento) === documento))
    return res.status(409).json({ success: false, message: `Ya existe un trabajador con el documento ${documento}.` });
  const w = {
    id: genId('w'), nombre, documento,
    cargo, fechaIngreso,
    correo, celular, area,
    consentimientoFirmaElectronica: false,
    documentosFirmados: [],
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  workers.push(w);
  psWrite(FILES.workers, workers);
  res.status(201).json({ success: true, data: { ...w, documentosFirmadosCount: 0 } });
});

router.put('/trabajadores/:id', (req, res) => {
  const workers = psRead(FILES.workers, []);
  const idx = workers.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Trabajador no encontrado.' });
  // El trabajador solo puede marcar el avance de SU recorrido (si se sale a mitad, al volver sigue donde
  // iba). Cambiar nombre, cédula, cargo, área o contacto es cosa del administrador.
  const AVANCE = ['inductionCompletadaEn', 'datosActualizadosEn', 'presentacionVistaEn'];
  const DATOS  = ['nombre', 'documento', 'cargo', 'fechaIngreso', 'correo', 'celular', 'area', 'consentimientoFirmaElectronica'];
  const b = req.body || {};
  if (!esAdmin(req) && DATOS.some(k => b[k] !== undefined))
    return res.status(403).json({ success: false, requiereAdmin: true, message: 'Solo el administrador puede cambiar los datos de una persona.' });
  const marcaOk = v => v === null || (typeof v === 'string' && v.length <= 40 && !isNaN(Date.parse(v)));
  if (AVANCE.some(k => b[k] !== undefined && !marcaOk(b[k]))) return res.status(400).json({ success: false, message: 'La fecha no es válida.' });
  if (b.correo !== undefined && !correoOk(texto(b.correo, 120))) return res.status(400).json({ success: false, message: 'El correo no es válido.' });
  const valorDe = k => {
    if (AVANCE.includes(k)) return b[k];
    if (k === 'consentimientoFirmaElectronica') return b[k] === true;
    if (k === 'fechaIngreso') return /^\d{4}-\d{2}-\d{2}$/.test(String(b[k])) ? b[k] : null;
    return texto(String(b[k] == null ? '' : b[k]), 120);
  };
  [...DATOS, ...AVANCE].forEach(k => { if (b[k] !== undefined) workers[idx][k] = valorDe(k); });
  workers[idx].updatedAt = new Date().toISOString();
  psWrite(FILES.workers, workers);
  res.json({ success: true, data: workers[idx] });
});

// Borra a la persona y TODO su rastro: los PDF que firmo y las respuestas de su
// evaluacion. Asi vuelve a quedar disponible para hacer el proceso de nuevo:
// entra con su cedula, se crea otra vez y empieza de cero.
//
// Antes las respuestas se quedaban sueltas, sin dueno: la persona desaparecia
// de la lista pero su evaluacion seguia guardada para siempre.
router.delete('/trabajadores/:id', soloAdmin, (req, res) => {
  const workers = psRead(FILES.workers, []);
  const idx = workers.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Trabajador no encontrado.' });

  (workers[idx].documentosFirmados || []).forEach(doc => {
    const f = path.join(UPLOADS_DIR, 'signed', `${doc.id}.pdf`);
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
  });

  const attempts = psRead(FILES.attempts, []);
  const quedan   = attempts.filter(a => a.workerId !== req.params.id);
  if (quedan.length !== attempts.length) psWrite(FILES.attempts, quedan);

  workers.splice(idx, 1);
  psWrite(FILES.workers, workers);
  res.status(204).send();
});

router.post('/trabajadores/:id/documentos-firmados', (req, res) => {
  const workers = psRead(FILES.workers, []);
  const idx = workers.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Trabajador no encontrado.' });
  const b = req.body || {};
  const nombre = texto(b.nombre, 150), hash = texto(b.hash, 128);
  if (!nombre) return res.status(400).json({ success: false, message: 'Falta el nombre del documento.' });
  if (typeof b.pdfBase64 !== 'string' || !b.pdfBase64) return res.status(400).json({ success: false, message: 'Falta el documento firmado.' });
  const buf = Buffer.from(b.pdfBase64, 'base64');
  if (!esPdf(buf)) return res.status(400).json({ success: false, message: 'El archivo no es un PDF válido.' });
  if (buf.length > MAX_PDF_BYTES) return res.status(413).json({ success: false, message: 'El PDF es demasiado grande (máximo 15 MB).' });
  const docId = genId('doc');
  fs.writeFileSync(path.join(UPLOADS_DIR, 'signed', `${docId}.pdf`), buf);
  const doc = { id: docId, nombre, hash, sizeKb: Math.round(buf.length/1024), firmadoEn: new Date().toISOString() };
  if (!workers[idx].documentosFirmados) workers[idx].documentosFirmados = [];
  workers[idx].documentosFirmados.push(doc);
  workers[idx].consentimientoFirmaElectronica = true;
  workers[idx].updatedAt = new Date().toISOString();
  psWrite(FILES.workers, workers);
  res.status(201).json({ success: true, data: doc });
});

// Los PDF firmados contienen la firma y datos personales: solo los descarga el administrador.
router.get('/trabajadores/:id/documentos-firmados/:docId', soloAdmin, (req, res) => {
  const w = psRead(FILES.workers, []).find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ success: false, message: 'Trabajador no encontrado.' });
  const doc = (w.documentosFirmados || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ success: false, message: 'Documento no encontrado.' });
  const file = path.join(UPLOADS_DIR, 'signed', `${doc.id}.pdf`);
  if (!fs.existsSync(file)) return res.status(404).json({ success: false, message: 'Archivo no encontrado.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="firmado_${nombreSeguro(doc.nombre)}"`);
  res.sendFile(file);
});

// ── PLAN DE CAPACITACIÓN ─────────────────────────────────────────────────────
router.get('/capacitaciones/plan', soloAdmin, (_req, res) =>
  res.json({ success: true, data: psRead(FILES.trainingPlan, []) }));

router.post('/capacitaciones/plan', soloAdmin, (req, res) => {
  const items = psRead(FILES.trainingPlan, []);
  const { mes, tema, dirigidoA, horas, responsable } = req.body;
  const item = { id: genId('tp'), mes:mes||'', tema:tema||'', dirigidoA:dirigidoA||'', horas:horas||'', responsable:responsable||'' };
  items.push(item);
  psWrite(FILES.trainingPlan, items);
  res.status(201).json({ success: true, data: item });
});

router.put('/capacitaciones/plan/:id', soloAdmin, (req, res) => {
  const items = psRead(FILES.trainingPlan, []);
  const idx = items.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Ítem no encontrado.' });
  ['mes','tema','dirigidoA','horas','responsable'].forEach(k => { if (req.body[k] !== undefined) items[idx][k] = req.body[k]; });
  psWrite(FILES.trainingPlan, items);
  res.json({ success: true, data: items[idx] });
});

router.delete('/capacitaciones/plan/:id', soloAdmin, (req, res) => {
  const items = psRead(FILES.trainingPlan, []);
  const idx = items.findIndex(x => x.id === req.params.id);
  if (idx !== -1) items.splice(idx, 1);
  psWrite(FILES.trainingPlan, items);
  res.status(204).send();
});

// ── SESIONES ─────────────────────────────────────────────────────────────────
router.get('/capacitaciones/sesiones', soloAdmin, (_req, res) => {
  const sessions = psRead(FILES.sessions, []);
  res.json({ success: true, data: sessions.map(({ asistentes, ...s }) => ({ ...s, asistentes })) });
});

router.post('/capacitaciones/sesiones', soloAdmin, (req, res) => {
  const sessions = psRead(FILES.sessions, []);
  const { tema, fecha, horas, dirigidoA, responsable } = req.body;
  const session = {
    id: genId('ses'), tema, fecha,
    horas:horas||'', dirigidoA:dirigidoA||'Todo el personal', responsable:responsable||'',
    asistentes: [], createdAt: new Date().toISOString(),
  };
  sessions.push(session);
  psWrite(FILES.sessions, sessions);
  res.status(201).json({ success: true, data: session });
});

router.post('/capacitaciones/sesiones/:id/asistentes', soloAdmin, (req, res) => {
  const sessions = psRead(FILES.sessions, []);
  const idx = sessions.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Sesión no encontrada.' });
  const { workerId, nombre } = req.body;
  const att = { id: genId('att'), sessionId: req.params.id, workerId: workerId||null, nombre, asistio: false, evaluado: false };
  if (!sessions[idx].asistentes) sessions[idx].asistentes = [];
  sessions[idx].asistentes.push(att);
  psWrite(FILES.sessions, sessions);
  res.status(201).json({ success: true, data: att });
});

router.patch('/capacitaciones/sesiones/:id/asistentes/:attId', soloAdmin, (req, res) => {
  const sessions = psRead(FILES.sessions, []);
  const sIdx = sessions.findIndex(x => x.id === req.params.id);
  if (sIdx === -1) return res.status(404).json({ success: false, message: 'Sesión no encontrada.' });
  const aIdx = (sessions[sIdx].asistentes||[]).findIndex(a => a.id === req.params.attId);
  if (aIdx === -1) return res.status(404).json({ success: false, message: 'Asistente no encontrado.' });
  ['asistio','evaluado'].forEach(k => { if (req.body[k] !== undefined) sessions[sIdx].asistentes[aIdx][k] = req.body[k]; });
  psWrite(FILES.sessions, sessions);
  res.json({ success: true, data: sessions[sIdx].asistentes[aIdx] });
});

router.delete('/capacitaciones/sesiones/:id/asistentes/:attId', soloAdmin, (req, res) => {
  const sessions = psRead(FILES.sessions, []);
  const sIdx = sessions.findIndex(x => x.id === req.params.id);
  if (sIdx !== -1) {
    const aIdx = (sessions[sIdx].asistentes||[]).findIndex(a => a.id === req.params.attId);
    if (aIdx !== -1) sessions[sIdx].asistentes.splice(aIdx, 1);
    psWrite(FILES.sessions, sessions);
  }
  res.status(204).send();
});

// ── EVALUACIONES ─────────────────────────────────────────────────────────────
router.get('/evaluaciones', (_req, res) => {
  const quizzes = psRead(FILES.quizzes, []);
  // La lista no lleva las preguntas (serían muchos datos para nada), pero sí
  // cuántas tiene cada una: es lo que muestra la pantalla.
  res.json({ success: true, data: quizzes.map(({ preguntas, ...q }) => ({
    ...q, preguntasCount: (preguntas || []).length,
  })) });
});

router.get('/evaluaciones/:id', (req, res) => {
  const q = psRead(FILES.quizzes, []).find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ success: false, message: 'Evaluación no encontrada.' });
  res.json({ success: true, data: q });
});

router.post('/evaluaciones', soloAdmin, (req, res) => {
  const quizzes = psRead(FILES.quizzes, []);
  const { nombre, categoria, preguntas } = req.body;
  const quiz = {
    id: genId('q'), nombre, categoria: categoria||'',
    preguntas: (preguntas||[]).map((p, i) => ({ id: p.id||genId('qq'), ...p, orden: i })),
    createdAt: new Date().toISOString(),
  };
  quizzes.push(quiz);
  psWrite(FILES.quizzes, quizzes);
  res.status(201).json({ success: true, data: quiz });
});

router.put('/evaluaciones/:id', soloAdmin, (req, res) => {
  const quizzes = psRead(FILES.quizzes, []);
  const idx = quizzes.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Evaluación no encontrada.' });
  const { nombre, categoria, preguntas } = req.body;
  if (nombre !== undefined) quizzes[idx].nombre = nombre;
  if (categoria !== undefined) quizzes[idx].categoria = categoria;
  if (preguntas !== undefined)
    quizzes[idx].preguntas = preguntas.map((p, i) => ({ id: p.id||genId('qq'), ...p, orden: i }));
  quizzes[idx].updatedAt = new Date().toISOString();
  psWrite(FILES.quizzes, quizzes);
  res.json({ success: true, data: quizzes[idx] });
});

router.delete('/evaluaciones/:id', soloAdmin, (req, res) => {
  const quizzes = psRead(FILES.quizzes, []);
  const idx = quizzes.findIndex(x => x.id === req.params.id);
  if (idx !== -1) quizzes.splice(idx, 1);
  psWrite(FILES.quizzes, quizzes);
  // Si la inducción usaba esa evaluación, queda sin evaluación hasta que se elija otra.
  const ind = psRead(FILES.induction, null);
  if (ind && ind.quizId === req.params.id) { ind.quizId = null; psWrite(FILES.induction, ind); }
  res.status(204).send();
});

// ── RESULTADOS ───────────────────────────────────────────────────────────────
// El administrador ve todo (nombres, respuestas). El trabajador solo necesita saber si ya presentó una
// evaluación y con qué nota: sin nombres ni respuestas de nadie, y con ?workerId= solo las suyas.
router.get('/resultados', (req, res) => {
  const todos = psRead(FILES.attempts, []);
  if (esAdmin(req)) return res.json({ success: true, data: todos });
  const solo = typeof req.query.workerId === 'string' ? req.query.workerId : '';
  const minimos = todos.filter(a => !solo || a.workerId === solo)
    .map(a => ({ id: a.id, workerId: a.workerId, quizId: a.quizId, puntaje: a.puntaje, fecha: a.fecha, origen: a.origen }));
  res.json({ success: true, data: minimos });
});

router.post('/resultados', limitar(60, 60 * 1000), (req, res) => {
  const attempts = psRead(FILES.attempts, []);
  const b = req.body || {};
  const puntaje = Number(b.puntaje);
  if (!Number.isFinite(puntaje) || puntaje < 0 || puntaje > 100000) return res.status(400).json({ success: false, message: 'El puntaje no es válido.' });
  const respuestas = (b.respuestas && typeof b.respuestas === 'object' && !Array.isArray(b.respuestas) && JSON.stringify(b.respuestas).length <= 200000) ? b.respuestas : {};
  const att = {
    id: genId('res'), workerId: texto(b.workerId, 100)||null, workerNombrePublico: texto(b.workerNombrePublico, 120)||null,
    quizId: texto(b.quizId, 100)||null, quizNombre: texto(b.quizNombre, 200), puntaje,
    // Que marco en cada pregunta. Sin esto solo queda la nota, y en Resultados
    // no se puede ver en que se equivoco.
    respuestas,
    fecha: new Date().toISOString(), origen: texto(b.origen, 40)||'panel_admin',
  };
  attempts.push(att);
  psWrite(FILES.attempts, attempts);
  res.status(201).json({ success: true, data: att });
});

// ── PLANTILLAS DE ANEXOS ─────────────────────────────────────────────────────
// No enviar pdfBase64 en el listado (demasiado pesado)
router.get('/paquete/plantillas', (_req, res) => {
  const all = psRead(FILES.annexTemplates, []);
  res.json({ success: true, data: all.map(({ pdfBase64, ...rest }) => rest) });
});

// Sirve desde disco si existe; si no, desde base64 guardado en JSON
router.get('/paquete/plantillas/:id/archivo', (req, res) => {
  const tpl = psRead(FILES.annexTemplates, []).find(x => x.id === req.params.id);
  if (!tpl) return res.status(404).json({ success: false, message: 'Plantilla no encontrada.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${nombreSeguro(tpl.nombre)}"`);
  const diskFile = path.join(UPLOADS_DIR, 'templates', `${tpl.id}.pdf`);
  if (fs.existsSync(diskFile)) return res.sendFile(diskFile);
  if (tpl.pdfBase64) return res.send(Buffer.from(tpl.pdfBase64, 'base64'));
  return res.status(404).json({ success: false, message: 'Archivo no encontrado en disco ni en base de datos.' });
});

// La plantilla se guarda SOLO en disco.
//
// Antes se guardaba ademas dentro del JSON, convertida a texto, como copia de
// seguridad: los archivos vivian en la carpeta del proyecto y cada despliegue
// los borraba. Eso ya no pasa — ahora estan en el disco permanente — asi que esa
// copia solo servia para pesar el doble. El archivo de plantillas llego a ocupar
// 831 KB, de los cuales 830 eran los mismos PDF repetidos dentro.
router.post('/paquete/plantillas', soloAdmin, (req, res) => {
  const templates = psRead(FILES.annexTemplates, []);
  const b = req.body || {};
  const nombre = texto(b.nombre, 150);
  if (!nombre) return res.status(400).json({ success: false, message: 'Falta el nombre de la plantilla.' });
  const fileKey = normalizeAnnexName(nombre);
  if (!fileKey) return res.status(400).json({ success: false, message: 'El nombre de la plantilla no es válido.' });
  if (templates.find(x => x.fileKey === fileKey))
    return res.status(409).json({ success: false, message: `Ya existe una plantilla equivalente ("${nombre}").` });
  if (typeof b.pdfBase64 !== 'string' || !b.pdfBase64) return res.status(400).json({ success: false, message: 'Falta el archivo PDF.' });
  const buf = Buffer.from(b.pdfBase64, 'base64');
  if (!esPdf(buf)) return res.status(400).json({ success: false, message: 'El archivo no es un PDF válido.' });
  if (buf.length > MAX_PDF_BYTES) return res.status(413).json({ success: false, message: 'El PDF es demasiado grande (máximo 15 MB).' });
  const id = genId('tpl');
  try { fs.writeFileSync(path.join(UPLOADS_DIR, 'templates', `${id}.pdf`), buf); } catch {}
  const tpl = { id, nombre, fileKey, sizeKb: Math.round(buf.length/1024), subidoEn: new Date().toISOString() };
  templates.push(tpl);
  psWrite(FILES.annexTemplates, templates);
  res.status(201).json({ success: true, data: tpl });
});

router.delete('/paquete/plantillas/:id', soloAdmin, (req, res) => {
  const templates = psRead(FILES.annexTemplates, []);
  const idx = templates.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Plantilla no encontrada.' });
  const f = path.join(UPLOADS_DIR, 'templates', `${templates[idx].id}.pdf`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
  const sigPos = psRead(FILES.signaturePos, {});
  delete sigPos[templates[idx].fileKey];
  psWrite(FILES.signaturePos, sigPos);
  templates.splice(idx, 1);
  psWrite(FILES.annexTemplates, templates);
  res.status(204).send();
});

// ── POSICIONES DE FIRMA ──────────────────────────────────────────────────────
router.get('/paquete/posiciones-firma', (_req, res) =>
  res.json({ success: true, data: Object.values(psRead(FILES.signaturePos, {})) }));

router.post('/paquete/posiciones-firma', soloAdmin, (req, res) => {
  const pos = psRead(FILES.signaturePos, {});
  const { fileKey, pageIndex, xRatio, yRatio, widthRatio } = req.body || {};
  if (typeof fileKey !== 'string' || !ID_OK.test(fileKey)) return res.status(400).json({ success: false, message: 'Identificador de plantilla no válido.' });
  const num = v => typeof v === 'number' && Number.isFinite(v);
  if (![pageIndex, xRatio, yRatio].every(num) || (widthRatio !== undefined && !num(widthRatio)))
    return res.status(400).json({ success: false, message: 'La posición de la firma no es válida.' });
  pos[fileKey] = { fileKey, pageIndex, xRatio, yRatio, widthRatio: widthRatio??0.22, updatedAt: new Date().toISOString() };
  psWrite(FILES.signaturePos, pos);
  res.json({ success: true, data: pos[fileKey] });
});

router.delete('/paquete/posiciones-firma/:fileKey', soloAdmin, (req, res) => {
  const pos = psRead(FILES.signaturePos, {});
  delete pos[req.params.fileKey];
  psWrite(FILES.signaturePos, pos);
  res.status(204).send();
});

// ── INDUCCIÓN ─────────────────────────────────────────────────────────────────
// El paquete de ingreso guarda todo lo que el trabajador tiene que recorrer:
// el enlace para actualizar sus datos, la presentación que debe ver, el texto
// de la inducción y cuál evaluación se aplica. Cada parte es opcional: la que
// no esté configurada, simplemente no aparece en el recorrido.
const INDUCCION_VACIA = { titulo:'', cuerpo:'', quizId:null, driveUrl:'', presentacion:null };

/* Lo que ve la pantalla: sin el PDF (va aparte, por su dirección) y con la
   evaluación resuelta. Si la que estaba elegida ya no existe (se borró o se
   volvió a crear) y hay UNA sola, se usa esa; con varias, hay que elegir. */
function induccionPublica() {
  const ind = { ...INDUCCION_VACIA, ...psRead(FILES.induction, {}) };
  if (ind.quizId) {
    const quizzes = psRead(FILES.quizzes, []);
    if (!quizzes.some(q => q.id === ind.quizId)) ind.quizId = quizzes.length === 1 ? quizzes[0].id : null;
  }
  if (ind.presentacion && !ind.presentacion.pdfBase64 && !fs.existsSync(PRESENTACION_PDF)) ind.presentacion = null;
  return ind;
}
router.get('/paquete/induccion', (_req, res) =>
  res.json({ success: true, data: induccionPublica() }));

// El PDF de la presentación. La dirección lleva ?v=version: cambia al subir otro.
router.get('/paquete/induccion/presentacion', (_req, res) => {
  if (!fs.existsSync(PRESENTACION_PDF)) return res.status(404).json({ success: false, message: 'No hay presentación.' });
  const ind = psRead(FILES.induction, {});
  const nombre = String((ind.presentacion && ind.presentacion.nombre) || 'presentacion.pdf').replace(/[^\w .()-]/g, '_');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="' + nombre + '"',
            'Cache-Control': 'public, max-age=86400' });
  res.sendFile(PRESENTACION_PDF);
});

router.put('/paquete/induccion', soloAdmin, (req, res) => {
  const previo = { ...INDUCCION_VACIA, ...psRead(FILES.induction, {}) };
  const { titulo, cuerpo, quizId, driveUrl, presentacion } = req.body;
  const ind = {
    titulo:   titulo   !== undefined ? String(titulo || '')   : previo.titulo,
    cuerpo:   cuerpo   !== undefined ? String(cuerpo || '')   : previo.cuerpo,
    quizId:   quizId   !== undefined ? (quizId || null)       : previo.quizId,
    driveUrl: driveUrl !== undefined ? String(driveUrl || '') : previo.driveUrl,
    // presentacion: null la quita; con pdfBase64 es una nueva (se guarda como
    // archivo); sin eso (o undefined) se deja como estaba.
    presentacion: previo.presentacion,
  };
  if (presentacion === null) {
    try { if (fs.existsSync(PRESENTACION_PDF)) fs.unlinkSync(PRESENTACION_PDF); } catch (e) {}
    ind.presentacion = null;
  } else if (presentacion && presentacion.pdfBase64) {
    const meta = guardarPresentacion(presentacion.pdfBase64, presentacion.nombre);
    if (!meta) return res.status(400).json({ success: false, message: 'El archivo no es un PDF válido.' });
    ind.presentacion = meta;
  }
  psWrite(FILES.induction, ind);
  res.json({ success: true, data: induccionPublica() });
});

module.exports = router;
