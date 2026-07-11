import { pageHeader } from '../helpers/markupHelpers.js';
import { escapeHtml } from '../utils/textUtils.js';
import { showToast } from '../helpers/toast.js';
import { quizzesService } from '../services/quizzes.service.js';
import { workersService } from '../services/workers.service.js';
import { attemptsService } from '../services/attempts.service.js';
import { scoreQuizAttempt } from '../services/quizScoring.js';
import { uid } from '../utils/idUtils.js';
import { Modal } from '../components/Modal.js';

/**
 * Página "Evaluaciones". Réplica de viewEvaluaciones() + modalEditQuiz() +
 * modalApplyQuiz() + modalShareLink() del original.
 */
export class EvaluacionesPage {
  constructor({ onNavigate } = {}) {
    this.onNavigate = onNavigate;
    this.modal = new Modal();
  }

  async render(container) {
    this.container = container;
    this.quizzes = await quizzesService.listAll();
    this._draw();
  }

  _draw() {
    this.container.innerHTML = this._html();
    this._attachListeners();
  }

  _html() {
    return `${pageHeader(
      'Capacitación SST',
      'Evaluaciones de conocimiento',
      'Banco de evaluaciones. Calificado sobre 100 pts: aprobado ≥ 80, refuerzo 60–79, reprobado < 60.'
    )}<div class="flex-between" style="margin-bottom:16px"><span class="small-muted">${
      this.quizzes.length
    } evaluación(es)</span><button class="btn btn-primary" id="new-quiz-btn"><i class="ti ti-plus"></i> Nueva evaluación</button></div><div class="grid-2">${this.quizzes
      .map(
        (qz) =>
          `<div class="card"><div class="flex-between"><div><div class="card-title" style="margin-bottom:2px">${escapeHtml(
            qz.nombre
          )}</div><span class="badge badge-grey">${escapeHtml(qz.categoria)}</span></div></div><p class="card-subtitle">${
            qz.preguntas.length
          } preguntas</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn btn-amber btn-sm" data-apply-quiz="${
            qz.id
          }"><i class="ti ti-clipboard-check"></i> Aplicar aquí</button><button class="btn btn-primary btn-sm" data-share-quiz="${
            qz.id
          }"><i class="ti ti-link"></i> Enviar enlace</button><button class="btn btn-ghost btn-sm" data-edit-quiz="${
            qz.id
          }"><i class="ti ti-edit"></i> Editar</button><button class="btn btn-ghost btn-sm" data-delete-quiz="${
            qz.id
          }"><i class="ti ti-trash"></i></button></div></div>`
      )
      .join('')}</div>`;
  }

  _attachListeners() {
    const c = this.container;
    c.querySelector('#new-quiz-btn')?.addEventListener('click', () => this._openEditModal(null));
    c.querySelectorAll('[data-apply-quiz]').forEach((btn) =>
      btn.addEventListener('click', () => this._openApplyModal(this.quizzes.find((q) => q.id === btn.dataset.applyQuiz)))
    );
    c.querySelectorAll('[data-share-quiz]').forEach((btn) =>
      btn.addEventListener('click', () => this._openShareModal(this.quizzes.find((q) => q.id === btn.dataset.shareQuiz)))
    );
    c.querySelectorAll('[data-edit-quiz]').forEach((btn) =>
      btn.addEventListener('click', () =>
        this._openEditModal(JSON.parse(JSON.stringify(this.quizzes.find((q) => q.id === btn.dataset.editQuiz))))
      )
    );
    c.querySelectorAll('[data-delete-quiz]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        await quizzesService.remove(btn.dataset.deleteQuiz);
        await this.render(c);
      })
    );
  }

  // ── Modal: crear/editar evaluación ──
  _openEditModal(existingQuiz) {
    const quiz = existingQuiz || { id: null, nombre: '', categoria: 'Inducción', preguntas: [] };

    const renderContent = () => {
      const questionCards = quiz.preguntas
        .map(
          (p, idx) =>
            `<div class="q-card" data-question-id="${p.id}"><div class="flex-between" style="margin-bottom:10px"><span class="small-muted">Pregunta ${
              idx + 1
            }</span><button type="button" class="btn btn-ghost btn-sm" data-remove-question="${
              p.id
            }"><i class="ti ti-trash"></i></button></div><div class="field" style="margin-bottom:10px"><input type="text" value="${escapeHtml(
              p.texto
            )}" data-question-text="${p.id}" placeholder="Texto de la pregunta"></div>${p.opciones
              .map(
                (opt, oi) =>
                  `<div class="q-opt-row"><input type="radio" name="correct-${p.id}" ${
                    p.correctaIdx === oi ? 'checked' : ''
                  } data-correct-radio="${p.id}|${oi}"><input type="text" value="${escapeHtml(
                    opt
                  )}" data-opt-text="${p.id}|${oi}" placeholder="Opción ${oi + 1}">${
                    p.opciones.length > 2
                      ? `<button type="button" class="btn btn-ghost btn-sm" data-remove-opt="${p.id}|${oi}"><i class="ti ti-x"></i></button>`
                      : ''
                  }</div>`
              )
              .join('')}<button type="button" class="btn btn-ghost btn-sm" data-add-opt="${p.id}"><i class="ti ti-plus"></i> Agregar opción</button></div>`
        )
        .join('');
      return `<div class="modal-title">${quiz.nombre ? 'Editar' : 'Nueva'} evaluación</div><div class="field"><label>Nombre</label><input type="text" id="quiz-name" value="${escapeHtml(
        quiz.nombre
      )}" placeholder="Ej. Evaluación de inducción en SST"></div><div class="field"><label>Categoría</label><input type="text" id="quiz-category" value="${escapeHtml(
        quiz.categoria
      )}" placeholder="Ej. Inducción"></div><div class="divider"></div><div id="questions-container">${questionCards}</div><button class="btn btn-ghost btn-sm" id="add-question-btn"><i class="ti ti-plus"></i> Agregar pregunta</button><div class="flex-between" style="margin-top:20px"><button type="button" class="btn btn-ghost" id="modal-cancel">Cancelar</button><button type="button" class="btn btn-primary" id="save-quiz-btn">Guardar evaluación</button></div>`;
    };

    const attachListeners = (modal) => {
      const rerender = () => modal.rerender({ renderContent, attachListeners });

      document.getElementById('add-question-btn')?.addEventListener('click', () => {
        quiz.preguntas.push({ id: uid('preg'), texto: '', opciones: ['', ''], correctaIdx: 0 });
        rerender();
      });
      document.querySelectorAll('[data-remove-question]').forEach((btn) =>
        btn.addEventListener('click', () => {
          quiz.preguntas = quiz.preguntas.filter((p) => p.id !== btn.dataset.removeQuestion);
          rerender();
        })
      );
      document.querySelectorAll('[data-question-text]').forEach((input) =>
        input.addEventListener('input', () => {
          const p = quiz.preguntas.find((p) => p.id === input.dataset.questionText);
          if (p) p.texto = input.value;
        })
      );
      document.querySelectorAll('[data-opt-text]').forEach((input) =>
        input.addEventListener('input', () => {
          const [pid, oi] = input.dataset.optText.split('|');
          const p = quiz.preguntas.find((p) => p.id === pid);
          if (p) p.opciones[parseInt(oi, 10)] = input.value;
        })
      );
      document.querySelectorAll('[data-correct-radio]').forEach((radio) =>
        radio.addEventListener('change', () => {
          const [pid, oi] = radio.dataset.correctRadio.split('|');
          const p = quiz.preguntas.find((p) => p.id === pid);
          if (p) p.correctaIdx = parseInt(oi, 10);
        })
      );
      document.querySelectorAll('[data-add-opt]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const p = quiz.preguntas.find((p) => p.id === btn.dataset.addOpt);
          p.opciones.push('');
          rerender();
        })
      );
      document.querySelectorAll('[data-remove-opt]').forEach((btn) =>
        btn.addEventListener('click', () => {
          const [pid, oi] = btn.dataset.removeOpt.split('|');
          const p = quiz.preguntas.find((p) => p.id === pid);
          p.opciones.splice(parseInt(oi, 10), 1);
          if (p.correctaIdx >= p.opciones.length) p.correctaIdx = 0;
          rerender();
        })
      );
      document.getElementById('save-quiz-btn')?.addEventListener('click', async () => {
        const name = document.getElementById('quiz-name').value.trim();
        const category = document.getElementById('quiz-category').value.trim();
        if (!name) {
          showToast('Indica un nombre.', 'error');
          return;
        }
        if (!quiz.preguntas.length) {
          showToast('Agrega al menos una pregunta.', 'error');
          return;
        }
        quiz.nombre = name;
        quiz.categoria = category || 'General';
        await quizzesService.save(quiz);
        this.modal.close();
        showToast('Evaluación guardada.', 'success');
        await this.render(this.container);
      });
    };

    this.modal.open({ renderContent, attachListeners });
  }

  // ── Modal: aplicar evaluación presencialmente ──
  async _openApplyModal(quiz) {
    const workers = await workersService.listAll();
    const state = { step: 'pick-worker', workerId: null, answers: {}, score: null };

    const renderContent = () => {
      if (state.step === 'pick-worker') {
        const opts = workers.map((w) => `<option value="${w.id}">${escapeHtml(w.nombre)}</option>`).join('');
        return `<div class="modal-title">Aplicar "${escapeHtml(quiz.nombre)}"</div><p class="modal-sub">Selecciona el trabajador.</p><div class="field"><label>Trabajador</label><select id="quiz-worker-select">${
          opts || '<option value="">Sin trabajadores registrados</option>'
        }</select></div><div class="flex-between" style="margin-top:18px"><button type="button" class="btn btn-ghost" id="modal-cancel">Cancelar</button><button type="button" class="btn btn-primary" id="start-quiz-btn" ${
          !workers.length ? 'disabled' : ''
        }>Comenzar</button></div>`;
      }
      if (state.step === 'in-progress') {
        const questions = quiz.preguntas
          .map(
            (p, idx) =>
              `<div class="q-card"><p style="font-weight:600;font-size:13.5px;margin:0 0 10px">${idx + 1}. ${escapeHtml(
                p.texto
              )}</p>${p.opciones
                .map(
                  (opt, oi) =>
                    `<label style="display:flex;align-items:center;gap:10px;margin-bottom:8px;cursor:pointer;font-size:13.5px"><input type="radio" name="ans-${p.id}" value="${oi}" data-answer="${
                      p.id
                    }" ${state.answers[p.id] === oi ? 'checked' : ''}>${escapeHtml(opt)}</label>`
                )
                .join('')}</div>`
          )
          .join('');
        return `<div class="modal-title">${escapeHtml(quiz.nombre)}</div><p class="modal-sub">Responde y califica la evaluación.</p>${questions}<div class="flex-between" style="margin-top:18px"><button type="button" class="btn btn-ghost" id="modal-cancel">Cancelar</button><button type="button" class="btn btn-primary" id="submit-quiz-btn">Calificar</button></div>`;
      }
      // step === 'result'
      const badge = state.score >= 80 ? { t: 'Aprobado', c: 'badge-green' } : state.score >= 60 ? { t: 'Aprobado con refuerzo', c: 'badge-amber' } : { t: 'Reprobado', c: 'badge-red' };
      return `<div class="modal-title">Resultado</div><div style="text-align:center;padding:10px 0 20px"><div style="font-family:var(--font-display);font-size:48px;font-weight:700;color:var(--navy-deep)">${state.score}</div><div class="small-muted" style="margin-bottom:10px">de 100 puntos</div><span class="badge ${badge.c}" style="font-size:13px;padding:6px 14px">${badge.t}</span></div><button type="button" class="btn btn-primary btn-block" id="modal-cancel">Cerrar</button>`;
    };

    const attachListeners = (modal) => {
      if (state.step === 'pick-worker') {
        document.getElementById('start-quiz-btn')?.addEventListener('click', () => {
          state.workerId = document.getElementById('quiz-worker-select').value;
          state.step = 'in-progress';
          state.answers = {};
          modal.rerender({ renderContent, attachListeners });
        });
      }
      if (state.step === 'in-progress') {
        document.querySelectorAll('[data-answer]').forEach((radio) =>
          radio.addEventListener('change', () => {
            state.answers[radio.dataset.answer] = parseInt(radio.value, 10);
          })
        );
        document.getElementById('submit-quiz-btn')?.addEventListener('click', async () => {
          state.score = scoreQuizAttempt(quiz.preguntas, state.answers);
          await attemptsService.submit({
            workerId: state.workerId,
            quizId: quiz.id,
            quizNombre: quiz.nombre,
            puntaje: state.score,
            origen: 'panel_admin',
          });
          state.step = 'result';
          modal.rerender({ renderContent, attachListeners });
        });
      }
    };

    this.modal.open({ renderContent, attachListeners });
  }

  // ── Modal: enviar evaluación por enlace ──
  async _openShareModal(quiz) {
    const workers = await workersService.listAll();
    const renderContent = () => {
      const url = `${location.origin}${location.pathname}?evaluar=${encodeURIComponent(quiz.id)}`;
      const workersWithContact = workers.filter((w) => w.correo || w.celular);
      const workerRows = workersWithContact
        .map((w) => {
          const subject = encodeURIComponent('Evaluación SST: ' + quiz.nombre);
          const body = encodeURIComponent(`Hola ${w.nombre},\n\nPor favor resuelve la evaluación:\n${url}`);
          const waText = encodeURIComponent(`Hola ${w.nombre}, por favor resuelve esta evaluación: ${url}`);
          return `<div class="doc-row"><div class="doc-icon"><i class="ti ti-user"></i></div><div class="doc-name">${escapeHtml(
            w.nombre
          )}</div><div style="display:flex;gap:6px">${
            w.correo ? `<a class="btn btn-ghost btn-sm" href="mailto:${escapeHtml(w.correo)}?subject=${subject}&body=${body}"><i class="ti ti-mail"></i></a>` : ''
          } ${
            w.celular
              ? `<a class="btn btn-ghost btn-sm" href="https://wa.me/${escapeHtml(
                  w.celular.replace(/\D/g, '')
                )}?text=${waText}" target="_blank"><i class="ti ti-brand-whatsapp"></i></a>`
              : ''
          }</div></div>`;
        })
        .join('');
      return `<div class="modal-title">Enviar evaluación por enlace</div><p class="modal-sub">Comparte este enlace. El trabajador elige su nombre, resuelve "<strong>${escapeHtml(
        quiz.nombre
      )}</strong>" y el resultado queda en Resultados automáticamente.</p><div class="field"><label>Enlace</label><input type="text" id="share-link-input" value="${escapeHtml(
        url
      )}" readonly onclick="this.select()"></div><button class="btn btn-primary btn-block" id="copy-link-btn"><i class="ti ti-copy"></i> Copiar enlace</button>${
        workerRows
          ? `<div class="divider"></div><p class="card-subtitle" style="margin-bottom:10px">Enviar directamente a:</p><div class="doc-list">${workerRows}</div>`
          : ''
      }<button type="button" class="btn btn-ghost btn-block" id="modal-cancel" style="margin-top:10px">Cerrar</button>`;
    };
    const attachListeners = () => {
      document.getElementById('copy-link-btn')?.addEventListener('click', () => {
        const input = document.getElementById('share-link-input');
        input.select();
        navigator.clipboard?.writeText(input.value);
        showToast('Enlace copiado.', 'success');
      });
    };
    this.modal.open({ renderContent, attachListeners });
  }
}
