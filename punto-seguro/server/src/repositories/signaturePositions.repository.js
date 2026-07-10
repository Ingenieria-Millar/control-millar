import { query } from '../config/database.js';

function mapRow(row) {
  if (!row) return null;
  return {
    fileKey: row.file_key,
    pageIndex: row.page_index,
    xRatio: Number(row.x_ratio),
    yRatio: Number(row.y_ratio),
    widthRatio: Number(row.width_ratio),
  };
}

export const signaturePositionsRepository = {
  async findAll() {
    const { rows } = await query('SELECT * FROM signature_positions');
    // Se devuelve como mapa {fileKey: posicion} para calzar 1:1 con
    // la estructura `APP.state.signaturePositions` del frontend original.
    const map = {};
    rows.forEach((r) => {
      map[r.file_key] = mapRow(r);
    });
    return map;
  },

  async upsert({ fileKey, pageIndex, xRatio, yRatio, widthRatio }) {
    const { rows } = await query(
      `INSERT INTO signature_positions (file_key, page_index, x_ratio, y_ratio, width_ratio)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (file_key) DO UPDATE SET
         page_index = EXCLUDED.page_index,
         x_ratio = EXCLUDED.x_ratio,
         y_ratio = EXCLUDED.y_ratio,
         width_ratio = EXCLUDED.width_ratio,
         updated_at = now()
       RETURNING *`,
      [fileKey, pageIndex, xRatio, yRatio, widthRatio ?? 0.22]
    );
    return mapRow(rows[0]);
  },

  async remove(fileKey) {
    await query('DELETE FROM signature_positions WHERE file_key = $1', [fileKey]);
  },
};
