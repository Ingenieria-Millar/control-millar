import { trainingPlanService } from '../services/trainingPlan.service.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

export const trainingPlanController = {
  listAll: asyncHandler(async (req, res) => {
    res.json({ success: true, data: await trainingPlanService.listAll() });
  }),
  create: asyncHandler(async (req, res) => {
    const item = await trainingPlanService.create(req.body);
    res.status(HTTP_STATUS.CREATED).json({ success: true, data: item });
  }),
  update: asyncHandler(async (req, res) => {
    const item = await trainingPlanService.update(req.params.id, req.body);
    res.json({ success: true, data: item });
  }),
  remove: asyncHandler(async (req, res) => {
    await trainingPlanService.remove(req.params.id);
    res.status(HTTP_STATUS.NO_CONTENT).send();
  }),
};
