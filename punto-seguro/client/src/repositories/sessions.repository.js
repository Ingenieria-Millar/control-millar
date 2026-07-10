import { httpClient } from '../services/httpClient.js';

export const sessionsRepository = {
  getAll: () => httpClient.get('/capacitaciones/sesiones'),
  create: (data) => httpClient.post('/capacitaciones/sesiones', data),
  addAttendee: (sessionId, data) => httpClient.post(`/capacitaciones/sesiones/${sessionId}/asistentes`, data),
  updateAttendee: (sessionId, attendeeId, data) =>
    httpClient.patch(`/capacitaciones/sesiones/${sessionId}/asistentes/${attendeeId}`, data),
  removeAttendee: (sessionId, attendeeId) =>
    httpClient.delete(`/capacitaciones/sesiones/${sessionId}/asistentes/${attendeeId}`),
};
