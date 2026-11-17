// Agent B core: runs each work order through the DealerFlow graph and reports transitions.
import { FlowRuntime } from './runtime/flowRuntime.js';
import { toStatusMessage, toArtifact } from './adapters/a2aAdapter.js';
import { diagnose, LABOR_RATE } from './diagnosisRules.js';
import { agentMessage, nowIso, PushConfigStore } from '@axon-fleet/shared';

export class DealerServiceAgent {
  constructor({ inventory, orders, scheduling, tasks, notifier, stepDelayMs = 900, logger }) {
    Object.assign(this, { inventory, orders, scheduling, tasks, notifier, stepDelayMs, logger });
    this.workOrders = new Map();
    this.pushConfigs = new PushConfigStore();
    this.flow = new FlowRuntime({ name: 'telemetry-to-service-appointment', nodes: this.#nodes() });
  }

  #nodes() {
    return [
      {
        id: 'diagnose', stage: 'diagnosed',
        run: (s) => ({ diagnosis: diagnose(s.telemetry) }),
        summarize: (s) => ({ text: `Diagnosed ${s.diagnosis.findings.length} finding(s); ${s.diagnosis.parts.length} part line(s) required`, data: { findings: s.diagnosis.findings, requiredParts: s.diagnosis.parts } }),
      },
      {
        id: 'check_inventory', stage: 'inventory_checked',
        run: (s) => ({ inventoryCheck: this.inventory.check(s.diagnosis.parts) }),
        summarize: (s) => ({ text: `Inventory checked: ${s.inventoryCheck.filter((c) => c.shortfall === 0).length}/${s.inventoryCheck.length} line(s) fully in stock`, data: { inventory: s.inventoryCheck } }),
      },
      {
        id: 'reserve_parts', stage: 'parts_reserved',
        run: (s) => ({ reservations: this.inventory.reserve(s.workOrderId, s.inventoryCheck) }),
        summarize: (s) => ({ text: `Reserved ${s.reservations.reduce((a, r) => a + r.qty, 0)} unit(s) across ${s.reservations.length} line(s)`, data: { reservations: s.reservations } }),
      },
      {
        id: 'order_missing_parts', stage: 'parts_ordered',
        run: (s) => ({ partsOrder: this.orders.create({ taskId: s.workOrderId, vehicleId: s.vehicle.vehicleId, shortfalls: s.inventoryCheck.filter((c) => c.shortfall > 0) }) }),
        summarize: (s) => (s.partsOrder
          ? { text: `Purchase order ${s.partsOrder.orderId} placed for ${s.partsOrder.lines.length} line(s), ETA ${s.partsOrder.eta}`, data: { partsOrder: s.partsOrder } }
          : { text: 'No parts order needed — everything reserved from stock', data: { partsOrder: null } }),
      },
      {
        id: 'propose_appointment', stage: 'appointment_proposed',
        run: (s) => {
          if (!s.diagnosis.services.length) return { appointment: null };
          let earliest = null;
          if (s.partsOrder) { earliest = new Date(`${s.partsOrder.eta}T00:00:00`); earliest.setDate(earliest.getDate() + 1); }
          return { appointment: this.scheduling.propose({ taskId: s.workOrderId, vehicleId: s.vehicle.vehicleId, skills: s.diagnosis.services.map((x) => x.skill), laborHours: s.diagnosis.laborHours, earliest }) };
        },
        summarize: (s) => (s.appointment
          ? { text: `Proposed ${new Date(s.appointment.start).toISOString().slice(0, 16).replace('T', ' ')} with ${s.appointment.mechanic.name} in ${s.appointment.bay.name}`, data: { appointment: s.appointment } }
          : { text: s.diagnosis.services.length ? 'No matching mechanic/bay slot in the planning window' : 'No service required — no appointment proposed', data: { appointment: null } }),
      },
    ];
  }

  submitWorkOrder(wo) {
    const task = this.tasks.create({
      id: wo.workOrderId,
      contextId: wo.contextId,
      stage: 'received',
      envelope: wo.envelope,
      extra: { vehicleId: wo.vehicle.vehicleId, inbound: { via: wo.via, gateway: wo.gatewayName, chain: wo.chain ?? null, claimedSender: wo.requester, verifiedCaller: wo.verifiedRequester, receivedAt: nowIso() }, runtime: this.flow.describe().runtime },
    });
    const state = { workOrderId: task.id, vehicle: wo.vehicle, telemetry: wo.telemetry, detectedIssues: wo.detectedIssues, startedAt: nowIso() };
    this.workOrders.set(task.id, { wo, state });
    setTimeout(() => this.#execute(task.id, wo, state), 0);
    return task;
  }

  async #execute(taskId, wo, state) {
    const push = (t) => this.notifier.push(t, wo).catch((e) => this.logger?.warn('push_failed', { taskId, err: e.message }));
    const result = await this.flow.run(state, {
      delayMs: this.stepDelayMs,
      isCanceled: () => this.tasks.isTerminal(taskId),
      onTransition: async ({ stage, summary }) => {
        if (this.tasks.isTerminal(taskId)) return;
        const t = this.tasks.update(taskId, { state: 'working', stage, message: toStatusMessage(stage, summary) });
        await push(t);
      },
    });
    if (result.status === 'canceled') return;
    if (result.status === 'failed') {
      const t = this.tasks.update(taskId, { state: 'failed', stage: 'failed', message: agentMessage(`Processing failed at ${result.error.node}: ${result.error.message}`) });
      return push(t);
    }
    const assessment = this.#assessment(state);
    state.assessment = assessment;
    const t = this.tasks.update(taskId, {
      state: 'completed',
      stage: 'completed',
      message: agentMessage(assessment.recommendation === 'service_required' ? 'Service assessment complete — appointment proposed' : 'Service assessment complete — no service required', { stage: 'completed' }),
      artifact: toArtifact(assessment),
    });
    await push(t);
  }

  #assessment(s) {
    const partsCost = s.inventoryCheck.reduce((a, c) => a + c.required * c.unitPrice, 0);
    const laborCost = Math.round(s.diagnosis.laborHours * LABOR_RATE.amount);
    const t = s.telemetry;
    return {
      kind: 'service_assessment',
      vehicle: { vehicleId: s.vehicle.vehicleId, vin: s.vehicle.vin, model: s.vehicle.model },
      telemetrySummary: {
        odometerKm: t.odometerKm, batterySocPct: t.batterySocPct, batterySohPct: t.batterySohPct, drivetrainTempC: t.drivetrainTempC,
        minTirePsi: Math.min(...Object.values(t.tirePressurePsi)), brakePadWearPct: t.brakePadWearPct, faultCodes: t.faultCodes,
      },
      findings: s.diagnosis.findings,
      requiredParts: s.diagnosis.parts,
      services: s.diagnosis.services,
      inventory: s.inventoryCheck,
      reservations: s.reservations,
      partsOrder: s.partsOrder,
      appointment: s.appointment,
      estimate: { partsCost, laborHours: s.diagnosis.laborHours, laborCost, total: partsCost + laborCost, currency: 'USD', note: 'Synthetic pricing' },
      recommendation: s.diagnosis.services.length ? 'service_required' : 'no_service_required',
      serviceCenter: { id: 'SYN-DLR-001', name: 'Synthetic Motors Service Center (fictional)' },
      completedAt: nowIso(),
      synthetic: true,
    };
  }

  cancel(taskId, reason) {
    const t = this.tasks.cancel(taskId, reason);
    this.inventory.releaseByTask(taskId);
    this.orders.cancelByTask(taskId);
    this.scheduling.releaseByTask(taskId);
    const entry = this.workOrders.get(taskId);
    if (entry) this.notifier.push(t, entry.wo).catch(() => {});
    return t;
  }

  /** Hidden admin skill used to demonstrate skill-level authorization. Never mutates data. */
  simulateDestructive(envelope, inbound) {
    const task = this.tasks.create({ id: envelope.task_id, contextId: envelope.correlation_id, stage: 'received', envelope, extra: { inbound: { via: inbound.via, claimedSender: envelope.sender_agent_id, verifiedCaller: inbound.verifiedCaller, receivedAt: nowIso() } } });
    return this.tasks.update(task.id, {
      state: 'completed',
      stage: 'completed',
      message: agentMessage('SIMULATED destructive action accepted (inventory NOT modified in this PoC)'),
      artifact: { artifactId: `art_${task.id}`, name: 'delete-inventory-result', parts: [{ kind: 'data', data: { simulated: true, wouldDelete: this.inventory.list().length, note: 'In direct mode nothing stopped this unauthorized skill call.' } }] },
    });
  }

  workOrderList(limit = 30) {
    return [...this.workOrders.entries()].reverse().slice(0, limit).map(([id, { wo, state }]) => ({
      taskId: id,
      vehicle: wo.vehicle,
      via: wo.via,
      requester: wo.requester,
      verifiedRequester: wo.verifiedRequester,
      telemetry: wo.telemetry,
      diagnosis: state.diagnosis ?? null,
      inventory: state.inventoryCheck ?? null,
      reservations: state.reservations ?? null,
      partsOrder: 'partsOrder' in state ? (state.partsOrder ? (this.orders.byTask(id)[0] ?? state.partsOrder) : null) : undefined,
      appointment: state.appointment,
      assessment: state.assessment ?? null,
    }));
  }

  reset() {
    this.workOrders.clear();
    this.pushConfigs = new PushConfigStore();
    this.tasks.clear();
    this.inventory.reset();
    this.orders.reset();
    this.scheduling.reset();
  }
}
