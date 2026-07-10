/**
 * Utilidades de texto: escape HTML, normalización de nombres de archivo,
 * eliminación de acentos y sanitización de nombres — idénticas al original.
 */

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(
    /[&<>"']/g,
    (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m])
  );
}

export function stripAccents(str) {
  return str.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ñ/g, 'n').replace(/Ñ/g, 'N');
}

/**
 * Normaliza el nombre de un anexo a una clave estable (fileKey), usada para
 * relacionar plantillas con sus posiciones de firma. Debe coincidir exactamente
 * con `normalizeAnnexName` del backend (server/src/services/annexTemplates.service.js).
 */
export function normalizeAnnexName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\.pdf$/i, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function sanitizeFilename(nombre) {
  return 'firmado_' + nombre.replace(/[^a-zA-Z0-9._-]/g, '_');
}
