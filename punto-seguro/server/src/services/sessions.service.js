import { sessionsRepository } from '../repositories/sessions.repository.js';
import { workersRepository } from '../repositories/workers.repository.js';
import { generateId } from '../utils/idGenerator.js';
import { AppError } from '../utils/AppError.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

export const sessionsService = {
  async listAll() {
    const sessions = await sessionsRepository.findAll();
    return Promise.all(
      sessions.map(async (s) => ({
        ...s,
        asistentes: await sessionsRepository.findAttendeesBySession(s.id),
      }))
    );
  },

  create(data) {
    return sessionsRepository.create({ id: generateId('sess'), ...data });
  },

  /**
   * Agrega un asistente. Puede venir de un trabajador registrado (workerId)
   * o como nombre manual, igual que en el modal original (modalAddAttendee).
   */
  async addAttendee(sessionId, { workerId, manualName }) {
    let nombre = manualName?.trim();
    if (workerId) {
      const worker = await workersRepository.findById(workerId);
      if (!worker) throw new AppError('Trabajador no encontrado.', HTTP_STATUS.NOT_FOUND);
      nombre = worker.nombre;
    }
    if (!nombre) {
      throw new AppError('Debes seleccionar un trabajador o escribir un nombre.', HTTP_STATUS.BAD_REQUEST);
    }
    return sessionsRepository.addAttendee({
      id: generateId('att'),
      sessionId,
      workerId: workerId || null,
      nombre,
    });
  },

  updateAttendee(sessionId, attendeeId, fields) {
    return sessionsRepository.updateAttendee(sessionId, attendeeId, fields);
  },

  removeAttendee(sessionId, attendeeId) {
    return sessionsRepository.removeAttendee(sessionId, attendeeId);
  },
};
