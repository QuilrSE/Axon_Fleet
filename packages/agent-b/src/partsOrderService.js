// Dummy supplier ordering with simulated asynchronous status progression:
// placed → confirmed → in_transit. Replace with a supplier/ERP purchase-order adapter.
import { nowIso } from '@axon-fleet/shared';

export class PartsOrderService {
  constructor({ progressMs = 1500 } = {}) {
    this.progressMs = progressMs;
    this.reset();
  }

  reset() {
    for (const t of this.timers ?? []) clearTimeout(t);
    this.timers = [];
    this.orders = new Map();
    this.seq = 1000;
  }

  create({ taskId, vehicleId, shortfalls }) {
    if (!shortfalls.length) return null;
    const now = new Date();
    const lines = shortfalls.map((s) => {
      const eta = new Date(now);
      eta.setDate(eta.getDate() + s.leadTimeDays);
      return { partNo: s.partNo, name: s.name, qty: s.shortfall, leadTimeDays: s.leadTimeDays, eta: eta.toISOString().slice(0, 10), unitPrice: s.unitPrice };
    });
    this.seq += 1;
    const order = {
      orderId: `PO-SYN-${this.seq}`,
      taskId,
      vehicleId,
      supplier: 'SYN Parts Distribution (fictional)',
      status: 'placed',
      lines,
      eta: lines.map((l) => l.eta).sort().at(-1),
      createdAt: nowIso(),
      statusHistory: [{ status: 'placed', at: nowIso() }],
    };
    this.orders.set(order.orderId, order);
    this.#advance(order.orderId, 'confirmed', this.progressMs);
    this.#advance(order.orderId, 'in_transit', this.progressMs * 3);
    return structuredClone(order);
  }

  #advance(orderId, status, delay) {
    const t = setTimeout(() => {
      const o = this.orders.get(orderId);
      if (!o || o.status === 'canceled') return;
      o.status = status;
      o.statusHistory.push({ status, at: nowIso() });
    }, delay);
    t.unref?.();
    this.timers.push(t);
  }

  cancelByTask(taskId) {
    for (const o of this.orders.values()) {
      if (o.taskId === taskId && o.status !== 'canceled') { o.status = 'canceled'; o.statusHistory.push({ status: 'canceled', at: nowIso() }); }
    }
  }

  byTask(taskId) { return [...this.orders.values()].filter((o) => o.taskId === taskId).map((o) => structuredClone(o)); }
  list() { return [...this.orders.values()].reverse().map((o) => structuredClone(o)); }
}
