
document.addEventListener('DOMContentLoaded', () => {
  App.init();

  // drag-to-reposition timeline chips — bound once on window/root since #root persists across re-renders
  window.addEventListener('pointermove', (e) => App.dragMove(e.clientX, e.clientY));
  window.addEventListener('pointerup', () => App.dragEnd());
});
