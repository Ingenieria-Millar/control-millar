import crypto from 'node:crypto';

/**
 * Genera IDs legibles con prefijo, ej: "w_9f3a1b2c".
 * Usa crypto.randomUUID (mejor entropía que Math.random del original)
 * mientras conserva el mismo estilo de identificador con prefijo semántico.
 */
export function generateId(prefix) {
  const raw = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  return `${prefix}_${raw}`;
}
