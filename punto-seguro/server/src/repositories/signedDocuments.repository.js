import { query } from '../config/database.js';

/**
 * Documentos firmados electrónicamente. El PDF se guarda como BYTEA en Postgres
 * (decisión confirmada: mismo almacén que el resto de los datos).
 */
function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    workerId: row.worker_id,
    nombre: row.nombre,
    hash: row.hash,
    sizeKb: row.size_kb ? Number(row.size_kb) : null,
    firmadoEn: row.firmado_en,
  };
}

export const signedDocumentsRepository = {
  async findByWorker(workerId) {
    const { rows } = await query(
      `SELECT id, worker_id, nombre, hash, size_kb, firmado_en
       FROM worker_signed_documents WHERE worker_id = $1 ORDER BY firmado_en ASC`,
      [workerId]
    );
    return rows.map(mapRow);
  },

  async findBinaryById(workerId, docId) {
    const { rows } = await query(
      `SELECT pdf_data, nombre FROM worker_signed_documents WHERE worker_id = $1 AND id = $2`,
      [workerId, docId]
    );
    return rows[0] || null;
  },

  async create({ id, workerId, nombre, hash, sizeKb, pdfBuffer }) {
    const { rows } = await query(
      `INSERT INTO worker_signed_documents (id, worker_id, nombre, hash, size_kb, pdf_data)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, worker_id, nombre, hash, size_kb, firmado_en`,
      [id, workerId, nombre, hash, sizeKb ?? null, pdfBuffer]
    );
    return mapRow(rows[0]);
  },

  async countByWorker(workerId) {
    const { rows } = await query(
      'SELECT COUNT(*)::int AS total FROM worker_signed_documents WHERE worker_id = $1',
      [workerId]
    );
    return rows[0].total;
  },
};
