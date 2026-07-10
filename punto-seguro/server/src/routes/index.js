import { Router } from 'express';
import { healthRouter } from './health.routes.js';
import { workersRouter } from './workers.routes.js';
import { trainingPlanRouter } from './trainingPlan.routes.js';
import { sessionsRouter } from './sessions.routes.js';
import { quizzesRouter } from './quizzes.routes.js';
import { attemptsRouter } from './attempts.routes.js';
import { annexTemplatesRouter } from './annexTemplates.routes.js';
import { signaturePositionsRouter } from './signaturePositions.routes.js';
import { inductionContentRouter } from './inductionContent.routes.js';

/**
 * Router raíz de la API. Cada módulo de dominio se monta aquí,
 * manteniendo un único punto de entrada: /api/*.
 * Las rutas públicas (enlaces de onboarding y quiz) reutilizan estos mismos
 * endpoints de solo lectura; no hay endpoints separados "públicos" porque
 * ya no existe el concepto de storage "shared" vs "privado" del original.
 */
export const apiRouter = Router();

apiRouter.use('/health', healthRouter);
apiRouter.use('/trabajadores', workersRouter);
apiRouter.use('/capacitaciones/plan', trainingPlanRouter);
apiRouter.use('/capacitaciones/sesiones', sessionsRouter);
apiRouter.use('/evaluaciones', quizzesRouter);
apiRouter.use('/resultados', attemptsRouter);
apiRouter.use('/paquete/plantillas', annexTemplatesRouter);
apiRouter.use('/paquete/posiciones-firma', signaturePositionsRouter);
apiRouter.use('/paquete/induccion', inductionContentRouter);

// Fase 4/5 añadirán: /api/pdf (sellado si se mueve al server) y /api/excel (si aplica)
