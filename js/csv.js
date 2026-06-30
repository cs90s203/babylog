// Google Calendar CSV export — see docs/csv-export.md for the field spec and limitations.
// This is a one-time snapshot export; re-importing the same range will create duplicates
// (Google's CSV import has no dedup). For live sync you'd need the Calendar API + OAuth (not implemented).

function pad(n) { return String(n).padStart(2, '0'); }

function fmtDate(d) {
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
}
function fmtTime(d) {
  let h = d.getHours();
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return `${pad(h)}:${pad(d.getMinutes())} ${ampm}`;
}
function csvField(v) {
  const s = String(v ?? '');
  if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function subjectFor(ev) {
  if (ev.type === 'milk') {
    const mix = (ev.breastMl || 0) > 0 && (ev.formulaMl || 0) > 0;
    const tag = mix ? '混合' : ((ev.formulaMl || 0) > 0 ? '配方乳' : '母乳');
    return `🍼 喝奶 ${ev.amountMl || 0}ml（${tag}）`;
  }
  if (ev.type === 'poop') return '💩 排便';
  return '💧 尿尿';
}

function durationKeyOf(type) { return type === 'milk' ? 'milk' : type; }

// Resolve [start, end] Date objects for an event given settings.duration.
function resolveRange(ev, duration) {
  const t = new Date(ev.time);
  const cfg = duration[durationKeyOf(ev.type)] || { mode: 'end', minutes: 0 };
  const ms = (cfg.minutes || 0) * 60000;
  if (cfg.mode === 'start') return [t, new Date(t.getTime() + ms)];
  return [new Date(t.getTime() - ms), t]; // mode === 'end'
}

// fromDate/toDate: 'YYYY-MM-DD' strings, inclusive on both ends.
function buildCsv(fromDate, toDate) {
  const from = new Date(fromDate + 'T00:00:00');
  const to = new Date(toDate + 'T23:59:59.999');
  const duration = Store.data.settings.duration;
  const rows = [['Subject', 'Start Date', 'Start Time', 'End Date', 'End Time', 'All Day Event', 'Description']];

  Store.liveEvents()
    .filter(ev => { const t = new Date(ev.time); return t >= from && t <= to; })
    .sort((a, b) => new Date(a.time) - new Date(b.time))
    .forEach(ev => {
      const [start, end] = resolveRange(ev, duration);
      const desc = `由 ${ev.by || '未命名'} 記錄`;
      rows.push([subjectFor(ev), fmtDate(start), fmtTime(start), fmtDate(end), fmtTime(end), 'False', desc]);
    });

  return rows.map(r => r.map(csvField).join(',')).join('\r\n');
}

function downloadCsv(fromDate, toDate) {
  const csv = buildCsv(fromDate, toDate);
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `baby-log-${fromDate}_to_${toDate}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
