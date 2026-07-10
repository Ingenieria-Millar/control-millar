import { quizzesRepository } from '../repositories/quizzes.repository.js';
import { generateId } from '../utils/idGenerator.js';
import { AppError } from '../utils/AppError.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

export const quizzesService = {
  async listAll() {
    const quizzes = await quizzesRepository.findAll();
    return Promise.all(
      quizzes.map(async (q) => ({
        ...q,
        preguntas: await quizzesRepository.findQuestionsByQuiz(q.id),
      }))
    );
  },

  async getById(id) {
    const quiz = await quizzesRepository.findById(id);
    if (!quiz) throw new AppError('Evaluación no encontrada.', HTTP_STATUS.NOT_FOUND);
    const preguntas = await quizzesRepository.findQuestionsByQuiz(id);
    return { ...quiz, preguntas };
  },

  /**
   * Crea o actualiza una evaluación completa (encabezado + preguntas), igual al
   * editor original que siempre guarda el objeto quiz entero de una sola vez.
   */
  async upsert({ id, nombre, categoria, preguntas }) {
    let quiz;
    if (id) {
      quiz = await quizzesRepository.update(id, { nombre, categoria });
      if (!quiz) throw new AppError('Evaluación no encontrada.', HTTP_STATUS.NOT_FOUND);
    } else {
      quiz = await quizzesRepository.create({ id: generateId('quiz'), nombre, categoria });
    }
    const preguntasConId = (preguntas || []).map((p) => ({
      ...p,
      id: p.id || generateId('preg'),
    }));
    const preguntasGuardadas = await quizzesRepository.replaceQuestions(quiz.id, preguntasConId);
    return { ...quiz, preguntas: preguntasGuardadas };
  },

  async remove(id) {
    await quizzesRepository.remove(id);
  },
};
