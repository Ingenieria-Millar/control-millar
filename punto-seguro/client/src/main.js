import './styles/global.css';
import { getOnboardingWorkerIdFromUrl, getPublicQuizIdFromUrl } from './utils/urlParams.js';

/**
 * Punto de entrada de la aplicación. Réplica de bootstrap() del archivo
 * original: decide entre 3 modos según los parámetros de la URL, sin cambiar
 * el comportamiento observado por el usuario.
 *   - ?ingreso=<workerId>  → proceso público de ingreso (firma + inducción + evaluación)
 *   - ?evaluar=<quizId>    → evaluación pública por enlace
 *   - (sin parámetros)     → panel administrativo (sidebar + rutas internas)
 *
 * Cada modo se importa dinámicamente: quien abre un enlace público de
 * evaluación no necesita descargar el código del panel admin, y viceversa.
 */
async function bootstrap() {
  const root = document.getElementById('root');

  const onboardingWorkerId = getOnboardingWorkerIdFromUrl();
  if (onboardingWorkerId) {
    const { OnboardingPage } = await import('./pages/public/OnboardingPage.js');
    await new OnboardingPage(onboardingWorkerId).render(root);
    return;
  }

  const publicQuizId = getPublicQuizIdFromUrl();
  if (publicQuizId) {
    const { PublicQuizPage } = await import('./pages/public/PublicQuizPage.js');
    await new PublicQuizPage(publicQuizId).render(root);
    return;
  }

  const { AppRouter } = await import('./router/AppRouter.js');
  new AppRouter(root).start();
}

bootstrap();
