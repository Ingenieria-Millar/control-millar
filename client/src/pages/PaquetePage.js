import { pageHeader, emptyState } from '../helpers/markupHelpers.js';
import { escapeHtml } from '../utils/textUtils.js';
import { showToast } from '../helpers/toast.js';
import { annexTemplatesService } from '../services/annexTemplates.service.js';
import { signaturePositionsService } from '../services/signaturePositions.service.js';
import { inductionContentService } from '../services/inductionContent.service.js';
import { quizzesService } from '../services/quizzes.service.js';
import { SignaturePositionPicker } from '../components/SignaturePositionPicker.js';

/**
 * Página "Paquete de ingreso". Réplica de viewPaquete()/attachPaqueteListeners()
 * del original. Las plantillas se suben directamente al servidor (Fase 2),
 * ya no como base64 en window.storage.
 */
export class PaquetePage {
  constructor({ onNavigate } = {}) {
    this.onNavigate = onNavigate;
  }

  async render(container) {
    this.container = container;
    this.annexTemplates = await annexTemplatesService.listAll();
    this.signaturePositions = await signaturePositionsService.listAll();
    this.induction = (await inductionContentService.get()) || { titulo: '', cuerpo: '', quizId: '' };
    this.quizzes = await quizzesService.listAll();
    this.picker = null;
    this._draw();
  }

  _draw() {
    if (this.picker) {
      this._drawPicker();
      return;
    }
    this.container.innerHTML = this._html();
    this._attachListeners();
  }

  _html() {
    const tpls = this.annexTemplates;
    const ic = this.induction;
    const tplRows = tpls
      .map((t) => {
        const hasPos = !!this.signaturePositions[t.fileKey];
        return `<div class="doc-row"><div class="doc-icon"><i class="ti ti-file-type-pdf"></i></div><div class="doc-name">${escapeHtml(
          t.nombre
        )}</div><div class="doc-meta">${
          hasPos
            ? '<span class="badge badge-green annex-position-badge"><i class="ti ti-map-pin"></i> Posición definida</span>'
            : '<span class="badge badge-red annex-position-badge"><i class="ti ti-map-pin-off"></i> Sin posición</span>'
        }</div><button class="btn btn-ghost btn-sm" data-locate-template="${t.id}"><i class="ti ti-crosshair"></i> Ubicar firma</button><button class="btn btn-ghost btn-sm" data-remove-template="${t.id}"><i class="ti ti-trash"></i></button></div>`;
      })
      .join('');
    const allPosOk = tpls.length > 0 && tpls.every((t) => !!this.signaturePositions[t.fileKey]);
    const hasQuiz = !!ic.quizId;
    const ready = allPosOk && hasQuiz;

    return `${pageHeader(
      'Ingreso de personal',
      'Paquete de ingreso',
      'Configura una sola vez los documentos plantilla, el contenido de la inducción y la evaluación de cierre. Luego envía el enlace único a cada trabajador.'
    )}
<div class="card">
<div class="flex-between" style="margin-bottom:14px"><div><div class="card-title" style="margin-bottom:2px">1. Anexos del paquete</div><p class="card-subtitle" style="margin-bottom:0">Sube los PDF plantilla (sin firmar) y ubica dónde debe ir la firma en cada uno.</p></div>${
      ready
        ? '<span class="badge badge-green"><i class="ti ti-circle-check"></i> Paquete listo para enviar</span>'
        : '<span class="badge badge-amber"><i class="ti ti-alert-triangle"></i> Pendiente de completar</span>'
    }</div>
<div class="field"><label>Agregar plantillas PDF</label><input type="file" id="template-input" accept="application/pdf" multiple></div>
${tpls.length ? `<div class="doc-list">${tplRows}</div>` : emptyState('ti-files', 'Sin plantillas aún', 'Sube los PDF del paquete de ingreso.')}
</div>
<div class="card">
<div class="card-title">2. Contenido de la inducción</div>
<p class="card-subtitle">Este texto se muestra al trabajador dentro del enlace, antes de la evaluación.</p>
<div class="field"><label>Título</label><input type="text" id="induction-title" value="${escapeHtml(ic.titulo)}"></div>
<div class="field"><label>Contenido</label><textarea id="induction-body" rows="10" style="font-family:inherit">${escapeHtml(ic.cuerpo)}</textarea></div>
<button class="btn btn-ghost" id="save-induction-btn"><i class="ti ti-device-floppy"></i> Guardar contenido</button>
</div>
<div class="card">
<div class="card-title">3. Evaluación de cierre</div>
<p class="card-subtitle">Selecciona cuál evaluación resuelve el trabajador al final del enlace de ingreso.</p>
<div class="field"><label>Evaluación</label><select id="induction-quiz-select"><option value="">— Selecciona una evaluación —</option>${this.quizzes
      .map((q) => `<option value="${q.id}" ${ic.quizId === q.id ? 'selected' : ''}>${escapeHtml(q.nombre)}</option>`)
      .join('')}</select></div>
${!this.quizzes.length ? '<p class="small-muted"><i class="ti ti-alert-triangle"></i> Primero crea una evaluación en la sección Evaluaciones.</p>' : ''}
</div>
<div class="card" style="background:var(--steel-light);border-color:var(--steel)">
<div class="card-title"><i class="ti ti-link" style="margin-right:6px;color:var(--steel)"></i>Enviar el enlace de ingreso</div>
<p class="card-subtitle">Una vez listo el paquete, ve a la sección Trabajadores y usa el botón "Enviar enlace" en cada trabajador para generar su enlace único de firma + inducción + evaluación.</p>
<button class="btn btn-primary" id="go-trabajadores-link-btn"><i class="ti ti-users"></i> Ir a Trabajadores</button>
</div>`;
  }

  _attachListeners() {
    const c = this.container;

    c.querySelector('#template-input')?.addEventListener('change', async (e) => {
      const files = Array.from(e.target.files);
      if (!files.length) return;
      showToast(`Subiendo ${files.length} plantilla(s)…`, 'default');
      for (const file of files) {
        try {
          await annexTemplatesService.upload(file);
        } catch {
          /* el toast de error ya lo muestra annexTemplatesService */
        }
      }
      showToast('Plantillas guardadas.', 'success');
      await this.render(c);
    });

    c.querySelectorAll('[data-locate-template]').forEach((btn) =>
      btn.addEventListener('click', () => this._locateTemplate(btn.dataset.locateTemplate))
    );
    c.querySelectorAll('[data-remove-template]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        await annexTemplatesService.remove(btn.dataset.removeTemplate);
        await this.render(c);
      })
    );

    c.querySelector('#save-induction-btn')?.addEventListener('click', async () => {
      this.induction.titulo = document.getElementById('induction-title').value.trim();
      this.induction.cuerpo = document.getElementById('induction-body').value;
      await inductionContentService.update(this.induction);
      showToast('Contenido de inducción guardado.', 'success');
    });

    c.querySelector('#induction-quiz-select')?.addEventListener('change', async (e) => {
      this.induction.quizId = e.target.value;
      await inductionContentService.update(this.induction);
      showToast('Evaluación de cierre actualizada.', 'success');
    });

    c.querySelector('#go-trabajadores-link-btn')?.addEventListener('click', () => this.onNavigate?.('trabajadores'));
  }

  async _locateTemplate(templateId) {
    const template = this.annexTemplates.find((t) => t.id === templateId);
    if (!template) return;
    const url = annexTemplatesService.getDownloadUrl(templateId);
    let blob;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      blob = await response.blob();
    } catch (err) {
      showToast('No se pudo descargar el PDF. Intente subirlo de nuevo.', 'error');
      return;
    }
    const file = new File([blob], template.nombre, { type: 'application/pdf' });

    this.picker = new SignaturePositionPicker({
      initialPosition: this.signaturePositions[template.fileKey] || null,
      onSave: async (position) => {
        if (position) {
          await signaturePositionsService.save({ fileKey: template.fileKey, ...position });
          this.signaturePositions[template.fileKey] = position;
        } else {
          await signaturePositionsService.remove(template.fileKey);
          delete this.signaturePositions[template.fileKey];
        }
        this.picker = null;
        this._draw();
      },
      onCancel: () => {
        this.picker = null;
        this._draw();
      },
    });
    const ok = await this.picker.open(file, template.fileKey);
    if (!ok) {
      this.picker = null;
      showToast('No se pudo abrir el PDF. Verifica que sea un archivo válido.', 'error');
      this._draw();
      return;
    }
    this._drawPicker();
  }

  _drawPicker() {
    this.container.innerHTML = this.picker.renderHTML();
    this.picker.attachListeners({ onRerender: () => this._drawPicker() });
    if (this.picker.pdfDoc) {
      requestAnimationFrame(() => setTimeout(() => this.picker.mountCanvas(), 60));
    }
  }
}
