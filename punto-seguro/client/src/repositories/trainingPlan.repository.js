import { httpClient } from '../services/httpClient.js';

export const trainingPlanRepository = {
  getAll: () => httpClient.get('/capacitaciones/plan'),
  create: (data) => httpClient.post('/capacitaciones/plan', data),
  update: (id, data) => httpClient.put(`/capacitaciones/plan/${id}`, data),
  remove: (id) => httpClient.delete(`/capacitaciones/plan/${id}`),
};
