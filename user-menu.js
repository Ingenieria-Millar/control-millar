/* ═══════════════════════════════════════════════════════════════════
   Menú de usuario compartido — Confecciones Millar
   Se incluye con <script src="/user-menu.js"></script> en cada pantalla.
   Muestra ícono + nombre con un menú:
     • Mi perfil  → editar nombre visible, correo y contraseña
     • Cerrar sesión
   Se inserta como un botón más dentro del contenedor derecho del header
   de cada pantalla (para no montarse encima de otros botones). Si la
   pantalla no tiene ninguno de los contenedores conocidos, cae de vuelta
   a flotar arriba a la derecha (comportamiento anterior).
   Aislado: no depende de funciones de la página; usa su propio token
   de sesión y su propio cierre de sesión. Se auto-oculta si no hay sesión.
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  if (window.__cmUserMenu) return;            // evitar doble carga
  window.__cmUserMenu = true;

  function ses()  { try { return JSON.parse(localStorage.getItem('cm_session') || '{}'); } catch (e) { return {}; } }
  function tok()  { return (ses().token) || ''; }
  function api(path, opts) {
    opts = opts || {};
    var h = new Headers(opts.headers || {});
    var t = tok(); if (t && !h.has('Authorization')) h.set('Authorization', 'Bearer ' + t);
    opts.headers = h;
    return fetch(path, opts);
  }
  var state = { displayName: '', email: '', loaded: false };

  // ── Estilos (prefijo cmum- para no chocar con la página) ──
  var css = document.createElement('style');
  css.textContent =
  '#cmum-wrap{position:relative;z-index:20;font-family:"Nunito",system-ui,sans-serif;}' +
  '#cmum-wrap.cmum-fixed{position:fixed;top:10px;right:14px;z-index:9000;}' +
  '#cmum-btn{display:flex;align-items:center;gap:7px;background:#fff;border:1px solid #e2e8f0;border-radius:22px;padding:6px 12px;cursor:pointer;color:#0f172a;font-size:13px;font-weight:700;box-shadow:0 2px 8px rgba(15,23,42,.10);}' +
  '#cmum-btn:hover{background:#f8fafc;border-color:#cbd5e1;}' +
  '#cmum-btn .cmum-ico{color:#2563eb;flex-shrink:0;}' +
  '#cmum-name{max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
  '#cmum-dd{display:none;position:absolute;right:0;top:calc(100% + 8px);min-width:190px;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 12px 32px rgba(15,23,42,.16);padding:6px;}' +
  '#cmum-dd.open{display:block;}' +
  '#cmum-dd button{display:flex;align-items:center;gap:10px;width:100%;background:none;border:none;text-align:left;padding:10px 12px;border-radius:8px;cursor:pointer;font-family:inherit;font-size:13.5px;font-weight:600;color:#334155;}' +
  '#cmum-dd button:hover{background:#f1f5f9;color:#0f172a;}' +
  '#cmum-dd button svg{color:#64748b;flex-shrink:0;}' +
  '#cmum-modal{display:none;position:fixed;inset:0;background:rgba(15,23,42,.5);z-index:10000;align-items:center;justify-content:center;padding:16px;font-family:"Nunito",system-ui,sans-serif;}' +
  '#cmum-modal.open{display:flex;}' +
  '#cmum-card{background:#fff;border-radius:16px;padding:26px 24px;width:100%;max-width:430px;box-shadow:0 20px 60px rgba(0,0,0,.25);box-sizing:border-box;}' +
  '#cmum-card h3{font-family:"Barlow Condensed",sans-serif;font-size:21px;font-weight:700;letter-spacing:2px;color:#0f172a;margin:0 0 4px;display:flex;align-items:center;gap:8px;text-transform:uppercase;}' +
  '#cmum-card .cmum-sub{font-size:12.5px;color:#64748b;margin:0 0 18px;}' +
  '.cmum-field{display:flex;flex-direction:column;gap:5px;margin-bottom:14px;}' +
  '.cmum-field label{font-size:11px;font-weight:700;color:#64748b;letter-spacing:1px;text-transform:uppercase;}' +
  '.cmum-field input{padding:9px 12px;border-radius:8px;border:1.5px solid #e2e8f0;font-size:13.5px;outline:none;font-family:inherit;color:#0f172a;box-sizing:border-box;width:100%;}' +
  '.cmum-field input:focus{border-color:#2563eb;}' +
  '.cmum-field input:disabled{background:#f1f5f9;color:#64748b;}' +
  '.cmum-divider{border-top:1px solid #eef2f7;margin:6px 0 14px;padding-top:12px;}' +
  '.cmum-dtitle{font-size:12px;font-weight:800;color:#334155;margin-bottom:2px;}' +
  '.cmum-hint{font-size:11.5px;color:#94a3b8;margin:0 0 12px;}' +
  '#cmum-error{color:#dc2626;font-size:12.5px;min-height:16px;margin-top:2px;}' +
  '.cmum-actions{display:flex;gap:10px;margin-top:6px;}' +
  '.cmum-actions button{flex:1;padding:11px;border-radius:9px;font-family:inherit;font-size:13.5px;font-weight:700;cursor:pointer;}' +
  '.cmum-cancel{border:1.5px solid #e2e8f0;background:#fff;color:#64748b;}' +
  '.cmum-save{border:none;background:linear-gradient(135deg,#1e3a8a,#2563eb);color:#fff;}' +
  '#cmum-toast{position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:#16a34a;color:#fff;font-family:"Nunito",system-ui,sans-serif;font-size:13.5px;font-weight:700;padding:11px 18px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.2);z-index:10001;opacity:0;transition:opacity .2s;}' +
  '#cmum-toast.show{opacity:1;}';
  document.head.appendChild(css);

  var IC_USER = '<svg class="cmum-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-6 8-6s8 2 8 6"/></svg>';
  var IC_CARET = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
  var IC_OUT = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>';

  // ── DOM ──
  var wrap = document.createElement('div');
  wrap.id = 'cmum-wrap'; wrap.style.display = 'none';
  wrap.innerHTML =
    '<button id="cmum-btn" type="button">' + IC_USER + '<span id="cmum-name"></span>' + IC_CARET + '</button>' +
    '<div id="cmum-dd">' +
      '<button id="cmum-open" type="button">' + IC_USER + ' Mi perfil</button>' +
      '<button id="cmum-logout" type="button">' + IC_OUT + ' Cerrar sesión</button>' +
    '</div>';

  var modal = document.createElement('div');
  modal.id = 'cmum-modal';
  modal.innerHTML =
    '<div id="cmum-card">' +
      '<h3>' + IC_USER + ' Mi perfil</h3>' +
      '<p class="cmum-sub">Actualiza tu información. Los cambios se guardan al instante.</p>' +
      '<div class="cmum-field"><label>Usuario</label><input id="cmum-usuario" type="text" disabled></div>' +
      '<div class="cmum-field"><label>Nombre visible</label><input id="cmum-nombre" type="text" maxlength="80" placeholder=""></div>' +
      '<div class="cmum-field"><label>Correo electrónico</label><input id="cmum-correo" type="email" maxlength="120" placeholder=""></div>' +
      '<div class="cmum-divider"><div class="cmum-dtitle">Cambiar contraseña</div><p class="cmum-hint">Déjalo en blanco si no quieres cambiarla.</p>' +
        '<div class="cmum-field"><label>Contraseña actual</label><input id="cmum-pass-act" type="password" maxlength="60" placeholder="••••••••" autocomplete="off"></div>' +
        '<div class="cmum-field"><label>Nueva contraseña</label><input id="cmum-pass-new" type="password" maxlength="60" placeholder="••••••••" autocomplete="off"></div>' +
      '</div>' +
      '<div id="cmum-error"></div>' +
      '<div class="cmum-actions"><button class="cmum-cancel" type="button" id="cmum-cancel">Cancelar</button><button class="cmum-save" type="button" id="cmum-save">Guardar</button></div>' +
    '</div>';

  function $(id) { return document.getElementById(id); }
  function toast(msg) {
    var t = $('cmum-toast');
    if (!t) { t = document.createElement('div'); t.id = 'cmum-toast'; document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 3000);
  }
  function setName(n) { var el = $('cmum-name'); if (el) el.textContent = n || ''; }
  function closeDD() { var dd = $('cmum-dd'); if (dd) dd.classList.remove('open'); }

  function refresh() {
    var s = ses();
    if (s && s.user) {
      wrap.style.display = 'block';
      setName(state.displayName || s.user);
      if (!state.loaded && s.token) {
        state.loaded = true;
        api('/api/mi-perfil').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
          if (d && d.ok) { state.displayName = d.displayName || ''; state.email = d.email || ''; setName(state.displayName || s.user); }
        }).catch(function () {});
      }
    } else {
      wrap.style.display = 'none';
    }
  }

  function abrir() {
    closeDD();
    var s = ses();
    $('cmum-error').textContent = '';
    $('cmum-pass-act').value = ''; $('cmum-pass-new').value = '';
    $('cmum-usuario').value = s.user || '';
    $('cmum-nombre').value = state.displayName || '';
    $('cmum-correo').value = state.email || '';
    if (s.token) {
      api('/api/mi-perfil').then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (d && d.ok) {
          $('cmum-usuario').value = d.user || s.user || '';
          $('cmum-nombre').value = d.displayName || '';
          $('cmum-correo').value = d.email || '';
          state.displayName = d.displayName || ''; state.email = d.email || '';
        }
      }).catch(function () {});
    }
    modal.classList.add('open');
  }
  function cerrar() { modal.classList.remove('open'); }

  function guardar() {
    var err = $('cmum-error'); err.textContent = '';
    var s = ses();
    if (!s.token) { err.textContent = 'Debes iniciar sesión con contraseña para editar tu perfil.'; return; }
    var nombre = $('cmum-nombre').value.trim();
    var correo = $('cmum-correo').value.trim();
    var pAct = $('cmum-pass-act').value;
    var pNew = $('cmum-pass-new').value;
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) { err.textContent = 'El correo no tiene un formato válido.'; return; }
    var body = { displayName: nombre, email: correo };
    if (pNew) {
      if (!pAct) { err.textContent = 'Escribe tu contraseña actual para cambiarla.'; return; }
      body.currentPass = pAct; body.newPass = pNew;
    }
    var btn = $('cmum-save'); if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
    api('/api/mi-perfil', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }).catch(function () { return { ok: r.ok, d: {} }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) { err.textContent = (res.d && res.d.error) || 'No se pudo guardar. Intenta de nuevo.'; return; }
        state.displayName = res.d.displayName || ''; state.email = res.d.email || '';
        setName(state.displayName || s.user);
        cerrar();
        toast(pNew ? '✅ Perfil y contraseña actualizados' : '✅ Perfil actualizado');
      })
      .catch(function () { err.textContent = 'Error de conexión. Intenta de nuevo.'; })
      .finally(function () { if (btn) { btn.disabled = false; btn.textContent = 'Guardar'; } });
  }

  function logout() {
    try { localStorage.removeItem('cm_session'); } catch (e) {}
    try { sessionStorage.removeItem('millar_nav_perfil'); } catch (e) {}
    window.location.href = '/';
  }

  function wire() {
    $('cmum-btn').addEventListener('click', function (e) { e.stopPropagation(); $('cmum-dd').classList.toggle('open'); });
    $('cmum-open').addEventListener('click', abrir);
    $('cmum-logout').addEventListener('click', logout);
    $('cmum-cancel').addEventListener('click', cerrar);
    $('cmum-save').addEventListener('click', guardar);
    modal.addEventListener('click', function (e) { if (e.target === modal) cerrar(); });
    document.addEventListener('click', closeDD);
  }

  // Contenedores conocidos del lado derecho del header, por pantalla.
  // Si ninguno existe, se cae de vuelta a flotar fijo (comportamiento anterior).
  var HEADER_SELECTORS = ['.hd-right', '.ia-header-right', '.ci-tb-right', '.topbar-right'];

  function mount() {
    var target = null;
    for (var i = 0; i < HEADER_SELECTORS.length; i++) {
      target = document.querySelector(HEADER_SELECTORS[i]);
      if (target) break;
    }
    if (target) {
      target.appendChild(wrap);
    } else {
      wrap.classList.add('cmum-fixed');
      document.body.appendChild(wrap);
    }
    document.body.appendChild(modal);
    wire();
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
