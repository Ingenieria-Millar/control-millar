import { inductionContentService } from '../services/inductionContent.service.js';
import { asyncHandler } from '../middlewares/errorHandler.js';

export const inductionContentController = {
  get: asyncHandler(async (req, res) => {
    res.json({ success: true, data: await inductionContentService.get() });
  }),
  upsert: asyncHandler(async (req, res) => {
    const content = await inductionContentService.upsert(req.body);
    res.json({ success: true, data: content });
  }),
};
