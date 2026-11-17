// Append-only (bounded) audit log. Plug a sink (file, SIEM, OTLP) in via the constructor.
import { newId, nowIso, RingBuffer } from '../utils/ids.js';

export class AuditLog {
  constructor({ max = 1000, sink = null } = {}) {
    this.buffer = new RingBuffer(max);
    this.sink = sink;
  }
  record(event) {
    const entry = { id: newId('aud'), timestamp: nowIso(), ...event };
    this.buffer.push(entry);
    try { this.sink?.(entry); } catch { /* sinks must never break the request path */ }
    return entry;
  }
  list({ limit = 200, agentId, type } = {}) {
    return this.buffer.list().filter((e) => (!type || e.type === type) && (!agentId || e.caller === agentId || e.target === agentId)).slice(0, limit);
  }
  get size() { return this.buffer.size; }
  clear() { this.buffer.clear(); }
}
