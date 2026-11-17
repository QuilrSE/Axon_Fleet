// HTTP and HTTPS gateways on localhost, private and public networks; advertised agent URLs.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, waitFor, post, put, get } from './helpers.js';
import { createPartnerGateway } from '../packages/partner-gateway-mock/src/app.js';
import { createLogger, normalizeGatewayUrl, hostScope, validateProfile, fetchJson } from '@axon-fleet/shared';

const KEYS = { 'agent-a': 'pk-a-0001', 'agent-b': 'pk-b-0002' };
const FWD = 'pfwd-0003';

describe('URL handling (unit)', () => {
  test('http is never upgraded; scheme-less input is inferred by network scope', () => {
    assert.equal(normalizeGatewayUrl('http://gw.example.com'), 'http://gw.example.com');
    assert.equal(normalizeGatewayUrl('gw.example.com', 'http'), 'http://gw.example.com');
    assert.equal(normalizeGatewayUrl('localhost:4100'), 'http://localhost:4100');
    assert.equal(normalizeGatewayUrl('10.0.0.5:8080/a2a/'), 'http://10.0.0.5:8080/a2a');
    assert.equal(normalizeGatewayUrl('partner-gateway:4100'), 'http://partner-gateway:4100');
    assert.equal(normalizeGatewayUrl('gw.example.com'), 'https://gw.example.com');
    assert.equal(normalizeGatewayUrl('HTTP://LocalHost:4100/'), 'http://localhost:4100');
    assert.throws(() => normalizeGatewayUrl('ftp://x'), /http/);
  });
  test('host scope classification', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', 'api.localhost']) assert.equal(hostScope(h), 'loopback', h);
    for (const h of ['10.1.2.3', '172.20.0.4', '192.168.1.9', 'partner-gateway', 'gw.corp', 'svc.cluster.local', 'host.docker.internal', 'fd00::1']) assert.equal(hostScope(h), 'private', h);
    for (const h of ['8.8.8.8', 'gateway.example.com', '172.32.0.1']) assert.equal(hostScope(h), 'public', h);
  });
  test('network policy switches', () => {
    const base = { name: 'g', kind: 'generic', credential: 'k' };
    assert.deepEqual(validateProfile({ ...base, url: 'http://gw.example.com' }), []);
    assert.ok(validateProfile({ ...base, url: 'http://gw.example.com' }, { requireHttpsForPublic: true }).some((e) => e.includes('https')));
    assert.deepEqual(validateProfile({ ...base, url: 'http://localhost:1' }, { requireHttpsForPublic: true }), []);
    assert.ok(validateProfile({ ...base, url: 'http://10.0.0.1' }, { allowPrivate: false }).some((e) => e.includes('private')));
  });
  test('connection errors are explained', async () => {
    const net = await import('node:net');
    const free = await new Promise((r) => { const sv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = sv.address(); sv.close(() => r(port)); }); });
    const r = await fetchJson(`http://127.0.0.1:${free}/health`, { timeoutMs: 1500 });
    assert.equal(r.status, 0);
    assert.match(r.data.error.message, /nothing is listening/i);
    const blocked = await fetchJson('http://127.0.0.1:6000/health', { timeoutMs: 1500 });
    assert.match(blocked.data.error.message, /blocked-port/);
  });
});

describe('gateways over plain HTTP (integration)', () => {
  let s; let partner; let port;
  before(async () => {
    s = await startStack();
    partner = createPartnerGateway({ apiKeys: KEYS, forwardToken: FWD, logger: createLogger('p', 'silent') });
    ({ port } = await partner.start({ port: 0, host: '127.0.0.1' }));
  });
  after(async () => { await partner.stop(); await s.stop(); });

  const profile = (agent, url, extra = {}) => ({
    name: 'Partner HTTP', kind: 'generic', url, authScheme: 'api-key', authHeader: 'x-api-key', credential: KEYS[agent], inboundCredential: FWD,
    callerHeader: 'x-partner-caller', registerMethod: 'PUT', registerPath: '/v1/agents/{agentId}', registerBody: 'card', deregisterPath: '/v1/agents/{agentId}',
    discoverPath: '/v1/agents?skill={skill}', invokePath: '/v1/agents/{agentId}/rpc', healthPath: '/healthz', resultsPath: 'items', agentIdField: 'id', ...extra,
  });

  test('host:port without a scheme connects over http and registers', async () => {
    const r = await post(`${s.aUrl}/api/gateways`, profile('agent-a', `127.0.0.1:${port}`));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.gateway.url, `http://127.0.0.1:${port}`);
    assert.equal(r.body.gateway.network.protocol, 'http');
    assert.equal(r.body.gateway.network.scope, 'loopback');
    assert.equal(r.body.gateway.registration.status, 'registered');
  });

  test('explicit http:// plus scheme field is honored', async () => {
    const r = await post(`${s.bUrl}/api/gateways`, profile('agent-b', `localhost:${port}`, { scheme: 'http' }));
    assert.equal(r.body.gateway.url, `http://localhost:${port}`);
    assert.equal(r.body.gateway.registration.status, 'registered');
  });

  test('https:// against an http-only gateway explains the fix', async () => {
    const r = await post(`${s.aUrl}/api/gateways`, profile('agent-a', `https://127.0.0.1:${port}`, { name: 'Wrong scheme' }));
    assert.equal(r.body.gateway.registration.status, 'failed');
    assert.match(r.body.gateway.registration.error, /does not speak HTTPS|use http/i);
  });

  test('route end to end through an http gateway', async () => {
    await post(`${s.aUrl}/api/gateways/partner-http/activate`, {});
    await post(`${s.bUrl}/api/gateways/partner-http/activate`, {});
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-001' });
    assert.equal(sent.status, 202, JSON.stringify(sent.body.error));
    await waitFor(() => s.a.agent.tasks.get(sent.body.taskId)?.state === 'completed');
    await post(`${s.aUrl}/api/gateways/a2a-gateway/activate`, {});
    await post(`${s.bUrl}/api/gateways/a2a-gateway/activate`, {});
  });

  test('identity API exposes copyable URLs and suggestions', async () => {
    const id = (await get(`${s.aUrl}/api/identity`)).body;
    assert.equal(id.cardUrl, `${s.aUrl}/.well-known/agent-card.json`);
    assert.equal(id.a2aEndpoint, `${s.aUrl}/a2a`);
    assert.ok(id.suggestions.some((x) => x.url.includes('host.docker.internal')));
    assert.equal(id.peer.cardUrl.endsWith('/.well-known/agent-card.json'), true);
  });

  test('advertised URL changes the Agent Card and re-registers with every gateway', async () => {
    const r = await put(`${s.bUrl}/api/identity`, { advertisedBaseUrl: s.bUrl.replace('127.0.0.1', 'localhost') });
    assert.equal(r.status, 200);
    assert.equal(r.body.cardUrl, `${s.bUrl.replace('127.0.0.1', 'localhost')}/.well-known/agent-card.json`);
    const card = (await get(`${s.bUrl}/.well-known/agent-card.json`)).body;
    assert.equal(card.url, `${s.bUrl.replace('127.0.0.1', 'localhost')}/a2a`);
    assert.equal(s.gateway.ctx.registry.get('agent-b').card.url, card.url);
    assert.equal(partner.agents.get('agent-b').card.url, card.url);
    const bad = await put(`${s.bUrl}/api/identity`, { advertisedBaseUrl: 'ftp://x' });
    assert.equal(bad.status, 400);
    await put(`${s.bUrl}/api/identity`, { advertisedBaseUrl: '' });
    assert.equal((await get(`${s.bUrl}/.well-known/agent-card.json`)).body.url, `${s.bUrl}/a2a`);
  });

  test('loopback agent URL + non-local gateway produces a reachability warning', async () => {
    const r = await post(`${s.aUrl}/api/gateways`, { name: 'Remote', kind: 'poc-gateway', url: 'http://10.255.255.1:4000', credential: 'x', registerEnabled: false });
    const w = r.body.gateway.warnings.map((x) => x.text).join(' ');
    assert.match(w, /cannot reach this agent/);
    const pub = await post(`${s.aUrl}/api/gateways`, { name: 'Public plain', kind: 'poc-gateway', url: 'http://gw.example.com', credential: 'x', registerEnabled: false });
    assert.match(pub.body.gateway.warnings.map((x) => x.text).join(' '), /not encrypted/);
  });

  test('direct-mode peer card URL is configurable on Agent A', async () => {
    await put(`${s.aUrl}/api/identity`, { peerCardUrl: s.bUrl.replace('http://', '') });
    const check = await post(`${s.aUrl}/api/identity/check-peer`, {});
    assert.equal(check.body.ok, true);
    assert.equal(check.body.url, `${s.bUrl}/.well-known/agent-card.json`);
    await put(`${s.aUrl}/api/config`, { gatewayEnabled: false });
    await put(`${s.bUrl}/api/config`, { gatewayEnabled: false });
    const sent = await post(`${s.aUrl}/api/service-request`, { vehicleId: 'veh-002' });
    assert.equal(sent.body.mode, 'direct');
    assert.match(sent.body.target.method, new RegExp(s.bUrl.replace(/[.]/g, '\\.')));
    await put(`${s.aUrl}/api/identity`, { peerCardUrl: '' });
  });
});
