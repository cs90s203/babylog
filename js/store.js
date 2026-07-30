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
const LEGACY_MIGRATED_KEY = LOCAL_PREFIX + 'legacy_migrated';
const FAMILY_ID_KEY = LOCAL_PREFIX + 'family_id';

function uid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
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

  init() {
    try { this._familyId = localStorage.getItem(FAMILY_ID_KEY) || null; } catch (e) { this._familyId = null; }
    this._loadFromDisk();
    try { this.caregiver = localStorage.getItem(CAREGIVER_KEY) || ''; } catch (e) { this.caregiver = ''; }
  },

  // Key this device's local cache is read from / written to. Staying on the single global
  // DATA_KEY when no family is known yet (or the account belongs to only one family) matches
  // the app's original behavior exactly — the per-family split only kicks in once bindFamily
  // has actually been called with a real family id (see below).
  _dataKey() { return this._familyId ? `${DATA_KEY}::${this._familyId}` : DATA_KEY; },
  _loadFromDisk() {
    let raw = null;
    try { raw = localStorage.getItem(this._dataKey()); } catch (e) {}
    if (!raw && this._familyId) {
      // No cache yet for this family on this device. If this is the very first family this
      // device has ever bound to, adopt the pre-existing global bt_data blob instead of
      // starting empty — that's what makes this change a no-op for every existing
      // single-family install (their history just gets renamed into a scoped key the first
      // time they sign in post-update). Any OTHER family this account later switches to
      // starts genuinely empty and re-syncs down from Firestore, same as a brand-new device
      // signing into an established family always has.
      let migrated = false;
      try { migrated = localStorage.getItem(LEGACY_MIGRATED_KEY) === '1'; } catch (e) {}
      if (!migrated) {
        try { raw = localStorage.getItem(DATA_KEY); } catch (e) {}
        try { localStorage.setItem(LEGACY_MIGRATED_KEY, '1'); } catch (e) {}
      }
    }
    try { this.data = raw ? JSON.parse(raw) : defaultData(); } catch (e) { this.data = defaultData(); }
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
    } catch (e) {}
    this._loadFromDisk();
    this.persist();
  },

  onChange(fn) { this.listeners.push(fn); },
  _emit() { this.listeners.forEach(fn => fn()); },

  persist() {
    try { localStorage.setItem(this._dataKey(), JSON.stringify(this.data)); } catch (e) {}
    this._emit();
  },

  // ---- local-only prefs ----
  local(key, val) {
    const k = LOCAL_PREFIX + key;
    if (val === undefined) {
      try { return localStorage.getItem(k); } catch (e) { return null; }
    }
    try { localStorage.setItem(k, val); } catch (e) {}
  },

  // Renaming "我是…" (e.g. fixing a typo) used to only affect *future* records — every
  // past event kept whatever name was baked into its `by` field at creation time (a
  // deliberate snapshot, see addEvent below), so the stats page's caregiver breakdown
  // would show the old and new names as two different people. Now a rename walks back
  // over every existing event tagged with the old name and relabels it too.
  setCaregiver(name) {
    const oldName = this.caregiver;
    this.caregiver = name;
    try { localStorage.setItem(CAREGIVER_KEY, name); } catch (e) {}
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
