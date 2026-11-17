// Runtime (hot-swappable) agent configuration such as the gateway toggle and gateway profiles.
// Persistence is pluggable: a store is { load(): object|null, save(values): void }.
//   Node.js:            fileStore(path) from '@axon-fleet/shared/node'
//   Cloudflare Workers: a Durable Object storage adapter (cloudflare/worker.js)
//   Tests:              no store (memory only)
import { nowIso } from './ids.js';

export class RuntimeConfig {
  constructor({ store = null, defaults = {}, logger } = {}) {
    this.store = store;
    this.defaults = { ...defaults };
    this.logger = logger;
    this.values = { ...defaults, updatedAt: nowIso(), updatedBy: 'defaults' };
    this.listeners = new Set();
    try {
      const saved = store?.load?.();
      if (saved) this.values = { ...this.values, ...saved };
    } catch (e) {
      logger?.warn('runtime_config_unreadable', { err: e.message });
    }
  }
  get(key) { return this.values[key]; }
  all() { return { ...this.values }; }
  set(patch, updatedBy = 'api') {
    this.values = { ...this.values, ...patch, updatedAt: nowIso(), updatedBy };
    this.#persist();
    for (const fn of this.listeners) fn(this.all());
    return this.all();
  }
  reset() {
    this.values = { ...this.defaults, updatedAt: nowIso(), updatedBy: 'reset' };
    this.#persist();
    for (const fn of this.listeners) fn(this.all());
    return this.all();
  }
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #persist() {
    try { this.store?.save?.(this.all()); } catch (e) { this.logger?.warn('runtime_config_persist_failed', { err: e.message }); }
  }
}
