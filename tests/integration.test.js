import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor, post, put, get, TOKENS, DIRECT_B } from './helpers.js';
import { createEnvelope, toJsonRpc } from '@axon-fleet/shared';

describe('end-to-end A2A workflow', () => {
  let s;
  before(async () => { s = await startStack(); });
  after(async () => { await s.stop(); });

  test('both agents serve Agent Cards and are registered at the gateway', async () => {
    const card = await get(`${s.bUrl}/.well-known/agent-card.json`);
    assert.equal(card.status, 200);
    assert.ok(card.body.skills.some((x) => x.id === 'vehicle_service_orchestration'));
    const list = await get(`${s.gatewayUrl}/registry/agents`, { authorization: `Bearer ${TOKENS['agent-a']}` });
    assert.deepEqual(list.body.agents.map((x) => x.agentId).sort(), ['agent-a', 'agent-b']);
  });

  test('registry discovery by skill and tag', async () => {
    const auth = { authorization: `Bearer ${TOKENS['agent-a']}` };
    const bySkill = await get(`${s.gatewayUrl}/registry/agents?skill=vehicle_service_orchestration`, auth);
    assert.deepEqual(bySkill.body.agents.map((x) => x.agentId), ['agent-b']);
    const byTag = await get(`${s.gatewayUrl}/registry/agents?tag=telemetry`, auth);
    assert.deepEqual(byTag.body.agents.map((x) => x.agentId), ['agent-a']);
    const unauth = await get(`${s.gatewayUrl}/registry/agents`);
    assert.equal(unauth.status, 401);
  });

  test('gateway-enabled: telemetry → task → parts → appointment, with push updates and audit', async () => {
    await post(`${s.aUrl}/api/telemetry`, { vehicleId: 'veh-001', scenario: 'brake_wear' });
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
    assert.equal(sent.status, 202);
    assert.equal(sent.body.mode, 'gateway');
    assert.deepEqual(sent.body.route, ['agent-a', 'a2a-gateway', 'agent-b']);
    const taskId = sent.body.taskId;
    await waitFor(() => s.a.agent.tasks.get(taskId)?.state === 'completed');
    const rec = s.a.agent.tasks.get(taskId);
    const stages = rec.timeline.map((t) => t.stage);
    for (const st of ['received', 'diagnosed', 'inventory_checked', 'parts_reserved', 'parts_ordered', 'appointment_proposed', 'completed']) assert.ok(stages.includes(st), `missing stage ${st}`);
    assert.equal(rec.result.recommendation, 'service_required');
    assert.ok(rec.result.reservations.some((r) => r.partNo === 'BRK-PAD-FR'));
    assert.ok(rec.result.partsOrder, 'rotor shortfall should create a parts order');
    assert.ok(rec.result.appointment?.mechanic);
    assert.ok(rec.timeline.filter((t) => t.via === 'gateway').length >= 6, 'push updates should arrive via gateway');
    const audit = s.gateway.ctx.audit.list({ type: 'a2a_request' });
    assert.ok(audit.some((e) => e.taskId === taskId && e.caller === 'agent-a' && e.authorization === 'allow' && e.routing === 'forwarded'));
    assert.ok(audit.some((e) => e.caller === 'agent-b' && e.skill === 'service_status_updates'));
  });

  test('gateway blocks unauthorized skill (delete_inventory) with 403 and audits it', async () => {
    const probe = await post(`${s.aUrl}/api/probe`, { type: 'unauthorized_skill' });
    assert.equal(probe.body.blocked, true);
    assert.equal(probe.body.calls[0].httpStatus, 403);
    assert.ok(s.gateway.ctx.audit.list().some((e) => e.skill === 'delete_inventory' && e.authorization === 'deny'));
  });

  test('gateway rejects invalid tokens and spoofed senders', async () => {
    const bad = await post(`${s.aUrl}/api/probe`, { type: 'invalid_token' });
    assert.equal(bad.body.calls[0].httpStatus, 401);
    const spoof = await post(`${s.aUrl}/api/probe`, { type: 'spoofed_sender' });
    assert.equal(spoof.body.calls[0].httpStatus, 403);
    assert.match(spoof.body.calls[0].message, /identity mismatch/);
  });

  test('agent B refuses direct calls while its gateway toggle is enabled', async () => {
    const env = createEnvelope({ sender: 'agent-a', recipient: 'agent-b', skill: 'vehicle_service_orchestration', intent: 'get_task_status', taskId: 'x' });
    const r = await post(`${s.bUrl}/a2a`, toJsonRpc('get_task_status', env), { authorization: `Bearer ${DIRECT_B}` });
    assert.equal(r.status, 403);
    assert.match(r.body.error.message, /Gateway is enabled/);
  });

  test('gateway-disabled: direct A2A works end to end and bypasses gateway audit', async () => {
    await put(`${s.aUrl}/api/config`, { gatewayEnabled: false });
    await put(`${s.bUrl}/api/config`, { gatewayEnabled: false });
    const before = s.gateway.ctx.stats.routed;
    await post(`${s.aUrl}/api/telemetry`, { vehicleId: 'veh-002', scenario: 'drivetrain_overheat' });
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-002' });
    assert.equal(sent.body.mode, 'direct');
    assert.deepEqual(sent.body.route, ['agent-a', 'agent-b']);
    await waitFor(() => s.a.agent.tasks.get(sent.body.taskId)?.state === 'completed');
    const rec = s.a.agent.tasks.get(sent.body.taskId);
    assert.ok(rec.timeline.filter((t) => t.via === 'direct').length >= 6);
    assert.ok(rec.result.partsOrder.lines.some((l) => l.partNo === 'EDU-COOL-PUMP'));
    assert.equal(s.gateway.ctx.stats.routed, before, 'no traffic should touch the gateway in direct mode');
    const state = await get(`${s.aUrl}/api/state`);
    assert.equal(state.body.mode.communicationMode, 'Direct A2A');
    assert.ok(state.body.mode.warning.includes('bypassed'));
  });

  test('gateway-disabled: unauthorized skill is NOT blocked (demonstrates missing central authz)', async () => {
    const probe = await post(`${s.aUrl}/api/probe`, { type: 'unauthorized_skill' });
    assert.equal(probe.body.mode, 'direct');
    assert.equal(probe.body.blocked, false);
    const bState = await get(`${s.bUrl}/api/state`);
    assert.ok(bState.body.securityEvents.some((e) => e.severity === 'critical' && e.skill === 'delete_inventory'));
  });

  test('toggle back on takes effect immediately', async () => {
    await put(`${s.aUrl}/api/config`, { gatewayEnabled: true });
    await put(`${s.bUrl}/api/config`, { gatewayEnabled: true });
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-003' });
    assert.equal(sent.body.mode, 'gateway');
    await waitFor(() => s.a.agent.tasks.get(sent.body.taskId)?.state === 'completed');
  });

  test('cancel_task releases the task', async () => {
    s.b.agent.stepDelayMs = 300;
    await post(`${s.aUrl}/api/telemetry`, { vehicleId: 'veh-001', scenario: 'low_tire' });
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
    const c = await post(`${s.aUrl}/api/tasks/${sent.body.taskId}/cancel`, {});
    assert.equal(c.body.record.state, 'canceled');
    s.b.agent.stepDelayMs = 5;
  });
});

describe('gateway rate limiting', () => {
  let s;
  before(async () => { s = await startStack({ rateLimit: { limit: 5, windowMs: 60_000 } }); });
  after(async () => { await s.stop(); });

  test('burst beyond the limit is rejected with 429 and logged', async () => {
    const probe = await post(`${s.aUrl}/api/probe`, { type: 'rate_limit_burst' });
    assert.ok(probe.body.blocked);
    assert.ok(s.gateway.ctx.stats.rateLimited >= 7);
    const st = await get(`${s.gatewayUrl}/api/state`);
    assert.ok(st.body.rateLimitEvents.length >= 7);
  });
});
