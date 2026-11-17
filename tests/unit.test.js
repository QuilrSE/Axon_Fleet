import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  buildAgentCard, validateAgentCard, AgentRegistry, PolicyEngine, RateLimiter, AuditLog,
  StaticTokenAuthenticator, createAuthenticator, classifyInbound, TelemetryGenerator, validateTelemetry,
  createEnvelope, toJsonRpc, validateRpcRequest, normalizeMethod, TaskStore, securityControls,
} from '@axon-fleet/shared';
import { diagnose } from '../packages/agent-b/src/diagnosisRules.js';
import { InventoryService } from '../packages/agent-b/src/inventoryService.js';
import { SchedulingService } from '../packages/agent-b/src/schedulingService.js';
import { evaluate } from '../packages/agent-a/src/maintenanceRules.js';

const cardA = JSON.parse(fs.readFileSync(new URL('../packages/agent-a/src/agent-card.json', import.meta.url)));
const cardB = JSON.parse(fs.readFileSync(new URL('../packages/agent-b/src/agent-card.json', import.meta.url)));

describe('Agent Cards', () => {
  test('templates build into valid cards with absolute URLs', () => {
    for (const tpl of [cardA, cardB]) {
      const card = buildAgentCard(tpl, { baseUrl: 'http://localhost:9999', version: '1.2.3' });
      assert.equal(card.url, 'http://localhost:9999/a2a');
      assert.equal(card.version, '1.2.3');
      assert.deepEqual(validateAgentCard(card), { valid: true, errors: [] });
    }
  });
  test('cards declare auth schemes but never contain credentials', () => {
    const card = buildAgentCard(cardB, { baseUrl: 'http://x' });
    assert.equal(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme, 'Bearer');
    assert.deepEqual(card.supportedInterfaces[0], { url: 'http://x/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' });
    const leaky = { ...card, securitySchemes: { k: { type: 'http', scheme: 'bearer', token: 'abc' } } };
    assert.equal(validateAgentCard(leaky).valid, false);
    assert.equal(validateAgentCard(card, { knownSecrets: ['poc-gw-token-agent-b'] }).valid, true);
    const embedded = { ...card, description: `${card.description} poc-gw-token-agent-b` };
    assert.equal(validateAgentCard(embedded, { knownSecrets: ['poc-gw-token-agent-b'] }).valid, false);
  });
  test('missing required fields are reported', () => {
    const r = validateAgentCard({ name: 'x' });
    assert.equal(r.valid, false);
    assert.ok(r.errors.some((e) => e.includes('skills')));
  });
});

describe('Registry', () => {
  const reg = new AgentRegistry();
  const a = buildAgentCard(cardA, { baseUrl: 'http://a' });
  const b = buildAgentCard(cardB, { baseUrl: 'http://b' });
  test('register and re-register (heartbeat)', () => {
    assert.equal(reg.register({ agentId: 'agent-a', card: a }).created, true);
    assert.equal(reg.register({ agentId: 'agent-b', card: b }).created, true);
    const again = reg.register({ agentId: 'agent-b', card: b });
    assert.equal(again.created, false);
    assert.equal(again.entry.registrations, 2);
  });
  test('rejects invalid agent ids and cards', () => {
    assert.equal(reg.register({ agentId: 'Bad ID', card: a }).ok, false);
    assert.equal(reg.register({ agentId: 'agent-c', card: { name: 'x' } }).ok, false);
  });
  test('discovery by skill, tag, name, capability, provider', () => {
    assert.deepEqual(reg.discover({ skill: 'vehicle_service_orchestration' }).map((e) => e.agentId), ['agent-b']);
    assert.deepEqual(reg.discover({ tag: 'inventory' }).map((e) => e.agentId), ['agent-b']);
    assert.deepEqual(reg.discover({ name: 'telemetry' }).map((e) => e.agentId), ['agent-a']);
    assert.deepEqual(reg.discover({ capability: 'pushNotifications' }).map((e) => e.agentId), ['agent-b']);
    assert.deepEqual(reg.discover({ provider: 'dealer' }).map((e) => e.agentId), ['agent-b']);
    assert.equal(reg.discover({ skill: 'nope' }).length, 0);
  });
});

describe('A2A messages and tasks', () => {
  test('envelope → JSON-RPC carries envelope + data part, aliases normalize', () => {
    const env = createEnvelope({ sender: 'agent-a', recipient: 'agent-b', skill: 's', intent: 'i', payload: { x: 1 } });
    const rpc = toJsonRpc('create_task', env);
    assert.equal(rpc.method, 'message/send');
    assert.equal(rpc.params.metadata.envelope.task_id, env.task_id);
    assert.deepEqual(rpc.params.message.parts[1].data.payload, { x: 1 });
    assert.deepEqual(validateRpcRequest(rpc), []);
    assert.equal(normalizeMethod('get_task_status'), 'tasks/get');
    assert.equal(normalizeMethod('cancel_task'), 'tasks/cancel');
    assert.equal(toJsonRpc('get_task_status', env).params.id, env.task_id);
  });
  test('validation catches malformed requests', () => {
    assert.ok(validateRpcRequest({ jsonrpc: '1.0' }).length > 0);
  });
  test('task lifecycle: transitions, terminal protection, cancel', () => {
    const store = new TaskStore();
    const t = store.create({ id: 'task_1' });
    store.update(t.id, { state: 'working', stage: 'inventory_checked' });
    const done = store.update(t.id, { state: 'completed', stage: 'completed' });
    assert.deepEqual(done.metadata.stageHistory.map((h) => h.stage), ['received', 'inventory_checked', 'completed']);
    assert.throws(() => store.cancel(t.id), /cannot be canceled/);
    const t2 = store.create({});
    assert.equal(store.cancel(t2.id).status.state, 'canceled');
  });
});

describe('Security', () => {
  test('static token authentication maps token → agent identity', async () => {
    const auth = new StaticTokenAuthenticator({ 'agent-a': 'tok-a' });
    assert.deepEqual(await auth.authenticate({ headers: { authorization: 'Bearer tok-a' } }), { ok: true, principal: { agentId: 'agent-a', scheme: 'static-bearer' } });
    assert.equal((await auth.authenticate({ headers: { authorization: 'Bearer nope' } })).reason, 'invalid_token');
    assert.equal((await auth.authenticate({ headers: {} })).reason, 'missing_bearer_token');
  });
  test('OAuth/OIDC/mTLS are declared extension points', async () => {
    const r = await createAuthenticator({ mode: 'oidc' }).authenticate({ headers: {} });
    assert.equal(r.ok, false);
    assert.match(r.reason, /not_implemented/);
  });
  test('skill-level authorization allowlist', () => {
    const p = new PolicyEngine();
    assert.equal(p.authorize({ caller: 'agent-a', target: 'agent-b', skill: 'vehicle_service_orchestration' }).allowed, true);
    assert.equal(p.authorize({ caller: 'agent-a', target: 'agent-b', skill: 'delete_inventory' }).allowed, false);
    assert.equal(p.authorize({ caller: 'rogue', target: 'agent-b', skill: 'vehicle_service_orchestration' }).allowed, false);
  });
  test('rate limiter enforces a fixed window', () => {
    const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
    assert.equal(rl.check('a', 0).allowed, true);
    assert.equal(rl.check('a', 1).allowed, true);
    assert.equal(rl.check('a', 2).allowed, false);
    assert.equal(rl.check('a', 1001).allowed, true);
  });
  test('audit log records and filters', () => {
    const log = new AuditLog();
    log.record({ type: 'a2a_request', caller: 'agent-a', target: 'agent-b' });
    log.record({ type: 'registration', caller: 'agent-b', target: 'a2a-gateway' });
    assert.equal(log.list({ type: 'registration' }).length, 1);
    assert.equal(log.list({ agentId: 'agent-a' }).length, 1);
    assert.ok(log.list()[0].id && log.list()[0].timestamp);
  });
  test('agent inbound: gateway token always ok; direct key only when gateway disabled', () => {
    const opts = { gatewayForwardToken: 'fwd', directApiKey: 'dk' };
    const req = (t) => ({ headers: { authorization: `Bearer ${t}`, 'x-a2a-caller': 'agent-a' } });
    assert.equal(classifyInbound(req('fwd'), { ...opts, gatewayEnabled: true }).via, 'gateway');
    assert.equal(classifyInbound(req('dk'), { ...opts, gatewayEnabled: true }).reason, 'gateway_required');
    assert.equal(classifyInbound(req('dk'), { ...opts, gatewayEnabled: false }).ok, true);
    assert.equal(classifyInbound(req('x'), { ...opts, gatewayEnabled: false }).status, 401);
  });
  test('UI security-control list flips with the gateway toggle', () => {
    assert.ok(securityControls(true).every((c) => c.applied));
    const off = securityControls(false);
    assert.ok(off.filter((c) => !c.applied).length >= 8);
    assert.ok(off.find((c) => c.name === 'Endpoint credential check').applied);
  });
});

describe('Telemetry and decision logic', () => {
  test('generator is deterministic for a seed and produces valid telemetry', () => {
    const g1 = new TelemetryGenerator({ seed: 1 });
    const g2 = new TelemetryGenerator({ seed: 1 });
    const t1 = g1.generate('veh-001', 'brake_wear');
    const t2 = g2.generate('veh-001', 'brake_wear');
    assert.equal(t1.brakePadWearPct.front, t2.brakePadWearPct.front);
    assert.deepEqual(validateTelemetry(t1), []);
  });
  test('Agent A local rules flag maintenance needs', () => {
    const g = new TelemetryGenerator({ seed: 3 });
    assert.ok(evaluate(g.generate('veh-001', 'brake_wear')).alerts.some((a) => a.code === 'BRAKE_FRONT' && a.severity === 'critical'));
    assert.ok(evaluate(g.generate('veh-002', 'low_tire')).alerts.some((a) => a.code.startsWith('TIRE_')));
    assert.equal(evaluate(g.generate('veh-003', 'normal')).serviceNeeded, false);
  });
  test('telemetry → parts decision logic', () => {
    const g = new TelemetryGenerator({ seed: 5 });
    const brake = diagnose(g.generate('veh-001', 'brake_wear'));
    assert.deepEqual(brake.parts.map((p) => p.partNo).sort(), ['BRK-PAD-FR', 'BRK-ROT-FR']);
    const heat = diagnose(g.generate('veh-002', 'drivetrain_overheat'));
    assert.ok(heat.parts.some((p) => p.partNo === 'EDU-COOL-PUMP'));
    const hev = diagnose(g.generate('veh-003', 'battery_degradation'));
    assert.ok(hev.parts.some((p) => p.partNo === 'HYB-BAT-MOD'));
    assert.equal(diagnose(g.generate('veh-001', 'normal')).parts.length, 0);
  });
  test('inventory reservation reserves stock, reports shortfalls, and releases', () => {
    const inv = new InventoryService();
    const check = inv.check([{ partNo: 'BRK-ROT-FR', qty: 2 }, { partNo: 'HV-BAT-MOD', qty: 1 }]);
    assert.deepEqual(check.map((c) => [c.reservable, c.shortfall]), [[1, 1], [0, 1]]);
    const made = inv.reserve('t1', check);
    assert.equal(made.length, 1);
    assert.equal(inv.available('BRK-ROT-FR'), 0);
    inv.releaseByTask('t1');
    assert.equal(inv.available('BRK-ROT-FR'), 1);
  });
  test('scheduling proposes a slot with a skilled mechanic and compatible bay', () => {
    const sched = new SchedulingService();
    const appt = sched.propose({ taskId: 't', vehicleId: 'v', skills: ['ev_hv'], laborHours: 2 });
    assert.ok(['MECH-02', 'MECH-04'].includes(appt.mechanic.id));
    assert.equal(appt.bay.id, 'BAY-2');
  });
});

describe('handler failures are never reported as "not found"', () => {
  test('Node/Express: a handler rejecting with undefined returns 500 with an explanation', async () => {
    const express = (await import('express')).default;
    const { asyncHandler, errorHandler, listen, closeServer } = await import('@axon-fleet/shared');
    const app = express();
    app.post('/api/x', asyncHandler(async () => { throw undefined; }));
    app.use((req, res) => res.status(404).json({ error: { message: 'not found' } }));
    app.use(errorHandler());
    const server = await listen(app, 0, '127.0.0.1');
    try {
      const r = await fetch(`http://127.0.0.1:${server.address().port}/api/x`, { method: 'POST' });
      assert.equal(r.status, 500);
      assert.match((await r.json()).error.message, /failed without an error object/);
    } finally { await closeServer(server); }
  });

  test('Workers router: same rule, and a matched route is named if it ever falls through', async () => {
    const express = (await import('../cloudflare/shims/express.js')).default;
    const { asyncHandler, errorHandler } = await import('@axon-fleet/shared');
    const app = express();
    app.use((req, res, next) => { next(); });
    app.post('/api/x', asyncHandler(async () => { throw null; }));
    app.post('/api/y', (req, res, next) => next());
    app.use((req, res) => res.status(404).json({ error: { message: req.matchedRoutes?.length ? `matched ${req.matchedRoutes.join(',')}` : 'missing' } }));
    app.use(errorHandler());
    const x = await app.fetch(new Request('https://h/api/x', { method: 'POST' }));
    assert.equal(x.status, 500);
    const y = await app.fetch(new Request('https://h/api/y', { method: 'POST' }));
    assert.equal(y.status, 404);
    assert.equal((await y.json()).error.message, 'matched POST /api/y');
  });
});
