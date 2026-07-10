import { Router } from 'express';
import { signaturePositionsController } from '../controllers/signaturePositions.controller.js';
import { validateBody } from '../middlewares/validate.js';
import { signaturePositionSchema } from '../validators/catalog.schema.js';

export const signaturePositionsRouter = Router();

signaturePositionsRouter.get('/', signaturePositionsController.listAll);
signaturePositionsRouter.post('/', validateBody(signaturePositionSchema), signaturePositionsController.upsert);
signaturePositionsRouter.delete('/:fileKey', signaturePositionsController.remove);
