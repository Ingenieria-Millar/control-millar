import { sessionsRepository } from '../repositories/sessions.repository.js';
import { withErrorToast } from './errorNotifier.js';

export const sessionsService = {
  async listAll() {
    const { data } = await withErrorToast(() => sessionsRepository.getAll(), 'No se pudieron cargar las sesiones.');
    return data;
  },
  async create(formData) {
    const { data } = await withErrorToast(() => sessionsRepository.create(formData), 'No se pudo crear la sesión.');
    return data;
  },
  async addAttendee(sessionId, payload) {
    const { data } = await withErrorToast(
      () => sessionsRepository.addAttendee(sessionId, payload),
      'No se pudo agregar el asistente.'
    );
    return data;
  },
  async toggleAsistio(sessionId, attendeeId, asistio) {
    const { data } = await withErrorToast(
      () => sessionsRepository.updateAttendee(sessionId, attendeeId, { asistio }),
      'No se pudo actualizar la asistencia.'
    );
    return data;
  },
  async removeAttendee(sessionId, attendeeId) {
    await withErrorToast(
      () => sessionsRepository.removeAttendee(sessionId, attendeeId),
      'No se pudo quitar el asistente.'
    );
  },
};
