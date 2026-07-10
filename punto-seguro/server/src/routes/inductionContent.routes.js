import { Router } from 'express';
import { inductionContentController } from '../controllers/inductionContent.controller.js';
import { validateBody } from '../middlewares/validate.js';
import { inductionContentSchema } from '../validators/catalog.schema.js';

export const inductionContentRouter = Router();

inductionContentRouter.get('/', inductionContentController.get);
inductionContentRouter.put('/', validateBody(inductionContentSchema), inductionContentController.upsert);
