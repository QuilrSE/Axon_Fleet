// A2A v1.0 wire format and conversion to/from the PoC's internal (v0.3-shaped) objects.
// Normative source: a2aproject/A2A specification/a2a.proto (v1.0). JSON uses proto3 JSON names:
//   - enums as SCREAMING_SNAKE strings: TASK_STATE_COMPLETED, ROLE_USER
//   - Part is a union identified by its field: { text } | { data } | { url } | { raw } (no "kind")
//   - SendMessage returns { task } or { message }; GetTask/CancelTask return the Task itself
//   - push notifications POST a StreamResponse: { task } | { message } | { statusUpdate } | { artifactUpdate }
import { newId, nowIso } from '../utils/ids.js';

export const A2A_V1_VERSION = '1.0';

export const V1_METHODS = Object.freeze([
  'SendMessage', 'SendStreamingMessage', 'GetTask', 'ListTasks', 'CancelTask', 'SubscribeToTask',
  'CreateTaskPushNotificationConfig', 'GetTaskPushNotificationConfig', 'ListTaskPushNotificationConfigs',
  'DeleteTaskPushNotificationConfig', 'GetExtendedAgentCard',
]);
export const isV1Method = (m) => V1_METHODS.includes(m);

export const V1_ERRORS = Object.freeze({
  TASK_NOT_FOUND: -32001, TASK_NOT_CANCELABLE: -32002, PUSH_NOT_SUPPORTED: -32003, UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005, INVALID_AGENT_RESPONSE: -32006, EXTENDED_CARD_NOT_CONFIGURED: -32007,
  EXTENSION_SUPPORT_REQUIRED: -32008, VERSION_NOT_SUPPORTED: -32009,
});

const STATE_TO_V1 = {
  submitted: 'TASK_STATE_SUBMITTED', working: 'TASK_STATE_WORKING', completed: 'TASK_STATE_COMPLETED', failed: 'TASK_STATE_FAILED',
  canceled: 'TASK_STATE_CANCELED', 'input-required': 'TASK_STATE_INPUT_REQUIRED', rejected: 'TASK_STATE_REJECTED', 'auth-required': 'TASK_STATE_AUTH_REQUIRED',
};
const STATE_FROM_V1 = Object.fromEntries(Object.entries(STATE_TO_V1).map(([k, v]) => [v, k]));
export const toV1State = (s) => STATE_TO_V1[s] ?? 'TASK_STATE_UNSPECIFIED';
export const fromV1State = (s) => STATE_FROM_V1[s] ?? (typeof s === 'string' ? s.replace(/^TASK_STATE_/, '').toLowerCase().replace(/_/g, '-') : 'unknown');

/** Accepts ROLE_USER / ROLE_AGENT (v1) and user / agent (lenient, as some gateways' examples use). */
export const fromV1Role = (r) => (/agent/i.test(String(r ?? '')) ? 'agent' : 'user');
export const toV1Role = (r) => (r === 'agent' ? 'ROLE_AGENT' : 'ROLE_USER');

export function toV1Part(p) {
  if (p == null) return null;
  if (p.kind === 'text' || (p.text !== undefined && p.kind === undefined)) return { text: p.text, ...(p.metadata ? { metadata: p.metadata } : {}) };
  if (p.kind === 'data' || (p.data !== undefined && p.kind === undefined)) return { data: p.data, mediaType: 'application/json', ...(p.metadata ? { metadata: p.metadata } : {}) };
  if (p.kind === 'file') return p.file?.uri ? { url: p.file.uri, mediaType: p.file.mimeType, filename: p.file.name } : { raw: p.file?.bytes, mediaType: p.file?.mimeType, filename: p.file?.name };
  return p;
}
export function fromV1Part(p) {
  if (p == null) return null;
  if (p.kind) return p; // already v0.3
  if (p.text !== undefined) return { kind: 'text', text: p.text, ...(p.metadata ? { metadata: p.metadata } : {}) };
  if (p.data !== undefined) return { kind: 'data', data: p.data, ...(p.metadata ? { metadata: p.metadata } : {}) };
  if (p.url !== undefined) return { kind: 'file', file: { uri: p.url, mimeType: p.mediaType, name: p.filename } };
  if (p.raw !== undefined) return { kind: 'file', file: { bytes: p.raw, mimeType: p.mediaType, name: p.filename } };
  return { kind: 'data', data: p };
}

const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

export function toV1Message(m) {
  if (!m) return undefined;
  return clean({
    messageId: m.messageId ?? newId('msg'), contextId: m.contextId, taskId: m.taskId, role: toV1Role(m.role),
    parts: (m.parts ?? []).map(toV1Part).filter(Boolean), metadata: m.metadata, referenceTaskIds: m.referenceTaskIds,
  });
}
export function fromV1Message(m) {
  if (!m) return undefined;
  return clean({ kind: 'message', messageId: m.messageId, contextId: m.contextId, taskId: m.taskId, role: fromV1Role(m.role), parts: (m.parts ?? []).map(fromV1Part).filter(Boolean), metadata: m.metadata });
}

export const toV1Status = (s) => clean({ state: toV1State(s?.state), message: toV1Message(s?.message), timestamp: s?.timestamp });
export const fromV1Status = (s) => clean({ state: fromV1State(s?.state), message: fromV1Message(s?.message), timestamp: s?.timestamp });

export function toV1Artifact(a) {
  return clean({ artifactId: a.artifactId, name: a.name, description: a.description, parts: (a.parts ?? []).map(toV1Part), metadata: a.metadata });
}
export function fromV1Artifact(a) {
  return clean({ artifactId: a.artifactId, name: a.name, description: a.description, parts: (a.parts ?? []).map(fromV1Part), metadata: a.metadata });
}

/** Internal task → strict v1 Task (drops the v0.3 "kind" discriminator). */
export function toV1Task(t) {
  if (!t) return t;
  return clean({
    id: t.id, contextId: t.contextId, status: toV1Status(t.status),
    artifacts: t.artifacts?.length ? t.artifacts.map(toV1Artifact) : undefined,
    history: t.history?.length ? t.history.map(toV1Message) : undefined,
    metadata: t.metadata,
  });
}
export function fromV1Task(t) {
  if (!t) return t;
  if (t.kind === 'task') return t;
  return clean({ kind: 'task', id: t.id, contextId: t.contextId, status: fromV1Status(t.status), artifacts: (t.artifacts ?? []).map(fromV1Artifact), history: (t.history ?? []).map(fromV1Message), metadata: t.metadata ?? {} });
}

/** v1 StreamResponse (push payload) → internal task snapshot (partial for status updates). */
export function taskFromStreamResponse(sr) {
  if (sr?.task) return fromV1Task(sr.task);
  if (sr?.statusUpdate) {
    const u = sr.statusUpdate;
    return { kind: 'task', id: u.taskId, contextId: u.contextId, status: fromV1Status(u.status), artifacts: [], metadata: u.metadata ?? {} };
  }
  if (sr?.artifactUpdate) {
    const u = sr.artifactUpdate;
    return { kind: 'task', id: u.taskId, contextId: u.contextId, status: null, artifacts: [fromV1Artifact(u.artifact)], metadata: u.metadata ?? {} };
  }
  return null;
}

/** Internal task → StreamResponse for a push: full task when terminal, otherwise a status update. */
export function streamResponseFor(task, terminal) {
  if (terminal) return { task: toV1Task(task) };
  return { statusUpdate: clean({ taskId: task.id, contextId: task.contextId, status: toV1Status(task.status), metadata: { stage: task.metadata?.stage } }) };
}

/**
 * Convert an outgoing PoC JSON-RPC request (v0.3 method names) to A2A v1.
 * @param {object} pushConfig  v1 TaskPushNotificationConfig to attach to SendMessage (optional)
 */
export function requestToV1(rpc, { pushConfig, omitContextId = false } = {}) {
  const env = rpc.params?.metadata?.envelope;
  const meta = env ? { envelope: env } : undefined;
  switch (rpc.method) {
    case 'message/send': {
      // A new task: no taskId (the server assigns it). Gateways that issue their own IDs (QuilrAI)
      // also get no contextId. skill_id names the skill for skill-routed agents.
      const { taskId, contextId, ...msg } = rpc.params.message;
      const skillId = env?.skill ? { skill_id: env.skill } : {};
      return {
        jsonrpc: '2.0', id: rpc.id, method: 'SendMessage',
        params: clean({
          message: toV1Message({ ...msg, ...(omitContextId ? {} : { contextId }), metadata: { ...(msg.metadata ?? {}), ...skillId, ...(meta ?? {}) } }),
          configuration: clean({ acceptedOutputModes: rpc.params.configuration?.acceptedOutputModes ?? ['application/json'], returnImmediately: true, taskPushNotificationConfig: pushConfig }),
          metadata: meta,
        }),
      };
    }
    case 'tasks/get': return { jsonrpc: '2.0', id: rpc.id, method: 'GetTask', params: { id: rpc.params.id } };
    case 'tasks/cancel': return { jsonrpc: '2.0', id: rpc.id, method: 'CancelTask', params: clean({ id: rpc.params.id, metadata: meta }) };
    default: return rpc;
  }
}

/** Convert a v1 JSON-RPC response body back to the internal shape the agents already understand. */
export function responseFromV1(v0method, body) {
  if (!body || body.error || !body.result) return body;
  const r = body.result;
  if (v0method === 'message/send') {
    if (r.task) return { ...body, result: fromV1Task(r.task) };
    if (r.message) return { ...body, result: { kind: 'task', id: r.message.taskId ?? newId('task'), contextId: r.message.contextId, status: { state: 'completed', timestamp: nowIso(), message: fromV1Message(r.message) }, artifacts: [], metadata: { stage: 'completed', directMessage: true } } };
  }
  return { ...body, result: fromV1Task(r) };
}

/** Validate the A2A-Version header: undefined (treated by caller), "1", "1.0", "1.x" OK. */
export function checkVersion(header) {
  if (header === undefined || header === null || header === '') return { ok: true, version: null };
  const v = String(header).trim();
  if (/^1(\.\d+)?$/.test(v)) return { ok: true, version: v };
  if (/^0\.3(\.\d+)?$/.test(v)) return { ok: true, version: v };
  return { ok: false, version: v };
}
