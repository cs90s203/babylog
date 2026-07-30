// Central state + persistence layer.
// Sync boundary (see docs/data-model.md):
//   bt_data        -> synced via Firestore (events, growth, settings) — shared by all devices
//                     of ONE family; once an account belongs to more than one family (see
//                     bindFamily below), each family gets its own bt_data::{familyId} key so
//                     switching babies on one device never mixes their data.
//   bt_caregiver   -> THIS DEVICE ONLY, marks `by` on new records, never synced
//   everything else prefixed bt_local_ -> device-only preferences
//
// Local mutations call Store._cloudPush(kind, doc) (wired to Sync.pushDoc in
// firebase-sync.js, a no-op until signed in) to fan out to Firestore. Remote changes
// come back through Store.mergeRemote()/mergeRemoteSettings(), called from the
// Firestore onSnapshot listeners — those write straight into Store.data and persist()
// WITHOUT going through _cloudPush again, so applying a remote change can never loop
// back into another write.

const DATA_KEY = 'bt_data';
const CAREGIVER_KEY = 'bt_caregiver';
const LOCAL_PREFIX = 'bt_local_';
const FAMILY_ID_KEY = LOCAL_PREFIX + 'family_id';
const LEGACY_OWNER_KEY = LOCAL_PREFIX + 'legacy_owner'; // which family the pre-multi-family bt_data belongs to

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Used by _loadFromDisk's legacy-migration fallback to decide whether a data blob is
// "real" or just an empty shell — see the incident note there.
function isEmptyDataBlob(raw) {
  if (!raw) return true;
  try {
    const d = JSON.parse(raw);
    const hasEvents = Array.isArray(d.events) && d.events.length > 0;
    const hasGrowth = Array.isArray(d.growth) && d.growth.length > 0;
    const hasBabyName = !!(d.settings && d.settings.babyName);
    return !hasEvents && !hasGrowth && !hasBabyName;
  } catch (e) { return true; }
}

function defaultData() {
  return {
    events: [],
    growth: [],
    settings: {
      babyName: '',
      babyBirth: '',
      babySex: '',
      babyEmoji: '👶',
      babyPhoto: '', // compressed base64 JPEG thumbnail; takes precedence over babyEmoji when set
      duration: {
        milk: { mode: 'end', minutes: 15 },
        poop: { mode: 'end', minutes: 15 },
        pee: { mode: 'end', minutes: 15 },
      },
      defaultMilk: { breast: 120, formula: 0 },
      alarmOffsetMinutes: 0,
    },
  };
}

const Store = {
  data: null,
  caregiver: '',
  listeners: [],
  _cloudPush: null, // set by firebase-sync.js: function(kind, doc)
  _cloudPushSettings: null, // function(settings)
  _familyId: null, // null = not signed in / single-family account, else which family's data is loaded
  _onPersistError: null, // set by app.js: function(err, context) -- a localStorage read/write failed
  _onDataCorrupted: null, // set by app.js: function(context) -- stored JSON couldn't be parsed and was reset

  // Every localStorage try/catch in this file used to swallow its error with an empty catch
  // body -- each one individually looked harmless ("just fall back to a default"), but that's
  // exactly the pattern that turned a real storage problem into what looked like catastrophic,
  // unexplained data loss in three separate incidents this week. Every read/write failure now
  // funnels through here so it's at least in the console, and reaches the user via the same
  // toast Store.persist() already used for its own failures.
  _reportStorageError(context, err) {
    console.error('Store storage error (' + context + '):', err);
    if (this._onPersistError) this._onPersistError(err, context);
  },

  init() {
    try { this._familyId = localStorage.getItem(FAMILY_ID_KEY) || null; }
    catch (e) { this._familyId = null; this._reportStorageError('init:read family id', e); }
    this._loadFromDisk();
    try { this.caregiver = localStorage.getItem(CAREGIVER_KEY) || ''; }
    catch (e) { this.caregiver = ''; this._reportStorageError('init:read caregiver', e); }
  },

  // Key this device's local cache is read from / written to. Staying on the single global
  // DATA_KEY when no family is known yet (or the account belongs to only one family) matches
  // the app's original behavior exactly — the per-family split only kicks in once bindFamily
  // has actually been called with a real family id (see below).
  _dataKey() { return this._familyId ? `${DATA_KEY}::${this._familyId}` : DATA_KEY; },
  // INCIDENT (see CHANGELOG): an earlier version of this migration marked itself "done" via
  // a separate flag as soon as it *read* the legacy blob, before confirming the scoped-key
  // write actually succeeded. If that write failed (e.g. localStorage quota exceeded — for a
  // moment during migration both the legacy AND scoped copies exist at once, roughly
  // doubling this app's storage footprint), the flag was already set, so every future load
  // trusted the now-permanently-empty scoped key and never looked at legacy again — the
  // real data was still sitting right there in localStorage, just never read. Fixed by (1)
  // judging "already migrated" from the scoped key's actual CONTENT instead of a separate
  // flag that can fall out of sync with reality, and self-healing any device already stuck
  // in that broken state, and (2) only deleting the legacy copy once the new copy is
  // confirmed persisted (see bindFamily below), never before.
  // The legacy blob predates multi-family and therefore belongs to exactly ONE family: the
  // first one this device ever bound to. Adopting it for any other family would copy one
  // baby's history into a different baby's storage — so record the owner on first adoption
  // and refuse to hand it to anyone else afterwards.
  _pendingLegacyMigration: false,
  _loadFromDisk() {
    let raw = null;
    try { raw = localStorage.getItem(this._dataKey()); }
    catch (e) { this._reportStorageError('loadFromDisk:read ' + this._dataKey(), e); }
    this._pendingLegacyMigration = false;
    if (this._familyId && isEmptyDataBlob(raw)) {
      let owner = null;
      try { owner = localStorage.getItem(LEGACY_OWNER_KEY); }
      catch (e) { this._reportStorageError('loadFromDisk:read legacy owner', e); }
      if (!owner || owner === this._familyId) {
        let legacyRaw = null;
        try { legacyRaw = localStorage.getItem(DATA_KEY); }
        catch (e) { this._reportStorageError('loadFromDisk:read legacy blob', e); }
        if (!isEmptyDataBlob(legacyRaw)) {
          raw = legacyRaw;
          this._pendingLegacyMigration = true;
          if (!owner) {
            try { localStorage.setItem(LEGACY_OWNER_KEY, this._familyId); }
            catch (e) { this._reportStorageError('loadFromDisk:write legacy owner', e); }
          }
        }
      }
    }
    try {
      this.data = raw ? JSON.parse(raw) : defaultData();
    } catch (e) {
      this.data = defaultData();
      // Only a real corruption if there was actually something to parse -- a missing/empty
      // key is a normal first run, not data loss, and shouldn't alarm anyone.
      if (raw) {
        console.error('Store: stored data was corrupted and has been reset:', e);
        if (this._onDataCorrupted) this._onDataCorrupted(this._dataKey());
      }
    }
    // backfill any settings keys added after a user's first install
    this.data.settings = Object.assign(defaultData().settings, this.data.settings || {});
    this.data.events = this.data.events || [];
    this.data.growth = this.data.growth || [];
  },
  // Called by Sync once it knows which family (if any) the signed-in account is using —
  // re-points Store.data at that family's own local cache so switching between two babies on
  // one device never mixes their data. A no-op if already bound to this family.
  bindFamily(familyId) {
    if (this._familyId === familyId) return;
    this._familyId = familyId;
    try {
      if (familyId) localStorage.setItem(FAMILY_ID_KEY, familyId);
      else localStorage.removeItem(FAMILY_ID_KEY);
    } catch (e) { this._reportStorageError('bindFamily:write family id', e); }
    this._loadFromDisk();
    const ok = this.persist();
    // Only reclaim the legacy key once its content is confirmed safely duplicated under the
    // new scoped key — if persist() failed, leave it untouched so the next load retries.
    if (this._pendingLegacyMigration && ok) {
      try { localStorage.removeItem(DATA_KEY); }
      catch (e) { this._reportStorageError('bindFamily:remove legacy blob', e); }
    }
    this._pendingLegacyMigration = false;
  },

  onChange(fn) { this.listeners.push(fn); },
  _emit() { this.listeners.forEach(fn => fn()); },

  persist() {
    try {
      localStorage.setItem(this._dataKey(), JSON.stringify(this.data));
      this._emit();
      return true;
    } catch (e) {
      this._reportStorageError('persist:write ' + this._dataKey(), e);
      this._emit();
      return false;
    }
  },

  // ---- local-only prefs ----
  local(key, val) {
    const k = LOCAL_PREFIX + key;
    if (val === undefined) {
      try { return localStorage.getItem(k); }
      catch (e) { this._reportStorageError('local:read ' + key, e); return null; }
    }
    try { localStorage.setItem(k, val); }
    catch (e) { this._reportStorageError('local:write ' + key, e); }
  },

  // Renaming "我是…" (e.g. fixing a typo) used to only affect *future* records — every
  // past event kept whatever name was baked into its `by` field at creation time (a
  // deliberate snapshot, see addEvent below), so the stats page's caregiver breakdown
  // would show the old and new names as two different people. Now a rename walks back
  // over every existing event tagged with the old name and relabels it too.
  setCaregiver(name) {
    const oldName = this.caregiver;
    this.caregiver = name;
    try { localStorage.setItem(CAREGIVER_KEY, name); }
    catch (e) { this._reportStorageError('setCaregiver:write', e); }
    if (oldName && oldName !== name) this._renameCaregiverInEvents(oldName, name);
    else this._emit();
  },
  _renameCaregiverInEvents(oldName, newName) {
    const now = new Date().toISOString();
    let changed = false;
    this.data.events.forEach(ev => {
      if (!ev.deleted && ev.by === oldName) {
        ev.by = newName;
        ev.updatedAt = now;
        changed = true;
        if (this._cloudPush) this._cloudPush('events', ev);
      }
    });
    if (changed) this.persist(); else this._emit();
  },

  // ---- events (milk/poop/pee) ----
  // Records carry updatedAt + a `deleted` tombstone (rather than array splice) so that
  // edits/deletes survive merges with a remote copy that doesn't know about them yet.
  // See docs/sync.md for the merge algorithm.
  addEvent(type, time, extra) {
    const now = new Date().toISOString();
    const ev = Object.assign({
      id: uid(), type, time: time.toISOString(), by: this.caregiver || '未命名',
      updatedAt: now, deleted: false,
    }, extra || {});
    this.data.events.push(ev);
    this.persist();
    if (this._cloudPush) this._cloudPush('events', ev);
    return ev;
  },
  updateEvent(id, patch) {
    const i = this.data.events.findIndex(e => e.id === id);
    if (i === -1) return;
    this.data.events[i] = Object.assign({}, this.data.events[i], patch, { updatedAt: new Date().toISOString() });
    this.persist();
    if (this._cloudPush) this._cloudPush('events', this.data.events[i]);
  },
  deleteEvent(id) {
    this.updateEvent(id, { deleted: true });
  },
  liveEvents() {
    return this.data.events.filter(e => !e.deleted);
  },

  // ---- growth ----
  addGrowth(entry) {
    const now = new Date().toISOString();
    const g = Object.assign({ id: uid(), updatedAt: now, deleted: false }, entry);
    this.data.growth.push(g);
    this.persist();
    if (this._cloudPush) this._cloudPush('growth', g);
    return g;
  },
  updateGrowth(id, patch) {
    const i = this.data.growth.findIndex(g => g.id === id);
    if (i === -1) return;
    this.data.growth[i] = Object.assign({}, this.data.growth[i], patch, { updatedAt: new Date().toISOString() });
    this.persist();
    if (this._cloudPush) this._cloudPush('growth', this.data.growth[i]);
  },
  deleteGrowth(id) {
    const i = this.data.growth.findIndex(g => g.id === id);
    if (i === -1) return;
    this.data.growth[i] = Object.assign({}, this.data.growth[i], { deleted: true, updatedAt: new Date().toISOString() });
    this.persist();
    if (this._cloudPush) this._cloudPush('growth', this.data.growth[i]);
  },
  liveGrowth() {
    return this.data.growth.filter(g => !g.deleted);
  },

  // ---- settings (last-write-wins via updatedAt) ----
  updateSettings(patch) {
    this.data.settings = Object.assign({}, this.data.settings, patch, { updatedAt: new Date().toISOString() });
    this.persist();
    if (this._cloudPushSettings) this._cloudPushSettings(this.data.settings);
  },
  updateDuration(type, patch) {
    this.data.settings.duration[type] = Object.assign({}, this.data.settings.duration[type], patch);
    this.updateSettings({ duration: this.data.settings.duration });
  },

  // ---- remote -> local merge (called from Firestore onSnapshot listeners only;
  //      never call _cloudPush here, or every device would re-broadcast every
  //      change it receives right back at Firestore in an infinite loop) ----
  mergeRemote(kind, doc) {
    if (this._mergeOne(kind, doc)) this.persist();
  },
  // Same merge logic as mergeRemote, but for a whole batch of docs from one Firestore
  // snapshot (e.g. the initial onSnapshot fire, which delivers every existing document
  // as an "added" change). Merging each doc in-memory and persisting/re-rendering once
  // at the end — instead of once per doc — avoids O(n) full-data JSON.stringify writes
  // and full-app re-renders for what's really a single logical update. With enough
  // history this was the "sign-in/sync feels slow" cause: n docs meant n synchronous
  // localStorage writes of the *entire* dataset plus n full re-renders in one tick.
  mergeRemoteBatch(kind, docs) {
    let changed = false;
    docs.forEach((doc) => { if (this._mergeOne(kind, doc)) changed = true; });
    if (changed) this.persist();
  },
  _mergeOne(kind, doc) {
    const arr = this.data[kind];
    const i = arr.findIndex((x) => x.id === doc.id);
    if (i === -1) { arr.push(doc); return true; }
    if (new Date(doc.updatedAt || 0) >= new Date(arr[i].updatedAt || 0)) {
      arr[i] = doc;
      return true;
    }
    return false;
  },
  mergeRemoteSettings(settings) {
    if ((settings.updatedAt || '') >= (this.data.settings.updatedAt || '')) {
      this.data.settings = Object.assign({}, this.data.settings, settings);
      this.persist();
    }
  },
};
