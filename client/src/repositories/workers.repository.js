import { httpClient } from '../services/httpClient.js';

/**
 * Acceso a datos de trabajadores desde el cliente. Reemplaza las llamadas
 * `safeGet(SK.WORKERS, ...)` / `saveWorkers()` del archivo original por
 * peticiones reales a la API construida en la Fase 2.
 */
export const workersRepository = {
  getAll: () => httpClient.get('/trabajadores'),
  getById: (id) => httpClient.get(`/trabajadores/${id}`),
  create: (data) => httpClient.post('/trabajadores', data),
  update: (id, data) => httpClient.put(`/trabajadores/${id}`, data),
  remove: (id) => httpClient.delete(`/trabajadores/${id}`),
  addSignedDocument: (id, doc) => httpClient.post(`/trabajadores/${id}/documentos-firmados`, doc),
  getSignedDocumentDownloadUrl: (id, docId) => `/api/trabajadores/${id}/documentos-firmados/${docId}`,
};
