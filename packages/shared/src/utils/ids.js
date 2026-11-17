import crypto from 'node:crypto';

export const newId = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
export const nowIso = () => new Date().toISOString();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const clone = (x) => (x === undefined ? x : structuredClone(x));

/** Bounded newest-first list used for logs, histories and audit trails. */
export class RingBuffer {
  constructor(max = 500) { this.max = max; this.items = []; }
  push(item) {
    this.items.unshift(item);
    if (this.items.length > this.max) this.items.length = this.max;
    return item;
  }
  list(limit) { return limit ? this.items.slice(0, limit) : [...this.items]; }
  get size() { return this.items.length; }
  clear() { this.items = []; }
}
