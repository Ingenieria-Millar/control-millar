import { signaturePositionsRepository } from '../repositories/signaturePositions.repository.js';
import { withErrorToast } from './errorNotifier.js';
import { showToast } from '../helpers/toast.js';

export const signaturePositionsService = {
  async listAll() {
    const { data } = await withErrorToast(
      () => signaturePositionsRepository.getAll(),
      'No se pudieron cargar las posiciones de firma.'
    );
    return data;
  },

  async save(position) {
    const { data } = await withErrorToast(
      () => signaturePositionsRepository.upsert(position),
      'No se pudo guardar la posición de firma.'
    );
    showToast(`Posición guardada para "${position.fileKey}".`, 'success');
    return data;
  },

  async remove(fileKey) {
    await withErrorToast(
      () => signaturePositionsRepository.remove(fileKey),
      'No se pudo eliminar la posición de firma.'
    );
    showToast('Posición eliminada.', 'default');
  },
};
