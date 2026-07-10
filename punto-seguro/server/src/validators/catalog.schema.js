import { z } from 'zod';

export const trainingPlanItemSchema = z.object({
  mes: z.string().trim().min(1).max(50),
  tema: z.string().trim().min(1).max(300),
  dirigidoA: z.string().trim().max(150).optional().default(''),
  horas: z.string().trim().max(20).optional().default(''),
  responsable: z.string().trim().max(150).optional().default(''),
});
export const trainingPlanItemUpdateSchema = trainingPlanItemSchema.partial();

export const sessionSchema = z.object({
  tema: z.string().trim().min(1).max(300),
  fecha: z.string().min(1, 'La fecha es obligatoria'),
  horas: z.string().trim().max(20).optional().default(''),
  dirigidoA: z.string().trim().max(150).optional().default('Todo el personal'),
  responsable: z.string().trim().max(150).optional().default(''),
});

export const attendeeSchema = z
  .object({
    workerId: z.string().trim().optional().nullable(),
    manualName: z.string().trim().max(200).optional(),
  })
  .refine((d) => d.workerId || d.manualName, {
    message: 'Debes indicar un trabajador registrado o un nombre manual.',
  });

export const attendeeUpdateSchema = z.object({
  asistio: z.boolean().optional(),
  evaluado: z.boolean().optional(),
});

const questionSchema = z.object({
  id: z.string().optional(),
  texto: z.string().trim().min(1).max(500),
  opciones: z.array(z.string().trim().min(1)).min(2, 'Cada pregunta necesita al menos 2 opciones'),
  correctaIdx: z.number().int().nonnegative(),
});

export const quizSchema = z.object({
  id: z.string().optional(),
  nombre: z.string().trim().min(1).max(200),
  categoria: z.string().trim().max(100).optional().default(''),
  preguntas: z.array(questionSchema).default([]),
});

export const attemptSchema = z.object({
  workerId: z.string().trim().optional().nullable(),
  workerDocumento: z.string().trim().optional(),
  workerNombrePublico: z.string().trim().max(200).optional(),
  quizId: z.string().trim().optional().nullable(),
  quizNombre: z.string().trim().min(1).max(200),
  puntaje: z.number().min(0).max(100),
  origen: z.enum(['panel_admin', 'enlace_publico', 'enlace_ingreso']).optional().default('panel_admin'),
});

export const annexTemplateUploadSchema = z.object({
  nombre: z.string().trim().min(1).max(255),
  pdfBase64: z.string().min(1, 'El archivo PDF es obligatorio'),
});

export const signaturePositionSchema = z.object({
  fileKey: z.string().trim().min(1),
  pageIndex: z.number().int().nonnegative(),
  xRatio: z.number().min(0).max(1),
  yRatio: z.number().min(0).max(1),
  widthRatio: z.number().min(0.05).max(1).optional().default(0.22),
});

export const inductionContentSchema = z.object({
  titulo: z.string().trim().min(1).max(300),
  cuerpo: z.string().trim().min(1),
  quizId: z.string().trim().optional().nullable(),
});
