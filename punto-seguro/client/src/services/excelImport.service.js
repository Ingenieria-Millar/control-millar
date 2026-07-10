import ExcelParserWorker from '../workers/excelParser.worker.js?worker';

const MAX_FILE_SIZE_MB = 5;
const PARSE_TIMEOUT_MS = 15_000;
const ALLOWED_EXTENSIONS = ['.xlsx', '.xls', '.csv'];

/**
 * Valida el archivo ANTES de enviarlo al Worker: extensión y tamaño.
 * Primera capa de defensa (barata) contra archivos maliciosos u oversized,
 * independiente del aislamiento del Worker.
 */
function validateFile(file) {
  const name = (file.name || '').toLowerCase();
  const hasValidExtension = ALLOWED_EXTENSIONS.some((ext) => name.endsWith(ext));
  if (!hasValidExtension) {
    throw new Error('Formato no soportado. Usa un archivo .xlsx, .xls o .csv.');
  }
  const sizeMb = file.size / (1024 * 1024);
  if (sizeMb > MAX_FILE_SIZE_MB) {
    throw new Error(`El archivo pesa ${sizeMb.toFixed(1)}MB; el máximo permitido es ${MAX_FILE_SIZE_MB}MB.`);
  }
}

/**
 * Parsea un archivo de Excel/CSV en un Web Worker aislado, con timeout.
 * Ver excelParser.worker.js para la justificación de seguridad completa.
 *
 * @returns {Promise<{workers: Array, headers: string[], headerMap: Object}>}
 */
export function parseExcelFile(file) {
  validateFile(file);

  return new Promise((resolve, reject) => {
    const worker = new ExcelParserWorker();
    let settled = false;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      worker.terminate(); // corta en seco cualquier cómputo colgado (mitigación de ReDoS)
      reject(new Error('El archivo tardó demasiado en procesarse y la operación fue cancelada.'));
    }, PARSE_TIMEOUT_MS);

    worker.onmessage = (event) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      worker.terminate();
      const { ok, result, error } = event.data;
      if (ok) resolve(result);
      else reject(new Error(error || 'No se pudo leer el archivo.'));
    };

    worker.onerror = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      worker.terminate();
      reject(new Error('No se pudo leer el archivo: ' + (err.message || 'error desconocido.')));
    };

    file.arrayBuffer().then((buffer) => {
      worker.postMessage({ fileBuffer: buffer }, [buffer]);
    });
  });
}
