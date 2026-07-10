/**
 * Generador de IDs temporales del lado del cliente. Solo se usa para "keys" de
 * UI antes de que un registro exista en el servidor (ej. filas nuevas en el
 * asistente de firma); los IDs definitivos siempre los genera el backend
 * (ver server/src/utils/idGenerator.js), evitando colisiones entre clientes.
 */
export function uid(prefix) {
  return prefix + '_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
}
