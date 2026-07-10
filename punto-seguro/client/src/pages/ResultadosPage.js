import { pageHeader, emptyState } from '../helpers/markupHelpers.js';
import { escapeHtml } from '../utils/textUtils.js';
import { formatDate } from '../utils/dateUtils.js';
import { attemptsService } from '../services/attempts.service.js';
import { sessionsService } from '../services/sessions.service.js';
import { workersService } from '../services/workers.service.js';
import { showToast } from '../helpers/toast.js';

/**
 * Página "Resultados y cobertura". Réplica de viewResultados()/attachResultadosListeners().
 *
 * Nota de simplificación: el botón "Buscar nuevas respuestas" del original
 * llamaba a syncSharedAttempts()/syncOnboardingSignedDocs(), necesarios porque
 * `window.storage` tenía datos "compartidos" separados de los "privados".
 * Con la API real (Fase 2/3) todos los intentos ya están en la misma base de
 * datos apenas se registran, así que este botón simplemente recarga la vista.
 */
export class ResultadosPage {
  async render(container) {
    this.container = container;
    const [attempts, sessions, workers] = await Promise.all([
      attemptsService.listAll(),
      sessionsService.listAll(),
      workersService.listAll(),
    ]);
    this.attempts = attempts;
    this.sessions = sessions;
    this.workers = workers;
    this._draw();
  }

  _draw() {
    this.container.innerHTML = this._html();
    this._attachListeners();
  }

  _html() {
    const atts = this.attempts.slice().sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
    const total = atts.length;
    const aprobados = atts.filter((a) => a.puntaje >= 80).length;
    const refuerzo = atts.filter((a) => a.puntaje >= 60 && a.puntaje < 80).length;
    const reprobados = atts.filter((a) => a.puntaje < 60).length;
    const avg = total ? Math.round(atts.reduce((s, a) => s + a.puntaje, 0) / total) : 0;

    const totalConvocados = this.sessions.reduce((s, ss) => s + (ss.asistentes ? ss.asistentes.length : 0), 0);
    const totalAsistieron = this.sessions.reduce(
      (s, ss) => s + (ss.asistentes ? ss.asistentes.filter((a) => a.asistio).length : 0),
      0
    );
    const coverage = totalConvocados ? Math.round((totalAsistieron / totalConvocados) * 100) : 0;

    const rows = atts
      .map((a) => {
        const worker = this.workers.find((w) => w.id === a.workerId);
        const nombre = worker ? worker.nombre : a.workerNombrePublico || 'No registrado';
        const estadoBadge =
          a.puntaje >= 80
            ? '<span class="badge badge-green">Aprobado</span>'
            : a.puntaje >= 60
            ? '<span class="badge badge-amber">Refuerzo</span>'
            : '<span class="badge badge-red">Reprobado</span>';
        const origenBadge =
          a.origen === 'enlace_ingreso'
            ? '<span class="badge badge-amber"><i class="ti ti-package"></i> Ingreso</span>'
            : a.origen === 'enlace_publico'
            ? '<span class="badge badge-grey"><i class="ti ti-link"></i> Enlace</span>'
            : '<span class="badge badge-grey"><i class="ti ti-device-desktop"></i> Presencial</span>';
        return `<tr><td>${escapeHtml(nombre)}</td><td>${escapeHtml(a.quizNombre)}</td><td>${formatDate(
          a.fecha
        )}</td><td><strong>${a.puntaje}</strong>/100</td><td>${estadoBadge}</td><td>${origenBadge}</td></tr>`;
      })
      .join('');

    return `${pageHeader(
      'Capacitación SST',
      'Resultados y cobertura',
      'Matriz consolidada de resultados lista para el COPASST y la revisión por la alta dirección.'
    )}<div class="flex-between" style="margin-bottom:16px"><span class="small-muted">Incluye respuestas de todos los canales (presencial, enlace, ingreso).</span><button class="btn btn-ghost btn-sm" id="refresh-results-btn"><i class="ti ti-refresh"></i> Buscar nuevas respuestas</button></div><div class="grid-3" style="margin-bottom:20px"><div class="stat-card"><div class="num">${coverage}%</div><div class="label">Cobertura (meta ≥ 90%)</div></div><div class="stat-card"><div class="num">${avg}</div><div class="label">Promedio evaluaciones</div></div><div class="stat-card"><div class="num">${total}</div><div class="label">Evaluaciones aplicadas</div></div></div><div class="card"><div class="card-title">Distribución</div><div class="grid-3"><div><span class="badge badge-green">Aprobado ≥ 80</span><div style="font-size:22px;font-weight:700;margin-top:8px;font-family:var(--font-display)">${aprobados}</div></div><div><span class="badge badge-amber">Refuerzo 60–79</span><div style="font-size:22px;font-weight:700;margin-top:8px;font-family:var(--font-display)">${refuerzo}</div></div><div><span class="badge badge-red">Reprobado &lt; 60</span><div style="font-size:22px;font-weight:700;margin-top:8px;font-family:var(--font-display)">${reprobados}</div></div></div></div><div class="card"><div class="card-title">Matriz de resultados</div>${
      total
        ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Trabajador</th><th>Evaluación</th><th>Fecha</th><th>Puntaje</th><th>Estado</th><th>Canal</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : emptyState('ti-chart-bar', 'Sin resultados aún', 'Cuando se apliquen evaluaciones aparecerán aquí.')
    }</div>`;
  }

  _attachListeners() {
    this.container.querySelector('#refresh-results-btn')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.setAttribute('disabled', 'true');
      btn.innerHTML = '<i class="ti ti-loader-2" style="animation:spin 1s linear infinite"></i> Buscando…';
      const before = this.attempts.length;
      await this.render(this.container);
      const added = this.attempts.length - before;
      showToast(added > 0 ? `Se encontraron ${added} respuesta(s) nueva(s).` : 'Sin respuestas nuevas por ahora.', added > 0 ? 'success' : 'default');
    });
  }
}
