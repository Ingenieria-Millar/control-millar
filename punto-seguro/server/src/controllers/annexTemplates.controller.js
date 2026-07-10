import { annexTemplatesService } from '../services/annexTemplates.service.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

export const annexTemplatesController = {
  listAll: asyncHandler(async (req, res) => {
    res.json({ success: true, data: await annexTemplatesService.listAll() });
  }),
  download: asyncHandler(async (req, res) => {
    const { pdf_data: pdfData, nombre } = await annexTemplatesService.getBinary(req.params.id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${nombre}"`);
    res.send(pdfData);
  }),
  upload: asyncHandler(async (req, res) => {
    const tpl = await annexTemplatesService.upload(req.body);
    res.status(HTTP_STATUS.CREATED).json({ success: true, data: tpl });
  }),
  remove: asyncHandler(async (req, res) => {
    await annexTemplatesService.remove(req.params.id);
    res.status(HTTP_STATUS.NO_CONTENT).send();
  }),
};
