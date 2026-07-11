import { httpClient } from '../services/httpClient.js';
import { API_BASE_URL } from '../config/apiConfig.js';

export const annexTemplatesRepository = {
  getAll: () => httpClient.get('/paquete/plantillas'),
  getDownloadUrl: (id) => `${API_BASE_URL}/paquete/plantillas/${id}/archivo`,
  upload: (data) => httpClient.post('/paquete/plantillas', data),
  remove: (id) => httpClient.delete(`/paquete/plantillas/${id}`),
};
