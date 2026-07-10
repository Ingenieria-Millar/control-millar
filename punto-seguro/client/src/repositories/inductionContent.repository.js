import { httpClient } from '../services/httpClient.js';

export const inductionContentRepository = {
  get: () => httpClient.get('/paquete/induccion'),
  update: (data) => httpClient.put('/paquete/induccion', data),
};
