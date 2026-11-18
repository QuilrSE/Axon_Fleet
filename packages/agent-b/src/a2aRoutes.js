// Agent B's A2A JSON-RPC endpoint: POST /a2a  (+ Agent Card at /.well-known/agent-card.json)
import express from 'express';
import {
  classifyInbound, validateRpcRequest, readEnvelope, normalizeMethod, METHODS, RPC_ERRORS,
  rpcResult, rpcError, nowIso, TaskError, isV1Method, versionGuard,
} from '@axon-fleet/shared';
import { handleV1 } from './a2aV1.js';
import { toWorkOrder, validateWorkOrder } from './adapters/a2aAdapter.js';

export function buildA2ARoutes({ cfg, agent, tasks, gateway, getCard, exchanges, securityEvents }) {
  const r = express.Router();

  r.get('/.well-known/agent-card.json', (req, res) => res.json(getCard()));

  r.post('/a2a', async (req, res, next) => {
   try {
    const body = req.body;
    const env = readEnvelope(body);
    const gatewayEnabled = gateway.connectivity.enabled;
    const inbound = classifyInbound(req, { gatewayCredentials: gateway.connectivity.inboundCredentials(), directApiKey: cfg.directApiKey, gatewayEnabled });
    gateway.connectivity.recordInbound(inbound, req);
    const v1 = isV1Method(body?.method);
    const method = body?.method ? (v1 ? body.method : normalizeMethod(body.method)) : null;
    const event = (decision, extra = {}) => securityEvents.push({
      timestamp: nowIso(), direction: 'inbound', via: inbound.via, mode: gatewayEnabled ? 'gateway' : 'direct',
      caller: inbound.verifiedCaller ?? env?.sender_agent_id ?? 'unknown', callerVerified: !!inbound.verifiedCaller,
      skill: env?.skill ?? null, method, decision, gateway: inbound.gateway?.name ?? null,
      gatewayControls: inbound.via === 'gateway' ? 'applied upstream by a2a-gateway' : 'not applied', ...extra,
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
    if (badVersion) { event('rejected', { reason: 'version_not_supported', severity: 'warning', detail: badVersion.error.message }); return reply(400, badVersion); }
    if (v1) return await handleV1({ req, body, inbound, cfg, agent, tasks, event, reply });

    const errors = validateRpcRequest(body);
    if (errors.length) {
      event('rejected', { reason: 'invalid_request', severity: 'warning', detail: errors.join('; ') });
      return reply(400, rpcError(body?.id, RPC_ERRORS.INVALID_REQUEST, `Invalid A2A request: ${errors.join('; ')}`));
    }

    try {
      switch (method) {
        case METHODS.MESSAGE_SEND: {
          if (env.skill === 'vehicle_service_orchestration') {
            const wo = toWorkOrder(body, inbound);
            const woErrors = validateWorkOrder(wo);
            if (woErrors.length) {
              event('rejected', { reason: 'invalid_params', severity: 'warning', detail: woErrors.join('; ') });
              return reply(200, rpcError(body.id, RPC_ERRORS.INVALID_PARAMS, `Invalid service request: ${woErrors.join('; ')}`));
            }
            event('accepted', {
              reason: inbound.reason,
              severity: inbound.via === 'direct' ? 'warning' : 'info',
              detail: inbound.via === 'direct'
                ? `Direct call from '${env.sender_agent_id}': no central authorization, rate limit or audit`
                : `Received via ${inbound.gateway?.name ?? 'gateway'} from '${inbound.verifiedCaller ?? env.sender_agent_id}'`,
              taskId: wo.workOrderId,
            });
            return reply(200, rpcResult(body.id, agent.submitWorkOrder(wo)));
          }
          if (env.skill === 'delete_inventory') {
            event('accepted', { reason: inbound.reason, severity: 'critical', detail: 'Destructive admin skill executed without centralized skill authorization (simulated — no data changed)', taskId: env.task_id });
            return reply(200, rpcResult(body.id, agent.simulateDestructive(env, inbound)));
          }
          event('rejected', { reason: 'unsupported_skill', severity: 'warning' });
          return reply(200, rpcError(body.id, RPC_ERRORS.UNSUPPORTED_OPERATION, `Skill '${env.skill}' is not supported by ${cfg.agentId}`));
        }
        case METHODS.TASKS_GET: {
          const task = tasks.get(body.params.id);
          return task ? reply(200, rpcResult(body.id, task)) : reply(200, rpcError(body.id, RPC_ERRORS.TASK_NOT_FOUND, `Task ${body.params.id} not found`));
        }
        case METHODS.TASKS_CANCEL: {
          const t = agent.cancel(body.params.id, `Canceled by ${inbound.verifiedCaller ?? env.sender_agent_id}`);
          event('accepted', { reason: 'cancel', severity: 'info', taskId: t.id });
          return reply(200, rpcResult(body.id, t));
        }
        default:
          return reply(200, rpcError(body.id, RPC_ERRORS.METHOD_NOT_FOUND, `Method '${body.method}' not supported`));
      }
    } catch (e) {
      if (e instanceof TaskError) {
        const code = e.code === 'TASK_NOT_FOUND' ? RPC_ERRORS.TASK_NOT_FOUND : RPC_ERRORS.TASK_NOT_CANCELABLE;
        return reply(200, rpcError(body.id, code, e.message));
      }
      throw e;
    }
   } catch (e) { next(e); }
  });

  return r;
}
