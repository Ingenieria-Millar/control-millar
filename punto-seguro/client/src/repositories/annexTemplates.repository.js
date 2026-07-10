import { httpClient } from '../services/httpClient.js';

export const annexTemplatesRepository = {
  getAll: () => httpClient.get('/paquete/plantillas'),
  getDownloadUrl: (id) => `/api/paquete/plantillas/${id}/archivo`,
  upload: (data) => httpClient.post('/paquete/plantillas', data),
  remove: (id) => httpClient.delete(`/paquete/plantillas/${id}`),
};
