// A2A client used by both agents. Two invocation paths:
//  - direct:   POST <agent card url>                 Authorization: Bearer <target's direct API key>
//  - gateway:  POST <gateway>/a2a/<targetAgentId>    Authorization: Bearer <caller's gateway token>
import { fetchJson } from '../utils/http.js';
import { AGENT_CARD_PATH } from './agentCard.js';

export { AGENT_CARD_PATH };

export async function fetchAgentCard(urlOrBase, { timeoutMs = 3000 } = {}) {
  const url = urlOrBase.endsWith('.json') ? urlOrBase : `${urlOrBase.replace(/\/$/, '')}${AGENT_CARD_PATH}`;
  const res = await fetchJson(url, { timeoutMs });
  return { ...res, url };
}

export async function callDirect({ endpoint, apiKey, rpc, timeoutMs = 8000 }) {
  const res = await fetchJson(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'x-a2a-route': 'direct', 'x-correlation-id': rpc?.params?.metadata?.envelope?.correlation_id ?? '' },
    body: rpc,
    timeoutMs,
  });
  return { ...res, route: 'direct', url: endpoint };
}

export async function callViaGateway({ gatewayUrl, token, targetAgentId, rpc, timeoutMs = 8000 }) {
  const url = `${gatewayUrl.replace(/\/$/, '')}/a2a/${encodeURIComponent(targetAgentId)}`;
  const res = await fetchJson(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'x-a2a-route': 'gateway', 'x-correlation-id': rpc?.params?.metadata?.envelope?.correlation_id ?? '' },
    body: rpc,
    timeoutMs,
  });
  return { ...res, route: 'gateway', url };
}

export async function registerWithGateway({ gatewayUrl, token, agentId, card, agentCardUrl }) {
  return fetchJson(`${gatewayUrl.replace(/\/$/, '')}/registry/agents`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: { agentId, agentCardUrl, card },
    timeoutMs: 3000,
  });
}

export async function discoverViaGateway({ gatewayUrl, token, query = {} }) {
  const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v)).toString();
  return fetchJson(`${gatewayUrl.replace(/\/$/, '')}/registry/agents${qs ? `?${qs}` : ''}`, {
    headers: { authorization: `Bearer ${token}` },
    timeoutMs: 3000,
  });
}

export const gatewayHealth = (gatewayUrl) => fetchJson(`${gatewayUrl.replace(/\/$/, '')}/health`, { timeoutMs: 1500 });
