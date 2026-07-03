// Central state + persistence layer.
// Sync boundary (see docs/data-model.md):
//   bt_data        -> synced via Firestore (events, growth, settings) — shared by all devices
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

  init() {
    try { this.data = JSON.parse(localStorage.getItem(DATA_KEY)) || defaultData(); }
    catch (e) { this.data = defaultData(); }
    // backfill any settings keys added after a user's first install
    this.data.settings = Object.assign(defaultData().settings, this.data.settings || {});
    this.data.events = this.data.events || [];
    this.data.growth = this.data.growth || [];
    try { this.caregiver = localStorage.getItem(CAREGIVER_KEY) || ''; } catch (e) { this.caregiver = ''; }
  },

  onChange(fn) { this.listeners.push(fn); },
  _emit() { this.listeners.forEach(fn => fn()); },

  persist() {
    try { localStorage.setItem(DATA_KEY, JSON.stringify(this.data)); } catch (e) {}
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

  setCaregiver(name) {
    this.caregiver = name;
    try { localStorage.setItem(CAREGIVER_KEY, name); } catch (e) {}
    this._emit();
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
    const arr = this.data[kind];
    const i = arr.findIndex((x) => x.id === doc.id);
    if (i === -1) { arr.push(doc); this.persist(); return; }
    if (new Date(doc.updatedAt || 0) >= new Date(arr[i].updatedAt || 0)) {
      arr[i] = doc;
      this.persist();
    }
  },
  mergeRemoteSettings(settings) {
    if ((settings.updatedAt || '') >= (this.data.settings.updatedAt || '')) {
      this.data.settings = Object.assign({}, this.data.settings, settings);
      this.persist();
    }
  },
};
