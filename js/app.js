// App state + actions. Rendering lives in views.js; this file owns "what can happen".

// Bump per CHANGELOG.md: patch = fixes/tweaks, minor = new features, major = architecture
// changes (e.g. the GitHub->Firebase sync swap). Shown at the bottom of the settings page.
const APP_VERSION = '2.27.0';

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
    statsPeriodOffset: 0, // 0 = current week/month/year, negative = swiped back N periods
    statsExpandedBar: null, // index of the tapped-open ml chart bar, or null
    growthMetric: 'weight',
    growthZoomed: true, // whether the growth chart is zoomed to "birth..current age+2m" or showing the full 0-24m span
    calYear: new Date().getFullYear(),
    calMonthNum: new Date().getMonth(), // 0-indexed, bounded between firstEventMonth() and the real current month
    calExpandedDay: null, // dayKey string ('YYYY-MM-DD') of the day currently expanded below the calendar, or null
    compareMode: false,
    compareDays: [], // up to 4 dayKey strings, selected while compareMode is on
    dayFilterTypes: ['milk', 'poop', 'pee', 'brush'], // which event types renderMultiDayTimeline shows — shared by the single-day expand panel and compare mode
    pendingCaregiverRename: null, // { oldName, newName } while confirming a "我是…" change that would bulk-rewrite past records
    editingId: null,
    editBy: '',
    editDate: todayStr(), // which calendar date the edit sheet's time stepper applies to — see openEditRec/saveEdit
    recDate: todayStr(), // which calendar date the ADD-new-record sheets (milk/quick poop-pee-brush) apply to — see openMilk/startPress/confirmRecord
    recBy: '', // who handled it, for the ADD-new-record sheets (kept separate from editBy so add/edit flows don't cross-contaminate) — pre-filled to Store.caregiver on open, applies only to this one record
    confirmDelId: null,
    dragId: null,
    justUpdatedId: null, // briefly set after a timeline drag commits, to glow that chip
    frontChipId: null, // which overlapping timeline chip (if any) is currently brought to front
    expandedGaps: [],
    numEdit: null, // { field, value } while a tap-to-edit number input is open
    showPredictionOverlay: false, // long-press the home "next feed" icon to toggle — see renderTodayTimeline
    toast: null,
    showWelcome: false,
    welcomeName: '',
    gDate: '', gWeight: '', gHeight: '', gHead: '',
    editingGrowthId: null,
    confirmDelGrowthId: null,
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
  _statsSwipe: null,
  _predPressTimer: null,

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
  predictAmount() {
    return predictNextAmount(Store.liveEvents(), Store.data.settings.babyBirth);
  },
  // Long-press the home "next feed" icon to reveal the prediction-vs-actual overlay on
  // today's timeline (see renderTodayTimeline) — hidden by default, purely a debugging/
  // curiosity view, not part of the everyday UI.
  startPredictionPress() {
    clearTimeout(this._predPressTimer);
    this._predPressTimer = setTimeout(() => {
      this.set({ showPredictionOverlay: !this.state.showPredictionOverlay });
    }, 450);
  },
  endPredictionPress() { clearTimeout(this._predPressTimer); },

  // ---- navigation ----
  goHome() { this.set({ screen: 'home', sheet: null }); },
  goStats() { this.set({ screen: 'stats', sheet: null }); },
  goRecords() { this.set({ screen: 'records', sheet: null }); },

  // ---- records calendar ----
  calPrevMonth() {
    const first = firstEventMonth();
    let y = this.state.calYear, m = this.state.calMonthNum - 1;
    if (m < 0) { m = 11; y--; }
    if (first && (y < first.y || (y === first.y && m < first.m))) return;
    this.set({ calYear: y, calMonthNum: m, calExpandedDay: null });
  },
  calNextMonth() {
    const now = new Date();
    let y = this.state.calYear, m = this.state.calMonthNum + 1;
    if (m > 11) { m = 0; y++; }
    if (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth())) return;
    this.set({ calYear: y, calMonthNum: m, calExpandedDay: null });
  },
  // Same handler for both selecting a day on the calendar AND removing one from the
  // compare-mode chip list (see renderRecords) — it's a plain toggle either way.
  calTapDay(key) {
    if (this.state.compareMode) {
      const cur = this.state.compareDays;
      if (cur.includes(key)) this.set({ compareDays: cur.filter(k => k !== key) });
      else if (cur.length < 4) this.set({ compareDays: [...cur, key] });
      return;
    }
    this.set({ calExpandedDay: this.state.calExpandedDay === key ? null : key });
  },
  toggleCompareMode() { this.set({ compareMode: !this.state.compareMode, compareDays: [], calExpandedDay: null }); },
  toggleDayFilterType(type) {
    const cur = this.state.dayFilterTypes;
    this.set({ dayFilterTypes: cur.includes(type) ? cur.filter(t => t !== type) : [...cur, type] });
  },
  goConfig() { this.set({ screen: 'config', sheet: null }); },
  closeSheet() {
    if (this.state.sheet === 'growth') this.resetZoom();
    this.set({ sheet: null });
  },
  // iOS Safari zooms the viewport in when a focused input's font-size is under 16px (the
  // growth sheet's weight/height/head fields are the only ones in the app small enough to
  // trigger it) and is supposed to zoom back out on blur — but that often doesn't fire
  // when the blur happens because we just tore down the whole sheet via a full re-render,
  // rather than the user calmly tapping elsewhere. Forcing maximum-scale down to 1.0
  // snaps the zoom back immediately; restoring the original viewport content right after
  // lets the user pinch-zoom normally again afterward.
  resetZoom() {
    const viewport = document.querySelector('meta[name=viewport]');
    if (!viewport) return;
    const original = viewport.getAttribute('content');
    viewport.setAttribute('content', original + ', maximum-scale=1.0');
    setTimeout(() => viewport.setAttribute('content', original), 350);
  },

  // ---- stats: period switching + swipe navigation + tap-to-expand ml bar ----
  setStatsRange(range) { this.set({ statsRange: range, statsPeriodOffset: 0, statsExpandedBar: null }); },
  toggleMlBar(i) { this.set({ statsExpandedBar: this.state.statsExpandedBar === i ? null : i }); },
  // Swipe left = further back in time, swipe right = toward the present (same convention
  // as e.g. Apple Health's weekly charts). Clamped so you can't swipe past "now" or past
  // the earliest period that actually has any records (see minStatsOffset, views.js).
  // Follow-the-finger paging for the stats charts. The charts track the finger live (via a
  // direct transform on #stats-swipe, NOT a state re-render per move — same approach as the
  // timeline/sheet drags) so it feels responsive instead of "did anything happen?", then
  // snaps to the next/prev period or springs back on release. Direction is locked on the
  // first few px of movement so a mostly-vertical drag is left to the page's own scroll (on
  // touch, touch-action:pan-y already routes vertical to native scroll; the lock is mainly
  // for mouse/trackpad, where touch-action doesn't apply).
  startStatsSwipe(clientX, clientY) { this._statsSwipe = { startX: clientX, startY: clientY, locked: null }; },
  _statsSwipeNode() { return document.getElementById('stats-swipe'); },
  statsSwipeMove(clientX, clientY) {
    const s = this._statsSwipe;
    if (!s) return;
    const dx = clientX - s.startX, dy = clientY - s.startY;
    if (s.locked === null) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return; // not enough to tell direction yet
      s.locked = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
      if (s.locked === 'v') { this._statsSwipe = null; return; } // vertical — hand back to page scroll
    }
    if (s.locked !== 'h') return;
    // Direction follows the finger like a carousel: dragging RIGHT reveals the PREVIOUS
    // (older) period from the left, dragging LEFT brings the NEXT (newer) one. Rubber-band
    // when there's nowhere further to go (dragging left while already on the current period,
    // or right while on the oldest one with data) so the edge feels bounded, not dead.
    const range = this.state.statsRange, off = this.state.statsPeriodOffset;
    const blocked = (dx < 0 && off >= 0) || (dx > 0 && off <= minStatsOffset(range));
    const eff = blocked ? dx * 0.25 : dx;
    const node = this._statsSwipeNode();
    if (node) { node.style.transition = 'none'; node.style.transform = `translateX(${eff}px)`; node.style.opacity = String(Math.max(0.55, 1 - Math.abs(eff) / 650)); }
  },
  _springStatsSwipeBack() {
    const node = this._statsSwipeNode();
    if (node) { node.style.transition = 'transform .2s ease, opacity .2s ease'; node.style.transform = 'translateX(0)'; node.style.opacity = '1'; }
  },
  // Fires on pointercancel (mobile browsers raise this instead of pointerup when they decide
  // mid-gesture the touch was a scroll / system gesture) — without handling it, the charts
  // stayed frozen wherever the finger left them because the spring-back only ran on pointerup.
  cancelStatsSwipe() {
    const s = this._statsSwipe; this._statsSwipe = null;
    if (s && s.locked === 'h') this._springStatsSwipeBack();
  },
  endStatsSwipe(clientX) {
    const s = this._statsSwipe; this._statsSwipe = null;
    if (!s || s.locked !== 'h') return;
    const dx = clientX - s.startX;
    const node = this._statsSwipeNode();
    const range = this.state.statsRange;
    const width = node ? node.offsetWidth : 320;
    const commit = Math.abs(dx) > Math.min(90, width * 0.25);
    const dir = dx < 0 ? 1 : -1; // drag left -> newer (+1 toward 0), drag right -> older (-1)
    const next = Math.max(minStatsOffset(range), Math.min(0, this.state.statsPeriodOffset + dir));
    if (commit && next !== this.state.statsPeriodOffset) {
      // Slide the current charts the rest of the way out IN THE FINGER'S DIRECTION, then
      // re-render at the new period (the fresh node comes back centred, so the eye reads it
      // as the new period snapping in).
      if (node) { node.style.transition = 'transform .17s ease, opacity .17s ease'; node.style.transform = `translateX(${dx < 0 ? -width : width}px)`; node.style.opacity = '0'; }
      setTimeout(() => this.set({ statsPeriodOffset: next, statsExpandedBar: null }), 165);
    } else {
      this._springStatsSwipeBack();
    }
  },

  toggleTheme() {
    const sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    const effNight = this.state.theme === 'night' || (this.state.theme === 'auto' && sysDark);
    this.setTheme(effNight ? 'day' : 'night');
  },
  setTheme(t) { Store.local('theme', t); this.set({ theme: t }); },

  // ---- quick record (poop/pee/brush tap & long-press) ----
  recordNow(type) {
    Store.addEvent(type, new Date());
    const map = { poop: ['💩', '排便記錄了！'], pee: ['💧', '尿尿記錄了！'], brush: ['👄', '刷牙記錄了！'] };
    // The "also add the other one" toast shortcut only makes sense for poop/pee (same
    // diaper change often has both) — brushing has no such pairing.
    const other = type === 'poop' ? 'pee' : type === 'pee' ? 'poop' : null;
    const ev = Store.data.events[Store.data.events.length - 1];
    this.toast(map[type][0], map[type][1], other, ev.id);
  },
  startPress(type) {
    this._longFired = false;
    clearTimeout(this._pressTimer);
    this._pressTimer = setTimeout(() => {
      this._longFired = true;
      const now = new Date();
      this.set({ sheet: 'edit', recordType: type, rt: { h: now.getHours(), m: Math.round(now.getMinutes() / 5) * 5 % 60 }, recDate: todayStr(), recBy: Store.caregiver || '' });
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
      recDate: todayStr(),
      recBy: Store.caregiver || '',
      milkBreast: Store.data.settings.defaultMilk.breast,
      milkFormula: Store.data.settings.defaultMilk.formula,
    });
  },
  onRecDate(v) { this.set({ recDate: v }); },
  // Tapping a caregiver chip in an ADD sheet (see renderMilkSheet/renderEditSheet) — a plain
  // re-render is fine for a tap. The text field below it has no onchange (same reasoning as
  // _editByValue: a re-render mid-tap could drop the click on the confirm button next to it),
  // so its typed value is read live at submit via _recByValue().
  pickRecBy(name) { this.set({ recBy: name }); },
  _recByValue() {
    const el = document.getElementById('f-rec-by');
    return (el && el.value.trim()) || this.state.recBy || Store.caregiver || '未命名';
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
    // Built from the sheet's own date field (recDate), not "today" — see openMilk/
    // startPress, which pre-fill it to today but let it be changed to backdate a forgotten
    // record. Same local-safe construction as _editDateTime()/dateFromKey().
    const [ry, rm, rd] = s.recDate.split('-').map(Number);
    const t = new Date(ry, rm - 1, rd); t.setHours(s.rt.h, s.rt.m, 0, 0);
    const type = s.recordType;
    const by = this._recByValue(); // chosen in the sheet's 由誰處理 picker; applies to this record only
    if (type === 'milk') {
      const ev = Store.addEvent('milk', t, { breastMl: s.milkBreast, formulaMl: s.milkFormula, amountMl: s.milkBreast + s.milkFormula, by });
      this._snapshotLivePrediction(ev);
      this.set({ sheet: null });
      this.toast('🍼', '喝奶記錄了！');
    } else {
      Store.addEvent(type, t, { by });
      const ev = Store.data.events[Store.data.events.length - 1];
      const other = type === 'poop' ? 'pee' : type === 'pee' ? 'poop' : null;
      const map = { poop: ['💩', '排便記錄了！'], pee: ['💧', '尿尿記錄了！'], brush: ['👄', '刷牙記錄了！'] };
      this.set({ sheet: null });
      this.toast(map[type][0], map[type][1], other, ev.id);
    }
  },
  // 即測 (live-prediction snapshot): the instant a feed is logged, freeze what the live
  // "next feed" prediction now says onto that feed, so it can later be compared against the
  // feed that actually follows (see analyzeTodayPredictionAccuracy's `live*` fields and the
  // timeline's 即測 line). Only when this feed is the latest milk feed — backdating a
  // forgotten record shouldn't attach a "predicted next feed" made from the vantage point of
  // now onto a feed that already has a real later feed after it (that next feed is no longer
  // unknown, so the snapshot would be meaningless). A poop/pee logged later doesn't count as
  // a "later feed" and doesn't block this.
  _snapshotLivePrediction(ev) {
    const evTime = new Date(ev.time).getTime();
    const laterFeed = Store.liveEvents().some(e => e.id !== ev.id && e.type === 'milk' && new Date(e.time).getTime() > evTime);
    if (laterFeed) return;
    const pred = predictNextFeed(Store.data.events, Store.data.settings.alarmOffsetMinutes || 0);
    if (!pred || pred.status !== 'ok' || !pred.nextTime) return;
    const ml = predictNextAmount(Store.data.events, Store.data.settings.babyBirth);
    Store.updateEvent(ev.id, { predNextTime: pred.nextTime.toISOString(), predNextMl: ml });
  },
  addOther() {
    const t = this.state.toast;
    if (!t || !t.addType) return;
    const src = Store.data.events.find(e => e.id === t.addEvId);
    // Inherit the paired record's caregiver — one diaper change is one person's doing, so the
    // "also add the other" shortcut shouldn't silently fall back to the device default.
    Store.addEvent(t.addType, src ? new Date(src.time) : new Date(), src ? { by: src.by } : undefined);
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
    const st = { sheet: 'editRec', editingId: rec.id, recordType: rec.type, rt: { h: dt.getHours(), m: dt.getMinutes() }, editDate: todayStr(dt), editBy: rec.by || Store.caregiver || '' };
    if (rec.type === 'milk') { st.milkBreast = rec.breastMl || 0; st.milkFormula = rec.formulaMl || 0; }
    this.set(st);
  },
  onEditDate(v) { this.set({ editDate: v }); },
  setEditType(t) { this.set({ recordType: t }); },
  onEditBy(v) { this.set({ editBy: v }); },
  // Tapping a caregiver tag (see allCaregiverNames/renderEditRecSheet) — a normal rerender
  // is fine here (unlike typing in the text input), since a tap isn't the same
  // mid-keystroke gesture that a rerender would otherwise interrupt.
  pickEditBy(name) { this.set({ editBy: name }); },
  // The 由誰處理 field has no onchange binding (see closeWelcome for why: a re-render
  // mid-tap can drop the click on the Save/Delete button right next to it), so read
  // the live DOM value at submit time instead of state.editBy.
  _editByValue() {
    const el = document.getElementById('f-edit-by');
    return (el && el.value.trim()) || this.state.editBy || Store.caregiver || '未命名';
  },
  // Builds the edited record's full timestamp from the edit sheet's OWN date field, not
  // "today" — a plain `new Date("YYYY-MM-DD")` parses as UTC midnight (shifts a day in any
  // timezone ahead of UTC), so this constructs it from the parts directly, same as
  // dateFromKey() in views.js.
  _editDateTime() {
    const [y, m, d] = this.state.editDate.split('-').map(Number);
    const t = new Date(y, m - 1, d);
    t.setHours(this.state.rt.h, this.state.rt.m, 0, 0);
    return t;
  },
  saveEdit() {
    const s = this.state;
    const t = this._editDateTime();
    const patch = { type: s.recordType, time: t.toISOString(), by: this._editByValue() };
    if (s.recordType === 'milk') Object.assign(patch, { breastMl: s.milkBreast, formulaMl: s.milkFormula, amountMl: s.milkBreast + s.milkFormula });
    Store.updateEvent(s.editingId, patch);
    this.set({ sheet: null });
    this.toast('✏️', '已更新');
  },
  editAddOther() {
    const s = this.state;
    const t = this._editDateTime();
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
      // If the finger already moved noticeably before the hold threshold elapsed, this
      // was a scroll/swipe passing through the chip, not a deliberate press-and-hold —
      // don't hijack it into a drag. This, plus the longer hold threshold below, is what
      // fixed chips being too easy to accidentally grab while scrolling the timeline.
      if (this._drag && !this._drag.moved) {
        this._drag.active = true;
        clearTimeout(this._glowTimer);
        this.set({ dragId: this._drag.id, justUpdatedId: this._drag.id });
        this._glowTimer = setTimeout(() => this.set({ justUpdatedId: null }), 900);
      }
    }, 740);
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
    }
    // else: moved but never activated (a scroll/swipe through the chip, cancelled above)
    // — dragId was never set for it, so there's nothing to clear and no rerender needed.
    else if (this.state.dragId != null) this.set({ dragId: null });
  },

  // ---- growth ----
  openGrowth() { this.set({ sheet: 'growth', editingGrowthId: null, gDate: todayStr(), gWeight: '', gHeight: '', gHead: '' }); },
  // Same growth sheet as openGrowth(), just pre-filled and flagged as editing an existing
  // record — saveGrowth() branches to Store.updateGrowth() instead of addGrowth() below.
  openEditGrowth(rec) {
    this.set({
      sheet: 'growth', editingGrowthId: rec.id, gDate: rec.date,
      gWeight: rec.weight ?? '', gHeight: rec.height ?? '', gHead: rec.head ?? '',
    });
  },
  saveGrowth() {
    this.resetZoom();
    // Same reasoning as closeWelcome/_editByValue: these fields have no onchange binding,
    // read straight from the DOM at submit time.
    const dv = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const gWeight = dv('f-g-weight'), gHeight = dv('f-g-height'), gHead = dv('f-g-head');
    if (!gWeight && !gHeight && !gHead) { this.set({ sheet: null, editingGrowthId: null }); return; }
    const f = (x) => { const n = parseFloat(x); return isNaN(n) ? null : n; };
    const weight = f(gWeight), height = f(gHeight), head = f(gHead);
    // Sanity bounds (generous enough to cover 0-24 months, not tied to any one baby's own
    // history) — these are plain text inputs so nothing stops a stray extra digit or typo,
    // and a wildly-off value would silently distort the growth chart/percentile otherwise.
    const GROWTH_BOUNDS = { weight: [0.3, 40], height: [25, 130], head: [20, 60] };
    const outOfRange = (v, [lo, hi]) => v != null && (v < lo || v > hi);
    if (outOfRange(weight, GROWTH_BOUNDS.weight) || outOfRange(height, GROWTH_BOUNDS.height) || outOfRange(head, GROWTH_BOUNDS.head)) {
      this.toast('⚠️', '數值看起來不太合理，請確認後再送出');
      return;
    }
    const patch = { date: this.state.gDate, weight, height, head };
    if (this.state.editingGrowthId) {
      Store.updateGrowth(this.state.editingGrowthId, patch);
      this.toast('✏️', '已更新');
    } else {
      Store.addGrowth(patch);
      this.toast('📈', '成長記錄了！');
    }
    this.set({ sheet: null, editingGrowthId: null });
  },
  deleteFromGrowthEdit() {
    this.resetZoom();
    this.set({ sheet: null, confirmDelGrowthId: this.state.editingGrowthId, editingGrowthId: null });
  },
  cancelDeleteGrowth() { this.set({ confirmDelGrowthId: null }); },
  doDeleteGrowth() {
    const id = this.state.confirmDelGrowthId;
    Store.deleteGrowth(id);
    this.set({ confirmDelGrowthId: null });
    this.toast('🗑️', '已刪除');
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

  // ---- baby avatar: emoji or a compressed photo thumbnail, see renderAvatarSheet ----
  openAvatarPicker() { this.set({ sheet: 'avatar' }); },
  setBabyEmoji(e) { Store.updateSettings({ babyEmoji: e, babyPhoto: '' }); this.set({ sheet: null }); },
  removeBabyPhoto() { Store.updateSettings({ babyPhoto: '' }); this.set({ sheet: null }); },
  // Resizes/crops to a small square JPEG before storing — this goes straight into the
  // settings document (synced as plain JSON, same as everything else), so it needs to stay
  // well under Firestore's 1MB document limit and not bloat every settings sync. A proper
  // photo library would use Cloud Storage instead, but that's a separate Firebase product
  // this app doesn't use yet — a compressed thumbnail is plenty for a single avatar photo.
  handleAvatarFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const SIZE = 160;
        const canvas = document.createElement('canvas');
        canvas.width = SIZE; canvas.height = SIZE;
        const ctx = canvas.getContext('2d');
        const side = Math.min(img.width, img.height);
        const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
        Store.updateSettings({ babyPhoto: canvas.toDataURL('image/jpeg', 0.7) });
        this.set({ sheet: null });
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  },
  // Renaming "我是…" bulk-rewrites every past record's `by` field to match (see
  // Store.setCaregiver) — worth a confirmation step since a mistyped/accidental change
  // would otherwise silently overwrite history with no undo. Only the actual rename case
  // needs confirming: first-time setup (old name empty) or re-submitting the same name
  // go straight through.
  requestSetCaregiver(v) {
    const newName = (v || '').trim();
    const oldName = Store.caregiver;
    if (!newName || !oldName || newName === oldName) { Store.setCaregiver(newName); return; }
    this.set({ pendingCaregiverRename: { oldName, newName } });
  },
  confirmCaregiverRename() {
    const p = this.state.pendingCaregiverRename;
    if (!p) return;
    Store.setCaregiver(p.newName);
    this.set({ pendingCaregiverRename: null });
  },
  cancelCaregiverRename() { this.set({ pendingCaregiverRename: null }); },
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
