// Dummy parts inventory. Replace with a DMS/ERP adapter exposing check/reserve/release.
import { newId, nowIso } from '@axon-fleet/shared';

const SEED = [
  { partNo: 'BRK-PAD-FR', name: 'Front brake pad set', onHand: 6, leadTimeDays: 1, unitPrice: 89 },
  { partNo: 'BRK-ROT-FR', name: 'Front brake rotor', onHand: 1, leadTimeDays: 1, unitPrice: 74 },
  { partNo: 'BRK-PAD-RR', name: 'Rear brake pad set', onHand: 4, leadTimeDays: 1, unitPrice: 69 },
  { partNo: 'TPMS-SVC-KIT', name: 'TPMS valve service kit', onHand: 8, leadTimeDays: 1, unitPrice: 12 },
  { partNo: 'TIRE-PLUG-KIT', name: 'Tire repair plug kit', onHand: 10, leadTimeDays: 1, unitPrice: 9 },
  { partNo: 'TIRE-235-45R18', name: 'Tire 235/45 R18 (EV-rated)', onHand: 2, leadTimeDays: 2, unitPrice: 210 },
  { partNo: 'HV-BAT-MOD', name: 'HV battery module (BEV)', onHand: 0, leadTimeDays: 4, unitPrice: 1450 },
  { partNo: 'HYB-BAT-MOD', name: 'Hybrid battery module (HEV)', onHand: 1, leadTimeDays: 3, unitPrice: 980 },
  { partNo: 'HV-ISO-KIT', name: 'HV isolation repair kit', onHand: 2, leadTimeDays: 2, unitPrice: 140 },
  { partNo: 'COOLANT-EV', name: 'EV coolant (1 L)', onHand: 12, leadTimeDays: 1, unitPrice: 18 },
  { partNo: 'EDU-COOL-PUMP', name: 'Drive-unit electric coolant pump', onHand: 0, leadTimeDays: 2, unitPrice: 320 },
  { partNo: 'WSS-FL', name: 'Wheel speed sensor, left front', onHand: 3, leadTimeDays: 1, unitPrice: 55 },
];

export class InventoryService {
  constructor() { this.reset(); }

  reset() {
    this.parts = new Map(SEED.map((p) => [p.partNo, { ...p, reserved: 0, currency: 'USD', supplier: 'SYN Parts Distribution (fictional)' }]));
    this.reservations = [];
  }

  available(partNo) { const p = this.parts.get(partNo); return p ? p.onHand - p.reserved : 0; }

  check(required) {
    return required.map((r) => {
      const p = this.parts.get(r.partNo);
      const available = this.available(r.partNo);
      return {
        partNo: r.partNo,
        name: p?.name ?? `Unknown part ${r.partNo}`,
        required: r.qty,
        available,
        reservable: Math.min(available, r.qty),
        shortfall: Math.max(0, r.qty - available),
        leadTimeDays: p?.leadTimeDays ?? 7,
        unitPrice: p?.unitPrice ?? 0,
        status: available >= r.qty ? 'in_stock' : available > 0 ? 'partial' : 'out_of_stock',
      };
    });
  }

  reserve(taskId, checks) {
    const made = [];
    for (const c of checks) {
      if (c.reservable <= 0) continue;
      const p = this.parts.get(c.partNo);
      if (!p) continue;
      const qty = Math.min(c.reservable, this.available(c.partNo)); // re-check at reservation time
      if (qty <= 0) continue;
      p.reserved += qty;
      const r = { reservationId: newId('rsv'), taskId, partNo: c.partNo, name: p.name, qty, status: 'reserved', at: nowIso() };
      this.reservations.push(r);
      made.push(r);
    }
    return made;
  }

  releaseByTask(taskId) {
    for (const r of this.reservations.filter((x) => x.taskId === taskId && x.status === 'reserved')) {
      const p = this.parts.get(r.partNo);
      if (p) p.reserved -= r.qty;
      r.status = 'released';
    }
  }

  list() { return [...this.parts.values()].map((p) => ({ ...p, available: p.onHand - p.reserved })); }
}
