import { escapeHtml } from '../utils/textUtils.js';

/**
 * Notificaciones tipo "toast". Réplica exacta del comportamiento visual original
 * (una a la vez, se reemplaza si ya hay una visible, desaparece a los 3.8s).
 */
let toastTimer = null;

export function showToast(message, type = 'default') {
  document.querySelector('.toast')?.remove();
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const icon = type === 'success' ? 'ti-circle-check' : type === 'error' ? 'ti-alert-circle' : 'ti-info-circle';
  el.innerHTML = `<i class="ti ${icon}" style="font-size:18px"></i><span>${escapeHtml(message)}</span>`;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3800);
}
