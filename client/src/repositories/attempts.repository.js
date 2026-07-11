import { httpClient } from '../services/httpClient.js';

export const attemptsRepository = {
  getAll: () => httpClient.get('/resultados'),
  create: (data) => httpClient.post('/resultados', data),
};
