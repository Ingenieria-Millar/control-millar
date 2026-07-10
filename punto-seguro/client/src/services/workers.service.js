import { workersRepository } from '../repositories/workers.repository.js';
import { withErrorToast } from './errorNotifier.js';
import { showToast } from '../helpers/toast.js';

/**
 * Lógica de negocio de trabajadores en el cliente. Sustituye a las funciones
 * sueltas `saveWorkers()`, `stripDocsForStorage()`, `rehydrateWorkerDocs()` del
 * original: esa lógica dejó de ser necesaria porque los documentos ya no viven
 * en el navegador (localStorage/window.storage) sino en el servidor.
 */
export const workersService = {
  async listAll() {
    const { data } = await withErrorToast(
      () => workersRepository.getAll(),
      'No se pudieron cargar los trabajadores.'
    );
    return data;
  },

  async getById(id) {
    const { data } = await withErrorToast(
      () => workersRepository.getById(id),
      'No se pudo cargar la información del trabajador.'
    );
    return data;
  },

  async register(formData) {
    const { data } = await withErrorToast(
      () => workersRepository.create(formData),
      'No se pudo registrar el trabajador.'
    );
    showToast('Trabajador registrado correctamente.', 'success');
    return data;
  },

  async update(id, formData) {
    const { data } = await withErrorToast(
      () => workersRepository.update(id, formData),
      'No se pudo actualizar el trabajador.'
    );
    return data;
  },

  async remove(id) {
    await withErrorToast(() => workersRepository.remove(id), 'No se pudo eliminar el trabajador.');
  },

  /**
   * Registra un documento ya firmado (el PDF firmado se produce en el
   * navegador con pdf-lib — ver Fase 4 — y aquí solo se envía a guardar).
   */
  async addSignedDocument(workerId, { nombre, hash, sizeKb, pdfBase64 }) {
    const { data } = await withErrorToast(
      () => workersRepository.addSignedDocument(workerId, { nombre, hash, sizeKb, pdfBase64 }),
      'No se pudo guardar el documento firmado.'
    );
    return data;
  },

  getSignedDocumentDownloadUrl(workerId, docId) {
    return workersRepository.getSignedDocumentDownloadUrl(workerId, docId);
  },
};
