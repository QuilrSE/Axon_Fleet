// A2A message / JSON-RPC envelope helpers.
//
// Spec-aligned: JSON-RPC 2.0 transport with A2A method names message/send, tasks/get, tasks/cancel,
// Message objects with parts[] (kind: text | data), Task objects with status.state.
// PoC additions: the business "envelope" (task_id, sender_agent_id, recipient_agent_id, skill,
// intent, payload, created_at, status, correlation_id) travels in params.metadata.envelope so the
// gateway can authorize per skill without parsing message parts. Friendly aliases
// (send_message, create_task, get_task_status, cancel_task) map onto the spec methods.
import { newId, nowIso } from '../utils/ids.js';

export const METHODS = Object.freeze({
  MESSAGE_SEND: 'message/send',
  TASKS_GET: 'tasks/get',
  TASKS_CANCEL: 'tasks/cancel',
  // PoC method used to deliver task status updates (A2A uses webhook push notifications for this).
  PUSH_STATUS: 'tasks/pushNotification',
});

export const METHOD_ALIASES = Object.freeze({
  send_message: METHODS.MESSAGE_SEND,
  create_task: METHODS.MESSAGE_SEND,
  get_task_status: METHODS.TASKS_GET,
  cancel_task: METHODS.TASKS_CANCEL,
  push_status: METHODS.PUSH_STATUS,
});

export const normalizeMethod = (m) => METHOD_ALIASES[m] ?? m;

// JSON-RPC / A2A error codes. -32001..-32006 follow the A2A spec; -3201x are PoC gateway codes
// (in A2A, authn/authz failures are signalled at the HTTP layer — we return both).
export const RPC_ERRORS = Object.freeze({
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  UNSUPPORTED_OPERATION: -32004,
  UNAUTHENTICATED: -32010,
  FORBIDDEN: -32011,
  GATEWAY_REQUIRED: -32012,
  RATE_LIMITED: -32029,
  UPSTREAM_UNAVAILABLE: -32050,
});

export function createEnvelope({ sender, recipient, skill, intent, payload = {}, taskId, correlationId, status = 'submitted' }) {
  return {
    task_id: taskId || newId('task'),
    sender_agent_id: sender,
    recipient_agent_id: recipient,
    skill,
    intent,
    payload,
    created_at: nowIso(),
    status,
    correlation_id: correlationId || newId('corr'),
  };
}

/** Wrap an envelope as an A2A JSON-RPC request. */
export function toJsonRpc(method, envelope, extraParams = {}) {
  const m = normalizeMethod(method);
  const params = { metadata: { envelope } };
  if (m === METHODS.TASKS_GET || m === METHODS.TASKS_CANCEL) {
    params.id = envelope.task_id;
  } else {
    params.message = {
      kind: 'message',
      role: m === METHODS.PUSH_STATUS ? 'agent' : 'user',
      messageId: newId('msg'),
      contextId: envelope.correlation_id,
      taskId: envelope.task_id,
      parts: [
        { kind: 'text', text: `${envelope.intent} (skill: ${envelope.skill})` },
        { kind: 'data', data: { skill: envelope.skill, intent: envelope.intent, payload: envelope.payload } },
      ],
    };
  }
  Object.assign(params, extraParams);
  return { jsonrpc: '2.0', id: newId('rpc'), method: m, params };
}

export const readEnvelope = (rpc) => rpc?.params?.metadata?.envelope ?? null;

const ENVELOPE_FIELDS = ['task_id', 'sender_agent_id', 'recipient_agent_id', 'skill', 'intent', 'created_at', 'correlation_id'];

/** Validate a JSON-RPC request carrying an A2A envelope. Returns array of error strings. */
export function validateRpcRequest(body) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['body must be a JSON-RPC object'];
  if (body.jsonrpc !== '2.0') errors.push('jsonrpc must be "2.0"');
  if (typeof body.method !== 'string') errors.push('method must be a string');
  if (body.id === undefined || body.id === null) errors.push('id is required');
  if (!body.params || typeof body.params !== 'object') errors.push('params object is required');
  const env = readEnvelope(body);
  if (!env) errors.push('params.metadata.envelope is required');
  else for (const f of ENVELOPE_FIELDS) if (!env[f]) errors.push(`envelope.${f} is required`);
  const m = normalizeMethod(body.method);
  if (m === METHODS.MESSAGE_SEND && !Array.isArray(body.params?.message?.parts)) errors.push('params.message.parts is required for message/send');
  if ((m === METHODS.TASKS_GET || m === METHODS.TASKS_CANCEL) && !body.params?.id) errors.push('params.id is required');
  return errors;
}

/** Pull the first data part out of an A2A message. */
export const dataPart = (message) => message?.parts?.find((p) => p.kind === 'data')?.data ?? null;

export const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
export const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

export function agentMessage(text, data) {
  const parts = [{ kind: 'text', text }];
  if (data) parts.push({ kind: 'data', data });
  return { kind: 'message', role: 'agent', messageId: newId('msg'), parts };
}
