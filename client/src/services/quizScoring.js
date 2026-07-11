/**
 * Calcula el puntaje de un intento de evaluación.
 * Fórmula idéntica al original: (respuestas correctas / total) * 100, redondeado.
 * Escala: aprobado ≥ 80, refuerzo 60–79, reprobado < 60 (ver viewResultados).
 */
export function scoreQuizAttempt(preguntas, answers) {
  const total = preguntas.length;
  const correct = preguntas.reduce((acc, p) => (answers[p.id] === p.correctaIdx ? acc + 1 : acc), 0);
  return total ? Math.round((correct / total) * 100) : 0;
}

export function classifyScore(puntaje) {
  if (puntaje >= 80) return 'aprobado';
  if (puntaje >= 60) return 'refuerzo';
  return 'reprobado';
}
