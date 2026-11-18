// Agent A's A2A JSON-RPC endpoint: POST /a2a  (+ Agent Card at /.well-known/agent-card.json)
import express from 'express';
import {
  classifyInbound, validateRpcRequest, readEnvelope, normalizeMethod, METHODS, RPC_ERRORS,
  rpcResult, rpcError, nowIso, dataPart, agentMessage, isV1Method, versionGuard, taskFromStreamResponse,
  fromV1Message, toV1Task, V1_ERRORS, parseBearer,
} from '@axon-fleet/shared';

export function buildA2ARoutes({ cfg, agent, engine, gateway, getCard, localTasks, exchanges, securityEvents }) {
  const r = express.Router();
  r.get('/.well-known/agent-card.json', (req, res) => res.json(getCard()));

  // A2A v1 push-notification webhook. Senders (Agent B directly, or a gateway such as Bifrost relaying
  // for it) POST a StreamResponse with the per-request token Agent A issued in taskPushNotificationConfig.
  r.post('/a2a/push', (req, res) => {
    const sr = req.body ?? {};
    const task = taskFromStreamResponse(sr);
    const token = req.get('x-a2a-notification-token') || parseBearer(req.get('authorization'));
    const check = gateway.acceptPushToken(token, task?.id);
    const ev = (decision, severity, detail) => securityEvents.push({ timestamp: nowIso(), direction: 'inbound', kind: 'v1_push_webhook', protocol: 'a2a-v1', decision, severity, detail, taskId: task?.id });
    if (!task?.id) { ev('rejected', 'warning', 'Webhook body is not an A2A v1 StreamResponse (task | statusUpdate | artifactUpdate)'); return res.status(400).json({ error: { code: 'INVALID_PUSH', message: 'Expected an A2A v1 StreamResponse' } }); }
    if (!check.ok) { ev('rejected', 'warning', `Push for ${task.id} rejected: ${check.reason}`); return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: check.reason } }); }
    const rec = agent.tasks.get(task.id);
    agent.handlePush(task, { via: rec?.mode ?? 'direct' });
    exchanges.push({ id: `push_${task.id}`, timestamp: nowIso(), direction: 'inbound', kind: 'v1_push_webhook', mode: rec?.mode ?? 'direct', protocol: 'a2a-v1', request: sr, response: { status: 200, body: { received: true } } });
    ev('accepted', 'info', `A2A v1 push for ${task.id}: ${task.metadata?.stage ?? task.status?.state ?? 'artifact'}`);
    return res.json({ received: true });
  });

  r.post('/a2a', (req, res) => {
    const body = req.body;
    const env = readEnvelope(body);
    const gatewayEnabled = gateway.connectivity.enabled;
    const inbound = classifyInbound(req, { gatewayCredentials: gateway.connectivity.inboundCredentials(), directApiKey: cfg.directApiKey, gatewayEnabled });
    gateway.connectivity.recordInbound(inbound, req);
    const method = body?.method ? normalizeMethod(body.method) : null;
    const event = (decision, extra = {}) => securityEvents.push({
      timestamp: nowIso(), direction: 'inbound', via: inbound.via, mode: gatewayEnabled ? 'gateway' : 'direct',
      caller: inbound.verifiedCaller ?? env?.sender_agent_id ?? 'unknown', callerVerified: !!inbound.verifiedCaller,
      skill: env?.skill ?? null, method, decision, gateway: inbound.gateway?.name ?? null, ...extra,
    });
    const reply = (status, payload) => {
      exchanges.push({ id: body?.id ?? null, timestamp: nowIso(), direction: 'inbound', kind: method, mode: inbound.via, request: body, response: { status, body: payload } });
      res.status(status).json(payload);
    };

    if (!inbound.ok) {
      event('rejected', { reason: inbound.reason, severity: 'warning', detail: inbound.message ?? 'Credential not accepted' });
      cfg.logger?.warn('inbound_auth_rejected', { agentId: cfg.agentId, status: inbound.status, reason: inbound.reason, detail: inbound.message, method: body?.method ?? null, headers: Object.keys(req.headers).filter((h) => !['cookie'].includes(h)) });
      const code = inbound.reason === 'gateway_required' ? RPC_ERRORS.GATEWAY_REQUIRED : RPC_ERRORS.UNAUTHENTICATED;
      return reply(inbound.status, rpcError(body?.id, code, inbound.message ?? `Authentication failed (${inbound.reason})`, { enforcedBy: cfg.agentId }));
    }
    const badVersion = versionGuard(req, body);
    if (badVersion) return reply(400, badVersion);
    if (isV1Method(body?.method)) {
      const p = body.params ?? {};
      if (body.method === 'SendMessage') {
        const msg = fromV1Message(p.message ?? { parts: [] });
        const data = dataPart(msg) ?? {};
        // Skill-routed (Whitematter): act only on the skill named in message.metadata.skill_id.
        const skill = msg.metadata?.skill_id ?? p.metadata?.skill_id ?? p.metadata?.envelope?.skill ?? data.skill ?? 'vehicle_telemetry_query';
        if (skill === 'service_status_updates') return reply(200, rpcError(body.id, V1_ERRORS.UNSUPPORTED_OPERATION, 'service_status_updates arrives as A2A push notifications (POST /a2a/push), not as SendMessage'));
        if (skill !== 'vehicle_telemetry_query') return reply(200, rpcError(body.id, V1_ERRORS.UNSUPPORTED_OPERATION, `Skill '${skill}' is not supported by ${cfg.agentId} over A2A v1`));
        const vehicleId = data.payload?.vehicleId ?? data.vehicleId ?? 'veh-001';
        const latest = engine.latest(vehicleId);
        const t = localTasks.create({ contextId: msg.contextId, stage: 'received' });
        const done = localTasks.update(t.id, {
          state: latest ? 'completed' : 'failed', stage: 'completed',
          message: agentMessage(latest ? `Latest telemetry for ${vehicleId}` : `No telemetry recorded yet for ${vehicleId}`),
          artifact: latest ? { artifactId: `art_${t.id}`, name: 'vehicle-telemetry', parts: [{ kind: 'data', data: latest }] } : undefined,
        });
        event('accepted', { severity: 'info', protocol: 'a2a-v1', detail: 'Telemetry query served (A2A v1)', taskId: t.id });
        return reply(200, rpcResult(body.id, { task: toV1Task(done) }));
      }
      if (body.method === 'GetTask') {
        const t = localTasks.get(p.id);
        return reply(200, t ? rpcResult(body.id, toV1Task(t)) : rpcError(body.id, V1_ERRORS.TASK_NOT_FOUND, `Task ${p.id} not found`));
      }
      return reply(200, rpcError(body.id, V1_ERRORS.UNSUPPORTED_OPERATION, `${body.method} is not supported by ${cfg.agentId}`));
    }

    const errors = validateRpcRequest(body);
    if (errors.length) {
      event('rejected', { reason: 'invalid_request', severity: 'warning', detail: errors.join('; ') });
      return reply(400, rpcError(body?.id, RPC_ERRORS.INVALID_REQUEST, `Invalid A2A request: ${errors.join('; ')}`));
    }

    switch (method) {
      case METHODS.PUSH_STATUS: {
        const task = body.params.task;
        if (!task?.id || !task.status?.state) return reply(200, rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, 'params.task with id and status is required'));
        agent.handlePush(task, inbound);
        event('accepted', { severity: 'info', detail: `Status update for ${task.id}: ${task.metadata?.stage ?? task.status.state}`, taskId: task.id });
        return reply(200, rpcResult(body.id, { received: true, taskId: task.id, stage: task.metadata?.stage ?? null }));
      }
      case METHODS.MESSAGE_SEND: {
        if (env.skill !== 'vehicle_telemetry_query') {
          event('rejected', { reason: 'unsupported_skill', severity: 'warning' });
          return reply(200, rpcError(body.id, RPC_ERRORS.UNSUPPORTED_OPERATION, `Skill '${env.skill}' is not supported by ${cfg.agentId}`));
        }
        const vehicleId = dataPart(body.params.message)?.payload?.vehicleId ?? 'veh-001';
        const latest = engine.latest(vehicleId);
        const t = localTasks.create({ id: env.task_id, contextId: env.correlation_id, stage: 'received', envelope: env });
        const done = localTasks.update(t.id, {
          state: latest ? 'completed' : 'failed', stage: 'completed',
          message: agentMessage(latest ? `Latest telemetry for ${vehicleId}` : `No telemetry recorded yet for ${vehicleId}`),
          artifact: latest ? { artifactId: `art_${t.id}`, name: 'vehicle-telemetry', parts: [{ kind: 'data', data: latest }] } : undefined,
        });
        event('accepted', { severity: inbound.via === 'direct' ? 'warning' : 'info', detail: 'Telemetry query served', taskId: t.id });
        return reply(200, rpcResult(body.id, done));
      }
      case METHODS.TASKS_GET: {
        const t = localTasks.get(body.params.id);
        return reply(200, t ? rpcResult(body.id, t) : rpcError(body.id, RPC_ERRORS.TASK_NOT_FOUND, `Task ${body.params.id} not found`));
      }
      default:
        return reply(200, rpcError(body.id, RPC_ERRORS.METHOD_NOT_FOUND, `Method '${body.method}' not supported by ${cfg.agentId}`));
    }
  });
  return r;
}
