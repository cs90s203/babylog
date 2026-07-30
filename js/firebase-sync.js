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
          Store.bindFamily(null);
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
          Store.bindFamily(null);
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
    this._detachListeners();
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
    this._detachListeners();
    const rebuild = fbDb.disableNetwork()
      .then(() => fbDb.enableNetwork())
      .then(() => { this._attachListeners(); });
    if (rebuild && rebuild.catch) {
      rebuild.catch((err) => {
        console.error("forceResync network rebuild failed, falling back to reload:", err);
        location.reload();
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
    }).catch(() => ({ babyName: "", babyEmoji: "👶" }));
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

  // Push every locally-held record on sign-in, not just future ones. Without this, a
  // device that already had local data (recorded before this device ever signed in, or
  // while offline) would never surface that data to Firestore — the listeners below only
  // pull remote -> local, and Store._cloudPush only fires for *new* mutations going
  // forward. This is what made two devices "not see the same baby": each kept its own
  // pre-existing local history stuck on itself. Safe to re-run on every sign-in — it's
  // just a batch of merge:true writes, and updatedAt-based merge (see store.js) means
  // repeats are harmless no-ops once everything has converged.
  _pushAllLocal() {
    if (!fbDb || !Store.data) return;
    const batch = fbDb.batch();
    let n = 0;
    Store.data.events.forEach((ev) => { batch.set(fbDb.doc(`${familyPath()}/events/${ev.id}`), ev, { merge: true }); n++; });
    Store.data.growth.forEach((g) => { batch.set(fbDb.doc(`${familyPath()}/growth/${g.id}`), g, { merge: true }); n++; });
    // Only push settings that have actually been touched (updatedAt set) — otherwise
    // switching to a family this device hasn't synced down yet would push the untouched
    // defaultData() scaffolding (blank babyName etc.) and clobber that family's real
    // settings before the listener below even gets a chance to pull them down.
    if (Store.data.settings && Store.data.settings.updatedAt) { batch.set(fbDb.doc(`${familyPath()}/settings/main`), Store.data.settings, { merge: true }); n++; }
    if (n === 0) return;
    // Same visibility rule as pushDoc: if this catch-up push fails, this device is holding
    // records the cloud has never seen — that must be surfaced, not just logged.
    batch.commit().then(() => this._notePushSuccess()).catch((err) => this._notePushFailure(err));
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

    unsubEvents = fbDb.collection(`${familyPath()}/events`).onSnapshot(
      (snap) => { this._noteSnapshotSource(snap); Store.mergeRemoteBatch("events", snap.docChanges().map((c) => ({ id: c.doc.id, ...c.doc.data() }))); settled(); },
      (err) => this._onListenerError(err)
    );
    unsubGrowth = fbDb.collection(`${familyPath()}/growth`).onSnapshot(
      (snap) => { this._noteSnapshotSource(snap); Store.mergeRemoteBatch("growth", snap.docChanges().map((c) => ({ id: c.doc.id, ...c.doc.data() }))); settled(); },
      (err) => this._onListenerError(err)
    );
    unsubSettings = fbDb.doc(`${familyPath()}/settings/main`).onSnapshot(
      (doc) => { this._noteSnapshotSource(doc); if (doc.exists) Store.mergeRemoteSettings(doc.data()); settled(); },
      (err) => this._onListenerError(err)
    );
  },
  // With enablePersistence on, a wedged server connection doesn't raise an error — onSnapshot
  // just keeps serving the local IndexedDB cache, so the app looked perfectly healthy while
  // never seeing the other phone's records (see CHANGELOG 2.33.5). metadata.fromCache is the
  // only signal that distinguishes the two, so track it and let the UI say so rather than
  // claiming live sync.
  fromCacheOnly: false,
  _cacheWatchdog: null,
  // A server connection that's actually just slow clears fromCacheOnly within a couple of
  // seconds on its own once the round-trip completes — that's normal and expected, not
  // escalated. But if it STAYS cache-only, neither the automatic retry backoff
  // (_onListenerError) nor a manual detach/reattach (forceResync) can help, because neither
  // one touches whatever's actually wedged (observed on a real device that stayed
  // cache-only across multiple manual reconnect attempts and an app-version update — i.e.
  // something below the onSnapshot layer, most likely the IndexedDB persistence connection
  // itself, not the listener subscription). A full page reload is the one thing guaranteed
  // to rebuild that from zero, so escalate to it automatically rather than leaving the user
  // stuck on a button that looks like it should work but doesn't.
  // INCIDENT (see CHANGELOG 2.33.8): the auto-reload below fixes a wedged LOCAL persistence
  // layer, but if what's actually wrong is the network itself (a firewall/VPN/carrier
  // blocking Firestore's connection outright), a reload reruns straight into the same
  // stuck state — and did, every ~12s, forever. From the user's side that's indistinguishable
  // from "nothing happened", because nothing meaningful did. sessionStorage caps this to ONE
  // automatic reload per browser session; if it's still stuck afterward, stop reloading and
  // say so plainly instead of looping silently.
  networkLikelyBlocked: false,
  _reloadAttemptedKey: "bt_local_stuck_reload_tried",
  _armCacheWatchdog() {
    clearTimeout(this._cacheWatchdog);
    this._cacheWatchdog = setTimeout(() => {
      if (!this.fromCacheOnly) return;
      let alreadyTried = false;
      try { alreadyTried = sessionStorage.getItem(this._reloadAttemptedKey) === "1"; } catch (e) {}
      if (alreadyTried) {
        console.error("Stuck on offline cache even after an automatic reload — likely a network block, not looping again.");
        this.networkLikelyBlocked = true;
        this.listeners.forEach((fn) => fn());
        return;
      }
      try { sessionStorage.setItem(this._reloadAttemptedKey, "1"); } catch (e) {}
      console.error("Stuck on offline cache for 12s after reconnect attempt — forcing ONE reload.");
      if (this._onStuckOnCache) this._onStuckOnCache();
      setTimeout(() => location.reload(), 1500);
    }, 12000);
  },
  _onStuckOnCache: null, // set by app.js to toast before the auto-reload below fires
  _noteSnapshotSource(snap) {
    const cached = !!(snap && snap.metadata && snap.metadata.fromCache);
    if (cached === this.fromCacheOnly) return;
    this.fromCacheOnly = cached;
    if (cached) {
      this._armCacheWatchdog();
    } else {
      clearTimeout(this._cacheWatchdog);
      if (this.networkLikelyBlocked) { this.networkLikelyBlocked = false; try { sessionStorage.removeItem(this._reloadAttemptedKey); } catch (e) {} }
    }
    this.listeners.forEach((fn) => fn());
  },
  _detachListeners() {
    clearTimeout(this._retryTimer);
    if (unsubEvents) unsubEvents();
    if (unsubGrowth) unsubGrowth();
    if (unsubSettings) unsubSettings();
    unsubEvents = unsubGrowth = unsubSettings = null;
  },
  // Most listener errors are transient (a network blip, a brief permission-check hiccup
  // right after sign-in) — retrying with backoff recovers from those on its own instead of
  // sitting in a permanent "fail" state that looks like data stopped syncing. Only gives up
  // (and asks for a manual tap-to-retry, see renderSyncPill) after several attempts.
  _onListenerError(err) {
    console.error("Firestore listener error:", err);
    this._listenerRetryCount++;
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
  _notePushFailure(err) {
    this.pushFailures++;
    this.lastPushError = (err && (err.code || err.message)) || String(err);
    console.error("cloud push failed:", err);
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
  pushDoc(kind, doc) {
    if (!this.isSignedIn() || !fbDb) return;
    fbDb.doc(`${familyPath()}/${kind}/${doc.id}`).set(doc, { merge: true })
      .then(() => this._notePushSuccess())
      .catch((err) => this._notePushFailure(err));
  },
  pushSettings(settings) {
    if (!this.isSignedIn() || !fbDb) return;
    fbDb.doc(`${familyPath()}/settings/main`).set(settings, { merge: true })
      .then(() => this._notePushSuccess())
      .catch((err) => this._notePushFailure(err));
  },
};

Store._cloudPush = (kind, doc) => Sync.pushDoc(kind, doc);
Store._cloudPushSettings = (settings) => Sync.pushSettings(settings);
