import { quizzesService } from '../services/quizzes.service.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

export const quizzesController = {
  listAll: asyncHandler(async (req, res) => {
    res.json({ success: true, data: await quizzesService.listAll() });
  }),
  getById: asyncHandler(async (req, res) => {
    res.json({ success: true, data: await quizzesService.getById(req.params.id) });
  }),
  upsert: asyncHandler(async (req, res) => {
    const quiz = await quizzesService.upsert(req.body);
    res.status(HTTP_STATUS.CREATED).json({ success: true, data: quiz });
  }),
  update: asyncHandler(async (req, res) => {
    const quiz = await quizzesService.upsert({ ...req.body, id: req.params.id });
    res.json({ success: true, data: quiz });
  }),
  remove: asyncHandler(async (req, res) => {
    await quizzesService.remove(req.params.id);
    res.status(HTTP_STATUS.NO_CONTENT).send();
  }),
};
