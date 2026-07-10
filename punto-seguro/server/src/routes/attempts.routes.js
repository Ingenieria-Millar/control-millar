import { Router } from 'express';
import { attemptsController } from '../controllers/attempts.controller.js';
import { validateBody } from '../middlewares/validate.js';
import { attemptSchema } from '../validators/catalog.schema.js';

export const attemptsRouter = Router();

attemptsRouter.get('/', attemptsController.listAll);
attemptsRouter.post('/', validateBody(attemptSchema), attemptsController.create);
