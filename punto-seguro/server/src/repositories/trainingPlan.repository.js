import { query } from '../config/database.js';

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    mes: row.mes,
    tema: row.tema,
    dirigidoA: row.dirigido_a,
    horas: row.horas,
    responsable: row.responsable,
  };
}

export const trainingPlanRepository = {
  async findAll() {
    const { rows } = await query('SELECT * FROM training_plan_items ORDER BY orden ASC');
    return rows.map(mapRow);
  },

  async create({ id, mes, tema, dirigidoA, horas, responsable }) {
    const { rows } = await query(
      `INSERT INTO training_plan_items (id, mes, tema, dirigido_a, horas, responsable)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, mes, tema, dirigidoA || '', horas || '', responsable || '']
    );
    return mapRow(rows[0]);
  },

  async update(id, fields) {
    const columns = { mes: 'mes', tema: 'tema', dirigidoA: 'dirigido_a', horas: 'horas', responsable: 'responsable' };
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
    values.push(id);
    const { rows } = await query(
      `UPDATE training_plan_items SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return mapRow(rows[0]);
  },

  async remove(id) {
    await query('DELETE FROM training_plan_items WHERE id = $1', [id]);
  },
};
