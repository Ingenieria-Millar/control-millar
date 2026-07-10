import { annexTemplatesRepository } from '../repositories/annexTemplates.repository.js';
import { generateId } from '../utils/idGenerator.js';
import { AppError } from '../utils/AppError.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

function normalizeAnnexName(name) {
  // Misma normalización que normalizeAnnexName() del archivo original,
  // para que las posiciones de firma guardadas por fileKey sigan calzando.
  return String(name || '')
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export const annexTemplatesService = {
  listAll: () => annexTemplatesRepository.findAll(),

  async getBinary(id) {
    const tpl = await annexTemplatesRepository.findBinaryById(id);
    if (!tpl) throw new AppError('Plantilla no encontrada.', HTTP_STATUS.NOT_FOUND);
    return tpl;
  },

  async upload({ nombre, pdfBase64 }) {
    const fileKey = normalizeAnnexName(nombre);
    const existing = await annexTemplatesRepository.findByFileKey(fileKey);
    if (existing) {
      throw new AppError(
        `Ya existe una plantilla con un nombre equivalente ("${existing.nombre}").`,
        HTTP_STATUS.CONFLICT
      );
    }
    const pdfBuffer = Buffer.from(pdfBase64, 'base64');
    return annexTemplatesRepository.create({
      id: generateId('tpl'),
      nombre,
      fileKey,
      sizeKb: Math.round(pdfBuffer.length / 1024),
      pdfBuffer,
    });
  },

  remove: (id) => annexTemplatesRepository.remove(id),
};

export { normalizeAnnexName };
