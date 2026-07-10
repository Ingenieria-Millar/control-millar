import { query } from '../config/database.js';

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    nombre: row.nombre,
    fileKey: row.file_key,
    sizeKb: row.size_kb ? Number(row.size_kb) : null,
    subidoEn: row.subido_en,
  };
}

export const annexTemplatesRepository = {
  async findAll() {
    const { rows } = await query(
      'SELECT id, nombre, file_key, size_kb, subido_en FROM annex_templates ORDER BY subido_en ASC'
    );
    return rows.map(mapRow);
  },

  async findBinaryById(id) {
    const { rows } = await query('SELECT pdf_data, nombre FROM annex_templates WHERE id = $1', [id]);
    return rows[0] || null;
  },

  async findByFileKey(fileKey) {
    const { rows } = await query('SELECT * FROM annex_templates WHERE file_key = $1', [fileKey]);
    return mapRow(rows[0]);
  },

  async create({ id, nombre, fileKey, sizeKb, pdfBuffer }) {
    const { rows } = await query(
      `INSERT INTO annex_templates (id, nombre, file_key, size_kb, pdf_data)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id, nombre, file_key, size_kb, subido_en`,
      [id, nombre, fileKey, sizeKb ?? null, pdfBuffer]
    );
    return mapRow(rows[0]);
  },

  async remove(id) {
    await query('DELETE FROM annex_templates WHERE id = $1', [id]);
  },
};
