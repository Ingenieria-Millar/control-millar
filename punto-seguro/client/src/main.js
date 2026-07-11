import './styles/global.css';

async function bootstrap() {
  const root = document.getElementById('root');

  // ── Login gate ──────────────────────────────────────────────────────────────
  const { LoginPage } = await import('./pages/LoginPage.js');
  const auth = await new LoginPage().waitForAuth(root);

  // ── Administrador: panel completo ───────────────────────────────────────────
  if (auth.role === 'admin') {
    const { AppRouter } = await import('./router/AppRouter.js');
    new AppRouter(root).start();
    return;
  }

  // ── Público sin registro previo: mostrar formulario ─────────────────────────
  let trabajador = auth.trabajador;
  if (auth.role === 'publico' && !trabajador) {
    const { RegistroPublicoPage } = await import('./pages/RegistroPublicoPage.js');
    trabajador = await new RegistroPublicoPage(auth.cedula).waitForSubmit(root);
  }

  // ── Vinculado y Público: proceso de inducción/firma ─────────────────────────
  const { OnboardingPage } = await import('./pages/public/OnboardingPage.js');
  await new OnboardingPage(trabajador.id).render(root);
}

bootstrap();
