// Firebase Auth (Google sign-in) + Firestore real-time sync.
// Auth flow (popup/redirect fallback, ITP detection) is adapted from a previously
// debugged implementation (jp_learning_mvp.html) rather than re-derived from scratch.
// See docs/sync.md for the data model and docs/architecture.md for the bigger picture.

const firebaseConfig = {
  apiKey: "AIzaSyCECSADEuScIxlzj_29bxYRGb_kKhOmjpw",
  authDomain: "babylogsync.firebaseapp.com",
  projectId: "babylogsync",
  storageBucket: "babylogsync.firebasestorage.app",
  messagingSenderId: "1006004961501",
  appId: "1:1006004961501:web:d2f9b7112f15c677f81b34",
};

// Server-side enforcement lives in Firestore Security Rules (see docs/sync.md) — this
// client-side map is just so the UI can show a clear "not authorized" message instead of
// a cryptic permission-denied error, and so the app knows which family's data to load.
// Each family is a fully separate Firestore path (families/{id}/...) with its own email
// list, so different families' data never mixes. Adding a new family (e.g. a friend's own
// baby) means adding one entry here AND mirroring the same email list in
// firestore.rules — that file is the actual security boundary, not this one (this object
// being visible in the client bundle isn't a leak in itself).
// An email can belong to more than one family (e.g. a grandparent helping with two
// grandkids) — familyIdsForEmail returns every match, and the signed-in account switches
// between them via Sync.switchFamily (see renderFamilySwitchButton in views.js). Store.js's
// bindFamily() keeps each family's local cache in its own storage key so switching never
// mixes two babies' data on one device — that used to be a hard assumption (single family
// per device); it no longer is.
const FAMILIES = {
  default: ["cs90s203@gmail.com", "snowy5420@gmail.com", "lunamamahappy@gmail.com"],
  friendA: ["phoebe790322@gmail.com", "jumptoohigh@gmail.com", "lunamamahappy@gmail.com", "cs90s203@gmail.com"],
  friendB: ["sanan282000@gmail.com"],
  friendC: ["jennifer90131@gmail.com", "s95321053@gmail.com"],
};
// Case-insensitive + trimmed on purpose: email addresses are not case-sensitive, but an
// exact-match lookup here treats "Snowy5420@gmail.com" and "snowy5420@gmail.com" as
// different people — and a miss doesn't just hide a family, it lands in the "unauthorized"
// branch below which force-signs-the-user-out, i.e. it looks exactly like "I can't log in".
// firestore.rules does its own exact match server-side, so it lists lowercase addresses and
// this must normalize to the same form.
function normEmail(e) { return String(e || "").trim().toLowerCase(); }
function familyIdsForEmail(email) {
  const target = normEmail(email);
  const ids = [];
  for (const id in FAMILIES) if (FAMILIES[id].some((e) => normEmail(e) === target)) ids.push(id);
  return ids;
}

let currentFamilyId = null; // set once signed in, see familyIdsForEmail()
function familyPath() { return `families/${currentFamilyId}`; }

let fbApp = null, fbAuth = null, fbDb = null;
let firebaseInitError = null;
let authStateKnown = false;
let unsubEvents = null, unsubGrowth = null, unsubSettings = null;

const Sync = {
  state: "idle", // idle | signing-in | syncing | done | fail | unauthorized
  message: "",
  user: null, // {email, displayName, photoURL} once signed in
  familyId: null, // mirrors currentFamilyId, so views.js/app.js don't need module-internal access
  availableFamilyIds: [], // every family this signed-in email belongs to (usually just one)
  lastRejectedEmail: "", // set when a sign-in is refused as unauthorized, so 診斷資訊 can show which address
  persistenceError: "", // set if enablePersistence()'s promise rejects — see init()
  _familyLabelCache: {}, // familyId -> {babyName, babyEmoji}, filled on demand by fetchFamilyLabel
  _resyncToken: 0, // bumped by every _detachListeners() call; lets forceResync's async tail detect it's stale (see forceResync)
  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  _set(state, message) { this.state = state; this.message = message || ""; this.listeners.forEach((fn) => fn()); },

  isSignedIn() { return !!this.user; },
  lastSync() { return Store.local("last_sync") || ""; },

  init() {
    try {
      if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(firebaseConfig);
      fbAuth = firebase.auth();
      fbDb = firebase.firestore();
      // INCIDENT (2026-08-02): confirmed via direct REST test on the stuck phone — plain HTTPS
      // requests to firestore.googleapis.com got a clean response, but the SDK's real-time
      // listeners stayed on "offline cache" forever. Plain REST and the SDK's default
      // real-time transport (WebChannel, a long-lived streaming connection) are different
      // enough that some networks — certain corporate/mobile-carrier proxies and firewalls in
      // particular — pass ordinary HTTPS through fine while quietly breaking the streaming
      // connection specifically. autoDetectLongPolling makes the SDK notice when that's
      // happening and fall back to plain HTTP long-polling (which behaves enough like normal
      // request/response traffic to get through those same middleboxes), with no effect at all
      // on networks where streaming already works. Must be set before any other Firestore call.
      fbDb.settings({ experimentalAutoDetectLongPolling: true, merge: true });
      // enablePersistence() returns a PROMISE — a bare try/catch around the call only ever
      // catches a synchronous throw, which is not how it reports "multiple tabs open" or
      // "unsupported browser": those arrive as a REJECTED promise. An unhandled rejection
      // here was completely invisible (no console entry a user could ever see, nothing in
      // diagnostics) — recorded so it can actually be seen instead of silently vanishing.
      fbDb.enablePersistence({ synchronizeTabs: true }).catch((e) => {
        Sync.persistenceError = (e && (e.code || e.message)) || String(e);
        console.error("enablePersistence failed:", e);
      });

      fbAuth.getRedirectResult().catch((err) => {
        if (err.code !== "auth/no-auth-event") console.warn("getRedirectResult:", err.code);
      });

      fbAuth.onAuthStateChanged((user) => {
        authStateKnown = true;
        const famIds = user ? familyIdsForEmail(user.email) : [];
        if (user && famIds.length === 0) {
          // Name the address that was rejected — "未被授權" with no detail is
          // indistinguishable from a broken login, and the actual string is what reveals a
          // typo/wrong-account/casing problem at a glance.
          this._set("unauthorized", `此 Google 帳號未被授權使用：${user.email}`);
          this.lastRejectedEmail = user.email || "";
          fbAuth.signOut();
          this.user = null;
          currentFamilyId = null; this.familyId = null; this.availableFamilyIds = [];
          // Deliberately NOT calling Store.bindFamily(null) here — see the sign-out branch
          // below for why.
          this._detachListeners();
          return;
        }
        this.availableFamilyIds = famIds;
        this.user = user ? { email: user.email, displayName: user.displayName, photoURL: user.photoURL } : null;
        if (user) {
          // Prefer whichever family this device last used (persisted by Store.bindFamily),
          // as long as this account still belongs to it — otherwise fall back to the first
          // match. For an account that has only ever belonged to one family, famIds[0] IS
          // that family, so this is a no-op for the common case.
          const pref = Store.local("family_id");
          currentFamilyId = (pref && famIds.includes(pref)) ? pref : famIds[0];
          this.familyId = currentFamilyId;
          Store.bindFamily(currentFamilyId);
          this._pushAllLocal();
          this._attachListeners();
          this._set("syncing");
        } else {
          currentFamilyId = null; this.familyId = null; this.availableFamilyIds = [];
          // INCIDENT: this used to call Store.bindFamily(null), which deletes this device's
          // persisted "last active family" (FAMILY_ID_KEY) on every sign-out. For an account
          // that belongs to more than one family, the NEXT sign-in then has no preference to
          // honor and silently falls back to familyIdsForEmail's first match — not
          // necessarily the family the user was actually using (e.g. switches from a friend's
          // baby back to "default" with no warning). Store simply keeps showing whichever
          // family it was last bound to; local-only usage while signed out already works
          // today (pushDoc/pushSettings both no-op when !isSignedIn()), so leaving the
          // binding alone is a pure fix — no behavior change for the common single-family
          // case, and it closes the multi-family one.
          this._detachListeners();
          this._set("idle");
        }
      });
    } catch (e) {
      firebaseInitError = e.message;
      this._set("fail", "Firebase 初始化失敗：" + e.message);
    }
  },

  // Move the signed-in account from its current family to another one it also belongs to
  // (see renderFamilySwitchButton/renderFamilySwitcher in views.js). No-op for an id the
  // account doesn't have access to, or the family it's already on.
  switchFamily(id) {
    if (!this.availableFamilyIds.includes(id) || id === currentFamilyId) return;
    this._detachListeners(); // also clears any stale fromCacheOnly flag — see _detachListeners
    // A push failure banner (or a cache-only warning) recorded against the PREVIOUS family
    // has nothing to do with this one's health — don't let it bleed into a freshly-switched,
    // possibly-perfectly-healthy family.
    this.pushFailures = 0;
    this.lastPushError = "";
    currentFamilyId = id;
    this.familyId = id;
    Store.bindFamily(id);
    this._pushAllLocal();
    this._attachListeners();
    this._set("syncing");
  },

  // Pull-to-refresh (see main.js). This used to be location.reload(); 2.31.1 replaced it with
  // a plain detach-then-reattach to skip the reload cost, which turned out to be a REGRESSION
  // (see CHANGELOG 2.33.5): with enablePersistence on, re-attaching a listener is happily
  // served from the local IndexedDB cache, so if the SDK's server connection is wedged (very
  // easy to hit on a phone that's been backgrounded//sleeping), reattaching re-reads the same
  // stale cache and still reports success — the exact "shows ✓ 即時同步中 but never receives
  // the other phone's records" symptom, with the previous escape hatch (a full reload
  // rebuilding the whole SDK) removed. Now the network layer itself is torn down and rebuilt
  // via disableNetwork/enableNetwork, which forces a real server round-trip, and any failure
  // falls back to the old reload so the user is never left with a refresh that quietly did
  // nothing.
  forceResync() {
    if (!this.isSignedIn() || !fbDb) { location.reload(); return; }
    this._set("syncing");
    this._detachListeners(); // bumps _resyncToken, invalidating any earlier in-flight forceResync tail (see below)
    const token = this._resyncToken;
    const rebuild = fbDb.disableNetwork()
      .then(() => fbDb.enableNetwork())
      .then(() => {
        // If sign-out (or another switchFamily/forceResync) happened during this async gap,
        // _detachListeners() has since bumped _resyncToken again — this attempt is stale and
        // must NOT reattach listeners for whatever family/session happens to be current now.
        if (token === this._resyncToken && this.isSignedIn()) this._attachListeners();
      });
    if (rebuild && rebuild.catch) {
      rebuild.catch((err) => {
        console.error("forceResync network rebuild failed, falling back to reload:", err);
        if (token === this._resyncToken) location.reload();
      });
    }
  },

  // Display label for a family in the switcher UI — reads that family's own settings/main
  // doc (allowed since the signed-in email is a member of every id in availableFamilyIds),
  // cached in-memory so re-opening the switcher doesn't re-fetch. Currently-active family's
  // label comes straight from the already-loaded Store.data, no network round-trip needed.
  fetchFamilyLabel(id) {
    if (this._familyLabelCache[id]) return Promise.resolve(this._familyLabelCache[id]);
    if (id === currentFamilyId) {
      const label = { babyName: Store.data.settings.babyName || "", babyEmoji: Store.data.settings.babyEmoji || "👶" };
      this._familyLabelCache[id] = label;
      return Promise.resolve(label);
    }
    return fbDb.doc(`families/${id}/settings/main`).get().then((doc) => {
      const d = doc.exists ? doc.data() : {};
      const label = { babyName: d.babyName || "", babyEmoji: d.babyEmoji || "👶" };
      this._familyLabelCache[id] = label;
      return label;
    }).catch((err) => { console.error("fetchFamilyLabel failed for", id, err); return { babyName: "", babyEmoji: "👶" }; });
  },

  signInWithGoogle() {
    if (!fbAuth) { this._set("fail", "Firebase 尚未載入，請重新整理後再試"); return; }
    this._set("signing-in");
    const provider = new firebase.auth.GoogleAuthProvider();
    fbAuth.signInWithPopup(provider).catch((err) => {
      if (err.code === "auth/popup-blocked") {
        fbAuth.signInWithRedirect(provider).catch((e) => this._set("fail", "登入失敗：" + (e.code || e.message)));
      } else if (err.code === "auth/popup-closed-by-user") {
        this._set("idle");
      } else {
        this._set("fail", "登入失敗：" + (err.code || err.message));
      }
    });
  },
  signOut() {
    if (fbAuth) fbAuth.signOut();
  },

  // Push locally-held records that haven't been confirmed pushed yet — covers a device that
  // had local data before it ever signed in, or that made edits while offline (Store._cloudPush
  // is a no-op then). Without this, that backlog would sit stuck on one device forever, since
  // the listeners below only pull remote -> local.
  //
  // INCIDENT (see CHANGELOG 2.33.9): this used to unconditionally re-push EVERY event/growth
  // record on EVERY sign-in — which happens on every single app load/reconnect, since Firebase
  // Auth persists the session. The old comment called that "safe" because merge:true repeats
  // are a harmless no-op for DATA correctness — true, but irrelevant to Firestore's write
  // quota: each .set() call is billed as a full write whether or not the content actually
  // changed. With ~1000 records and a day full of reconnects/reloads (each version bump, each
  // manual reconnect, each auto-reload), that alone was enough to burn through the entire
  // 20k/day Spark-plan write quota — confirmed via the Firebase console's usage graph (writes
  // at 98.8%). Once writes start being rejected for hitting quota, new records genuinely never
  // reach Firestore, which is indistinguishable from "sync is broken."
  //
  // Fixed with a per-family, per-device watermark: only push records whose updatedAt is newer
  // than the last successful catch-up push. On ordinary established use nothing has a newer
  // updatedAt (every real mutation already gets pushed individually via _cloudPush at the
  // moment it happens), so this becomes a 0-write no-op almost every time it runs — it only
  // does meaningful work when there's an actual backlog to catch up on.
  _pushAllLocalInFlight: false,
  _pushAllLocal() {
    if (!fbDb || !Store.data || !currentFamilyId) return;
    // Avoids duplicate concurrent catch-up pushes from overlapping reconnects IN THIS TAB
    // (e.g. a fast sign-in followed immediately by a manual forceResync). This does NOT
    // protect against a second browser tab/window racing the same account — enablePersistence
    // explicitly anticipates multiple tabs, so that's a real possibility, but the worst case is
    // wasted-but-idempotent duplicate writes (merge:true, last-updatedAt-wins), not a
    // correctness risk, and a full cross-tab mutex is disproportionate effort for that.
    if (this._pushAllLocalInFlight) return;
    if (this._inQuotaCooldown()) return; // already known-doomed until the cooldown clears — see _noteQuotaExhausted
    const watermarkKey = "catchup_push_wm_" + currentFamilyId;
    const watermark = Store.local(watermarkKey) || "";
    const isNew = (doc) => (doc.updatedAt || "") > watermark;
    const docs = [];
    Store.data.events.forEach((ev) => { if (isNew(ev)) docs.push({ kind: "events", id: ev.id, doc: ev }); });
    Store.data.growth.forEach((g) => { if (isNew(g)) docs.push({ kind: "growth", id: g.id, doc: g }); });
    // Only push settings that have actually been touched (updatedAt set) — otherwise
    // switching to a family this device hasn't synced down yet would push the untouched
    // defaultData() scaffolding (blank babyName etc.) and clobber that family's real
    // settings before the listener below even gets a chance to pull them down.
    if (Store.data.settings && Store.data.settings.updatedAt && isNew(Store.data.settings)) docs.push({ kind: "settings", id: "main", doc: Store.data.settings });
    if (docs.length === 0) return;

    // Cloud Firestore hard-caps one WriteBatch at 500 operations. This app already has ~1000
    // events some days (see CHANGELOG 2.33.9's own measurement), so an unchunked batch would
    // reject EVERY catch-up push outright — and since the watermark only advances on a
    // successful commit, it could never make progress past that point. Split into chunks
    // safely under the cap and commit sequentially, advancing the watermark after each chunk
    // that succeeds so a LATER chunk failing doesn't roll back progress already confirmed.
    const CHUNK_SIZE = 400;
    const chunks = [];
    for (let i = 0; i < docs.length; i += CHUNK_SIZE) chunks.push(docs.slice(i, i + CHUNK_SIZE));

    this._pushAllLocalInFlight = true;
    let chain = Promise.resolve();
    chunks.forEach((chunk) => {
      chain = chain.then(() => {
        const batch = fbDb.batch();
        let maxSeenInChunk = "";
        chunk.forEach(({ kind, id, doc }) => {
          batch.set(fbDb.doc(`${familyPath()}/${kind}/${id}`), doc, { merge: true });
          if ((doc.updatedAt || "") > maxSeenInChunk) maxSeenInChunk = doc.updatedAt;
        });
        return batch.commit().then(() => {
          this._notePushSuccess();
          const soFar = Store.local(watermarkKey) || "";
          if (maxSeenInChunk > soFar) Store.local(watermarkKey, maxSeenInChunk);
        });
      });
    });
    // Same visibility rule as pushDoc: if this catch-up push fails, this device is holding
    // records the cloud has never seen — that must be surfaced, not just logged.
    chain
      .catch((err) => this._notePushFailure(err))
      .then(() => { this._pushAllLocalInFlight = false; });
  },

  // ---- real-time listeners: remote change -> merge into Store.data -> re-render ----
  _listenerRetryCount: 0,
  _retryTimer: null,
  _attachListeners() {
    this._detachListeners();
    clearTimeout(this._retryTimer);
    let pending = 3;
    const settled = () => {
      pending--;
      if (pending <= 0) {
        this._listenerRetryCount = 0; // back to healthy — a future error starts backoff from scratch
        this._set("done");
        Store.local("last_sync", this._nowLabel());
      }
    };
    // Per-listener "have I already delivered my own first snapshot" tracking — deliberately
    // NOT keyed off this.state === "done", which needs ALL THREE listeners to have settled at
    // least once. A device stuck exactly the way this fix targets may never reach "done" at
    // all (that's the bug), which would make that gate permanently false and this whole fix a
    // no-op for the one case it exists for. Each listener only needs to know about itself.
    let eventsSeenFirst = false, growthSeenFirst = false, settingsSeenFirst = false;

    unsubEvents = fbDb.collection(`${familyPath()}/events`).onSnapshot(
      (snap) => {
        this._noteSnapshotSource(snap);
        const changed = Store.mergeRemoteBatch("events", snap.docChanges().map((c) => ({ id: c.doc.id, ...c.doc.data() })));
        if (changed && eventsSeenFirst) this._noteLiveConnectionConfirmed();
        eventsSeenFirst = true;
        settled();
      },
      (err) => this._onListenerError(err)
    );
    unsubGrowth = fbDb.collection(`${familyPath()}/growth`).onSnapshot(
      (snap) => {
        this._noteSnapshotSource(snap);
        const changed = Store.mergeRemoteBatch("growth", snap.docChanges().map((c) => ({ id: c.doc.id, ...c.doc.data() })));
        if (changed && growthSeenFirst) this._noteLiveConnectionConfirmed();
        growthSeenFirst = true;
        settled();
      },
      (err) => this._onListenerError(err)
    );
    unsubSettings = fbDb.doc(`${familyPath()}/settings/main`).onSnapshot(
      (doc) => {
        this._noteSnapshotSource(doc);
        const changed = doc.exists && Store.mergeRemoteSettings(doc.data());
        if (changed && settingsSeenFirst) this._noteLiveConnectionConfirmed();
        settingsSeenFirst = true;
        settled();
      },
      (err) => this._onListenerError(err)
    );
  },
  // With enablePersistence on, a wedged server connection doesn't raise an error — onSnapshot
  // just keeps serving the local IndexedDB cache, so the app can look healthy while never
  // seeing another phone's records (see CHANGELOG 2.33.5). metadata.fromCache is the only
  // signal available for this, so it's still tracked and shown — but NOT trusted enough to
  // drive an automatic reload anymore.
  // INCIDENT (2026-08-02): metadata.fromCache is documented to sometimes stay stuck `true`
  // for extended periods even while a listener is genuinely receiving live server updates
  // (see firebase-js-sdk#8343) — confirmed on a real device where two phones were actively
  // exchanging new records in real time while this device's own diagnostics kept insisting it
  // was offline. The auto-reload-after-12s escalation this used to have (CHANGELOG 2.33.7)
  // was built on the assumption that a stuck flag reliably means a stuck connection; it
  // doesn't, so an unreliable signal was driving a real action (a forced reload, burning a
  // full re-read of everything) on a false alarm. Now this only ever updates the passive
  // diagnostics display and the manual "reconnect" button stays available — no auto-reload,
  // no separate "still stuck after reloading" escalation state.
  fromCacheOnly: false,
  _noteSnapshotSource(snap) {
    const cached = !!(snap && snap.metadata && snap.metadata.fromCache);
    if (cached === this.fromCacheOnly) return;
    this.fromCacheOnly = cached;
    this.listeners.forEach((fn) => fn());
  },
  // A snapshot that lands AFTER the initial settle (i.e. not just first-load cache hydration)
  // and actually contains new/changed data — data this device didn't already have — could
  // only have arrived via a real live update; no stale local cache spontaneously produces
  // someone else's new record on its own. Trust that observed behavior over what the
  // fromCache metadata flag claims (see the INCIDENT note above _noteSnapshotSource).
  _noteLiveConnectionConfirmed() {
    if (!this.fromCacheOnly) return;
    this.fromCacheOnly = false;
    this.listeners.forEach((fn) => fn());
  },
  _detachListeners() {
    clearTimeout(this._retryTimer);
    this._resyncToken++; // invalidate any in-flight forceResync tail from a previous cycle (see forceResync)
    if (this.fromCacheOnly) { this.fromCacheOnly = false; this.listeners.forEach((fn) => fn()); }
    if (unsubEvents) unsubEvents();
    if (unsubGrowth) unsubGrowth();
    if (unsubSettings) unsubSettings();
    unsubEvents = unsubGrowth = unsubSettings = null;
  },
  // Most listener errors are transient (a network blip, a brief permission-check hiccup
  // right after sign-in) — retrying with backoff recovers from those on its own instead of
  // sitting in a permanent "fail" state that looks like data stopped syncing. Only gives up
  // (and asks for a manual tap-to-retry, see renderSyncPill) after several attempts.
  _lastListenerErrorAt: 0,
  _onListenerError(err) {
    console.error("Firestore listener error:", err);
    // The events/growth/settings listeners all share one underlying connection, so a single
    // disruption trips all three error callbacks in quick succession — without this window,
    // that counted as 3 failures instead of 1, escalating the backoff (and reaching the
    // give-up threshold) about 3x faster than the "after several attempts" comment intends.
    const now = Date.now();
    if (now - this._lastListenerErrorAt > 800) this._listenerRetryCount++;
    this._lastListenerErrorAt = now;
    if (this._listenerRetryCount > 5) {
      this._set("fail", "同步發生錯誤（已自動重試多次）：" + err.message);
      return;
    }
    this._set("syncing", `連線不穩，重新連線中…(${this._listenerRetryCount})`);
    const delay = Math.min(30000, 1000 * Math.pow(2, this._listenerRetryCount));
    clearTimeout(this._retryTimer);
    this._retryTimer = setTimeout(() => { if (this.isSignedIn()) this._attachListeners(); }, delay);
  },
  _nowLabel() {
    const d = new Date();
    return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  },

  // ---- local -> cloud pushes (wired up as Store._cloudPush, see store.js) ----
  // INCIDENT (see CHANGELOG 2.33.4): push failures used to be swallowed into console.error
  // only. A device whose pushes were silently failing kept saving records to localStorage
  // alone, with the UI still showing a healthy "✓ 即時同步中" — so "these records never
  // reached the other phone" went unnoticed for hours, and when a later reload read from a
  // different storage key, that batch of cloud-less records was simply gone. Every push
  // failure is now counted and surfaced (see renderSyncPill / _onPushError), so
  // "saved locally but NOT in the cloud" can never again look identical to a healthy sync.
  pushFailures: 0,
  lastPushError: "",
  _onPushError: null, // set by app.js to raise a toast the first time this happens
  // INCIDENT (2026-07-31): the Spark plan's free daily write quota is a once-a-day budget, not
  // a retry-friendly rate limit — once it's exhausted, EVERY write (batched or individual)
  // fails with "resource-exhausted" until the next daily reset. Before this, a failed commit
  // just meant the watermark didn't advance, so the very next refresh re-attempted the exact
  // same backlog chunk, failed the exact same way, and did that again on every single
  // subsequent refresh — measured at ~400+ wasted write attempts per refresh, repeating for as
  // long as the app kept getting reloaded, which is indistinguishable from (and was mistaken
  // for) a fresh quota-exhausting bug each time. A quota-specific failure now arms a cooldown
  // so the app stops hammering a door it already knows is locked, instead of just retrying
  // faster/harder.
  _quotaCooldownKeyFor(familyId) { return "quota_cooldown_" + (familyId || "none"); },
  _inQuotaCooldown() {
    if (!currentFamilyId) return false;
    const until = Number(Store.local(this._quotaCooldownKeyFor(currentFamilyId)) || 0);
    return until > Date.now();
  },
  _noteQuotaExhausted() {
    if (!currentFamilyId) return;
    const COOLDOWN_MS = 4 * 60 * 60 * 1000; // a few hours is plenty to stop refresh-triggered thrashing without needing to predict the exact Pacific-time daily reset moment
    Store.local(this._quotaCooldownKeyFor(currentFamilyId), String(Date.now() + COOLDOWN_MS));
  },
  _notePushFailure(err) {
    this.pushFailures++;
    this.lastPushError = (err && (err.code || err.message)) || String(err);
    console.error("cloud push failed:", err);
    if (err && err.code === "resource-exhausted") this._noteQuotaExhausted();
    if (this.pushFailures === 1 && this._onPushError) this._onPushError(err);
    this.listeners.forEach((fn) => fn()); // refresh the sync pill so the warning shows up
  },
  // A push that succeeds after earlier failures means the connection recovered — clear the
  // warning rather than leaving a stale "some records may not be in the cloud" banner up.
  _notePushSuccess() {
    if (this.pushFailures === 0) return;
    this.pushFailures = 0;
    this.lastPushError = "";
    this.listeners.forEach((fn) => fn());
  },
  // _pushAllLocal's watermark otherwise only advances from its OWN batch commits, never from
  // these everyday individual pushes — so every record that's already been successfully
  // synced this way would still look "new" (updatedAt > watermark) to the next catch-up push
  // and get needlessly resent. Nudging the watermark forward here too means the catch-up
  // backlog stays bounded to "since the last individual push", not "since the last catch-up".
  _advanceWatermark(updatedAt) {
    if (!updatedAt || !currentFamilyId) return;
    const key = "catchup_push_wm_" + currentFamilyId;
    const cur = Store.local(key) || "";
    if (updatedAt > cur) Store.local(key, updatedAt);
  },
  pushDoc(kind, doc) {
    if (!this.isSignedIn() || !fbDb) return;
    if (this._inQuotaCooldown()) return; // a doomed attempt right now would just count as another failure; the record stays local and goes out once the cooldown clears (via the watermark catch-up)
    fbDb.doc(`${familyPath()}/${kind}/${doc.id}`).set(doc, { merge: true })
      .then(() => { this._notePushSuccess(); this._advanceWatermark(doc.updatedAt); })
      .catch((err) => this._notePushFailure(err));
  },
  pushSettings(settings) {
    if (!this.isSignedIn() || !fbDb) return;
    if (this._inQuotaCooldown()) return;
    fbDb.doc(`${familyPath()}/settings/main`).set(settings, { merge: true })
      .then(() => { this._notePushSuccess(); this._advanceWatermark(settings.updatedAt); })
      .catch((err) => this._notePushFailure(err));
  },
};

Store._cloudPush = (kind, doc) => Sync.pushDoc(kind, doc);
Store._cloudPushSettings = (settings) => Sync.pushSettings(settings);
