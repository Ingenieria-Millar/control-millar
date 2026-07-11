/**
 * Lectura de parámetros de la URL que determinan el modo público de la app.
 * Réplica de getPublicQuizIdFromUrl()/getOnboardingWorkerIdFromUrl() del original.
 */
export function getPublicQuizIdFromUrl() {
  return new URLSearchParams(location.search).get('evaluar') || null;
}

export function getOnboardingWorkerIdFromUrl() {
  return new URLSearchParams(location.search).get('ingreso') || null;
}
