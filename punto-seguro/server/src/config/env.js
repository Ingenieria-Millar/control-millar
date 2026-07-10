import 'dotenv/config';

/**
 * Configuración centralizada de entorno.
 * Único punto de lectura de `process.env` en todo el backend:
 * el resto del código importa `env` en lugar de tocar process.env directamente.
 */
function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Falta la variable de entorno obligatoria: ${name}`);
  }
  return value;
}

export const env = Object.freeze({
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 4000),
  databaseUrl: required('DATABASE_URL'),
  jwtSecret: required('JWT_SECRET', 'dev-secret-not-for-production'),
  corsOrigin: process.env.CORS_ORIGIN || '*',
  maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 15),
});
