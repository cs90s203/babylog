// App state + actions. Rendering lives in views.js; this file owns "what can happen".

// Bump per CHANGELOG.md: patch = fixes/tweaks, minor = new features, major = architecture
// changes (e.g. the GitHub->Firebase sync swap). Shown at the bottom of the settings page.
const APP_VERSION = '2.3.7';

function todayStr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

const App = {
  state: {
    screen: 'home',
    theme: 'auto',
    sheet: null,           // 'milk' | 'edit' | 'editRec' | 'growth'
    recordType: 'milk',
    rt: { h: 0, m: 0 },
    milkBreast: 0,
    milkFormula: 0,
    scale: 'today',
    statsTab: 'feed',
    statsRange: 'week',
    growthMetric: 'weight',
    recordsFilter: 'all',
    editingId: null,
    editBy: '',
    confirmDelId: null,
    dragId: null,
    justUpdatedId: null, // briefly set after a timeline drag commits, to glow that chip
    frontChipId: null, // which overlapping timeline chip (if any) is currently brought to front
    expandedGaps: [],
    numEdit: null, // { field, value } while a tap-to-edit number input is open
    toast: null,
    showWelcome: false,
    welcomeName: '',
    gDate: '', gWeight: '', gHeight: '', gHead: '',
    exportFrom: todayStr(new Date(Date.now() - 7 * 86400000)),
    exportTo: todayStr(),
  },
  _toastTimer: null,
  _pressTimer: null,
  _longFired: false,
  _drag: null,
  _dragTimer: null,
  _trackNode: null,
  _yToH: null,
  _hToY: null,
  _axis: null,
  _winStart: null,
  _holdTimer: null,
  _holdInterval: null,
  _sheetDrag: null,
  _glowTimer: null,

  init() {
    Store.init();
    this.state.theme = Store.local('theme') || 'auto';
    this.state.showWelcome = !Store.caregiver;
    Store.onChange(() => this.rerender());
    Sync.onChange(() => this.rerender());
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => { if (this.state.theme === 'auto') this.rerender(); };
      if (mq.addEventListener) mq.addEventListener('change', handler);
    }
    this.rerender();
    // Firestore's onSnapshot listeners (attached once signed in) stay live on their own —
    // no polling or pull-to-refresh needed, unlike the old GitHub-Contents-API sync.
    Sync.init();
  },

  rerender() { render(this.state); },
  set(patch) { Object.assign(this.state, patch); this.rerender(); },

  hm(frac) {
    const h = Math.floor(frac) % 24, m = Math.round((frac % 1) * 60);
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  },

  toast(emoji, msg, addType, addEvId) {
    clearTimeout(this._toastTimer);
    this.set({ toast: { emoji, msg, addType: addType || null, addEvId: addEvId ?? null } });
    this._toastTimer = setTimeout(() => this.set({ toast: null }), addType ? 3200 : 1700);
  },
  dismissToast() { clearTimeout(this._toastTimer); this.set({ toast: null }); },

  predict() {
    return predictNextFeed(Store.liveEvents(), Store.data.settings.alarmOffsetMinutes || 0);
  },

  // ---- navigation ----
  goHome() { this.set({ screen: 'home', sheet: null }); },
  goStats() { this.set({ screen: 'stats', sheet: null }); },
  goRecords() { this.set({ screen: 'records', sheet: null }); },
  goConfig() { this.set({ screen: 'config', sheet: null }); },
  closeSheet() { this.set({ sheet: null }); },

  toggleTheme() {
    const sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const effNight = this.state.theme === 'night' || (this.state.theme === 'auto' && sysDark);
    this.setTheme(effNight ? 'day' : 'night');
  },
  setTheme(t) { Store.local('theme', t); this.set({ theme: t }); },

  // ---- quick record (poop/pee tap & long-press) ----
  recordNow(type) {
    Store.addEvent(type, new Date());
    const map = { poop: ['💩', '排便記錄了！'], pee: ['💧', '尿尿記錄了！'] };
    const other = type === 'poop' ? 'pee' : 'poop';
    const ev = Store.data.events[Store.data.events.length - 1];
    this.toast(map[type][0], map[type][1], other, ev.id);
  },
  startPress(type) {
    this._longFired = false;
    clearTimeout(this._pressTimer);
    this._pressTimer = setTimeout(() => {
      this._longFired = true;
      const now = new Date();
      this.set({ sheet: 'edit', recordType: type, rt: { h: now.getHours(), m: Math.round(now.getMinutes() / 5) * 5 % 60 } });
    }, 450);
  },
  endPress() { clearTimeout(this._pressTimer); },
  tap(type) {
    if (this._longFired) { this._longFired = false; return; }
    this.recordNow(type);
  },

  openMilk() {
    const n = new Date();
    this.set({
      sheet: 'milk', recordType: 'milk',
      rt: { h: n.getHours(), m: Math.round(n.getMinutes() / 5) * 5 % 60 },
      milkBreast: Store.data.settings.defaultMilk.breast,
      milkFormula: Store.data.settings.defaultMilk.formula,
    });
  },
  setH(d) { const rt = this.state.rt; this.set({ rt: { ...rt, h: (rt.h + d + 24) % 24 } }); },
  setM(d) { const rt = this.state.rt; this.set({ rt: { ...rt, m: (rt.m + d + 60) % 60 } }); },

  // Press-and-hold repeat for the +/- time steppers (now ±1 instead of ±5, so this is what
  // makes large adjustments still fast). fn fires once immediately, then repeats with a
  // short delay, then accelerates. The button's own DOM node gets replaced by the rerender
  // each step triggers, so release is caught globally (see main.js window pointerup ->
  // App.stopHold()) rather than via this button's own onpointerup.
  startHold(fn) {
    this.stopHold();
    fn();
    this._holdTimer = setTimeout(() => {
      let n = 0;
      this._holdInterval = setInterval(() => {
        fn();
        n++;
        if (n === 8) { clearInterval(this._holdInterval); this._holdInterval = setInterval(fn, 60); }
      }, 160);
    }, 400);
  },
  stopHold() {
    clearTimeout(this._holdTimer); clearInterval(this._holdInterval);
    this._holdTimer = null; this._holdInterval = null;
  },

  // Tap-to-edit: tapping the h/m stepper number or an ml amount swaps it for a numeric
  // input in place (see numEditInput/timeStepper/mlValueSpan in views.js).
  startNumEdit(field) {
    const s = this.state;
    const cur = field === 'h' ? s.rt.h : field === 'm' ? s.rt.m : field === 'milkBreast' ? s.milkBreast : s.milkFormula;
    this.set({ numEdit: { field, value: String(cur) } });
  },
  cancelNumEdit() { this.set({ numEdit: null }); },
  commitNumEdit(raw) {
    const ne = this.state.numEdit;
    if (!ne) return;
    let n = parseInt(raw, 10);
    if (isNaN(n)) { this.set({ numEdit: null }); return; }
    if (ne.field === 'h') { n = Math.max(0, Math.min(23, n)); this.set({ rt: { ...this.state.rt, h: n }, numEdit: null }); }
    else if (ne.field === 'm') { n = Math.max(0, Math.min(59, n)); this.set({ rt: { ...this.state.rt, m: n }, numEdit: null }); }
    else if (ne.field === 'milkBreast') { n = Math.max(0, Math.min(999, n)); this.set({ milkBreast: n, numEdit: null }); }
    else if (ne.field === 'milkFormula') { n = Math.max(0, Math.min(999, n)); this.set({ milkFormula: n, numEdit: null }); }
  },

  // Bottom sheet drag-to-dismiss: pointerdown anywhere on the sheet card starts it (not
  // just the handle) — but only when it doesn't land on something that's supposed to
  // handle its own pointer/click (buttons, inputs, range sliders, the numeric tap-to-edit
  // field...), otherwise this would swallow every tap and drag on those controls. Global
  // pointermove/pointerup (main.js) drive it. Live-transforms the sheet's DOM node
  // directly (no rerender per pixel — same reasoning as timeline drag/sliders), and only
  // touches Store/state once, on release, to actually close the sheet.
  startSheetDrag(e) {
    if (e.target.closest('button, input, a, select, textarea, [contenteditable]')) return;
    const sheetEl = e.currentTarget;
    if (!sheetEl) return;
    this._sheetDrag = { startY: e.clientY, sheetEl, height: sheetEl.getBoundingClientRect().height };
    sheetEl.style.transition = 'none';
  },
  sheetDragMove(clientY) {
    const d = this._sheetDrag; if (!d) return;
    const dy = Math.max(0, clientY - d.startY);
    d.sheetEl.style.transform = `translateY(${dy}px)`;
  },
  sheetDragEnd(clientY) {
    const d = this._sheetDrag; if (!d) return;
    this._sheetDrag = null;
    const dy = Math.max(0, clientY - d.startY);
    d.sheetEl.style.transition = 'transform .22s cubic-bezier(.17,.67,.32,1.1)';
    if (dy > d.height * 0.28 || dy > 140) {
      d.sheetEl.style.transform = `translateY(${d.height}px)`;
      setTimeout(() => this.closeSheet(), 180);
    } else {
      d.sheetEl.style.transform = '';
    }
  },
  // Milk ml sliders: same class of bug as the old timeline drag (see dragMove) — calling
  // this.set() on every oninput tick triggers a full app re-render per pixel of drag,
  // which fights the browser's own native slider-drag gesture (the DOM node gets replaced
  // mid-gesture) and made it "hard to track/hard to zero out". Write straight into
  // App.state (no rerender) and patch the couple of dependent text spans directly; the
  // state is fully correct by the time the sheet is closed/saved, no separate commit step
  // needed since nothing here is pushed anywhere until confirmRecord()/saveEdit() run.
  liveSlider(kind, v) {
    v = parseInt(v, 10) || 0;
    if (kind === 'breast') this.state.milkBreast = v; else this.state.milkFormula = v;
    const total = this.state.milkBreast + this.state.milkFormula;
    const totalEl = document.getElementById('f-milk-total');
    const breastEl = document.getElementById('f-milk-breast-val');
    const formulaEl = document.getElementById('f-milk-formula-val');
    if (totalEl) totalEl.textContent = total;
    if (breastEl) breastEl.textContent = this.state.milkBreast + ' ml';
    if (formulaEl) formulaEl.textContent = this.state.milkFormula + ' ml';
  },
  // Default-ml sliders in settings: same live-patch treatment, but these DO need a real
  // commit (Store.updateSettings, which also pushes to Firestore) — just only once, on
  // release (onchange), not once per pixel of drag.
  liveDefSlider(kind, v) {
    const el = document.getElementById(kind === 'breast' ? 'f-def-breast-val' : 'f-def-formula-val');
    if (el) el.textContent = (parseInt(v, 10) || 0) + ' ml';
  },

  confirmRecord() {
    const s = this.state;
    const now = new Date();
    const t = new Date(now); t.setHours(s.rt.h, s.rt.m, 0, 0);
    const type = s.recordType;
    if (type === 'milk') {
      Store.addEvent('milk', t, { breastMl: s.milkBreast, formulaMl: s.milkFormula, amountMl: s.milkBreast + s.milkFormula });
      this.set({ sheet: null });
      this.toast('🍼', '喝奶記錄了！');
    } else {
      Store.addEvent(type, t);
      const ev = Store.data.events[Store.data.events.length - 1];
      const other = type === 'poop' ? 'pee' : 'poop';
      const map = { poop: ['💩', '排便記錄了！'], pee: ['💧', '尿尿記錄了！'] };
      this.set({ sheet: null });
      this.toast(map[type][0], map[type][1], other, ev.id);
    }
  },
  addOther() {
    const t = this.state.toast;
    if (!t || !t.addType) return;
    const src = Store.data.events.find(e => e.id === t.addEvId);
    Store.addEvent(t.addType, src ? new Date(src.time) : new Date());
    const m2 = { poop: ['💩', '也記了排便！'], pee: ['💧', '也記了尿尿！'] };
    this.toast(m2[t.addType][0], m2[t.addType][1]);
  },

  // ---- timeline interactions ----
  toggleGap(key) {
    const cur = this.state.expandedGaps;
    this.set({ expandedGaps: cur.includes(key) ? cur.filter(k => k !== key) : [...cur, key] });
  },
  openEditRec(rec) {
    const dt = new Date(rec.time);
    const st = { sheet: 'editRec', editingId: rec.id, recordType: rec.type, rt: { h: dt.getHours(), m: dt.getMinutes() }, editBy: rec.by || Store.caregiver || '' };
    if (rec.type === 'milk') { st.milkBreast = rec.breastMl || 0; st.milkFormula = rec.formulaMl || 0; }
    this.set(st);
  },
  setEditType(t) { this.set({ recordType: t }); },
  onEditBy(v) { this.set({ editBy: v }); },
  // The 由誰處理 field has no onchange binding (see closeWelcome for why: a re-render
  // mid-tap can drop the click on the Save/Delete button right next to it), so read
  // the live DOM value at submit time instead of state.editBy.
  _editByValue() {
    const el = document.getElementById('f-edit-by');
    return (el && el.value.trim()) || this.state.editBy || Store.caregiver || '未命名';
  },
  saveEdit() {
    const s = this.state;
    const t = new Date(); t.setHours(s.rt.h, s.rt.m, 0, 0);
    const patch = { type: s.recordType, time: t.toISOString(), by: this._editByValue() };
    if (s.recordType === 'milk') Object.assign(patch, { breastMl: s.milkBreast, formulaMl: s.milkFormula, amountMl: s.milkBreast + s.milkFormula });
    Store.updateEvent(s.editingId, patch);
    this.set({ sheet: null });
    this.toast('✏️', '已更新');
  },
  editAddOther() {
    const s = this.state;
    const t = new Date(); t.setHours(s.rt.h, s.rt.m, 0, 0);
    Store.updateEvent(s.editingId, { type: s.recordType, time: t.toISOString(), by: this._editByValue() });
    const other = s.recordType === 'poop' ? 'pee' : 'poop';
    Store.addEvent(other, t);
    this.set({ sheet: null });
    this.toast('✅', '已加上另一項');
  },
  deleteFromEdit() { this.set({ sheet: null, confirmDelId: this.state.editingId }); },
  requestDelete(id) { this.set({ confirmDelId: id }); },
  cancelDelete() { this.set({ confirmDelId: null }); },
  doDelete() {
    const id = this.state.confirmDelId;
    Store.deleteEvent(id);
    this.set({ confirmDelId: null });
    this.toast('🗑️', '已刪除');
  },

  // drag-to-reposition a timeline chip
  startDrag(id, clientX, clientY) {
    this._drag = { id, startX: clientX, startY: clientY, moved: false, active: false };
    // Bring the pressed chip to the front of its overlapping stack (see views.js —
    // clustered chips cascade with a partial overlap) so it's fully visible/tappable
    // instead of staying partly hidden behind whichever chip happened to render on top.
    if (this.state.frontChipId !== id) this.set({ frontChipId: id });
    clearTimeout(this._dragTimer);
    this._dragTimer = setTimeout(() => {
      if (this._drag) { this._drag.active = true; this.set({ dragId: this._drag.id }); }
    }, 240);
  },
  // While actively dragging, this patches the drag-mode DOM nodes directly (#ddot/#dtl/
  // #drow, rendered once by views.js when dragId gets set) instead of writing to Store on
  // every pointermove. Writing to Store used to trigger a full app re-render per pixel of
  // movement — that's where the old jank, the page jumping to scrollTop 0 mid-drag, and
  // the event "disappearing" when dragged past a stale/detached track node all came from.
  // The actual data write now happens exactly once, in dragEnd().
  dragMove(clientX, clientY) {
    const d = this._drag; if (!d) return;
    if (Math.abs(clientX - d.startX) > 4 || Math.abs(clientY - d.startY) > 4) d.moved = true;
    if (!d.active || !this._trackNode || !this._yToH || !this._winStart) return;
    const rect = this._trackNode.getBoundingClientRect();
    const ax = this._axis || { startH: 0, endH: 27 };
    // Can't drag an event into the future — clamp at "now", not at the window's right edge
    // (which extends 3h past now purely to leave layout breathing room).
    const maxH = ax.nowPos != null ? ax.nowPos : ax.endH;
    let h = this._yToH(clientY - rect.top);
    h = Math.max(ax.startH, Math.min(maxH, h));
    h = Math.round(h * 12) / 12; // snap to 5-minute increments
    d.pendingTime = new Date(this._winStart.getTime() + h * 3600000);

    const y = this._hToY ? this._hToY(h) : Math.max(0, clientY - rect.top);
    const dot = document.getElementById('ddot'), tl = document.getElementById('dtl'), row = document.getElementById('drow');
    const label = String(d.pendingTime.getHours()).padStart(2, '0') + ':' + String(d.pendingTime.getMinutes()).padStart(2, '0');
    if (dot) dot.style.top = (y - 6) + 'px';
    if (tl) { tl.style.top = (y - 8) + 'px'; tl.textContent = label; }
    if (row) row.style.top = (y - 19) + 'px';
  },
  dragEnd() {
    const d = this._drag; this._drag = null;
    clearTimeout(this._dragTimer);
    // IMPORTANT: this fires on every pointerup anywhere in the app (see main.js), not just
    // drag gestures. When no drag was active, do NOT touch state/rerender here — a rerender
    // mid-gesture replaces the DOM between mouseup and the browser's click dispatch, which
    // silently drops the click on whatever the user was actually tapping (e.g. every button
    // in the app, including this very welcome screen's "開始記錄" button).
    if (!d) return;
    if (d.active) {
      if (d.pendingTime) Store.updateEvent(d.id, { time: d.pendingTime.toISOString() });
      // Confirmation is a brief glow on the chip itself instead of a toast — the chip
      // already visibly settles into its new position on release, so a popup saying
      // "time updated" was redundant and just delayed/blocked the view for 1.7s.
      clearTimeout(this._glowTimer);
      this.set({ dragId: null, justUpdatedId: d.id });
      this._glowTimer = setTimeout(() => this.set({ justUpdatedId: null }), 900);
    }
    else if (!d.moved) {
      this.set({ dragId: null });
      const rec = Store.data.events.find(e => e.id === d.id);
      if (rec) this.openEditRec(rec);
    } else this.set({ dragId: null });
  },

  // ---- growth ----
  openGrowth() { this.set({ sheet: 'growth', gDate: todayStr(), gWeight: '', gHeight: '', gHead: '' }); },
  saveGrowth() {
    // Same reasoning as closeWelcome/_editByValue: these fields have no onchange binding,
    // read straight from the DOM at submit time.
    const dv = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const gWeight = dv('f-g-weight'), gHeight = dv('f-g-height'), gHead = dv('f-g-head');
    if (!gWeight && !gHeight && !gHead) { this.set({ sheet: null }); return; }
    const f = (x) => { const n = parseFloat(x); return isNaN(n) ? null : n; };
    Store.addGrowth({ date: this.state.gDate, weight: f(gWeight), height: f(gHeight), head: f(gHead) });
    this.set({ sheet: null });
    this.toast('📈', '成長記錄了！');
  },

  // ---- welcome ----
  closeWelcome() {
    // Read straight from the DOM rather than state.welcomeName: the input has no onchange
    // binding (typing must not trigger a full re-render, which would blow away the very
    // button the user is mid-tap on). Set local state false first so the modal closes in
    // one clean render instead of flashing through Store's own re-render first.
    const el = document.getElementById('f-welcome-name');
    const v = (el && el.value.trim()) || '我';
    this.set({ showWelcome: false, welcomeName: v });
    Store.setCaregiver(v);
  },

  // ---- settings ----
  setBabyName(v) { Store.updateSettings({ babyName: v }); },
  setBabyBirth(v) { Store.updateSettings({ babyBirth: v }); },
  setBabySex(v) { Store.updateSettings({ babySex: v }); },
  setCaregiver(v) { Store.setCaregiver(v); },
  setDurationMode(type, mode) { Store.updateDuration(type, { mode }); },
  setDurationMin(type, delta) {
    const cur = Store.data.settings.duration[type].minutes;
    Store.updateDuration(type, { minutes: Math.max(0, cur + delta) });
  },
  setDefMilk(which, v) {
    const d = Object.assign({}, Store.data.settings.defaultMilk, { [which]: parseInt(v, 10) || 0 });
    Store.updateSettings({ defaultMilk: d });
  },
  incAlarm() { Store.updateSettings({ alarmOffsetMinutes: Math.min(60, (Store.data.settings.alarmOffsetMinutes || 0) + 5) }); },
  decAlarm() { Store.updateSettings({ alarmOffsetMinutes: Math.max(-60, (Store.data.settings.alarmOffsetMinutes || 0) - 5) }); },
  setExportFrom(v) { this.set({ exportFrom: v }); },
  setExportTo(v) { this.set({ exportTo: v }); },
  doExport() {
    downloadCsv(this.state.exportFrom, this.state.exportTo);
    this.toast('📅', 'CSV 已下載');
  },
  doBackup() {
    downloadJsonBackup();
    this.toast('💾', '備份已下載');
  },
  signIn() { Sync.signInWithGoogle(); },
  signOut() { Sync.signOut(); },
};

window.A = App;
