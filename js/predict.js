// Next-feed prediction: median of the most recent N inter-feed intervals, split into
// "day" and "night" buckets so an overnight sleep stretch doesn't get treated the same as
// a normal daytime gap. See docs/prediction.md for rationale and remaining extension ideas.

const N_RECENT = 8; // how many recent intervals (per bucket) to consider
const MIN_DATA_DAYS = 2; // need at least this many days of feed history before predicting

function median(arr) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
// "Night" isn't a fixed clock window (nap/bedtime timing varies) — an interval is "night"
// if its two feeds fall on different local calendar dates, same approach as the stats
// page's night-excluded average interval.
function sameLocalDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}

function predictNextFeed(events, alarmOffsetMinutes) {
  const feeds = events.filter(e => e.type === 'milk').slice().sort((a, b) => new Date(a.time) - new Date(b.time));
  if (feeds.length < 2) return { status: 'collecting' };

  const first = new Date(feeds[0].time), last = new Date(feeds[feeds.length - 1].time);
  const spanDays = (last - first) / 86400000;
  if (spanDays < MIN_DATA_DAYS) return { status: 'collecting' };

  const dayIntervals = [], nightIntervals = [];
  for (let i = 1; i < feeds.length; i++) {
    const prev = new Date(feeds[i - 1].time), cur = new Date(feeds[i].time);
    const mins = (cur - prev) / 60000;
    if (mins <= 0) continue;
    (sameLocalDay(prev, cur) ? dayIntervals : nightIntervals).push(mins);
  }
  const dayMedian = median(dayIntervals.slice(-N_RECENT));
  const nightMedian = median(nightIntervals.slice(-N_RECENT));
  if (dayMedian == null && nightMedian == null) return { status: 'collecting' };

  const lastTime = new Date(feeds[feeds.length - 1].time);
  const sinceLastMin = (new Date() - lastTime) / 60000;

  // Once we've already gone longer than a typical daytime gap since the last feed, this is
  // very likely an overnight stretch — predict using the night-interval median (if we have
  // one) instead of reapplying the shorter daytime rhythm, which used to make the app nag
  // "should have fed by now" partway through a perfectly normal long night's sleep.
  let medianMin, usedNightInterval = false;
  if (nightMedian != null && (dayMedian == null || sinceLastMin > dayMedian)) {
    medianMin = nightMedian; usedNightInterval = true;
  } else {
    medianMin = dayMedian != null ? dayMedian : nightMedian;
  }

  const nextTime = new Date(lastTime.getTime() + medianMin * 60000 + (alarmOffsetMinutes || 0) * 60000);
  return { status: 'ok', nextTime, medianIntervalMin: medianMin, usedNightInterval };
}

/* Pseudocode (see docs/prediction.md):
 *   feeds = sortByTime(events.filter(type == 'milk'))
 *   if feeds.length < 2 or span(feeds) < 2 days: return "collecting"
 *   split diffs(feeds) into dayIntervals/nightIntervals by whether they cross a local date
 *   if it's been longer than the day median since the last feed, predict with the night
 *     median (we're probably mid-sleep-stretch); otherwise use the day median
 *   nextTime = last(feeds).time + chosenMedian + alarmOffset
 *
 * Future extension ideas (not implemented):
 *   - weight intervals by milkType (formula feeds tend to space out longer than breast)
 */
