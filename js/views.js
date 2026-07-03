// Pure(ish) rendering: state + Store -> HTML strings. All interactivity is wired via
// inline on* attributes calling into window.A (see app.js) — no virtual DOM, just re-render.

let _timelineMeta = null; // { yToH(y), axis:{startH,endH} } — read by main.js after DOM insert

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hm(date) {
  return String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}
function fracOf(date) { return date.getHours() + date.getMinutes() / 60; }

function milkColorOf(ev) { return (ev.breastMl > 0 && ev.formulaMl > 0) ? '#C77D52' : ((ev.formulaMl > 0) ? '#E8A33D' : '#FF8C6B'); }
function dotColor(ev) { return ev.type === 'milk' ? milkColorOf(ev) : ev.type === 'poop' ? '#C8965A' : '#79C3F0'; }
function tintBg(ev) { return ev.type === 'milk' ? ((ev.breastMl > 0 && ev.formulaMl > 0) ? 'var(--tMix)' : (ev.formulaMl > 0 ? 'var(--tMilkF)' : 'var(--tMilkB)')) : ev.type === 'poop' ? 'var(--tPoop)' : 'var(--tPee)'; }
function emojiOf(t) { return t === 'milk' ? '🍼' : t === 'poop' ? '💩' : '💧'; }

// ============================= THEME =============================
function applyTheme(state) {
  const sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const effNight = state.theme === 'night' || (state.theme === 'auto' && sysDark);
  // Set on <html>, not .app: CSS custom properties only cascade DOWN to descendants.
  // .app is a descendant of body/#root, so those ancestors could never see --bg2 etc.
  // when the attribute lived on .app — that's what was showing as a white background
  // outside the 440px column (and bleeding through on mobile when 100vh misbehaves).
  document.documentElement.setAttribute('data-theme', effNight ? 'night' : 'day');
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', effNight ? '#16130E' : '#FAF6EF');
  return effNight;
}

// ============================= NAV =============================
function navIcon(name, active) {
  const c = active ? 'var(--accent)' : 'var(--text3)';
  if (name === 'home') return `<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 9.5L11 3l8 6.5V19a1 1 0 01-1 1H14v-5H8v5H4a1 1 0 01-1-1z" fill="${c}"/></svg>`;
  if (name === 'stats') return `<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="2" y="12" width="4" height="7" rx="1.5" fill="${c}"/><rect x="9" y="7" width="4" height="12" rx="1.5" fill="${c}"/><rect x="16" y="4" width="4" height="15" rx="1.5" fill="${c}"/></svg>`;
  if (name === 'records') return `<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><rect x="3" y="2" width="16" height="18" rx="3" stroke="${c}" stroke-width="1.5"/><path d="M7 7h8M7 11h8M7 15h5" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/></svg>`;
  return `<svg width="22" height="22" viewBox="0 0 22 22" fill="none"><circle cx="11" cy="11" r="3" stroke="${c}" stroke-width="1.5"/><path d="M11 2v2m0 14v2M2 11h2m14 0h2m-3.17-6.83-1.42 1.42M6.59 15.41l-1.42 1.42M18.83 17.83l-1.42-1.42M5.59 6.59 4.17 5.17" stroke="${c}" stroke-width="1.5" stroke-linecap="round"/></svg>`;
}
function backIcon() { return `<svg width="9" height="15" viewBox="0 0 9 15" fill="none"><path d="M8 1L1.5 7.5 8 14" stroke="var(--text)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`; }

// The quick-record buttons (milk/poop/pee) fan out above the FAB like paw-print toes
// above a heel pad — 3 fixed points on an arc, computed with plain trig instead of a
// canvas/SVG path since there are only ever 3 of them. Positioned relative to the FAB
// button's own top-center (see the wrapper div in renderNav), radius/spread tuned to sit
// close above the FAB without colliding with the home/stats/records/config icons on
// either side.
function pawButtons() {
  // R/spreadDeg tuned so adjacent buttons' chord distance clears their combined diameter
  // (with a few px to spare) instead of overlapping, while staying inside the horizontal
  // gap to the home/stats/records/config icons on either side.
  const R = 50, spreadDeg = 96, size = Math.round(32 * 1.15);
  const items = [
    { emoji: '🍼', bg: '#FCD0A1', shadow: 'rgba(252,208,161,.55)', attrs: `onclick="A.openMilk()"` },
    { emoji: '💩', bg: '#995D81', shadow: 'rgba(153,93,129,.4)', attrs: `onclick="A.tap('poop')" onpointerdown="A.startPress('poop')" onpointerup="A.endPress()" onpointerleave="A.endPress()"` },
    { emoji: '💧', bg: '#9BB1FF', shadow: 'rgba(155,177,255,.5)', attrs: `onclick="A.tap('pee')" onpointerdown="A.startPress('pee')" onpointerup="A.endPress()" onpointerleave="A.endPress()"` },
  ];
  const n = items.length, dropPx = 15, sideOutPx = 5;
  return items.map((it, i) => {
    const angleDeg = -spreadDeg / 2 + (spreadDeg * i / (n - 1));
    const rad = angleDeg * Math.PI / 180;
    let dx = R * Math.sin(rad);
    const dy = -R * Math.cos(rad) + dropPx;
    if (dx !== 0) dx += Math.sign(dx) * sideOutPx; // push the left/right buttons further out, middle stays centered
    return `<button ${it.attrs} style="position:absolute;left:calc(50% + ${dx.toFixed(1)}px - ${size / 2}px);top:${(dy - size / 2).toFixed(1)}px;width:${size}px;height:${size}px;border-radius:50%;border:none;background:${it.bg};box-shadow:0 3px 10px ${it.shadow};display:flex;align-items:center;justify-content:center;font-size:17px;z-index:5;">${it.emoji}</button>`;
  }).join('');
}
function renderNav(state) {
  const s = state.screen;
  return `
  <div style="flex-shrink:0;height:84px;background:var(--nav);backdrop-filter:blur(10px);border-top:1px solid var(--line);display:flex;align-items:flex-start;justify-content:space-around;padding:10px 4px 0;z-index:20;">
    <button onclick="A.goHome()" style="background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:56px;">
      ${navIcon('home', s === 'home')}<span style="font-size:10px;font-weight:700;color:${s === 'home' ? 'var(--accent)' : 'var(--text3)'};">首頁</span>
    </button>
    <button onclick="A.goStats()" style="background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:56px;">
      ${navIcon('stats', s === 'stats')}<span style="font-size:10px;font-weight:700;color:${s === 'stats' ? 'var(--accent)' : 'var(--text3)'};">統計</span>
    </button>
    <div style="position:relative;width:60px;display:flex;flex-direction:column;align-items:center;margin-top:-18px;">
      <button onclick="A.openGrowth()" style="background:none;border:none;display:flex;flex-direction:column;align-items:center;">
        <div style="width:54px;height:54px;border-radius:50%;background:var(--fab);display:flex;align-items:center;justify-content:center;box-shadow:0 4px 18px var(--fabGlow);">
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none"><line x1="13" y1="5" x2="13" y2="21" stroke="white" stroke-width="2.5" stroke-linecap="round"/><line x1="5" y1="13" x2="21" y2="13" stroke="white" stroke-width="2.5" stroke-linecap="round"/></svg>
        </div>
      </button>
      ${pawButtons()}
    </div>
    <button onclick="A.goRecords()" style="background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:56px;">
      ${navIcon('records', s === 'records')}<span style="font-size:10px;font-weight:700;color:${s === 'records' ? 'var(--accent)' : 'var(--text3)'};">紀錄</span>
    </button>
    <button onclick="A.goConfig()" style="background:none;border:none;display:flex;flex-direction:column;align-items:center;gap:3px;min-width:56px;">
      ${navIcon('config', s === 'config')}<span style="font-size:10px;font-weight:700;color:${s === 'config' ? 'var(--accent)' : 'var(--text3)'};">設定</span>
    </button>
  </div>`;
}

function headerBar(title) {
  return `<div style="padding:18px 22px 8px;display:flex;align-items:center;gap:12px;">
    <button onclick="A.goHome()" style="width:38px;height:38px;border-radius:50%;background:var(--card);border:none;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px var(--shadow);">${backIcon()}</button>
    <h1 style="font-size:24px;font-weight:800;letter-spacing:-.5px;color:var(--text);">${title}</h1>
  </div>`;
}

// ============================= HOME =============================
function renderSyncPill() {
  const st = Sync.state;
  const spinner = `<div style="width:15px;height:15px;border:2px solid var(--track);border-top-color:var(--accent);border-radius:50%;animation:spin .7s linear infinite;"></div>`;
  if (st === 'signing-in') return `<div style="display:flex;align-items:center;gap:8px;color:var(--text2);font-size:12px;font-weight:600;">${spinner}登入中…</div>`;
  if (st === 'syncing') return `<div style="display:flex;align-items:center;gap:8px;color:var(--text2);font-size:12px;font-weight:600;">${spinner}連接中…</div>`;
  if (st === 'done') return `<div style="display:flex;align-items:center;gap:6px;color:#4FA84F;font-size:12px;font-weight:700;">✓ 即時同步中</div>`;
  if (st === 'unauthorized') return `<div style="display:flex;align-items:center;gap:6px;color:#D2654A;font-size:12px;font-weight:700;">⚠ ${esc(Sync.message)}</div>`;
  if (st === 'fail') return `<div onclick="A.signIn()" style="cursor:pointer;display:flex;align-items:center;gap:6px;color:#D2654A;font-size:12px;font-weight:700;">⚠ ${esc(Sync.message || '同步失敗')}・點擊重試</div>`;
  return `<div onclick="A.signIn()" style="cursor:pointer;display:flex;align-items:center;gap:6px;color:var(--text3);font-size:11.5px;font-weight:600;">🔗 點擊登入以同步</div>`;
}

function renderPrediction() {
  const p = AppRef().predict();
  if (p.status === 'ok') {
    const rem = (p.nextTime - new Date()) / 60000;
    let cd;
    if (rem > 0) { const rh = Math.floor(rem / 60), rm = Math.round(rem % 60); cd = '⏱ ' + (rh > 0 ? `還有 ${rh}h ${rm}m` : `還有 ${rm}m`); }
    else cd = '✨ 現在可以餵囉';
    return `<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px;">
      <div>
        <p style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:5px;">預計下一餐</p>
        <p style="font-size:34px;font-weight:800;letter-spacing:-1.5px;line-height:1;color:var(--text);">${hm(p.nextTime)}</p>
        <p style="font-size:13px;color:var(--text2);font-weight:500;margin-top:4px;">${cd}</p>
      </div>
      <div style="width:62px;height:62px;border-radius:50%;background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:30px;">🍼</div>
    </div>`;
  }
  return `<div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;">
    <div style="width:56px;height:56px;border-radius:50%;background:var(--card2);display:flex;align-items:center;justify-content:center;font-size:26px;">🔍</div>
    <div><p style="font-size:15px;font-weight:800;color:var(--text);">資料蒐集中…</p><p style="font-size:12px;color:var(--text2);margin-top:3px;line-height:1.4;">記錄滿兩天後即可預測下一餐</p></div>
  </div>`;
}

function lastTimeLabel(type) {
  const evs = Store.liveEvents().filter(e => e.type === type).sort((a, b) => new Date(a.time) - new Date(b.time));
  return evs.length ? hm(new Date(evs[evs.length - 1].time)) : '--:--';
}

function renderTimeline(state) {
  const scales = [['today', '今天'], ['week', '本週'], ['month', '本月'], ['year', '本年']];
  const tabs = `<div style="display:flex;background:var(--card2);border-radius:14px;padding:4px;margin-bottom:16px;">
    ${scales.map(([k, l]) => `<button onclick="A.set({scale:'${k}'})" style="flex:1;padding:8px 0;border:none;border-radius:10px;font-size:12.5px;font-weight:700;font-family:inherit;background:${state.scale === k ? 'var(--card)' : 'transparent'};color:${state.scale === k ? 'var(--text)' : 'var(--text2)'};box-shadow:${state.scale === k ? '0 2px 6px var(--shadow)' : 'none'};">${l}</button>`).join('')}
  </div>`;

  let body;
  if (state.scale === 'today') body = renderTodayTimeline(state);
  else body = renderBarTimeline(state.scale);
  return `<div>${tabs}${body}</div>`;
}

function renderBarTimeline(scale) {
  const sets = {
    week: { data: weeklyMilkCounts(), labels: ['一', '二', '三', '四', '五', '六', '日'], cap: '每日喝奶次數' },
    month: { data: monthlyWeeklyMilkCounts(), labels: monthlyWeekLabels(), cap: '每週喝奶次數' },
    year: { data: yearlyMonthlyMilkCounts(), labels: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'], cap: '每月喝奶次數' },
  };
  const set = sets[scale];
  const max = Math.max(1, ...set.data);
  return `<div>
    <p style="font-size:12px;color:var(--text2);font-weight:600;margin-bottom:12px;">${set.cap}</p>
    <div style="display:flex;align-items:flex-end;gap:${scale === 'year' ? 4 : 8}px;height:130px;">
      ${set.data.map((v, i) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;">
        <div style="font-size:9px;color:var(--text3);font-weight:700;">${scale === 'year' ? '' : v}</div>
        <div style="width:100%;height:${Math.round(v / max * 96) + 6}px;background:linear-gradient(180deg,#FF8C6B,#FF6B4A);border-radius:6px;transform-origin:bottom;animation:growBar .5s ease;"></div>
        <div style="font-size:9px;color:var(--text2);font-weight:600;">${set.labels[i]}</div>
      </div>`).join('')}
    </div>
  </div>`;
}

// Local calendar date, NOT toISOString()'s UTC date — using UTC here meant "today" only
// rolled over at UTC midnight (08:00 in UTC+8), not local midnight, so the home screen's
// today-only stats stayed stuck on yesterday's numbers for hours after local midnight.
function dayKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function weeklyMilkCounts() {
  const now = new Date(); const out = [];
  const dow = (now.getDay() + 6) % 7; // Mon=0
  for (let i = 0; i < 7; i++) {
    const d = new Date(now); d.setDate(now.getDate() - dow + i); d.setHours(0, 0, 0, 0);
    const next = new Date(d); next.setDate(d.getDate() + 1);
    out.push(Store.liveEvents().filter(e => e.type === 'milk' && new Date(e.time) >= d && new Date(e.time) < next).length);
  }
  return out;
}
function monthlyWeekLabels() { return ['W1', 'W2', 'W3', 'W4', 'W5']; }
function monthlyWeeklyMilkCounts() {
  const now = new Date(); const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const out = [0, 0, 0, 0, 0];
  Store.liveEvents().forEach(e => {
    if (e.type !== 'milk') return;
    const t = new Date(e.time);
    if (t.getFullYear() !== now.getFullYear() || t.getMonth() !== now.getMonth()) return;
    const w = Math.min(4, Math.floor((t.getDate() - 1) / 7));
    out[w]++;
  });
  return out;
}
function yearlyMonthlyMilkCounts() {
  const now = new Date(); const out = new Array(12).fill(0);
  Store.liveEvents().forEach(e => {
    if (e.type !== 'milk') return;
    const t = new Date(e.time);
    if (t.getFullYear() !== now.getFullYear()) return;
    out[t.getMonth()]++;
  });
  return out;
}

// The "今天" timeline is a fixed rolling window (now-24h .. now+3h), not the calendar day.
// A fixed calendar-day window (00:00-24:00) breaks in two ways: it can't show anything
// from "yesterday" even one minute past midnight, and its width was previously *also*
// data-dependent (min event time .. now), making it look tiny with sparse data. Position
// on the axis is "hours since winStart" (a plain float, can exceed the old 0-24 range) —
// real Date math handles day rollover for free, so labels just work across midnight.
function renderTodayTimeline(state) {
  const now = new Date();
  const winStart = new Date(now.getTime() - 24 * 3600000);
  const winEnd = new Date(now.getTime() + 3 * 3600000);
  const posOf = (d) => (d.getTime() - winStart.getTime()) / 3600000;
  const dateOfPos = (p) => new Date(winStart.getTime() + p * 3600000);

  const windowEvents = Store.liveEvents()
    .filter(e => { const t = new Date(e.time); return t >= winStart && t <= winEnd; })
    .map(e => ({ ...e, h: posOf(new Date(e.time)) }));
  const pxH = 40, padTop = 14, HOURW = 22, axisX = 70, half = 19, keepR = 0.8, collapseMin = 3, collapsePx = 46;
  const dragEv = state.dragId ? windowEvents.find(e => e.id === state.dragId) : null;
  const startH = 0, endH = posOf(winEnd); // fixed window: always 0 .. 27
  const nowPos = posOf(now); // always 24, but computed for clarity/robustness
  const pts = windowEvents.map(e => e.h).concat([nowPos]);

  let keeps = pts.map(h => [Math.max(startH, h - keepR), Math.min(endH, h + keepR)]).sort((a, b) => a[0] - b[0]);
  const merged = [];
  keeps.forEach(k => { const last = merged[merged.length - 1]; if (last && k[0] <= last[1] + 0.001) last[1] = Math.max(last[1], k[1]); else merged.push([k[0], k[1]]); });
  const segs = []; let cur = startH;
  merged.forEach(m => {
    if (m[0] > cur + 0.001) { const len = m[0] - cur, key = cur.toFixed(2) + '-' + m[0].toFixed(2); segs.push({ h0: cur, h1: m[0], collapsed: len >= collapseMin && !state.expandedGaps.includes(key), key }); }
    segs.push({ h0: Math.max(cur, m[0]), h1: m[1], collapsed: false });
    cur = Math.max(cur, m[1]);
  });
  if (cur < endH - 0.001) { const len = endH - cur, key = cur.toFixed(2) + '-' + endH.toFixed(2); segs.push({ h0: cur, h1: endH, collapsed: len >= collapseMin && !state.expandedGaps.includes(key), key }); }
  let yy = padTop;
  segs.forEach(sg => { sg.y0 = yy; sg.px = sg.collapsed ? collapsePx : (sg.h1 - sg.h0) * pxH; sg.y1 = sg.y0 + sg.px; yy = sg.y1; });
  const Yof = (h) => { for (const sg of segs) { if (h <= sg.h1 + 1e-9) { const f = (h - sg.h0) / ((sg.h1 - sg.h0) || 1); return sg.y0 + Math.max(0, Math.min(1, f)) * sg.px; } } return yy; };

  // Rough per-chip width estimate (no live DOM measurement available — this is all
  // generated as an HTML string) and the row's roughly-known available width (the app
  // shell is fixed at max-width:440px, so this doesn't vary much device to device).
  // Only fall back to the compact/overlapping layout when the full-size chips genuinely
  // wouldn't fit; otherwise lay them out normally, side by side, full labels. A cluster
  // whose full-size row still doesn't fit on one line (rare — long milk labels) gets an
  // extra reserved line of height so it can't visually spill into whatever's below it.
  const ROW_WIDTH_EST = 230, ROW_LINE_H = 24;
  const estChipWidth = (r) => r.type === 'milk' ? 115 : 76;
  const clusterLayout = (cl) => {
    const fullWidthNeeded = cl.items.reduce((s, r) => s + estChipWidth(r), 0) + (cl.items.length - 1) * 6;
    const compact = cl.items.length > 1 && fullWidthNeeded > ROW_WIDTH_EST;
    const lines = compact ? 1 : Math.max(1, Math.ceil(fullWidthNeeded / ROW_WIDTH_EST));
    return { compact, lines };
  };

  // Cluster membership/positions are computed from the *full* event set (including the
  // event currently being dragged, at its still-unchanged stored position) — dragMove
  // never touches Store, so windowEvents doesn't actually change during a drag. An earlier
  // version excluded the dragged event from this clustering step entirely, which
  // recomputed whichever cluster it belonged to (its mean position, whether it needs
  // compact/stacked layout) the instant a drag started, causing that cluster — and
  // anything pushed down after it — to visibly jump before the pointer had even moved.
  // Keeping it in the layout math freezes everyone else in place; only its own chip is
  // skipped when rendering (see itemsHtml below), since the floating #drow block already
  // shows it following the pointer.
  const sorted = [...windowEvents].sort((a, b) => a.h - b.h);
  const clusters = [];
  sorted.forEach(r => { const last = clusters[clusters.length - 1]; if (last && Math.abs(r.h - last.items[0].h) <= 0.18) last.items.push(r); else clusters.push({ items: [r] }); });
  let lastY = -999, lastRowExtra = 0;
  // Clusters within ~66 minutes of each other (2*half+6 px at pxH=40) get pushed further
  // down than their raw Yof(mean) position to keep their dot/label from visually
  // overlapping the previous cluster's. A cluster whose row needs more than one line
  // (clusterLayout().lines > 1) reserves that extra height for whatever comes after it too
  // (lastRowExtra), so a wrapped row can't run into the next cluster or, for the last
  // cluster, into the legend below the track. Hour gridlines and the "now" line don't go
  // through this push — if we used raw Yof() for them, a pushed-down cluster could end up
  // rendered *below* a gridline that's chronologically later than it, which is exactly
  // backwards. yOfAdjusted() (below) carries the same cumulative push-down forward onto
  // anything queried at or after that cluster's time, so gridlines/now-line stay
  // consistent with where the clusters actually ended up.
  clusters.forEach(cl => {
    const { compact, lines } = clusterLayout(cl);
    cl.compact = compact;
    const rowExtra = Math.max(0, lines - 1) * ROW_LINE_H;
    const mean = cl.items.reduce((a, r) => a + r.h, 0) / cl.items.length;
    const natural = Yof(mean);
    let y = natural;
    const minGap = 2 * half + 6 + lastRowExtra;
    if (y < lastY + minGap) y = lastY + minGap;
    cl.y = y; cl.time = mean;
    lastY = y; lastRowExtra = rowExtra;
  });
  // Gridlines/hour marks need a Y mapping that's consistent with where clusters actually
  // ended up (cl.y, after push-down), but two simpler approaches were both tried and both
  // broke on busy days with many clusters:
  //  - using just the nearest cluster's own pushExtra: not monotonic across clusters (a
  //    tightly-packed cluster can need a big push while the next, naturally further away,
  //    needs none), so the offset could suddenly drop back near a later cluster and put a
  //    gridline *above* one computed just before it.
  //  - anchoring to the nearest earlier cluster and extending forward at Yof's natural
  //    rate: still broke, because an EARLIER cluster's push can eat into the natural time
  //    gap leading up to a LATER, unpushed cluster — extrapolating from the earlier one
  //    overshoots past where the later cluster actually sits.
  // What's actually guaranteed monotonic is the sequence of cluster anchor points
  // themselves: cl.y is non-decreasing by construction (each one is pushed to at least
  // lastY + minGap). So build a piecewise-linear curve straight through those anchor
  // points — (cl.time, cl.y) for every cluster, plus the window's start/end — and
  // interpolate hour marks along straight lines between whichever two anchors bracket
  // them. Connecting an increasing sequence of points with straight segments is
  // monotonic no matter how uneven the pushes were.
  const anchors = [{ pos: startH, y: Yof(startH) }];
  clusters.forEach(cl => anchors.push({ pos: cl.time, y: cl.y }));
  const lastCl = clusters[clusters.length - 1];
  const tailOffset = lastCl ? lastCl.y - Yof(lastCl.time) : 0;
  anchors.push({ pos: endH, y: Yof(endH) + tailOffset });
  function yOfAdjusted(pos) {
    if (pos <= anchors[0].pos) return anchors[0].y + (pos - anchors[0].pos);
    const lastA = anchors[anchors.length - 1];
    if (pos >= lastA.pos) return lastA.y + (pos - lastA.pos);
    let lo = 0, hi = anchors.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (anchors[mid].pos <= pos) lo = mid; else hi = mid; }
    const a = anchors[lo], b = anchors[hi];
    const f = (b.pos - a.pos) > 1e-9 ? (pos - a.pos) / (b.pos - a.pos) : 0;
    return a.y + f * (b.y - a.y);
  }
  // Reserve extra room below the "now" line so it (and whatever's just above it) isn't
  // crammed against the legend row right under the track — those used to sit only a few
  // px apart when the last event/cluster landed close to "now", making the bottom of the
  // timeline cramped and fiddly to tap.
  const NOW_BOTTOM_GAP = 40;
  const trackH = Math.max(yy + padTop, lastY + 30 + lastRowExtra, yOfAdjusted(nowPos) + NOW_BOTTOM_GAP);
  // Timeline drag needs to convert a pointer's Y back to an hour position that's
  // consistent with what's actually drawn — i.e. it must go through the same push-down
  // offset as yOfAdjusted, not the raw (pre-push) Yof. yOfAdjusted has no closed-form
  // inverse (the offset depends on which cluster's time a position falls after), so invert
  // it numerically: sample it densely (5-minute resolution) and binary-search + interpolate
  // between samples. This is what silently caused dragged events to commit the wrong time
  // whenever an earlier cluster's label had been pushed down (see CHANGELOG v2.3.2).
  const ySamples = [];
  for (let p = startH; p < endH; p += 1 / 12) ySamples.push([p, yOfAdjusted(p)]);
  ySamples.push([endH, yOfAdjusted(endH)]);
  function yToHAdjusted(y) {
    if (y <= ySamples[0][1]) return ySamples[0][0];
    const last = ySamples[ySamples.length - 1];
    if (y >= last[1]) return last[0];
    let lo = 0, hi = ySamples.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ySamples[mid][1] <= y) lo = mid; else hi = mid; }
    const [p0, y0] = ySamples[lo], [p1, y1] = ySamples[hi];
    const f = (y1 - y0) > 1e-6 ? (y - y0) / (y1 - y0) : 0;
    return p0 + f * (p1 - p0);
  }
  _timelineMeta = { yToH: yToHAdjusted, hToY: yOfAdjusted, axis: { startH, endH, nowPos }, winStart };

  let nodes = `<div style="position:absolute;left:${axisX}px;top:${padTop}px;width:2px;height:${trackH - padTop * 2}px;background:var(--track);border-radius:1px;"></div>`;
  // Real wall-clock hour boundaries within the window, computed once regardless of segments
  // (winStart rarely lands exactly on the hour, so "every integer pos" != "every :00 clock time").
  const hourMarks = [];
  { const g = new Date(winStart); g.setMinutes(0, 0, 0); if (g < winStart) g.setHours(g.getHours() + 1);
    for (; g <= winEnd; g.setHours(g.getHours() + 1)) hourMarks.push({ pos: posOf(g), date: new Date(g) }); }
  segs.forEach(sg => {
    if (sg.collapsed) {
      // If the gap crosses midnight, bare HH:MM on both ends can visually read as
      // "backwards" (e.g. "22:58–20:15" when the first is yesterday) — tag both ends with
      // a date whenever they don't fall on the same calendar day.
      const d0 = dateOfPos(sg.h0), d1 = dateOfPos(sg.h1);
      const sameDay = d0.toDateString() === d1.toDateString();
      const dtag = (d) => sameDay ? '' : ` ${d.getMonth() + 1}/${d.getDate()}`;
      nodes += `<div onclick="A.toggleGap('${sg.key}')" style="position:absolute;left:6px;right:6px;top:${sg.y0}px;height:${sg.px}px;display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;">
        <div style="flex:1;height:0;border-top:1.5px dashed var(--track);"></div>
        <span style="font-size:10px;color:var(--text3);font-weight:600;white-space:nowrap;">⋯ ${hm(d0)}${dtag(d0)}–${hm(d1)}${dtag(d1)} 無紀錄 ▸</span>
        <div style="flex:1;height:0;border-top:1.5px dashed var(--track);"></div></div>`;
    } else {
      // Hour numbers are only useful up through "now" — past that is the empty 3h
      // look-ahead buffer with no events (and, per the request, roughly where the legend
      // row sits below the track), so hide hour marks beyond nowPos instead of cluttering
      // that dead space with 01/02/03 labels that don't correspond to anything.
      hourMarks.filter(m => m.pos >= sg.h0 - 1e-6 && m.pos <= sg.h1 + 1e-6 && m.pos <= nowPos + 1e-6).forEach(m => {
        const y = yOfAdjusted(m.pos);
        const hh = m.date.getHours();
        // The midnight date badge (e.g. "7/2") sits in its own column to the LEFT of the
        // hour-number column, right-aligned against it, instead of being appended after
        // the hour text — appending it inline pushed "00" itself out of alignment with
        // every other hour number (which are always exactly 2 characters).
        const dateBadge = hh === 0
          ? `<div style="position:absolute;left:-25px;width:24px;text-align:right;top:${y - 6}px;font-size:8.5px;color:var(--text3);opacity:.7;white-space:nowrap;">${m.date.getMonth() + 1}/${m.date.getDate()}</div>`
          : '';
        // Hour number lives in its own gutter column at the far left, separate from the
        // event time labels (which sit closer to the dot) — they used to share the same
        // column and could visually stack when a pushed-down cluster landed near an hour
        // line. A short dashed tick bridges the gutter to the axis so the number still
        // reads as "belonging" to its gridline.
        nodes += `<div style="position:absolute;left:${axisX}px;right:0;top:${y}px;height:1px;background:var(--grid);"></div>
          <div style="position:absolute;left:${HOURW + 4}px;width:${axisX - HOURW - 14}px;top:${y}px;height:0;border-top:1px dashed var(--grid);opacity:.6;"></div>
          ${dateBadge}
          <div style="position:absolute;left:0;width:${HOURW}px;text-align:right;top:${y - 6}px;font-size:9.5px;color:var(--text3);font-weight:700;white-space:nowrap;">${pad2(hh)}</div>`;
      });
    }
  });
  const ny = yOfAdjusted(nowPos);
  nodes += `<div style="position:absolute;left:${axisX - 4}px;right:0;top:${ny}px;height:2px;background:var(--accent);z-index:3;"></div>
    <div style="position:absolute;right:4px;top:${ny - 14}px;font-size:9px;font-weight:800;color:var(--accent);background:var(--card2);padding:1px 6px;border-radius:6px;z-index:3;">現在 ${hm(now)}</div>`;

  // compact=true abbreviates the label to just emoji+one-character (排便→便, 尿尿→尿) —
  // used when a chip is part of an overlapping stack (see below) and doesn't have room to
  // show its full label without the pile becoming unreadable.
  const chip = (r, active, compact) => {
    let kids = `<span style="font-size:15px;">${emojiOf(r.type)}</span>`;
    if (r.type === 'milk') {
      const mix = r.breastMl > 0 && r.formulaMl > 0;
      const amt = mix ? (r.breastMl + '+' + r.formulaMl + 'ml') : ((r.formulaMl > 0 ? r.formulaMl : r.breastMl) + 'ml');
      kids += `<span style="color:${milkColorOf(r)};">${amt}</span>`;
      if (!compact) { const tag = mix ? '混合' : (r.formulaMl > 0 ? '配方乳' : '母乳'); kids += `<span style="font-size:10px;font-weight:700;color:${milkColorOf(r)};">${tag}</span>`; }
    } else kids += `<span>${compact ? (r.type === 'poop' ? '便' : '尿') : (r.type === 'poop' ? '排便' : '尿尿')}</span>`;
    // Brief glow instead of a toast popup — fires both when a press-and-hold activates a
    // drag (confirms "you've grabbed this one") and when the drag commits (see
    // App.startDrag/dragEnd). state.justUpdatedId is cleared again ~900ms later.
    const glow = r.id === state.justUpdatedId ? 'animation:chipGlow .9s ease;' : '';
    return `<div onpointerdown="A.startDrag('${r.id}',event.clientX,event.clientY)" title="${hm(new Date(r.time))}" class="chip" data-chip-id="${r.id}" style="background:${tintBg(r)};box-shadow:${active ? '0 6px 16px var(--shadow2)' : '0 1px 3px var(--shadow)'};transform:${active ? 'scale(1.05)' : 'none'};${glow}">${kids}</div>`;
  };
  clusters.forEach((cl, ci) => {
    // Events at (near) the same time cascade with a partial overlap (instead of wrapping
    // to a second line) only when they wouldn't otherwise fit side by side — later events
    // sit on top by default (z-index by position), but whichever chip was last tapped
    // (state.frontChipId, set in App.startDrag) is always brought fully to front so it
    // stays reachable even when piled up. cl.compact was already decided above (it also
    // feeds the trackH/spacing math), so reuse it rather than recomputing.
    const compact = cl.compact;
    // The dragged item itself is skipped here — it's shown by the floating #drow block
    // instead — but its cluster-mates (if any) still render normally, at the cluster's
    // frozen position (cl.y/cl.time, computed above from the full item set).
    const visibleItems = cl.items.filter(r => r.id !== state.dragId);
    if (visibleItems.length === 0) return; // whole cluster was just the dragged item — nothing left to draw here
    const itemsHtml = visibleItems.map((r, i) => {
      const z = r.id === state.frontChipId ? 50 : (2 + i);
      const ml = (compact && i > 0) ? -18 : 0;
      return `<div style="position:relative;z-index:${z};margin-left:${ml}px;">${chip(r, false, compact)}</div>`;
    }).join('');
    const rowStyle = compact
      ? `display:flex;align-items:center;`
      : `display:flex;align-items:center;gap:6px;flex-wrap:wrap;`;
    nodes += `<div style="position:absolute;left:${axisX - 4}px;top:${cl.y - 5}px;width:10px;height:10px;border-radius:50%;background:${dotColor(visibleItems[0])};border:2px solid var(--card);z-index:2;"></div>
      <div style="position:absolute;left:${HOURW}px;width:${axisX - HOURW - 8}px;text-align:right;top:${cl.y - 8}px;font-size:12px;font-weight:800;color:var(--text);z-index:2;">${hm(dateOfPos(cl.time))}</div>
      <div style="position:absolute;left:${axisX + 14}px;right:4px;top:${cl.y - half}px;min-height:${2 * half}px;${rowStyle}z-index:2;">${itemsHtml}</div>`;
  });
  if (dragEv) {
    const y = yOfAdjusted(dragEv.h);
    nodes += `<div id="ddot" style="position:absolute;left:${axisX - 5}px;top:${y - 6}px;width:12px;height:12px;border-radius:50%;background:${dotColor(dragEv)};border:2px solid var(--card);z-index:8;"></div>
      <div id="dtl" style="position:absolute;left:${HOURW}px;width:${axisX - HOURW - 8}px;text-align:right;top:${y - 8}px;font-size:12px;font-weight:800;color:var(--accent);z-index:8;">${hm(dateOfPos(dragEv.h))}</div>
      <div id="drow" style="position:absolute;left:${axisX + 14}px;right:4px;top:${y - half}px;display:flex;align-items:center;gap:6px;z-index:8;">${chip(dragEv, true)}</div>`;
  }
  const legend = [['#FF8C6B', '母乳'], ['#E8A33D', '配方'], ['#C77D52', '混合'], ['#C8965A', '排便'], ['#79C3F0', '尿尿']]
    .map(([c, l]) => `<div style="display:flex;align-items:center;gap:4px;"><div style="width:9px;height:9px;border-radius:50%;background:${c};"></div><span style="font-size:11px;color:var(--text2);">${l}</span></div>`).join('');

  return `<div>
    <div id="timeline-track" style="position:relative;height:${trackH}px;">${nodes}</div>
    <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap;justify-content:center;">${legend}</div>
    <p style="font-size:10.5px;color:var(--text3);margin-top:8px;text-align:center;">長按事件標籤上下拖曳改時間・點一下開編輯</p>
  </div>`;
}
function pad2(n) { return String(n).padStart(2, '0'); }

// Trying out moving quick-record (milk/poop/pee) into the paw-shaped buttons above the
// nav's FAB (see pawButtons/renderNav) instead of these big home-screen buttons — set
// back to true to bring the original section back.
const SHOW_HOME_QUICK_RECORD = false;
function renderHome(state) {
  const milks = Store.liveEvents().filter(e => e.type === 'milk');
  const todayEvents = Store.liveEvents().filter(e => dayKey(new Date(e.time)) === dayKey(new Date()));
  const milkCount = todayEvents.filter(e => e.type === 'milk').length;
  const totalMilkMl = todayEvents.filter(e => e.type === 'milk').reduce((s, e) => s + (e.amountMl || 0), 0);
  const poopCount = todayEvents.filter(e => e.type === 'poop').length;
  const peeCount = todayEvents.filter(e => e.type === 'pee').length;
  const btnSize = 112, btnOpacity = 0.75;
  const now = new Date();
  const todayLabel = now.toLocaleDateString('zh-TW', { weekday: 'long', month: 'long', day: 'numeric' });
  const babyName = Store.data.settings.babyName || '寶貝';

  return `<div class="ns" id="scroll-area" style="flex:1;min-height:0;padding-bottom:48px;">
    <div style="display:flex;justify-content:center;align-items:center;gap:8px;height:38px;">${renderSyncPill()}</div>
    <div style="padding:2px 22px 14px;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <p style="font-size:13px;font-weight:500;color:var(--text2);margin-bottom:3px;">${esc(todayLabel)}</p>
        <h1 style="font-size:29px;font-weight:800;letter-spacing:-.5px;line-height:1.1;color:var(--text);">嗨，${esc(babyName)}！👋</h1>
      </div>
      <div style="display:flex;align-items:center;gap:10px;">
        <button onclick="A.toggleTheme()" style="width:40px;height:40px;border-radius:50%;background:var(--card);border:none;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px var(--shadow);">${themeIcon(state)}</button>
        <div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,#FFCC70,#FF8C6B);display:flex;align-items:center;justify-content:center;font-size:22px;box-shadow:0 4px 14px rgba(240,165,0,.35);">👶</div>
      </div>
    </div>
    <div style="margin:0 16px 14px;background:var(--card);border-radius:18px;padding:18px 20px;box-shadow:0 2px 16px var(--shadow);">
      ${renderPrediction()}
      <div style="display:flex;padding-top:14px;border-top:1px solid var(--line);">
        <div style="flex:1;text-align:center;"><p style="font-size:21px;font-weight:800;color:#FF7A56;line-height:1;">${milkCount}</p><p style="font-size:10px;color:var(--text2);font-weight:600;margin-top:2px;">喝奶</p></div>
        <div style="width:1px;background:var(--line);margin:0 2px;"></div>
        <div style="flex:1;text-align:center;"><p style="font-size:21px;font-weight:800;line-height:1;color:var(--text);">${totalMilkMl}</p><p style="font-size:10px;color:var(--text2);font-weight:600;margin-top:2px;">ml</p></div>
        <div style="width:1px;background:var(--line);margin:0 2px;"></div>
        <div style="flex:1;text-align:center;"><p style="font-size:21px;font-weight:800;color:#C8965A;line-height:1;">${poopCount}</p><p style="font-size:10px;color:var(--text2);font-weight:600;margin-top:2px;">排便</p></div>
        <div style="width:1px;background:var(--line);margin:0 2px;"></div>
        <div style="flex:1;text-align:center;"><p style="font-size:21px;font-weight:800;color:#4AAEDF;line-height:1;">${peeCount}</p><p style="font-size:10px;color:var(--text2);font-weight:600;margin-top:2px;">尿尿</p></div>
      </div>
    </div>
    ${SHOW_HOME_QUICK_RECORD ? `<div style="padding:4px 16px 14px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <p style="font-size:17px;font-weight:700;color:var(--text);">快速記錄</p>
        <p style="font-size:11px;color:var(--text3);">長按排便/尿尿可補記時間</p>
      </div>
      <div class="btn-row">
        <button onclick="A.openMilk()" class="round-btn" style="width:${btnSize}px;height:${btnSize}px;background:#FCD0A1;box-shadow:0 6px 22px rgba(252,208,161,.55);opacity:${btnOpacity};">
          <div style="font-size:32px;line-height:1;">🍼</div><p style="font-size:15px;font-weight:800;color:#5C4A10;">喝奶</p><p style="font-size:10px;color:rgba(92,74,16,.7);font-weight:600;">${lastTimeLabel('milk')}</p>
        </button>
        <button onclick="A.tap('poop')" onpointerdown="A.startPress('poop')" onpointerup="A.endPress()" onpointerleave="A.endPress()" class="round-btn" style="width:${btnSize}px;height:${btnSize}px;background:#995D81;box-shadow:0 6px 22px rgba(153,93,129,.4);opacity:${btnOpacity};">
          <div style="font-size:32px;line-height:1;">💩</div><p style="font-size:15px;font-weight:800;color:#fff;">排便</p><p style="font-size:10px;color:rgba(255,255,255,.72);font-weight:600;">${lastTimeLabel('poop')}</p>
        </button>
        <button onclick="A.tap('pee')" onpointerdown="A.startPress('pee')" onpointerup="A.endPress()" onpointerleave="A.endPress()" class="round-btn" style="width:${btnSize}px;height:${btnSize}px;background:#9BB1FF;box-shadow:0 6px 22px rgba(155,177,255,.5);opacity:${btnOpacity};">
          <div style="font-size:32px;line-height:1;">💧</div><p style="font-size:15px;font-weight:800;color:#24365E;">尿尿</p><p style="font-size:10px;color:rgba(36,54,94,.68);font-weight:600;">${lastTimeLabel('pee')}</p>
        </button>
      </div>
    </div>` : ''}
    <div style="padding:0 16px 24px;">
      <div style="background:var(--card);border-radius:18px;padding:18px 18px 20px;box-shadow:0 2px 12px var(--shadow);">
        <p style="font-size:15px;font-weight:700;margin-bottom:14px;color:var(--text);">活動時間軸</p>
        ${renderTimeline(state)}
      </div>
    </div>
  </div>`;
}

function themeIcon(state) {
  const sysDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const effNight = state.theme === 'night' || (state.theme === 'auto' && sysDark);
  if (effNight) return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z" fill="var(--text2)"/></svg>`;
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4" fill="var(--text2)"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" stroke="var(--text2)" stroke-width="2" stroke-linecap="round"/></svg>`;
}

// ============================= STATS =============================
function sCard(title, child) {
  return `<div class="card" style="padding:16px 16px 14px;margin-bottom:14px;"><p style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:14px;">${title}</p>${child}</div>`;
}
// offset: 0 = current period, -1 = one period back, etc. Past periods run through their
// natural end (Sunday/end-of-month/end-of-year); the current period (offset 0) still caps
// at "now" so it doesn't show future dates.
function rangeBounds(range, offset = 0) {
  const now = new Date();
  if (range === 'week') {
    const dow = (now.getDay() + 6) % 7;
    const s = new Date(now); s.setDate(now.getDate() - dow + offset * 7); s.setHours(0, 0, 0, 0);
    const e = new Date(s); e.setDate(s.getDate() + 6); e.setHours(23, 59, 59, 999);
    return [s, offset === 0 ? now : e];
  }
  if (range === 'month') {
    const s = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const e = new Date(s.getFullYear(), s.getMonth() + 1, 0, 23, 59, 59, 999);
    return [s, offset === 0 ? now : e];
  }
  const s = new Date(now.getFullYear() + offset, 0, 1);
  const e = new Date(s.getFullYear(), 11, 31, 23, 59, 59, 999);
  return [s, offset === 0 ? now : e];
}
// How far back (most negative offset) you can swipe before hitting the earliest record —
// walks backward one period at a time since periods have irregular lengths (months/years).
function minStatsOffset(range) {
  const all = Store.liveEvents();
  if (!all.length) return 0;
  const earliest = Math.min(...all.map(e => new Date(e.time).getTime()));
  let offset = 0;
  while (rangeBounds(range, offset)[0].getTime() > earliest) offset--;
  return offset;
}
// "標題下方顯示月份" — a single shared subtitle above the swipeable charts showing which
// week/month/year is currently in view.
function statsPeriodLabel(range, offset) {
  const [s, e] = rangeBounds(range, offset);
  if (range === 'week') {
    const wd = ['日', '一', '二', '三', '四', '五', '六'];
    const eEnd = new Date(s); eEnd.setDate(s.getDate() + 6);
    return `${s.getMonth() + 1}/${s.getDate()}（${wd[s.getDay()]}）－${eEnd.getMonth() + 1}/${eEnd.getDate()}（${wd[eEnd.getDay()]}）`;
  }
  if (range === 'month') return `${s.getFullYear()}年${s.getMonth() + 1}月`;
  return `${s.getFullYear()}年`;
}
// Date sub-label for bucket i within the current period — used under the weekday labels in
// week mode, and to name a bucket when its bar is tapped open (see toggleMlBar).
function statsBucketLabel(range, offset, i) {
  const [s] = rangeBounds(range, offset);
  if (range === 'week') { const d = new Date(s); d.setDate(s.getDate() + i); return `${d.getMonth() + 1}/${d.getDate()}`; }
  if (range === 'month') { const w0 = new Date(s); w0.setDate(s.getDate() + i * 7); const w1 = new Date(w0); w1.setDate(w0.getDate() + 6); return `${w0.getMonth() + 1}/${w0.getDate()}–${w1.getMonth() + 1}/${w1.getDate()}`; }
  return `${i + 1}月`;
}
function renderFeedStats(state) {
  const range = state.statsRange;
  const offset = state.statsPeriodOffset || 0;
  const [from, to] = rangeBounds(range, offset);
  const evs = Store.liveEvents().filter(e => { const t = new Date(e.time); return t >= from && t <= to; });
  const milks = evs.filter(e => e.type === 'milk');
  const totalMl = milks.reduce((s, e) => s + (e.amountMl || 0), 0);
  const days = Math.max(1, Math.round((to - from) / 86400000) + 1);
  const avgMl = Math.round(totalMl / days);
  const poopCount = evs.filter(e => e.type === 'poop').length;
  const peeCount = evs.filter(e => e.type === 'pee').length;
  const sortedMilks = milks.slice().sort((a, b) => new Date(a.time) - new Date(b.time));
  // Exclude the overnight stretch from the average — not a fixed clock window (babies'
  // sleep timing varies night to night), but dynamically: any interval whose two feeds
  // fall on different calendar days is treated as "the night gap" and skipped. A fixed
  // interval that includes those long overnight gaps skews the average upward and doesn't
  // reflect actual daytime feeding rhythm.
  let avgIntervalLabel = '—';
  if (sortedMilks.length >= 2) {
    let totalMin = 0, n = 0;
    for (let i = 1; i < sortedMilks.length; i++) {
      const prev = new Date(sortedMilks[i - 1].time), cur = new Date(sortedMilks[i].time);
      if (dayKey(prev) !== dayKey(cur)) continue;
      totalMin += (cur - prev) / 60000; n++;
    }
    if (n > 0) { const avgMin = totalMin / n; avgIntervalLabel = `${Math.floor(avgMin / 60)}h${Math.round(avgMin % 60)}m`; }
  }

  const rangeTabs = `<div class="seg" style="margin-bottom:6px;">${[['week', '本週'], ['month', '本月'], ['year', '本年']].map(([k, l]) => `<button class="${state.statsRange === k ? 'active' : ''}" onclick="A.setStatsRange('${k}')">${l}</button>`).join('')}</div>
    <p style="text-align:center;font-size:12px;color:var(--text2);font-weight:600;margin-bottom:14px;">${esc(statsPeriodLabel(range, offset))}</p>`;
  const sStat = (val, lbl) => `<div style="flex:1;text-align:center;"><p style="font-size:17px;font-weight:800;color:var(--text);line-height:1;">${val}</p><p style="font-size:9.5px;color:var(--text2);font-weight:600;margin-top:3px;">${lbl}</p></div>`;
  const div = `<div style="width:1px;background:var(--line);margin:0 2px;"></div>`;
  const summary = `<div class="card" style="display:flex;padding:16px 6px;margin-bottom:14px;">${sStat(avgMl, '平均奶量/日')}${div}${sStat(avgIntervalLabel, '平均間隔(不含夜間)')}${div}${sStat(poopCount, '排便次數')}${div}${sStat(peeCount, '尿尿次數')}</div>`;

  const byMap = {};
  evs.forEach(e => { const k = e.by || '未命名'; if (!byMap[k]) byMap[k] = { milk: 0, diaper: 0 }; if (e.type === 'milk') byMap[k].milk++; else byMap[k].diaper++; });
  const ranking = Object.keys(byMap).map(name => ({ name, milk: byMap[name].milk, diaper: byMap[name].diaper, total: byMap[name].milk + byMap[name].diaper })).sort((a, b) => b.total - a.total);
  const rkMax = ranking.length ? Math.max(...ranking.map(r => r.total)) : 1;
  const cgRows = ranking.map((r, i) => `<div style="margin-bottom:${i === ranking.length - 1 ? 0 : 13}px;">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px;"><span style="font-size:14px;font-weight:700;color:var(--text);">${i === 0 && r.total > 0 ? '🏅 ' : ''}${esc(r.name)}</span><span style="font-size:12px;color:var(--text2);">🍼 ${r.milk} ・ 🧷 ${r.diaper}</span></div>
    <div style="height:8px;border-radius:4px;background:var(--card2);overflow:hidden;"><div style="width:${r.total / rkMax * 100}%;height:100%;border-radius:4px;background:${i === 0 ? 'linear-gradient(90deg,#F0A500,#FF8C6B)' : 'var(--track)'};"></div></div></div>`).join('');
  const caregiverCard = sCard('照顧者分擔 💛', ranking.length ? (cgRows + `<p style="font-size:11px;color:var(--text3);margin-top:12px;text-align:center;">謝謝大家一起照顧寶寶 🌿</p>`) : `<p style="font-size:13px;color:var(--text3);text-align:center;padding:20px 0;">還沒有記錄</p>`);

  // "星期標籤底下顯示日期" — only meaningful for week mode, where each bucket really is a
  // single calendar day; month/year buckets are weeks/months so a day number wouldn't mean
  // anything there (the shared statsPeriodLabel subtitle above already gives that context).
  const dateSubLabel = (i) => range === 'week' ? `<div style="font-size:8px;color:var(--text3);margin-top:1px;">${statsBucketLabel(range, offset, i)}</div>` : '';

  const { labels, milkCounts } = bucketize(range, evs, 'milk');
  const mMax = Math.max(1, ...milkCounts);
  const milkChart = sCard(`喝奶次數（${range === 'week' ? '每日' : range === 'month' ? '每週' : '每月'}）`,
    `<div style="display:flex;align-items:flex-end;gap:6px;height:120px;">${milkCounts.map((v, i) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;"><div style="font-size:9px;color:var(--text3);font-weight:700;">${v}</div><div style="width:100%;height:${Math.round(v / mMax * 86) + 6}px;background:linear-gradient(180deg,#FF8C6B,#FF6B4A);border-radius:6px;"></div><div style="font-size:9px;color:var(--text2);font-weight:600;">${labels[i]}</div>${dateSubLabel(i)}</div>`).join('')}</div>`);

  // Tapping a bar expands that bucket's breast/formula breakdown below the chart — in week
  // mode that's a single day; in month/year mode (where a bar is a week's or a month's
  // total) it expands that whole week's/month's breast+formula totals instead, per the
  // user's request, since there's no single "that day" to show there.
  const { breastMl, formulaMl } = bucketizeMl(range, evs);
  const totals = breastMl.map((b, i) => b + formulaMl[i]);
  const aMax = Math.max(1, ...totals);
  const expandedIdx = state.statsExpandedBar;
  const expandedDetail = (expandedIdx != null && expandedIdx < totals.length)
    ? `<div style="margin-top:12px;padding:10px 12px;background:var(--card2);border-radius:12px;display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:12px;font-weight:700;color:var(--text2);">${esc(statsBucketLabel(range, offset, expandedIdx))}</span>
        <span style="font-size:12px;color:var(--text);"><span style="color:#FF8C6B;font-weight:700;">母乳 ${breastMl[expandedIdx]}ml</span>　<span style="color:#E8A33D;font-weight:700;">配方 ${formulaMl[expandedIdx]}ml</span></span>
      </div>`
    : '';
  const amtChart = sCard('奶量 ml（母乳 ＋ 配方）',
    `<div style="display:flex;align-items:flex-end;gap:6px;height:120px;">${totals.map((tot, i) => `<div onclick="A.toggleMlBar(${i})" style="flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;"><div style="width:100%;height:${Math.round(tot / aMax * 92)}px;border-radius:6px;overflow:hidden;display:flex;flex-direction:column;outline:${expandedIdx === i ? '2px solid var(--accent)' : 'none'};outline-offset:2px;">${tot > 0 ? `<div style="height:${formulaMl[i] / tot * 100}%;background:#E8A33D;"></div><div style="flex:1;background:#FF8C6B;"></div>` : ''}</div><div style="font-size:9px;color:var(--text2);font-weight:600;">${labels[i]}</div>${dateSubLabel(i)}</div>`).join('')}</div>
    <div style="display:flex;gap:14px;margin-top:12px;justify-content:center;">${[['#FF8C6B', '母乳'], ['#E8A33D', '配方']].map(([c, l]) => `<div style="display:flex;align-items:center;gap:4px;"><div style="width:9px;height:9px;border-radius:50%;background:${c};"></div><span style="font-size:11px;color:var(--text2);">${l}</span></div>`).join('')}</div>
    ${expandedDetail}`);

  // A diaper change is one or more poop/pee events logged at the *exact same* timestamp —
  // per the user, their baby rarely finishes everything in one go, so even a 1-minute gap
  // must NOT be merged (unlike the timeline's own event clustering, which is a looser
  // ~11-minute visual grouping for a different purpose). Simply summing poop+pee event
  // counts double-counts every change where both were logged together.
  const changes = dedupeDiaperChanges(evs);
  const { counts: diaperCounts, poopCounts: dPoop, peeCounts: dPee } = bucketizeChanges(range, changes);
  const dMax = Math.max(1, ...diaperCounts);
  const diaperChart = sCard(`換尿布次數（${range === 'week' ? '每日' : range === 'month' ? '每週' : '每月'}）`,
    `<div style="display:flex;align-items:flex-end;gap:6px;height:150px;">${diaperCounts.map((cnt, i) => `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:1px;">
      <div style="font-size:10px;font-weight:800;color:var(--text);line-height:1.3;">${cnt}</div>
      <div style="font-size:9px;font-weight:700;color:#C8965A;line-height:1.3;">${dPoop[i]}</div>
      <div style="font-size:9px;font-weight:700;color:#79C3F0;line-height:1.3;">${dPee[i]}</div>
      <div style="width:100%;margin-top:5px;height:${Math.round(cnt / dMax * 76) + (cnt > 0 ? 6 : 0)}px;border-radius:6px;overflow:hidden;display:flex;flex-direction:column;">${cnt > 0 ? `<div style="height:${dPoop[i] / ((dPoop[i] + dPee[i]) || 1) * 100}%;background:#C8965A;"></div><div style="flex:1;background:#79C3F0;"></div>` : ''}</div>
      <div style="font-size:9px;color:var(--text2);font-weight:600;margin-top:6px;">${labels[i]}</div>${dateSubLabel(i)}
    </div>`).join('')}</div>
    <div style="display:flex;gap:14px;margin-top:12px;justify-content:center;">${[['var(--text)', '換尿布次數'], ['#C8965A', '排便'], ['#79C3F0', '尿尿']].map(([c, l]) => `<div style="display:flex;align-items:center;gap:4px;"><div style="width:9px;height:9px;border-radius:50%;background:${c};"></div><span style="font-size:11px;color:var(--text2);">${l}</span></div>`).join('')}</div>`);

  // Left/right swipe (see App.startStatsSwipe/endStatsSwipe) pages through weeks/months/
  // years — swipe left goes further back in time, matching the convention used by e.g.
  // Apple Health's weekly charts. Wraps all three charts together since they always show
  // the same period.
  const swipeCharts = `<div onpointerdown="A.startStatsSwipe(event.clientX)">${milkChart}${amtChart}${diaperChart}</div>`;

  return rangeTabs + summary + caregiverCard + swipeCharts;
}
function bucketize(range, evs, type) {
  const now = new Date();
  if (range === 'week') {
    const labels = ['一', '二', '三', '四', '五', '六', '日']; const counts = new Array(7).fill(0);
    evs.filter(e => e.type === type).forEach(e => { const d = (new Date(e.time).getDay() + 6) % 7; counts[d]++; });
    return { labels, milkCounts: counts };
  }
  if (range === 'month') {
    const labels = ['W1', 'W2', 'W3', 'W4', 'W5']; const counts = new Array(5).fill(0);
    evs.filter(e => e.type === type).forEach(e => { const w = Math.min(4, Math.floor((new Date(e.time).getDate() - 1) / 7)); counts[w]++; });
    return { labels, milkCounts: counts };
  }
  const labels = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12']; const counts = new Array(12).fill(0);
  evs.filter(e => e.type === type).forEach(e => { counts[new Date(e.time).getMonth()]++; });
  return { labels, milkCounts: counts };
}
function bucketizeMl(range, evs) {
  const n = range === 'week' ? 7 : range === 'month' ? 5 : 12;
  const breastMl = new Array(n).fill(0), formulaMl = new Array(n).fill(0);
  evs.filter(e => e.type === 'milk').forEach(e => {
    let idx;
    const d = new Date(e.time);
    if (range === 'week') idx = (d.getDay() + 6) % 7;
    else if (range === 'month') idx = Math.min(4, Math.floor((d.getDate() - 1) / 7));
    else idx = d.getMonth();
    breastMl[idx] += e.breastMl || 0; formulaMl[idx] += e.formulaMl || 0;
  });
  return { breastMl, formulaMl };
}
// One diaper change = every poop/pee event sharing the exact same timestamp (strict —
// even a 1-minute gap is a separate change, per how this family actually uses diapers).
function dedupeDiaperChanges(evs) {
  const diaper = evs.filter(e => e.type === 'poop' || e.type === 'pee').slice().sort((a, b) => new Date(a.time) - new Date(b.time));
  const changes = [];
  diaper.forEach(e => {
    const t = new Date(e.time).getTime();
    const last = changes[changes.length - 1];
    if (last && last.time === t) { if (e.type === 'poop') last.poop++; else last.pee++; }
    else changes.push({ time: t, poop: e.type === 'poop' ? 1 : 0, pee: e.type === 'pee' ? 1 : 0 });
  });
  return changes;
}
function bucketizeChanges(range, changes) {
  const n = range === 'week' ? 7 : range === 'month' ? 5 : 12;
  const counts = new Array(n).fill(0), poopCounts = new Array(n).fill(0), peeCounts = new Array(n).fill(0);
  changes.forEach(c => {
    const d = new Date(c.time);
    let idx;
    if (range === 'week') idx = (d.getDay() + 6) % 7;
    else if (range === 'month') idx = Math.min(4, Math.floor((d.getDate() - 1) / 7));
    else idx = d.getMonth();
    counts[idx]++; poopCounts[idx] += c.poop; peeCounts[idx] += c.pee;
  });
  return { counts, poopCounts, peeCounts };
}

function renderGrowthStats(state) {
  const gm = state.growthMetric;
  const baby = Store.data.settings;
  const hasProfile = !!(baby.babyBirth && baby.babySex);
  const AGES = [0, 3, 6, 9, 12, 15, 18, 21, 24];
  const PCTS = [3, 15, 50, 85, 97];
  const meta = { weight: { unit: 'kg', label: '體重', yr: [2, 16] }, height: { unit: 'cm', label: '身高', yr: [45, 95] }, head: { unit: 'cm', label: '頭圍', yr: [32, 52] } }[gm];
  const ageOf = (ds) => (new Date(ds) - new Date(baby.babyBirth)) / 86400000 / 30.4375;
  const GW = 320, GH = 210, mxl = 30, mxr = 14, gmt = 10, gmb = 22;
  const sx = (age) => mxl + Math.max(0, Math.min(24, age)) / 24 * (GW - mxl - mxr);
  const [yr0, yr1] = meta.yr;
  const sy = (v) => (GH - gmb) - (Math.max(yr0, Math.min(yr1, v)) - yr0) / (yr1 - yr0) * (GH - gmb - gmt);
  let gk = '';
  for (let t = 0; t <= 4; t++) { const v = yr0 + (yr1 - yr0) * t / 4; const y = sy(v); gk += `<line x1="${mxl}" y1="${y}" x2="${GW - mxr}" y2="${y}" stroke="var(--grid)" stroke-width="1"/><text x="${mxl - 4}" y="${y + 3}" font-size="8" fill="var(--text3)" text-anchor="end">${Math.round(v)}</text>`; }
  [0, 6, 12, 18, 24].forEach(a => gk += `<text x="${sx(a)}" y="${GH - 6}" font-size="8" fill="var(--text3)" text-anchor="middle">${a}m</text>`);
  if (hasProfile) {
    const sex = baby.babySex;
    PCTS.forEach(p => {
      const pts = AGES.map(a => `${sx(a)},${sy(whoValueAtPercentile(gm, sex, a, p))}`).join(' ');
      const mid = p === 50;
      gk += `<polyline points="${pts}" fill="none" stroke="${mid ? 'var(--accent)' : 'var(--track)'}" stroke-width="${mid ? 2 : 1}" ${mid ? '' : 'stroke-dasharray="3 3"'}/>`;
      gk += `<text x="${GW - mxr + 1}" y="${sy(whoValueAtPercentile(gm, sex, 24, p)) + 3}" font-size="7" fill="${mid ? 'var(--accent)' : 'var(--text3)'}">${p}</text>`;
    });
  }
  const growth = Store.liveGrowth();
  const bpts = growth.map(r => ({ a: hasProfile ? ageOf(r.date) : null, v: r[gm], date: r.date, id: r.id })).filter(p => p.v != null && (!hasProfile || (p.a >= 0 && p.a <= 24.5))).sort((a, b) => hasProfile ? a.a - b.a : new Date(a.date) - new Date(b.date));
  if (bpts.length) {
    const px = (p, i) => hasProfile ? sx(p.a) : (mxl + (bpts.length === 1 ? 0.5 : i / (bpts.length - 1)) * (GW - mxl - mxr));
    gk += `<polyline points="${bpts.map((p, i) => px(p, i) + ',' + sy(p.v)).join(' ')}" fill="none" stroke="#FF8C6B" stroke-width="2.5"/>`;
    bpts.forEach((p, i) => gk += `<circle cx="${px(p, i)}" cy="${sy(p.v)}" r="4" fill="#FF8C6B" stroke="var(--card)" stroke-width="1.5"/>`);
  }
  const chartSvg = `<svg viewBox="0 0 ${GW} ${GH}" style="width:100%;height:auto;overflow:visible;">${gk}</svg>`;
  const metricBtns = `<div class="seg" style="margin-bottom:14px;">${[['weight', '⚖️ 體重'], ['height', '📏 身高'], ['head', '🧠 頭圍']].map(([k, l]) => `<button class="${gm === k ? 'active' : ''}" onclick="A.set({growthMetric:'${k}'})">${l}</button>`).join('')}</div>`;
  const gList = growth.slice().sort((a, b) => new Date(b.date) - new Date(a.date)).map(r => `<div onclick='A.openEditGrowth(${JSON.stringify(r).replace(/'/g, "&#39;")})' style="display:flex;align-items:center;gap:8px;justify-content:space-between;padding:11px 14px;border-bottom:1px solid var(--line);cursor:pointer;"><span style="font-size:12.5px;color:var(--text2);">${esc(r.date)}</span><span style="font-size:13px;font-weight:700;color:var(--text);">⚖️ ${r.weight ?? '—'}  📏 ${r.height ?? '—'}  🧠 ${r.head ?? '—'}</span><svg width="7" height="12" viewBox="0 0 7 12" fill="none" style="flex-shrink:0;"><path d="M1 1l5 5-5 5" stroke="var(--text3)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`).join('');
  const note = hasProfile ? '依 WHO LMS 對照表計算之百分位曲線（3/15/50/85/97），僅供參考、非醫療診斷' : '填寫「寶寶資料」的生日與性別後，會顯示 WHO 百分位曲線';

  return metricBtns + sCard(`${meta.label} 成長曲線（${meta.unit}）`, chartSvg + `<p style="font-size:10px;color:var(--text3);margin-top:8px;text-align:center;line-height:1.4;">${note}</p>`)
    + `<div class="card" style="overflow:hidden;">${growth.length ? gList : `<p style="font-size:13px;color:var(--text3);text-align:center;padding:24px 0;">還沒有成長記錄，點下方 ＋ 新增</p>`}</div>`;
}

function renderStats(state) {
  const tabBar = `<div class="seg" style="margin-bottom:14px;">${[['feed', '🍼 餵養'], ['growth', '📈 成長']].map(([k, l]) => `<button class="${state.statsTab === k ? 'active' : ''}" onclick="A.set({statsTab:'${k}'})">${l}</button>`).join('')}</div>`;
  return `<div class="ns" style="flex:1;min-height:0;padding-bottom:58px;">
    ${headerBar('統計')}
    <div style="padding:8px 16px 0;">${tabBar}${state.statsTab === 'growth' ? renderGrowthStats(state) : renderFeedStats(state)}</div>
  </div>`;
}

// ============================= RECORDS =============================
function renderRecords(state) {
  const filter = state.recordsFilter;
  const evs = Store.liveEvents().filter(e => filter === 'all' || e.type === filter).sort((a, b) => new Date(b.time) - new Date(a.time));
  const chips = `<div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">${[['all', '全部'], ['milk', '🍼 喝奶'], ['poop', '💩 排便'], ['pee', '💧 尿尿']].map(([k, l]) => `<button onclick="A.set({recordsFilter:'${k}'})" style="padding:8px 14px;border:none;border-radius:12px;font-size:12.5px;font-weight:700;font-family:inherit;background:${filter === k ? 'var(--accent)' : 'var(--card2)'};color:${filter === k ? '#fff' : 'var(--text2)'};">${l}</button>`).join('')}</div>`;
  const row = (r) => {
    let label;
    if (r.type === 'milk') { const mix = r.breastMl > 0 && r.formulaMl > 0; label = '喝奶 ' + (mix ? (r.breastMl + '+' + r.formulaMl + 'ml ・混合') : ((r.amountMl || 0) + 'ml ・' + (r.formulaMl > 0 ? '配方乳' : '母乳'))); }
    else label = r.type === 'poop' ? '排便' : '尿尿';
    const d = new Date(r.time);
    return `<div onclick='A.openEditRec(${JSON.stringify(r).replace(/'/g, "&#39;")})' style="display:flex;align-items:center;gap:12px;padding:13px 14px;border-bottom:1px solid var(--line);cursor:pointer;">
      <div style="width:40px;height:40px;border-radius:13px;background:${tintBg(r)};display:flex;align-items:center;justify-content:center;font-size:19px;flex-shrink:0;">${emojiOf(r.type)}</div>
      <div style="flex:1;"><p style="font-size:14px;font-weight:700;color:var(--text);margin-bottom:1px;">${label}</p><p style="font-size:12px;color:var(--text2);">${d.toLocaleDateString('zh-TW', { month: 'numeric', day: 'numeric' })} ${hm(d)} · ${esc(r.by || '未命名')}</p></div>
      <svg width="7" height="12" viewBox="0 0 7 12" fill="none"><path d="M1 1l5 5-5 5" stroke="var(--text3)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </div>`;
  };
  const list = evs.length ? `<div class="card" style="overflow:hidden;">${evs.map(row).join('')}</div>` : `<div style="text-align:center;padding:48px 0;color:var(--text3);font-size:13px;">沒有符合的紀錄</div>`;
  return `<div class="ns" style="flex:1;min-height:0;padding-bottom:78px;">
    ${headerBar('紀錄')}
    <div style="padding:8px 16px 0;">${chips}${list}</div>
  </div>`;
}

// ============================= SETTINGS =============================
function sectionLabel(t) { return `<p style="font-size:12px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin:0 6px 8px;">${t}</p>`; }
function durRow(type, label, emoji) {
  const d = Store.data.settings.duration[type];
  const seg = (mode, txt) => `<button onclick="A.setDurationMode('${type}','${mode}')" style="padding:6px 12px;border:none;border-radius:9px;font-size:12px;font-weight:700;font-family:inherit;background:${d.mode === mode ? 'var(--card)' : 'transparent'};color:${d.mode === mode ? 'var(--text)' : 'var(--text2)'};box-shadow:${d.mode === mode ? '0 1px 5px var(--shadow)' : 'none'};">${txt}</button>`;
  const mbtn = (t, delta) => `<button onclick="A.setDurationMin('${type}',${delta})" style="width:30px;height:30px;border-radius:50%;border:1.5px solid var(--inpBorder);background:var(--card);font-size:16px;font-weight:700;color:var(--text);font-family:inherit;line-height:1;">${t}</button>`;
  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-top:1px solid var(--line);">
    <span style="font-size:14px;font-weight:700;color:var(--text);">${emoji} ${label}</span>
    <div style="display:flex;align-items:center;gap:10px;">
      <div style="display:flex;background:var(--card2);border-radius:11px;padding:3px;">${seg('end', '結束')}${seg('start', '開始')}</div>
      <div style="display:flex;align-items:center;gap:5px;">${mbtn('−', -5)}<span style="min-width:34px;text-align:center;font-size:14px;font-weight:700;color:var(--text);">${d.minutes}分</span>${mbtn('+', 5)}</div>
    </div>
  </div>`;
}
function babyAgeLabel() {
  const birth = Store.data.settings.babyBirth;
  if (!birth) return '尚未設定生日';
  const mo = (new Date() - new Date(birth)) / 86400000 / 30.4375;
  if (mo < 0) return '即將出生';
  return mo < 1 ? Math.round(mo * 30.4) + ' 天大' : Math.floor(mo) + ' 個月大';
}

const GOOGLE_G_ICON = `<svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`;

function renderAuthCard() {
  const u = Sync.user;
  if (u) {
    const initial = (u.displayName || u.email || '?')[0].toUpperCase();
    const photo = u.photoURL
      ? `<img src="${u.photoURL}" referrerpolicy="no-referrer" style="width:40px;height:40px;border-radius:50%;flex-shrink:0;object-fit:cover;" />`
      : `<div style="width:40px;height:40px;border-radius:50%;background:var(--accent);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:17px;flex-shrink:0;">${initial}</div>`;
    const statusLabel = Sync.state === 'done' ? '✓ 即時同步中' : Sync.state === 'syncing' ? '連接中…' : (Sync.message || '—');
    return `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:14px;">
        ${photo}
        <div style="flex:1;min-width:0;">
          <p style="font-size:14px;font-weight:700;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(u.displayName || '使用者')}</p>
          <p style="font-size:12px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;">${esc(u.email)}</p>
        </div>
        <button onclick="A.signOut()" style="flex-shrink:0;font-size:12px;color:#E5573D;background:none;border:1.5px solid #E5573D;border-radius:10px;padding:6px 12px;">登出</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;background:var(--card2);border-radius:12px;padding:10px 12px;">
        <div style="width:8px;height:8px;border-radius:50%;background:${Sync.state === 'done' ? '#5CB85C' : '#C8965A'};flex-shrink:0;"></div>
        <p style="font-size:12px;color:var(--text2);">${esc(statusLabel)}</p>
      </div>`;
  }
  const warn = Sync.state === 'unauthorized'
    ? `<div style="display:flex;gap:6px;align-items:flex-start;margin-bottom:12px;background:var(--card2);border-radius:12px;padding:10px 12px;"><span style="font-size:13px;">⚠️</span><p style="font-size:11px;color:#D2654A;line-height:1.5;">${esc(Sync.message)}，請改用授權過的 Google 帳號登入。</p></div>`
    : '';
  return `${warn}
    <button onclick="A.signIn()" style="width:100%;padding:13px;border:1.5px solid var(--inpBorder);border-radius:14px;background:var(--inpBg);display:flex;align-items:center;justify-content:center;gap:10px;font-size:14px;font-weight:700;color:var(--text);">
      ${GOOGLE_G_ICON}使用 Google 帳號登入
    </button>
    <p style="font-size:11px;color:var(--text3);text-align:center;margin-top:10px;line-height:1.5;">登入後資料即時同步到所有裝置，僅限授權過的家庭成員帳號。</p>`;
}
function renderSettings(state) {
  const s = Store.data.settings;
  const sexBtn = (val, label) => `<button onclick="A.setBabySex('${val}')" style="flex:1;padding:9px;border-radius:10px;border:none;font-size:13px;font-weight:${s.babySex === val ? 700 : 600};cursor:pointer;background:${s.babySex === val ? 'var(--card)' : 'transparent'};color:${s.babySex === val ? 'var(--text)' : 'var(--text2)'};box-shadow:${s.babySex === val ? '0 1px 5px var(--shadow)' : 'none'};">${label}</button>`;
  const themeOpt = (val, label) => `<button onclick="A.setTheme('${val}')" style="flex:1;padding:9px 0;border:none;border-radius:11px;font-size:13px;font-weight:700;font-family:inherit;background:${state.theme === val ? 'var(--card)' : 'transparent'};color:${state.theme === val ? 'var(--text)' : 'var(--text2)'};box-shadow:${state.theme === val ? '0 1px 5px var(--shadow)' : 'none'};">${label}</button>`;

  return `<div class="ns" style="flex:1;min-height:0;padding-bottom:18px;">
    ${headerBar('設定')}
    <div style="padding:14px 16px 0;">
      ${sectionLabel('寶寶資料（所有裝置共用）')}
      <div class="card" style="padding:20px 18px;">
        <div style="display:flex;align-items:center;gap:14px;margin-bottom:16px;">
          <div style="width:60px;height:60px;border-radius:50%;background:linear-gradient(135deg,#FFCC70,#FF8C6B);display:flex;align-items:center;justify-content:center;font-size:30px;flex-shrink:0;">👶</div>
          <div style="flex:1;min-width:0;">
            <input type="text" value="${esc(s.babyName)}" onchange="A.setBabyName(this.value)" placeholder="寶寶名字" style="border:none;background:transparent;font-size:21px;font-weight:800;padding:0;color:var(--text);border-radius:0;" />
            <p style="font-size:12px;color:var(--text2);margin-top:2px;">${babyAgeLabel()}</p>
          </div>
        </div>
        <p style="font-size:11px;color:var(--text2);font-weight:600;margin-bottom:5px;">生日</p>
        <input type="date" value="${esc(s.babyBirth)}" onchange="A.setBabyBirth(this.value)" style="margin-bottom:12px;" />
        <p style="font-size:11px;color:var(--text2);font-weight:600;margin-bottom:6px;">性別（用於成長百分位）</p>
        <div style="display:flex;background:var(--card2);border-radius:14px;padding:4px;">${sexBtn('boy', '👦 男生')}${sexBtn('girl', '👧 女生')}</div>
        <p style="font-size:10.5px;color:var(--text3);margin-top:10px;line-height:1.5;">寶寶資料屬於所有照顧者共用（會隨同步在各裝置一致）；下方「我是…」才是這支手機自己的身分。</p>
      </div>
    </div>
    <div style="padding:18px 16px 0;">
      ${sectionLabel('這支手機的使用者')}
      <div class="card" style="padding:16px;">
        <p style="font-size:11px;color:var(--text2);font-weight:600;margin-bottom:7px;">我是…（之後每筆記錄會標記成這個名字）</p>
        <input type="text" value="${esc(Store.caregiver)}" onchange="A.setCaregiver(this.value)" placeholder="爸爸、媽媽、阿嬤、保母…" />
      </div>
    </div>
    <div style="padding:18px 16px 0;">
      ${sectionLabel('外觀')}
      <div class="card" style="padding:14px 16px;">
        <div style="display:flex;background:var(--card2);border-radius:14px;padding:4px;">${themeOpt('day', '☀️ 日間')}${themeOpt('night', '🌙 夜間')}${themeOpt('auto', '🔄 自動')}</div>
        <p style="font-size:11px;color:var(--text3);margin-top:10px;line-height:1.5;">「自動」會跟隨系統的深淺色設定切換。夜間餵奶時建議用夜間模式，降低亮度不刺眼。</p>
      </div>
    </div>
    <div style="padding:18px 16px 0;">
      ${sectionLabel('事件時長')}
      <div class="card" style="padding:6px 16px;">
        <p style="font-size:11px;color:var(--text3);padding:10px 0 4px;line-height:1.5;">用於匯出日曆時決定事件起訖。<b style="color:var(--text2);">結束</b>=事件時間當結束往前推；<b style="color:var(--text2);">開始</b>=當開始往後推；分鐘設 0 即起訖相同。</p>
        ${durRow('milk', '喝奶', '🍼')}${durRow('poop', '排便', '💩')}${durRow('pee', '尿尿', '💧')}
      </div>
    </div>
    <div style="padding:18px 16px 0;">
      ${sectionLabel('匯出 Google 日曆')}
      <div class="card" style="padding:16px;">
        <div style="margin-bottom:8px;">
          <p style="font-size:11px;color:var(--text2);font-weight:600;margin-bottom:5px;">從</p>
          <input type="date" value="${esc(state.exportFrom)}" onchange="A.setExportFrom(this.value)" style="margin-bottom:10px;" />
          <p style="font-size:11px;color:var(--text2);font-weight:600;margin-bottom:5px;">到</p>
          <input type="date" value="${esc(state.exportTo)}" onchange="A.setExportTo(this.value)" />
        </div>
        <p style="font-size:11px;color:var(--text3);margin-bottom:14px;">含頭含尾，自由框選範圍。CSV 為一次性快照匯入，重複匯入會產生重複事件。</p>
        <button onclick="A.doExport()" class="primary-btn" style="box-shadow:0 4px 16px rgba(240,165,0,.38);padding:15px;">⬇ 匯出 CSV</button>
      </div>
    </div>
    <div style="padding:18px 16px 0;">
      ${sectionLabel('同步與帳號')}
      <div class="card" style="padding:16px;">
        ${renderAuthCard()}
      </div>
    </div>
    <div style="padding:18px 16px 0;">
      ${sectionLabel('資料備份')}
      <div class="card" style="padding:16px;">
        <p style="font-size:11px;color:var(--text3);margin-bottom:12px;line-height:1.5;">下載一份完整資料快照（喝奶/排便/尿尿/成長紀錄），存到雲端硬碟或信箱給自己，作為額外保險。</p>
        <button onclick="A.doBackup()" style="width:100%;background:var(--card2);border:1.5px solid var(--inpBorder);border-radius:16px;padding:13px;font-size:14px;font-weight:700;color:var(--text);">💾 下載備份 JSON</button>
      </div>
    </div>
    <div style="padding:18px 16px 0;">
      ${sectionLabel('預設奶量')}
      <div class="card" style="padding:16px;">
        <p style="font-size:11px;color:var(--text3);margin-bottom:12px;line-height:1.5;">開「喝奶」時自動帶入的預設量。</p>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin:0 2px 2px;"><span style="font-size:13px;font-weight:700;color:#FF7A56;">🤱 母乳</span><span id="f-def-breast-val" style="font-size:14px;font-weight:800;color:var(--text);">${s.defaultMilk.breast} ml</span></div>
        <div style="margin:0 2px 12px;"><input type="range" min="0" max="300" step="5" value="${s.defaultMilk.breast}" oninput="A.liveDefSlider('breast',this.value)" onchange="A.setDefMilk('breast',this.value)" /></div>
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin:0 2px 2px;"><span style="font-size:13px;font-weight:700;color:#E8A33D;">🍼 配方</span><span id="f-def-formula-val" style="font-size:14px;font-weight:800;color:var(--text);">${s.defaultMilk.formula} ml</span></div>
        <div style="margin:0 2px;"><input type="range" min="0" max="300" step="5" value="${s.defaultMilk.formula}" oninput="A.liveDefSlider('formula',this.value)" onchange="A.setDefMilk('formula',this.value)" /></div>
      </div>
    </div>
    <div style="padding:18px 16px 24px;">
      ${sectionLabel('Alarm 時間微調')}
      <div class="card" style="padding:16px;">
        <p style="font-size:11px;color:var(--text3);margin-bottom:14px;line-height:1.5;">調整首頁「預計下一餐」的提示時間（畫面提示，非系統鬧鐘）。</p>
        <div style="display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:15px;font-weight:800;color:var(--text);">⏰ ${alarmLabel(s.alarmOffsetMinutes)}</span>
          <div style="display:flex;align-items:center;gap:12px;">
            <button onclick="A.decAlarm()" style="width:36px;height:36px;border-radius:50%;border:1.5px solid var(--inpBorder);background:var(--card);font-size:19px;font-weight:700;color:var(--text);line-height:1;">−</button>
            <button onclick="A.incAlarm()" style="width:36px;height:36px;border-radius:50%;border:1.5px solid var(--inpBorder);background:var(--card);font-size:19px;font-weight:700;color:var(--text);line-height:1;">+</button>
          </div>
        </div>
      </div>
    </div>

    <div style="text-align:center;padding:24px 0 8px;color:var(--text3);font-size:11px;letter-spacing:.05em;">
      v${APP_VERSION}
    </div>
  </div>`;
}
function alarmLabel(n) { n = n || 0; return n === 0 ? '準時' : (n < 0 ? `提前 ${-n} 分` : `延後 ${n} 分`); }

// ============================= SHEETS =============================
// Tapping the number itself (h/m here, ml amounts in the milk sheets) swaps it for a
// numeric <input> in place — see App.startNumEdit/commitNumEdit. Autofocus is handled in
// render() (see below) since the `autofocus` HTML attribute isn't reliable on innerHTML
// insertion across browsers.
function numEditInput(value, width, fontSize) {
  return `<input id="f-numedit" type="number" inputmode="numeric" value="${esc(value)}" onblur="A.commitNumEdit(this.value)" onkeydown="if(event.key==='Enter'){this.blur();}else if(event.key==='Escape'){A.cancelNumEdit();}" style="width:${width}px;text-align:center;font-weight:800;font-size:${fontSize}px;border:none;background:var(--card);border-radius:8px;color:var(--text);" />`;
}
function timeStepper(state) {
  const pad = (n) => String(n).padStart(2, '0');
  const ne = state.numEdit;
  // Long-press repeats the step (accelerating) instead of one step per tap — see
  // App.startHold/stopHold. Release is caught globally (main.js window pointerup) since
  // this button's own DOM node gets replaced by the rerender each step fires.
  const stepBtn = (label, fn) => `<button onpointerdown="A.startHold(()=>{${fn}})" style="width:38px;height:38px;border-radius:50%;border:none;background:var(--card);color:var(--text);font-size:20px;font-weight:700;box-shadow:0 2px 6px var(--shadow);font-family:inherit;line-height:1;">${label}</button>`;
  const unit = (field, val, suffix, dec, inc) => {
    const editing = ne && ne.field === field;
    const display = editing
      ? numEditInput(ne.value, 58, 26)
      : `<span onclick="A.startNumEdit('${field}')" style="font-size:30px;font-weight:800;letter-spacing:-1px;color:var(--text);cursor:pointer;">${val}</span><span style="font-size:13px;color:var(--text2);margin-left:3px;">${suffix}</span>`;
    return `<div style="display:flex;align-items:center;gap:12px;">${stepBtn('−', dec)}<div style="min-width:58px;text-align:center;">${display}</div>${stepBtn('+', inc)}</div>`;
  };
  return `<div style="display:flex;justify-content:center;gap:22px;background:var(--card2);border-radius:18px;padding:16px 0;">
    ${unit('h', pad(state.rt.h), '時', "A.setH(-1)", "A.setH(1)")}
    ${unit('m', pad(state.rt.m), '分', "A.setM(-1)", "A.setM(1)")}
  </div>`;
}

// ml amount spans double as both a live-drag readout (see App.liveSlider, which patches
// #f-milk-breast-val/#f-milk-formula-val's textContent directly while the range slider is
// being dragged) and a tap-to-edit target — so the id must stay on the non-editing <span>.
function mlValueSpan(state, field) {
  const id = field === 'milkBreast' ? 'f-milk-breast-val' : 'f-milk-formula-val';
  const ne = state.numEdit;
  if (ne && ne.field === field) return numEditInput(ne.value, 70, 15);
  const val = field === 'milkBreast' ? state.milkBreast : state.milkFormula;
  return `<span id="${id}" onclick="A.startNumEdit('${field}')" style="font-size:15px;font-weight:800;color:var(--text);cursor:pointer;">${val} ml</span>`;
}
function renderMilkSheet(state, reopen) {
  return `<div class="sheet-overlay" onclick="A.closeSheet()">
    <div class="sheet" onclick="event.stopPropagation()" onpointerdown="A.startSheetDrag(event)" style="${sheetAnim(reopen)}">
      <div class="sheet-handle"></div>
      <h2 style="font-size:23px;font-weight:800;margin-bottom:16px;color:var(--text);">記錄喝奶 🍼</h2>
      <p style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">時間</p>
      ${timeStepper(state)}
      <p style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin:16px 0 4px;">奶量（母乳 ＋ 配方，可混合）</p>
      <div style="text-align:center;margin-bottom:6px;"><span id="f-milk-total" style="font-size:54px;font-weight:800;line-height:1;letter-spacing:-2px;color:var(--text);">${state.milkBreast + state.milkFormula}</span><span style="font-size:18px;font-weight:500;color:var(--text2);margin-left:5px;">ml 總計</span></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin:6px 4px 2px;"><span style="font-size:13px;font-weight:700;color:#FF7A56;">🤱 母乳</span>${mlValueSpan(state, 'milkBreast')}</div>
      <div style="margin:0 4px 14px;"><input type="range" min="0" max="300" step="5" value="${state.milkBreast}" oninput="A.liveSlider('breast',this.value)" /></div>
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin:6px 4px 2px;"><span style="font-size:13px;font-weight:700;color:#E8A33D;">🍼 配方</span>${mlValueSpan(state, 'milkFormula')}</div>
      <div style="margin:0 4px 22px;"><input type="range" min="0" max="300" step="5" value="${state.milkFormula}" oninput="A.liveSlider('formula',this.value)" /></div>
      <button onclick="A.confirmRecord()" class="primary-btn">✓ 完成記錄</button>
      <button onclick="A.closeSheet()" class="text-btn">取消</button>
    </div>
  </div>`;
}
function renderEditSheet(state, reopen) {
  const label = state.recordType === 'poop' ? '排便 💩' : '尿尿 💧';
  return `<div class="sheet-overlay" onclick="A.closeSheet()">
    <div class="sheet" onclick="event.stopPropagation()" onpointerdown="A.startSheetDrag(event)" style="${sheetAnim(reopen)}">
      <div class="sheet-handle"></div>
      <h2 style="font-size:23px;font-weight:800;margin-bottom:6px;color:var(--text);">補記${label}</h2>
      <p style="font-size:13px;color:var(--text2);margin-bottom:18px;">調整時間後送出。</p>
      <p style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">時間</p>
      ${timeStepper(state)}
      <button onclick="A.confirmRecord()" class="primary-btn" style="margin-top:24px;">✓ 完成記錄</button>
      <button onclick="A.closeSheet()" class="text-btn">取消</button>
    </div>
  </div>`;
}
function renderEditRecSheet(state, reopen) {
  const isMilk = state.recordType === 'milk';
  const isDiaper = !isMilk;
  const typeSeg = isDiaper ? `<p style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin:16px 0 8px;">類型</p>
    <div style="display:flex;background:var(--card2);border-radius:18px;padding:4px;margin-bottom:12px;">
      <button onclick="A.setEditType('poop')" style="flex:1;padding:10px;border-radius:14px;border:none;font-size:14px;font-weight:${state.recordType === 'poop' ? 700 : 600};background:${state.recordType === 'poop' ? 'var(--card)' : 'transparent'};color:${state.recordType === 'poop' ? 'var(--text)' : 'var(--text2)'};box-shadow:${state.recordType === 'poop' ? '0 2px 8px var(--shadow)' : 'none'};">💩 排便</button>
      <button onclick="A.setEditType('pee')" style="flex:1;padding:10px;border-radius:14px;border:none;font-size:14px;font-weight:${state.recordType === 'pee' ? 700 : 600};background:${state.recordType === 'pee' ? 'var(--card)' : 'transparent'};color:${state.recordType === 'pee' ? 'var(--text)' : 'var(--text2)'};box-shadow:${state.recordType === 'pee' ? '0 2px 8px var(--shadow)' : 'none'};">💧 尿尿</button>
    </div>
    <button onclick="A.editAddOther()" style="width:100%;background:var(--card2);border:1.5px dashed var(--inpBorder);border-radius:14px;padding:12px;font-size:14px;font-weight:700;color:var(--text2);margin-bottom:6px;">${state.recordType === 'poop' ? '＋ 同時加上尿尿 💧' : '＋ 同時加上排便 💩'}</button>` : '';
  const milkBlock = isMilk ? `<p style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin:16px 0 4px;">奶量（母乳 ＋ 配方）</p>
    <div style="text-align:center;margin-bottom:6px;"><span id="f-milk-total" style="font-size:48px;font-weight:800;line-height:1;letter-spacing:-2px;color:var(--text);">${state.milkBreast + state.milkFormula}</span><span style="font-size:17px;font-weight:500;color:var(--text2);margin-left:5px;">ml 總計</span></div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin:6px 4px 2px;"><span style="font-size:13px;font-weight:700;color:#FF7A56;">🤱 母乳</span>${mlValueSpan(state, 'milkBreast')}</div>
    <div style="margin:0 4px 12px;"><input type="range" min="0" max="300" step="5" value="${state.milkBreast}" oninput="A.liveSlider('breast',this.value)" /></div>
    <div style="display:flex;justify-content:space-between;align-items:baseline;margin:6px 4px 2px;"><span style="font-size:13px;font-weight:700;color:#E8A33D;">🍼 配方</span>${mlValueSpan(state, 'milkFormula')}</div>
    <div style="margin:0 4px 14px;"><input type="range" min="0" max="300" step="5" value="${state.milkFormula}" oninput="A.liveSlider('formula',this.value)" /></div>` : '';
  return `<div class="sheet-overlay" onclick="A.closeSheet()">
    <div class="sheet" onclick="event.stopPropagation()" onpointerdown="A.startSheetDrag(event)" style="padding-bottom:30px;${sheetAnim(reopen)}">
      <div class="sheet-handle"></div>
      <h2 style="font-size:23px;font-weight:800;margin-bottom:16px;color:var(--text);">編輯記錄</h2>
      <p style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">時間</p>
      ${timeStepper(state)}
      ${typeSeg}
      ${milkBlock}
      <p style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin:16px 0 8px;">由誰處理</p>
      <input id="f-edit-by" type="text" value="${esc(state.editBy)}" placeholder="名字" style="margin-bottom:14px;" />
      <button onclick="A.saveEdit()" class="primary-btn" style="padding:16px;font-size:16px;">✓ 儲存變更</button>
      <button onclick="A.deleteFromEdit()" style="width:100%;background:transparent;border:none;padding:12px;font-size:14px;font-weight:700;color:#E5573D;margin-top:4px;">🗑️ 刪除這筆</button>
    </div>
  </div>`;
}
function renderGrowthSheet(state, reopen) {
  const editing = !!state.editingGrowthId;
  return `<div class="sheet-overlay" onclick="A.closeSheet()">
    <div class="sheet" onclick="event.stopPropagation()" onpointerdown="A.startSheetDrag(event)" style="${sheetAnim(reopen)}">
      <div class="sheet-handle"></div>
      <h2 style="font-size:23px;font-weight:800;margin-bottom:16px;color:var(--text);">${editing ? '編輯成長紀錄' : '記錄成長'} 📈</h2>
      <p style="font-size:11px;font-weight:700;color:var(--text2);text-transform:uppercase;letter-spacing:.6px;margin-bottom:8px;">日期</p>
      <input type="date" value="${esc(state.gDate)}" onchange="A.set({gDate:this.value})" style="margin-bottom:16px;" />
      <div style="display:flex;gap:10px;">
        <div style="flex:1;"><p style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:6px;">⚖️ 體重 kg</p><input id="f-g-weight" type="text" inputmode="decimal" value="${esc(state.gWeight)}" placeholder="5.4" /></div>
        <div style="flex:1;"><p style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:6px;">📏 身高 cm</p><input id="f-g-height" type="text" inputmode="decimal" value="${esc(state.gHeight)}" placeholder="58" /></div>
        <div style="flex:1;"><p style="font-size:11px;font-weight:700;color:var(--text2);margin-bottom:6px;">🧠 頭圍 cm</p><input id="f-g-head" type="text" inputmode="decimal" value="${esc(state.gHead)}" placeholder="39" /></div>
      </div>
      <p style="font-size:10.5px;color:var(--text3);margin:10px 2px 0;">可只填部分，留空的不記。</p>
      <button onclick="A.saveGrowth()" class="primary-btn" style="margin-top:18px;">✓ ${editing ? '儲存變更' : '完成記錄'}</button>
      <button onclick="A.closeSheet()" class="text-btn">取消</button>
      ${editing ? `<button onclick="A.deleteFromGrowthEdit()" style="width:100%;background:transparent;border:none;padding:12px;font-size:14px;font-weight:700;color:#E5573D;margin-top:4px;">🗑️ 刪除這筆</button>` : ''}
    </div>
  </div>`;
}

function renderDeleteConfirm(state) {
  const rec = Store.data.events.find(e => e.id === state.confirmDelId);
  if (!rec) return '';
  const mix = rec.breastMl > 0 && rec.formulaMl > 0;
  const tn = rec.type === 'milk' ? ('喝奶 ' + (mix ? (rec.breastMl + '+' + rec.formulaMl + 'ml') : ((rec.amountMl || 0) + 'ml'))) : rec.type === 'poop' ? '排便' : '尿尿';
  const delText = tn + ' · ' + hm(new Date(rec.time));
  return `<div style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);z-index:90;display:flex;align-items:center;justify-content:center;" onclick="A.cancelDelete()">
    <div onclick="event.stopPropagation()" style="background:var(--card);border-radius:26px;padding:26px 24px 20px;width:280px;text-align:center;box-shadow:0 24px 80px var(--shadow2);animation:pop .35s cubic-bezier(.17,.67,.32,1.2);">
      <div style="font-size:40px;margin-bottom:8px;">${emojiOf(rec.type)}</div>
      <p style="font-size:16px;font-weight:800;margin-bottom:3px;color:var(--text);">刪除這筆記錄？</p>
      <p style="font-size:13px;color:var(--text2);margin-bottom:18px;">${delText}</p>
      <div style="display:flex;gap:10px;">
        <button onclick="A.cancelDelete()" style="flex:1;background:var(--card2);border:none;border-radius:14px;padding:13px;font-size:15px;font-weight:700;color:var(--text2);">取消</button>
        <button onclick="A.doDelete()" style="flex:1;background:#E5573D;border:none;border-radius:14px;padding:13px;font-size:15px;font-weight:800;color:#fff;box-shadow:0 4px 14px rgba(229,87,61,.4);">刪除</button>
      </div>
    </div>
  </div>`;
}

function renderDeleteGrowthConfirm(state) {
  const rec = Store.data.growth.find(g => g.id === state.confirmDelGrowthId);
  if (!rec) return '';
  const delText = `${esc(rec.date)} · ⚖️ ${rec.weight ?? '—'}  📏 ${rec.height ?? '—'}  🧠 ${rec.head ?? '—'}`;
  return `<div style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);backdrop-filter:blur(4px);z-index:90;display:flex;align-items:center;justify-content:center;" onclick="A.cancelDeleteGrowth()">
    <div onclick="event.stopPropagation()" style="background:var(--card);border-radius:26px;padding:26px 24px 20px;width:280px;text-align:center;box-shadow:0 24px 80px var(--shadow2);animation:pop .35s cubic-bezier(.17,.67,.32,1.2);">
      <div style="font-size:40px;margin-bottom:8px;">📈</div>
      <p style="font-size:16px;font-weight:800;margin-bottom:3px;color:var(--text);">刪除這筆成長紀錄？</p>
      <p style="font-size:13px;color:var(--text2);margin-bottom:18px;">${delText}</p>
      <div style="display:flex;gap:10px;">
        <button onclick="A.cancelDeleteGrowth()" style="flex:1;background:var(--card2);border:none;border-radius:14px;padding:13px;font-size:15px;font-weight:700;color:var(--text2);">取消</button>
        <button onclick="A.doDeleteGrowth()" style="flex:1;background:#E5573D;border:none;border-radius:14px;padding:13px;font-size:15px;font-weight:800;color:#fff;box-shadow:0 4px 14px rgba(229,87,61,.4);">刪除</button>
      </div>
    </div>
  </div>`;
}

function renderWelcome(state) {
  if (!state.showWelcome) return '';
  return `<div style="position:absolute;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.55);backdrop-filter:blur(8px);z-index:110;display:flex;align-items:center;justify-content:center;padding:24px;">
    <div style="background:var(--card);border-radius:28px;padding:28px 24px 22px;width:300px;text-align:center;box-shadow:0 24px 80px var(--shadow2);animation:pop .35s cubic-bezier(.17,.67,.32,1.2);">
      <div style="font-size:46px;margin-bottom:10px;">👶</div>
      <h2 style="font-size:20px;font-weight:800;color:var(--text);margin-bottom:6px;">你是誰呢？</h2>
      <p style="font-size:12.5px;color:var(--text2);margin-bottom:18px;line-height:1.5;">這支手機之後記錄的事件，都會標記成你的名字。</p>
      <input id="f-welcome-name" type="text" value="${esc(state.welcomeName)}" placeholder="爸爸、媽媽、阿嬤…" style="text-align:center;margin-bottom:16px;" />
      <button onclick="A.closeWelcome()" class="primary-btn" style="padding:15px;font-size:16px;box-shadow:0 6px 20px rgba(240,165,0,.4);">開始記錄 →</button>
    </div>
  </div>`;
}

function renderToast(state) {
  const t = state.toast;
  if (!t) return '';
  if (!t.addType) {
    return `<div class="toast-wrap" style="pointer-events:none;">
      <div style="background:var(--card);border-radius:30px;padding:28px 42px;text-align:center;box-shadow:0 24px 80px var(--shadow2);animation:pop .4s cubic-bezier(.17,.67,.32,1.2),fade 1.7s ease forwards;">
        <div style="font-size:50px;margin-bottom:10px;">${t.emoji}</div><p style="font-size:17px;font-weight:800;color:var(--text);">${esc(t.msg)}</p>
      </div></div>`;
  }
  const addLabel = t.addType === 'pee' ? '＋ 尿尿 💧' : '＋ 排便 💩';
  return `<div class="toast-wrap" onclick="A.dismissToast()">
    <div onclick="event.stopPropagation()" style="background:var(--card);border-radius:30px;padding:26px 30px 22px;text-align:center;box-shadow:0 24px 80px var(--shadow2);animation:pop .4s cubic-bezier(.17,.67,.32,1.2);">
      <div style="font-size:48px;margin-bottom:8px;">${t.emoji}</div>
      <p style="font-size:17px;font-weight:800;margin-bottom:3px;color:var(--text);">${esc(t.msg)}</p>
      <p style="font-size:12px;color:var(--text2);margin-bottom:16px;">同一片尿布也有？</p>
      <button onclick="A.addOther()" style="background:linear-gradient(135deg,#F0A500,#E09000);border:none;border-radius:14px;padding:12px 24px;font-size:15px;font-weight:800;color:#fff;box-shadow:0 4px 14px rgba(240,165,0,.4);">${addLabel}</button>
    </div></div>`;
}

// ============================= ROOT =============================
function AppRef() { return window.A; }

function renderScreen(state) {
  if (state.screen === 'stats') return renderStats(state);
  if (state.screen === 'records') return renderRecords(state);
  if (state.screen === 'config') return renderSettings(state);
  return renderHome(state);
}
// Every state change rebuilds the whole DOM (see render() below), so the sheet's
// slide-up-from-bottom CSS animation would otherwise replay on every single re-render
// while it's open — including every tick of dragging a range slider (oninput fires per
// pixel) or every tap of the time stepper. That looked like the sheet "kept reopening"
// and made sliders/time adjustment unusable. Track whether this is the same sheet
// instance as last render (by sheet type + editingId) and suppress the animation if so;
// only a genuine open (or switching to editing a different record) should animate in.
let _lastSheetKey = null;
function renderSheet(state) {
  if (!state.sheet) { _lastSheetKey = null; return ''; }
  const key = state.sheet + ':' + (state.editingId || '');
  const reopen = key === _lastSheetKey;
  _lastSheetKey = key;
  if (state.sheet === 'milk') return renderMilkSheet(state, reopen);
  if (state.sheet === 'edit') return renderEditSheet(state, reopen);
  if (state.sheet === 'editRec') return renderEditRecSheet(state, reopen);
  if (state.sheet === 'growth') return renderGrowthSheet(state, reopen);
  return '';
}
function sheetAnim(reopen) { return reopen ? 'animation:none;' : ''; }

function render(state) {
  _timelineMeta = null;
  // Every state change replaces #root's whole innerHTML (see module comment below), which
  // would otherwise reset the visible screen's scroll position to 0 on every single
  // re-render — jarring mid-scroll, and especially bad during a drag gesture that used to
  // trigger a render per pointermove. Carry the old scroll position over to the new DOM.
  const prevScroll = document.querySelector('.ns')?.scrollTop || 0;
  const screenHtml = renderScreen(state);
  const html = `<div class="app">
    ${screenHtml}
    ${renderNav(state)}
    ${renderSheet(state)}
    ${renderDeleteConfirm(state)}
    ${renderDeleteGrowthConfirm(state)}
    ${renderWelcome(state)}
    ${renderToast(state)}
  </div>`;
  const root = document.getElementById('root');
  root.innerHTML = html;
  applyTheme(state);
  const scrollArea = root.querySelector('.ns');
  if (scrollArea) scrollArea.scrollTop = prevScroll;
  // autofocus isn't reliably honored on elements inserted via innerHTML across browsers
  const numEditEl = document.getElementById('f-numedit');
  if (numEditEl) { numEditEl.focus(); numEditEl.select(); }
  if (_timelineMeta) {
    window.A._trackNode = document.getElementById('timeline-track');
    window.A._yToH = _timelineMeta.yToH;
    window.A._hToY = _timelineMeta.hToY;
    window.A._axis = _timelineMeta.axis;
    window.A._winStart = _timelineMeta.winStart;
  }
  return root.querySelector('#scroll-area');
}
