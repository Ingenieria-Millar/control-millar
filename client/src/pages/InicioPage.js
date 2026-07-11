import { pageHeader } from '../helpers/markupHelpers.js';
import { workersService } from '../services/workers.service.js';
import { attemptsService } from '../services/attempts.service.js';
import { annexTemplatesService } from '../services/annexTemplates.service.js';
import { inductionContentService } from '../services/inductionContent.service.js';

/**
 * Página "Panel general" (Dashboard). Réplica de viewInicio() del original,
 * ahora obteniendo los datos de la API en vez de `APP.state` precargado.
 */
export class InicioPage {
  constructor({ onNavigate }) {
    this.onNavigate = onNavigate;
  }

  async render(container) {
    const [workers, attempts, annexTemplates, induction] = await Promise.all([
      workersService.listAll(),
      attemptsService.listAll(),
      annexTemplatesService.listAll(),
      inductionContentService.get(),
    ]);

    const totalWorkers = workers.length;
    const fullySigned = workers.filter((w) => (w.documentosFirmadosCount || 0) >= 9).length;
    const totalAttempts = attempts.length;
    const passed = attempts.filter((a) => a.puntaje >= 80).length;
    const passRate = totalAttempts ? Math.round((passed / totalAttempts) * 100) : 0;
    const packageReady = annexTemplates.length > 0 && !!induction?.quizId;

    container.innerHTML = `
      ${pageHeader(
        'Panel general',
        'Bienvenido a Punto Seguro',
        'Gestiona la firma de documentos de ingreso, el paquete de inducción y el programa de capacitación en un solo lugar.'
      )}
      <div class="grid-3" style="margin-bottom:20px">
        <div class="stat-card"><div class="num">${totalWorkers}</div><div class="label">Trabajadores registrados</div></div>
        <div class="stat-card"><div class="num">${fullySigned}</div><div class="label">Con los 9 anexos firmados</div></div>
        <div class="stat-card"><div class="num">${passRate}%</div><div class="label">Aprobación en evaluaciones</div></div>
      </div>
      <div class="grid-2">
        <div class="card">
          <div class="card-title"><i class="ti ti-package" style="margin-right:6px;color:var(--steel)"></i>Paquete de ingreso por enlace</div>
          <p class="card-subtitle">${
            packageReady
              ? 'El paquete está configurado. Genera un enlace único por trabajador con firma, inducción y evaluación en un solo flujo.'
              : 'Configura el paquete de ingreso: sube las plantillas de documentos, redacta la inducción y elige la evaluación de cierre.'
          }</p>
          <button class="btn btn-primary btn-block" data-go="${packageReady ? 'trabajadores' : 'paquete'}"><i class="ti ti-arrow-right"></i> ${
            packageReady ? 'Enviar enlace a trabajador' : 'Configurar paquete'
          }</button>
        </div>
        <div class="card">
          <div class="card-title"><i class="ti ti-clipboard-check" style="margin-right:6px;color:var(--steel)"></i>Programa de capacitación</div>
          <p class="card-subtitle">Plan anual, sesiones, evaluaciones y resultados de cobertura del SG-SST.</p>
          <button class="btn btn-primary btn-block" data-go="resultados"><i class="ti ti-arrow-right"></i> Ver resultados</button>
        </div>
      </div>`;

    container.querySelectorAll('[data-go]').forEach((btn) => {
      btn.addEventListener('click', () => this.onNavigate(btn.dataset.go));
    });
  }
}
