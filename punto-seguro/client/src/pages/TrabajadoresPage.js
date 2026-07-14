import { pageHeader, emptyState } from '../helpers/markupHelpers.js';
import { escapeHtml } from '../utils/textUtils.js';
import { formatDate, todayISO } from '../utils/dateUtils.js';
import { showToast } from '../helpers/toast.js';
import { workersService } from '../services/workers.service.js';
import { quizzesService } from '../services/quizzes.service.js';
import { annexTemplatesService } from '../services/annexTemplates.service.js';
import { signaturePositionsService } from '../services/signaturePositions.service.js';
import { inductionContentService } from '../services/inductionContent.service.js';
import { attemptsService } from '../services/attempts.service.js';
import { parseExcelFile } from '../services/excelImport.service.js';
import { importWorkersFromRows } from '../services/workersImport.service.js';
import { Modal } from '../components/Modal.js';

/**
 * Página "Trabajadores". Réplica de viewTrabajadores() + modalImportExcel() +
 * modalDocs() + modalOnboardLink() del original, con los datos vivos de la API.
 */
export class TrabajadoresPage {
  constructor({ onNavigate, onSignWorker }) {
    this.onNavigate = onNavigate;
    this.onSignWorker = onSignWorker; // navega a la página de Firma con el trabajador elegido
    this.modal = new Modal();
    this.workers = [];
  }

  async render(container) {
    this.container = container;
    [this.workers, this.attempts, this.annexTemplates] = await Promise.all([
      workersService.listAll(),
      attemptsService.listAll(),
      annexTemplatesService.listAll(),
    ]);
    container.innerHTML = this._html();
    this._attachListeners();
  }

  _html() {
    return `${pageHeader(
      'Ingreso de personal',
      'Trabajadores',
      'Registra trabajadores manualmente o importa desde Excel. Desde aquí puedes enviar el enlace de ingreso completo a cada uno.'
    )}
<div class="card">
<div class="flex-between" style="margin-bottom:16px"><div class="card-title" style="margin-bottom:0">Nuevo trabajador</div><button class="btn btn-ghost btn-sm" id="open-import-btn"><i class="ti ti-file-spreadsheet"></i> Importar desde Excel</button></div>
<form id="worker-form">
<div class="grid-2">
<div class="field"><label>Nombre completo</label><input type="text" name="nombre" placeholder="Ej. María Fernanda Gómez" required></div>
<div class="field"><label>Número de identificación</label><input type="text" name="documento" placeholder="Ej. 1.020.345.678" required></div>
<div class="field"><label>Cargo</label><input type="text" name="cargo" placeholder="Ej. Auxiliar de bodega"></div>
<div class="field"><label>Fecha de ingreso</label><input type="date" name="fechaIngreso" value="${todayISO()}"></div>
<div class="field"><label>Correo electrónico</label><input type="email" name="correo" placeholder="nombre@empresa.com"></div>
<div class="field"><label>Número de celular</label><input type="text" name="celular" placeholder="Ej. 300 123 4567"></div>
<div class="field"><label>Área / proceso</label><input type="text" name="area" placeholder="Ej. Logística"></div>
</div>
<button type="submit" class="btn btn-primary"><i class="ti ti-user-plus"></i> Registrar trabajador</button>
</form>
</div>
<div class="card">
<div class="card-title">Trabajadores registrados</div>
<p class="card-subtitle">${this.workers.length} en total</p>
${this._renderTable()}
</div>`;
  }

  _renderTable() {
    if (!this.workers.length) {
      return emptyState('ti-users', 'Sin trabajadores aún', 'Registra el primer trabajador con el formulario de arriba.');
    }
    const totalDocs = this.annexTemplates.length;

    // índice: workerId → último intento
    const lastAttempt = {};
    (this.attempts || []).forEach(a => {
      if (!lastAttempt[a.workerId] || new Date(a.fecha) > new Date(lastAttempt[a.workerId].fecha))
        lastAttempt[a.workerId] = a;
    });

    const rows = this.workers
      .slice()
      .reverse()
      .map((w) => {
        const firmados = w.documentosFirmadosCount || 0;
        const firmasBadge = totalDocs === 0
          ? '<span class="badge badge-grey">Sin plantillas</span>'
          : firmados >= totalDocs
            ? `<span class="badge badge-green"><i class="ti ti-check"></i> ${firmados}/${totalDocs}</span>`
            : firmados > 0
              ? `<span class="badge badge-amber">${firmados}/${totalDocs}</span>`
              : `<span class="badge badge-grey">0/${totalDocs}</span>`;

        const induccionBadge = w.inductionCompletadaEn
          ? '<span class="badge badge-green"><i class="ti ti-check"></i> Completada</span>'
          : '<span class="badge badge-grey">Pendiente</span>';

        const att = lastAttempt[w.id];
        const evalBadge = att
          ? att.puntaje >= 80
            ? `<span class="badge badge-green">${att.puntaje} pts</span>`
            : att.puntaje >= 60
              ? `<span class="badge badge-amber">${att.puntaje} pts</span>`
              : `<span class="badge badge-red">${att.puntaje} pts</span>`
          : '<span class="badge badge-grey">Pendiente</span>';

        return `<tr>
<td><strong>${escapeHtml(w.nombre)}</strong><br><span class="small-muted">${escapeHtml(w.documento)}</span></td>
<td>${escapeHtml(w.cargo || '—')}<br><span class="small-muted">${escapeHtml(w.area || '—')}</span></td>
<td>${firmasBadge}</td>
<td>${induccionBadge}</td>
<td>${evalBadge}</td>
<td style="white-space:nowrap">
<button class="btn btn-ghost btn-sm" data-sign-worker="${w.id}"><i class="ti ti-signature"></i> Firmar</button>
<button class="btn btn-primary btn-sm" data-onboard-link="${w.id}" style="margin-left:4px"><i class="ti ti-link"></i> Enlace</button>
${firmados ? `<button class="btn btn-ghost btn-sm" data-view-docs="${w.id}" style="margin-left:4px"><i class="ti ti-folder"></i></button>` : ''}
</td></tr>`;
      })
      .join('');
    return `<div class="table-wrap"><table class="data-table"><thead><tr><th>Trabajador</th><th>Cargo / Área</th><th>Firma</th><th>Inducción</th><th>Evaluación</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  _attachListeners() {
    const c = this.container;

    c.querySelector('#worker-form')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        await workersService.register({
          nombre: fd.get('nombre').trim(),
          documento: fd.get('documento').trim(),
          cargo: fd.get('cargo').trim(),
          fechaIngreso: fd.get('fechaIngreso'),
          correo: fd.get('correo').trim(),
          celular: fd.get('celular').trim(),
          area: fd.get('area').trim(),
        });
        await this.render(c);
      } catch {
        /* el toast de error ya lo muestra workersService */
      }
    });

    c.querySelectorAll('[data-sign-worker]').forEach((btn) =>
      btn.addEventListener('click', () => this.onSignWorker(btn.dataset.signWorker))
    );

    c.querySelectorAll('[data-onboard-link]').forEach((btn) =>
      btn.addEventListener('click', () => this._openOnboardLinkModal(btn.dataset.onboardLink))
    );

    c.querySelectorAll('[data-view-docs]').forEach((btn) =>
      btn.addEventListener('click', () => this._openDocsModal(btn.dataset.viewDocs))
    );

    c.querySelector('#open-import-btn')?.addEventListener('click', () => this._openImportModal());
  }

  async _openDocsModal(workerId) {
    const worker = await workersService.getById(workerId);
    const renderContent = () => {
      const docs = worker.documentosFirmados || [];
      const rows = docs
        .map(
          (d) =>
            `<div class="doc-row signed"><div class="doc-icon"><i class="ti ti-file-check"></i></div><div class="doc-name">${escapeHtml(
              d.nombre
            )}<br><span class="small-muted">SHA-256: ${d.hash.slice(0, 16)}…</span></div><div class="doc-meta">${formatDate(
              d.firmadoEn
            )}</div><a class="btn btn-ghost btn-sm" href="${workersService.getSignedDocumentDownloadUrl(
              worker.id,
              d.id
            )}" download><i class="ti ti-download"></i></a></div>`
        )
        .join('');
      return `<div class="modal-title">Documentos de ${escapeHtml(worker.nombre)}</div><p class="modal-sub">${
        docs.length
      } documento(s) firmado(s) electrónicamente.</p><div class="doc-list">${
        rows || '<p class="small-muted">Sin documentos firmados aún.</p>'
      }</div><button type="button" class="btn btn-ghost btn-block" id="modal-cancel" style="margin-top:18px">Cerrar</button>`;
    };
    this.modal.open({ renderContent });
  }

  async _openOnboardLinkModal(workerId) {
    const worker = await workersService.getById(workerId);
    const [annexTemplates, signaturePositions, induction, quizzes] = await Promise.all([
      annexTemplatesService.listAll(),
      signaturePositionsService.listAll(),
      inductionContentService.get(),
      quizzesService.listAll(),
    ]);
    const missingPositions = annexTemplates.filter((t) => !signaturePositions[t.fileKey]);
    const hasQuiz = !!induction?.quizId;
    const ready = annexTemplates.length > 0 && missingPositions.length === 0 && hasQuiz;

    const renderContent = () => {
      if (!ready) {
        return `<div class="modal-title">Falta completar el paquete</div><p class="modal-sub">Antes de enviar el enlace a ${escapeHtml(
          worker.nombre
        )}, completa en "Paquete de ingreso":</p><div class="doc-list">${
          annexTemplates.length === 0
            ? '<div class="doc-row"><div class="doc-icon"><i class="ti ti-alert-triangle"></i></div><div class="doc-name">No se han subido plantillas de anexos</div></div>'
            : ''
        }${
          missingPositions.length > 0
            ? `<div class="doc-row"><div class="doc-icon"><i class="ti ti-map-pin-off"></i></div><div class="doc-name">${missingPositions.length} anexo(s) sin posición de firma</div></div>`
            : ''
        }${
          !hasQuiz
            ? '<div class="doc-row"><div class="doc-icon"><i class="ti ti-clipboard-x"></i></div><div class="doc-name">No se ha seleccionado la evaluación de cierre</div></div>'
            : ''
        }</div><div class="flex-between" style="margin-top:18px"><button type="button" class="btn btn-ghost" id="modal-cancel">Cerrar</button><button type="button" class="btn btn-primary" id="go-paquete-btn">Ir al paquete de ingreso</button></div>`;
      }
      const url = `${location.origin}${location.pathname}?ingreso=${encodeURIComponent(worker.id)}`;
      const quizName = quizzes.find((q) => q.id === induction.quizId)?.nombre || '';
      const subject = encodeURIComponent('Proceso de ingreso SST');
      const body = encodeURIComponent(
        `Hola ${worker.nombre},\n\nPor favor completa tu proceso de ingreso SST (firma de documentos, inducción y evaluación):\n${url}\n\nGracias.`
      );
      const waText = encodeURIComponent(`Hola ${worker.nombre}, completa tu proceso de ingreso SST en este enlace: ${url}`);
      return `<div class="modal-title">Enlace de ingreso para ${escapeHtml(worker.nombre)}</div><p class="modal-sub">Este enlace guía al trabajador por tres pasos: firmar los ${
        annexTemplates.length
      } documento(s), leer la inducción y resolver la evaluación "<strong>${escapeHtml(
        quizName
      )}</strong>". Todo queda registrado automáticamente.</p><div class="field"><label>Enlace</label><input type="text" id="onboard-link-input" value="${escapeHtml(
        url
      )}" readonly onclick="this.select()"></div><button class="btn btn-primary btn-block" id="copy-onboard-link-btn"><i class="ti ti-copy"></i> Copiar enlace</button><div class="divider"></div><div style="display:flex;gap:8px">${
        worker.correo
          ? `<a class="btn btn-ghost" style="flex:1;justify-content:center" href="mailto:${escapeHtml(
              worker.correo
            )}?subject=${subject}&body=${body}"><i class="ti ti-mail"></i> Correo</a>`
          : ''
      } ${
        worker.celular
          ? `<a class="btn btn-ghost" style="flex:1;justify-content:center" href="https://wa.me/${escapeHtml(
              worker.celular.replace(/\D/g, '')
            )}?text=${waText}" target="_blank"><i class="ti ti-brand-whatsapp"></i> WhatsApp</a>`
          : ''
      }</div>${
        !worker.correo && !worker.celular
          ? '<p class="small-muted" style="margin-top:10px"><i class="ti ti-info-circle"></i> Agrega correo o celular al trabajador para habilitar el envío directo.</p>'
          : ''
      }<button type="button" class="btn btn-ghost btn-block" id="modal-cancel" style="margin-top:14px">Cerrar</button>`;
    };

    const attachListeners = () => {
      document.getElementById('go-paquete-btn')?.addEventListener('click', () => {
        this.modal.close();
        this.onNavigate('paquete');
      });
      document.getElementById('copy-onboard-link-btn')?.addEventListener('click', () => {
        const input = document.getElementById('onboard-link-input');
        input.select();
        navigator.clipboard?.writeText(input.value);
        showToast('Enlace copiado.', 'success');
      });
    };

    this.modal.open({ renderContent, attachListeners });
  }

  _openImportModal() {
    let parsed = null;
    const renderContent = () => {
      if (!parsed) {
        return `<div class="modal-title">Importar desde Excel</div><p class="modal-sub">Selecciona un .xlsx o .csv con columnas para nombre, documento, cargo, correo, celular y área.</p><div class="field"><label>Archivo</label><input type="file" id="import-file-input" accept=".xlsx,.xls,.csv"></div><p class="small-muted">Encabezados reconocidos: nombre, cédula, cargo, correo, celular, área.</p><div class="flex-between" style="margin-top:18px"><button type="button" class="btn btn-ghost" id="modal-cancel">Cancelar</button><button type="button" class="btn btn-primary" id="import-parse-btn" disabled>Leer archivo</button></div><div id="import-error" style="display:none;margin-top:12px;color:var(--safety-red);font-size:13px"></div>`;
      }
      const { workers, headerMap } = parsed;
      const missing = ['nombre', 'documento'].filter((f) => headerMap[f] === undefined);
      const rows = workers
        .slice(0, 50)
        .map(
          (w) =>
            `<tr><td>${escapeHtml(w.nombre) || '—'}</td><td>${escapeHtml(w.documento) || '—'}</td><td>${
              escapeHtml(w.cargo) || '—'
            }</td><td>${escapeHtml(w.correo) || '—'}</td><td>${escapeHtml(w.celular) || '—'}</td></tr>`
        )
        .join('');
      return `<div class="modal-title">Confirmar importación</div><p class="modal-sub">Se detectaron <strong>${
        workers.length
      }</strong> trabajador(es). Revisa la vista previa.</p>${
        missing.length
          ? `<div class="badge badge-amber" style="margin-bottom:14px">No se encontró columna de ${missing.join(
              ' y '
            )}. Revisa los encabezados.</div>`
          : ''
      }<div class="table-wrap" style="max-height:280px;overflow-y:auto"><table class="data-table"><thead><tr><th>Nombre</th><th>Documento</th><th>Cargo</th><th>Correo</th><th>Celular</th></tr></thead><tbody>${rows}</tbody></table></div>${
        workers.length > 50 ? '<p class="small-muted" style="margin-top:8px">Mostrando los primeros 50.</p>' : ''
      }<div class="flex-between" style="margin-top:18px"><button type="button" class="btn btn-ghost" id="modal-cancel">Cancelar</button><button type="button" class="btn btn-primary" id="import-confirm-btn" ${
        !workers.length ? 'disabled' : ''
      }>Importar ${workers.length} trabajador(es)</button></div>`;
    };

    const attachListeners = (modal) => {
      const fileInput = document.getElementById('import-file-input');
      if (fileInput) {
        fileInput.addEventListener('change', () => {
          document.getElementById('import-parse-btn')?.removeAttribute('disabled');
        });
        document.getElementById('import-parse-btn')?.addEventListener('click', async () => {
          const file = fileInput.files[0];
          if (!file) return;
          const btn = document.getElementById('import-parse-btn');
          btn.setAttribute('disabled', 'true');
          btn.textContent = 'Leyendo…';
          try {
            const result = await parseExcelFile(file);
            if (!result.workers.length) {
              const errorEl = document.getElementById('import-error');
              errorEl.style.display = 'block';
              errorEl.textContent = 'No se encontraron filas con nombre o documento.';
              btn.removeAttribute('disabled');
              btn.textContent = 'Leer archivo';
              return;
            }
            parsed = result;
            modal.rerender({ renderContent, attachListeners });
          } catch (err) {
            const errorEl = document.getElementById('import-error');
            errorEl.style.display = 'block';
            errorEl.textContent = err.message || 'No se pudo leer el archivo.';
            btn.removeAttribute('disabled');
            btn.textContent = 'Leer archivo';
          }
        });
      }
      document.getElementById('import-confirm-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('import-confirm-btn');
        btn.setAttribute('disabled', 'true');
        btn.textContent = 'Importando…';
        const { added, skippedDuplicates, skippedInvalid } = await importWorkersFromRows(parsed.workers);
        this.modal.close();
        const parts = [`${added} importado(s)`];
        if (skippedDuplicates) parts.push(`${skippedDuplicates} omitido(s) por duplicado`);
        if (skippedInvalid) parts.push(`${skippedInvalid} omitido(s) por falta de documento`);
        showToast(parts.join(', ') + '.', 'success');
        await this.render(this.container);
      });
    };

    this.modal.open({ renderContent, attachListeners });
  }
}
