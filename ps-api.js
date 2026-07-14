'use strict';
const { Router } = require('express');
const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR    = path.join(__dirname, 'ps-data');
const UPLOADS_DIR = path.join(__dirname, 'ps-uploads');

[DATA_DIR,
 path.join(UPLOADS_DIR, 'signed'),
 path.join(UPLOADS_DIR, 'templates'),
].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

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

// ── HEALTH ───────────────────────────────────────────────────────────────────
router.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── AUTH ADMINISTRADOR ────────────────────────────────────────────────────────
router.post('/auth', (req, res) => {
  const { pass } = req.body || {};
  if (!pass) return res.status(400).json({ success: false, message: 'Contraseña requerida.' });
  const cfg = psRead(PS_CONFIG, { adminPass: 'millar2024' });
  if (pass !== (cfg.adminPass || 'millar2024'))
    return res.status(401).json({ success: false, message: 'Contraseña incorrecta.' });
  res.json({ success: true });
});

router.put('/config/admin-pass', (req, res) => {
  const { pass } = req.body || {};
  if (!pass) return res.status(400).json({ success: false, message: 'Contraseña requerida.' });
  const cfg = psRead(PS_CONFIG, {});
  cfg.adminPass = pass;
  psWrite(PS_CONFIG, cfg);
  res.json({ success: true });
});

// ── TRABAJADORES ─────────────────────────────────────────────────────────────
router.get('/trabajadores', (_req, res) => {
  const workers = psRead(FILES.workers, []);
  res.json({ success: true, data: workers.map(w => ({
    ...w,
    documentosFirmadosCount: (w.documentosFirmados || []).length,
  })) });
});

router.get('/trabajadores/cedula/:cedula', (req, res) => {
  const w = psRead(FILES.workers, []).find(x => String(x.documento) === String(req.params.cedula));
  if (!w) return res.status(404).json({ success: false, message: 'No encontrado.' });
  res.json({ success: true, data: w });
});

router.get('/trabajadores/:id', (req, res) => {
  const w = psRead(FILES.workers, []).find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ success: false, message: 'Trabajador no encontrado.' });
  res.json({ success: true, data: w });
});

router.post('/trabajadores', (req, res) => {
  const workers = psRead(FILES.workers, []);
  const { nombre, documento, cargo, fechaIngreso, correo, celular, area } = req.body;
  if (workers.find(x => x.documento === documento))
    return res.status(409).json({ success: false, message: `Ya existe un trabajador con el documento ${documento}.` });
  const w = {
    id: genId('w'), nombre, documento,
    cargo: cargo||'', fechaIngreso: fechaIngreso||null,
    correo: correo||'', celular: celular||'', area: area||'',
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
  ['nombre','documento','cargo','fechaIngreso','correo','celular','area','consentimientoFirmaElectronica','inductionCompletadaEn']
    .forEach(k => { if (req.body[k] !== undefined) workers[idx][k] = req.body[k]; });
  workers[idx].updatedAt = new Date().toISOString();
  psWrite(FILES.workers, workers);
  res.json({ success: true, data: workers[idx] });
});

router.delete('/trabajadores/:id', (req, res) => {
  const workers = psRead(FILES.workers, []);
  const idx = workers.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Trabajador no encontrado.' });
  (workers[idx].documentosFirmados || []).forEach(doc => {
    const f = path.join(UPLOADS_DIR, 'signed', `${doc.id}.pdf`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  });
  workers.splice(idx, 1);
  psWrite(FILES.workers, workers);
  res.status(204).send();
});

router.post('/trabajadores/:id/documentos-firmados', (req, res) => {
  const workers = psRead(FILES.workers, []);
  const idx = workers.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Trabajador no encontrado.' });
  const { nombre, hash, sizeKb, pdfBase64 } = req.body;
  const docId = genId('doc');
  const buf = Buffer.from(pdfBase64, 'base64');
  fs.writeFileSync(path.join(UPLOADS_DIR, 'signed', `${docId}.pdf`), buf);
  const doc = { id: docId, nombre, hash, sizeKb: sizeKb ?? Math.round(buf.length/1024), firmadoEn: new Date().toISOString() };
  if (!workers[idx].documentosFirmados) workers[idx].documentosFirmados = [];
  workers[idx].documentosFirmados.push(doc);
  workers[idx].consentimientoFirmaElectronica = true;
  workers[idx].updatedAt = new Date().toISOString();
  psWrite(FILES.workers, workers);
  res.status(201).json({ success: true, data: doc });
});

router.get('/trabajadores/:id/documentos-firmados/:docId', (req, res) => {
  const w = psRead(FILES.workers, []).find(x => x.id === req.params.id);
  if (!w) return res.status(404).json({ success: false, message: 'Trabajador no encontrado.' });
  const doc = (w.documentosFirmados || []).find(d => d.id === req.params.docId);
  if (!doc) return res.status(404).json({ success: false, message: 'Documento no encontrado.' });
  const file = path.join(UPLOADS_DIR, 'signed', `${doc.id}.pdf`);
  if (!fs.existsSync(file)) return res.status(404).json({ success: false, message: 'Archivo no encontrado.' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="firmado_${doc.nombre}"`);
  res.sendFile(file);
});

// ── PLAN DE CAPACITACIÓN ─────────────────────────────────────────────────────
router.get('/capacitaciones/plan', (_req, res) =>
  res.json({ success: true, data: psRead(FILES.trainingPlan, []) }));

router.post('/capacitaciones/plan', (req, res) => {
  const items = psRead(FILES.trainingPlan, []);
  const { mes, tema, dirigidoA, horas, responsable } = req.body;
  const item = { id: genId('tp'), mes:mes||'', tema:tema||'', dirigidoA:dirigidoA||'', horas:horas||'', responsable:responsable||'' };
  items.push(item);
  psWrite(FILES.trainingPlan, items);
  res.status(201).json({ success: true, data: item });
});

router.put('/capacitaciones/plan/:id', (req, res) => {
  const items = psRead(FILES.trainingPlan, []);
  const idx = items.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false, message: 'Ítem no encontrado.' });
  ['mes','tema','dirigidoA','horas','responsable'].forEach(k => { if (req.body[k] !== undefined) items[idx][k] = req.body[k]; });
  psWrite(FILES.trainingPlan, items);
  res.json({ success: true, data: items[idx] });
});

router.delete('/capacitaciones/plan/:id', (req, res) => {
  const items = psRead(FILES.trainingPlan, []);
  const idx = items.findIndex(x => x.id === req.params.id);
  if (idx !== -1) items.splice(idx, 1);
  psWrite(FILES.trainingPlan, items);
  res.status(204).send();
});

// ── SESIONES ─────────────────────────────────────────────────────────────────
router.get('/capacitaciones/sesiones', (_req, res) => {
  const sessions = psRead(FILES.sessions, []);
  res.json({ success: true, data: sessions.map(({ asistentes, ...s }) => ({ ...s, asistentes })) });
});

router.post('/capacitaciones/sesiones', (req, res) => {
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

router.post('/capacitaciones/sesiones/:id/asistentes', (req, res) => {
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

router.patch('/capacitaciones/sesiones/:id/asistentes/:attId', (req, res) => {
  const sessions = psRead(FILES.sessions, []);
  const sIdx = sessions.findIndex(x => x.id === req.params.id);
  if (sIdx === -1) return res.status(404).json({ success: false, message: 'Sesión no encontrada.' });
  const aIdx = (sessions[sIdx].asistentes||[]).findIndex(a => a.id === req.params.attId);
  if (aIdx === -1) return res.status(404).json({ success: false, message: 'Asistente no encontrado.' });
  ['asistio','evaluado'].forEach(k => { if (req.body[k] !== undefined) sessions[sIdx].asistentes[aIdx][k] = req.body[k]; });
  psWrite(FILES.sessions, sessions);
  res.json({ success: true, data: sessions[sIdx].asistentes[aIdx] });
});

router.delete('/capacitaciones/sesiones/:id/asistentes/:attId', (req, res) => {
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
  res.json({ success: true, data: quizzes.map(({ preguntas, ...q }) => q) });
});

router.get('/evaluaciones/:id', (req, res) => {
  const q = psRead(FILES.quizzes, []).find(x => x.id === req.params.id);
  if (!q) return res.status(404).json({ success: false, message: 'Evaluación no encontrada.' });
  res.json({ success: true, data: q });
});

router.post('/evaluaciones', (req, res) => {
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

router.put('/evaluaciones/:id', (req, res) => {
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

router.delete('/evaluaciones/:id', (req, res) => {
  const quizzes = psRead(FILES.quizzes, []);
  const idx = quizzes.findIndex(x => x.id === req.params.id);
  if (idx !== -1) quizzes.splice(idx, 1);
  psWrite(FILES.quizzes, quizzes);
  res.status(204).send();
});

// ── RESULTADOS ───────────────────────────────────────────────────────────────
router.get('/resultados', (_req, res) =>
  res.json({ success: true, data: psRead(FILES.attempts, []) }));

router.post('/resultados', (req, res) => {
  const attempts = psRead(FILES.attempts, []);
  const { workerId, workerNombrePublico, quizId, quizNombre, puntaje, origen } = req.body;
  const att = {
    id: genId('res'), workerId: workerId||null, workerNombrePublico: workerNombrePublico||null,
    quizId: quizId||null, quizNombre: quizNombre||'', puntaje,
    fecha: new Date().toISOString(), origen: origen||'panel_admin',
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
  res.setHeader('Content-Disposition', `inline; filename="${tpl.nombre}"`);
  const diskFile = path.join(UPLOADS_DIR, 'templates', `${tpl.id}.pdf`);
  if (fs.existsSync(diskFile)) return res.sendFile(diskFile);
  if (tpl.pdfBase64) return res.send(Buffer.from(tpl.pdfBase64, 'base64'));
  return res.status(404).json({ success: false, message: 'Archivo no encontrado en disco ni en base de datos.' });
});

// Guarda pdfBase64 en el JSON además del disco (persiste en reinicios/redeployos)
router.post('/paquete/plantillas', (req, res) => {
  const templates = psRead(FILES.annexTemplates, []);
  const { nombre, pdfBase64 } = req.body;
  const fileKey = normalizeAnnexName(nombre);
  if (templates.find(x => x.fileKey === fileKey))
    return res.status(409).json({ success: false, message: `Ya existe una plantilla equivalente ("${nombre}").` });
  const buf = Buffer.from(pdfBase64, 'base64');
  const id = genId('tpl');
  try { fs.writeFileSync(path.join(UPLOADS_DIR, 'templates', `${id}.pdf`), buf); } catch {}
  const tpl = { id, nombre, fileKey, pdfBase64, sizeKb: Math.round(buf.length/1024), subidoEn: new Date().toISOString() };
  templates.push(tpl);
  psWrite(FILES.annexTemplates, templates);
  const { pdfBase64: _, ...publicTpl } = tpl;
  res.status(201).json({ success: true, data: publicTpl });
});

router.delete('/paquete/plantillas/:id', (req, res) => {
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

router.post('/paquete/posiciones-firma', (req, res) => {
  const pos = psRead(FILES.signaturePos, {});
  const { fileKey, pageIndex, xRatio, yRatio, widthRatio } = req.body;
  pos[fileKey] = { fileKey, pageIndex, xRatio, yRatio, widthRatio: widthRatio??0.22, updatedAt: new Date().toISOString() };
  psWrite(FILES.signaturePos, pos);
  res.json({ success: true, data: pos[fileKey] });
});

router.delete('/paquete/posiciones-firma/:fileKey', (req, res) => {
  const pos = psRead(FILES.signaturePos, {});
  delete pos[req.params.fileKey];
  psWrite(FILES.signaturePos, pos);
  res.status(204).send();
});

// ── INDUCCIÓN ─────────────────────────────────────────────────────────────────
router.get('/paquete/induccion', (_req, res) =>
  res.json({ success: true, data: psRead(FILES.induction, { titulo:'', cuerpo:'', quizId:null }) }));

router.put('/paquete/induccion', (req, res) => {
  const { titulo, cuerpo, quizId } = req.body;
  const ind = { titulo: titulo??'', cuerpo: cuerpo??'', quizId: quizId??null };
  psWrite(FILES.induction, ind);
  res.json({ success: true, data: ind });
});

module.exports = router;
