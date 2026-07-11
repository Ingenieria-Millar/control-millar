import { httpClient } from '../services/httpClient.js';

export const signaturePositionsRepository = {
  getAll: () => httpClient.get('/paquete/posiciones-firma'),
  upsert: (data) => httpClient.post('/paquete/posiciones-firma', data),
  remove: (fileKey) => httpClient.delete(`/paquete/posiciones-firma/${fileKey}`),
};
