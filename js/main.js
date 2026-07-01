
document.addEventListener('DOMContentLoaded', () => {
  App.init();

  // drag-to-reposition timeline chips — bound once on window/root since #root persists across re-renders
  window.addEventListener('pointermove', (e) => App.dragMove(e.clientX, e.clientY));
  window.addEventListener('pointerup', () => App.dragEnd());

  // Pull-to-refresh: a plain page reload, not tied to sync (Firestore already syncs in
  // real time on its own). This is here purely as a manual "start clean" convenience —
  // e.g. while developing/testing, or if a device's listeners ever get stuck.
  // The indicator lives outside #root (appended straight to body) since #root's
  // innerHTML gets replaced on every app re-render and would wipe a mid-gesture element.
  const pull = document.createElement('div');
  pull.style.cssText = 'position:fixed;top:0;left:50%;transform:translate(-50%,-40px);z-index:200;background:var(--card);color:var(--text2);font-size:12px;font-weight:700;padding:8px 16px;border-radius:0 0 14px 14px;box-shadow:0 4px 12px var(--shadow);opacity:0;transition:opacity .15s;pointer-events:none;';
  pull.textContent = '↓ 放開重新整理';
  document.body.appendChild(pull);

  const THRESHOLD = 64;
  let startY = 0, pulling = false, armed = false;
  const root = document.getElementById('root');
  root.addEventListener('touchstart', (e) => {
    const area = e.target.closest('.ns');
    if (area && area.scrollTop <= 2) { startY = e.touches[0].clientY; pulling = true; armed = false; }
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy <= 0) { pull.style.opacity = '0'; armed = false; return; }
    const clamped = Math.min(dy, THRESHOLD * 1.5);
    pull.style.transform = `translate(-50%, ${clamped - 40}px)`;
    pull.style.opacity = String(Math.min(1, dy / THRESHOLD));
    armed = dy > THRESHOLD;
    pull.textContent = armed ? '↓ 放開重新整理' : '↓ 下拉重新整理';
  }, { passive: true });
  root.addEventListener('touchend', () => {
    pulling = false;
    if (armed) {
      pull.textContent = '重新整理中…';
      pull.style.transform = 'translate(-50%, 10px)';
      pull.style.opacity = '1';
      setTimeout(() => location.reload(), 150);
    } else {
      pull.style.opacity = '0';
    }
    armed = false;
  });
});
