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
// CAVEAT: local data (localStorage['bt_data']) is NOT namespaced per family — this assumes
// each device only ever signs in as one family's members. If a shared/borrowed device ever
// signed into two different families' accounts, cached local records could get pushed to
// the wrong family on the next sign-in. Fine for "a couple of families, each on their own
// devices"; would need per-family local storage keys to be fully safe against that.
const FAMILIES = {
  default: ["cs90s203@gmail.com", "snowy5420@gmail.com", "lunamamahappy@gmail.com"],
  friendA: ["phoebe790322@gmail.com", "jumptoohigh@gmail.com"],
  friendB: ["sanan282000@gmail.com"],
};
function familyIdForEmail(email) {
  for (const id in FAMILIES) if (FAMILIES[id].includes(email)) return id;
  return null;
}

let currentFamilyId = null; // set once signed in, see familyIdForEmail()
function familyPath() { return `families/${currentFamilyId}`; }

let fbApp = null, fbAuth = null, fbDb = null;
let firebaseInitError = null;
let authStateKnown = false;
let unsubEvents = null, unsubGrowth = null, unsubSettings = null;

const Sync = {
  state: "idle", // idle | signing-in | syncing | done | fail | unauthorized
  message: "",
  user: null, // {email, displayName, photoURL} once signed in
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
      try { fbDb.enablePersistence({ synchronizeTabs: true }); } catch (e) { /* multiple tabs etc. — non-fatal, just no offline cache */ }

      fbAuth.getRedirectResult().catch((err) => {
        if (err.code !== "auth/no-auth-event") console.warn("getRedirectResult:", err.code);
      });

      fbAuth.onAuthStateChanged((user) => {
        authStateKnown = true;
        const famId = user ? familyIdForEmail(user.email) : null;
        if (user && !famId) {
          this._set("unauthorized", "此 Google 帳號未被授權使用");
          fbAuth.signOut();
          this.user = null;
          currentFamilyId = null;
          this._detachListeners();
          return;
        }
        currentFamilyId = famId;
        this.user = user ? { email: user.email, displayName: user.displayName, photoURL: user.photoURL } : null;
        if (user) {
          this._pushAllLocal();
          this._attachListeners();
          this._set("syncing");
        } else {
          currentFamilyId = null;
          this._detachListeners();
          this._set("idle");
        }
      });
    } catch (e) {
      firebaseInitError = e.message;
      this._set("fail", "Firebase 初始化失敗：" + e.message);
    }
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
    if (Store.data.settings) { batch.set(fbDb.doc(`${familyPath()}/settings/main`), Store.data.settings, { merge: true }); n++; }
    if (n === 0) return;
    batch.commit().catch((err) => console.error("initial catch-up push failed:", err));
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
      (snap) => { snap.docChanges().forEach((c) => Store.mergeRemote("events", { id: c.doc.id, ...c.doc.data() })); settled(); },
      (err) => this._onListenerError(err)
    );
    unsubGrowth = fbDb.collection(`${familyPath()}/growth`).onSnapshot(
      (snap) => { snap.docChanges().forEach((c) => Store.mergeRemote("growth", { id: c.doc.id, ...c.doc.data() })); settled(); },
      (err) => this._onListenerError(err)
    );
    unsubSettings = fbDb.doc(`${familyPath()}/settings/main`).onSnapshot(
      (doc) => { if (doc.exists) Store.mergeRemoteSettings(doc.data()); settled(); },
      (err) => this._onListenerError(err)
    );
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
  pushDoc(kind, doc) {
    if (!this.isSignedIn() || !fbDb) return;
    fbDb.doc(`${familyPath()}/${kind}/${doc.id}`).set(doc, { merge: true }).catch((err) => {
      console.error("cloud push failed:", err);
    });
  },
  pushSettings(settings) {
    if (!this.isSignedIn() || !fbDb) return;
    fbDb.doc(`${familyPath()}/settings/main`).set(settings, { merge: true }).catch((err) => {
      console.error("cloud push (settings) failed:", err);
    });
  },
};

Store._cloudPush = (kind, doc) => Sync.pushDoc(kind, doc);
Store._cloudPushSettings = (settings) => Sync.pushSettings(settings);
