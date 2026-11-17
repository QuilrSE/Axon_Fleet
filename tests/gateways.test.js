// Custom gateway URLs and registration with a third-party A2A gateway.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startStack, waitFor, post, put, get } from './helpers.js';
import { createPartnerGateway } from '../packages/partner-gateway-mock/src/app.js';
import {
  createLogger, createGatewayAdapter, GatewayProfileStore, RuntimeConfig, controlsFor, validateProfile, maskSecret, resolveSecret,
} from '@axon-fleet/shared';

const PARTNER_KEYS = { 'agent-a': 'pk-agent-a-1234', 'agent-b': 'pk-agent-b-5678' };
const PARTNER_FWD = 'partner-forward-xyz';
const partnerProfile = (url, agent) => ({
  name: 'Partner A2A Exchange', kind: 'generic', url, authScheme: 'api-key', authHeader: 'x-api-key',
  credential: PARTNER_KEYS[agent], inboundCredential: PARTNER_FWD, callerHeader: 'x-partner-caller',
  registerMethod: 'PUT', registerPath: '/v1/agents/{agentId}', registerBody: 'card', deregisterPath: '/v1/agents/{agentId}',
  discoverPath: '/v1/agents?skill={skill}', invokePath: '/v1/agents/{agentId}/rpc', healthPath: '/healthz', resultsPath: 'items', agentIdField: 'id',
  declaredControls: ['authentication', 'sender_binding', 'audit'],
});
const del = async (url) => { const r = await fetch(url, { method: 'DELETE' }); return { status: r.status, body: await r.json() }; };

describe('gateway profiles (unit)', () => {
  test('validation rejects bad URLs, embedded credentials, missing credentials and disallowed hosts', () => {
    assert.ok(validateProfile({ name: 'x', url: 'ftp://h', kind: 'generic', credential: 'k' }).some((e) => e.includes('http')));
    assert.ok(validateProfile({ name: 'x', url: 'https://u:p@h', kind: 'generic', credential: 'k' }).some((e) => e.includes('embed')));
    assert.ok(validateProfile({ name: 'x', url: 'https://h', kind: 'generic' }).some((e) => e.includes('credential')));
    assert.deepEqual(validateProfile({ name: 'x', url: 'https://h', kind: 'generic', authScheme: 'none' }), []);
    assert.ok(validateProfile({ name: 'x', url: 'https://evil.example', kind: 'generic', credential: 'k' }, { allowlist: ['gw.corp'] }).some((e) => e.includes('ALLOWLIST')));
  });

  test('store: add, mask, keep secret on masked update, remove active falls back', () => {
    const runtime = new RuntimeConfig({ defaults: { gatewayEnabled: true } });
    const store = new GatewayProfileStore({ runtime, defaults: [{ id: 'default', name: 'PoC', kind: 'poc-gateway', url: 'http://localhost:4000', credential: 'secret-default' }] });
    const p = store.add({ name: 'Acme Gateway', url: 'https://gw.acme.example/', credential: 'acme-secret-9876' });
    assert.equal(p.id, 'acme-gateway');
    assert.equal(p.url, 'https://gw.acme.example');
    assert.equal(store.masked(p).credential, '••••9876');
    store.update(p.id, { credential: '••••9876', name: 'Acme GW' });
    assert.equal(store.get(p.id).credential, 'acme-secret-9876');
    store.setActive(p.id);
    store.remove(p.id);
    assert.equal(store.activeId(), 'default');
    assert.throws(() => store.remove('default'), /at least one/);
    assert.equal(maskSecret('env:FOO'), 'env:FOO');
    process.env.POC_TEST_SECRET = 'from-env';
    assert.equal(resolveSecret('env:POC_TEST_SECRET'), 'from-env');
  });

  test('generic adapter maps paths, auth header and result shapes', async () => {
    let seen;
    const srv = http.createServer((req, res) => {
      seen = { method: req.method, url: req.url, key: req.headers['x-api-key'] };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: { results: [{ uid: 'agent-b', name: 'B', url: 'http://b/a2a', status: 'healthy' }] } }));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const a = createGatewayAdapter({ kind: 'generic', name: 'X', url: `http://127.0.0.1:${srv.address().port}/base`, authScheme: 'api-key', authHeader: 'X-Api-Key', credential: 'k1', discoverPath: '/search?skill={skill}', resultsPath: 'data.results', agentIdField: 'uid' });
    const d = await a.discover({ skill: 'vehicle_service_orchestration' });
    assert.equal(seen.url, '/base/search?skill=vehicle_service_orchestration');
    assert.equal(seen.key, 'k1');
    assert.deepEqual(d.agents.map((x) => [x.agentId, x.health.status]), [['agent-b', 'healthy']]);
    await a.discover({});
    assert.equal(seen.url, '/base/search');
    srv.close();
  });

  test('controls reflect what a third-party gateway declares', () => {
    const c = controlsFor(true, { kind: 'generic', name: 'Partner', declaredControls: ['authentication', 'audit'] });
    assert.equal(c.find((x) => x.key === 'authentication').applied, true);
    assert.equal(c.find((x) => x.key === 'skill_authorization').applied, false);
    assert.match(c.find((x) => x.key === 'audit').enforcedBy, /not verified/);
    assert.ok(controlsFor(true, { kind: 'poc-gateway', name: 'PoC' }).filter((x) => x.applied).length === 11);
  });
});

describe('third-party gateway (integration)', () => {
  let s; let partner; let partnerUrl;
  before(async () => {
    s = await startStack();
    partner = createPartnerGateway({ apiKeys: PARTNER_KEYS, forwardToken: PARTNER_FWD, logger: createLogger('p', 'silent') });
    const { port } = await partner.start({ port: 0, host: '127.0.0.1' });
    partnerUrl = `http://127.0.0.1:${port}`;
  });
  after(async () => { await partner.stop(); await s.stop(); });

  test('gateway list masks credentials', async () => {
    const r = await get(`${s.aUrl}/api/gateways`);
    assert.equal(r.body.gateways.length, 1);
    assert.equal(r.body.gateways[0].active, true);
    assert.ok(!JSON.stringify(r.body).includes('test-gw-token-a'));
    assert.ok(r.body.meta.presets['partner-exchange-mock']);
  });

  test('invalid custom gateway URL is rejected', async () => {
    const r = await post(`${s.aUrl}/api/gateways`, { name: 'bad', url: 'not a url', kind: 'generic', credential: 'x' });
    assert.equal(r.status, 400);
    assert.match(r.body.error.message, /not valid/);
  });

  test('agents register their cards with the third-party gateway', async () => {
    const ra = await post(`${s.aUrl}/api/gateways`, partnerProfile(partnerUrl, 'agent-a'));
    const rb = await post(`${s.bUrl}/api/gateways`, partnerProfile(partnerUrl, 'agent-b'));
    assert.equal(ra.status, 201);
    assert.equal(ra.body.gateway.registration.status, 'registered');
    assert.equal(rb.body.gateway.registration.status, 'registered');
    assert.equal(ra.body.gateway.credential, '••••1234');
    assert.deepEqual([...partner.agents.keys()].sort(), ['agent-a', 'agent-b']);
    // still registered with the built-in gateway too (federated publishing)
    assert.equal(s.gateway.ctx.registry.list().length, 2);
  });

  test('test endpoint discovers through the third-party API shape', async () => {
    const r = await post(`${s.aUrl}/api/gateways/partner-a2a-exchange/test`, { skill: 'vehicle_service_orchestration' });
    assert.equal(r.body.health.ok, true);
    assert.deepEqual(r.body.discovery.agents.map((a) => a.agentId), ['agent-b']);
  });

  test('routing through the third-party gateway end to end', async () => {
    await post(`${s.aUrl}/api/gateways/partner-a2a-exchange/activate`, {});
    await post(`${s.bUrl}/api/gateways/partner-a2a-exchange/activate`, {});
    const before = s.gateway.ctx.stats.routed;
    await post(`${s.aUrl}/api/telemetry`, { vehicleId: 'veh-001', scenario: 'brake_wear' });
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body.error));
    assert.deepEqual(sent.body.route, ['agent-a', 'partner-a2a-exchange', 'agent-b']);
    await waitFor(() => s.a.agent.tasks.get(sent.body.taskId)?.state === 'completed');
    const rec = s.a.agent.tasks.get(sent.body.taskId);
    assert.ok(rec.timeline.filter((t) => t.via === 'gateway').length >= 6);
    assert.equal(s.gateway.ctx.stats.routed, before, 'built-in gateway must not see this traffic');
    const fwd = partner.audit.list().filter((e) => e.event === 'rpc_forwarded');
    assert.ok(fwd.some((e) => e.caller === 'agent-a' && e.skill === 'vehicle_service_orchestration'));
    assert.ok(fwd.some((e) => e.caller === 'agent-b' && e.skill === 'service_status_updates'));
    const bState = await get(`${s.bUrl}/api/state`);
    const task = bState.body.tasks.find((t) => t.id === sent.body.taskId);
    assert.equal(task.metadata.inbound.verifiedCaller, 'agent-a', 'caller taken from x-partner-caller');
    const mode = (await get(`${s.aUrl}/api/state`)).body.mode;
    assert.equal(mode.activeGateway.name, 'Partner A2A Exchange');
    assert.equal(mode.controls.find((c) => c.key === 'skill_authorization').applied, false);
  });

  test('controls differ: partner blocks spoofing but not unauthorized skills', async () => {
    const skill = await post(`${s.aUrl}/api/probe`, { type: 'unauthorized_skill' });
    assert.equal(skill.body.blocked, false);
    const spoof = await post(`${s.aUrl}/api/probe`, { type: 'spoofed_sender' });
    assert.equal(spoof.body.blocked, true);
  });

  test('editing with a masked credential keeps the secret', async () => {
    const r = await put(`${s.aUrl}/api/gateways/partner-a2a-exchange`, { credential: '••••1234', name: 'Partner A2A Exchange' });
    assert.equal(r.status, 200);
    assert.equal(r.body.gateways.find((g) => g.id === 'partner-a2a-exchange').registration.status, 'registered');
  });

  test('removing the active gateway deregisters and falls back to the default', async () => {
    const r = await del(`${s.aUrl}/api/gateways/partner-a2a-exchange`);
    assert.equal(r.body.activeGatewayId, 'a2a-gateway');
    await waitFor(() => !partner.agents.has('agent-a'));
    await del(`${s.bUrl}/api/gateways/partner-a2a-exchange`);
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-002' });
    assert.deepEqual(sent.body.route, ['agent-a', 'a2a-gateway', 'agent-b']);
  });

  test('unreachable custom gateway shows a failed registration', async () => {
    const r = await post(`${s.aUrl}/api/gateways`, { name: 'Down', url: 'http://127.0.0.1:1', kind: 'poc-gateway', credential: 'x' });
    assert.equal(r.status, 201);
    assert.equal(r.body.gateway.registration.status, 'failed');
    assert.equal(r.body.gateway.health.status, 'unreachable');
  });
});
