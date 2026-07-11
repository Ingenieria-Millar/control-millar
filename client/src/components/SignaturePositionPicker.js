import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { escapeHtml } from '../utils/textUtils.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Selector visual de la posición de firma sobre un PDF (renderizado con pdf.js).
 * Réplica funcional del objeto `picker` + `openPositionPicker`/`renderPickerHTML`/
 * `renderPickerCanvas`/`drawPickerMarker`/`attachPickerClickzone`/`attachPickerListeners`
 * del archivo original, encapsulado en una clase para poder reutilizarse en
 * distintas páginas (paquete de ingreso, asistente de firma) sin estado global.
 *
 * Uso:
 *   const picker = new SignaturePositionPicker({ initialPosition, onSave, onCancel });
 *   await picker.open(file, fileKey);
 *   container.innerHTML = picker.renderHTML();
 *   picker.mountCanvas(); // después de insertar el HTML en el DOM
 */
export class SignaturePositionPicker {
  constructor({ initialPosition = null, onSave, onCancel } = {}) {
    this.fileKey = null;
    this.fileName = null;
    this.pdfDoc = null;
    this.numPages = 1;
    this.pageIndex = 0;
    this.marker = initialPosition ? { ...initialPosition } : null;
    this.onSave = onSave;
    this.onCancel = onCancel;
  }

  async open(file, fileKey) {
    this.fileKey = fileKey;
    this.fileName = file.name;
    this.pdfDoc = null;
    try {
      const buffer = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buffer.slice(0) }).promise;
      this.pdfDoc = pdf;
      this.numPages = pdf.numPages;
      this.pageIndex = this.marker ? Math.min(this.marker.pageIndex, pdf.numPages - 1) : pdf.numPages - 1;
      return true;
    } catch (err) {
      console.error('SignaturePositionPicker.open:', err);
      return false;
    }
  }

  renderHTML() {
    if (!this.pdfDoc) {
      return `
        <div class="page-header"><p class="page-eyebrow">Ubicar firma</p><h1 class="page-title">Cargando vista previa…</h1></div>
        <div class="card text-center" style="padding:50px"><i class="ti ti-loader-2" style="font-size:28px;color:var(--steel);animation:spin 1s linear infinite"></i></div>`;
    }
    const disablePrev = this.pageIndex <= 0;
    const disableNext = this.pageIndex >= this.numPages - 1;
    const hasMarker = !!this.marker;
    return `
      <div class="page-header" style="margin-bottom:14px">
        <p class="page-eyebrow">Firma de anexos · Ubicar firma</p>
        <h1 class="page-title">¿Dónde va la firma?</h1>
        <p class="page-desc">Haz clic en <strong>${escapeHtml(this.fileName)}</strong> para marcar exactamente dónde debe aparecer la firma. La posición se recordará para este anexo.</p>
      </div>
      <div class="card" style="margin-bottom:12px;padding:14px 18px">
        <div class="flex-between" style="flex-wrap:wrap;gap:10px">
          <div style="display:flex;gap:8px;align-items:center">
            <button class="btn btn-ghost btn-sm" id="pp-prev" ${disablePrev ? 'disabled' : ''}><i class="ti ti-chevron-left"></i> Anterior</button>
            <span class="small-muted">Página <strong>${this.pageIndex + 1}</strong> de ${this.numPages}</span>
            <button class="btn btn-ghost btn-sm" id="pp-next" ${disableNext ? 'disabled' : ''}>Siguiente <i class="ti ti-chevron-right"></i></button>
          </div>
          <div style="display:flex;gap:8px">
            <button class="btn btn-ghost" id="pp-cancel"><i class="ti ti-arrow-left"></i> Cancelar</button>
            ${hasMarker ? '<button class="btn btn-ghost btn-sm" id="pp-clear"><i class="ti ti-eraser"></i> Quitar</button>' : ''}
            <button class="btn btn-primary" id="pp-save" ${!hasMarker ? 'disabled' : ''}><i class="ti ti-map-pin"></i> Guardar posición</button>
          </div>
        </div>
        <p class="small-muted" id="pp-info" style="margin-top:10px;margin-bottom:0">${
          hasMarker
            ? `<i class="ti ti-check" style="color:var(--safety-green)"></i> Posición marcada en página ${this.marker.pageIndex + 1}. Haz clic de nuevo para moverla.`
            : '<i class="ti ti-hand-click"></i> Haz clic en el documento para marcar dónde va la firma.'
        }</p>
      </div>
      <div class="card" style="padding:0;overflow:hidden">
        <div id="pp-wrap" style="width:100%;background:#e8e6e0;position:relative;line-height:0">
          <canvas id="pp-canvas" style="display:block"></canvas>
          <div id="pp-overlay" style="position:absolute;top:0;left:0;pointer-events:none"></div>
          <div id="pp-clickzone" style="position:absolute;top:0;left:0;cursor:crosshair"></div>
        </div>
      </div>
      <p class="small-muted" style="margin-top:8px"><i class="ti ti-info-circle"></i> El recuadro naranja muestra el área de la firma. Haz clic varias veces para reposicionarlo.</p>`;
  }

  async mountCanvas() {
    const canvas = document.getElementById('pp-canvas');
    const wrap = document.getElementById('pp-wrap');
    if (!canvas || !wrap || !this.pdfDoc) return;

    const wrapWidth = wrap.getBoundingClientRect().width || wrap.offsetWidth || 800;
    const maxHeight = Math.floor(window.innerHeight * 0.7);
    const pdfPage = await this.pdfDoc.getPage(this.pageIndex + 1);
    const base = pdfPage.getViewport({ scale: 1 });
    const scale = Math.min(wrapWidth / base.width, maxHeight / base.height, 1.8);
    const viewport = pdfPage.getViewport({ scale });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = canvas.width + 'px';
    canvas.style.height = canvas.height + 'px';

    const overlay = document.getElementById('pp-overlay');
    const clickzone = document.getElementById('pp-clickzone');
    if (overlay) {
      overlay.style.width = canvas.width + 'px';
      overlay.style.height = canvas.height + 'px';
    }
    if (clickzone) {
      clickzone.style.width = canvas.width + 'px';
      clickzone.style.height = canvas.height + 'px';
    }

    await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    this.drawMarker();
    this.attachClickzone();
  }

  drawMarker() {
    const overlay = document.getElementById('pp-overlay');
    if (!overlay) return;
    overlay.innerHTML = '';
    const m = this.marker;
    if (!m || m.pageIndex !== this.pageIndex) return;
    const left = (m.xRatio * 100).toFixed(3) + '%';
    const top = (m.yRatio * 100).toFixed(3) + '%';
    const widthPct = (m.widthRatio * 100).toFixed(3) + '%';
    overlay.innerHTML = `<div style="position:absolute;left:${left};top:${top};width:${widthPct};padding-top:calc(${widthPct} * 0.42);border:2.5px dashed #B5740F;background:rgba(181,116,15,0.15);border-radius:4px;box-sizing:border-box"><div style="position:absolute;inset:0;display:flex;align-items:center;justify-content:center"><span style="font-size:11px;font-weight:700;color:#B5740F;background:#fff;padding:2px 8px;border-radius:4px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.1)"><i class="ti ti-signature"></i> Firma aquí</span></div></div>`;
  }

  attachClickzone() {
    const clickzone = document.getElementById('pp-clickzone');
    if (!clickzone) return;
    const freshClickzone = clickzone.cloneNode(true);
    clickzone.parentNode.replaceChild(freshClickzone, clickzone);
    freshClickzone.addEventListener('click', (e) => {
      const rect = freshClickzone.getBoundingClientRect();
      const xRatio = (e.clientX - rect.left) / rect.width;
      const yRatio = (e.clientY - rect.top) / rect.height;
      const widthRatio = 0.22;
      const halfWidth = widthRatio / 2;
      const halfHeight = (widthRatio * 0.42) / 2;
      this.marker = {
        pageIndex: this.pageIndex,
        xRatio: Math.max(0, Math.min(xRatio - halfWidth, 1 - widthRatio)),
        yRatio: Math.max(0, Math.min(yRatio - halfHeight, 1 - widthRatio * 0.42)),
        widthRatio,
      };
      this.drawMarker();
      document.getElementById('pp-save')?.removeAttribute('disabled');
      const info = document.getElementById('pp-info');
      if (info) {
        info.innerHTML = `<i class="ti ti-check" style="color:var(--safety-green)"></i> Posición marcada en página ${this.pageIndex + 1}. Haz clic de nuevo para moverla.`;
      }
    });
  }

  attachListeners({ onRerender }) {
    document.getElementById('pp-prev')?.addEventListener('click', () => {
      if (this.pageIndex > 0) {
        this.pageIndex--;
        onRerender();
      }
    });
    document.getElementById('pp-next')?.addEventListener('click', () => {
      if (this.pageIndex < this.numPages - 1) {
        this.pageIndex++;
        onRerender();
      }
    });
    document.getElementById('pp-cancel')?.addEventListener('click', () => this.onCancel?.());
    document.getElementById('pp-clear')?.addEventListener('click', () => {
      this.marker = null;
      this.onSave?.(null, this.fileKey, this.fileName);
    });
    document.getElementById('pp-save')?.addEventListener('click', () => {
      if (!this.marker) return;
      this.onSave?.({ ...this.marker }, this.fileKey, this.fileName);
    });
  }
}
