import { renderSidebar, attachSidebarListeners } from '../components/Sidebar.js';

const VALID_ROUTES = ['inicio', 'trabajadores', 'firma', 'paquete', 'plan', 'sesiones', 'evaluaciones', 'resultados'];

/**
 * Enrutador del panel administrativo. Reemplaza render()/renderRoute()/
 * attachRouteListeners()/attachGlobalListeners()/goTo() del original:
 * en vez de un único objeto de estado global (`APP.state`), cada página es
 * una instancia con su propio estado, y el router solo decide cuál montar.
 *
 * Cada página se importa dinámicamente (import() perezoso) en vez de
 * estáticamente: así el bundle inicial no arrastra pdf-lib/pdfjs-dist (usados
 * solo en Firma y Paquete) ni el Worker de Excel (usado solo en Trabajadores)
 * cuando el usuario solo quiere ver el Dashboard. Esto es lo que hace efectivo
 * el code-splitting configurado en vite.config.js (Fase 4).
 *
 * Nota de simplificación: al navegar entre secciones se crea una instancia
 * nueva de la página (en vez de conservar el wizard de firma en un estado
 * global entre navegaciones). Esto es más predecible para el usuario: si
 * sales de "Firma de anexos" a mitad del proceso y vuelves, empiezas de nuevo
 * en vez de continuar un wizard a medias.
 */
export class AppRouter {
  constructor(root) {
    this.root = root;
    this.route = 'inicio';
    this.sidebarOpen = false;
    this.routeParams = {};
    this.navToken = 0; // evita que una navegación lenta y obsoleta pise a una más reciente
  }

  start() {
    this.goTo('inicio');
  }

  goTo(route, params = {}) {
    this.route = VALID_ROUTES.includes(route) ? route : 'inicio';
    this.routeParams = params;
    this.sidebarOpen = false;
    this._render();
  }

  _render() {
    this.root.innerHTML = `<button class="mobile-menu-btn" id="mobile-menu-btn"><i class="ti ti-menu-2"></i></button><aside class="sidebar ${
      this.sidebarOpen ? 'open' : ''
    }" id="sidebar">${renderSidebar(this.route)}</aside><main class="main" id="main-content"><div class="text-center" style="padding:60px"><i class="ti ti-loader-2" style="font-size:24px;color:var(--steel);animation:spin 1s linear infinite"></i></div></main>`;

    attachSidebarListeners((route) => this.goTo(route));
    document.querySelectorAll('[data-go]').forEach((el) => el.addEventListener('click', () => this.goTo(el.dataset.go)));
    document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
      this.sidebarOpen = !this.sidebarOpen;
      this._render();
    });

    this._mountPage();
  }

  async _mountPage() {
    const token = ++this.navToken;
    const page = await this._createPage();
    if (token !== this.navToken) return; // el usuario ya navegó a otra sección mientras cargaba
    const container = document.getElementById('main-content');
    page.render(container);
  }

  async _createPage() {
    const onNavigate = (route, params) => this.goTo(route, params);

    switch (this.route) {
      case 'trabajadores': {
        const { TrabajadoresPage } = await import('../pages/TrabajadoresPage.js');
        return new TrabajadoresPage({ onNavigate, onSignWorker: (workerId) => this.goTo('firma', { preselectedWorkerId: workerId }) });
      }
      case 'firma': {
        const { FirmaPage } = await import('../pages/FirmaPage.js');
        return new FirmaPage({ onNavigate, preselectedWorkerId: this.routeParams.preselectedWorkerId });
      }
      case 'paquete': {
        const { PaquetePage } = await import('../pages/PaquetePage.js');
        return new PaquetePage({ onNavigate });
      }
      case 'plan': {
        const { PlanPage } = await import('../pages/PlanPage.js');
        return new PlanPage();
      }
      case 'sesiones': {
        const { SesionesPage } = await import('../pages/SesionesPage.js');
        return new SesionesPage();
      }
      case 'evaluaciones': {
        const { EvaluacionesPage } = await import('../pages/EvaluacionesPage.js');
        return new EvaluacionesPage({ onNavigate });
      }
      case 'resultados': {
        const { ResultadosPage } = await import('../pages/ResultadosPage.js');
        return new ResultadosPage();
      }
      default: {
        const { InicioPage } = await import('../pages/InicioPage.js');
        return new InicioPage({ onNavigate });
      }
    }
  }
}
