-- ============================================
-- PUNTO SEGURO — Migración 002: esquema de dominio
-- Basado 1:1 en el modelo de datos de la app original (SK.WORKERS, SK.TRAININGS,
-- SK.SESSIONS, SK.QUIZZES, SK.ATTEMPTS, SK.SIG_POS, SK.ANNEX_TPLS, SK.INDUCTION).
-- ============================================

-- ── TRABAJADORES ──
CREATE TABLE IF NOT EXISTS workers (
  id                 TEXT PRIMARY KEY,
  nombre             TEXT NOT NULL,
  documento          TEXT NOT NULL,
  cargo              TEXT DEFAULT '',
  fecha_ingreso      DATE,
  correo             TEXT DEFAULT '',
  celular            TEXT DEFAULT '',
  area               TEXT DEFAULT '',
  consentimiento_firma_electronica BOOLEAN NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (documento)
);

-- Documentos firmados electrónicamente por cada trabajador (incluye el PDF binario)
CREATE TABLE IF NOT EXISTS worker_signed_documents (
  id           TEXT PRIMARY KEY,
  worker_id    TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  nombre       TEXT NOT NULL,
  hash         TEXT NOT NULL,
  size_kb      NUMERIC,
  firmado_en   TIMESTAMPTZ NOT NULL DEFAULT now(),
  pdf_data     BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_signed_docs_worker ON worker_signed_documents(worker_id);

-- ── PLAN ANUAL DE CAPACITACIÓN (filas editables) ──
CREATE TABLE IF NOT EXISTS training_plan_items (
  id            TEXT PRIMARY KEY,
  mes           TEXT NOT NULL,
  tema          TEXT NOT NULL,
  dirigido_a    TEXT DEFAULT '',
  horas         TEXT DEFAULT '',
  responsable   TEXT DEFAULT '',
  orden         SERIAL
);

-- ── SESIONES DE CAPACITACIÓN ──
CREATE TABLE IF NOT EXISTS training_sessions (
  id            TEXT PRIMARY KEY,
  tema          TEXT NOT NULL,
  fecha         DATE NOT NULL,
  horas         TEXT DEFAULT '',
  dirigido_a    TEXT DEFAULT 'Todo el personal',
  responsable   TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session_attendees (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  worker_id     TEXT REFERENCES workers(id) ON DELETE SET NULL,
  nombre        TEXT NOT NULL,
  asistio       BOOLEAN NOT NULL DEFAULT FALSE,
  evaluado      BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_attendees_session ON session_attendees(session_id);

-- ── EVALUACIONES (QUIZZES) ──
CREATE TABLE IF NOT EXISTS quizzes (
  id            TEXT PRIMARY KEY,
  nombre        TEXT NOT NULL,
  categoria     TEXT DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quiz_questions (
  id            TEXT PRIMARY KEY,
  quiz_id       TEXT NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  texto         TEXT NOT NULL,
  opciones      JSONB NOT NULL,
  correcta_idx  INTEGER NOT NULL,
  orden         SERIAL
);
CREATE INDEX IF NOT EXISTS idx_questions_quiz ON quiz_questions(quiz_id);

-- ── INTENTOS DE EVALUACIÓN (resultados) ──
CREATE TABLE IF NOT EXISTS quiz_attempts (
  id                     TEXT PRIMARY KEY,
  worker_id              TEXT REFERENCES workers(id) ON DELETE SET NULL,
  worker_nombre_publico  TEXT,
  quiz_id                TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
  quiz_nombre            TEXT NOT NULL,
  puntaje                NUMERIC NOT NULL,
  fecha                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  origen                 TEXT NOT NULL DEFAULT 'panel_admin'
);
CREATE INDEX IF NOT EXISTS idx_attempts_worker ON quiz_attempts(worker_id);
CREATE INDEX IF NOT EXISTS idx_attempts_quiz ON quiz_attempts(quiz_id);

-- ── PLANTILLAS DE ANEXOS (paquete de ingreso) ──
CREATE TABLE IF NOT EXISTS annex_templates (
  id           TEXT PRIMARY KEY,
  nombre       TEXT NOT NULL,
  file_key     TEXT NOT NULL UNIQUE,
  size_kb      NUMERIC,
  subido_en    TIMESTAMPTZ NOT NULL DEFAULT now(),
  pdf_data     BYTEA NOT NULL
);

-- ── POSICIONES DE FIRMA POR ANEXO (una por file_key) ──
CREATE TABLE IF NOT EXISTS signature_positions (
  file_key      TEXT PRIMARY KEY,
  page_index    INTEGER NOT NULL,
  x_ratio       NUMERIC NOT NULL,
  y_ratio       NUMERIC NOT NULL,
  width_ratio   NUMERIC NOT NULL DEFAULT 0.22,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── CONTENIDO DE INDUCCIÓN (fila única / singleton) ──
CREATE TABLE IF NOT EXISTS induction_content (
  id        SMALLINT PRIMARY KEY DEFAULT 1,
  titulo    TEXT NOT NULL,
  cuerpo    TEXT NOT NULL,
  quiz_id   TEXT REFERENCES quizzes(id) ON DELETE SET NULL,
  CONSTRAINT single_row CHECK (id = 1)
);
