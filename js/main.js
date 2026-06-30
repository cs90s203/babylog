
document.addEventListener('DOMContentLoaded', () => {
  App.init();

  // drag-to-reposition timeline chips — bound once on window/root since #root persists across re-renders
  window.addEventListener('pointermove', (e) => App.dragMove(e.clientX, e.clientY));
  window.addEventListener('pointerup', () => App.dragEnd());

  // pull-to-refresh on the active screen's scroll area
  let startY = 0, pulling = false;
  const root = document.getElementById('root');
  root.addEventListener('touchstart', (e) => {
    const area = e.target.closest('#scroll-area');
    if (area && area.scrollTop <= 2) { startY = e.touches[0].clientY; pulling = true; }
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    if (e.touches[0].clientY - startY > 64) { pulling = false; App.doSync(); }
  }, { passive: true });
  root.addEventListener('touchend', () => { pulling = false; });
});
