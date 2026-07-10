import { annexTemplatesRepository } from '../repositories/annexTemplates.repository.js';
import { withErrorToast } from './errorNotifier.js';
import { fileToBase64 } from '../utils/binaryUtils.js';

export const annexTemplatesService = {
  async listAll() {
    const { data } = await withErrorToast(
      () => annexTemplatesRepository.getAll(),
      'No se pudieron cargar las plantillas de anexos.'
    );
    return data;
  },

  async upload(file) {
    const pdfBase64 = await fileToBase64(file);
    const { data } = await withErrorToast(
      () => annexTemplatesRepository.upload({ nombre: file.name, pdfBase64 }),
      `No se pudo subir la plantilla "${file.name}".`
    );
    return data;
  },

  async remove(id) {
    await withErrorToast(() => annexTemplatesRepository.remove(id), 'No se pudo eliminar la plantilla.');
  },

  getDownloadUrl(id) {
    return annexTemplatesRepository.getDownloadUrl(id);
  },
};
