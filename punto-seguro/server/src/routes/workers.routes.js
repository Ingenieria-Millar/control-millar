import { Router } from 'express';
import { workersController } from '../controllers/workers.controller.js';
import { validateBody } from '../middlewares/validate.js';
import { workerSchema, workerUpdateSchema, signedDocumentSchema } from '../validators/worker.schema.js';

export const workersRouter = Router();

workersRouter.get('/', workersController.listAll);
workersRouter.get('/:id', workersController.getById);
workersRouter.post('/', validateBody(workerSchema), workersController.create);
workersRouter.put('/:id', validateBody(workerUpdateSchema), workersController.update);
workersRouter.delete('/:id', workersController.remove);

workersRouter.post(
  '/:id/documentos-firmados',
  validateBody(signedDocumentSchema),
  workersController.addSignedDocument
);
workersRouter.get('/:id/documentos-firmados/:docId', workersController.downloadSignedDocument);
