import { renderPublicHeader, renderOnboardingHeader } from '../../components/PublicHeader.js';
import { escapeHtml } from '../../utils/textUtils.js';
import { formatDateTime } from '../../utils/dateUtils.js';
import { showToast } from '../../helpers/toast.js';
import { workersService } from '../../services/workers.service.js';
import { annexTemplatesService } from '../../services/annexTemplates.service.js';
import { signaturePositionsService } from '../../services/signaturePositions.service.js';
import { inductionContentService } from '../../services/inductionContent.service.js';
import { quizzesService } from '../../services/quizzes.service.js';
import { attemptsService } from '../../services/attempts.service.js';
import { stampSignatureOnPdf } from '../../services/pdfStamping.service.js';
import { scoreQuizAttempt, classifyScore } from '../../services/quizScoring.js';
import { bytesToBase64 } from '../../utils/binaryUtils.js';
import { SignaturePad } from '../../components/SignaturePad.js';

const SCORE_LABELS = {
  aprobado: { text: 'Aprobado', className: 'badge-green' },
  refuerzo: { text: 'Aprobado con refuerzo', className: 'badge-amber' },
  reprobado: { text: 'Reprobado', className: 'badge-red' },
};

/**
 * Página pública "Proceso de ingreso" (?ingreso=workerId). Réplica de
 * bootstrapOnboarding()/renderOB()/obContent()/attachOBListeners() del original.
 *
 * Nota de simplificación respecto al original: la marca "ya completado"
 * (antes una clave aparte `sst:onboarding_done:<id>` en window.storage) ahora
 * se deriva de los datos que ya existen — si el trabajador tiene tantos
 * documentos firmados como plantillas del paquete Y ya existe un intento de
 * evaluación con origen "enlace_ingreso" — en vez de mantener una bandera
 * redundante en una tabla aparte.
 */
export class OnboardingPage {
  constructor(workerId) {
    this.workerId = workerId;
    this.step = 'loading';
    this.errorMsg = '';
    this.signedDocs = [];
    this.consent = false;
    this.answers = {};
    this.score = null;
    this.signaturePad = null;
  }

  async render(root) {
    this.root = root;
    document.title = 'Proceso de Ingreso SST — Punto Seguro';
    this._draw();

    try {
      const worker = await workersService.getById(this.workerId);
      this.worker = worker;

      const annexTemplates = await annexTemplatesService.listAll();
      if (!annexTemplates.length) {
        this.step = 'error';
        this.errorMsg = 'El paquete de ingreso aún no está configurado. Contacta al área de SST.';
        this._draw();
        return;
      }
      this.annexTemplates = annexTemplates;
      this.signaturePositions = await signaturePositionsService.listAll();

      const induction = await inductionContentService.get();
      if (!induction?.quizId) {
        this.step = 'error';
        this.errorMsg = 'No se encontró la evaluación configurada. Contacta al área de SST.';
        this._draw();
        return;
      }
      this.induction = induction;

      const quiz = await quizzesService.getById(induction.quizId).catch(() => null);
      if (!quiz) {
        this.step = 'error';
        this.errorMsg = 'No se encontró la evaluación configurada. Contacta al área de SST.';
        this._draw();
        return;
      }
      this.quiz = quiz;

      const alreadyDone = await this._checkAlreadyDone();
      if (alreadyDone) {
        this.step = 'already_done';
        this._draw();
        return;
      }

      this.step = 'sign';
      this._draw();
    } catch (err) {
      console.error(err);
      this.step = 'error';
      this.errorMsg = 'No se encontró información para este enlace. Solicita uno nuevo al área de SST.';
      this._draw();
    }
  }

  async _checkAlreadyDone() {
    const allSigned = (this.worker.documentosFirmados?.length || 0) >= this.annexTemplates.length;
    if (!allSigned) return false;
    const attempts = await attemptsService.listAll();
    return attempts.some((a) => a.workerId === this.workerId && a.origen === 'enlace_ingreso');
  }

  _draw() {
    this.root.innerHTML = `<div class="public-wrap">${this._content()}</div>`;
    this._attachListeners();
    if (this.step === 'sign') {
      this.signaturePad = new SignaturePad({
        canvasId: 'sig-canvas',
        clearButtonId: 'sig-clear-btn',
        confirmButtonIds: ['onboard-sign-btn'],
        consentCheckboxId: 'onboard-consent-check',
        placeholderSelector: '.sig-pad-placeholder',
        wrapSelector: '.sig-pad-wrap',
      });
      setTimeout(() => this.signaturePad.init(), 80);
    }
  }

  _content() {
    if (this.step === 'loading') {
      return `<div class="public-card text-center"><i class="ti ti-loader-2" style="font-size:24px;color:var(--steel);animation:spin 1s linear infinite"></i><p class="small-muted" style="margin-top:10px">Cargando tu proceso de ingreso…</p></div>`;
    }
    if (this.step === 'error') {
      return `<div class="public-card text-center">${renderPublicHeader()}<div class="divider"></div><div style="font-size:30px;color:var(--safety-red);margin:10px 0"><i class="ti ti-alert-circle"></i></div><div class="card-title">No se pudo cargar</div><p class="card-subtitle">${escapeHtml(
        this.errorMsg
      )}</p></div>`;
    }
    if (this.step === 'already_done') {
      return `<div class="public-card text-center">${renderPublicHeader()}<div class="divider"></div><div style="font-size:30px;color:var(--safety-green);margin:10px 0"><i class="ti ti-circle-check"></i></div><div class="card-title">Ya completaste tu proceso de ingreso</div><p class="card-subtitle">Tus documentos, inducción y evaluación ya fueron registrados.</p></div>`;
    }
    if (this.step === 'sign') return this._contentSign();
    if (this.step === 'induction') return this._contentInduction();
    if (this.step === 'quiz') return this._contentQuiz();
    if (this.step === 'done') return this._contentDone();
    return '';
  }

  _contentSign() {
    const docs = this.annexTemplates;
    const docList = docs
      .map((d) => `<div class="doc-row"><div class="doc-icon"><i class="ti ti-file-type-pdf"></i></div><div class="doc-name">${escapeHtml(d.nombre)}</div></div>`)
      .join('');
    return `<div class="public-card">${renderOnboardingHeader('sign')}<div class="divider"></div><div class="card-title">Firma de documentos de ingreso</div><p class="card-subtitle">Hola ${escapeHtml(
      this.worker.nombre
    )}, firma una sola vez abajo. Tu firma se aplicará automáticamente a los ${docs.length} documento(s) en el lugar indicado por SST.</p><div class="doc-list" style="margin-bottom:16px">${docList}</div><div class="sig-pad-wrap"><div class="sig-pad-placeholder">Firma aquí con el dedo o el mouse</div><canvas id="sig-canvas"></canvas></div><div style="margin-top:10px"><button class="btn btn-ghost btn-sm" id="sig-clear-btn" disabled><i class="ti ti-eraser"></i> Borrar</button></div><div class="divider"></div><label style="display:flex;gap:10px;align-items:flex-start;font-size:13px;color:var(--ink-soft);cursor:pointer"><input type="checkbox" id="onboard-consent-check" style="margin-top:3px;width:16px;height:16px"><span>Declaro mi consentimiento para firmar electrónicamente estos documentos, conforme al artículo 7° de la Ley 527 de 1999 y al Decreto 2364 de 2012.</span></label><button class="btn btn-amber btn-block" id="onboard-sign-btn" style="margin-top:18px" disabled><i class="ti ti-stamp"></i> Firmar y continuar</button><div id="ob-sign-progress" style="margin-top:14px;display:none"><div class="progress-bar-track"><div class="progress-bar-fill" id="ob-sign-fill" style="width:0%"></div></div><p class="small-muted" id="ob-sign-text" style="margin-top:8px"></p></div></div>`;
  }

  _contentInduction() {
    const ic = this.induction;
    const paragraphs = (ic.cuerpo || '')
      .split('\n')
      .filter((p) => p.trim())
      .map((p) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.6">${escapeHtml(p)}</p>`)
      .join('');
    return `<div class="public-card">${renderOnboardingHeader('induction')}<div class="divider"></div><div class="card-title">${escapeHtml(
      ic.titulo || 'Inducción'
    )}</div><div style="margin:14px 0">${paragraphs}</div><button class="btn btn-primary btn-block" id="ob-induction-continue"><i class="ti ti-arrow-right"></i> Continuar a la evaluación</button></div>`;
  }

  _contentQuiz() {
    const quiz = this.quiz;
    const answered = Object.keys(this.answers).length;
    const questions = quiz.preguntas
      .map(
        (p, idx) =>
          `<div class="q-card"><p style="font-weight:600;font-size:14px;margin:0 0 12px">${idx + 1}. ${escapeHtml(
            p.texto
          )}</p>${p.opciones
            .map(
              (opt, oi) =>
                `<label style="display:flex;align-items:center;gap:10px;margin-bottom:9px;cursor:pointer;font-size:14px"><input type="radio" name="ans-${p.id}" value="${oi}" data-onb-answer="${
                  p.id
                }" ${this.answers[p.id] === oi ? 'checked' : ''}>${escapeHtml(opt)}</label>`
            )
            .join('')}</div>`
      )
      .join('');
    return `<div class="public-card">${renderOnboardingHeader('quiz')}<div class="divider"></div><div class="flex-between" style="margin-bottom:6px"><div class="card-title" style="margin-bottom:0">${escapeHtml(
      quiz.nombre
    )}</div><span class="small-muted">${answered}/${quiz.preguntas.length} respondidas</span></div><p class="card-subtitle">Última parte de tu proceso de ingreso.</p>${questions}<button class="btn btn-primary btn-block" id="ob-submit-quiz"><i class="ti ti-send"></i> Finalizar proceso de ingreso</button></div>`;
  }

  _contentDone() {
    const label = SCORE_LABELS[classifyScore(this.score)];
    return `<div class="public-card text-center">${renderPublicHeader()}<div class="divider"></div><div style="width:56px;height:56px;border-radius:50%;background:var(--safety-green-light);color:var(--safety-green);display:flex;align-items:center;justify-content:center;font-size:26px;margin:10px auto 14px"><i class="ti ti-circle-check"></i></div><div class="card-title">¡Proceso de ingreso completado!</div><p class="card-subtitle">Gracias, ${escapeHtml(
      this.worker.nombre
    )}. Tus ${this.signedDocs.length} documento(s) quedaron firmados y tu evaluación registrada.</p><div style="font-family:var(--font-display);font-size:44px;font-weight:700;color:var(--navy-deep);margin:14px 0 6px">${
      this.score
    }</div><p class="small-muted" style="margin-bottom:10px">de 100 puntos en la evaluación</p><span class="badge ${label.className}" style="font-size:13px;padding:6px 14px">${
      label.text
    }</span></div>`;
  }

  _attachListeners() {
    document.getElementById('onboard-consent-check')?.addEventListener('change', (e) => {
      this.consent = e.target.checked;
      this.signaturePad?.updateConfirmButtonsState();
    });
    document.getElementById('sig-clear-btn')?.addEventListener('click', () => this.signaturePad?.clear());
    document.getElementById('sig-canvas')?.addEventListener('mouseup', () => this.signaturePad?.updateConfirmButtonsState());
    document.getElementById('sig-canvas')?.addEventListener('touchend', () => this.signaturePad?.updateConfirmButtonsState());
    document.getElementById('onboard-sign-btn')?.addEventListener('click', () => this._handleSign());
    document.getElementById('ob-induction-continue')?.addEventListener('click', () => {
      this.step = 'quiz';
      this.answers = {};
      this._draw();
    });
    document.querySelectorAll('[data-onb-answer]').forEach((radio) =>
      radio.addEventListener('change', () => {
        this.answers[radio.dataset.onbAnswer] = parseInt(radio.value, 10);
      })
    );
    document.getElementById('ob-submit-quiz')?.addEventListener('click', () => this._handleSubmitQuiz());
  }

  async _handleSign() {
    if (!this.signaturePad?.hasStroke) {
      showToast('Por favor firma antes de continuar.', 'error');
      return;
    }
    if (!this.consent) {
      showToast('Debes aceptar el consentimiento.', 'error');
      return;
    }
    const sig = this.signaturePad.getPngDataUrl();
    const progressWrap = document.getElementById('ob-sign-progress');
    const progressFill = document.getElementById('ob-sign-fill');
    const progressText = document.getElementById('ob-sign-text');
    progressWrap.style.display = 'block';
    document.getElementById('onboard-sign-btn')?.setAttribute('disabled', 'true');

    try {
      const docs = this.annexTemplates;
      const fechaHora = formatDateTime(new Date().toISOString());
      const signedDocs = [];

      for (let i = 0; i < docs.length; i++) {
        const tpl = docs[i];
        progressFill.style.width = Math.round((i / docs.length) * 100) + '%';
        progressText.textContent = `Estampando firma en "${tpl.nombre}" (${i + 1}/${docs.length})`;

        const response = await fetch(annexTemplatesService.getDownloadUrl(tpl.id));
        if (!response.ok) throw new Error(`No se pudo cargar "${tpl.nombre}".`);
        const buffer = await response.arrayBuffer();

        const position = this.signaturePositions[tpl.fileKey];
        if (!position) throw new Error(`Sin posición de firma definida para "${tpl.nombre}".`);

        const { bytes, hash } = await stampSignatureOnPdf(
          buffer,
          sig,
          { nombre: this.worker.nombre, documento: this.worker.documento, fechaHora },
          position
        );
        signedDocs.push({ nombre: tpl.nombre, hash, sizeKb: Math.round(bytes.length / 1024), bytes });
      }

      progressFill.style.width = '100%';
      progressText.textContent = 'Guardando documentos firmados…';

      for (const doc of signedDocs) {
        await workersService.addSignedDocument(this.workerId, {
          nombre: doc.nombre,
          hash: doc.hash,
          sizeKb: doc.sizeKb,
          pdfBase64: bytesToBase64(doc.bytes),
        });
      }

      this.signedDocs = signedDocs;
      this.step = 'induction';
      this._draw();
    } catch (err) {
      console.error(err);
      showToast('Error al firmar: ' + err.message, 'error');
      document.getElementById('onboard-sign-btn')?.removeAttribute('disabled');
    }
  }

  async _handleSubmitQuiz() {
    const quiz = this.quiz;
    const total = quiz.preguntas.length;
    const answered = Object.keys(this.answers).length;
    if (answered < total && !confirm(`Te faltan ${total - answered} pregunta(s). ¿Enviar?`)) return;

    const score = scoreQuizAttempt(quiz.preguntas, this.answers);
    this.score = score;
    document.getElementById('ob-submit-quiz')?.setAttribute('disabled', 'true');

    try {
      await attemptsService.submit({
        workerId: this.workerId,
        workerDocumento: this.worker.documento,
        quizId: quiz.id,
        quizNombre: quiz.nombre,
        puntaje: score,
        origen: 'enlace_ingreso',
      });
    } catch (err) {
      console.error(err);
    }

    this.step = 'done';
    this._draw();
  }
}
