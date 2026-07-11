import { renderPublicHeader } from '../../components/PublicHeader.js';
import { escapeHtml } from '../../utils/textUtils.js';
import { showToast } from '../../helpers/toast.js';
import { quizzesService } from '../../services/quizzes.service.js';
import { attemptsService } from '../../services/attempts.service.js';
import { scoreQuizAttempt, classifyScore } from '../../services/quizScoring.js';

const SCORE_LABELS = {
  aprobado: { text: 'Aprobado', className: 'badge-green' },
  refuerzo: { text: 'Aprobado con refuerzo', className: 'badge-amber' },
  reprobado: { text: 'Reprobado', className: 'badge-red' },
};

/**
 * Página pública "Evaluación por enlace" (?evaluar=quizId). Réplica de
 * bootstrapPublic()/renderPublicQuiz()/pubQuizContent()/attachPublicQuizListeners().
 * No requiere sesión ni sidebar: reemplaza todo el <div id="root">.
 */
export class PublicQuizPage {
  constructor(quizId) {
    this.quizId = quizId;
    this.state = { step: 'identify', worker: { nombre: '', documento: '' }, answers: {}, score: null };
  }

  async render(root) {
    this.root = root;
    document.title = 'Evaluación SST — Punto Seguro';
    root.innerHTML = `<div class="public-wrap"><div class="public-card text-center"><i class="ti ti-loader-2" style="font-size:24px;color:var(--steel);animation:spin 1s linear infinite"></i></div></div>`;

    try {
      this.quiz = await quizzesService.getById(this.quizId);
    } catch {
      this.quiz = null;
    }

    if (!this.quiz) {
      root.innerHTML = `<div class="public-wrap"><div class="public-card text-center"><div style="font-size:30px;color:var(--safety-red)"><i class="ti ti-alert-circle"></i></div><div class="card-title">Evaluación no encontrada</div><p class="card-subtitle">El enlace puede haber expirado. Solicita uno nuevo.</p></div></div>`;
      return;
    }
    this._draw();
  }

  _draw() {
    this.root.innerHTML = `<div class="public-wrap">${this._content()}</div>`;
    this._attachListeners();
  }

  _content() {
    const quiz = this.quiz;
    const s = this.state;

    if (s.step === 'identify') {
      return `<div class="public-card">${renderPublicHeader()}<div class="divider"></div><div class="card-title">${escapeHtml(
        quiz.nombre
      )}</div><p class="card-subtitle">${quiz.preguntas.length} preguntas · Categoría: ${escapeHtml(
        quiz.categoria
      )}</p><form id="identify-form"><div class="field"><label>Nombre completo</label><input type="text" name="nombre" required placeholder="Ej. Juan Pérez"></div><div class="field"><label>Número de identificación</label><input type="text" name="documento" required placeholder="Ej. 1.020.345.678"></div><button type="submit" class="btn btn-primary btn-block"><i class="ti ti-arrow-right"></i> Comenzar evaluación</button></form></div>`;
    }

    if (s.step === 'in-progress') {
      const questions = quiz.preguntas
        .map(
          (p, idx) =>
            `<div class="q-card"><p style="font-weight:600;font-size:14px;margin:0 0 12px">${idx + 1}. ${escapeHtml(
              p.texto
            )}</p>${p.opciones
              .map(
                (opt, oi) =>
                  `<label style="display:flex;align-items:center;gap:10px;margin-bottom:9px;cursor:pointer;font-size:14px"><input type="radio" name="ans-${p.id}" value="${oi}" data-pub-answer="${
                    p.id
                  }" ${s.answers[p.id] === oi ? 'checked' : ''}>${escapeHtml(opt)}</label>`
              )
              .join('')}</div>`
        )
        .join('');
      const answered = Object.keys(s.answers).length;
      return `<div class="public-card">${renderPublicHeader()}<div class="divider"></div><div class="flex-between" style="margin-bottom:6px"><div class="card-title" style="margin-bottom:0">${escapeHtml(
        quiz.nombre
      )}</div><span class="small-muted">${answered}/${quiz.preguntas.length} respondidas</span></div><p class="card-subtitle">Respondiendo como ${escapeHtml(
        s.worker.nombre
      )}</p>${questions}<button type="button" class="btn btn-primary btn-block" id="pub-submit-btn"><i class="ti ti-send"></i> Enviar respuestas</button></div>`;
    }

    const label = SCORE_LABELS[classifyScore(s.score)];
    return `<div class="public-card text-center">${renderPublicHeader()}<div class="divider"></div><div style="width:56px;height:56px;border-radius:50%;background:var(--safety-green-light);color:var(--safety-green);display:flex;align-items:center;justify-content:center;font-size:26px;margin:10px auto 14px"><i class="ti ti-circle-check"></i></div><div class="card-title">Respuestas enviadas</div><p class="card-subtitle">Gracias, ${escapeHtml(
      s.worker.nombre
    )}.</p><div style="font-family:var(--font-display);font-size:44px;font-weight:700;color:var(--navy-deep);margin:14px 0 6px">${
      s.score
    }</div><p class="small-muted" style="margin-bottom:10px">de 100 puntos</p><span class="badge ${label.className}" style="font-size:13px;padding:6px 14px">${
      label.text
    }</span></div>`;
  }

  _attachListeners() {
    document.getElementById('identify-form')?.addEventListener('submit', (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      this.state.worker.nombre = fd.get('nombre').trim();
      this.state.worker.documento = fd.get('documento').trim();
      this.state.step = 'in-progress';
      this.state.answers = {};
      this._draw();
    });

    document.querySelectorAll('[data-pub-answer]').forEach((radio) =>
      radio.addEventListener('change', () => {
        this.state.answers[radio.dataset.pubAnswer] = parseInt(radio.value, 10);
      })
    );

    document.getElementById('pub-submit-btn')?.addEventListener('click', async () => {
      const quiz = this.quiz;
      const total = quiz.preguntas.length;
      const answered = Object.keys(this.state.answers).length;
      if (answered < total && !confirm(`Te faltan ${total - answered} pregunta(s). ¿Enviar?`)) return;

      const score = scoreQuizAttempt(quiz.preguntas, this.state.answers);
      this.state.score = score;
      document.getElementById('pub-submit-btn')?.setAttribute('disabled', 'true');

      try {
        await attemptsService.submit({
          workerDocumento: this.state.worker.documento,
          workerNombrePublico: this.state.worker.nombre,
          quizId: quiz.id,
          quizNombre: quiz.nombre,
          puntaje: score,
          origen: 'enlace_publico',
        });
      } catch {
        showToast('El resultado no pudo guardarse, pero puedes ver tu puntaje a continuación.', 'error');
      }

      this.state.step = 'done';
      this._draw();
    });
  }
}
