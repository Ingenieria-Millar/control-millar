import { AppError } from '../utils/AppError.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

/**
 * Middleware genérico: valida req.body contra un esquema zod.
 * Si es válido, reemplaza req.body por los datos ya parseados/normalizados (trim, defaults).
 * Si no, corta la petición con 400 y el detalle de cada campo — evita repetir
 * este bloque try/parse en cada controlador.
 */
export function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const details = result.error.issues.map((i) => ({
        campo: i.path.join('.'),
        mensaje: i.message,
      }));
      return next(new AppError('Datos inválidos.', HTTP_STATUS.BAD_REQUEST, details));
    }
    req.body = result.data;
    next();
  };
}
