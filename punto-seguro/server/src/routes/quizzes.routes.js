import { Router } from 'express';
import { quizzesController } from '../controllers/quizzes.controller.js';
import { validateBody } from '../middlewares/validate.js';
import { quizSchema } from '../validators/catalog.schema.js';

export const quizzesRouter = Router();

quizzesRouter.get('/', quizzesController.listAll);
quizzesRouter.get('/:id', quizzesController.getById);
quizzesRouter.post('/', validateBody(quizSchema), quizzesController.upsert);
quizzesRouter.put('/:id', validateBody(quizSchema), quizzesController.update);
quizzesRouter.delete('/:id', quizzesController.remove);
