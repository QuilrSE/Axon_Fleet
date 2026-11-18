// REST API for managing an agent's gateway profiles (mounted by both agents).
import express from 'express';
import { HttpError, asyncHandler } from '../utils/http.js';
import { nowIso } from '../utils/ids.js';
import { GATEWAY_KINDS, AUTH_SCHEMES, REGISTER_BODIES, CONTROL_DEFS, PROTOCOLS, MANAGEMENT_AUTH } from './gatewayAdapters.js';

/** Presets the dashboard can load into the form. Credentials are env references, never values. */
export function gatewayPresets(agentEnvPrefix) {
  return {
    'poc-gateway': { label: 'PoC A2A Gateway (this repo)', kind: 'poc-gateway', name: 'PoC A2A Gateway', url: 'http://localhost:4000', authScheme: 'bearer', credential: `env:${agentEnvPrefix}_GATEWAY_TOKEN`, inboundCredential: 'env:GATEWAY_FORWARD_TOKEN' },
    'partner-exchange-mock': {
      label: 'Partner A2A Exchange (mock third-party, port 4100)', kind: 'generic', name: 'Partner A2A Exchange', url: 'http://localhost:4100',
      authScheme: 'api-key', authHeader: 'x-api-key', credential: `env:${agentEnvPrefix}_PARTNER_GATEWAY_KEY`, inboundCredential: 'env:PARTNER_GATEWAY_FORWARD_TOKEN', callerHeader: 'x-partner-caller',
      registerMethod: 'PUT', registerPath: '/v1/agents/{agentId}', registerBody: 'card', deregisterPath: '/v1/agents/{agentId}',
      discoverPath: '/v1/agents?skill={skill}', invokePath: '/v1/agents/{agentId}/rpc', healthPath: '/healthz', resultsPath: 'items', agentIdField: 'id',
      declaredControls: ['authentication', 'sender_binding', 'audit'],
    },
    bifrost: {
      label: 'Bifrost Agent Gateway (A2A v1, e.g. Docker on port 8080)', kind: 'bifrost', name: 'Bifrost', url: 'http://localhost:8080',
      authScheme: 'api-key', authHeader: 'x-bf-vk', credential: '', inboundHeaderName: 'Authorization', inboundCredential: 'Bearer bifrost-forward-token',
      managementAuthScheme: 'basic', managementCredential: '', allowByDefault: true, agentNames: '',
      declaredControls: ['authentication', 'allowlist', 'audit', 'tracing', 'policy_routing'],
    },
    whitematter: {
      label: 'Whitematter A2A Gateway', kind: 'whitematter', name: 'Whitematter A2A Gateway', url: '',
      authScheme: 'bearer', credential: '', inboundHeaderName: 'Authorization', inboundCredential: 'Bearer whitematter-forward-token',
      agentNames: '', registerEnabled: false, pushMode: 'auto',
      declaredControls: ['authentication', 'allowlist', 'skill_authorization', 'rate_limiting', 'audit', 'tracing', 'policy_routing', 'request_validation'],
    },
    'generic-blank': { label: 'Blank third-party gateway', kind: 'generic', name: '', url: '', authScheme: 'bearer' },
  };
}

export function buildGatewayRoutes({ connectivity, securityEvents, agentEnvPrefix, onChange = () => {} }) {
  const r = express.Router();
  const by = (req) => req.get('x-changed-by') || 'dashboard';
  const event = (detail, severity = 'info') => securityEvents.push({ timestamp: nowIso(), direction: 'config', decision: 'gateway_config', severity, detail });
  const view = () => ({
    gatewayEnabled: connectivity.enabled,
    activeGatewayId: connectivity.profiles.activeId(),
    gateways: connectivity.gatewayList(),
    meta: { kinds: GATEWAY_KINDS, authSchemes: AUTH_SCHEMES, registerBodies: REGISTER_BODIES, controls: CONTROL_DEFS, protocols: PROTOCOLS, managementAuth: MANAGEMENT_AUTH, presets: gatewayPresets(agentEnvPrefix), allowlist: connectivity.profiles.allowlist },
  });

  r.get('/api/gateways', (req, res) => res.json(view()));

  // Equivalent curl for every hop. ?reveal=1 shows literal secrets (env-sourced ones always render as ${VAR}).
  r.get('/api/gateways/:id/curl', (req, res) => {
    const out = connectivity.curls(req.params.id, { reveal: req.query.reveal === '1' });
    if (!out) throw new HttpError(404, 'GATEWAY_NOT_FOUND', `No gateway profile '${req.params.id}'`);
    if (out.revealed) event(`Secrets revealed in curl view for '${out.gateway.name}'`, 'warning');
    res.json(out);
  });

  // Live preview for the add/edit form: nothing is saved.
  r.post('/api/gateways/curl-preview', (req, res) => {
    const { id, reveal, ...input } = req.body ?? {};
    let draft;
    try { draft = connectivity.profiles.draft(input, id); } catch (e) { return res.json({ errors: [e.message], planned: [] }); }
    let out = { planned: [] };
    try { out = connectivity.curls(draft.profile, { reveal: !!reveal }); } catch (e) { draft.errors.push(e.message); }
    res.json({ errors: draft.errors, planned: out?.planned ?? [], revealed: out?.revealed ?? false, envSecrets: out?.envSecrets ?? [] });
  });

  r.post('/api/gateways', asyncHandler(async (req, res) => {
    const { activate, ...input } = req.body ?? {};
    const p = connectivity.profiles.add(input, by(req));
    event(`Added gateway '${p.name}' (${p.url})${p.registerEnabled ? ' — registering Agent Card' : ''}`);
    await Promise.all([connectivity.refreshHealth(p.id), p.registerEnabled ? connectivity.registerOnce(p.id) : null]);
    if (req.body?.activate) connectivity.profiles.setActive(p.id, by(req));
    onChange();
    res.status(201).json({ gateway: connectivity.gatewayList().find((g) => g.id === p.id), ...view() });
  }));

  r.put('/api/gateways/:id', asyncHandler(async (req, res) => {
    const p = connectivity.profiles.update(req.params.id, req.body ?? {}, by(req));
    event(`Updated gateway '${p.name}' (${p.url})`);
    await Promise.all([connectivity.refreshHealth(p.id), p.registerEnabled ? connectivity.registerOnce(p.id) : null]);
    onChange();
    res.json(view());
  }));

  r.delete('/api/gateways/:id', asyncHandler(async (req, res) => {
    const p = connectivity.profiles.get(req.params.id);
    if (!p) throw new HttpError(404, 'GATEWAY_NOT_FOUND', `No gateway profile '${req.params.id}'`);
    connectivity.profiles.remove(p.id, by(req));
    connectivity.deregisterFrom(p).catch(() => {});
    event(`Removed gateway '${p.name}' and deregistered`, 'warning');
    onChange();
    res.json(view());
  }));

  r.post('/api/gateways/:id/activate', (req, res) => {
    connectivity.profiles.setActive(req.params.id, by(req));
    const p = connectivity.active;
    event(`Routing switched to '${p.name}' (${p.url})`, 'warning');
    connectivity.registerOnce(p.id).catch(() => {});
    onChange();
    res.json(view());
  });

  r.post('/api/gateways/:id/register', asyncHandler(async (req, res) => {
    if (!connectivity.profiles.get(req.params.id)) throw new HttpError(404, 'GATEWAY_NOT_FOUND', `No gateway profile '${req.params.id}'`);
    const result = await connectivity.registerOnce(req.params.id, { force: true });
    res.json({ registration: connectivity.gatewayList().find((g) => g.id === req.params.id).registration, active: result });
  }));

  r.post('/api/gateways/:id/test', asyncHandler(async (req, res) => {
    const p = connectivity.profiles.get(req.params.id);
    if (!p) throw new HttpError(404, 'GATEWAY_NOT_FOUND', `No gateway profile '${req.params.id}'`);
    const adapter = connectivity.adapter(p);
    const [health, discovery] = await Promise.all([adapter.health(), adapter.discover({ skill: req.body?.skill })]);
    await connectivity.refreshHealth(p.id);
    res.json({
      gateway: p.id,
      health: { ok: health.ok, status: health.status, ms: health.ms, error: health.ok ? null : (health.data?.error?.message ?? `HTTP ${health.status}`) },
      discovery: { ok: discovery.ok, status: discovery.status, url: discovery.url, agents: discovery.agents.map((a) => ({ agentId: a.agentId, name: a.name, url: a.url })), error: discovery.ok ? null : discovery.data },
    });
  }));

  r.post('/api/gateways/reset', (req, res) => {
    connectivity.profiles.restoreDefaults(by(req));
    connectivity.registerOnce().catch(() => {});
    event('Gateway list restored to defaults', 'warning');
    onChange();
    res.json(view());
  });

  return r;
}
