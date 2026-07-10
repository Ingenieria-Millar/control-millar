import { query } from '../config/database.js';

function mapRow(row) {
  if (!row) return null;
  return { titulo: row.titulo, cuerpo: row.cuerpo, quizId: row.quiz_id };
}

/**
 * Contenido de inducción: fila única (id=1), tal como el original
 * lo trataba como un objeto singleton (SK.INDUCTION).
 */
export const inductionContentRepository = {
  async get() {
    const { rows } = await query('SELECT * FROM induction_content WHERE id = 1');
    return mapRow(rows[0]);
  },

  async upsert({ titulo, cuerpo, quizId }) {
    const { rows } = await query(
      `INSERT INTO induction_content (id, titulo, cuerpo, quiz_id) VALUES (1, $1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET titulo = EXCLUDED.titulo, cuerpo = EXCLUDED.cuerpo, quiz_id = EXCLUDED.quiz_id
       RETURNING *`,
      [titulo, cuerpo, quizId || null]
    );
    return mapRow(rows[0]);
  },
};
