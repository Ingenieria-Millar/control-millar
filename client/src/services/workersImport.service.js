import { workersRepository } from '../repositories/workers.repository.js';
import { todayISO } from '../utils/dateUtils.js';

/**
 * Importa en bloque los trabajadores ya parseados desde Excel (ver
 * excelImport.service.js). Sustituye la lógica original que revisaba
 * duplicados contra `APP.state.workers` en memoria: ahora cada fila se
 * intenta crear contra la API, y el propio backend (restricción UNIQUE de
 * la Fase 2) decide si es un duplicado — una sola fuente de verdad, sin
 * condiciones de carrera entre pestañas/usuarios concurrentes.
 *
 * Diferencia intencional respecto al original: el backend exige `documento`
 * no vacío (mejora de integridad de datos, Fase 2). Las filas sin documento
 * se reportan como "omitidas por datos incompletos" en vez de importarse
 * con un documento vacío.
 *
 * @returns {Promise<{added: number, skippedDuplicates: number, skippedInvalid: number, errors: string[]}>}
 */
export async function importWorkersFromRows(rows) {
  let added = 0;
  let skippedDuplicates = 0;
  let skippedInvalid = 0;
  const errors = [];

  for (const row of rows) {
    const documento = (row.documento || '').trim();
    const nombre = (row.nombre || '').trim() || '(sin nombre)';

    if (!documento) {
      skippedInvalid++;
      continue;
    }

    try {
      await workersRepository.create({
        nombre,
        documento,
        cargo: row.cargo || '',
        correo: row.correo || '',
        celular: row.celular || '',
        area: row.area || '',
        fechaIngreso: todayISO(),
      });
      added++;
    } catch (err) {
      if (err.message && err.message.toLowerCase().includes('ya existe un trabajador')) {
        skippedDuplicates++;
      } else {
        errors.push(`${documento}: ${err.message}`);
      }
    }
  }

  return { added, skippedDuplicates, skippedInvalid, errors };
}
