// App state + actions. Rendering lives in views.js; this file owns "what can happen".

// Bump per CHANGELOG.md: patch = fixes/tweaks, minor = new features, major = architecture
// changes (e.g. the GitHub->Firebase sync swap). Shown at the bottom of the settings page.
const APP_VERSION = '2.2.0';

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
    expandedGaps: [],
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
  setBreast(v) { this.set({ milkBreast: parseInt(v, 10) || 0 }); },
  setFormula(v) { this.set({ milkFormula: parseInt(v, 10) || 0 }); },

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
    let h = this._yToH(clientY - rect.top);
    h = Math.max(ax.startH, Math.min(ax.endH, h));
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
      this.set({ dragId: null });
      this.toast('🕑', '時間已更新');
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
