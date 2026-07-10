import { API_BASE_URL } from '../config/apiConfig.js';

/**
 * Cliente HTTP centralizado del frontend.
 * Reemplaza las antiguas `persist()` / `safeGet()` basadas en `window.storage`:
 * ahora todos los repositorios del cliente pasan por aquí para hablar con la API real.
 */
async function request(path, { method = 'GET', body, headers = {}, isFormData = false } = {}) {
  const options = {
    method,
    headers: isFormData ? headers : { 'Content-Type': 'application/json', ...headers },
  };

  if (body !== undefined) {
    options.body = isFormData ? body : JSON.stringify(body);
  }

  const response = await fetch(`${API_BASE_URL}${path}`, options);
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.blob();

  if (!response.ok) {
    const message = payload && payload.message ? payload.message : `Error HTTP ${response.status}`;
    throw new Error(message);
  }

  return payload;
}

export const httpClient = {
  get: (path) => request(path),
  post: (path, body, opts) => request(path, { method: 'POST', body, ...opts }),
  put: (path, body, opts) => request(path, { method: 'PUT', body, ...opts }),
  patch: (path, body, opts) => request(path, { method: 'PATCH', body, ...opts }),
  delete: (path) => request(path, { method: 'DELETE' }),
};
