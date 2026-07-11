class d{constructor(t){this.cedula=t}async waitForSubmit(t){return this.root=t,document.title="Registro — Inducción Integral",new Promise(e=>{this.resolve=e,this._render()})}_render(){const t=new Date().toISOString().split("T")[0];this.root.innerHTML=`
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
          <input type="date" id="rf-fecha" class="ili-input" value="${t}" required>
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
</div>`,this.root.querySelector("#reg-form").addEventListener("submit",async e=>{e.preventDefault(),await this._submit()}),setTimeout(()=>{var e;return(e=this.root.querySelector("#rf-nombre"))==null?void 0:e.focus()},80)}async _submit(){const t=this.root.querySelector("#rf-nombre").value.trim(),e=this.root.querySelector("#rf-cargo").value.trim(),o=this.root.querySelector("#rf-fecha").value,s=this.root.querySelector("#rf-celular").value.trim(),n=this.root.querySelector("#rf-correo").value.trim(),r=this.root.querySelector("#rf-err"),i=this.root.querySelector("#rf-submit");if(!t||!e||!o){r.textContent="Complete los campos obligatorios (*)",r.style.display="";return}i.disabled=!0,r.style.display="none",i.textContent="Registrando…";try{const l=await fetch("/punto-seguro/api/trabajadores",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({nombre:t,documento:this.cedula,cargo:e,fechaIngreso:o,celular:s,correo:n,area:"Público"})}),a=await l.json();l.ok?this.resolve(a.data):(r.textContent=a.message||"Error al registrar. Intente de nuevo.",r.style.display="",i.disabled=!1,i.textContent="Registrar y continuar →")}catch{r.textContent="Error de conexión. Intente de nuevo.",r.style.display="",i.disabled=!1,i.textContent="Registrar y continuar →"}}}export{d as RegistroPublicoPage};
