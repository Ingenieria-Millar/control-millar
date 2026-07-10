import { signaturePositionsRepository } from '../repositories/signaturePositions.repository.js';

export const signaturePositionsService = {
  listAll: () => signaturePositionsRepository.findAll(),
  upsert: (data) => signaturePositionsRepository.upsert(data),
  remove: (fileKey) => signaturePositionsRepository.remove(fileKey),
};
