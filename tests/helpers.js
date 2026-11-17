// Spins up gateway + Agent B + Agent A in-process on ephemeral ports.
import { createGateway } from '../packages/a2a-gateway/src/app.js';
import { createAgentB } from '../packages/agent-b/src/app.js';
import { createAgentA } from '../packages/agent-a/src/app.js';
import { createLogger, sleep } from '@axon-fleet/shared';

export const TOKENS = { 'agent-a': 'test-gw-token-a', 'agent-b': 'test-gw-token-b' };
export const FORWARD = 'test-forward-token';
export const DIRECT_A = 'test-direct-a';
export const DIRECT_B = 'test-direct-b';
const silent = (name) => createLogger(name, 'silent');

export async function startStack({ rateLimit = { limit: 1000, windowMs: 10_000 }, stepDelayMs = 5 } = {}) {
  const gateway = createGateway({ logger: silent('gw'), tokens: TOKENS, forwardToken: FORWARD, rateLimit, healthIntervalMs: 0 });
  const { port: gwPort } = await gateway.start({ port: 0, host: '127.0.0.1' });
  const gatewayUrl = `http://127.0.0.1:${gwPort}`;

  const b = createAgentB({ logger: silent('b'), gatewayUrl, gatewayToken: TOKENS['agent-b'], gatewayForwardToken: FORWARD, directApiKey: DIRECT_B, agentADirectApiKey: DIRECT_A, stepDelayMs, orderProgressMs: 20, registrationIntervalMs: 60_000 });
  const { port: bPort } = await b.start({ port: 0, host: '127.0.0.1', publicHost: '127.0.0.1' });
  const bUrl = `http://127.0.0.1:${bPort}`;

  const a = createAgentA({ logger: silent('a'), gatewayUrl, gatewayToken: TOKENS['agent-a'], gatewayForwardToken: FORWARD, directApiKey: DIRECT_A, agentBDirectApiKey: DIRECT_B, agentBCardUrl: `${bUrl}/.well-known/agent-card.json`, agentBDirectUrl: `${bUrl}/a2a`, registrationIntervalMs: 60_000, burstSize: 12 });
  const { port: aPort } = await a.start({ port: 0, host: '127.0.0.1', publicHost: '127.0.0.1' });
  b.cfg.agentADirectUrl = `http://127.0.0.1:${aPort}/a2a`;

  await waitFor(() => a.gateway.connectivity.registration.status === 'registered' && b.gateway.connectivity.registration.status === 'registered');
  return {
    gateway, a, b, gatewayUrl, bUrl, aUrl: `http://127.0.0.1:${aPort}`,
    async stop() { await a.stop(); await b.stop(); await gateway.stop(); },
  };
}

export async function waitFor(fn, { timeoutMs = 5000, intervalMs = 20 } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(intervalMs);
  }
  throw new Error('waitFor timed out');
}

export async function post(url, body, headers = {}) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
export async function put(url, body) {
  const res = await fetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
export async function get(url, headers = {}) {
  const res = await fetch(url, { headers });
  return { status: res.status, body: await res.json() };
}
