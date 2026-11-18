// Agent B — A2A v1.0 JSON-RPC methods (served on the same /a2a endpoint as the v0.3 methods).
import {
  rpcError, rpcResult, dataPart, createEnvelope, fromV1Message, toV1Task, toV1State, fromV1State,
  V1_ERRORS, RPC_ERRORS, waitForTerminal, TaskError, newId,
  WM_CHAIN_HEADER, WM_REQUEST_ID_HEADER,
} from '@axon-fleet/shared';
import { validateWorkOrder } from './adapters/a2aAdapter.js';

const SERVICE_SKILL = 'vehicle_service_orchestration';

export async function handleV1({ req, body, inbound, cfg, agent, tasks, event, reply }) {
  const p = body.params ?? {};
  const err = (code, message) => reply(200, rpcError(body.id, code, message));
  try {
    switch (body.method) {
      case 'SendMessage': {
        if (!Array.isArray(p.message?.parts) || !p.message.parts.length) return err(RPC_ERRORS.INVALID_PARAMS, 'params.message with at least one part is required');
        const msg = fromV1Message(p.message);
        if (msg.taskId && tasks.has(msg.taskId)) return err(V1_ERRORS.UNSUPPORTED_OPERATION, `Task ${msg.taskId} already exists; this agent does not accept follow-up messages on a task`);
        const given = p.metadata?.envelope ?? p.message.metadata?.envelope ?? null;
        const data = dataPart(msg) ?? {};
        // Skill-routed (Whitematter): the skill named in message.metadata.skill_id wins.
        const skill = msg.metadata?.skill_id ?? p.metadata?.skill_id ?? given?.skill ?? data.skill ?? p.metadata?.skill ?? SERVICE_SKILL;
        // Delegation chain from the gateway (Whitematter chain header + W3C baggage). Agent B makes no
        // further gateway calls while handling this task; if it did, it would pass the header on.
        const h = req?.headers ?? {};
        const chain = (h[WM_CHAIN_HEADER] || h.baggage || h[WM_REQUEST_ID_HEADER])
          ? { gatewayChain: h[WM_CHAIN_HEADER] ? `present (${String(h[WM_CHAIN_HEADER]).length} chars)` : null, baggage: h.baggage ? 'present' : null, gatewayRequestId: h[WM_REQUEST_ID_HEADER] ?? null }
          : null;
        const payload = data.payload ?? data;
        const sender = given?.sender_agent_id ?? inbound.verifiedCaller ?? 'a2a-client';
        const env = given ?? createEnvelope({ sender, recipient: cfg.agentId, skill, intent: data.intent ?? 'SendMessage', correlationId: msg.contextId });

        if (skill === 'delete_inventory') {
          event('accepted', { severity: 'critical', protocol: 'a2a-v1', detail: 'Destructive admin skill executed without centralized skill authorization (simulated — no data changed)', taskId: env.task_id });
          return reply(200, rpcResult(body.id, { task: toV1Task(agent.simulateDestructive(env, inbound)) }));
        }
        if (skill !== SERVICE_SKILL) return err(V1_ERRORS.UNSUPPORTED_OPERATION, `Skill '${skill}' is not supported by ${cfg.agentId}`);

        const vehicle = payload.vehicle ?? (payload.telemetry ? { vehicleId: payload.telemetry.vehicleId, vin: payload.telemetry.vin, model: payload.telemetry.model, powertrain: payload.telemetry.powertrain } : {});
        const pushCfg = p.configuration?.taskPushNotificationConfig;
        const wo = {
          workOrderId: given?.task_id ?? newId('task'),
          contextId: msg.contextId ?? env.correlation_id,
          requester: sender,
          verifiedRequester: inbound.verifiedCaller,
          via: inbound.via,
          gatewayName: inbound.gateway?.name ?? null,
          vehicle,
          telemetry: payload.telemetry,
          detectedIssues: payload.detectedIssues ?? [],
          preferences: payload.preferences ?? {},
          protocol: 'a2a-v1',
          chain,
          pushConfig: null,
          v1PushConfigs: [],
          envelope: env,
        };
        const errors = validateWorkOrder(wo);
        if (errors.length) {
          event('rejected', { reason: 'invalid_params', severity: 'warning', protocol: 'a2a-v1', detail: errors.join('; ') });
          return err(RPC_ERRORS.INVALID_PARAMS, `Invalid service request: ${errors.join('; ')}. Send a data part like {"vehicle":{"vehicleId":"veh-001","vin":"…"},"telemetry":{…}} (see examples/).`);
        }
        const task = agent.submitWorkOrder(wo);
        if (pushCfg) agent.pushConfigs.add(task.id, pushCfg);
        event('accepted', {
          reason: inbound.reason, protocol: 'a2a-v1', taskId: task.id,
          severity: inbound.via === 'direct' ? 'warning' : 'info',
          detail: `A2A v1 SendMessage via ${inbound.via === 'gateway' ? (inbound.gateway?.name ?? 'gateway') : 'direct call'} from '${sender}'${pushCfg ? '; push webhook registered' : ''}`,
        });
        if (p.configuration?.returnImmediately) return reply(200, rpcResult(body.id, { task: toV1Task(task) }));
        const done = await waitForTerminal(tasks, task.id, cfg.blockingTimeoutMs ?? 25_000);
        return reply(200, rpcResult(body.id, { task: toV1Task(done) }));
      }
      case 'GetTask': {
        const t = tasks.get(p.id);
        if (!t) return err(V1_ERRORS.TASK_NOT_FOUND, `Task ${p.id} not found`);
        if (typeof p.historyLength === 'number') t.history = (t.history ?? []).slice(-p.historyLength);
        return reply(200, rpcResult(body.id, toV1Task(t)));
      }
      case 'ListTasks': {
        let list = tasks.list(500);
        if (p.contextId) list = list.filter((t) => t.contextId === p.contextId);
        if (p.status) list = list.filter((t) => toV1State(t.status.state) === p.status || t.status.state === fromV1State(p.status));
        const size = Math.min(Math.max(p.pageSize ?? 50, 1), 100);
        const start = Number(p.pageToken || 0);
        const page = list.slice(start, start + size);
        return reply(200, rpcResult(body.id, {
          tasks: page.map((t) => { const v = toV1Task(t); if (p.includeArtifacts === false) delete v.artifacts; return v; }),
          nextPageToken: start + size < list.length ? String(start + size) : '',
          pageSize: size,
          totalSize: list.length,
        }));
      }
      case 'CancelTask': {
        const t = agent.cancel(p.id, `Canceled by ${inbound.verifiedCaller ?? p.metadata?.envelope?.sender_agent_id ?? 'A2A client'}`);
        event('accepted', { reason: 'cancel', severity: 'info', protocol: 'a2a-v1', taskId: t.id });
        return reply(200, rpcResult(body.id, toV1Task(t)));
      }
      case 'CreateTaskPushNotificationConfig': {
        if (!tasks.has(p.taskId)) return err(V1_ERRORS.TASK_NOT_FOUND, `Task ${p.taskId} not found`);
        return reply(200, rpcResult(body.id, agent.pushConfigs.add(p.taskId, p)));
      }
      case 'GetTaskPushNotificationConfig': {
        const c = agent.pushConfigs.get(p.taskId, p.id);
        return c ? reply(200, rpcResult(body.id, c)) : err(V1_ERRORS.TASK_NOT_FOUND, `Push notification config ${p.id} not found for task ${p.taskId}`);
      }
      case 'ListTaskPushNotificationConfigs':
        return reply(200, rpcResult(body.id, { configs: agent.pushConfigs.list(p.taskId), nextPageToken: '' }));
      case 'DeleteTaskPushNotificationConfig':
        agent.pushConfigs.remove(p.taskId, p.id);
        return reply(200, rpcResult(body.id, {}));
      case 'SendStreamingMessage':
      case 'SubscribeToTask':
        return err(V1_ERRORS.UNSUPPORTED_OPERATION, 'Streaming is not supported (capabilities.streaming = false). Use SendMessage with a push notification config, or poll GetTask.');
      case 'GetExtendedAgentCard':
        return err(V1_ERRORS.EXTENDED_CARD_NOT_CONFIGURED, 'This agent has no extended agent card');
      default:
        return err(RPC_ERRORS.METHOD_NOT_FOUND, `Method '${body.method}' not found`);
    }
  } catch (e) {
    if (e instanceof TaskError) return err(e.code === 'TASK_NOT_FOUND' ? V1_ERRORS.TASK_NOT_FOUND : V1_ERRORS.TASK_NOT_CANCELABLE, e.message);
    if (e.code === 'INVALID') return err(RPC_ERRORS.INVALID_PARAMS, e.message);
    throw e;
  }
}
