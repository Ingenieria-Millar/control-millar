import { trainingPlanRepository } from '../repositories/trainingPlan.repository.js';
import { generateId } from '../utils/idGenerator.js';

export const trainingPlanService = {
  listAll: () => trainingPlanRepository.findAll(),

  create(data) {
    return trainingPlanRepository.create({ id: generateId('plan'), ...data });
  },

  update(id, data) {
    return trainingPlanRepository.update(id, data);
  },

  remove(id) {
    return trainingPlanRepository.remove(id);
  },
};
