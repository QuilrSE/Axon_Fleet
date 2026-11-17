// Agent identity API: the URLs other systems need to configure this agent (card URL, A2A endpoint),
// plus the "advertised URL" override for gateways that cannot reach the agent at its local address.
import express from 'express';
import { HttpError } from '../utils/http.js';
import { nowIso } from '../utils/ids.js';
import { normalizeGatewayUrl, describeUrl, localAddressSuggestions } from '../utils/network.js';
import { AGENT_CARD_PATH, fetchAgentCard } from './client.js';
import { cardEndpoint, CARD_FORMATS } from './agentCard.js';

export function buildIdentityRoutes({ cfg, connectivity, getBaseUrl, securityEvents, peer }) {
  const r = express.Router();
  const view = () => {
    const base = getBaseUrl();
    return {
      agentId: cfg.agentId,
      baseUrl: base,
      configuredBaseUrl: cfg.baseUrl,
      advertisedBaseUrl: connectivity.runtime.get('advertisedBaseUrl') ?? null,
      cardUrl: `${base}${AGENT_CARD_PATH}`,
      a2aEndpoint: `${base}/a2a`,
      healthUrl: `${base}/health`,
      network: describeUrl(base),
      suggestions: localAddressSuggestions(cfg.port ?? new URL(cfg.baseUrl).port, base),
      peer: peer?.() ?? null,
      cardFormat: connectivity.runtime.get('cardFormat') || cfg.cardFormat || 'dual',
      cardFormats: CARD_FORMATS,
      protocols: ['A2A 1.0 (JSONRPC)', 'A2A 0.3 (JSON-RPC, legacy)'],
    };
  };

  r.get('/api/identity', (req, res) => res.json(view()));

  r.put('/api/identity', async (req, res, next) => {
    try {
      const { advertisedBaseUrl, peerCardUrl, cardFormat } = req.body ?? {};
      if (cardFormat !== undefined) {
        if (!CARD_FORMATS[cardFormat]) throw new HttpError(400, 'INVALID_FORMAT', `cardFormat must be one of ${Object.keys(CARD_FORMATS).join(', ')}`);
        connectivity.runtime.set({ cardFormat }, 'dashboard');
        await connectivity.registerOnce();
        securityEvents.push({ timestamp: nowIso(), direction: 'config', decision: 'identity_changed', severity: 'info', detail: `Agent Card format set to ${CARD_FORMATS[cardFormat]} — re-registered with all gateways` });
      }
      if (advertisedBaseUrl !== undefined) {
        let url = null;
        if (advertisedBaseUrl) {
          try { url = normalizeGatewayUrl(advertisedBaseUrl).replace(/\/a2a$|\/\.well-known\/agent-card\.json$/, ''); } catch (e) { throw new HttpError(400, 'INVALID_URL', `Advertised URL is not valid: ${e.message}`); }
        }
        await connectivity.setAdvertisedBaseUrl(url, 'dashboard');
        securityEvents.push({ timestamp: nowIso(), direction: 'config', decision: 'identity_changed', severity: 'info', detail: `Agent Card now advertises ${getBaseUrl()} — re-registered with all gateways` });
      }
      if (peerCardUrl !== undefined) {
        if (!peer) throw new HttpError(400, 'NOT_SUPPORTED', 'This agent has no configurable peer');
        let url = null;
        if (peerCardUrl) {
          try { url = normalizeGatewayUrl(peerCardUrl); } catch (e) { throw new HttpError(400, 'INVALID_URL', `Peer card URL is not valid: ${e.message}`); }
          if (!url.endsWith('.json')) url = `${url.replace(/\/a2a$/, '')}${AGENT_CARD_PATH}`;
        }
        connectivity.runtime.set({ peerCardUrl: url }, 'dashboard');
        securityEvents.push({ timestamp: nowIso(), direction: 'config', decision: 'identity_changed', severity: 'info', detail: `Direct-mode peer card URL set to ${url ?? 'default'}` });
      }
      res.json(view());
    } catch (e) { next(e); }
  });

  r.post('/api/identity/check-peer', async (req, res) => {
    const p = peer?.();
    if (!p) return res.status(400).json({ error: { code: 'NOT_SUPPORTED', message: 'No peer configured' } });
    const r2 = await fetchAgentCard(p.cardUrl);
    res.json({ ok: r2.ok, status: r2.status, url: r2.url, name: r2.data?.name ?? null, endpoint: r2.ok ? cardEndpoint(r2.data) : null, error: r2.ok ? null : r2.data?.error?.message ?? `HTTP ${r2.status}` });
  });

  return r;
}
