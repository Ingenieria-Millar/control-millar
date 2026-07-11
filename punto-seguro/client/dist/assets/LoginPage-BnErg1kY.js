class d{async waitForAuth(t){return this.root=t,document.title="Inducción y Reinducción Integral — Millar",new Promise(l=>{this.resolve=l,this._render()})}_render(){this.root.innerHTML=`
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
</div>`,this.root.querySelectorAll(".ili-role-btn").forEach(t=>t.addEventListener("click",()=>this._selectRole(t.dataset.role)))}_selectRole(t){this.root.querySelectorAll(".ili-role-btn").forEach(e=>e.classList.toggle("active",e.dataset.role===t));const l=this.root.querySelector("#ili-form");if(l.style.display="",t==="admin"){l.innerHTML=`
<div class="ili-field-group">
  <label class="ili-label">Contraseña</label>
  <input type="password" id="ili-pass" class="ili-input" placeholder="••••••••" autocomplete="current-password">
  <span class="ili-err" id="ili-err" style="display:none">Contraseña incorrecta</span>
  <button class="ili-btn" id="ili-submit">Ingresar →</button>
</div>`;const e=l.querySelector("#ili-pass"),a=l.querySelector("#ili-submit"),i=l.querySelector("#ili-err"),n=async()=>{const s=e.value.trim();if(s){a.disabled=!0,i.style.display="none";try{(await fetch("/punto-seguro/api/auth",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({pass:s})})).ok?this.resolve({role:"admin"}):(i.style.display="",e.value="",e.focus())}catch{i.textContent="Error de conexión.",i.style.display=""}finally{a.disabled=!1}}};a.addEventListener("click",n),e.addEventListener("keydown",s=>s.key==="Enter"&&n()),setTimeout(()=>e.focus(),80)}else{l.innerHTML=`
<div class="ili-field-group">
  <label class="ili-label">Número de cédula (CC)</label>
  <input type="text" id="ili-cedula" class="ili-input" placeholder="Ej: 12345678" inputmode="numeric">
  <span class="ili-err" id="ili-err" style="display:none"></span>
  <button class="ili-btn" id="ili-submit">Continuar →</button>
</div>`;const e=l.querySelector("#ili-cedula"),a=l.querySelector("#ili-submit"),i=l.querySelector("#ili-err"),n=async()=>{const s=e.value.trim();if(!s){i.textContent="Ingrese su número de cédula.",i.style.display="";return}a.disabled=!0,i.style.display="none";try{const o=await fetch(`/punto-seguro/api/trabajadores/cedula/${encodeURIComponent(s)}`);if(o.ok){const r=await o.json();this.resolve({role:t,cedula:s,workerId:r.data.id,trabajador:r.data})}else o.status===404?t==="vinculado"?(i.textContent="Cédula no encontrada. Contacte al administrador.",i.style.display=""):this.resolve({role:"publico",cedula:s,trabajador:null}):(i.textContent="Error al consultar. Intente de nuevo.",i.style.display="")}catch{i.textContent="Error de conexión.",i.style.display=""}finally{a.disabled=!1}};a.addEventListener("click",n),e.addEventListener("keydown",s=>s.key==="Enter"&&n()),setTimeout(()=>e.focus(),80)}}}export{d as LoginPage};
