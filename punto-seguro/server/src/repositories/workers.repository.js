import { query } from '../config/database.js';

/**
 * Acceso a datos de trabajadores. Único módulo que sabe escribir SQL para esta tabla;
 * el resto de la app (services/controllers) solo llama a estas funciones.
 */
function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    documento: row.documento,
    cargo: row.cargo,
    fechaIngreso: row.fecha_ingreso,
    correo: row.correo,
    celular: row.celular,
    area: row.area,
    consentimientoFirmaElectronica: row.consentimiento_firma_electronica,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const workersRepository = {
  async findAll() {
    const { rows } = await query('SELECT * FROM workers ORDER BY created_at ASC');
    return rows.map(mapRow);
  },

  async findById(id) {
    const { rows } = await query('SELECT * FROM workers WHERE id = $1', [id]);
    return mapRow(rows[0]);
  },

  async findByDocumento(documento) {
    const { rows } = await query('SELECT * FROM workers WHERE documento = $1', [documento]);
    return mapRow(rows[0]);
  },

  async create({ id, nombre, documento, cargo, fechaIngreso, correo, celular, area }) {
    const { rows } = await query(
      `INSERT INTO workers (id, nombre, documento, cargo, fecha_ingreso, correo, celular, area)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, nombre, documento, cargo || '', fechaIngreso || null, correo || '', celular || '', area || '']
    );
    return mapRow(rows[0]);
  },

  async update(id, fields) {
    const columns = {
      nombre: 'nombre',
      documento: 'documento',
      cargo: 'cargo',
      fechaIngreso: 'fecha_ingreso',
      correo: 'correo',
      celular: 'celular',
      area: 'area',
      consentimientoFirmaElectronica: 'consentimiento_firma_electronica',
    };
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
    if (sets.length === 0) return this.findById(id);
    sets.push(`updated_at = now()`);
    values.push(id);
    const { rows } = await query(
      `UPDATE workers SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`,
      values
    );
    return mapRow(rows[0]);
  },

  async remove(id) {
    await query('DELETE FROM workers WHERE id = $1', [id]);
  },
};
