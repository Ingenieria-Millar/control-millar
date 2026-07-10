import { Router } from 'express';
import { trainingPlanController } from '../controllers/trainingPlan.controller.js';
import { validateBody } from '../middlewares/validate.js';
import { trainingPlanItemSchema, trainingPlanItemUpdateSchema } from '../validators/catalog.schema.js';

export const trainingPlanRouter = Router();

trainingPlanRouter.get('/', trainingPlanController.listAll);
trainingPlanRouter.post('/', validateBody(trainingPlanItemSchema), trainingPlanController.create);
trainingPlanRouter.put('/:id', validateBody(trainingPlanItemUpdateSchema), trainingPlanController.update);
trainingPlanRouter.delete('/:id', trainingPlanController.remove);
