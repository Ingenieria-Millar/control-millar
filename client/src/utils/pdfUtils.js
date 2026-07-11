/**
 * Utilidades específicas de manipulación de PDF/imagen en el navegador.
 */
export function dataUrlToBytes(dataUrl) {
  const binary = atob(dataUrl.split(',')[1]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
