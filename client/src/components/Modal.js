/**
 * Controlador genérico de modal (overlay). Reemplaza el mecanismo
 * renderModal()/closeModal()/modalContent() basado en `APP.state.ui.modal`
 * del original: cada página que necesite un modal crea su propia instancia,
 * le pasa una función que genera el HTML interno y otra que ata los listeners,
 * sin depender de un estado global compartido.
 */
export class Modal {
  open({ renderContent, attachListeners }) {
    this.close(); // solo un modal a la vez, igual que el original
    const overlay = document.createElement('div');
    overlay.id = 'modal-overlay';
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `<div class="modal-box">${renderContent()}</div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
    document.body.appendChild(overlay);
    document.getElementById('modal-cancel')?.addEventListener('click', () => this.close());
    attachListeners?.(this);
  }

  /**
   * Re-renderiza el contenido del modal actual (para wizards multi-paso
   * como aplicar evaluación o editar preguntas) sin cerrar el overlay.
   */
  rerender({ renderContent, attachListeners }) {
    const overlay = document.getElementById('modal-overlay');
    if (!overlay) return;
    overlay.querySelector('.modal-box').innerHTML = renderContent();
    document.getElementById('modal-cancel')?.addEventListener('click', () => this.close());
    attachListeners?.(this);
  }

  close() {
    document.getElementById('modal-overlay')?.remove();
  }
}
