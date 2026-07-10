/**
 * Encabezado de las páginas públicas (sin sidebar), con barra de progreso
 * opcional para el flujo de onboarding. Réplica de publicHeader()/obHeader().
 */
export function renderPublicHeader() {
  return `<div class="public-brand"><div class="brand-mark"><i class="ti ti-shield-check"></i></div><div class="brand-text"><div class="name">Punto Seguro</div><div class="sub">Evaluación de Seguridad y Salud en el Trabajo</div></div></div>`;
}

const ONBOARDING_STEPS = ['sign', 'induction', 'quiz'];
const ONBOARDING_LABELS = ['Firmar', 'Inducción', 'Evaluación'];

export function renderOnboardingHeader(currentStep) {
  const currentIndex = ONBOARDING_STEPS.indexOf(currentStep);
  if (currentIndex === -1) return renderPublicHeader();
  const steps = ONBOARDING_STEPS.map(
    (step, i) =>
      `<div class="onboard-progress-step ${i < currentIndex ? 'done' : i === currentIndex ? 'active' : ''}"><div class="onboard-progress-dot">${
        i < currentIndex ? '<i class="ti ti-check"></i>' : i + 1
      }</div><span>${ONBOARDING_LABELS[i]}</span></div>${
        i < ONBOARDING_STEPS.length - 1 ? `<div class="onboard-progress-line ${i < currentIndex ? 'done' : ''}"></div>` : ''
      }`
  ).join('');
  return `${renderPublicHeader()}<div class="onboard-progress">${steps}</div>`;
}
