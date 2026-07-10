import * as XLSX from 'xlsx';
import { buildHeaderMap, mapRowToWorker } from '../services/excelMapping.js';

/**
 * Web Worker dedicado a parsear archivos de Excel/CSV con la librería `xlsx`.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO (mitigación de seguridad, no solo rendimiento):
 * `xlsx` tiene dos vulnerabilidades conocidas sin parche oficial en el registro
 * de npm:
 *   - Prototype Pollution (GHSA-4r6h-8v6p-xvw6)
 *   - ReDoS / Denegación de servicio por regex (GHSA-5pgg-2g8v-p4x9)
 *
 * Ejecutar el parseo en un Web Worker mitiga ambas de raíz:
 *   1) Un Worker tiene su propio scope global aislado. Si un archivo malicioso
 *      lograra contaminar Object.prototype, solo afectaría a este Worker
 *      desechable — nunca al hilo principal ni al resto de la aplicación.
 *   2) Si un archivo dispara un ReDoS (cuelga el hilo con un regex patológico),
 *      el hilo principal permanece responsive y el servicio que orquesta este
 *      Worker (excelImport.service.js) puede forzar `worker.terminate()` tras
 *      un timeout, matando el cálculo colgado sin congelar la UI.
 *
 * Además, se aplican límites explícitos (tamaño de archivo, número de filas)
 * como segunda capa de defensa, independientes del sandboxing del Worker.
 */

const MAX_ROWS = 5000;

self.onmessage = (event) => {
  const { fileBuffer } = event.data;
  try {
    const data = new Uint8Array(fileBuffer);

    // Opciones mínimas: desactivan el parseo de fórmulas, estilos y VBA,
    // que son las rutas de código más propensas a los problemas conocidos
    // de esta librería. Solo necesitamos valores de celda como texto.
    const workbook = XLSX.read(data, {
      type: 'array',
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
      bookVBA: false,
      bookProps: false,
    });

    const firstSheetName = workbook.SheetNames[0];
    if (!firstSheetName) {
      self.postMessage({ ok: true, result: { workers: [], headers: [] } });
      return;
    }

    const sheet = workbook.Sheets[firstSheetName];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });

    if (!rows.length) {
      self.postMessage({ ok: true, result: { workers: [], headers: [] } });
      return;
    }
    if (rows.length > MAX_ROWS) {
      self.postMessage({
        ok: false,
        error: `El archivo tiene ${rows.length} filas; el máximo permitido es ${MAX_ROWS}.`,
      });
      return;
    }

    const headers = Object.keys(rows[0]);
    const headerMap = buildHeaderMap(headers);
    const workers = rows.map((r) => mapRowToWorker(r, headerMap)).filter((w) => w.nombre || w.documento);

    self.postMessage({ ok: true, result: { workers, headers, headerMap } });
  } catch (err) {
    self.postMessage({ ok: false, error: err?.message || 'No se pudo leer el archivo.' });
  }
};
