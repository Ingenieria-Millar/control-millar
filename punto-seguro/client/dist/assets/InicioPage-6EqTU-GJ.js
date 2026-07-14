import{p as b}from"./markupHelpers-DBqD6TEF.js";import{w as f}from"./workers.service-qVqd78Tv.js";import{a as h}from"./attempts.service-DKEYExq5.js";import{a as k,i as w}from"./inductionContent.service-E6gofvR7.js";import"./errorNotifier-XE8to8zv.js";import"./binaryUtils-BLu2Esm7.js";class x{constructor({onNavigate:s}){this.onNavigate=s}async render(s){const[t,n,d,i]=await Promise.all([f.listAll(),h.listAll(),k.listAll(),w.get()]),l=t.length,c=d.length,o=t.filter(a=>c>0&&(a.documentosFirmadosCount||0)>=c).length,v=t.filter(a=>!!a.inductionCompletadaEn).length,u=new Set(t.map(a=>a.id)),m=n.filter(a=>u.has(a.workerId)),e={};m.forEach(a=>{(!e[a.workerId]||new Date(a.fecha)>new Date(e[a.workerId].fecha))&&(e[a.workerId]=a)});const p=Object.values(e).length,g=Object.values(e).filter(a=>a.puntaje>=80).length,r=d.length>0&&!!(i!=null&&i.quizId);s.innerHTML=`
      ${b("Panel general","Bienvenido al módulo de Inducción Integral","Controla el avance de cada trabajador en firmas, inducción y evaluación desde un solo lugar.")}
      <div class="grid-3" style="margin-bottom:12px">
        <div class="stat-card"><div class="num">${l}</div><div class="label">Trabajadores registrados</div></div>
        <div class="stat-card"><div class="num">${o}</div><div class="label">Documentos firmados completos</div></div>
        <div class="stat-card"><div class="num">${v}</div><div class="label">Inducciones completadas</div></div>
      </div>
      <div class="grid-3" style="margin-bottom:20px">
        <div class="stat-card"><div class="num">${p}</div><div class="label">Evaluaciones realizadas</div></div>
        <div class="stat-card"><div class="num">${g}</div><div class="label">Evaluaciones aprobadas ≥ 80</div></div>
        <div class="stat-card"><div class="num">${l>0?Math.round(o/l*100):0}%</div><div class="label">Cobertura de firmas</div></div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-title"><i class="ti ti-package" style="margin-right:6px;color:var(--steel)"></i>Paquete de ingreso por enlace</div>
          <p class="card-subtitle">${r?"El paquete está configurado. Genera un enlace único por trabajador con firma, inducción y evaluación en un solo flujo.":"Configura el paquete de ingreso: sube las plantillas de documentos, redacta la inducción y elige la evaluación de cierre."}</p>
          <button class="btn btn-primary btn-block" data-go="${r?"trabajadores":"paquete"}"><i class="ti ti-arrow-right"></i> ${r?"Enviar enlace a trabajador":"Configurar paquete"}</button>
        </div>
        <div class="card">
          <div class="card-title"><i class="ti ti-clipboard-check" style="margin-right:6px;color:var(--steel)"></i>Programa de capacitación</div>
          <p class="card-subtitle">Plan anual, sesiones, evaluaciones y resultados de cobertura del SG-SST.</p>
          <button class="btn btn-primary btn-block" data-go="resultados"><i class="ti ti-arrow-right"></i> Ver resultados</button>
        </div>
      </div>`,s.querySelectorAll("[data-go]").forEach(a=>{a.addEventListener("click",()=>this.onNavigate(a.dataset.go))})}}export{x as InicioPage};
