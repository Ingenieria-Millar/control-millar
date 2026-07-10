import { httpClient } from '../services/httpClient.js';

export const quizzesRepository = {
  getAll: () => httpClient.get('/evaluaciones'),
  getById: (id) => httpClient.get(`/evaluaciones/${id}`),
  create: (data) => httpClient.post('/evaluaciones', data),
  update: (id, data) => httpClient.put(`/evaluaciones/${id}`, data),
  remove: (id) => httpClient.delete(`/evaluaciones/${id}`),
};
