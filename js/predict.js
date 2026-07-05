// Next-feed prediction. Learns the household's actual rhythm instead of one blended
// median: intervals are split into four daypart buckets (morning/afternoon/evening/night),
// and the day's first/last feed times are learned as anchors for the two trickiest
// moments — right after waking and right before the overnight stretch. See
// docs/prediction.md for rationale and remaining extension ideas.

const N_RECENT = 8; // how many recent intervals (per bucket) to consider
const RECENT_DAYS = 14; // how many recent valid days feed into typicalFirstHour/typicalLastHour — kept in sync with N_RECENT's own recency so the two don't drift apart as sleep patterns slowly change (e.g. typicalFirstHour lagging behind an already-longer recent night stretch)
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

// asOf lets a caller reconstruct "what would this have predicted at some earlier moment"
// (see analyzeTodayPredictionAccuracy) — defaults to the real current time for the live
// home-screen prediction, where there's no earlier moment to pretend it is.
function predictNextFeed(events, alarmOffsetMinutes, asOf) {
  const feeds = events.filter(e => e.type === 'milk').slice().sort((a, b) => new Date(a.time) - new Date(b.time));
  if (feeds.length < 2) return { status: 'collecting' };

  const first = new Date(feeds[0].time), last = new Date(feeds[feeds.length - 1].time);
  const spanDays = (last - first) / 86400000;
  if (spanDays < MIN_DATA_DAYS) return { status: 'collecting' };

  const now = asOf || new Date();
  const validDates = validFeedDates(feeds, now);

  // Group valid-date feeds by date to pull out each day's first/last feed time and totals.
  const byDate = {};
  feeds.forEach(f => {
    const dk = dateKey(new Date(f.time));
    if (!validDates.has(dk)) return;
    (byDate[dk] = byDate[dk] || []).push(f);
  });
  // byDate's keys are insertion-ordered (dateKey isn't a pure-digit string, so JS doesn't
  // reorder them numerically) and feeds were sorted ascending before grouping, so this is
  // already chronological — slicing the tail gives the most recent RECENT_DAYS valid days.
  const dayEntries = Object.values(byDate).slice(-RECENT_DAYS);
  const firstHours = [], lastHours = [];
  let totalMl = 0, totalFeeds = 0;
  dayEntries.forEach(dayFeeds => {
    const f0 = new Date(dayFeeds[0].time), fN = new Date(dayFeeds[dayFeeds.length - 1].time);
    firstHours.push(f0.getHours() + f0.getMinutes() / 60);
    lastHours.push(fN.getHours() + fN.getMinutes() / 60);
    totalFeeds += dayFeeds.length;
    totalMl += dayFeeds.reduce((s, e) => s + (e.amountMl || 0), 0);
  });
  const typicalFirstHour = median(firstHours);
  const typicalLastHour = median(lastHours); // also doubles as "usual last feed before bed"
  const validDayCount = dayEntries.length;
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

  // Whether the last feed was itself already at/past the household's usual last-feed-of-
  // the-day hour is a fixed fact the moment that feed was logged, so this stays stable no
  // matter when you look at it afterward (unlike using elapsed real time, which used to
  // make the same data flip-flop between buckets purely depending on when you checked).
  const lastFeedHour = lastFeedTime.getHours() + lastFeedTime.getMinutes() / 60;
  const lastFeedBucket = bucketOf(lastFeedTime, lastFeedTime);
  const pastBedtime = typicalLastHour != null && bucketMedian.night != null && lastFeedHour >= typicalLastHour;
  // The night stretch's own projected end time (last feed + this household's recent night
  // interval), when knowable — used below to decide when it's fair to stop extrapolating
  // from the night bucket and switch to "no feed yet today" reasoning instead.
  const nightProjection = pastBedtime && bucketMedian.night != null
    ? new Date(lastFeedTime.getTime() + bucketMedian.night * 60000) : null;

  // No feed logged yet today: extrapolating from last night's last feed via the night
  // median tends to overshoot past when this baby usually wakes for its first feed —
  // anchor to the learned typical first-feed clock time instead. Gated on the night
  // stretch's own projected end (nightProjection) rather than the calendar date alone —
  // otherwise the mere act of the clock crossing midnight mid-stretch, with zero new
  // data, used to cause a discontinuous jump to a completely different estimate.
  const overdueForNight = nightProjection != null ? now >= nightProjection : dateKey(lastFeedTime) !== dateKey(now);
  if (overdueForNight && typicalFirstHour != null) {
    const h = Math.floor(typicalFirstHour), m = Math.round((typicalFirstHour % 1) * 60);
    let candidate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, m);
    // Never predict a first-feed-of-day time earlier than the point the night stretch is
    // itself expected to end — otherwise a long typical night vs. an early typicalFirstHour
    // could produce a candidate that's already in the past by the time this branch fires.
    if (nightProjection != null && candidate < nightProjection) candidate = nightProjection;
    if (candidate > lastFeedTime) { nextTime = candidate; usedBucket = 'typicalFirst'; }
  }

  if (!nextTime) {
    usedBucket = pastBedtime ? 'night' : lastFeedBucket;
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

// Rough single-feed volume by age, generic public formula-feeding guidance (not
// household-specific, not medical advice — same "reference curve" spirit as the WHO
// growth percentiles). [ageMonths, typicalMlPerFeed]. Interpolated linearly between
// points, same technique as who-data.js's lmsAt().
const AGE_ML_REF = [[0, 60], [1, 90], [2, 120], [3, 130], [4, 150], [6, 180], [9, 200], [12, 220], [18, 220], [24, 200]];
function refMlAtAge(ageMonths) {
  const a = Math.max(0, Math.min(24, ageMonths));
  let lo = AGE_ML_REF[0], hi = AGE_ML_REF[AGE_ML_REF.length - 1];
  for (let i = 0; i < AGE_ML_REF.length - 1; i++) { if (a >= AGE_ML_REF[i][0] && a <= AGE_ML_REF[i + 1][0]) { lo = AGE_ML_REF[i]; hi = AGE_ML_REF[i + 1]; break; } }
  const span = hi[0] - lo[0];
  const f = span > 0 ? (a - lo[0]) / span : 0;
  return lo[1] + (hi[1] - lo[1]) * f;
}

// Predicts the next feed's amount (ml). Primary signal is the household's own recent
// feeds — taking the median of just the last N_RECENT naturally tracks "drinks more as
// they grow" for free, since older/smaller feeds age out of that window on their own; no
// separate growth-trend model needed. The age-based reference table only fills in early
// on, before there's much of the baby's own data to trust — its influence fades out as
// feeds accumulate (matured by 30 feeds, roughly a week or so for most feeding schedules).
function predictNextAmount(events, babyBirthDate) {
  const feeds = events.filter(e => e.type === 'milk' && (e.amountMl || 0) > 0).slice().sort((a, b) => new Date(a.time) - new Date(b.time));
  const ownMedian = median(feeds.slice(-N_RECENT).map(e => e.amountMl));
  let refMl = null;
  if (babyBirthDate) refMl = refMlAtAge((new Date() - new Date(babyBirthDate)) / 86400000 / 30.4375);
  if (ownMedian == null) return refMl != null ? Math.round(refMl) : null;
  if (refMl == null) return Math.round(ownMedian);
  const ownWeight = Math.min(1, feeds.length / 30);
  return Math.round(ownWeight * ownMedian + (1 - ownWeight) * refMl);
}

// Retroactively reconstructs what predictNextFeed()/predictNextAmount() would have said
// right before each of TODAY's actual feeds, using only the events that existed at that
// moment — both are pure functions of "events so far", so no separate "mark a prediction
// now, check back later" step is needed; accuracy can be reconstructed after the fact for
// any feed that's already happened. Drives the prediction-vs-actual overlay on today's
// timeline (see App.togglePredictionOverlay / renderTodayTimeline).
function analyzeTodayPredictionAccuracy(events, alarmOffsetMinutes, babyBirthDate) {
  const now = new Date();
  const feeds = events.filter(e => e.type === 'milk').slice().sort((a, b) => new Date(a.time) - new Date(b.time));
  const todayFeeds = feeds.filter(f => dateKey(new Date(f.time)) === dateKey(now));
  return todayFeeds.map(f => {
    const fTime = new Date(f.time);
    const before = events.filter(e => new Date(e.time) < fTime);
    // Reconstruct as of fTime, not the real current moment — without this, "minutes since
    // the last feed" etc. inside predictNextFeed were measured against whenever someone
    // happened to check the overlay, not against when this feed actually happened, which
    // could force the wrong daypart bucket (usually 'night', the longest one) and produce
    // a bogus predicted time completely unrelated to what the app would have shown live.
    const pred = predictNextFeed(before, alarmOffsetMinutes, fTime);
    const predictedMl = predictNextAmount(before, babyBirthDate);
    const actualMl = f.amountMl || 0;
    if (pred.status !== 'ok') return { id: f.id, actualTime: fTime, actualMl, predictedTime: null, predictedMl, timeErrorMin: null, mlError: null };
    return {
      id: f.id, actualTime: fTime, actualMl, predictedTime: pred.nextTime, predictedMl,
      timeErrorMin: Math.round((fTime - pred.nextTime) / 60000),
      mlError: predictedMl != null ? actualMl - predictedMl : null,
    };
  });
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
