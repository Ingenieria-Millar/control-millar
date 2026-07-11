import{p as v}from"./markupHelpers-DBqD6TEF.js";import{w as p}from"./workers.service-qVqd78Tv.js";import{a as g}from"./attempts.service-DKEYExq5.js";import{a as m,i as b}from"./inductionContent.service-E6gofvR7.js";import"./errorNotifier-XE8to8zv.js";import"./binaryUtils-BLu2Esm7.js";class P{constructor({onNavigate:e}){this.onNavigate=e}async render(e){const[s,r,o,t]=await Promise.all([p.listAll(),g.listAll(),m.listAll(),b.get()]),n=s.length,c=s.filter(a=>(a.documentosFirmadosCount||0)>=9).length,l=r.length,d=r.filter(a=>a.puntaje>=80).length,u=l?Math.round(d/l*100):0,i=o.length>0&&!!(t!=null&&t.quizId);e.innerHTML=`
      ${v("Panel general","Bienvenido a Punto Seguro","Gestiona la firma de documentos de ingreso, el paquete de inducción y el programa de capacitación en un solo lugar.")}
      <div class="grid-3" style="margin-bottom:20px">
        <div class="stat-card"><div class="num">${n}</div><div class="label">Trabajadores registrados</div></div>
        <div class="stat-card"><div class="num">${c}</div><div class="label">Con los 9 anexos firmados</div></div>
        <div class="stat-card"><div class="num">${u}%</div><div class="label">Aprobación en evaluaciones</div></div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-title"><i class="ti ti-package" style="margin-right:6px;color:var(--steel)"></i>Paquete de ingreso por enlace</div>
          <p class="card-subtitle">${i?"El paquete está configurado. Genera un enlace único por trabajador con firma, inducción y evaluación en un solo flujo.":"Configura el paquete de ingreso: sube las plantillas de documentos, redacta la inducción y elige la evaluación de cierre."}</p>
          <button class="btn btn-primary btn-block" data-go="${i?"trabajadores":"paquete"}"><i class="ti ti-arrow-right"></i> ${i?"Enviar enlace a trabajador":"Configurar paquete"}</button>
        </div>
        <div class="card">
          <div class="card-title"><i class="ti ti-clipboard-check" style="margin-right:6px;color:var(--steel)"></i>Programa de capacitación</div>
          <p class="card-subtitle">Plan anual, sesiones, evaluaciones y resultados de cobertura del SG-SST.</p>
          <button class="btn btn-primary btn-block" data-go="resultados"><i class="ti ti-arrow-right"></i> Ver resultados</button>
        </div>
      </div>`,e.querySelectorAll("[data-go]").forEach(a=>{a.addEventListener("click",()=>this.onNavigate(a.dataset.go))})}}export{P as InicioPage};
