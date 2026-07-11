import { attemptsRepository } from '../repositories/attempts.repository.js';
import { withErrorToast } from './errorNotifier.js';

export const attemptsService = {
  async listAll() {
    const { data } = await withErrorToast(() => attemptsRepository.getAll(), 'No se pudieron cargar los resultados.');
    return data;
  },
  async submit(attempt) {
    const { data } = await withErrorToast(
      () => attemptsRepository.create(attempt),
      'No se pudo registrar el resultado de la evaluación.'
    );
    return data;
  },
};
