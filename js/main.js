
document.addEventListener('DOMContentLoaded', () => {
  App.init();

  // drag-to-reposition timeline chips, bottom-sheet drag-to-dismiss, and stepper
  // long-press-repeat release — all bound once on window/root since #root persists across
  // re-renders, and each gesture's own DOM node can get replaced mid-gesture by a rerender.
  window.addEventListener('pointermove', (e) => { App.dragMove(e.clientX, e.clientY); App.sheetDragMove(e.clientY); App.statsSwipeMove(e.clientX, e.clientY); });
  window.addEventListener('pointerup', (e) => { App.dragEnd(); App.sheetDragEnd(e.clientY); App.stopHold(); App.endStatsSwipe(e.clientX); });
  // Mobile browsers raise pointercancel (not pointerup) when they take over a touch mid-gesture
  // as a scroll/system gesture — spring the stats charts back so they don't freeze half-swiped.
  window.addEventListener('pointercancel', () => { App.stopHold(); App.cancelStatsSwipe(); });

  // Pull-to-refresh: forces the Firestore listeners to detach and re-attach (see
  // Sync.forceResync), which re-fetches from the server without the cost of a full page
  // reload — no re-downloading scripts, no re-initializing the Firebase SDK, no re-resolving
  // auth. Firestore already syncs in real time on its own; this is purely a manual "start
  // clean" convenience for when a device's listeners seem stuck.
  // The indicator lives outside #root (appended straight to body) since #root's
  // innerHTML gets replaced on every app re-render and would wipe a mid-gesture element.
  const pull = document.createElement('div');
  pull.style.cssText = 'position:fixed;top:0;left:50%;transform:translate(-50%,-40px);z-index:200;background:var(--card);color:var(--text2);font-size:12px;font-weight:700;padding:8px 16px;border-radius:14px;box-shadow:0 4px 12px var(--shadow);opacity:0;transition:opacity .15s;pointer-events:none;';
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
      // No page reload to wipe the indicator for us anymore — hide it once the listeners
      // report back "done", or after a timeout so a slow/stuck connection doesn't leave it
      // stuck on screen forever.
      let hidden = false;
      const unsubscribe = () => { const i = Sync.listeners.indexOf(onSyncChange); if (i !== -1) Sync.listeners.splice(i, 1); };
      const hide = () => { if (hidden) return; hidden = true; pull.style.opacity = '0'; unsubscribe(); };
      const onSyncChange = () => { if (Sync.state === 'done' || Sync.state === 'fail') hide(); };
      Sync.onChange(onSyncChange);
      setTimeout(hide, 6000); // fallback in case the listeners never settle
      setTimeout(() => Sync.forceResync(), 150);
    } else {
      pull.style.opacity = '0';
    }
    armed = false;
  });
});
