import { PDFDocument, rgb, StandardFonts } from 'pdf-lib';
import { dataUrlToBytes } from '../utils/pdfUtils.js';
import { sha256Hex, bytesToBase64, bytesToBlobUrl } from '../utils/binaryUtils.js';
import { stripAccents, normalizeAnnexName } from '../utils/textUtils.js';
import { formatDateTime } from '../utils/dateUtils.js';

/**
 * Estampa la imagen de la firma (PNG en base64) sobre un PDF, en la posición
 * relativa indicada, y agrega el pie de firma legal. Lógica idéntica a
 * `stampSignatureOnPdf` del archivo original, ahora importando pdf-lib como
 * módulo npm (antes se cargaba como variable global `PDFLib` vía CDN).
 *
 * @returns {{bytes: Uint8Array, hash: string}} PDF firmado y su SHA-256.
 */
export async function stampSignatureOnPdf(pdfArrayBuffer, sigDataUrl, meta, position) {
  if (
    !position ||
    typeof position.pageIndex !== 'number' ||
    typeof position.xRatio !== 'number' ||
    typeof position.yRatio !== 'number'
  ) {
    throw new Error('POSICION_NO_DEFINIDA');
  }

  const pdfDoc = await PDFDocument.load(pdfArrayBuffer);
  const pngBytes = dataUrlToBytes(sigDataUrl);
  const pngImage = await pdfDoc.embedPng(pngBytes);
  const pages = pdfDoc.getPages();
  const pageIndex = Math.min(Math.max(position.pageIndex, 0), pages.length - 1);
  const targetPage = pages[pageIndex];
  const { width, height } = targetPage.getSize();

  const signatureWidth = (position.widthRatio || 0.22) * width;
  const signatureHeight = (pngImage.height / pngImage.width) * signatureWidth;
  const x = position.xRatio * width;
  const yFromTop = position.yRatio * height;
  const y = height - yFromTop - signatureHeight;

  targetPage.drawImage(pngImage, { x, y: Math.max(y, 4), width: signatureWidth, height: signatureHeight });

  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const legalLines = [
    stripAccents('Firmado electronicamente por ' + meta.nombre),
    stripAccents('C.C. ' + meta.documento + '  -  ' + meta.fechaHora),
    'Mecanismo: firma electronica (Ley 527/1999, Decreto 2364/2012)',
  ];
  legalLines.forEach((line, i) => {
    targetPage.drawText(line, { x, y: Math.max(y - 4 - i * 9, 2), size: 6.5, font, color: rgb(0.35, 0.38, 0.42) });
  });

  const out = await pdfDoc.save();
  const hash = await sha256Hex(out);
  return { bytes: out, hash };
}

/**
 * Firma todos los anexos de un trabajador con un único trazo de firma,
 * usando la posición guardada para cada anexo (por fileKey).
 * `positions` es el mapa {fileKey: {pageIndex,xRatio,yRatio,widthRatio}}.
 *
 * A diferencia del original, NO genera el `id` del documento aquí (uid('doc')):
 * el id definitivo lo asigna el servidor al persistir (Fase 2/3), evitando IDs
 * huérfanos si la subida llegara a fallar.
 */
export async function signAllAnnexes(worker, annexFiles, sigDataUrl, positions, onProgress) {
  const sinPosicion = annexFiles.filter((f) => !positions || !positions[normalizeAnnexName(f.name)]);
  if (sinPosicion.length > 0) {
    throw new Error('POSICION_FALTANTE:' + sinPosicion.map((f) => `"${f.name}"`).join(', '));
  }

  const results = [];
  const fechaHora = formatDateTime(new Date().toISOString());

  for (let i = 0; i < annexFiles.length; i++) {
    const file = annexFiles[i];
    onProgress?.(i, annexFiles.length, file.name);

    const buffer = await file.arrayBuffer();
    const fileKey = normalizeAnnexName(file.name);
    const { bytes, hash } = await stampSignatureOnPdf(
      buffer,
      sigDataUrl,
      { nombre: worker.nombre, documento: worker.documento, fechaHora },
      positions[fileKey]
    );
    const pdfBase64 = bytesToBase64(bytes);

    results.push({
      nombre: file.name,
      hash,
      firmadoEn: new Date().toISOString(),
      blobUrl: bytesToBlobUrl(bytes, 'application/pdf'),
      pdfBase64,
      sizeKb: Math.round(bytes.length / 1024),
    });
  }

  return results;
}
