/**
 * Formulario de registro para visitantes/público que ingresan por primera vez.
 * Campos: CC (pre-llenado), Nombre completo, Cargo, Fecha ingreso, Celular, Correo.
 */
export class RegistroPublicoPage {
  constructor(cedula) {
    this.cedula = cedula;
  }

  async waitForSubmit(root) {
    this.root = root;
    document.title = 'Registro — Inducción Integral';
    return new Promise(resolve => {
      this.resolve = resolve;
      this._render();
    });
  }

  _render() {
    const today = new Date().toISOString().split('T')[0];
    this.root.innerHTML = `
<div class="ili-login">
  <div class="ili-login-card" style="max-width:480px">
    <div class="ili-login-logo-wrap">
      <img src="/logo.png" alt="Millar" class="ili-login-logo">
    </div>
    <div class="ili-login-title">REGISTRO DE VISITANTE</div>
    <div class="ili-login-sub">Complete sus datos para iniciar el proceso de inducción</div>

    <form id="reg-form" class="reg-form" autocomplete="off">
      <div class="reg-row">
        <div class="reg-field">
          <label>Número de cédula</label>
          <input type="text" value="${this.cedula}" readonly class="ili-input" style="background:var(--paper);color:var(--ink-soft)">
        </div>
      </div>
      <div class="reg-row">
        <div class="reg-field">
          <label>Nombre completo *</label>
          <input type="text" id="rf-nombre" class="ili-input" placeholder="Ej: María García López" required>
        </div>
      </div>
      <div class="reg-row reg-row-2">
        <div class="reg-field">
          <label>Cargo *</label>
          <input type="text" id="rf-cargo" class="ili-input" placeholder="Ej: Operaria, Contratista" required>
        </div>
        <div class="reg-field">
          <label>Fecha de ingreso *</label>
          <input type="date" id="rf-fecha" class="ili-input" value="${today}" required>
        </div>
      </div>
      <div class="reg-row reg-row-2">
        <div class="reg-field">
          <label>Número de celular</label>
          <input type="tel" id="rf-celular" class="ili-input" placeholder="3001234567" inputmode="numeric">
        </div>
        <div class="reg-field">
          <label>Correo electrónico</label>
          <input type="email" id="rf-correo" class="ili-input" placeholder="correo@ejemplo.com">
        </div>
      </div>
      <span class="ili-err" id="rf-err" style="display:none"></span>
      <button type="submit" class="ili-btn" id="rf-submit" style="margin-top:8px">
        Registrar y continuar →
      </button>
    </form>
  </div>
</div>`;

    this.root.querySelector('#reg-form').addEventListener('submit', async e => {
      e.preventDefault();
      await this._submit();
    });
    setTimeout(() => this.root.querySelector('#rf-nombre')?.focus(), 80);
  }

  async _submit() {
    const nombre  = this.root.querySelector('#rf-nombre').value.trim();
    const cargo   = this.root.querySelector('#rf-cargo').value.trim();
    const fecha   = this.root.querySelector('#rf-fecha').value;
    const celular = this.root.querySelector('#rf-celular').value.trim();
    const correo  = this.root.querySelector('#rf-correo').value.trim();
    const err     = this.root.querySelector('#rf-err');
    const btn     = this.root.querySelector('#rf-submit');

    if (!nombre || !cargo || !fecha) {
      err.textContent = 'Complete los campos obligatorios (*)';
      err.style.display = '';
      return;
    }

    btn.disabled = true;
    err.style.display = 'none';
    btn.textContent = 'Registrando…';

    try {
      const r = await fetch('/punto-seguro/api/trabajadores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nombre, documento: this.cedula,
          cargo, fechaIngreso: fecha,
          celular, correo, area: 'Público',
        }),
      });
      const data = await r.json();
      if (r.ok) {
        this.resolve(data.data);
      } else {
        err.textContent = data.message || 'Error al registrar. Intente de nuevo.';
        err.style.display = '';
        btn.disabled = false;
        btn.textContent = 'Registrar y continuar →';
      }
    } catch {
      err.textContent = 'Error de conexión. Intente de nuevo.';
      err.style.display = '';
      btn.disabled = false;
      btn.textContent = 'Registrar y continuar →';
    }
  }
}
