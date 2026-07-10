import { trainingPlanRepository } from '../repositories/trainingPlan.repository.js';
import { withErrorToast } from './errorNotifier.js';

export const trainingPlanService = {
  async listAll() {
    const { data } = await withErrorToast(
      () => trainingPlanRepository.getAll(),
      'No se pudo cargar el plan de capacitación.'
    );
    return data;
  },
  async addRow(defaults) {
    const { data } = await withErrorToast(
      () => trainingPlanRepository.create(defaults),
      'No se pudo agregar la fila del plan.'
    );
    return data;
  },
  async updateField(id, field, value) {
    const { data } = await withErrorToast(
      () => trainingPlanRepository.update(id, { [field]: value }),
      'No se pudo guardar el cambio del plan.'
    );
    return data;
  },
  async removeRow(id) {
    await withErrorToast(() => trainingPlanRepository.remove(id), 'No se pudo eliminar la fila del plan.');
  },
};
