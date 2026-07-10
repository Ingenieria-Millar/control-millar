/**
 * Barra lateral de navegación. Réplica exacta de renderSidebar() del original.
 * `onNavigate` la inyecta el router (Fase 8); aquí solo se genera el marcado
 * y se atan los clics.
 */
const NAV_ITEMS = [
  { section: 'Ingreso de personal', items: [
    { route: 'inicio', icon: 'ti-layout-dashboard', label: 'Panel general' },
    { route: 'trabajadores', icon: 'ti-users', label: 'Trabajadores' },
    { route: 'firma', icon: 'ti-signature', label: 'Firma de anexos' },
    { route: 'paquete', icon: 'ti-package', label: 'Paquete de ingreso' },
  ]},
  { section: 'Capacitación SST', items: [
    { route: 'plan', icon: 'ti-calendar-event', label: 'Plan anual' },
    { route: 'sesiones', icon: 'ti-presentation', label: 'Sesiones e inducciones' },
    { route: 'evaluaciones', icon: 'ti-clipboard-check', label: 'Evaluaciones' },
    { route: 'resultados', icon: 'ti-chart-bar', label: 'Resultados' },
  ]},
];

export function renderSidebar(activeRoute) {
  const navItem = ({ route, icon, label }) =>
    `<div class="nav-item ${activeRoute === route ? 'active' : ''}" data-route="${route}"><span class="icon"><i class="ti ${icon}"></i></span><span>${label}</span></div>`;

  const sections = NAV_ITEMS.map(
    ({ section, items }) => `<div class="nav-section-label">${section}</div>${items.map(navItem).join('')}`
  ).join('');

  const millarUrl = (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_MILLAR_URL) || null;
  const volverHref = millarUrl || 'javascript:history.back()';
  return `<div class="brand"><div class="brand-mark"><i class="ti ti-shield-check"></i></div><div class="brand-text"><div class="name">CONFECCIONES MILLAR</div><div class="sub">SG-SST · Punto Seguro</div></div></div>
${sections}
<div class="sidebar-footer">
  <a href="${volverHref}" class="nav-item" style="text-decoration:none;color:inherit;margin-bottom:8px;display:flex;">
    <span class="icon"><i class="ti ti-arrow-left"></i></span><span>← Volver al Menú</span>
  </a>
  <div class="legal">Firma electrónica conforme a la Ley 527/1999 y el Decreto 2364/2012.</div>
</div>`;
}

export function attachSidebarListeners(onNavigate) {
  document.querySelectorAll('[data-route]').forEach((el) => {
    el.addEventListener('click', () => onNavigate(el.dataset.route));
  });
}
