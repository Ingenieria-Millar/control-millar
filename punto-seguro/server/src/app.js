import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from './config/env.js';
import { apiRouter } from './routes/index.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_DIST_PATH = path.resolve(__dirname, '../../client/dist');

/**
 * Crea y configura la instancia de Express.
 * Separado de server.js para poder testear la app sin levantar un puerto real.
 */
export function createApp() {
  const app = express();

  // Seguridad de cabeceras HTTP
  app.use(
    helmet({
      contentSecurityPolicy: false, // se configurará explícitamente en fases de PDF/firma
    })
  );

  // CORS restringido al origen configurado
  app.use(cors({ origin: env.corsOrigin }));

  // Compresión de respuestas
  app.use(compression());

  // Logging de peticiones HTTP
  app.use(morgan(env.isProduction ? 'combined' : 'dev'));

  // Parseo de JSON (límite generoso para payloads con datos de firma/base64)
  app.use(express.json({ limit: '20mb' }));
  app.use(express.urlencoded({ extended: true, limit: '20mb' }));

  // API
  app.use('/api', apiRouter);

  // Sirve el build del cliente (Vite) en producción
  app.use(express.static(CLIENT_DIST_PATH));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(CLIENT_DIST_PATH, 'index.html'));
  });

  // 404 y manejo centralizado de errores (siempre al final)
  app.use('/api', notFoundHandler);
  app.use(errorHandler);

  return app;
}
