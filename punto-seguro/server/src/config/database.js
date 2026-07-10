import pg from 'pg';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

const { Pool } = pg;

/**
 * Pool único de conexiones a PostgreSQL, compartido por todos los repositorios.
 * Ningún otro módulo debe crear su propia conexión: siempre se importa `pool`
 * o se usa la función `query()` de aquí, para mantener centralizado el acceso a datos.
 */
export const pool = new Pool({
  connectionString: env.databaseUrl,
  ssl: env.isProduction ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  logger.error('Error inesperado en el pool de PostgreSQL', err);
});

/**
 * Ejecuta una consulta SQL parametrizada.
 * @param {string} text - Sentencia SQL con placeholders ($1, $2, ...)
 * @param {Array<any>} params - Parámetros de la consulta
 */
export async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (duration > 200) {
    logger.warn(`Consulta lenta (${duration}ms): ${text}`);
  }
  return result;
}

export async function checkDatabaseConnection() {
  await pool.query('SELECT 1');
}
