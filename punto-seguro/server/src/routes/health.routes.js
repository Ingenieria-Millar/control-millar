import { Router } from 'express';
import { checkDatabaseConnection } from '../config/database.js';
import { asyncHandler } from '../middlewares/errorHandler.js';

export const healthRouter = Router();

/**
 * GET /api/health
 * Usado por Render (healthCheckPath) para verificar que el servicio y la BD están vivos.
 */
healthRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    await checkDatabaseConnection();
    res.json({
      success: true,
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  })
);
