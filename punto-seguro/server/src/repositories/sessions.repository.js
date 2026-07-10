import { query } from '../config/database.js';

function mapSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    tema: row.tema,
    fecha: row.fecha,
    horas: row.horas,
    dirigidoA: row.dirigido_a,
    responsable: row.responsable,
  };
}

function mapAttendee(row) {
  if (!row) return null;
  return {
    id: row.id,
    sessionId: row.session_id,
    workerId: row.worker_id,
    nombre: row.nombre,
    asistio: row.asistio,
    evaluado: row.evaluado,
  };
}

export const sessionsRepository = {
  async findAll() {
    const { rows } = await query('SELECT * FROM training_sessions ORDER BY fecha DESC');
    return rows.map(mapSession);
  },

  async findAttendeesBySession(sessionId) {
    const { rows } = await query(
      'SELECT * FROM session_attendees WHERE session_id = $1 ORDER BY nombre ASC',
      [sessionId]
    );
    return rows.map(mapAttendee);
  },

  async create({ id, tema, fecha, horas, dirigidoA, responsable }) {
    const { rows } = await query(
      `INSERT INTO training_sessions (id, tema, fecha, horas, dirigido_a, responsable)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, tema, fecha, horas || '', dirigidoA || 'Todo el personal', responsable || '']
    );
    return mapSession(rows[0]);
  },

  async addAttendee({ id, sessionId, workerId, nombre }) {
    const { rows } = await query(
      `INSERT INTO session_attendees (id, session_id, worker_id, nombre)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [id, sessionId, workerId || null, nombre]
    );
    return mapAttendee(rows[0]);
  },

  async updateAttendee(sessionId, attendeeId, fields) {
    const columns = { asistio: 'asistio', evaluado: 'evaluado' };
    const sets = [];
    const values = [];
    let i = 1;
    for (const [key, column] of Object.entries(columns)) {
      if (fields[key] !== undefined) {
        sets.push(`${column} = $${i}`);
        values.push(fields[key]);
        i += 1;
      }
    }
    if (sets.length === 0) return null;
    values.push(sessionId, attendeeId);
    const { rows } = await query(
      `UPDATE session_attendees SET ${sets.join(', ')} WHERE session_id = $${i} AND id = $${i + 1} RETURNING *`,
      values
    );
    return mapAttendee(rows[0]);
  },

  async removeAttendee(sessionId, attendeeId) {
    await query('DELETE FROM session_attendees WHERE session_id = $1 AND id = $2', [sessionId, attendeeId]);
  },
};
