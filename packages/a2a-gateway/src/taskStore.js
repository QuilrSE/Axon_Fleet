// The gateway does not own tasks; it keeps a lightweight index of tasks it has routed
// (for tracing and the dashboard), updated from responses and status pushes.
import { nowIso } from '@axon-fleet/shared';

export class GatewayTaskIndex {
  constructor(max = 300) { this.max = max; this.tasks = new Map(); }
  observe({ taskId, caller, target, skill, state, stage, method, correlationId }) {
    if (!taskId) return;
    const prev = this.tasks.get(taskId) ?? { taskId, firstSeen: nowIso(), hops: 0, requester: caller, provider: target, skill };
    const next = { ...prev, lastMethod: method, correlationId: correlationId ?? prev.correlationId, state: state ?? prev.state ?? 'submitted', stage: stage ?? prev.stage, updatedAt: nowIso(), hops: prev.hops + 1 };
    this.tasks.delete(taskId);
    this.tasks.set(taskId, next);
    if (this.tasks.size > this.max) this.tasks.delete(this.tasks.keys().next().value);
  }
  list(limit = 50) { return [...this.tasks.values()].reverse().slice(0, limit); }
  clear() { this.tasks.clear(); }
}
