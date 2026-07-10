import { query } from '../config/database.js';

function mapQuiz(row) {
  if (!row) return null;
  return { id: row.id, nombre: row.nombre, categoria: row.categoria };
}

function mapQuestion(row) {
  if (!row) return null;
  return {
    id: row.id,
    quizId: row.quiz_id,
    texto: row.texto,
    opciones: row.opciones,
    correctaIdx: row.correcta_idx,
  };
}

export const quizzesRepository = {
  async findAll() {
    const { rows } = await query('SELECT * FROM quizzes ORDER BY created_at ASC');
    return rows.map(mapQuiz);
  },

  async findById(id) {
    const { rows } = await query('SELECT * FROM quizzes WHERE id = $1', [id]);
    return mapQuiz(rows[0]);
  },

  async findQuestionsByQuiz(quizId) {
    const { rows } = await query(
      'SELECT * FROM quiz_questions WHERE quiz_id = $1 ORDER BY orden ASC',
      [quizId]
    );
    return rows.map(mapQuestion);
  },

  async create({ id, nombre, categoria }) {
    const { rows } = await query(
      'INSERT INTO quizzes (id, nombre, categoria) VALUES ($1,$2,$3) RETURNING *',
      [id, nombre, categoria || '']
    );
    return mapQuiz(rows[0]);
  },

  async update(id, { nombre, categoria }) {
    const { rows } = await query(
      `UPDATE quizzes SET nombre = COALESCE($2, nombre), categoria = COALESCE($3, categoria), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, nombre, categoria]
    );
    return mapQuiz(rows[0]);
  },

  async remove(id) {
    await query('DELETE FROM quizzes WHERE id = $1', [id]);
  },

  async replaceQuestions(quizId, questions) {
    // Reemplazo transaccional simple: se borran y se insertan de nuevo,
    // reflejando el mismo comportamiento del editor original (guarda el quiz completo).
    await query('DELETE FROM quiz_questions WHERE quiz_id = $1', [quizId]);
    for (const q of questions) {
      await query(
        `INSERT INTO quiz_questions (id, quiz_id, texto, opciones, correcta_idx)
         VALUES ($1,$2,$3,$4,$5)`,
        [q.id, quizId, q.texto, JSON.stringify(q.opciones), q.correctaIdx]
      );
    }
    return this.findQuestionsByQuiz(quizId);
  },
};
