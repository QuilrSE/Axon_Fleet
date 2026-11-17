// Agent B communication mode + outbound status pushes through the ACTIVE gateway profile or direct.
import {
  AgentConnectivity, RuntimeConfig, createEnvelope, toJsonRpc, METHODS, callDirect, nowIso, deliverV1Push, TERMINAL_STATES,
} from '@axon-fleet/shared';

export function defaultGatewayProfile(cfg) {
  return { id: 'a2a-gateway', name: 'PoC A2A Gateway', kind: 'poc-gateway', url: cfg.gatewayUrl, authScheme: 'bearer', credential: cfg.gatewayToken, inboundCredential: cfg.gatewayForwardToken, registerEnabled: true };
}

export function createGatewayConfig({ cfg, getCard, getBaseUrl, logger, exchanges, securityEvents, getPushConfigs = () => [] }) {
  const runtime = new RuntimeConfig({ store: cfg.runtimeStore, defaults: { gatewayEnabled: cfg.gatewayDefaultEnabled }, logger });
  const connectivity = new AgentConnectivity({
    agentId: cfg.agentId,
    getCard,
    getCardUrl: () => `${getBaseUrl()}/.well-known/agent-card.json`,
    runtime,
    defaultGateway: defaultGatewayProfile(cfg),
    allowlist: cfg.gatewayUrlAllowlist ?? [],
    peerAgentId: 'agent-a',
    allowReveal: cfg.allowSecretReveal ?? true,
    allowPrivate: cfg.allowPrivateGateways ?? true,
    requireHttpsForPublic: cfg.requireHttpsForPublicGateways ?? false,
    registrationIntervalMs: cfg.registrationIntervalMs,
    logger,
  });

  /** A2A v1: POST a StreamResponse to every webhook the client (or its gateway, e.g. Bifrost) registered. */
  async function pushV1(task, wo) {
    const configs = getPushConfigs(task.id);
    const terminal = TERMINAL_STATES.has(task.status.state);
    for (const c of configs) {
      const res = await deliverV1Push(c, task, { terminal });
      exchanges.push({ id: `push_${task.id}_${task.metadata.stage}`, timestamp: nowIso(), direction: 'outbound', kind: 'v1_push_webhook', mode: wo.via, gateway: wo.gatewayName, url: c.url, request: res.request.body, response: { status: res.status, body: res.data }, durationMs: res.ms });
      if (!res.ok) securityEvents.push({ timestamp: nowIso(), direction: 'outbound', kind: 'v1_push_webhook', mode: wo.via, decision: 'failed', severity: 'warning', httpStatus: res.status, detail: `Webhook ${c.url}: ${res.data?.error?.message ?? res.data?.message ?? `HTTP ${res.status}`}`, taskId: task.id, stage: task.metadata.stage });
    }
    return null;
  }

  /** Deliver an A2A task status update to the requesting agent. */
  async function push(task, wo) {
    if (wo.protocol === 'a2a-v1') return pushV1(task, wo);
    const viaGateway = connectivity.enabled;
    const envelope = createEnvelope({
      sender: cfg.agentId,
      recipient: wo.requester,
      skill: 'service_status_updates',
      intent: 'task_status_update',
      payload: { task_id: task.id, state: task.status.state, stage: task.metadata.stage },
      taskId: task.id,
      correlationId: wo.envelope.correlation_id,
      status: task.status.state,
    });
    const rpc = toJsonRpc(METHODS.PUSH_STATUS, envelope, { task });
    let res;
    if (viaGateway) {
      res = await connectivity.adapter().invoke(wo.requester, rpc);
    } else {
      const url = wo.pushConfig?.url;
      if (!url) {
        securityEvents.push({ timestamp: nowIso(), direction: 'outbound', kind: 'status_push', mode: 'direct', decision: 'skipped', severity: 'info', detail: 'No pushNotificationConfig.url supplied by requester' });
        return null;
      }
      res = await callDirect({ endpoint: url, apiKey: cfg.agentADirectApiKey, rpc });
    }
    exchanges.push({ id: rpc.id, timestamp: nowIso(), direction: 'outbound', kind: 'status_push', mode: viaGateway ? 'gateway' : 'direct', gateway: res.gateway?.name ?? null, url: res.url, request: rpc, response: { status: res.status, body: res.data }, durationMs: res.ms });
    if (!res.ok) {
      const err = res.data?.error;
      securityEvents.push({ timestamp: nowIso(), direction: 'outbound', kind: 'status_push', mode: viaGateway ? 'gateway' : 'direct', gateway: res.gateway?.name ?? null, target: wo.requester, decision: 'failed', severity: 'warning', httpStatus: res.status, detail: (typeof err === 'string' ? err : err?.message) ?? 'push failed', taskId: task.id, stage: task.metadata.stage });
    }
    return res;
  }

  const describe = () => connectivity.describe({
    peerLabel: 'Agent A (In-Vehicle Telemetry Agent)',
    peerDirectEndpoint: cfg.agentADirectUrl,
    routingPath: ['agent-a', '{gateway}', 'agent-b'],
    directRoutingPath: ['agent-a', 'agent-b'],
    inboundRoute: (gw) => `${gw.invokeUrl}  →  ${getBaseUrl()}/a2a (${gw.name} forwarding credential required; direct calls refused)`,
    get directInboundRoute() { return `${getBaseUrl()}/a2a (static direct API key)`; },
  });

  return { runtime, connectivity, push, describe };
}
