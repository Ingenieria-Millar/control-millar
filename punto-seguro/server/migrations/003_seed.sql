-- ============================================
-- PUNTO SEGURO — Migración 003: datos semilla
-- Reproduce exactamente defaultTrainingPlan(), defaultQuizzes() y
-- defaultInductionContent() del archivo original, para que el primer arranque
-- de la app en producción luzca igual que el original con storage vacío.
-- Idempotente: usa ON CONFLICT DO NOTHING, seguro de re-ejecutar.
-- ============================================

-- Plan anual de capacitación
INSERT INTO training_plan_items (id, mes, tema, dirigido_a, horas, responsable) VALUES
  ('plan_01','Enero','Política SST, roles y responsabilidades','Todo el personal','2','Profesional SST'),
  ('plan_02','Febrero','Identificación de peligros y valoración de riesgos','Mandos medios','3','Profesional SST'),
  ('plan_03','Marzo','Manejo y levantamiento de cargas','Personal operativo','2','Profesional SST'),
  ('plan_04','Abril','Riesgo locativo y orden y aseo','Todo el personal','2','Profesional SST'),
  ('plan_05','Mayo','Trabajo seguro en alturas / Riesgo eléctrico','Personal expuesto','8','Profesional SST'),
  ('plan_06','Junio','Primeros auxilios básicos','Brigada','8','Profesional SST'),
  ('plan_07','Julio','Riesgo psicosocial y estrés','Todo el personal','2','Profesional SST'),
  ('plan_08','Agosto','Plan de emergencias y simulacro','Todo el personal','3','Profesional SST'),
  ('plan_09','Septiembre','Riesgo biológico y químico','Personal expuesto','2','Profesional SST'),
  ('plan_10','Octubre','Investigación de incidentes','Mandos medios','3','Profesional SST'),
  ('plan_11','Noviembre','Reinducción general SG-SST','Todo el personal','2','Profesional SST'),
  ('plan_12','Diciembre','Evaluación de gestión y cierre','Alta dirección','2','Profesional SST')
ON CONFLICT (id) DO NOTHING;

-- Evaluación por defecto: inducción SST
INSERT INTO quizzes (id, nombre, categoria) VALUES
  ('quiz_induccion','Evaluación de inducción en SST','Inducción')
ON CONFLICT (id) DO NOTHING;

INSERT INTO quiz_questions (id, quiz_id, texto, opciones, correcta_idx) VALUES
  ('preg_01','quiz_induccion','¿Cuál es el objetivo principal del SG-SST?',
    '["Cumplir un trámite administrativo","Prevenir accidentes y enfermedades laborales","Reducir el salario","Aumentar la producción"]', 1),
  ('preg_02','quiz_induccion','¿Qué hacer al identificar una condición insegura?',
    '["Ignorarla","Reportarla al responsable de SST o jefe","Esperar a que otro la reporte","Resolverla sin avisar"]', 1),
  ('preg_03','quiz_induccion','¿En qué plazo debe reportarse un accidente de trabajo?',
    '["Dentro de las 24 horas","No hay plazo","Solo si es grave","Una semana después"]', 0),
  ('preg_04','quiz_induccion','¿Qué es el COPASST?',
    '["Un proveedor de EPP","El Comité Paritario de SST","Una entidad gubernamental","El área de nómina"]', 1),
  ('preg_05','quiz_induccion','¿Verdadero o falso? El autorreporte de condiciones de salud es solo del médico.',
    '["Verdadero","Falso"]', 1),
  ('preg_06','quiz_induccion','¿Para qué sirve la matriz de peligros?',
    '["Llevar inventario","Identificar, evaluar y priorizar los riesgos","Calcular nómina","Programar vacaciones"]', 1),
  ('preg_07','quiz_induccion','Ante una emergencia, ¿qué debe hacer primero?',
    '["Recoger sus pertenencias","Dirigirse con calma a la ruta de evacuación","Usar el ascensor","Esperar sin moverse"]', 1),
  ('preg_08','quiz_induccion','¿Qué EPP debe usar?',
    '["Los que él elija","Los asignados según el análisis de riesgo","Ninguno","Solo si el supervisor está presente"]', 1),
  ('preg_09','quiz_induccion','¿Quién puede participar en el Comité de Convivencia?',
    '["Solo la gerencia","Trabajadores elegidos junto con representantes del empleador","Solo RRHH","Nadie, es externo"]', 1),
  ('preg_10','quiz_induccion','¿Qué hacer si presenta incapacidad mayor a 30 días?',
    '["Reincorporarse sin proceso adicional","Pasar por reinducción antes de retomar funciones","Cambiar de empresa","No es necesario informar"]', 1)
ON CONFLICT (id) DO NOTHING;

-- Contenido de inducción por defecto
INSERT INTO induction_content (id, titulo, cuerpo, quiz_id) VALUES (
  1,
  'Inducción en Seguridad y Salud en el Trabajo',
  E'Bienvenido a la organización. Antes de comenzar tus labores, es importante que conozcas:\n\n• La política de SST de la empresa y el compromiso con tu seguridad.\n• Los principales peligros y riesgos asociados a tu puesto de trabajo.\n• El uso correcto de los elementos de protección personal (EPP) asignados.\n• Las rutas de evacuación y el punto de encuentro en caso de emergencia.\n• Cómo reportar una condición insegura o un incidente.\n• Los mecanismos de participación: COPASST y Comité de Convivencia Laboral.\n\nPor favor lee con atención esta información antes de continuar con la evaluación.',
  'quiz_induccion'
) ON CONFLICT (id) DO NOTHING;
