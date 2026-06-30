// GitHub Contents API sync: pull -> merge -> push -> retry on SHA conflict.
// See docs/sync.md for the full flow diagram and docs/backup.md for the backup policy.

const DATA_PATH = 'data.json';
const MAX_RETRIES = 3;
const BACKUP_RETENTION_DAYS = 30;

function b64encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}
function b64decode(str) {
  return decodeURIComponent(escape(atob(str)));
}

const Sync = {
  state: 'idle', // idle | syncing | done | fail
  message: '',
  listeners: [],
  onChange(fn) { this.listeners.push(fn); },
  _set(state, message) { this.state = state; this.message = message || ''; this.listeners.forEach(fn => fn()); },

  creds() {
    return { token: Store.local('gh_token') || '', repo: Store.local('gh_repo') || '' };
  },
  hasCreds() {
    const c = this.creds();
    return !!(c.token && c.repo && c.repo.includes('/'));
  },
  lastSync() { return Store.local('last_sync') || ''; },

  api(path) {
    const { repo } = this.creds();
    return `https://api.github.com/repos/${repo}/contents/${path}`;
  },
  headers() {
    const { token } = this.creds();
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  },

  async getFile(path) {
    const res = await fetch(this.api(path), { headers: this.headers() });
    if (res.status === 404) return { content: null, sha: null };
    if (!res.ok) throw new Error(`GitHub 讀取失敗 (${res.status})`);
    const json = await res.json();
    return { content: JSON.parse(b64decode(json.content)), sha: json.sha };
  },

  async putFile(path, obj, sha, message) {
    const body = {
      message,
      content: b64encode(JSON.stringify(obj, null, 2)),
    };
    if (sha) body.sha = sha;
    const res = await fetch(this.api(path), { method: 'PUT', headers: this.headers(), body: JSON.stringify(body) });
    if (res.status === 409 || res.status === 422) {
      const err = new Error('SHA_CONFLICT');
      err.code = 'SHA_CONFLICT';
      throw err;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`GitHub 寫入失敗 (${res.status}) ${txt}`);
    }
    return res.json();
  },

  // ---- merge: events/growth = union by id, newer updatedAt wins; settings = last-write-wins ----
  merge(local, remote) {
    if (!remote) return local;
    const mergeArr = (a = [], b = []) => {
      const byId = new Map();
      [...a, ...b].forEach(item => {
        const existing = byId.get(item.id);
        if (!existing || new Date(item.updatedAt || 0) >= new Date(existing.updatedAt || 0)) {
          byId.set(item.id, item);
        }
      });
      return Array.from(byId.values());
    };
    const settings = (!remote.settings || (local.settings.updatedAt || '') >= (remote.settings.updatedAt || ''))
      ? local.settings : remote.settings;
    return {
      events: mergeArr(local.events, remote.events),
      growth: mergeArr(local.growth, remote.growth),
      settings,
    };
  },

  // ---- daily backup snapshot ----
  async maybeBackup(mergedData) {
    const today = new Date().toISOString().slice(0, 10);
    if (Store.local('last_backup_date') === today) return;
    const path = `backups/data-${today}.json`;
    try {
      const existing = await this.getFile(path);
      if (!existing.content) {
        await this.putFile(path, mergedData, null, `Daily backup ${today}`);
      }
      Store.local('last_backup_date', today);
      await this.pruneBackups();
    } catch (e) {
      // backup failures shouldn't block the main sync
      console.warn('backup failed', e);
    }
  },

  // Keep last N daily backups + always keep the 1st-of-month ones (long-term history).
  async pruneBackups() {
    const res = await fetch(this.api('backups'), { headers: this.headers() });
    if (!res.ok) return;
    const list = await res.json();
    if (!Array.isArray(list)) return;
    const cutoff = Date.now() - BACKUP_RETENTION_DAYS * 86400000;
    for (const f of list) {
      const m = f.name.match(/^data-(\d{4}-\d{2}-\d{2})\.json$/);
      if (!m) continue;
      const d = new Date(m[1] + 'T00:00:00Z');
      const isFirstOfMonth = m[1].endsWith('-01');
      if (d.getTime() < cutoff && !isFirstOfMonth) {
        await fetch(this.api(`backups/${f.name}`), {
          method: 'DELETE', headers: this.headers(),
          body: JSON.stringify({ message: `Prune old backup ${m[1]}`, sha: f.sha }),
        }).catch(() => {});
      }
    }
  },

  // Full reconcile: pull -> merge -> push, retried on optimistic-lock conflicts.
  async sync() {
    if (this.state === 'syncing') return;
    if (!this.hasCreds()) { this._set('fail', '尚未設定 GitHub Token / Repo'); return; }
    this._set('syncing');
    try {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        const remote = await this.getFile(DATA_PATH);
        const merged = this.merge(Store.data, remote.content);
        try {
          await this.putFile(DATA_PATH, merged, remote.sha, `Sync ${new Date().toISOString()}`);
          Store.data = merged;
          Store.persist();
          await this.maybeBackup(merged);
          const now = new Date();
          const label = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
          Store.local('last_sync', label);
          this._set('done');
          setTimeout(() => { if (this.state === 'done') this._set('idle'); }, 2200);
          return;
        } catch (e) {
          if (e.code === 'SHA_CONFLICT') continue; // someone else pushed first — retry
          throw e;
        }
      }
      this._set('fail', '同步衝突過多，請稍後再試');
    } catch (e) {
      this._set('fail', e.message || '同步失敗，請檢查網路或 Token');
    }
    setTimeout(() => { if (this.state === 'fail') this._set('idle'); }, 3200);
  },

  // ---- manual restore from a backup snapshot (see docs/backup.md) ----
  async restoreFromBackup(dateStr) {
    const path = `backups/data-${dateStr}.json`;
    const { content } = await this.getFile(path);
    if (!content) throw new Error('找不到該日期的備份');
    Store.data = content;
    Store.persist();
    return content;
  },
};
