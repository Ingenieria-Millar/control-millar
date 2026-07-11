import { quizzesRepository } from '../repositories/quizzes.repository.js';
import { withErrorToast } from './errorNotifier.js';

export const quizzesService = {
  async listAll() {
    const { data } = await withErrorToast(() => quizzesRepository.getAll(), 'No se pudieron cargar las evaluaciones.');
    return data;
  },
  async getById(id) {
    const { data } = await withErrorToast(
      () => quizzesRepository.getById(id),
      'No se pudo cargar la evaluación.'
    );
    return data;
  },
  async save(quiz) {
    const { data } = await withErrorToast(
      () => (quiz.id ? quizzesRepository.update(quiz.id, quiz) : quizzesRepository.create(quiz)),
      'No se pudo guardar la evaluación.'
    );
    return data;
  },
  async remove(id) {
    await withErrorToast(() => quizzesRepository.remove(id), 'No se pudo eliminar la evaluación.');
  },
};
