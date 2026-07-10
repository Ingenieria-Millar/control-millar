/**
 * Mapeo de encabezados de Excel a campos de trabajador.
 * Réplica exacta de IMPORT_ALIASES / normHdr / buildHeaderMap / mapRowToWorker
 * del archivo original, con un blindaje adicional: solo se leen/escriben las
 * claves explícitamente listadas en WORKER_FIELDS. Esto es intencional y es
 * parte de la mitigación de la vulnerabilidad de "prototype pollution" de la
 * librería `xlsx` (GHSA-4r6h-8v6p-xvw6): nunca copiamos claves arbitrarias
 * del archivo ("__proto__", "constructor", etc. quedan automáticamente fuera
 * porque no pertenecen a esta lista blanca).
 */

export const WORKER_FIELDS = ['nombre', 'documento', 'cargo', 'correo', 'celular', 'area'];

export const IMPORT_ALIASES = {
  nombre: ['nombre', 'nombre completo', 'trabajador', 'empleado', 'name'],
  documento: [
    'documento',
    'cedula',
    'cédula',
    'identificacion',
    'identificación',
    'cc',
    'id',
    'numero de identificacion',
    'número de identificación',
  ],
  cargo: ['cargo', 'puesto', 'posicion', 'posición', 'rol'],
  correo: ['correo', 'email', 'correo electronico', 'correo electrónico', 'e-mail'],
  celular: ['celular', 'telefono', 'teléfono', 'numero de celular', 'número de celular', 'movil', 'móvil', 'phone'],
  area: ['area', 'área', 'departamento', 'proceso'],
};

export function normHdr(h) {
  return String(h || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Construye el mapa {campo: encabezadoOriginal} buscando cada alias conocido.
 * Devuelve un objeto sin prototipo (Object.create(null)) para que ninguna
 * clave del archivo pueda "heredar" o pisar métodos de Object.prototype.
 */
export function buildHeaderMap(headers) {
  const normalized = headers.map(normHdr);
  const map = Object.create(null);
  WORKER_FIELDS.forEach((field) => {
    const aliases = IMPORT_ALIASES[field];
    const idx = normalized.findIndex((h) => aliases.includes(h));
    if (idx !== -1) map[field] = headers[idx];
  });
  return map;
}

/**
 * Extrae los campos de trabajador de una fila cruda del Excel, usando
 * solo el mapa de encabezados (lista blanca) — nunca copia la fila completa.
 */
export function mapRowToWorker(row, headerMap) {
  const get = (field) => {
    const key = headerMap[field];
    if (key === undefined) return '';
    const value = row[key];
    return value === undefined || value === null ? '' : String(value).trim();
  };
  return {
    nombre: get('nombre'),
    documento: get('documento'),
    cargo: get('cargo'),
    correo: get('correo'),
    celular: get('celular'),
    area: get('area'),
  };
}
