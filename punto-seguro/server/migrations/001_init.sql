-- ============================================
-- PUNTO SEGURO — Migración 001: extensión base
-- El esquema completo (trabajadores, capacitaciones, sesiones,
-- quizzes, intentos, firmas, anexos, inducción) se agrega en la Fase 2.
-- ============================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id SERIAL PRIMARY KEY,
  filename TEXT NOT NULL UNIQUE,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
