import { query } from '../config/database.js';

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workerId: row.worker_id,
    workerNombrePublico: row.worker_nombre_publico,
    quizId: row.quiz_id,
    quizNombre: row.quiz_nombre,
    puntaje: Number(row.puntaje),
    fecha: row.fecha,
    origen: row.origen,
  };
}

export const attemptsRepository = {
  async findAll() {
    const { rows } = await query('SELECT * FROM quiz_attempts ORDER BY fecha DESC');
    return rows.map(mapRow);
  },

  async create({ id, workerId, workerNombrePublico, quizId, quizNombre, puntaje, origen }) {
    const { rows } = await query(
      `INSERT INTO quiz_attempts (id, worker_id, worker_nombre_publico, quiz_id, quiz_nombre, puntaje, origen)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [id, workerId || null, workerNombrePublico || null, quizId || null, quizNombre, puntaje, origen || 'panel_admin']
    );
    return mapRow(rows[0]);
  },
};
