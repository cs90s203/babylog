// Next-feed prediction. Learns the household's actual rhythm instead of one blended
// median: intervals are split into four daypart buckets (morning/afternoon/evening/night),
// and the day's first/last feed times are learned as anchors for the two trickiest
// moments — right after waking and right before the overnight stretch. See
// docs/prediction.md for rationale and remaining extension ideas.

const N_RECENT = 8; // how many recent intervals (per bucket) to consider
const MIN_DATA_DAYS = 2; // need at least this many days of feed history before predicting
const PREDICT_EARLY_HOUR = 6; // a first tracking day only counts as "complete" if logging started before this hour — same rule as the stats page's validStatsDays() (separate constant name — classic <script> tags share one global scope, so this can't reuse views.js's EARLY_HOUR)

function median(arr) {
  if (!arr.length) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
function sameLocalDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() && d1.getMonth() === d2.getMonth() && d1.getDate() === d2.getDate();
}
function dateKey(d) { return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

// "Night" isn't a fixed clock window on its own — it's whichever interval crosses into a
// new local date, same as before, PLUS the small pre-dawn hours (23:00-04:59) even when
// they don't cross a date (two feeds both shortly after midnight, say). Anything else is
// bucketed by clock hour into three dayparts. Fixed boundaries here (unlike the day/night
// split) since "morning/afternoon/evening" is a much more universal sense of time of day
// than "how long this baby sleeps at a stretch", which genuinely varies household to
// household.
function bucketOf(prev, cur) {
  if (!sameLocalDay(prev, cur)) return 'night';
  const h = cur.getHours();
  if (h >= 23 || h < 5) return 'night';
  if (h < 11) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

// Which calendar dates are trustworthy enough to learn typical patterns (bucket medians,
// first/last-feed times, daily volume) from. Excludes: today (always incomplete), the
// first-ever tracking day if logging started too late in the day to represent a full day,
// and — implicitly, since they're just never in `feeds` — any days before tracking began.
// Building a "typical morning gap" or "typical first feed time" out of a half-day of data
// would skew every prediction that leans on it. Mirrors the stats page's validStatsDays().
function validFeedDates(feeds, now) {
  const valid = new Set();
  if (!feeds.length) return valid;
  const firstTime = new Date(feeds[0].time);
  const firstDk = dateKey(firstTime);
  const todayDk = dateKey(now);
  feeds.forEach(f => {
    const d = new Date(f.time);
    const dk = dateKey(d);
    if (dk === todayDk) return;
    if (dk === firstDk && firstTime.getHours() >= PREDICT_EARLY_HOUR) return;
    valid.add(dk);
  });
  return valid;
}

function predictNextFeed(events, alarmOffsetMinutes) {
  const feeds = events.filter(e => e.type === 'milk').slice().sort((a, b) => new Date(a.time) - new Date(b.time));
  if (feeds.length < 2) return { status: 'collecting' };

  const first = new Date(feeds[0].time), last = new Date(feeds[feeds.length - 1].time);
  const spanDays = (last - first) / 86400000;
  if (spanDays < MIN_DATA_DAYS) return { status: 'collecting' };

  const now = new Date();
  const validDates = validFeedDates(feeds, now);

  // Group valid-date feeds by date to pull out each day's first/last feed time and totals.
  const byDate = {};
  feeds.forEach(f => {
    const dk = dateKey(new Date(f.time));
    if (!validDates.has(dk)) return;
    (byDate[dk] = byDate[dk] || []).push(f);
  });
  const firstHours = [], lastHours = [];
  let totalMl = 0, totalFeeds = 0;
  Object.values(byDate).forEach(dayFeeds => {
    const f0 = new Date(dayFeeds[0].time), fN = new Date(dayFeeds[dayFeeds.length - 1].time);
    firstHours.push(f0.getHours() + f0.getMinutes() / 60);
    lastHours.push(fN.getHours() + fN.getMinutes() / 60);
    totalFeeds += dayFeeds.length;
    totalMl += dayFeeds.reduce((s, e) => s + (e.amountMl || 0), 0);
  });
  const typicalFirstHour = median(firstHours);
  const typicalLastHour = median(lastHours); // also doubles as "usual last feed before bed"
  const validDayCount = Object.keys(byDate).length;
  const avgMlPerDay = validDayCount ? Math.round(totalMl / validDayCount) : null;
  const avgFeedsPerDay = validDayCount ? Math.round((totalFeeds / validDayCount) * 10) / 10 : null;

  // Bucket every interval whose *both* endpoints fall on a valid date — an interval
  // touching today or the incomplete first day is unreliable evidence of the household's
  // actual rhythm, not just the day-total stats.
  const buckets = { morning: [], afternoon: [], evening: [], night: [] };
  for (let i = 1; i < feeds.length; i++) {
    const prev = new Date(feeds[i - 1].time), cur = new Date(feeds[i].time);
    if (!validDates.has(dateKey(prev)) || !validDates.has(dateKey(cur))) continue;
    const mins = (cur - prev) / 60000;
    if (mins <= 0) continue;
    buckets[bucketOf(prev, cur)].push(mins);
  }
  const bucketMedian = {};
  Object.keys(buckets).forEach(k => { bucketMedian[k] = median(buckets[k].slice(-N_RECENT)); });
  const allRecent = [].concat(...Object.values(buckets)).slice(-N_RECENT);
  if (Object.values(bucketMedian).every(v => v == null)) return { status: 'collecting' };

  const lastFeedTime = new Date(feeds[feeds.length - 1].time);
  let nextTime, medianMin = null, usedBucket = null;

  // No feed logged yet today: extrapolating from last night's last feed via the night
  // median tends to overshoot past when this baby usually wakes for its first feed —
  // anchor to the learned typical first-feed clock time instead.
  const noFeedToday = dateKey(lastFeedTime) !== dateKey(now);
  if (noFeedToday && typicalFirstHour != null) {
    const h = Math.floor(typicalFirstHour), m = Math.round((typicalFirstHour % 1) * 60);
    const candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    if (candidate > lastFeedTime) { nextTime = candidate; usedBucket = 'typicalFirst'; }
  }

  if (!nextTime) {
    const nowHour = now.getHours() + now.getMinutes() / 60;
    const sinceLastMin = (now - lastFeedTime) / 60000;
    const currentBucket = bucketOf(lastFeedTime, now);
    // Lean into night mode either once we're past the household's usual last-feed-before-bed
    // time, or once we've already gone longer than the current daypart's typical gap
    // (the general form of the old "exceeded the day median" check, now per-bucket instead
    // of just day-vs-night).
    const pastBedtime = typicalLastHour != null && bucketMedian.night != null && nowHour >= typicalLastHour;
    const overdueForBucket = bucketMedian[currentBucket] != null && sinceLastMin > bucketMedian[currentBucket] && bucketMedian.night != null;
    usedBucket = (pastBedtime || overdueForBucket) ? 'night' : currentBucket;
    medianMin = bucketMedian[usedBucket] != null ? bucketMedian[usedBucket] : median(allRecent);
    if (medianMin == null) return { status: 'collecting' };
    nextTime = new Date(lastFeedTime.getTime() + medianMin * 60000);
  }

  nextTime = new Date(nextTime.getTime() + (alarmOffsetMinutes || 0) * 60000);
  return {
    status: 'ok', nextTime, usedBucket, medianIntervalMin: medianMin,
    avgMlPerDay, avgFeedsPerDay, typicalFirstHour, typicalLastHour,
  };
}

/* Pseudocode (see docs/prediction.md):
 *   feeds = sortByTime(events.filter(type == 'milk'))
 *   if feeds.length < 2 or span(feeds) < 2 days: return "collecting"
 *   validDates = dates with a genuinely complete day of tracking (excludes today and any
 *     partial first day, see validFeedDates)
 *   for each valid date: record first/last feed hour, daily ml total, daily feed count
 *   bucket every interval between two valid-date feeds into morning/afternoon/evening/night
 *   if no feed yet today: predict today at the learned typical first-feed hour
 *   else: pick a bucket (current daypart, or night if past bedtime / overdue) and predict
 *     last feed time + that bucket's median interval
 *   nextTime += alarmOffset
 *
 * Future extension ideas (not implemented):
 *   - weight intervals by milkType (formula feeds tend to space out longer than breast)
 *   - surface avgMlPerDay/avgFeedsPerDay in the UI as their own stat, not just internal state
 */
