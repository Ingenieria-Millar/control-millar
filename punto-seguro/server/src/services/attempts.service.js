import { attemptsRepository } from '../repositories/attempts.repository.js';
import { workersRepository } from '../repositories/workers.repository.js';
import { generateId } from '../utils/idGenerator.js';

export const attemptsService = {
  listAll: () => attemptsRepository.findAll(),

  /**
   * Registra un intento de evaluación. Soporta el mismo mecanismo de "match por
   * documento" que usaba syncSharedAttempts en el original: si el intento viene
   * de un enlace público sin workerId pero con el documento del trabajador,
   * se intenta emparejar con un trabajador existente.
   */
  async create({ workerId, workerDocumento, workerNombrePublico, quizId, quizNombre, puntaje, origen }) {
    let resolvedWorkerId = workerId || null;
    if (!resolvedWorkerId && workerDocumento) {
      const worker = await workersRepository.findByDocumento(workerDocumento.trim());
      if (worker) resolvedWorkerId = worker.id;
    }
    return attemptsRepository.create({
      id: generateId('att'),
      workerId: resolvedWorkerId,
      workerNombrePublico: resolvedWorkerId ? undefined : workerNombrePublico,
      quizId,
      quizNombre,
      puntaje,
      origen,
    });
  },
};
