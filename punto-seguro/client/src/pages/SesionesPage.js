import { pageHeader, emptyState } from '../helpers/markupHelpers.js';
import { escapeHtml } from '../utils/textUtils.js';
import { formatDate, todayISO } from '../utils/dateUtils.js';
import { sessionsService } from '../services/sessions.service.js';
import { workersService } from '../services/workers.service.js';
import { Modal } from '../components/Modal.js';

/**
 * Página "Sesiones e inducciones". Réplica de viewSesiones()/attachSesionesListeners().
 */
export class SesionesPage {
  constructor() {
    this.modal = new Modal();
  }

  async render(container) {
    this.container = container;
    this.sessions = await sessionsService.listAll();
    this._draw();
  }

  _draw() {
    this.container.innerHTML = this._html();
    this._attachListeners();
  }

  _html() {
    const rows = this.sessions
      .slice()
      .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))
      .map((s) => {
        const attendees = s.asistentes || [];
        const present = attendees.filter((a) => a.asistio).length;
        const coverage = attendees.length ? Math.round((present / attendees.length) * 100) : 0;
        const attendeeRows = attendees
          .map(
            (a) =>
              `<tr><td>${escapeHtml(a.nombre)}</td><td><label style="display:flex;align-items:center;gap:6px;cursor:pointer"><input type="checkbox" data-toggle-attend="${
                s.id
              }|${a.id}" ${a.asistio ? 'checked' : ''}><span class="small-muted">Asistió</span></label></td><td>${
                a.evaluado
                  ? '<span class="badge badge-green">Evaluado</span>'
                  : '<span class="badge badge-grey">Sin evaluar</span>'
              }</td><td><button class="btn btn-ghost btn-sm" data-remove-attendee="${s.id}|${a.id}"><i class="ti ti-x"></i></button></td></tr>`
          )
          .join('');
        return `<div class="card"><div class="flex-between"><div><div class="card-title" style="margin-bottom:2px">${escapeHtml(
          s.tema
        )}</div><p class="small-muted" style="margin:0">${formatDate(s.fecha)} · ${escapeHtml(
          s.dirigidoA || 'Todo el personal'
        )}</p></div><span class="badge ${
          coverage >= 90 ? 'badge-green' : coverage >= 60 ? 'badge-amber' : 'badge-red'
        }">${coverage}% asistencia</span></div><div class="divider"></div><div class="flex-between" style="margin-bottom:10px"><span class="small-muted">Asistentes (${present}/${
          attendees.length
        })</span><button class="btn btn-ghost btn-sm" data-add-attendee="${s.id}"><i class="ti ti-user-plus"></i> Agregar</button></div>${
          attendees.length
            ? `<div class="table-wrap"><table class="data-table"><thead><tr><th>Nombre</th><th>Asistencia</th><th>Evaluación</th><th></th></tr></thead><tbody>${attendeeRows}</tbody></table></div>`
            : '<p class="small-muted">Sin asistentes aún.</p>'
        }</div>`;
      })
      .join('');
    return `${pageHeader(
      'Capacitación SST',
      'Sesiones e inducciones',
      'Programa y registra cada sesión de capacitación con su lista de asistentes.'
    )}<div class="flex-between" style="margin-bottom:16px"><span class="small-muted">${
      this.sessions.length
    } sesión(es)</span><button class="btn btn-primary" id="new-session-btn"><i class="ti ti-calendar-plus"></i> Nueva sesión</button></div>${
      rows || `<div class="card">${emptyState('ti-presentation', 'Sin sesiones aún', 'Crea la primera sesión con el botón de arriba.')}</div>`
    }`;
  }

  _attachListeners() {
    const c = this.container;
    c.querySelector('#new-session-btn')?.addEventListener('click', () => this._openNewSessionModal());
    c.querySelectorAll('[data-add-attendee]').forEach((btn) =>
      btn.addEventListener('click', () => this._openAddAttendeeModal(btn.dataset.addAttendee))
    );
    c.querySelectorAll('[data-toggle-attend]').forEach((chk) =>
      chk.addEventListener('change', async () => {
        const [sessionId, attendeeId] = chk.dataset.toggleAttend.split('|');
        await sessionsService.toggleAsistio(sessionId, attendeeId, chk.checked);
        await this.render(c);
      })
    );
    c.querySelectorAll('[data-remove-attendee]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        const [sessionId, attendeeId] = btn.dataset.removeAttendee.split('|');
        await sessionsService.removeAttendee(sessionId, attendeeId);
        await this.render(c);
      })
    );
  }

  _openNewSessionModal() {
    const renderContent = () =>
      `<div class="modal-title">Nueva sesión</div><p class="modal-sub">Programa una sesión de capacitación.</p><form id="session-form"><div class="field"><label>Tema</label><input type="text" name="tema" required></div><div class="grid-2"><div class="field"><label>Fecha</label><input type="date" name="fecha" value="${todayISO()}" required></div><div class="field"><label>Horas</label><input type="text" name="horas" value="2"></div></div><div class="field"><label>Dirigido a</label><input type="text" name="dirigidoA" value="Todo el personal"></div><div class="field"><label>Responsable</label><input type="text" name="responsable" value="Profesional SST"></div><div class="flex-between" style="margin-top:18px"><button type="button" class="btn btn-ghost" id="modal-cancel">Cancelar</button><button type="submit" class="btn btn-primary">Crear sesión</button></div></form>`;
    const attachListeners = () => {
      document.getElementById('session-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        await sessionsService.create({
          tema: fd.get('tema'),
          fecha: fd.get('fecha'),
          horas: fd.get('horas'),
          dirigidoA: fd.get('dirigidoA'),
          responsable: fd.get('responsable'),
        });
        this.modal.close();
        await this.render(this.container);
      });
    };
    this.modal.open({ renderContent, attachListeners });
  }

  async _openAddAttendeeModal(sessionId) {
    const workers = await workersService.listAll();
    const renderContent = () => {
      const opts = workers.map((w) => `<option value="${w.id}">${escapeHtml(w.nombre)}</option>`).join('');
      return `<div class="modal-title">Agregar asistente</div><form id="attendee-form"><div class="field"><label>Trabajador registrado</label><select name="workerId"><option value="">— Nombre manual —</option>${opts}</select></div><div class="field"><label>O nombre manual</label><input type="text" name="manualName"></div><div class="flex-between" style="margin-top:18px"><button type="button" class="btn btn-ghost" id="modal-cancel">Cancelar</button><button type="submit" class="btn btn-primary">Agregar</button></div></form>`;
    };
    const attachListeners = () => {
      document.getElementById('attendee-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        await sessionsService.addAttendee(sessionId, {
          workerId: fd.get('workerId') || null,
          manualName: fd.get('manualName'),
        });
        this.modal.close();
        await this.render(this.container);
      });
    };
    this.modal.open({ renderContent, attachListeners });
  }
}
