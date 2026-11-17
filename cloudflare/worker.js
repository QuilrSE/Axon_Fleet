// Cloudflare Workers entry point for the Axon Fleet.
//
// One Worker serves everything on one hostname:
//   /                       dashboard (Workers static assets: packages/web-dashboard/public)
//   /config.js              dashboard config (service URLs for this hostname)
//   /gateway/*              PoC A2A Gateway & Agent Registry   → Durable Object GatewayService
//   /agent-a/*              In-vehicle telemetry agent         → Durable Object AgentAService
//   /agent-b/*              Dealership orchestration agent     → Durable Object AgentBService
//   /partner/*              Mock third-party gateway           → Durable Object PartnerGatewayService
//
// Each service is the same Express-style app as on Node.js (see cloudflare/shims), running inside a
// single Durable Object instance so its in-memory state, timers and background tasks behave as one
// long-lived server. Runtime config (gateway toggle, gateway profiles, advertised URL) is persisted in
// Durable Object storage.
import { DurableObject } from 'cloudflare:workers';
import { createGateway } from '../packages/a2a-gateway/src/app.js';
import { createAgentA } from '../packages/agent-a/src/app.js';
import { createAgentB } from '../packages/agent-b/src/app.js';
import { createPartnerGateway } from '../packages/partner-gateway-mock/src/app.js';
import { createLogger, envStr, envInt, envBool, parseTokenMap, applyDemoEnvDefaults } from '@axon-fleet/shared';

const SERVICES = { gateway: 'GATEWAY', 'agent-a': 'AGENT_A', 'agent-b': 'AGENT_B', partner: 'PARTNER' };
const PREFIX_RE = /^\/(gateway|agent-a|agent-b|partner)(\/.*)?$/;
const IDLE_MS = 10 * 60 * 1000;

/** Copy Worker vars/secrets into process.env (the services read configuration from it). */
function applyEnv(env) {
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && process.env[k] === undefined) process.env[k] = v;
  applyDemoEnvDefaults();
}

/** Forward a request for /<service>/... to that service's Durable Object. */
function toService(env, origin, url, init) {
  const u = new URL(url);
  const m = PREFIX_RE.exec(u.pathname);
  if (!m) return null;
  const ns = env[SERVICES[m[1]]];
  const stub = ns.get(ns.idFromName(m[1]));
  const inner = new URL(`${m[2] ?? '/'}${u.search}`, 'https://service.internal');
  const req = new Request(inner, init);
  req.headers.set('x-poc-origin', origin);
  return stub.fetch(req);
}

/** Calls from one service to another on this Worker's hostname stay inside the Worker. */
function installInternalFetch(env) {
  globalThis.__A2A_INTERNAL_FETCH__ = async (url, init) => {
    const origin = globalThis.__A2A_ORIGIN__;
    if (!origin) return null;
    let u;
    try { u = new URL(url); } catch { return null; }
    if (u.origin !== origin) return null;
    return toService(env, origin, url, init);
  };
}

const configJs = (origin) => `window.POC_CONFIG = ${JSON.stringify({ agentAUrl: `${origin}/agent-a`, agentBUrl: `${origin}/agent-b`, gatewayUrl: `${origin}/gateway`, partnerUrl: `${origin}/partner`, platform: 'cloudflare-workers' })};`;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = (env.PUBLIC_BASE_URL || url.origin).replace(/\/$/, '');
    if (url.pathname === '/config.js') return new Response(configJs(origin), { headers: { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    if (url.pathname === '/health') return Response.json({ status: 'ok', service: 'axon-fleet', platform: 'cloudflare-workers', origin });
    const routed = toService(env, origin, request.url, request);
    if (routed) return routed;
    if (!env.ASSETS) return new Response('Not found', { status: 404 });
    if (url.pathname === '/') return env.ASSETS.fetch(new Request(new URL('/index.html', url), request));
    return env.ASSETS.fetch(request);
  },
};

// Log promise rejections nothing handled, with their reason (empty reasons included).
globalThis.addEventListener?.('unhandledrejection', (ev) => {
  const r = ev.reason;
  console.error(JSON.stringify({ level: 'error', msg: 'unhandled_rejection', reason: r instanceof Error ? r.message : String(r), stack: r?.stack ?? null }));
});

/** Base class: lazily builds the service for this hostname, persists runtime config, pauses timers when idle. */
class ServiceObject extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    applyEnv(env);
    installInternalFetch(env);
    this.svc = null;
    this.saved = null;
    this.lastSeen = Date.now();
    this.paused = false;
    ctx.blockConcurrencyWhile(async () => {
      this.saved = (await ctx.storage.get('runtime')) ?? null;
      this.origin = (await ctx.storage.get('origin')) ?? null;
    });
  }

  runtimeStore() {
    return {
      load: () => this.saved,
      save: (values) => { this.saved = values; this.ctx.storage.put('runtime', values); },
    };
  }

  async fetch(request) {
    const origin = (this.env.PUBLIC_BASE_URL || request.headers.get('x-poc-origin') || this.origin || '').replace(/\/$/, '');
    if (!origin) return Response.json({ error: { message: 'Unknown public origin; set PUBLIC_BASE_URL' } }, { status: 500 });
    globalThis.__A2A_ORIGIN__ = origin;
    if (origin !== this.origin) { this.origin = origin; this.ctx.storage.put('origin', origin); }
    if (!this.svc) {
      this.svc = this.build(origin, this.env);
      this.startTimers();
      this.idleTimer = setInterval(() => this.checkIdle(), 60_000);
    }
    this.lastSeen = Date.now();
    if (this.paused) { this.paused = false; this.startTimers(); }
    return this.svc.app.fetch(request);
  }

  /** Background heartbeats only run while someone uses the service, so idle objects can be evicted. */
  checkIdle() {
    if (!this.paused && Date.now() - this.lastSeen > IDLE_MS) { this.paused = true; this.stopTimers(); }
  }
  startTimers() {}
  stopTimers() {}
}

const logger = (name) => createLogger(name, envStr('LOG_LEVEL', 'info'));

export class GatewayService extends ServiceObject {
  build() {
    return createGateway({
      logger: logger('a2a-gateway'),
      authMode: envStr('AUTH_MODE', 'static'),
      tokens: parseTokenMap(envStr('GATEWAY_AGENT_TOKENS', 'agent-a:poc-gw-token-agent-a,agent-b:poc-gw-token-agent-b')),
      forwardToken: envStr('GATEWAY_FORWARD_TOKEN', 'poc-gw-forward-token'),
      extraSecrets: [envStr('AGENT_A_DIRECT_API_KEY'), envStr('AGENT_B_DIRECT_API_KEY')],
      rateLimit: { limit: envInt('RATE_LIMIT_MAX', 20), windowMs: envInt('RATE_LIMIT_WINDOW_MS', 10_000) },
      healthIntervalMs: envInt('HEALTH_CHECK_INTERVAL_MS', 15_000),
      corsOrigins: envStr('CORS_ORIGINS', '*'),
    });
  }
  startTimers() { this.svc.ctx.registry.startHealthChecks(); }
  stopTimers() { this.svc.ctx.registry.stopHealthChecks(); }
}

const agentCommon = (store) => ({
  gatewayForwardToken: envStr('GATEWAY_FORWARD_TOKEN', 'poc-gw-forward-token'),
  gatewayDefaultEnabled: envBool('GATEWAY_DEFAULT_ENABLED', true),
  registrationIntervalMs: envInt('REGISTRATION_INTERVAL_MS', 30_000),
  runtimeStore: store,
  corsOrigins: envStr('CORS_ORIGINS', '*'),
  cardFormat: envStr('AGENT_CARD_FORMAT', 'dual'),
  allowSecretReveal: envBool('DASHBOARD_ALLOW_SECRET_REVEAL', true),
  allowPrivateGateways: envBool('GATEWAY_ALLOW_PRIVATE_NETWORKS', true),
  requireHttpsForPublicGateways: envBool('GATEWAY_REQUIRE_HTTPS_FOR_PUBLIC', false),
  gatewayUrlAllowlist: envStr('GATEWAY_URL_ALLOWLIST', '').split(',').map((h) => h.trim()).filter(Boolean),
});

export class AgentAService extends ServiceObject {
  build(origin) {
    return createAgentA({
      ...agentCommon(this.runtimeStore()),
      logger: logger('agent-a'),
      baseUrl: `${origin}/agent-a`,
      gatewayUrl: `${origin}/gateway`,
      gatewayToken: envStr('AGENT_A_GATEWAY_TOKEN', 'poc-gw-token-agent-a'),
      directApiKey: envStr('AGENT_A_DIRECT_API_KEY', 'poc-direct-key-agent-a'),
      agentBDirectApiKey: envStr('AGENT_B_DIRECT_API_KEY', 'poc-direct-key-agent-b'),
      agentBCardUrl: `${origin}/agent-b/.well-known/agent-card.json`,
      agentBDirectUrl: `${origin}/agent-b/a2a`,
      telemetrySeed: envInt('TELEMETRY_SEED', 42),
    });
  }
  startTimers() { this.svc.gateway.connectivity.start(); }
  stopTimers() { this.svc.gateway.connectivity.stop(); }
}

export class AgentBService extends ServiceObject {
  build(origin) {
    return createAgentB({
      ...agentCommon(this.runtimeStore()),
      logger: logger('agent-b'),
      baseUrl: `${origin}/agent-b`,
      gatewayUrl: `${origin}/gateway`,
      gatewayToken: envStr('AGENT_B_GATEWAY_TOKEN', 'poc-gw-token-agent-b'),
      directApiKey: envStr('AGENT_B_DIRECT_API_KEY', 'poc-direct-key-agent-b'),
      agentADirectApiKey: envStr('AGENT_A_DIRECT_API_KEY', 'poc-direct-key-agent-a'),
      agentADirectUrl: `${origin}/agent-a/a2a`,
      stepDelayMs: envInt('AGENT_B_STEP_DELAY_MS', 900),
    });
  }
  startTimers() { this.svc.gateway.connectivity.start(); }
  stopTimers() { this.svc.gateway.connectivity.stop(); }
}

export class PartnerGatewayService extends ServiceObject {
  build() {
    return createPartnerGateway({
      logger: logger('partner-gateway'),
      apiKeys: parseTokenMap(envStr('PARTNER_GATEWAY_API_KEYS', 'agent-a:partner-key-agent-a,agent-b:partner-key-agent-b')),
      forwardToken: envStr('PARTNER_GATEWAY_FORWARD_TOKEN', 'partner-forward-token'),
      corsOrigins: envStr('CORS_ORIGINS', '*'),
    });
  }
}
