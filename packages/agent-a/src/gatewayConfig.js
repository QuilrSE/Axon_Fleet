// Agent A communication mode: discovery + outbound calls go through the ACTIVE gateway profile
// (built-in or third-party) or directly to Agent B, switched at runtime without a restart.
import {
  AgentConnectivity, RuntimeConfig, callDirect, fetchAgentCard, getSkill, nowIso, readEnvelope, HttpError, cardEndpoint,
  requestToV1, responseFromV1, newId, hostScope,
  WM_REQUEST_ID_HEADER,
} from '@axon-fleet/shared';

export const SERVICE_SKILL = 'vehicle_service_orchestration';

export function defaultGatewayProfile(cfg) {
  return { id: 'a2a-gateway', name: 'PoC A2A Gateway', kind: 'poc-gateway', url: cfg.gatewayUrl, authScheme: 'bearer', credential: cfg.gatewayToken, inboundCredential: cfg.gatewayForwardToken, registerEnabled: true };
}

export function createGatewayConfig({ cfg, getCard, getBaseUrl, logger, exchanges, securityEvents }) {
  const runtime = new RuntimeConfig({ store: cfg.runtimeStore, defaults: { gatewayEnabled: cfg.gatewayDefaultEnabled }, logger });
  const connectivity = new AgentConnectivity({
    agentId: cfg.agentId,
    getCard,
    getCardUrl: () => `${getBaseUrl()}/.well-known/agent-card.json`,
    runtime,
    defaultGateway: defaultGatewayProfile(cfg),
    allowlist: cfg.gatewayUrlAllowlist ?? [],
    peerAgentId: cfg.agentBId ?? 'agent-b',
    allowReveal: cfg.allowSecretReveal ?? true,
    allowPrivate: cfg.allowPrivateGateways ?? true,
    requireHttpsForPublic: cfg.requireHttpsForPublicGateways ?? false,
    registrationIntervalMs: cfg.registrationIntervalMs,
    logger,
  });
  let lastDiscovery = null;
  const peerCardUrl = () => runtime.get('peerCardUrl') || cfg.agentBCardUrl;
  const peerDirectUrl = () => (runtime.get('peerCardUrl') ? `${new URL(runtime.get('peerCardUrl')).origin}/a2a` : cfg.agentBDirectUrl);

  async function discover() {
    if (connectivity.enabled) {
      const gw = connectivity.active;
      const adapter = connectivity.adapter(gw);
      const res = await adapter.discover({ skill: SERVICE_SKILL });
      if (!res.ok) throw new HttpError(502, 'DISCOVERY_FAILED', `Discovery at '${gw.name}' failed: ${res.data?.error?.message ?? res.data?.message ?? `HTTP ${res.status}`}`);
      const candidates = res.agents.filter((a) => a.agentId !== cfg.agentId);
      const pick = candidates.find((a) => a.health?.status === 'healthy') ?? candidates[0];
      if (!pick) {
        throw new HttpError(404, 'NO_AGENT', gw.kind === 'whitematter'
          ? `No agent with skill '${SERVICE_SKILL}' is visible to this caller key at '${gw.name}'. Whitematter only shows agents the caller has a grant for: check the caller's grants in the Whitematter console and the agent slugs on this gateway.`
          : `No agent with skill '${SERVICE_SKILL}' is registered at '${gw.name}'`);
      }
      lastDiscovery = {
        mode: 'gateway', gatewayId: gw.id, gatewayName: gw.name, method: `Registry lookup at ${gw.name} (skill = ${SERVICE_SKILL})`, at: nowIso(),
        agentId: pick.agentId, name: pick.name, provider: pick.provider, health: pick.health?.status,
        endpoint: adapter.invokeUrl(pick.agentId), cardUrl: pick.agentCardUrl, candidates: candidates.length,
      };
    } else {
      const res = await fetchAgentCard(peerCardUrl());
      if (!res.ok) throw new HttpError(502, 'DISCOVERY_FAILED', `Could not fetch Agent B's card at ${res.url}: ${res.data?.error?.message ?? `HTTP ${res.status}`}`);
      if (!getSkill(res.data, SERVICE_SKILL)) throw new HttpError(422, 'SKILL_MISSING', `Agent card at ${res.url} does not advertise '${SERVICE_SKILL}'`);
      lastDiscovery = {
        mode: 'direct', method: `Direct Agent Card fetch (${peerCardUrl()})`, at: nowIso(),
        agentId: cfg.agentBId, name: res.data.name, provider: res.data.provider?.organization,
        endpoint: cardEndpoint(res.data), cardUrl: res.url, candidates: 1,
      };
    }
    return lastDiscovery;
  }

  // A2A v1 push notifications: per-request bearer tokens that the webhook (/a2a/push) accepts.
  const pushTokens = new Map(); // token -> { taskId|null, createdAt }
  function issuePushConfig() {
    const token = newId('ptok');
    pushTokens.set(token, { taskId: null, createdAt: Date.now() });
    if (pushTokens.size > 500) pushTokens.delete(pushTokens.keys().next().value);
    return { url: `${getBaseUrl()}/a2a/push`, token, authentication: { scheme: 'Bearer', credentials: token } };
  }
  /** Validate a webhook delivery: known token, bound to one task id. */
  function acceptPushToken(token, taskId) {
    const t = token && pushTokens.get(token);
    if (!t) return { ok: false, reason: 'unknown_push_token' };
    if (t.taskId && taskId && t.taskId !== taskId) return { ok: false, reason: 'token_bound_to_other_task' };
    if (taskId) t.taskId = taskId;
    return { ok: true };
  }

  // Push webhooks per gateway. Whitematter only delivers to HTTPS webhooks on public addresses and answers
  // -32003 when push is off for the organization; in those cases Agent A polls GetTask instead.
  const pushOffFor = new Set();
  function pushAllowed(profile) {
    if (pushOffFor.has(profile.id)) return false;
    const mode = profile.pushMode ?? 'auto';
    if (mode === 'off') return false;
    if (mode === 'on' || profile.kind !== 'whitematter') return true;
    const u = new URL(`${getBaseUrl()}/a2a/push`);
    return (u.protocol === 'https:' && hostScope(u.hostname) === 'public') || process.env.WHITEMATTER_ALLOW_INSECURE_WEBHOOK === 'true';
  }

  /** Send a JSON-RPC request to a discovered agent through whichever path is active. */
  async function call(target, rpc, { kind = 'request', credentialOverride } = {}) {
    const viaGateway = connectivity.enabled;
    const adapter = viaGateway ? connectivity.adapter() : null;
    const v1 = adapter?.protocol === 'a2a-v1';
    let wire = rpc;
    let pushCfg = null;
    const whitematter = adapter?.profile?.kind === 'whitematter';
    let pushNote = null;
    if (v1) {
      const wantPush = rpc.method === 'message/send' && kind === 'service_request';
      pushCfg = wantPush && pushAllowed(adapter.profile) ? issuePushConfig() : undefined;
      if (wantPush && !pushCfg) pushNote = 'no push webhook attached (status is polled)';
      wire = requestToV1(rpc, { pushConfig: pushCfg ?? undefined, omitContextId: whitematter });
    }
    let res = viaGateway
      ? await adapter.invoke(target.agentId, wire, { credentialOverride })
      : await callDirect({ endpoint: target.mode === 'direct' ? target.endpoint : peerDirectUrl(), apiKey: credentialOverride ?? cfg.agentBDirectApiKey, rpc });
    if (v1 && pushCfg && res.data?.error?.code === -32003) {
      // Push notifications are off at the gateway: resend without a webhook and poll instead.
      pushOffFor.add(adapter.profile.id);
      securityEvents.push({ timestamp: nowIso(), direction: 'outbound', kind, mode: 'gateway', gateway: adapter.profile.name, decision: 'push_disabled', severity: 'info', detail: `${adapter.profile.name} has push notifications turned off (-32003); resending without a webhook and polling GetTask.` });
      pushCfg = null;
      pushNote = 'push is off at the gateway (-32003); resent without a webhook, status is polled';
      wire = requestToV1(rpc, { omitContextId: whitematter });
      res = await adapter.invoke(target.agentId, wire, { credentialOverride });
    }
    const rawBody = res.data;
    if (v1) {
      res = { ...res, data: responseFromV1(rpc.method, res.data), protocol: 'a2a-v1' };
      if (pushCfg && res.data?.result?.id) pushTokens.get(pushCfg.token).taskId = res.data.result.id;
    }
    const env = readEnvelope(rpc);
    const rpcErr = res.data?.error;
    const gwName = res.gateway?.name ?? null;
    const gwReqId = res.headers?.['x-gateway-request-id'] ?? res.headers?.[WM_REQUEST_ID_HEADER] ?? null;
    exchanges.push({ id: rpc.id, timestamp: nowIso(), direction: 'outbound', kind, mode: res.route, gateway: gwName, protocol: v1 ? 'a2a-v1' : 'poc', url: res.url, request: wire, response: { status: res.status, body: rawBody, gatewayRequestId: gwReqId }, durationMs: res.ms });
    if (kind !== 'poll_task_status' || !res.ok) securityEvents.push({
      timestamp: nowIso(), direction: 'outbound', kind, mode: res.route, gateway: gwName, protocol: v1 ? 'a2a-v1' : 'poc', target: target.agentId, skill: env?.skill, method: rpc.method,
      httpStatus: res.status, decision: res.ok && !rpcErr ? 'ok' : res.status === 429 ? 'rate_limited' : res.status === 401 || res.status === 403 ? 'blocked' : 'error',
      severity: res.ok && !rpcErr ? 'info' : 'warning',
      detail: (typeof rpcErr === 'string' ? rpcErr : rpcErr?.message) ?? (viaGateway ? `Routed via ${gwName}${gwReqId ? ` (request ${gwReqId})` : ''}${pushNote ? `; ${pushNote}` : ''}` : 'Sent directly — no gateway authz, rate limit or central audit'),
      gatewayRequestId: gwReqId,
      controls: viaGateway ? 'gateway-enforced' : 'bypassed',
    });
    return res;
  }

  const describe = () => connectivity.describe({
    peerLabel: 'Agent B (Dealership Service Orchestration Agent)',
    peerDirectEndpoint: peerDirectUrl(),
    routingPath: ['agent-a', '{gateway}', 'agent-b'],
    directRoutingPath: ['agent-a', 'agent-b'],
    inboundRoute: (gw) => `${gw.invokeUrl}  →  ${getBaseUrl()}/a2a (${gw.name} forwarding credential required)`,
    get directInboundRoute() { return `${getBaseUrl()}/a2a (static direct API key)`; },
    discovery: lastDiscovery,
  });

  return { runtime, connectivity, discover, call, describe, peerCardUrl, peerDirectUrl, acceptPushToken, get lastDiscovery() { return lastDiscovery; } };
}
