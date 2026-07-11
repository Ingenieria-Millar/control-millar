import { pageHeader } from '../helpers/markupHelpers.js';
import { escapeHtml } from '../utils/textUtils.js';
import { trainingPlanService } from '../services/trainingPlan.service.js';

/**
 * Página "Plan anual de capacitación". Réplica de viewPlan()/attachPlanListeners().
 * Cada celda editable persiste su cambio individualmente contra la API
 * (antes se reescribía el arreglo completo en window.storage en cada edición).
 */
export class PlanPage {
  async render(container) {
    this.container = container;
    this.plan = await trainingPlanService.listAll();
    this._draw();
  }

  _draw() {
    this.container.innerHTML = this._html();
    this._attachListeners();
  }

  _html() {
    const rows = this.plan
      .map(
        (t) => `<tr>
<td><input type="text" value="${escapeHtml(t.mes)}" data-plan-field="mes" data-plan-id="${t.id}" style="border:none;background:transparent;font-size:13.5px;width:80px"></td>
<td><input type="text" value="${escapeHtml(t.tema)}" data-plan-field="tema" data-plan-id="${t.id}" style="border:none;background:transparent;font-size:13.5px;width:220px"></td>
<td><input type="text" value="${escapeHtml(t.dirigidoA)}" data-plan-field="dirigidoA" data-plan-id="${t.id}" style="border:none;background:transparent;font-size:13.5px;width:140px"></td>
<td><input type="text" value="${escapeHtml(t.horas)}" data-plan-field="horas" data-plan-id="${t.id}" style="border:none;background:transparent;font-size:13.5px;width:40px"></td>
<td><input type="text" value="${escapeHtml(t.responsable)}" data-plan-field="responsable" data-plan-id="${t.id}" style="border:none;background:transparent;font-size:13.5px;width:120px"></td>
<td><button class="btn btn-ghost btn-sm" data-delete-plan="${t.id}"><i class="ti ti-trash"></i></button></td>
</tr>`
      )
      .join('');
    return `${pageHeader(
      'Capacitación SST',
      'Plan anual de capacitación',
      'Cronograma mensual de temas, dirigido a cada nivel de la organización, conforme al Decreto 1072 de 2015 y la Resolución 0312 de 2019.'
    )}
<div class="card"><div class="flex-between" style="margin-bottom:14px"><div class="card-title" style="margin-bottom:0">Cronograma ${new Date().getFullYear()}</div><button class="btn btn-ghost btn-sm" id="add-plan-row"><i class="ti ti-plus"></i> Agregar tema</button></div>
<div class="table-wrap"><table class="data-table"><thead><tr><th>Mes</th><th>Tema</th><th>Dirigido a</th><th>Horas</th><th>Responsable</th><th></th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  }

  _attachListeners() {
    const c = this.container;
    c.querySelectorAll('[data-plan-field]').forEach((input) =>
      input.addEventListener('change', async () => {
        const row = this.plan.find((t) => t.id === input.dataset.planId);
        if (row) row[input.dataset.planField] = input.value;
        await trainingPlanService.updateField(input.dataset.planId, input.dataset.planField, input.value);
      })
    );
    c.querySelector('#add-plan-row')?.addEventListener('click', async () => {
      await trainingPlanService.addRow({ mes: 'Mes', tema: 'Nuevo tema', dirigidoA: 'Todo el personal', horas: '2', responsable: 'Profesional SST' });
      await this.render(c);
    });
    c.querySelectorAll('[data-delete-plan]').forEach((btn) =>
      btn.addEventListener('click', async () => {
        await trainingPlanService.removeRow(btn.dataset.deletePlan);
        await this.render(c);
      })
    );
  }
}
