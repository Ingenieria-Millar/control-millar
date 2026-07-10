import { workersService } from '../services/workers.service.js';
import { asyncHandler } from '../middlewares/errorHandler.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

export const workersController = {
  listAll: asyncHandler(async (req, res) => {
    const workers = await workersService.listAll();
    res.json({ success: true, data: workers });
  }),

  getById: asyncHandler(async (req, res) => {
    const worker = await workersService.getById(req.params.id);
    res.json({ success: true, data: worker });
  }),

  create: asyncHandler(async (req, res) => {
    const worker = await workersService.create(req.body);
    res.status(HTTP_STATUS.CREATED).json({ success: true, data: worker });
  }),

  update: asyncHandler(async (req, res) => {
    const worker = await workersService.update(req.params.id, req.body);
    res.json({ success: true, data: worker });
  }),

  remove: asyncHandler(async (req, res) => {
    await workersService.remove(req.params.id);
    res.status(HTTP_STATUS.NO_CONTENT).send();
  }),

  addSignedDocument: asyncHandler(async (req, res) => {
    const doc = await workersService.addSignedDocument(req.params.id, req.body);
    res.status(HTTP_STATUS.CREATED).json({ success: true, data: doc });
  }),

  downloadSignedDocument: asyncHandler(async (req, res) => {
    const { pdf_data: pdfData, nombre } = await workersService.getSignedDocumentBinary(
      req.params.id,
      req.params.docId
    );
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="firmado_${nombre}"`);
    res.send(pdfData);
  }),
};
