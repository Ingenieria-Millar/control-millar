import { inductionContentRepository } from '../repositories/inductionContent.repository.js';

export const inductionContentService = {
  get: () => inductionContentRepository.get(),
  upsert: (data) => inductionContentRepository.upsert(data),
};
