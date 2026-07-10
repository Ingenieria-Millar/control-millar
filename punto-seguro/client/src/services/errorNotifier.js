import { showToast } from '../helpers/toast.js';

/**
 * Envuelve una operación asíncrona y muestra un toast de error si falla,
 * replicando el comportamiento de `persist()`/`safeGet()` en el archivo original
 * (que nunca dejaban una promesa rechazada sin avisar al usuario).
 * Relanza el error para que la vista decida si necesita reaccionar además del toast.
 */
export async function withErrorToast(operation, friendlyMessage) {
  try {
    return await operation();
  } catch (err) {
    showToast(friendlyMessage || err.message || 'Ocurrió un error inesperado.', 'error');
    throw err;
  }
}
