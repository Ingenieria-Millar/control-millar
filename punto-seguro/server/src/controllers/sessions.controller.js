import { sessionsService } from '../services/sessions.service.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

export const sessionsController = {
  listAll: asyncHandler(async (req, res) => {
    res.json({ success: true, data: await sessionsService.listAll() });
  }),
  create: asyncHandler(async (req, res) => {
    const session = await sessionsService.create(req.body);
    res.status(HTTP_STATUS.CREATED).json({ success: true, data: session });
  }),
  addAttendee: asyncHandler(async (req, res) => {
    const attendee = await sessionsService.addAttendee(req.params.id, req.body);
    res.status(HTTP_STATUS.CREATED).json({ success: true, data: attendee });
  }),
  updateAttendee: asyncHandler(async (req, res) => {
    const attendee = await sessionsService.updateAttendee(req.params.id, req.params.attendeeId, req.body);
    res.json({ success: true, data: attendee });
  }),
  removeAttendee: asyncHandler(async (req, res) => {
    await sessionsService.removeAttendee(req.params.id, req.params.attendeeId);
    res.status(HTTP_STATUS.NO_CONTENT).send();
  }),
};
