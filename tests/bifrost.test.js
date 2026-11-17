// A2A v1 compatibility and Bifrost Agent Gateway integration.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startStack, waitFor, post, put, get, FORWARD } from './helpers.js';
import { createBifrostMock, STRICT_ERROR } from './mocks/bifrostMock.js';
import { buildAgentCard, v1Interfaces, validateAgentCard, toV1Task, fromV1Task, requestToV1, createEnvelope, toJsonRpc } from '@axon-fleet/shared';

const VK = 'sk-bf-test';
const BF_FWD = 'bifrost-fwd-test';
const SETUP = 'setup-123';
const tplB = JSON.parse(fs.readFileSync(new URL('../packages/agent-b/src/agent-card.json', import.meta.url)));
const rpcV1 = (url, method, params, headers = {}) => post(url, { jsonrpc: '2.0', id: `t-${method}`, method, params }, { authorization: `Bearer ${FORWARD}`, 'a2a-version': '1.0', ...headers });
const bifrostProfile = (url, extra = {}) => ({
  name: 'Bifrost', kind: 'bifrost', url, authScheme: 'api-key', authHeader: 'x-bf-vk', credential: VK, inboundCredential: BF_FWD,
  managementAuthScheme: 'setup-token', managementCredential: SETUP, allowByDefault: true, ...extra,
});

describe('A2A v1 card and wire format (unit)', () => {
  test('cards advertise a strict v1 JSONRPC interface in both card formats', () => {
    for (const format of ['dual', 'v1']) {
      const c = buildAgentCard(tplB, { baseUrl: 'http://host.docker.internal:4002', format });
      assert.deepEqual(v1Interfaces(c), [{ url: 'http://host.docker.internal:4002/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
      assert.deepEqual(validateAgentCard(c).errors, []);
    }
    const strict = buildAgentCard(tplB, { baseUrl: 'http://x', format: 'v1' });
    for (const f of ['url', 'protocolVersion', 'preferredTransport', 'additionalInterfaces']) assert.equal(strict[f], undefined);
  });
  test('a v0.3-only card has no v1 interface (the original Bifrost error)', () => {
    const old = { name: 'x', description: 'x', version: '1', protocolVersion: '0.3.0', url: 'http://x/a2a', preferredTransport: 'JSONRPC' };
    assert.equal(v1Interfaces(old).length, 0);
  });
  test('task conversion uses v1 enums and kind-less parts, and round-trips', () => {
    const t = { kind: 'task', id: 't1', contextId: 'c1', status: { state: 'input-required', timestamp: 'now', message: { kind: 'message', role: 'agent', messageId: 'm', parts: [{ kind: 'text', text: 'hi' }] } }, artifacts: [{ artifactId: 'a', name: 'n', parts: [{ kind: 'data', data: { x: 1 } }] }], metadata: { stage: 's' } };
    const v = toV1Task(t);
    assert.equal(v.kind, undefined);
    assert.equal(v.status.state, 'TASK_STATE_INPUT_REQUIRED');
    assert.equal(v.status.message.role, 'ROLE_AGENT');
    assert.deepEqual(v.status.message.parts, [{ text: 'hi' }]);
    assert.deepEqual(v.artifacts[0].parts[0], { data: { x: 1 }, mediaType: 'application/json' });
    assert.equal(fromV1Task(v).status.state, 'input-required');
  });
  test('outgoing requests map to v1 method names', () => {
    const env = createEnvelope({ sender: 'agent-a', recipient: 'agent-b', skill: 's', intent: 'i' });
    assert.equal(requestToV1(toJsonRpc('message/send', env)).method, 'SendMessage');
    assert.equal(requestToV1(toJsonRpc('message/send', env)).params.message.role, 'ROLE_USER');
    assert.equal(requestToV1(toJsonRpc('tasks/get', env)).method, 'GetTask');
    assert.equal(requestToV1(toJsonRpc('tasks/cancel', env)).method, 'CancelTask');
  });
});

describe('Agent B as an A2A v1 server (what Bifrost sends upstream)', () => {
  let s;
  before(async () => { s = await startStack(); });
  after(async () => { await s.stop(); });

  test('SendMessage (blocking) returns a completed v1 task with artifact', async () => {
    const telemetry = s.a.engine.generate('veh-001', 'brake_wear').telemetry;
    const r = await rpcV1(`${s.bUrl}/a2a`, 'SendMessage', { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Assess this vehicle' }, { data: { vehicle: { vehicleId: 'veh-001', vin: telemetry.vin }, telemetry } }] } });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const task = r.body.result.task;
    assert.equal(task.status.state, 'TASK_STATE_COMPLETED');
    assert.equal(task.kind, undefined);
    const data = task.artifacts[0].parts.find((p) => p.data).data;
    assert.equal(data.recommendation, 'service_required');
    const got = await rpcV1(`${s.bUrl}/a2a`, 'GetTask', { id: task.id });
    assert.equal(got.body.result.id, task.id);
    const list = await rpcV1(`${s.bUrl}/a2a`, 'ListTasks', { pageSize: 5 });
    assert.ok(list.body.result.tasks.some((t) => t.id === task.id));
    assert.equal(typeof list.body.result.totalSize, 'number');
    const cancel = await rpcV1(`${s.bUrl}/a2a`, 'CancelTask', { id: task.id });
    assert.equal(cancel.body.error.code, -32002);
  });

  test('lenient role names and a role of "user" are accepted', async () => {
    const telemetry = s.a.engine.generate('veh-002', 'low_tire').telemetry;
    const r = await rpcV1(`${s.bUrl}/a2a`, 'SendMessage', { message: { messageId: 'm2', role: 'user', parts: [{ data: { telemetry } }] }, configuration: { returnImmediately: true } });
    assert.equal(r.body.result.task.status.state, 'TASK_STATE_SUBMITTED');
  });

  test('helpful errors: missing data, streaming, unsupported version, push config CRUD', async () => {
    const noData = await rpcV1(`${s.bUrl}/a2a`, 'SendMessage', { message: { messageId: 'm3', role: 'ROLE_USER', parts: [{ text: 'hello' }] } });
    assert.equal(noData.body.error.code, -32602);
    assert.match(noData.body.error.message, /data part/);
    const stream = await rpcV1(`${s.bUrl}/a2a`, 'SendStreamingMessage', { message: { messageId: 'm4', role: 'ROLE_USER', parts: [{ text: 'x' }] } });
    assert.equal(stream.body.error.code, -32004);
    const v2 = await rpcV1(`${s.bUrl}/a2a`, 'GetTask', { id: 'x' }, { 'a2a-version': '2.0' });
    assert.equal(v2.body.error.code, -32009);
    const telemetry = s.a.engine.generate('veh-003', 'normal').telemetry;
    const t = (await rpcV1(`${s.bUrl}/a2a`, 'SendMessage', { message: { messageId: 'm5', role: 'ROLE_USER', parts: [{ data: { telemetry } }] }, configuration: { returnImmediately: true } })).body.result.task;
    const c = (await rpcV1(`${s.bUrl}/a2a`, 'CreateTaskPushNotificationConfig', { taskId: t.id, url: 'http://127.0.0.1:9/hook', token: 'tk' })).body.result;
    assert.ok(c.id);
    assert.equal((await rpcV1(`${s.bUrl}/a2a`, 'ListTaskPushNotificationConfigs', { taskId: t.id })).body.result.configs.length, 1);
    await rpcV1(`${s.bUrl}/a2a`, 'DeleteTaskPushNotificationConfig', { taskId: t.id, id: c.id });
    assert.equal((await rpcV1(`${s.bUrl}/a2a`, 'ListTaskPushNotificationConfigs', { taskId: t.id })).body.result.configs.length, 0);
  });

  test('Agent A rejects pushes without a token it issued', async () => {
    const r = await post(`${s.aUrl}/a2a/push`, { statusUpdate: { taskId: 'nope', contextId: 'c', status: { state: 'TASK_STATE_WORKING' } } }, { authorization: 'Bearer forged' });
    assert.equal(r.status, 401);
  });

  test('strict v1 card format still routes through the built-in gateway', async () => {
    await put(`${s.bUrl}/api/identity`, { cardFormat: 'v1' });
    const card = (await get(`${s.bUrl}/.well-known/agent-card.json`)).body;
    assert.equal(card.url, undefined);
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body.error));
    await waitFor(() => s.a.agent.tasks.get(sent.body.taskId)?.state === 'completed');
    await put(`${s.bUrl}/api/identity`, { cardFormat: 'dual' });
  });
});

describe('Bifrost Agent Gateway (emulated) end to end', () => {
  let s; let bf; let bfUrl;
  before(async () => {
    s = await startStack();
    s.a.cfg.pollIntervalMs = 400;
    bf = createBifrostMock({ setupToken: SETUP, virtualKeys: [VK] });
    bfUrl = await bf.start();
  });
  after(async () => { await bf.stop(); await s.stop(); });

  test('agents register themselves through the management API (strict v1 check passes)', async () => {
    const rb = await post(`${s.bUrl}/api/gateways`, bifrostProfile(bfUrl, { activate: true }));
    const ra = await post(`${s.aUrl}/api/gateways`, bifrostProfile(bfUrl, { activate: true }));
    assert.equal(rb.status, 201, JSON.stringify(rb.body));
    assert.equal(rb.body.gateway.registration.status, 'registered', rb.body.gateway.registration.error);
    assert.equal(rb.body.gateway.registration.mode, 'management-api');
    assert.equal(ra.body.gateway.registration.status, 'registered', ra.body.gateway.registration.error);
    assert.deepEqual([...bf.agents.keys()].sort(), ['agent-a', 'agent-b']);
    assert.equal(bf.agents.get('agent-b').runtimeHeaders.Authorization, `Bearer ${BF_FWD}`);
  });

  test('discovery reads Bifrost-served cards; work flows A → Bifrost → B with v1 calls and relayed pushes', async () => {
    await post(`${s.aUrl}/api/telemetry`, { vehicleId: 'veh-001', scenario: 'brake_wear' });
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body.error));
    assert.deepEqual(sent.body.route, ['agent-a', 'bifrost', 'agent-b']);
    assert.match(sent.body.target.endpoint, /\/agents\/a2a\/agent-b\/json-rpc$/);
    await waitFor(() => s.a.agent.tasks.get(sent.body.taskId)?.state === 'completed', { timeoutMs: 8000 });
    const rec = s.a.agent.tasks.get(sent.body.taskId);
    assert.equal(rec.result.recommendation, 'service_required');
    assert.ok(bf.log.some((e) => e.op === 'rpc' && e.method === 'SendMessage'));
    assert.ok(bf.log.filter((e) => e.op === 'push_relay' && e.status === 200).length >= 3, 'pushes relayed through Bifrost callback');
    const aState = (await get(`${s.aUrl}/api/state`)).body;
    assert.ok(aState.exchanges.some((x) => x.request?.method === 'SendMessage' && x.protocol === 'a2a-v1'));
    const bTask = (await get(`${s.bUrl}/api/state`)).body.tasks.find((t) => t.id === sent.body.taskId);
    assert.equal(bTask.metadata.inbound.via, 'gateway');
    assert.equal(bTask.metadata.inbound.gateway, 'Bifrost');
  });

  test('cancel through Bifrost', async () => {
    s.b.agent.stepDelayMs = 300;
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-002' });
    const c = await post(`${s.aUrl}/api/tasks/${sent.body.taskId}/cancel`, {});
    assert.equal(c.body.record.state, 'canceled', JSON.stringify(c.body.response));
    s.b.agent.stepDelayMs = 5;
  });

  test('manual registration: unregistered agent is reported, then verified once added in the catalog', async () => {
    bf.agents.delete('agent-b');
    const r = await put(`${s.bUrl}/api/gateways/bifrost`, { managementAuthScheme: 'none' });
    const g = r.body.gateways.find((x) => x.id === 'bifrost');
    assert.equal(g.registration.status, 'not_registered');
    assert.match(g.registration.error, /Agent Catalog/);
    assert.ok(g.warnings.some((w) => /Manual registration/.test(w.text)));
    await bf.manualRegister('agent-b', `${s.bUrl}/.well-known/agent-card.json`, `Bearer ${BF_FWD}`);
    const again = await post(`${s.bUrl}/api/gateways/bifrost/register`, {});
    assert.equal(again.body.registration.status, 'registered');
    assert.equal(again.body.registration.mode, 'verified');
  });

  test('a v0.3-only card is refused by the gateway with the original error', async () => {
    const r = await fetch(`${bfUrl}/api/agents`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-bifrost-setup-token': SETUP }, body: JSON.stringify({ name: 'old-agent', agent_card_url: `${s.gatewayUrl}/health` }) });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.message, STRICT_ERROR);
  });
});

describe('A2A Go SDK compatibility (what Bifrost decodes)', () => {
  test('security requirement scopes are arrays (a2a-go < v2.6.0 rejects {"list": []})', async () => {
    const { goSdkCardError } = await import('./mocks/bifrostMock.js');
    for (const tpl of ['agent-a', 'agent-b']) {
      const t = JSON.parse(fs.readFileSync(new URL(`../packages/${tpl}/src/agent-card.json`, import.meta.url)));
      for (const format of ['dual', 'v1']) {
        const card = buildAgentCard(t, { baseUrl: 'http://host.docker.internal:4002', format });
        assert.deepEqual(card.securityRequirements, [{ schemes: { bearer: [] } }]);
        assert.equal(goSdkCardError(card), null);
      }
    }
    const legacy = buildAgentCard({ ...tplB, securityRequirements: [{ schemes: { bearer: { list: ['read'] } } }] }, { baseUrl: 'http://x' });
    assert.deepEqual(legacy.securityRequirements, [{ schemes: { bearer: ['read'] } }], 'canonical ProtoJSON input is normalized');
    assert.match(goSdkCardError({ securityRequirements: [{ schemes: { bearer: { list: [] } } }] }), /cannot unmarshal object into Go struct field \.0\.schemes\.bearer of type a2a\.SecuritySchemeScopes/);
  });

  test('Agent B accepts a SendMessage exactly as the Go SDK encodes it', async () => {
    const s = await startStack();
    try {
      const params = JSON.parse(fs.readFileSync(new URL('./fixtures/a2a-go-sendmessage-params.json', import.meta.url)));
      const r = await rpcV1(`${s.bUrl}/a2a`, 'SendMessage', params);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const id = r.body.result.task.id;
      const cfgs = await rpcV1(`${s.bUrl}/a2a`, 'ListTaskPushNotificationConfigs', { taskId: id });
      assert.equal(cfgs.body.result.configs[0].url, 'http://127.0.0.1:9/push/callback');
      assert.equal(cfgs.body.result.configs[0].taskId, id);
    } finally { await s.stop(); }
  });
});

describe('Bifrost credential diagnostics', () => {
  let s; let bf; let bfUrl;
  before(async () => {
    s = await startStack();
    bf = createBifrostMock({ setupToken: SETUP, virtualKeys: [VK] });
    bfUrl = await bf.start();
    await bf.manualRegister('agent-a', `${s.aUrl}/.well-known/agent-card.json`, `Bearer ${BF_FWD}`);
  });
  after(async () => { await bf.stop(); await s.stop(); });

  test('unset env:BIFROST_VIRTUAL_KEY is named as the cause of a 401', async () => {
    delete process.env.POC_TEST_UNSET_VK;
    const r = await post(`${s.aUrl}/api/gateways`, bifrostProfile(bfUrl, { managementAuthScheme: 'none', managementCredential: '', credential: 'env:POC_TEST_UNSET_VK' }));
    const g = r.body.gateway;
    assert.equal(g.registration.status, 'failed');
    assert.equal(g.registration.httpStatus, 401);
    assert.match(g.registration.error, /POC_TEST_UNSET_VK is not set/);
    assert.ok(g.warnings.some((w) => /POC_TEST_UNSET_VK is not set/.test(w.text)));
  });

  test('a wrong key gets a 401-specific hint; once set correctly the registration verifies', async () => {
    process.env.POC_TEST_UNSET_VK = 'sk-bf-wrong';
    const r = await post(`${s.aUrl}/api/gateways/bifrost/register`, {});
    assert.match(r.body.registration.error, /did not accept the virtual key/);
    process.env.POC_TEST_UNSET_VK = VK;
    const ok = await post(`${s.aUrl}/api/gateways/bifrost/register`, {});
    assert.equal(ok.body.registration.status, 'registered');
    assert.equal(ok.body.registration.mode, 'verified');
    delete process.env.POC_TEST_UNSET_VK;
  });
});

describe('Bifrost → agent request authentication', () => {
  let s; let bf; let bfUrl;
  const send = () => post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
  before(async () => {
    s = await startStack();
    bf = createBifrostMock({ setupToken: SETUP, virtualKeys: [VK] });
    bfUrl = await bf.start();
    for (const [url, agentId] of [[s.bUrl, 'agent-b'], [s.aUrl, 'agent-a']]) {
      await post(`${url}/api/gateways`, bifrostProfile(bfUrl, { activate: true, managementAuthScheme: 'none', managementCredential: '' }));
      await bf.manualRegister(agentId, `${url}/.well-known/agent-card.json`, `Bearer ${BF_FWD}`);
    }
  });
  after(async () => { await bf.stop(); await s.stop(); });

  const setB = (authorization) => { bf.agents.get('agent-b').runtimeHeaders = authorization === undefined ? {} : { Authorization: authorization }; };
  const lastBRejection = async () => (await get(`${s.bUrl}/api/state`)).body.securityEvents.find((e) => e.decision === 'rejected');

  test('no request authentication on the registration → B names the missing header', async () => {
    setB(undefined);
    const r = await send();
    assert.equal(r.body.state, 'failed');
    const ev = await lastBRejection();
    assert.equal(ev.reason, 'missing_bearer_token');
    assert.match(ev.detail, /No credential header was sent.*Bifrost via Authorization/);
  });

  test('wrong token → B shows received vs expected fingerprints, never the secret', async () => {
    setB('Bearer some-other-token');
    await send();
    const ev = await lastBRejection();
    assert.equal(ev.reason, 'invalid_credentials');
    assert.match(ev.detail, /received Authorization scheme Bearer, token …oken \(16 chars\); accepted .*Bifrost via Authorization …test \(16 chars\)/);
    assert.ok(!ev.detail.includes('some-other-token') && !ev.detail.includes(BF_FWD));
  });

  for (const [label, header] of [['doubled prefix', `Bearer Bearer ${BF_FWD}`], ['bare token', BF_FWD], ['standard', `Bearer ${BF_FWD}`]]) {
    test(`${label} "Authorization" value is accepted and the task completes`, async () => {
      setB(header);
      const r = await send();
      assert.equal(r.status, 202, JSON.stringify(r.body.error));
      await waitFor(() => s.a.agent.tasks.get(r.body.taskId)?.state === 'completed', { timeoutMs: 8000 });
    });
  }
});

describe('Bifrost self-registration (management auth)', () => {
  let s; let bf; let bfUrl;
  const ADMIN = 'admin:admin-pw';
  const ops = (name) => bf.log.filter((e) => e.name === name && ['register', 'replace'].includes(e.op)).map((e) => e.op);
  before(async () => {
    s = await startStack();
    bf = createBifrostMock({ setupToken: SETUP, virtualKeys: [VK], admin: ADMIN, dashboardAuth: true });
    bfUrl = await bf.start();
  });
  after(async () => { await bf.stop(); await s.stop(); });

  test('admin username:password registers the agent; heartbeats do not re-send it', async () => {
    const r = await post(`${s.bUrl}/api/gateways`, bifrostProfile(bfUrl, { managementAuthScheme: 'basic', managementCredential: ADMIN }));
    const g = r.body.gateway;
    assert.equal(g.registration.status, 'registered', g.registration.error);
    assert.equal(g.registration.mode, 'management-api');
    assert.equal(g.registration.action, 'created');
    assert.equal(bf.agents.get('agent-b').runtimeHeaders.Authorization, `Bearer ${BF_FWD}`);
    await s.b.gateway.connectivity.registerOnce();
    await s.b.gateway.connectivity.registerOnce();
    assert.deepEqual(ops('agent-b'), ['register'], 'unchanged heartbeats only check, never re-register');
    assert.ok(bf.log.filter((e) => e.op === 'get' && e.name === 'agent-b').length >= 2);
  });

  test('a changed card URL updates the registration; "Register now" forces an update', async () => {
    await put(`${s.bUrl}/api/identity`, { advertisedBaseUrl: s.bUrl.replace('127.0.0.1', 'localhost') });
    assert.deepEqual(ops('agent-b'), ['register', 'replace']);
    assert.match(bf.agents.get('agent-b').cardUrl, /localhost/);
    const r = await post(`${s.bUrl}/api/gateways/bifrost/register`, {});
    assert.equal(r.body.registration.action, 'updated');
    await put(`${s.bUrl}/api/identity`, { advertisedBaseUrl: '' });
  });

  test('a registration deleted in Bifrost is re-created on the next heartbeat', async () => {
    bf.agents.delete('agent-b');
    await s.b.gateway.connectivity.registerOnce();
    assert.ok(bf.agents.has('agent-b'));
    assert.equal(s.b.gateway.connectivity.gatewayList().find((x) => x.id === 'bifrost').registration.action, 'created');
  });

  test('an existing manual registration is taken over (POST says exists → PUT)', async () => {
    await bf.manualRegister('agent-a', `${s.aUrl}/.well-known/agent-card.json`, 'Bearer old');
    const r = await post(`${s.aUrl}/api/gateways`, bifrostProfile(bfUrl, { managementAuthScheme: 'bearer', managementCredential: 'mk-test' }));
    assert.equal(r.body.gateway.registration.action, 'updated', r.body.gateway.registration.error);
    assert.equal(bf.agents.get('agent-a').runtimeHeaders.Authorization, `Bearer ${BF_FWD}`);
  });

  test('wrong admin password and a virtual key used as management token get specific hints', async () => {
    const bad = await put(`${s.bUrl}/api/gateways/bifrost`, { managementAuthScheme: 'basic', managementCredential: 'admin:wrong' });
    const e1 = bad.body.gateways.find((x) => x.id === 'bifrost').registration;
    assert.equal(e1.status, 'failed');
    assert.match(e1.error, /did not accept the admin credentials/);
    const vk = await put(`${s.bUrl}/api/gateways/bifrost`, { managementAuthScheme: 'bearer', managementCredential: VK });
    assert.match(vk.body.gateways.find((x) => x.id === 'bifrost').registration.error, /virtual key/);
  });
});

describe('Bifrost setup-token mode', () => {
  test('wrong setup token → 403 hint', async () => {
    const s = await startStack();
    const bf = createBifrostMock({ setupToken: SETUP, virtualKeys: [VK] });
    const bfUrl = await bf.start();
    try {
      const r = await post(`${s.bUrl}/api/gateways`, bifrostProfile(bfUrl, { managementAuthScheme: 'setup-token', managementCredential: 'nope' }));
      assert.match(r.body.gateway.registration.error, /does not match setup_token/);
      const ok = await put(`${s.bUrl}/api/gateways/bifrost`, { managementCredential: SETUP });
      assert.equal(ok.body.gateways.find((x) => x.id === 'bifrost').registration.status, 'registered');
    } finally { await bf.stop(); await s.stop(); }
  });
});
