// Next-feed prediction: median of the most recent N inter-feed intervals.
// Median (not mean) is used because one long overnight gap shouldn't skew the estimate.
// See docs/prediction.md for rationale and future extensions (day/night split, breast vs formula).

const N_RECENT = 8; // how many recent intervals to consider
const MIN_DATA_DAYS = 2; // need at least this many days of feed history before predicting

function predictNextFeed(events, alarmOffsetMinutes) {
  const feeds = events.filter(e => e.type === 'milk').slice().sort((a, b) => new Date(a.time) - new Date(b.time));
  if (feeds.length < 2) return { status: 'collecting' };

  const first = new Date(feeds[0].time), last = new Date(feeds[feeds.length - 1].time);
  const spanDays = (last - first) / 86400000;
  if (spanDays < MIN_DATA_DAYS) return { status: 'collecting' };

  const intervals = [];
  for (let i = Math.max(1, feeds.length - N_RECENT); i < feeds.length; i++) {
    const mins = (new Date(feeds[i].time) - new Date(feeds[i - 1].time)) / 60000;
    if (mins > 0) intervals.push(mins);
  }
  if (!intervals.length) return { status: 'collecting' };

  const sorted = intervals.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const medianMin = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const lastTime = new Date(feeds[feeds.length - 1].time);
  const nextTime = new Date(lastTime.getTime() + medianMin * 60000 + (alarmOffsetMinutes || 0) * 60000);
  return { status: 'ok', nextTime, medianIntervalMin: medianMin };
}

/* Pseudocode (see docs/prediction.md):
 *   feeds = sortByTime(events.filter(type == 'milk'))
 *   if feeds.length < 2 or span(feeds) < 2 days: return "collecting"
 *   intervals = diff(last N feeds)
 *   nextTime = last(feeds).time + median(intervals) + alarmOffset
 *
 * Future extension ideas (not implemented):
 *   - split intervals into day/night buckets, predict using the bucket matching `now`
 *   - weight intervals by milkType (formula feeds tend to space out longer than breast)
 */
