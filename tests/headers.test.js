// Explicit header name/value configuration and "equivalent curl" output.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startStack, waitFor, post, put, get } from './helpers.js';
import { createBifrostMock } from './mocks/bifrostMock.js';
import { toCurl, quoteArg, secretSources, classifyInbound, inboundAuth } from '@axon-fleet/shared';

const VK = 'sk-bf-test';
const SETUP = 'setup-123';
// Async so the in-process servers can answer while the shell runs curl.
const sh = async (cmd, env = {}) => (await promisify(execFile)('sh', ['-c', cmd], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 15000 })).stdout;

describe('curl rendering (unit)', () => {
  test('env secrets become ${VAR}, literal secrets are masked unless revealed, quotes are safe', async () => {
    process.env.T_VK = 'sk-bf-abcdef123';
    const p = { authScheme: 'api-key', authHeader: 'x-bf-vk', credential: 'env:T_VK', inboundCredential: "lit'eral-9876", managementAuthScheme: 'basic', managementCredential: 'env:T_ADMIN' };
    process.env.T_ADMIN = 'admin:pw';
    const src = secretSources(p);
    const c = toCurl({ method: 'post', url: 'http://h/x', headers: { 'x-bf-vk': 'sk-bf-abcdef123', 'X-Agent': "lit'eral-9876", Authorization: `Basic ${Buffer.from('admin:pw').toString('base64')}` } }, { sources: src });
    assert.match(c, /-H "x-bf-vk: \$\{T_VK\}"/);
    assert.match(c, /-H 'X-Agent: ••••9876'/);
    assert.match(c, /Basic \$\(printf '%s' "\$T_ADMIN" \| base64/);
    assert.ok(!c.includes('sk-bf-abcdef123') && !c.includes('lit\'eral'));
    const r = toCurl({ method: 'GET', url: 'http://h', headers: { 'X-Agent': "lit'eral-9876" } }, { sources: src, reveal: true });
    assert.equal(await sh(`printf '%s' ${quoteArg("lit'eral-9876", [], {})}`), "lit'eral-9876");
    assert.match(r, /X-Agent: lit'\\''eral-9876/);
    const b64 = await sh(`printf '%s' "$(printf '%s' "$T_ADMIN" | base64 | tr -d '\\n')"`);
    assert.equal(b64, Buffer.from('admin:pw').toString('base64'));
  });

  test('inbound auth: custom header exact match, non-Bearer Authorization, helpful rejection', () => {
    const creds = [
      { header: 'x-agent-secret', headerName: 'X-Agent-Secret', value: 'super-secret-1', profileId: 'g1', name: 'GW1' },
      { header: 'authorization', headerName: 'Authorization', value: 'Basic Z3c6cHc=', profileId: 'g2', name: 'GW2' },
    ];
    assert.equal(classifyInbound({ headers: { 'x-agent-secret': 'super-secret-1' } }, { gatewayCredentials: creds, gatewayEnabled: true }).gateway.id, 'g1');
    assert.equal(classifyInbound({ headers: { authorization: 'Basic Z3c6cHc=' } }, { gatewayCredentials: creds, gatewayEnabled: true }).gateway.id, 'g2');
    const bad = classifyInbound({ headers: { 'x-agent-secret': 'nope-0000' } }, { gatewayCredentials: creds, gatewayEnabled: true });
    assert.equal(bad.status, 401);
    assert.match(bad.message, /received X-Agent-Secret …0000/);
    assert.ok(!bad.message.includes('super-secret-1'));
    assert.deepEqual(inboundAuth({ inboundCredential: 'tok' }), { name: 'Authorization', value: 'Bearer tok', ref: 'tok' });
    assert.deepEqual(inboundAuth({ inboundHeaderName: 'X-K', inboundCredential: 'v' }), { name: 'X-K', value: 'v', ref: 'v' });
  });
});

describe('explicit headers + equivalent curl against Bifrost (emulated)', () => {
  let s; let bf; let bfUrl;
  const profile = (url) => ({
    name: 'Bifrost', kind: 'bifrost', url,
    authScheme: 'api-key', authHeader: 'x-bf-vk', credential: VK,                     // agent → gateway, literal value
    inboundHeaderName: 'X-Agent-Secret', inboundCredential: 'super-secret-1',          // gateway → agent, literal value
    managementAuthScheme: 'header', managementHeaderName: 'X-Bifrost-Setup-Token', managementCredential: SETUP,
    extraHeaders: [{ name: 'X-Tenant', value: 'acme-tenant' }],
    allowByDefault: true, activate: true,
  });
  before(async () => {
    s = await startStack();
    bf = createBifrostMock({ setupToken: SETUP, virtualKeys: [VK] });
    bfUrl = await bf.start();
    for (const u of [s.bUrl, s.aUrl]) {
      const r = await post(`${u}/api/gateways`, profile(bfUrl));
      assert.equal(r.body.gateway.registration.status, 'registered', r.body.gateway.registration.error);
    }
  });
  after(async () => { await bf.stop(); await s.stop(); });

  test('registration sends the custom gateway → agent header; requests flow end to end', async () => {
    assert.deepEqual(bf.agents.get('agent-b').runtimeHeaders, { 'X-Agent-Secret': 'super-secret-1' });
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body.error));
    await waitFor(() => s.a.agent.tasks.get(sent.body.taskId)?.state === 'completed', { timeoutMs: 8000 });
    const rpc = bf.log.find((e) => e.op === 'rpc' && e.method === 'SendMessage');
    assert.equal(rpc.headers['x-tenant'], 'acme-tenant');
    assert.equal(rpc.headers['x-bf-vk'], VK);
    const bTask = (await get(`${s.bUrl}/api/state`)).body.tasks.find((t) => t.id === sent.body.taskId);
    assert.equal(bTask.metadata.inbound.gateway, 'Bifrost');
  });

  test('curl view: planned, sent and received requests with masked secrets', async () => {
    const c = (await get(`${s.aUrl}/api/gateways/bifrost/curl`)).body;
    const ids = c.planned.map((x) => x.id);
    assert.deepEqual(ids, ['health', 'register', 'discover', 'invoke', 'inbound']);
    const reg = c.planned.find((x) => x.id === 'register').curl;
    assert.match(reg, /-X POST '.*\/api\/agents'/);
    assert.match(reg, /X-Bifrost-Setup-Token: ••••-123/);
    assert.match(reg, /"X-Agent-Secret":"••••et-1"/);
    const inv = c.planned.find((x) => x.id === 'invoke').curl;
    assert.match(inv, /x-bf-vk: ••••test/);
    assert.match(inv, /X-Tenant: ••••nant/);
    assert.match(inv, /A2A-Version: 1.0/);
    assert.match(c.planned.find((x) => x.id === 'inbound').curl, /X-Agent-Secret: ••••et-1/);
    assert.ok(c.sent.some((x) => x.op === 'invoke' && /json-rpc/.test(x.curl)));
    assert.ok(c.sent.some((x) => x.op === 'register'));
    const json = JSON.stringify(c);
    for (const secret of [VK, SETUP, 'super-secret-1', 'acme-tenant']) assert.ok(!json.includes(secret), `leaked ${secret}`);
    const b = (await get(`${s.bUrl}/api/gateways/bifrost/curl`)).body;
    assert.match(b.inbound.curl, /x-agent-secret: ••••et-1/, 'B shows what Bifrost actually sent it');
  });

  test('revealed curl commands actually work: through Bifrost, and Bifrost → agent', async () => {
    const c = (await get(`${s.aUrl}/api/gateways/bifrost/curl?reveal=1`)).body;
    assert.equal(c.revealed, true);
    const viaGateway = JSON.parse(await sh(c.planned.find((x) => x.id === 'invoke').curl));
    assert.equal(viaGateway.error.code, -32001, JSON.stringify(viaGateway));      // authenticated, task not found
    const direct = JSON.parse(await sh(c.planned.find((x) => x.id === 'inbound').curl));
    assert.equal(direct.error.code, -32001, JSON.stringify(direct));
    const verify = JSON.parse(await sh(c.planned.find((x) => x.id === 'discover').curl));
    assert.ok(verify.supportedInterfaces?.length);
  });

  test('env-sourced values render as ${VAR} and run in a shell with the variable set', async () => {
    process.env.T_BF_VK = VK;
    await put(`${s.aUrl}/api/gateways/bifrost`, { credential: 'env:T_BF_VK' });
    const c = (await get(`${s.aUrl}/api/gateways/bifrost/curl?reveal=1`)).body;
    const cmd = c.planned.find((x) => x.id === 'invoke').curl;
    assert.match(cmd, /x-bf-vk: \$\{T_BF_VK\}/);
    assert.equal(JSON.parse(await sh(cmd, { T_BF_VK: VK })).error.code, -32001);
    assert.deepEqual(c.envSecrets, ['T_BF_VK']);
  });

  test('rejected inbound requests are shown with fingerprints only', async () => {
    await post(`${s.bUrl}/a2a`, { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }, { 'x-agent-secret': 'wrong-secret-zzzz' });
    const b = (await get(`${s.bUrl}/api/gateways/bifrost/curl?reveal=1`)).body;
    assert.match(b.rejected.curl, /x-agent-secret: <received …zzzz, 17 chars>/);
    assert.ok(!JSON.stringify(b.rejected).includes('wrong-secret-zzzz'));
  });

  test('live preview for an unsaved form, and validation of header names/values', async () => {
    const r = await post(`${s.aUrl}/api/gateways/curl-preview`, { name: 'Draft', kind: 'generic', url: 'gw.example.com', authScheme: 'api-key', authHeader: 'X-Api-Key', credential: 'k-123456' });
    assert.deepEqual(r.body.errors, []);
    assert.match(r.body.planned.find((x) => x.id === 'invoke').curl, /https:\/\/gw\.example\.com.*\n.*X-Api-Key: ••••3456/);
    const bad = await post(`${s.aUrl}/api/gateways`, { name: 'Bad', kind: 'generic', url: 'http://x', authScheme: 'api-key', authHeader: 'X-K', credential: 'a\r\nInjected: 1' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /line breaks/);
    const reserved = await post(`${s.aUrl}/api/gateways`, { name: 'Bad2', kind: 'generic', url: 'http://x', authScheme: 'none', extraHeaders: [{ name: 'Host', value: 'evil' }] });
    assert.match(reserved.body.error.message, /managed by the agent/);
    const keep = await put(`${s.aUrl}/api/gateways/bifrost`, { extraHeaders: [{ name: 'X-Tenant', value: '••••nant' }] });
    assert.equal(keep.status, 200);
    assert.equal(s.a.gateway.connectivity.profiles.get('bifrost').extraHeaders[0].value, 'acme-tenant', 'masked value keeps the stored secret');
  });
});
