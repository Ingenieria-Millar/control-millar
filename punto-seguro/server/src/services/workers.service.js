import { workersRepository } from '../repositories/workers.repository.js';
import { signedDocumentsRepository } from '../repositories/signedDocuments.repository.js';
import { generateId } from '../utils/idGenerator.js';
import { AppError } from '../utils/AppError.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

export const workersService = {
  async listAll() {
    const workers = await workersRepository.findAll();
    // Adjunta el conteo de documentos firmados, igual al badge "x/9 firmados" del original.
    return Promise.all(
      workers.map(async (w) => ({
        ...w,
        documentosFirmadosCount: await signedDocumentsRepository.countByWorker(w.id),
      }))
    );
  },

  async getById(id) {
    const worker = await workersRepository.findById(id);
    if (!worker) throw new AppError('Trabajador no encontrado.', HTTP_STATUS.NOT_FOUND);
    const documentosFirmados = await signedDocumentsRepository.findByWorker(id);
    return { ...worker, documentosFirmados };
  },

  async create(data) {
    const existing = await workersRepository.findByDocumento(data.documento);
    if (existing) {
      throw new AppError(
        `Ya existe un trabajador registrado con el documento ${data.documento}.`,
        HTTP_STATUS.CONFLICT
      );
    }
    return workersRepository.create({ id: generateId('w'), ...data });
  },

  async update(id, data) {
    const worker = await workersRepository.findById(id);
    if (!worker) throw new AppError('Trabajador no encontrado.', HTTP_STATUS.NOT_FOUND);
    return workersRepository.update(id, data);
  },

  async remove(id) {
    const worker = await workersRepository.findById(id);
    if (!worker) throw new AppError('Trabajador no encontrado.', HTTP_STATUS.NOT_FOUND);
    await workersRepository.remove(id);
  },

  /**
   * Registra un documento ya firmado (el PDF llega firmado desde el cliente,
   * generado con pdf-lib en el navegador — ver Fase 4). Aquí solo se persiste.
   */
  async addSignedDocument(workerId, { nombre, hash, sizeKb, pdfBase64 }) {
    const worker = await workersRepository.findById(workerId);
    if (!worker) throw new AppError('Trabajador no encontrado.', HTTP_STATUS.NOT_FOUND);

    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    const computedSizeKb = sizeKb ?? Math.round(pdfBuffer.length / 1024);

    const doc = await signedDocumentsRepository.create({
      id: generateId('doc'),
      workerId,
      nombre,
      hash,
      sizeKb: computedSizeKb,
      pdfBuffer,
    });

    if (!worker.consentimientoFirmaElectronica) {
      await workersRepository.update(workerId, { consentimientoFirmaElectronica: true });
    }
    return doc;
  },

  async getSignedDocumentBinary(workerId, docId) {
    const doc = await signedDocumentsRepository.findBinaryById(workerId, docId);
    if (!doc) throw new AppError('Documento no encontrado.', HTTP_STATUS.NOT_FOUND);
    return doc;
  },
};
