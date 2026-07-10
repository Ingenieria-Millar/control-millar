import { HTTP_STATUS } from '../constants/httpStatus.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { env } from '../config/env.js';

/**
 * Middleware final de manejo de errores (4 argumentos = Express lo reconoce como tal).
 * Único lugar donde se decide el formato de respuesta de error de toda la API.
 */
// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  const isAppError = err instanceof AppError;
  const statusCode = isAppError ? err.statusCode : HTTP_STATUS.INTERNAL_SERVER_ERROR;

  if (!isAppError || statusCode >= 500) {
    logger.error(`${req.method} ${req.originalUrl} →`, err);
  }

  res.status(statusCode).json({
    success: false,
    message: isAppError ? err.message : 'Ha ocurrido un error inesperado en el servidor.',
    details: isAppError ? err.details : undefined,
    stack: env.isProduction ? undefined : err.stack,
  });
}

/**
 * Envuelve un handler async para que sus rechazos de promesa
 * lleguen automáticamente a errorHandler (evita try/catch repetido en cada ruta).
 */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Middleware para rutas no encontradas (404), colocado después de todas las rutas.
 */
export function notFoundHandler(req, res) {
  res.status(HTTP_STATUS.NOT_FOUND).json({
    success: false,
    message: `Ruta no encontrada: ${req.method} ${req.originalUrl}`,
  });
}
