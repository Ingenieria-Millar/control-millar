import { Router } from 'express';
import { annexTemplatesController } from '../controllers/annexTemplates.controller.js';
import { validateBody } from '../middlewares/validate.js';
import { annexTemplateUploadSchema } from '../validators/catalog.schema.js';

export const annexTemplatesRouter = Router();

annexTemplatesRouter.get('/', annexTemplatesController.listAll);
annexTemplatesRouter.get('/:id/archivo', annexTemplatesController.download);
annexTemplatesRouter.post('/', validateBody(annexTemplateUploadSchema), annexTemplatesController.upload);
annexTemplatesRouter.delete('/:id', annexTemplatesController.remove);
