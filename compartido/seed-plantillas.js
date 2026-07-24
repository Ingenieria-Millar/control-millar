'use strict';
const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR       = path.join(__dirname, 'ps-data');
const UPLOADS_DIR    = path.join(__dirname, 'ps-uploads');
const PDF_DIR        = path.join(__dirname, 'pdf-plantillas');
const TEMPLATES_FILE = path.join(DATA_DIR, 'ps_annex_templates.json');

[DATA_DIR, path.join(UPLOADS_DIR, 'templates')].forEach(d => {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
});

function normalizeAnnexName(name) {
  return String(name || '')
    .toLowerCase().replace(/\.pdf$/i, '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}
function genId(prefix) {
  return `${prefix}_${Date.now()}_${uuidv4().replace(/-/g,'').slice(0,8)}`;
}

if (!fs.existsSync(PDF_DIR)) {
  console.error('ERROR: Crea la carpeta pdf-plantillas/ y pon los PDFs ahí.');
  process.exit(1);
}

let templates = [];
try { templates = JSON.parse(fs.readFileSync(TEMPLATES_FILE, 'utf8')); } catch {}

const pdfs = fs.readdirSync(PDF_DIR).filter(f => /\.pdf$/i.test(f));
if (!pdfs.length) { console.log('No hay PDFs en pdf-plantillas/'); process.exit(0); }

let added = 0, skipped = 0;

for (const fname of pdfs) {
  const fileKey = normalizeAnnexName(fname);
  if (templates.find(t => t.fileKey === fileKey)) {
    console.log(`  OMITIDO (ya existe): ${fname}`);
    skipped++;
    continue;
  }
  const buf      = fs.readFileSync(path.join(PDF_DIR, fname));
  const pdfBase64 = buf.toString('base64');
  const id       = genId('tpl');
  try { fs.writeFileSync(path.join(UPLOADS_DIR, 'templates', `${id}.pdf`), buf); } catch {}
  templates.push({
    id, nombre: fname, fileKey, pdfBase64,
    sizeKb: Math.round(buf.length / 1024),
    subidoEn: new Date().toISOString(),
  });
  console.log(`  AGREGADO: ${fname} (${Math.round(buf.length / 1024)} KB)`);
  added++;
}

fs.writeFileSync(TEMPLATES_FILE, JSON.stringify(templates), 'utf8');
console.log(`\nListo: ${added} agregado(s), ${skipped} omitido(s).`);
console.log('Próximo paso: git add ps-data/ps_annex_templates.json && git commit && git push');
