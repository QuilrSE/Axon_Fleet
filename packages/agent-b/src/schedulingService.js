// Dummy mechanic + service-bay scheduling with seeded busy slots.
// Replace with a DMS scheduling adapter exposing propose/release/view.
import { mulberry32, newId, nowIso } from '@axon-fleet/shared';

export const MECHANICS = [
  { id: 'MECH-01', name: 'Tech Avery (synthetic)', skills: ['brakes', 'tires', 'general'] },
  { id: 'MECH-02', name: 'Tech Blake (synthetic)', skills: ['ev_hv', 'electrical', 'general'] },
  { id: 'MECH-03', name: 'Tech Casey (synthetic)', skills: ['tires', 'brakes', 'general'] },
  { id: 'MECH-04', name: 'Tech Devi (synthetic)', skills: ['ev_hv', 'brakes', 'electrical', 'tires'] },
];
export const BAYS = [
  { id: 'BAY-1', name: 'Bay 1, general', supports: ['brakes', 'tires', 'general', 'electrical'] },
  { id: 'BAY-2', name: 'Bay 2, HV-certified', supports: ['ev_hv', 'electrical', 'brakes', 'general'] },
  { id: 'BAY-3', name: 'Bay 3, tires and alignment', supports: ['tires', 'general'] },
];
export const SLOT_HOURS = [9, 11, 13, 15];
const SKILL_PRIORITY = ['ev_hv', 'electrical', 'brakes', 'tires', 'general'];

export class SchedulingService {
  constructor({ days = 10, seed = 7 } = {}) {
    this.days = days;
    this.seed = seed;
    this.reset();
  }

  reset() {
    const rand = mulberry32(this.seed);
    this.slots = [];
    this.appointments = [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    let added = 0;
    while (added < this.days) {
      d.setDate(d.getDate() + 1);
      if (d.getDay() === 0) continue; // closed Sundays
      added += 1;
      for (const hour of SLOT_HOURS) {
        const start = new Date(d);
        start.setHours(hour);
        this.slots.push({
          start: start.toISOString(),
          date: start.toISOString().slice(0, 10),
          hour,
          mechanics: Object.fromEntries(MECHANICS.map((m) => [m.id, rand() < 0.35 ? 'busy' : 'free'])),
          bays: Object.fromEntries(BAYS.map((b) => [b.id, rand() < 0.3 ? 'busy' : 'free'])),
        });
      }
    }
  }

  propose({ taskId, vehicleId, skills, laborHours, earliest }) {
    const needed = skills.length ? [...new Set(skills)] : ['general'];
    const primary = SKILL_PRIORITY.find((s) => needed.includes(s)) ?? 'general';
    const attempt = (req) => {
      for (const slot of this.slots) {
        if (earliest && new Date(slot.start) < earliest) continue;
        const mech = MECHANICS.find((m) => req.every((s) => m.skills.includes(s)) && slot.mechanics[m.id] === 'free');
        const bay = BAYS.find((b) => req.every((s) => b.supports.includes(s)) && slot.bays[b.id] === 'free');
        if (mech && bay) return { slot, mech, bay };
      }
      return null;
    };
    const hit = attempt(needed) ?? attempt([primary]);
    if (!hit) return null;
    hit.slot.mechanics[hit.mech.id] = 'held';
    hit.slot.bays[hit.bay.id] = 'held';
    const hold = new Date();
    hold.setHours(hold.getHours() + 24);
    const appt = {
      appointmentId: newId('appt'),
      taskId,
      vehicleId,
      start: hit.slot.start,
      estDurationHours: laborHours,
      mechanic: { id: hit.mech.id, name: hit.mech.name },
      bay: { id: hit.bay.id, name: hit.bay.name },
      skillsCovered: needed.filter((s) => hit.mech.skills.includes(s)),
      status: 'proposed',
      holdExpiresAt: hold.toISOString(),
      createdAt: nowIso(),
    };
    this.appointments.push(appt);
    return structuredClone(appt);
  }

  releaseByTask(taskId) {
    for (const a of this.appointments.filter((x) => x.taskId === taskId && x.status === 'proposed')) {
      const slot = this.slots.find((s) => s.start === a.start);
      if (slot) { slot.mechanics[a.mechanic.id] = 'free'; slot.bays[a.bay.id] = 'free'; }
      a.status = 'released';
    }
  }

  view({ slotLimit = 12 } = {}) {
    return {
      mechanics: MECHANICS,
      bays: BAYS,
      slots: this.slots.slice(0, slotLimit),
      appointments: [...this.appointments].reverse(),
    };
  }
}
