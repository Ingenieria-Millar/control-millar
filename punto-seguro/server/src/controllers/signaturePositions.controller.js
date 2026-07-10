import { signaturePositionsService } from '../services/signaturePositions.service.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

export const signaturePositionsController = {
  listAll: asyncHandler(async (req, res) => {
    res.json({ success: true, data: await signaturePositionsService.listAll() });
  }),
  upsert: asyncHandler(async (req, res) => {
    const pos = await signaturePositionsService.upsert(req.body);
    res.status(HTTP_STATUS.CREATED).json({ success: true, data: pos });
  }),
  remove: asyncHandler(async (req, res) => {
    await signaturePositionsService.remove(req.params.fileKey);
    res.status(HTTP_STATUS.NO_CONTENT).send();
  }),
};
