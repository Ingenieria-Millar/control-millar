import { inductionContentRepository } from '../repositories/inductionContent.repository.js';
import { withErrorToast } from './errorNotifier.js';

export const inductionContentService = {
  async get() {
    const { data } = await withErrorToast(
      () => inductionContentRepository.get(),
      'No se pudo cargar el contenido de inducción.'
    );
    return data;
  },
  async update(content) {
    const { data } = await withErrorToast(
      () => inductionContentRepository.update(content),
      'No se pudo guardar el contenido de inducción.'
    );
    return data;
  },
};
