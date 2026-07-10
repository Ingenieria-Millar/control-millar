import { z } from 'zod';

/**
 * Esquema de validación para trabajadores.
 * Centraliza las reglas que en el archivo original vivían implícitas en `required`
 * de los <input> del formulario (sin validación real del lado del servidor).
 */
export const workerSchema = z.object({
  nombre: z.string().trim().min(1, 'El nombre es obligatorio').max(200),
  documento: z.string().trim().min(1, 'El número de identificación es obligatorio').max(50),
  cargo: z.string().trim().max(150).optional().default(''),
  fechaIngreso: z.string().optional().nullable(),
  correo: z.string().trim().max(200).email('Correo inválido').optional().or(z.literal('')),
  celular: z.string().trim().max(30).optional().default(''),
  area: z.string().trim().max(150).optional().default(''),
});

export const workerUpdateSchema = workerSchema.partial();

export const signedDocumentSchema = z.object({
  nombre: z.string().trim().min(1).max(255),
  hash: z.string().trim().min(1),
  sizeKb: z.number().nonnegative().optional(),
  pdfBase64: z.string().min(1, 'El PDF firmado es obligatorio'),
});
