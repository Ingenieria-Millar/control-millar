import { pageHeader, emptyState } from '../helpers/markupHelpers.js';
import { escapeHtml, normalizeAnnexName, sanitizeFilename } from '../utils/textUtils.js';
import { formatDateTime } from '../utils/dateUtils.js';
import { showToast } from '../helpers/toast.js';
import { workersService } from '../services/workers.service.js';
import { signaturePositionsService } from '../services/signaturePositions.service.js';
import { signAllAnnexes } from '../services/pdfStamping.service.js';
import { SignaturePad } from '../components/SignaturePad.js';
import { SignaturePositionPicker } from '../components/SignaturePositionPicker.js';

/**
 * Página "Firma de anexos". Réplica del asistente de 3 pasos original
 * (viewFirma / renderStepUpload / renderStepSign / renderStepDone), ahora
 * persistiendo el resultado a través de workersService.addSignedDocument()
 * en vez de window.storage.
 */
export class FirmaPage {
  constructor({ preselectedWorkerId, onNavigate } = {}) {
    this.preselectedWorkerId = preselectedWorkerId || null;
    this.onNavigate = onNavigate;
    this.wizard = { step: 1, files: [], signedDocs: [], consent: false, workerSearch: '' };
    this.signaturePad = null;
    this.picker = null;
  }

  async render(container) {
    this.container = container;
    this.workers = await workersService.listAll();
    this.signaturePositions = await signaturePositionsService.listAll();

    if (this.preselectedWorkerId) {
      this.activeWorkerId = this.preselectedWorkerId;
      this.preselectedWorkerId = null;
    }
    this.activeWorker = this.activeWorkerId ? this.workers.find((w) => w.id === this.activeWorkerId) : null;

    this._draw();
  }

  _draw() {
    if (this.picker) {
      this._drawPicker();
      return;
    }
    const w = this.activeWorker;
    if (!w) {
      this.container.innerHTML = `${pageHeader('Ingreso de personal', 'Firma de anexos', 'Selecciona el trabajador que va a firmar.')}<div class="card">${
        this.workers.length ? this._renderWorkerPicker() : emptyState('ti-user-plus', 'Registra primero un trabajador', 'Ve a la sección Trabajadores.')
      }</div>`;
      this._attachPickerWorkerListeners();
      return;
    }
    this.container.innerHTML = `${pageHeader(
      'Ingreso de personal',
      'Firma de anexos',
      `Firmando para ${escapeHtml(w.nombre)} · C.C. ${escapeHtml(w.documento)}`
    )}<button class="btn btn-ghost btn-sm" id="change-worker-btn" style="margin-bottom:16px"><i class="ti ti-switch-horizontal"></i> Elegir otro trabajador</button>${this._renderStepper()}<div class="card">${
      this.wizard.step === 1 ? this._renderStepUpload() : this.wizard.step === 2 ? this._renderStepSign() : this._renderStepDone()
    }</div>`;
    this._attachWizardListeners();
    if (this.wizard.step === 2) {
      this.signaturePad = new SignaturePad({
        canvasId: 'sig-canvas',
        clearButtonId: 'sig-clear-btn',
        confirmButtonIds: ['sig-confirm-btn'],
        consentCheckboxId: 'consent-check',
        placeholderSelector: '.sig-pad-placeholder',
        wrapSelector: '.sig-pad-wrap',
      });
      setTimeout(() => this.signaturePad.init(), 30);
    }
  }

  _renderWorkerPicker() {
    const s = (this.wizard.workerSearch || '').trim().toLowerCase();
    const rows = this.workers
      .filter((w) => !s || (w.nombre || '').toLowerCase().includes(s) || (w.documento || '').toLowerCase().includes(s))
      .map(
        (w) =>
          `<div class="doc-row" style="cursor:pointer" data-pick-worker="${w.id}"><div class="doc-icon"><i class="ti ti-user"></i></div><div class="doc-name">${escapeHtml(
            w.nombre
          )}<br><span class="small-muted">${escapeHtml(w.cargo || 'Sin cargo')} · ${escapeHtml(
            w.documento || '—'
          )}</span></div><div class="doc-meta"><span class="badge badge-grey">${w.documentosFirmadosCount || 0}/9</span></div></div>`
      )
      .join('');
    return `<div class="field" style="margin-bottom:14px"><label>Buscar por nombre o documento</label><input type="text" id="worker-search-input" placeholder="Escribe para filtrar…" value="${escapeHtml(
      this.wizard.workerSearch || ''
    )}"></div><div class="doc-list">${rows || '<p class="small-muted">No se encontraron trabajadores.</p>'}</div>`;
  }

  _renderStepper() {
    const step = this.wizard.step;
    const s = (n, label) =>
      `<div class="step ${step === n ? 'active' : step > n ? 'done' : ''}"><div class="step-dot">${
        step > n ? '<i class="ti ti-check"></i>' : n
      }</div><div class="step-label">${label}</div></div>`;
    return `<div class="stepper">${s(1, 'Cargar los anexos')}<div class="step-line ${step > 1 ? 'done' : ''}"></div>${s(
      2,
      'Firmar una sola vez'
    )}<div class="step-line ${step > 2 ? 'done' : ''}"></div>${s(3, 'Documentos firmados')}</div>`;
  }

  _renderStepUpload() {
    const wz = this.wizard;
    const count = wz.files.length;
    const sinPosicion = wz.files.filter((f) => !this.signaturePositions[normalizeAnnexName(f.name)]);
    const todosOk = count > 0 && sinPosicion.length === 0;
    const rows = wz.files
      .map((f, i) => {
        const fk = normalizeAnnexName(f.name);
        const hasPos = !!this.signaturePositions[fk];
        return `<div class="doc-row"><div class="doc-icon"><i class="ti ti-file-type-pdf"></i></div><div class="doc-name">${escapeHtml(
          f.name
        )}</div><div class="doc-meta">${
          hasPos
            ? '<span class="badge badge-green annex-position-badge"><i class="ti ti-map-pin"></i> Posición definida</span>'
            : '<span class="badge badge-red annex-position-badge"><i class="ti ti-map-pin-off"></i> Sin posición — obligatorio</span>'
        }</div><button class="btn btn-ghost btn-sm" data-locate-signature="${i}"><i class="ti ti-crosshair"></i> Ubicar firma</button><button class="btn btn-ghost btn-sm" data-remove-file="${i}"><i class="ti ti-x"></i></button></div>`;
      })
      .join('');
    return `<div class="card-title">Paso 1 · Cargar los anexos en PDF y ubicar la firma</div><p class="card-subtitle">Selecciona los PDF del paquete de ingreso. Debes indicar dónde va la firma en cada uno antes de continuar.</p><div class="field"><label>Archivos PDF</label><input type="file" id="annex-input" accept="application/pdf" multiple></div>${
      count ? `<div class="doc-list" style="margin-top:14px">${rows}</div>` : ''
    }${
      count > 0 && sinPosicion.length > 0
        ? `<div style="margin-top:14px;padding:12px;background:var(--safety-amber-light);border:1px solid var(--safety-amber);border-radius:var(--radius-md);font-size:13px;color:var(--safety-amber)"><i class="ti ti-alert-triangle"></i> <strong>${
            sinPosicion.length
          } anexo(s) sin posición:</strong>${sinPosicion
            .map((f) => `<span style="display:block;padding-left:18px">• ${escapeHtml(f.name)}</span>`)
            .join('')}</div>`
        : ''
    }<div class="flex-between" style="margin-top:18px"><span class="small-muted">${count} anexo(s) cargado(s)</span><button class="btn btn-primary" id="go-step2" ${
      !todosOk ? 'disabled' : ''
    }>Continuar a la firma <i class="ti ti-arrow-right"></i></button></div>${
      count > 0 && !todosOk
        ? '<p class="small-muted" style="text-align:right;margin-top:6px">Debes ubicar la firma en todos los anexos antes de continuar.</p>'
        : ''
    }`;
  }

  _renderStepSign() {
    const wz = this.wizard;
    return `<div class="card-title">Paso 2 · Captura de la firma</div><p class="card-subtitle">El trabajador firma una sola vez. El trazo se aplicará a los ${
      wz.files.length
    } documento(s) en la posición que definiste.</p><div class="sig-pad-wrap"><div class="sig-pad-placeholder">Firme aquí con el dedo, mouse o lápiz óptico</div><canvas id="sig-canvas"></canvas></div><div class="flex-between" style="margin-top:12px"><button class="btn btn-ghost btn-sm" id="sig-clear-btn" disabled><i class="ti ti-eraser"></i> Borrar</button><span class="small-muted">Trazo único — se replicará en todos los anexos</span></div><div class="divider"></div><label style="display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--ink-soft);cursor:pointer"><input type="checkbox" id="consent-check" style="margin-top:3px;width:16px;height:16px" ${
      wz.consent ? 'checked' : ''
    }><span>Declaro mi consentimiento para firmar electrónicamente los documentos de ingreso al SG-SST, conforme al artículo 7° de la Ley 527 de 1999 y al Decreto 2364 de 2012.</span></label><div class="flex-between" style="margin-top:20px"><button class="btn btn-ghost" id="back-step1"><i class="ti ti-arrow-left"></i> Volver</button><button class="btn btn-amber" id="sig-confirm-btn" disabled><i class="ti ti-stamp"></i> Firmar los ${
      wz.files.length
    } documentos</button></div><div id="sign-progress" style="margin-top:16px;display:none"><div class="progress-bar-track"><div class="progress-bar-fill" id="sign-progress-fill" style="width:0%"></div></div><p class="small-muted" id="sign-progress-text" style="margin-top:8px"></p></div>`;
  }

  _renderStepDone() {
    const wz = this.wizard;
    const w = this.activeWorker;
    const rows = wz.signedDocs
      .map(
        (d) =>
          `<div class="doc-row signed"><div class="doc-icon"><i class="ti ti-file-check"></i></div><div class="doc-name">${escapeHtml(
            d.nombre
          )}<br><span class="small-muted">SHA-256: ${d.hash.slice(0, 16)}…</span></div><div class="doc-meta">${formatDateTime(
            d.firmadoEn
          )}</div><a class="btn btn-ghost btn-sm" href="${d.blobUrl}" download="${sanitizeFilename(d.nombre)}"><i class="ti ti-download"></i></a></div>`
      )
      .join('');
    return `<div style="text-align:center;margin-bottom:20px"><div style="width:56px;height:56px;border-radius:50%;background:var(--safety-green-light);color:var(--safety-green);display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 12px"><i class="ti ti-circle-check"></i></div><div class="card-title">Firma aplicada a ${
      wz.signedDocs.length
    } documento(s)</div><p class="card-subtitle">${escapeHtml(w.nombre)} firmó y los documentos quedaron guardados.</p></div><div class="doc-list">${rows}</div><div class="flex-between" style="margin-top:22px"><button class="btn btn-ghost" id="go-trabajadores-btn"><i class="ti ti-arrow-left"></i> Volver</button><button class="btn btn-primary" id="sign-another"><i class="ti ti-user-plus"></i> Firmar otro trabajador</button></div>`;
  }

  _attachPickerWorkerListeners() {
    const searchInput = this.container.querySelector('#worker-search-input');
    if (searchInput) {
      searchInput.addEventListener('input', (e) => {
        this.wizard.workerSearch = e.target.value;
        this.container.querySelector('.card').innerHTML = this._renderWorkerPicker();
        this._attachPickerWorkerListeners();
        const el = this.container.querySelector('#worker-search-input');
        el?.focus();
        el?.setSelectionRange(el.value.length, el.value.length);
      });
    }
    this.container.querySelectorAll('[data-pick-worker]').forEach((el) =>
      el.addEventListener('click', () => {
        this.activeWorkerId = el.dataset.pickWorker;
        this.activeWorker = this.workers.find((w) => w.id === this.activeWorkerId);
        this.wizard = { step: 1, files: [], signedDocs: [], consent: false, workerSearch: '' };
        this._draw();
      })
    );
  }

  _attachWizardListeners() {
    const c = this.container;
    const wz = this.wizard;

    c.querySelector('#change-worker-btn')?.addEventListener('click', () => {
      this.activeWorkerId = null;
      this.activeWorker = null;
      this._draw();
    });

    c.querySelector('#annex-input')?.addEventListener('change', (e) => {
      wz.files = wz.files.concat(Array.from(e.target.files));
      this._draw();
    });
    c.querySelectorAll('[data-remove-file]').forEach((btn) =>
      btn.addEventListener('click', () => {
        wz.files.splice(parseInt(btn.dataset.removeFile, 10), 1);
        this._draw();
      })
    );
    c.querySelectorAll('[data-locate-signature]').forEach((btn) =>
      btn.addEventListener('click', () => {
        const file = wz.files[parseInt(btn.dataset.locateSignature, 10)];
        this._openPositionPicker(file, normalizeAnnexName(file.name));
      })
    );

    c.querySelector('#go-step2')?.addEventListener('click', () => {
      wz.step = 2;
      this._draw();
    });
    c.querySelector('#back-step1')?.addEventListener('click', () => {
      wz.step = 1;
      this._draw();
    });

    c.querySelector('#sig-clear-btn')?.addEventListener('click', () => this.signaturePad?.clear());
    c.querySelector('#consent-check')?.addEventListener('change', (e) => {
      wz.consent = e.target.checked;
      this.signaturePad?.updateConfirmButtonsState();
    });
    c.querySelector('#sig-canvas')?.addEventListener('mouseup', () => this.signaturePad?.updateConfirmButtonsState());
    c.querySelector('#sig-canvas')?.addEventListener('touchend', () => this.signaturePad?.updateConfirmButtonsState());

    c.querySelector('#sig-confirm-btn')?.addEventListener('click', () => this._confirmSignature());

    c.querySelector('#go-trabajadores-btn')?.addEventListener('click', () => this.onNavigate?.('trabajadores'));
    c.querySelector('#sign-another')?.addEventListener('click', () => {
      this.activeWorkerId = null;
      this.activeWorker = null;
      this._draw();
    });
  }

  async _confirmSignature() {
    const wz = this.wizard;
    if (!this.signaturePad?.hasStroke) {
      showToast('Capture una firma antes de continuar.', 'error');
      return;
    }
    if (!wz.consent) {
      showToast('Debe aceptar el consentimiento de firma.', 'error');
      return;
    }
    const worker = this.activeWorker;
    const sig = this.signaturePad.getPngDataUrl();
    const progressWrap = document.getElementById('sign-progress');
    const progressFill = document.getElementById('sign-progress-fill');
    const progressText = document.getElementById('sign-progress-text');
    progressWrap.style.display = 'block';
    document.getElementById('sig-confirm-btn')?.setAttribute('disabled', 'true');

    try {
      const docs = await signAllAnnexes(worker, wz.files, sig, this.signaturePositions, (i, total, name) => {
        progressFill.style.width = Math.round((i / total) * 100) + '%';
        progressText.textContent = `Estampando firma en "${name}" (${i + 1}/${total})`;
      });
      progressFill.style.width = '100%';
      progressText.textContent = 'Guardando…';

      const persistedDocs = [];
      for (const doc of docs) {
        const persisted = await workersService.addSignedDocument(worker.id, {
          nombre: doc.nombre,
          hash: doc.hash,
          sizeKb: doc.sizeKb,
          pdfBase64: doc.pdfBase64,
        });
        persistedDocs.push({ ...persisted, blobUrl: doc.blobUrl });
      }
      wz.signedDocs = persistedDocs;
      wz.step = 3;
      showToast(`Firma aplicada y guardada en ${docs.length} documento(s).`, 'success');
      this._draw();
    } catch (err) {
      console.error(err);
      document.getElementById('sig-confirm-btn')?.removeAttribute('disabled');
      if (err.message?.startsWith('POSICION_FALTANTE:')) {
        showToast('Falta posición de firma en: ' + err.message.replace('POSICION_FALTANTE:', ''), 'error');
        wz.step = 1;
        this._draw();
      } else {
        showToast('Error al estampar la firma. Verifica que los archivos sean PDF válidos.', 'error');
      }
    }
  }

  _openPositionPicker(file, fileKey) {
    this.picker = new SignaturePositionPicker({
      initialPosition: this.signaturePositions[fileKey] || null,
      onSave: async (position) => {
        if (position) {
          await signaturePositionsService.save({ fileKey, ...position });
          this.signaturePositions[fileKey] = position;
        } else {
          await signaturePositionsService.remove(fileKey);
          delete this.signaturePositions[fileKey];
        }
        this.picker = null;
        this._draw();
      },
      onCancel: () => {
        this.picker = null;
        this._draw();
      },
    });
    this.picker.open(file, fileKey).then((ok) => {
      if (!ok) {
        this.picker = null;
        showToast('No se pudo abrir el PDF. Verifica que sea un archivo válido.', 'error');
        this._draw();
        return;
      }
      this._drawPicker();
    });
  }

  _drawPicker() {
    this.container.innerHTML = this.picker.renderHTML();
    this.picker.attachListeners({ onRerender: () => this._drawPicker() });
    if (this.picker.pdfDoc) {
      requestAnimationFrame(() => setTimeout(() => this.picker.mountCanvas(), 60));
    }
  }
}
