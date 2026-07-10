/**
 * Fragmentos de marcado reutilizables entre vistas (estado vacío, encabezado
 * de página). Se mantienen como generadores de HTML porque el resto de la app
 * sigue el mismo enfoque de plantillas de texto que el original (sin framework),
 * decisión que se mantiene para no alterar el comportamiento ni el diseño visual.
 */

export function emptyState(icon, title, desc) {
  return `<div class="empty-state"><div class="icon"><i class="ti ${icon}"></i></div><div class="title">${title}</div><div class="desc">${desc}</div></div>`;
}

export function pageHeader(eyebrow, title, desc) {
  return `<div class="page-header"><p class="page-eyebrow">${eyebrow}</p><h1 class="page-title">${title}</h1><p class="page-desc">${desc}</p></div>`;
}
