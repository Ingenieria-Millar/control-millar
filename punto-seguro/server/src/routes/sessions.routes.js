import { Router } from 'express';
import { sessionsController } from '../controllers/sessions.controller.js';
import { validateBody } from '../middlewares/validate.js';
import { sessionSchema, attendeeSchema, attendeeUpdateSchema } from '../validators/catalog.schema.js';

export const sessionsRouter = Router();

sessionsRouter.get('/', sessionsController.listAll);
sessionsRouter.post('/', validateBody(sessionSchema), sessionsController.create);
sessionsRouter.post('/:id/asistentes', validateBody(attendeeSchema), sessionsController.addAttendee);
sessionsRouter.patch(
  '/:id/asistentes/:attendeeId',
  validateBody(attendeeUpdateSchema),
  sessionsController.updateAttendee
);
sessionsRouter.delete('/:id/asistentes/:attendeeId', sessionsController.removeAttendee);
