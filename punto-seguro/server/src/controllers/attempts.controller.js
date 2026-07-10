import { attemptsService } from '../services/attempts.service.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

export const attemptsController = {
  listAll: asyncHandler(async (req, res) => {
    res.json({ success: true, data: await attemptsService.listAll() });
  }),
  create: asyncHandler(async (req, res) => {
    const attempt = await attemptsService.create(req.body);
    res.status(HTTP_STATUS.CREATED).json({ success: true, data: attempt });
  }),
};
