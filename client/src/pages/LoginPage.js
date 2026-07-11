/**
 * Pantalla de ingreso al módulo Inducción y Reinducción Integral.
 * Tres roles: Administrador (contraseña), Vinculado (cédula), Público (cédula).
 */
export class LoginPage {
  async waitForAuth(root) {
    this.root = root;
    document.title = 'Inducción y Reinducción Integral — Millar';
    return new Promise(resolve => {
      this.resolve = resolve;
      this._render();
    });
  }

  _render() {
    this.root.innerHTML = `
<div class="ili-login">
  <div class="ili-login-card">
    <div class="ili-login-logo-wrap">
      <img src="/logo.png" alt="Millar" class="ili-login-logo">
    </div>
    <div class="ili-login-title">INDUCCIÓN Y REINDUCCIÓN INTEGRAL</div>
    <div class="ili-login-sub">Confecciones Millar S.A.S. · SG-SST</div>

    <div class="ili-roles" id="ili-roles">
      <button class="ili-role-btn" data-role="admin">
        <span class="ili-role-icon"><i class="ti ti-shield-lock"></i></span>
        <span class="ili-role-label">Administrador</span>
      </button>
      <button class="ili-role-btn" data-role="vinculado">
        <span class="ili-role-icon"><i class="ti ti-id-badge"></i></span>
        <span class="ili-role-label">Vinculado</span>
        <span class="ili-role-hint">Empleado activo</span>
      </button>
      <button class="ili-role-btn" data-role="publico">
        <span class="ili-role-icon"><i class="ti ti-user-plus"></i></span>
        <span class="ili-role-label">Público</span>
        <span class="ili-role-hint">Visitante / Ingreso nuevo</span>
      </button>
    </div>

    <div id="ili-form" class="ili-form" style="display:none"></div>
  </div>
</div>`;

    this.root.querySelectorAll('.ili-role-btn').forEach(btn =>
      btn.addEventListener('click', () => this._selectRole(btn.dataset.role))
    );
  }

  _selectRole(role) {
    this.root.querySelectorAll('.ili-role-btn').forEach(b =>
      b.classList.toggle('active', b.dataset.role === role)
    );
    const formEl = this.root.querySelector('#ili-form');
    formEl.style.display = '';

    if (role === 'admin') {
      formEl.innerHTML = `
<div class="ili-field-group">
  <label class="ili-label">Contraseña</label>
  <input type="password" id="ili-pass" class="ili-input" placeholder="••••••••" autocomplete="current-password">
  <span class="ili-err" id="ili-err" style="display:none">Contraseña incorrecta</span>
  <button class="ili-btn" id="ili-submit">Ingresar →</button>
</div>`;

      const inp = formEl.querySelector('#ili-pass');
      const btn = formEl.querySelector('#ili-submit');
      const err = formEl.querySelector('#ili-err');

      const submit = async () => {
        const pass = inp.value.trim();
        if (!pass) return;
        btn.disabled = true; err.style.display = 'none';
        try {
          const r = await fetch('/punto-seguro/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pass }),
          });
          if (r.ok) { this.resolve({ role: 'admin' }); }
          else { err.style.display = ''; inp.value = ''; inp.focus(); }
        } catch { err.textContent = 'Error de conexión.'; err.style.display = ''; }
        finally { btn.disabled = false; }
      };

      btn.addEventListener('click', submit);
      inp.addEventListener('keydown', e => e.key === 'Enter' && submit());
      setTimeout(() => inp.focus(), 80);

    } else {
      formEl.innerHTML = `
<div class="ili-field-group">
  <label class="ili-label">Número de cédula (CC)</label>
  <input type="text" id="ili-cedula" class="ili-input" placeholder="Ej: 12345678" inputmode="numeric">
  <span class="ili-err" id="ili-err" style="display:none"></span>
  <button class="ili-btn" id="ili-submit">Continuar →</button>
</div>`;

      const inp = formEl.querySelector('#ili-cedula');
      const btn = formEl.querySelector('#ili-submit');
      const err = formEl.querySelector('#ili-err');

      const submit = async () => {
        const cedula = inp.value.trim();
        if (!cedula) { err.textContent = 'Ingrese su número de cédula.'; err.style.display = ''; return; }
        btn.disabled = true; err.style.display = 'none';
        try {
          const r = await fetch(`/punto-seguro/api/trabajadores/cedula/${encodeURIComponent(cedula)}`);
          if (r.ok) {
            const d = await r.json();
            this.resolve({ role, cedula, workerId: d.data.id, trabajador: d.data });
          } else if (r.status === 404) {
            if (role === 'vinculado') {
              err.textContent = 'Cédula no encontrada. Contacte al administrador.';
              err.style.display = '';
            } else {
              this.resolve({ role: 'publico', cedula, trabajador: null });
            }
          } else {
            err.textContent = 'Error al consultar. Intente de nuevo.';
            err.style.display = '';
          }
        } catch { err.textContent = 'Error de conexión.'; err.style.display = ''; }
        finally { btn.disabled = false; }
      };

      btn.addEventListener('click', submit);
      inp.addEventListener('keydown', e => e.key === 'Enter' && submit());
      setTimeout(() => inp.focus(), 80);
    }
  }
}
