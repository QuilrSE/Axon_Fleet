// Agent A core: telemetry → local analysis → discover dealer agent → A2A task → track status.
import { createEnvelope, toJsonRpc, METHODS, nowIso, RingBuffer, HttpError } from '@axon-fleet/shared';
import { SERVICE_SKILL } from './gatewayConfig.js';

const dataOf = (msg) => msg?.parts?.find((p) => p.kind === 'data')?.data ?? null;
const textOf = (msg) => msg?.parts?.find((p) => p.kind === 'text')?.text ?? null;

export class VehicleAgent {
  constructor({ cfg, engine, gateway, securityEvents, logger, getBaseUrl = () => cfg.baseUrl }) {
    Object.assign(this, { cfg, engine, gateway, securityEvents, logger, getBaseUrl });
    this.tasks = new Map();
    this.probes = new RingBuffer(12);
  }

  generateTelemetry(vehicleId, scenario) { return this.engine.generate(vehicleId, scenario); }

  async sendServiceRequest(vehicleId) {
    const record = this.engine.latest(vehicleId) ?? this.engine.generate(vehicleId, 'normal');
    const vehicle = this.engine.vehicles().find((v) => v.vehicleId === vehicleId);
    if (!vehicle) throw new HttpError(404, 'UNKNOWN_VEHICLE', `Unknown vehicle ${vehicleId}`);
    const target = await this.gateway.discover();
    const mode = this.gateway.connectivity.enabled ? 'gateway' : 'direct';
    const envelope = createEnvelope({
      sender: this.cfg.agentId,
      recipient: target.agentId,
      skill: SERVICE_SKILL,
      intent: 'service_assessment_and_parts_order',
      payload: {
        vehicle: { vehicleId, vin: vehicle.vin, model: vehicle.model, powertrain: vehicle.powertrain },
        telemetry: record.telemetry,
        detectedIssues: record.analysis.alerts,
        preferences: { preferredServiceCenter: 'SYN-DLR-001', contact: 'in-vehicle display', loanerRequested: false },
      },
    });
    const rpc = toJsonRpc(METHODS.MESSAGE_SEND, envelope, {
      configuration: { acceptedOutputModes: ['application/json'], blocking: false, pushNotificationConfig: { url: `${this.getBaseUrl()}/a2a`, authentication: { schemes: ['Bearer'] } } },
    });
    const rec = {
      taskId: envelope.task_id, correlationId: envelope.correlation_id, vehicleId, createdAt: nowIso(),
      mode, gateway: mode === 'gateway' ? target.gatewayName : null,
      route: mode === 'gateway' ? ['agent-a', target.gatewayId, target.agentId] : ['agent-a', target.agentId],
      target, state: 'sending', stage: null, timeline: [], result: null, error: null, request: rpc, initialResponse: null,
      alertsAtSend: record.analysis.alerts.length,
    };
    this.tasks.set(rec.taskId, rec);
    const res = await this.gateway.call(target, rpc, { kind: 'service_request' });
    rec.initialResponse = { status: res.status, body: res.data };
    rec.protocol = res.protocol ?? 'poc';
    if (!res.ok || res.data?.error) {
      rec.state = 'failed';
      const e = res.data?.error;
      rec.error = (typeof e === 'string' ? e : e?.message) ?? `HTTP ${res.status}`;
      rec.timeline.push({ at: nowIso(), stage: 'send_failed', state: 'failed', text: rec.error, via: mode });
    } else {
      // Gateways such as QuilrAI issue their own task/context IDs: track the task under the returned ID.
      const issued = res.data.result?.id;
      if (issued && issued !== rec.taskId) {
        this.tasks.delete(rec.taskId);
        rec.clientTaskId = rec.taskId;
        rec.taskId = issued;
        this.tasks.set(issued, rec);
      }
      if (res.data.result?.contextId) rec.contextId = res.data.result.contextId;
      rec.gatewayRequestId = res.headers?.['x-quilr-request-id'] ?? res.headers?.['x-gateway-request-id'] ?? null;
      this.#apply(rec, res.data.result, mode);
      if (rec.protocol === 'a2a-v1') this.#poll(rec);
    }
    return rec;
  }

  /** A2A v1 fallback: poll GetTask until terminal, in case webhook pushes cannot reach this agent. */
  #poll(rec, { intervalMs = this.cfg.pollIntervalMs ?? 2500, maxMs = 180_000 } = {}) {
    const started = Date.now();
    const tick = async () => {
      if (['completed', 'failed', 'canceled', 'rejected'].includes(rec.state) || Date.now() - started > maxMs) return;
      try { await this.refreshTask(rec.taskId, { quiet: true }); } catch { /* keep polling */ }
      const t = setTimeout(tick, intervalMs); t.unref?.();
    };
    const t = setTimeout(tick, intervalMs); t.unref?.();
  }

  #apply(rec, task, via) {
    if (!task) return;
    const stage = task.metadata?.stage ?? (task.status?.state === 'completed' ? 'completed' : rec.stage ?? null);
    const state = task.status?.state ?? rec.state;
    if (rec.state && ['completed', 'failed', 'canceled', 'rejected'].includes(rec.state) && state !== rec.state) return; // ignore late/duplicate pushes
    const last = rec.timeline.at(-1);
    if (!last || last.stage !== stage || last.state !== state) {
      rec.timeline.push({ at: task.status?.timestamp ?? nowIso(), stage, state, text: textOf(task.status?.message), data: dataOf(task.status?.message), via });
    }
    rec.state = state;
    rec.stage = stage;
    rec.updatedAt = nowIso();
    const art = task.artifacts?.find((a) => a.name === 'service-assessment') ?? task.artifacts?.[0];
    if (art) rec.result = art.parts?.find((p) => p.kind === 'data')?.data ?? null;
  }

  /** Inbound A2A status update (tasks/pushNotification). */
  handlePush(task, inbound) {
    let rec = this.tasks.get(task.id);
    if (!rec) {
      rec = { taskId: task.id, vehicleId: task.metadata?.vehicleId ?? null, createdAt: nowIso(), mode: inbound.via, route: [], target: null, state: 'unknown', stage: null, timeline: [], result: null, error: null, unsolicited: true };
      this.tasks.set(task.id, rec);
    }
    this.#apply(rec, task, inbound.via);
    return rec;
  }

  async #targetFor(rec) {
    const mode = this.gateway.connectivity.enabled ? 'gateway' : 'direct';
    if (rec.target && rec.mode === mode && (mode === 'direct' || rec.target.gatewayId === this.gateway.connectivity.active.id)) return rec.target;
    return this.gateway.discover();
  }

  async refreshTask(taskId, { quiet = false } = {}) {
    const rec = this.#require(taskId);
    const target = await this.#targetFor(rec);
    const env = createEnvelope({ sender: this.cfg.agentId, recipient: target.agentId, skill: SERVICE_SKILL, intent: 'get_task_status', taskId, correlationId: rec.correlationId });
    const res = await this.gateway.call(target, toJsonRpc(METHODS.TASKS_GET, env), { kind: quiet ? 'poll_task_status' : 'get_task_status' });
    if (res.data?.result) this.#apply(rec, res.data.result, this.gateway.connectivity.enabled ? 'gateway' : 'direct');
    return { record: rec, response: { status: res.status, body: res.data } };
  }

  async cancelTask(taskId) {
    const rec = this.#require(taskId);
    const target = await this.#targetFor(rec);
    const env = createEnvelope({ sender: this.cfg.agentId, recipient: target.agentId, skill: SERVICE_SKILL, intent: 'cancel_task', taskId, correlationId: rec.correlationId });
    const res = await this.gateway.call(target, toJsonRpc(METHODS.TASKS_CANCEL, env), { kind: 'cancel_task' });
    if (res.data?.result) this.#apply(rec, res.data.result, this.gateway.connectivity.enabled ? 'gateway' : 'direct');
    return { record: rec, response: { status: res.status, body: res.data } };
  }

  #require(taskId) {
    const rec = this.tasks.get(taskId);
    if (!rec) throw new HttpError(404, 'TASK_NOT_FOUND', `No local record of task ${taskId}`);
    return rec;
  }

  /** Security probes: the same attack against gateway-mediated vs direct mode. */
  async runProbe(type) {
    const mode = this.gateway.connectivity.enabled ? 'gateway' : 'direct';
    const target = await this.gateway.discover();
    const sample = this.engine.latest('veh-001') ?? this.engine.generate('veh-001', 'brake_wear');
    const vehicle = this.engine.vehicles()[0];
    const env = (over = {}) => createEnvelope({ sender: this.cfg.agentId, recipient: target.agentId, skill: SERVICE_SKILL, intent: 'probe', ...over });
    const summarize = (res) => ({ httpStatus: res.status, code: res.data?.error?.code ?? null, message: res.data?.error?.message ?? (res.data?.result ? `accepted → task ${res.data.result.id} (${res.data.result.status?.state})` : null), gatewayRequestId: res.headers?.['x-gateway-request-id'] ?? null });
    const blocked = (res) => !res.ok || !!res.data?.error;
    let calls = [];
    let description;

    switch (type) {
      case 'unauthorized_skill': {
        description = "Invoke Agent B's hidden 'delete_inventory' skill (not allowlisted for agent-a)";
        const res = await this.gateway.call(target, toJsonRpc(METHODS.MESSAGE_SEND, env({ skill: 'delete_inventory', intent: 'delete_all_inventory', payload: { confirm: true } })), { kind: 'probe:unauthorized_skill' });
        calls = [{ ...summarize(res), blocked: blocked(res) }];
        break;
      }
      case 'invalid_token': {
        description = 'Call with a forged / invalid credential';
        const res = await this.gateway.call(target, toJsonRpc(METHODS.TASKS_GET, env({ taskId: 'task_probe_invalid_token' })), { kind: 'probe:invalid_token', credentialOverride: 'forged-token-0000' });
        calls = [{ ...summarize(res), blocked: blocked(res) }];
        break;
      }
      case 'spoofed_sender': {
        description = "Claim to be 'fleet-admin-agent' in the envelope while holding agent-a's credential";
        const rpc = toJsonRpc(METHODS.MESSAGE_SEND, env({
          sender: 'fleet-admin-agent',
          payload: { vehicle: { vehicleId: vehicle.vehicleId, vin: vehicle.vin, model: vehicle.model, powertrain: vehicle.powertrain }, telemetry: sample.telemetry, detectedIssues: [] },
        }), { configuration: { pushNotificationConfig: { url: `${this.getBaseUrl()}/a2a` } } });
        const res = await this.gateway.call(target, rpc, { kind: 'probe:spoofed_sender' });
        calls = [{ ...summarize(res), blocked: blocked(res) }];
        break;
      }
      case 'rate_limit_burst': {
        const n = this.cfg.burstSize ?? 25;
        description = `Fire ${n} rapid tasks/get calls`;
        for (let i = 0; i < n; i += 5) {
          const batch = await Promise.all(Array.from({ length: Math.min(5, n - i) }, () => this.gateway.call(target, toJsonRpc(METHODS.TASKS_GET, env({ taskId: 'task_probe_burst' })), { kind: 'probe:rate_limit_burst' })));
          calls.push(...batch.map((r) => ({ ...summarize(r), blocked: r.status === 429 })));
        }
        break;
      }
      default:
        throw new HttpError(400, 'UNKNOWN_PROBE', `Unknown probe '${type}'. Use unauthorized_skill | invalid_token | spoofed_sender | rate_limit_burst`);
    }

    const blockedCount = calls.filter((c) => c.blocked).length;
    const outcome = type === 'rate_limit_burst'
      ? (blockedCount ? `${blockedCount}/${calls.length} calls rate-limited (HTTP 429)` : `all ${calls.length} calls reached Agent B — no rate limit applied`)
      : (blockedCount ? `Blocked (HTTP ${calls[0].httpStatus})` : 'Allowed — reached Agent B');
    const result = { id: `probe_${Date.now()}`, at: nowIso(), type, mode, gateway: mode === 'gateway' ? this.gateway.connectivity.active.name : null, description, outcome, blocked: blockedCount > 0, calls: type === 'rate_limit_burst' ? calls.slice(-6) : calls, totalCalls: calls.length };
    this.probes.push(result);
    this.securityEvents.push({ timestamp: nowIso(), direction: 'probe', kind: type, mode, decision: result.blocked ? 'blocked' : 'allowed', severity: result.blocked ? 'info' : 'critical', detail: `${description}: ${outcome}` });
    return result;
  }

  taskList(limit = 20) { return [...this.tasks.values()].reverse().slice(0, limit); }
}
