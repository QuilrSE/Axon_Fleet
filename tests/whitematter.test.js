// Whitematter A2A Gateway compliance (against an emulator built from Whitematter's documentation).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startStack, waitFor, post, put, get } from './helpers.js';
import { createWhitematterMock } from './mocks/whitematterMock.js';
import { explainWhitematterError, parseWhitematterUrl, WM_ERROR_CODE_FIELD } from '@axon-fleet/shared';

const KEY_A = 'sk-test-agent-a';
const KEY_B = 'sk-test-agent-b';
const FWD = 'whitematter-forward-test';
const SLUG_A = 'in-vehicle-telemetry-driver-assistant-agent';
const SLUG_B = 'synthetic-motors-service-orchestration-agent';
const sh = async (cmd) => (await promisify(execFile)('sh', ['-c', cmd], { encoding: 'utf8', timeout: 15000 })).stdout;

async function setup({ pushEnabled = true, allowInsecureWebhook = true, grantASkills = '*', skillRouted = true } = {}) {
  if (allowInsecureWebhook) process.env.WHITEMATTER_ALLOW_INSECURE_WEBHOOK = 'true'; else delete process.env.WHITEMATTER_ALLOW_INSECURE_WEBHOOK;
  const s = await startStack();
  s.a.cfg.pollIntervalMs = 300;
  const q = createWhitematterMock({
    pushEnabled,
    callers: {
      [KEY_A]: { id: 'vehicle-agent', grants: { [SLUG_B]: { methods: '*', skills: grantASkills }, [SLUG_A]: { methods: '*', skills: '*' } } },
      [KEY_B]: { id: 'dealer-agent', grants: { [SLUG_B]: { methods: '*', skills: '*' } } },
      'sk-no-grants': { id: 'nobody', grants: {} },
    },
  });
  await q.start();
  await q.registerAgent({ slug: SLUG_B, cardUrl: `${s.bUrl}/.well-known/agent-card.json`, outbound: { type: 'bearer', token: FWD }, skillRouted });
  await q.registerAgent({ slug: SLUG_A, cardUrl: `${s.aUrl}/.well-known/agent-card.json`, outbound: { type: 'bearer', token: FWD } });
  const profile = (key, extra = {}) => ({
    name: 'Whitematter A2A Gateway', kind: 'whitematter', url: `${q.base}/${SLUG_A}`,       // pasting an agent URL is fine
    authScheme: 'bearer', credential: key, inboundHeaderName: 'Authorization', inboundCredential: `Bearer ${FWD}`,
    agentNames: `agent-a=${SLUG_A},agent-b=${SLUG_B}`, registerEnabled: true, activate: true, ...extra,
  });
  const rb = await post(`${s.bUrl}/api/gateways`, profile(KEY_B));
  const ra = await post(`${s.aUrl}/api/gateways`, profile(KEY_A));
  return { s, q, ra, rb, async stop() { await q.stop(); await s.stop(); delete process.env.WHITEMATTER_ALLOW_INSECURE_WEBHOOK; } };
}

describe('Whitematter helpers (unit)', () => {
  test('agent URL / card URL / base all normalize to /a2a/{org}', () => {
    for (const u of ['https://gateway.example.com/a2a/tadc5ab68a5195659/in-vehicle-telemetry-driver-assistant-agent', 'https://gateway.example.com/a2a/tadc5ab68a5195659/in-vehicle-telemetry-driver-assistant-agent/.well-known/agent-card.json', 'https://gateway.example.com/a2a/tadc5ab68a5195659/']) {
      assert.equal(parseWhitematterUrl(u).base, 'https://gateway.example.com/a2a/tadc5ab68a5195659');
    }
    assert.equal(parseWhitematterUrl('https://h/a2a/org1/my-agent').slug, 'my-agent');
  });
  test('the exact error from the field is explained with both accepted headers', () => {
    const res = { status: 401, data: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'missing A2A caller key', details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'A2A_UNAUTHENTICATED', domain: 'whitematter.example', metadata: { [WM_ERROR_CODE_FIELD]: 'a2a_unauthenticated', request_id: '0b2a9d4cb35341c1a6581f4571380109' } }] } } };
    const e = explainWhitematterError(res);
    assert.equal(e.code, 'a2a_unauthenticated');
    assert.match(e.message, /Authorization: Bearer <caller key>" or in the gateway's caller-key header/);
    assert.match(e.message, /Gateway request ID: 0b2a9d4cb35341c1a6581f4571380109/);
  });
});

describe('Agents A and B through the Whitematter A2A Gateway (push relay)', () => {
  let t;
  before(async () => { t = await setup(); });
  after(async () => { await t.stop(); });

  test('without a caller key Whitematter answers "missing A2A caller key"', async () => {
    const r = await fetch(`${t.q.base}/catalog`);
    assert.equal(r.status, 401);
    assert.equal((await r.json()).error.message, 'missing A2A caller key');
  });

  test('profiles: base URL normalized, key checked via catalog, registration verified via served card', async () => {
    const g = t.ra.body.gateway;
    assert.equal(t.ra.status, 201, JSON.stringify(t.ra.body));
    assert.equal(g.url, t.q.base);
    assert.equal(g.registration.status, 'registered', g.registration.error);
    assert.equal(g.registration.mode, 'verified');
    assert.equal(g.health.status, 'healthy');
    assert.equal(t.rb.body.gateway.registration.status, 'registered', t.rb.body.gateway.registration.error);
  });

  test('A → Whitematter → B: gateway task ID adopted, skill_id sent, no client context, caller key not forwarded, chain recorded', async () => {
    await post(`${t.s.aUrl}/api/telemetry`, { vehicleId: 'veh-001', scenario: 'brake_wear' });
    const sent = await post(`${t.s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body.error));
    assert.deepEqual(sent.body.route, ['agent-a', 'whitematter-a2a-gateway', 'agent-b']);
    assert.match(sent.body.taskId, /^qt_/, 'Agent A tracks the gateway-issued task ID');
    await waitFor(() => t.s.a.agent.tasks.get(sent.body.taskId)?.state === 'completed', { timeoutMs: 10000 });
    const rec = t.s.a.agent.tasks.get(sent.body.taskId);
    assert.equal(rec.result.recommendation, 'service_required');
    const fwd = t.q.log.find((e) => e.op === 'forward' && e.method === 'SendMessage');
    assert.equal(fwd.skill, 'vehicle_service_orchestration');
    assert.equal(fwd.sentContextId, null);
    assert.equal(fwd.callerKeyForwarded, false);
    assert.ok(t.q.log.filter((e) => e.op === 'push_relay' && e.status === 200).length >= 3, 'status updates relayed through Whitematter');
    const bTask = (await get(`${t.s.bUrl}/api/state`)).body.tasks.at(0);
    assert.match(bTask.metadata.inbound.chain.gatewayChain, /^present/);
    assert.equal(bTask.metadata.inbound.gateway, 'Whitematter A2A Gateway');
  });

  test('polling uses the gateway task ID (owner-only GetTask succeeds)', async () => {
    const id = [...t.s.a.agent.tasks.keys()].find((k) => k.startsWith('qt_'));
    const r = await post(`${t.s.aUrl}/api/tasks/${id}/refresh`, {});
    assert.equal(r.body.response.body.result.id, id);
  });

  test('unauthorized skill is refused by Whitematter (skill_unknown) and explained', async () => {
    const p = (await post(`${t.s.aUrl}/api/probe`, { type: 'unauthorized_skill' })).body;
    assert.equal(p.blocked, true);
    assert.match(p.calls[0].message, /grant does not allow this method or skill.*skill_unknown/);
  });

  test('B served by Whitematter: gateway interface, Whitematter key scheme; Whitematter can call A too (skill_id honored)', async () => {
    const card = await (await fetch(`${t.q.base}/${SLUG_B}/.well-known/agent-card.json`, { headers: { authorization: `Bearer ${KEY_A}` } })).json();
    assert.equal(card.supportedInterfaces[0].url, `${t.q.base}/${SLUG_B}`);
    assert.ok(card.securitySchemes.whitematter_key);
    const r = await post(`${t.q.base}/${SLUG_A}`, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ data: { vehicleId: 'veh-001' } }], metadata: { skill_id: 'vehicle_telemetry_query' } } } }, { authorization: `Bearer ${KEY_A}`, 'a2a-version': '1.0' });
    assert.equal(r.body.result.task.status.state, 'TASK_STATE_COMPLETED', JSON.stringify(r.body));
    assert.match(r.body.result.task.id, /^qt_/);
  });

  test('equivalent curl: Whitematter endpoints, masked key, and the revealed call works', async () => {
    const c = (await get(`${t.s.aUrl}/api/gateways/whitematter-a2a-gateway/curl`)).body;
    assert.deepEqual(c.planned.map((x) => x.id), ['health', 'register', 'discover', 'invoke', 'inbound']);
    assert.match(c.planned.find((x) => x.id === 'invoke').curl, new RegExp(`/a2a/${t.q.org}/${SLUG_B}'[\\s\\S]*Authorization: Bearer ••••nt-a[\\s\\S]*A2A-Version: 1.0`));
    assert.match(c.planned.find((x) => x.id === 'inbound').note, /outbound auth to Bearer token/);
    const rev = (await get(`${t.s.aUrl}/api/gateways/whitematter-a2a-gateway/curl?reveal=1`)).body;
    const out = JSON.parse(await sh(rev.planned.find((x) => x.id === 'invoke').curl));
    assert.equal(out.error.code, -32001, JSON.stringify(out));
  });
});

describe('Whitematter edge cases', () => {
  test('HTTP (non-public) webhook: Agent A attaches no webhook and completes by polling', async () => {
    const t = await setup({ allowInsecureWebhook: false });
    try {
      const sent = await post(`${t.s.aUrl}/api/service-request`, { vehicleId: 'veh-002' });
      await waitFor(() => t.s.a.agent.tasks.get(sent.body.taskId)?.state === 'completed', { timeoutMs: 12000 });
      assert.equal(t.q.log.filter((e) => e.op === 'push_relay').length, 0);
      assert.ok(t.ra.body.gateway.warnings.some((w) => /HTTPS on public addresses/.test(w.text)));
    } finally { await t.stop(); }
  });

  test('push off for the organization (-32003): resend without webhook, then poll', async () => {
    const t = await setup({ pushEnabled: false });
    try {
      const sent = await post(`${t.s.aUrl}/api/service-request`, { vehicleId: 'veh-003' });
      assert.equal(sent.status, 202, JSON.stringify(sent.body.error));
      await waitFor(() => t.s.a.agent.tasks.get(sent.body.taskId)?.state === 'completed', { timeoutMs: 12000 });
      const ev = (await get(`${t.s.aUrl}/api/state`)).body.securityEvents;
      assert.ok(ev.some((e) => e.decision === 'push_disabled'));
    } finally { await t.stop(); }
  });

  test('no grant for the target → -31404 explained; wrong key → -31401 explained', async () => {
    const t = await setup();
    try {
      await put(`${t.s.aUrl}/api/gateways/whitematter-a2a-gateway`, { credential: 'sk-no-grants' });
      const sent = await post(`${t.s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
      assert.equal(sent.status, 404);
      assert.match(sent.body.error.message, /No agent with skill/);
      const raw = await fetch(`${t.q.base}/${SLUG_B}`, { method: 'POST', headers: { authorization: 'Bearer sk-no-grants', 'content-type': 'application/json', 'a2a-version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }) });
      const ex = explainWhitematterError({ status: raw.status, data: await raw.json(), headers: Object.fromEntries(raw.headers) });
      assert.equal(ex.code, 'a2a_agent_not_found');
      assert.match(ex.message, /no grant for it/);
      await put(`${t.s.aUrl}/api/gateways/whitematter-a2a-gateway`, { credential: 'sk-wrong' });
      const g = (await get(`${t.s.aUrl}/api/gateways`)).body.gateways.find((x) => x.id === 'whitematter-a2a-gateway');
      assert.equal(g.registration.status, 'failed');
      assert.match(g.registration.error, /caller key is missing, invalid/);
    } finally { await t.stop(); }
  });

  test('skill-routed with several granted skills: request without skill_id is refused, ours is accepted', async () => {
    const t = await setup();
    try {
      const a = t.q.agents.get(SLUG_B);
      a.card = { ...a.card, skills: [...a.card.skills, { id: 'recall_lookup', name: 'Recall lookup', description: 'x', tags: [] }] };
      const bare = await post(`${t.q.base}/${SLUG_B}`, { jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'm', role: 'ROLE_USER', parts: [{ text: 'hi' }] } } }, { authorization: `Bearer ${KEY_A}`, 'a2a-version': '1.0' });
      assert.equal(bare.body.error.code, -31403);
      assert.equal(bare.body.error.data.reason, 'skill_required');
      const sent = await post(`${t.s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
      assert.equal(sent.status, 202, JSON.stringify(sent.body.error));
    } finally { await t.stop(); }
  });
});

describe('saved settings from earlier versions', () => {
  test('an entry with a retired gateway type but Whitematter settings is migrated, and routing follows it', async () => {
    const { RuntimeConfig, GatewayProfileStore } = await import('@axon-fleet/shared');
    const old = { id: 'old-gateway-id', name: 'Old A2A Gateway', kind: 'retired-gateway-type', url: 'https://gateway.example.com/a2a/org1', authScheme: 'bearer', credential: 'k', pushMode: 'auto', agentNames: 'agent-b=dealer' };
    let saved = { gateways: [{ id: 'a2a-gateway', name: 'PoC', kind: 'poc-gateway', url: 'http://localhost:4000', credential: 'x' }, old], activeGatewayId: 'old-gateway-id' };
    const runtime = new RuntimeConfig({ store: { load: () => saved, save: (v) => { saved = v; } } });
    const store = new GatewayProfileStore({ runtime, defaults: [] });
    const migrated = store.get('whitematter-a2a-gateway');
    assert.equal(migrated.kind, 'whitematter');
    assert.equal(migrated.name, 'Whitematter A2A Gateway');
    assert.equal(migrated.agentNames, 'agent-b=dealer');
    assert.equal(store.activeId(), 'whitematter-a2a-gateway');
    assert.equal(saved.gateways[1].kind, 'whitematter', 'migration is persisted');
    assert.equal(store.get('a2a-gateway').kind, 'poc-gateway', 'other entries untouched');
  });
});
