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
  friendA: ["phoebe790322@gmail.com", "jumptoohigh@gmail.com", "lunamamahappy@gmail.com", "cs90s203@gmail.com", "snowy5420@gmail.com"],
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
          // INCIDENT (2026-08): a caregiver who genuinely belongs to more than one family
          // (e.g. a 月嫂 helping two households) got silently defaulted to whichever family
          // happens to be listed first in FAMILIES, on any device with no prior preference —
          // no indication which baby's data that even was. She kept using the app normally
          // (records save locally regardless), so nothing looked broken on her end, while the
          // family she actually meant to help never saw anything from her. Binding to the
          // wrong family isn't a guess this code should make silently — ask instead, labeled
          // by baby name/emoji (not the internal "default"/"friendA" ids), and only once per
          // device (this becomes tomorrow's "pref" the moment she answers).
          if (famIds.length > 1 && !(pref && famIds.includes(pref))) {
            currentFamilyId = null;
            this.familyId = null;
            this._set("choosing-family");
            return;
          }
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

  // Resolves the "choosing-family" pending state (see onAuthStateChanged) — the one-time
  // explicit pick for a multi-family account with no stored device preference yet. Once
  // chosen, bindFamily() persists it as this device's preference, so this never fires again
  // for the same account+device unless site data is cleared.
  chooseFamily(id) {
    if (this.state !== "choosing-family" || !this.availableFamilyIds.includes(id)) return;
    currentFamilyId = id;
    this.familyId = id;
    Store.bindFamily(id);
    this._pushAllLocal();
    this._attachListeners();
    this._set("syncing");
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
    const fid = currentFamilyId;
    // INCIDENT (2026-11): the "updatedAt > one global watermark" rule described above cannot
    // express "record A failed to push but the newer record B succeeded" — B's success moved
    // the watermark past A, so A looked already-synced forever and never reached the cloud (no
    // other family member ever saw it; if this phone's storage was later cleared it was gone
    // for good). Reproduced for real by tools/watermark-gap-test.html: a rejected push, and a
    // push silently skipped during the quota cooldown, are both followed by a successful push
    // of a newer record. Replaced with a per-record ledger (see _markPending): an entry is
    // added the moment a record is written and removed only when THAT version is confirmed
    // pushed, so a later success can never cover for an earlier failure.
    if (Store.local(this._pendingKey(fid)) === null) {
      // First run of the ledger on this device+family: adopt exactly what the old watermark
      // rule would have pushed, so an in-progress backlog isn't dropped by the upgrade.
      const wm = Store.local("catchup_push_wm_" + fid) || "";
      const seed = {};
      Store.data.events.forEach((e) => { if ((e.updatedAt || "") > wm) seed["events/" + e.id] = e.updatedAt || ""; });
      Store.data.growth.forEach((g) => { if ((g.updatedAt || "") > wm) seed["growth/" + g.id] = g.updatedAt || ""; });
      if (Store.data.settings && Store.data.settings.updatedAt && Store.data.settings.updatedAt > wm) seed["settings/main"] = Store.data.settings.updatedAt;
      this._writePending(fid, seed);
    }
    const pending = this._readPending(fid);
    const docs = [];
    const orphaned = [];
    Object.keys(pending).forEach((key) => {
      const slash = key.indexOf("/");
      const kind = key.slice(0, slash), id = key.slice(slash + 1);
      // Only push settings that have actually been touched (updatedAt set) — otherwise
      // switching to a family this device hasn't synced down yet would push the untouched
      // defaultData() scaffolding (blank babyName etc.) and clobber that family's real
      // settings before the listener below even gets a chance to pull them down.
      const doc = kind === "settings"
        ? (Store.data.settings && Store.data.settings.updatedAt ? Store.data.settings : null)
        : (Store.data[kind] || []).find((x) => x.id === id) || null;
      if (doc) docs.push({ kind, id, doc }); else orphaned.push([key, pending[key]]);
    });
    if (orphaned.length) this._clearPendingMany(fid, orphaned); // ledger entry whose record no longer exists locally -- nothing to push
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
        const included = [];
        chunk.forEach(({ kind, id, doc }) => {
          // One record Firestore refuses outright (e.g. an `undefined` field makes set() throw
          // synchronously) must not take the other 399 in its chunk down with it on every
          // retry -- skip it (it stays in the ledger and is reported) and push the rest.
          try {
            batch.set(fbDb.doc(`${familyPath()}/${kind}/${id}`), doc, { merge: true });
            included.push([kind + "/" + id, doc.updatedAt || ""]);
          } catch (e) { this._notePushFailure(e); }
        });
        if (included.length === 0) return;
        return batch.commit().then(() => {
          this._notePushSuccess();
          this._clearPendingMany(fid, included);
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
    // INCIDENT (2026-08-25): switchFamily/chooseFamily rebind Store.data to the new family
    // (Store.bindFamily) BEFORE this runs, but the Firestore SDK can still deliver one more
    // snapshot from the OLD family's listener after unsubscribe() has been called — the SDK
    // processes "stop listening" through its own internal async queue, so a snapshot that was
    // already in flight when the switch happened is not retroactively cancelled. That
    // straggler snapshot's callback used to run with no idea it belonged to a listener
    // generation that no longer matches the current family, merging the OLD family's growth/
    // events straight into the NEW family's Store.data (records are matched purely by id — see
    // Store._mergeOne — with no family field to catch the mismatch), and persist() then wrote
    // that contamination to the new family's own local cache. Reused the _resyncToken counter
    // _detachListeners() already bumps (previously only checked by forceResync's async tail)
    // as a generation guard here too: each callback below captures the token active on ITS
    // attach and refuses to merge if a later _detachListeners() has since moved it on.
    const myToken = this._resyncToken;
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
    let eventsReconciled = false, growthReconciled = false; // once per attach, on the first SERVER-confirmed snapshot -- see _reconcileWithCloud

    // includeMetadataChanges matters here: WITHOUT it, Firestore suppresses the snapshot
    // that fires when the server confirms the initial cache-served result with IDENTICAL
    // data — that confirmation is a metadata-only change (fromCache true→false, nothing in
    // the documents themselves). So on any quiet open (no new records arriving), the app
    // received exactly one snapshot — the cache one — and the "同步狀態確認中" pill sat
    // there forever with no second event to clear it, even though the connection was fine
    // (observed on a real device 2026-08: sync fully working both directions, pill never
    // turning green). With the option on, that confirmation is actually delivered and
    // _noteSnapshotSource sees fromCache=false within seconds of load. docChanges() called
    // with no arguments still returns only REAL data changes, so the merge/push paths see
    // exactly what they saw before, and metadata events are client-side state — no extra
    // Firestore reads billed.
    const META = { includeMetadataChanges: true };
    unsubEvents = fbDb.collection(`${familyPath()}/events`).onSnapshot(
      META,
      (snap) => {
        if (myToken !== this._resyncToken) return; // straggler from a listener generation that's since been superseded — see the note above
        this._noteSnapshotSource(snap);
        const changed = Store.mergeRemoteBatch("events", snap.docChanges().map((c) => ({ id: c.doc.id, ...c.doc.data() })));
        if (changed && eventsSeenFirst) this._noteLiveConnectionConfirmed();
        eventsSeenFirst = true;
        if (!eventsReconciled && !snap.metadata.fromCache) { eventsReconciled = true; this._reconcileWithCloud("events", snap); }
        settled();
      },
      (err) => this._onListenerError(err)
    );
    unsubGrowth = fbDb.collection(`${familyPath()}/growth`).onSnapshot(
      META,
      (snap) => {
        if (myToken !== this._resyncToken) return; // straggler from a listener generation that's since been superseded — see the note above
        this._noteSnapshotSource(snap);
        const changed = Store.mergeRemoteBatch("growth", snap.docChanges().map((c) => ({ id: c.doc.id, ...c.doc.data() })));
        if (changed && growthSeenFirst) this._noteLiveConnectionConfirmed();
        growthSeenFirst = true;
        if (!growthReconciled && !snap.metadata.fromCache) { growthReconciled = true; this._reconcileWithCloud("growth", snap); }
        settled();
      },
      (err) => this._onListenerError(err)
    );
    unsubSettings = fbDb.doc(`${familyPath()}/settings/main`).onSnapshot(
      META,
      (doc) => {
        if (myToken !== this._resyncToken) return; // straggler from a listener generation that's since been superseded — see the note above
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
  // ---- pending-push ledger: "key -> updatedAt of the version still owed to the cloud" ----
  // Stored per family under bt_local_pending_push_{familyId} as {"events/<id>": updatedAt, ...}.
  // Normally empty, so the catch-up push stays a 0-write no-op on ordinary established use.
  _pendingKey(fid) { return "pending_push_" + fid; },
  _pendingFid() { return currentFamilyId || Store._familyId || null; }, // sign-out clears currentFamilyId but Store stays bound -- records made while signed out still belong to that family
  _readPending(fid) {
    try { return JSON.parse(Store.local(this._pendingKey(fid)) || "{}") || {}; } catch (e) { return {}; }
  },
  _writePending(fid, obj) { Store.local(this._pendingKey(fid), JSON.stringify(obj)); },
  _markPending(fid, kind, doc) {
    if (!fid || !doc) return;
    const p = this._readPending(fid);
    p[kind + "/" + (kind === "settings" ? "main" : doc.id)] = doc.updatedAt || "";
    this._writePending(fid, p);
  },
  // entries: [[key, updatedAt], ...]. An entry is only removed if it still holds the version
  // that was just confirmed -- if the record was edited again meanwhile (newer updatedAt
  // re-marked it), that newer version is still owed and must stay.
  _clearPendingMany(fid, entries) {
    const p = this._readPending(fid);
    let changed = false;
    entries.forEach(([key, updatedAt]) => {
      if (key in p && p[key] === updatedAt) { delete p[key]; changed = true; }
    });
    if (changed) this._writePending(fid, p);
  },
  // After an individual push succeeds the connection is demonstrably healthy -- the right
  // moment to flush anything else still owed (e.g. a record that failed or was skipped during
  // the quota cooldown). At most once per 30s so a persistently-failing record can't turn
  // every later success into another failing write attempt.
  _flushTimer: null,
  _lastFlushAt: 0,
  _flushPendingSoon(fid) {
    if (this._flushTimer || !fid) return;
    if (Object.keys(this._readPending(fid)).length === 0) return; // the common case: nothing else owed
    const wait = Math.max(1500, 30000 - (Date.now() - this._lastFlushAt));
    this._flushTimer = setTimeout(() => {
      this._flushTimer = null;
      this._lastFlushAt = Date.now();
      this._pushAllLocal();
    }, wait);
  },
  // Single-family accounts only (a multi-family device's local cache could hold another
  // family's records from the pre-2.37.4 listener leak, and pushing those would spread them):
  // once the SERVER-confirmed snapshot of a collection arrives, any local record the cloud
  // doesn't have was never delivered -- stranded by the old watermark gap above -- so owe it.
  _reconcileWithCloud(kind, snap) {
    if (this.availableFamilyIds.length !== 1 || !currentFamilyId || !snap.docs) return;
    const fid = currentFamilyId;
    const inCloud = new Set(snap.docs.map((d) => d.id));
    const p = this._readPending(fid);
    let added = 0;
    (Store.data[kind] || []).forEach((doc) => {
      if (!inCloud.has(doc.id)) { p[kind + "/" + doc.id] = doc.updatedAt || ""; added++; }
    });
    if (!added) return;
    this._writePending(fid, p);
    this._pushAllLocal();
  },
  pushDoc(kind, doc) {
    const fid = this._pendingFid();
    this._markPending(fid, kind, doc); // BEFORE every early return below: skipped/failed/offline pushes must stay owed
    if (!this.isSignedIn() || !fbDb) return;
    if (this._inQuotaCooldown()) return; // a doomed attempt right now would just count as another failure; the record stays in the ledger and goes out once the cooldown clears
    try {
      fbDb.doc(`${familyPath()}/${kind}/${doc.id}`).set(doc, { merge: true })
        .then(() => { this._notePushSuccess(); this._clearPendingMany(fid, [[kind + "/" + doc.id, doc.updatedAt || ""]]); this._flushPendingSoon(fid); })
        .catch((err) => this._notePushFailure(err));
    } catch (err) { this._notePushFailure(err); } // set() throws synchronously on data Firestore rejects (e.g. an undefined field) -- used to escape into the caller
  },
  pushSettings(settings) {
    const fid = this._pendingFid();
    this._markPending(fid, "settings", settings);
    if (!this.isSignedIn() || !fbDb) return;
    if (this._inQuotaCooldown()) return;
    try {
      fbDb.doc(`${familyPath()}/settings/main`).set(settings, { merge: true })
        .then(() => { this._notePushSuccess(); this._clearPendingMany(fid, [["settings/main", settings.updatedAt || ""]]); this._flushPendingSoon(fid); })
        .catch((err) => this._notePushFailure(err));
    } catch (err) { this._notePushFailure(err); }
  },
};

Store._cloudPush = (kind, doc) => Sync.pushDoc(kind, doc);
Store._cloudPushSettings = (settings) => Sync.pushSettings(settings);
