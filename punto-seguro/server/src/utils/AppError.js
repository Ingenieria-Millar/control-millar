/**
 * Error de aplicación con código HTTP asociado.
 * Los servicios/controladores lanzan `AppError` en vez de errores genéricos,
 * y el middleware centralizado de errores decide cómo responder según el `statusCode`.
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}
