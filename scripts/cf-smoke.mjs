#!/usr/bin/env node
// End-to-end smoke test for the Cloudflare deployment (or `wrangler dev`).
//   npm run cf:smoke -- https://axon-fleet.<your-subdomain>.workers.dev
//   npm run cf:smoke                      (defaults to http://localhost:8787)
// Leaves the deployment in its default state (gateway on, built-in gateway active).
const BASE = (process.argv[2] || process.env.CF_BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const ok = (cond, label, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`); if (!cond) failures += 1; return cond; };
async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const get = (p) => call('GET', p);
const post = (p, b = {}) => call('POST', p, b);
const put = (p, b) => call('PUT', p, b);
async function waitTask(taskId, ms = 20000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const t = (await get('/agent-a/api/state')).data.tasks.find((x) => x.taskId === taskId);
    if (t && ['completed', 'failed', 'canceled'].includes(t.state)) return t;
    await sleep(800);
  }
  return null;
}
async function serviceRequest(label, expectRoute) {
  await post('/agent-a/api/telemetry', { vehicleId: 'veh-001', scenario: 'brake_wear' });
  const sent = await post('/agent-a/api/service-request', { vehicleId: 'veh-001' });
  ok(sent.status === 202, `${label}: request accepted`, sent.data?.error ?? '');
  ok(JSON.stringify(sent.data.route) === JSON.stringify(expectRoute), `${label}: route ${JSON.stringify(sent.data.route)}`);
  const t = await waitTask(sent.data.taskId);
  ok(t?.state === 'completed', `${label}: task completed`, t ? t.timeline.map((x) => x.stage).join(' → ') : 'timed out');
  return t;
}

console.log(`Smoke test against ${BASE}\n`);
ok((await get('/health')).data?.status === 'ok', 'worker health');
const cfg = await fetch(`${BASE}/config.js`).then((r) => r.text());
ok(cfg.includes(`${BASE}/agent-a`), 'dashboard config points at this hostname');
for (const p of ['/', '/agent-a.html', '/agent-b.html', '/gateway.html']) ok((await fetch(`${BASE}${p}`)).status === 200, `dashboard page ${p}`);
const cardB = (await get('/agent-b/.well-known/agent-card.json')).data;
ok(cardB.supportedInterfaces?.[0]?.url === `${BASE}/agent-b/a2a`, 'Agent B card advertises this hostname (A2A v1)');

// warm up + reset to defaults
for (const a of ['agent-a', 'agent-b']) { await post(`/${a}/api/config/reset`); await put(`/${a}/api/config`, { gatewayEnabled: true }); await post(`/${a}/api/gateways/a2a-gateway/activate`); }
let reg = [];
for (let i = 0; i < 15 && reg.length < 2; i++) { reg = (await get('/gateway/api/state')).data.agents.map((a) => a.agentId); if (reg.length < 2) await sleep(1000); }
ok(reg.includes('agent-a') && reg.includes('agent-b'), 'both agents registered at the gateway', reg.join(','));

await serviceRequest('gateway mode', ['agent-a', 'a2a-gateway', 'agent-b']);
const probe = (await post('/agent-a/api/probe', { type: 'unauthorized_skill' })).data;
ok(probe.blocked && probe.calls?.[0]?.httpStatus === 403, 'gateway blocks unauthorized skill (403)');

for (const a of ['agent-a', 'agent-b']) await put(`/${a}/api/config`, { gatewayEnabled: false });
await serviceRequest('direct mode', ['agent-a', 'agent-b']);
const probe2 = (await post('/agent-a/api/probe', { type: 'unauthorized_skill' })).data;
ok(probe2.blocked === false, 'direct mode: unauthorized skill is NOT blocked (expected)');
for (const a of ['agent-a', 'agent-b']) await put(`/${a}/api/config`, { gatewayEnabled: true });

const partner = (agent) => ({
  name: 'Partner A2A Exchange', kind: 'generic', url: `${BASE}/partner`, authScheme: 'api-key', authHeader: 'x-api-key',
  credential: `partner-key-${agent}`, inboundHeaderName: 'Authorization', inboundCredential: 'Bearer partner-forward-token', callerHeader: 'x-partner-caller',
  registerMethod: 'PUT', registerPath: '/v1/agents/{agentId}', registerBody: 'card', deregisterPath: '/v1/agents/{agentId}',
  discoverPath: '/v1/agents?skill={skill}', invokePath: '/v1/agents/{agentId}/rpc', healthPath: '/healthz', resultsPath: 'items', agentIdField: 'id', activate: true,
});
for (const a of ['agent-a', 'agent-b']) {
  await call('DELETE', `/${a}/api/gateways/partner-a2a-exchange`);
  const r = await post(`/${a}/api/gateways`, partner(a));
  ok(r.data?.gateway?.registration?.status === 'registered', `${a} registered with the third-party (partner) gateway`, r.data?.gateway?.registration?.error ?? r.data?.error?.message ?? '');
}
await serviceRequest('third-party gateway', ['agent-a', 'partner-a2a-exchange', 'agent-b']);
const curl = (await get('/agent-a/api/gateways/partner-a2a-exchange/curl')).data;
ok(curl.planned?.some((x) => x.id === 'invoke' && x.curl.includes('x-api-key: ••••')), 'equivalent curl renders with masked secrets');
for (const a of ['agent-a', 'agent-b']) { await post(`/${a}/api/gateways/a2a-gateway/activate`); await call('DELETE', `/${a}/api/gateways/partner-a2a-exchange`); }

console.log(`\n${failures ? `${failures} check(s) failed` : 'All checks passed'}`);
process.exit(failures ? 1 : 0);
