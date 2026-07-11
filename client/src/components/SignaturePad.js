/**
 * Controlador del lienzo de captura de firma manuscrita.
 * Réplica funcional exacta de `sigPad` / `initSignaturePad` / `clearSignaturePad`
 * del archivo original, encapsulado como una clase reutilizable en vez de estado
 * global, para poder usarse tanto en el panel admin como en el flujo público
 * de onboarding (que antes duplicaba IDs de botón: `sig-confirm-btn` /
 * `onboard-sign-btn`).
 */
export class SignaturePad {
  /**
   * @param {Object} options
   * @param {string} options.canvasId - id del <canvas> de captura
   * @param {string} options.clearButtonId - id del botón "Borrar"
   * @param {string[]} options.confirmButtonIds - ids de botones que se habilitan al firmar
   * @param {string} [options.consentCheckboxId] - id del checkbox de consentimiento, si aplica
   * @param {string} [options.placeholderSelector] - selector del texto placeholder a remover/restaurar
   * @param {string} [options.wrapSelector] - selector del contenedor visual del pad
   */
  constructor(options) {
    this.options = options;
    this.canvas = null;
    this.ctx = null;
    this.drawing = false;
    this.hasStroke = false;
    this.lastX = 0;
    this.lastY = 0;
  }

  init() {
    const canvas = document.getElementById(this.options.canvasId);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#16324A';

    this.canvas = canvas;
    this.ctx = ctx;
    this.hasStroke = false;

    const pos = (e) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: (e.touches ? e.touches[0].clientX : e.clientX) - r.left,
        y: (e.touches ? e.touches[0].clientY : e.clientY) - r.top,
      };
    };
    const start = (e) => {
      e.preventDefault();
      this.drawing = true;
      const p = pos(e);
      this.lastX = p.x;
      this.lastY = p.y;
    };
    const move = (e) => {
      if (!this.drawing) return;
      e.preventDefault();
      const p = pos(e);
      ctx.beginPath();
      ctx.moveTo(this.lastX, this.lastY);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      this.lastX = p.x;
      this.lastY = p.y;
      this.hasStroke = true;
      document.getElementById(this.options.clearButtonId)?.removeAttribute('disabled');
      if (this.options.wrapSelector) document.querySelector(this.options.wrapSelector)?.classList.add('has-sig');
      if (this.options.placeholderSelector) document.querySelector(this.options.placeholderSelector)?.remove();
      this.updateConfirmButtonsState();
    };
    const end = () => {
      this.drawing = false;
    };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
  }

  clear() {
    if (!this.ctx || !this.canvas) return;
    const ratio = window.devicePixelRatio || 1;
    this.ctx.clearRect(0, 0, this.canvas.width / ratio, this.canvas.height / ratio);
    this.hasStroke = false;
    document.getElementById(this.options.clearButtonId)?.setAttribute('disabled', 'true');
    if (this.options.wrapSelector) {
      const wrap = document.querySelector(this.options.wrapSelector);
      wrap?.classList.remove('has-sig');
      if (this.options.placeholderSelector && !document.querySelector(this.options.placeholderSelector)) {
        wrap?.insertAdjacentHTML('afterbegin', '<div class="sig-pad-placeholder">Firme aquí con el dedo, mouse o lápiz óptico</div>');
      }
    }
    this.updateConfirmButtonsState();
  }

  getPngDataUrl() {
    return this.canvas.toDataURL('image/png');
  }

  updateConfirmButtonsState() {
    const consent = this.options.consentCheckboxId ? document.getElementById(this.options.consentCheckboxId) : null;
    const consentOk = !consent || consent.checked;
    (this.options.confirmButtonIds || []).forEach((id) => {
      const btn = document.getElementById(id);
      if (!btn) return;
      if (this.hasStroke && consentOk) btn.removeAttribute('disabled');
      else btn.setAttribute('disabled', 'true');
    });
  }
}
