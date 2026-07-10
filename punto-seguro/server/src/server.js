import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import { checkDatabaseConnection } from './config/database.js';

async function start() {
  try {
    await checkDatabaseConnection();
    logger.info('Conexión a PostgreSQL verificada correctamente.');
  } catch (err) {
    logger.error('No se pudo conectar a la base de datos al iniciar:', err.message);
  }

  const app = createApp();
  app.listen(env.port, () => {
    logger.info(`Punto Seguro API escuchando en el puerto ${env.port} (${env.nodeEnv})`);
  });
}

start();
