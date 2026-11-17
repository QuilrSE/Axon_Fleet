// Shared A2A v1 JSON-RPC server helpers used by both agents.
import { rpcError, rpcResult } from './message.js';
import { V1_ERRORS, checkVersion } from './v1.js';
import { TERMINAL_STATES } from './task.js';
import { fetchJson } from '../utils/http.js';
import { newId, nowIso } from '../utils/ids.js';
import { streamResponseFor } from './v1.js';

/** Reject unsupported A2A-Version values (spec: VersionNotSupportedError, -32009). */
export function versionGuard(req, body) {
  const v = checkVersion(req.get?.('a2a-version') ?? req.headers?.['a2a-version'] ?? req.query?.['A2A-Version']);
  if (v.ok) return null;
  return rpcError(body?.id, V1_ERRORS.VERSION_NOT_SUPPORTED, `A2A-Version "${v.version}" is not supported. This agent speaks A2A 1.0 (and 0.3 for legacy clients).`);
}

/** Wait until a task is terminal (or interrupted) — used when SendMessage is not returnImmediately. */
export function waitForTerminal(tasks, id, timeoutMs = 25_000) {
  const t0 = tasks.get(id);
  if (!t0 || TERMINAL_STATES.has(t0.status.state)) return Promise.resolve(t0);
  return new Promise((resolve) => {
    const onChange = (t) => { if (t.id === id && (TERMINAL_STATES.has(t.status.state) || t.status.state === 'input-required')) done(t); };
    const timer = setTimeout(() => done(tasks.get(id)), timeoutMs);
    function done(t) { clearTimeout(timer); tasks.off('change', onChange); resolve(t); }
    tasks.on('change', onChange);
  });
}

/** In-memory TaskPushNotificationConfig store (per task). */
export class PushConfigStore {
  constructor() { this.byTask = new Map(); }
  add(taskId, cfg) {
    if (!cfg?.url || !/^https?:\/\//.test(cfg.url)) throw Object.assign(new Error('taskPushNotificationConfig.url must be an absolute http(s) URL'), { code: 'INVALID' });
    const entry = { ...cfg, id: cfg.id || newId('pnc'), taskId };
    const list = this.byTask.get(taskId) ?? [];
    this.byTask.set(taskId, [...list.filter((c) => c.id !== entry.id), entry]);
    return entry;
  }
  list(taskId) { return this.byTask.get(taskId) ?? []; }
  get(taskId, id) { return this.list(taskId).find((c) => c.id === id) ?? null; }
  remove(taskId, id) { this.byTask.set(taskId, this.list(taskId).filter((c) => c.id !== id)); }
}

/**
 * Deliver one A2A v1 push notification: POST StreamResponse to the webhook with the configured
 * authentication (Authorization: <scheme> <credentials>) and token (X-A2A-Notification-Token).
 */
export async function deliverV1Push(config, task, { terminal, timeoutMs = 15_000 } = {}) {
  const headers = { 'content-type': 'application/a2a+json', 'a2a-version': '1.0' };
  if (config.authentication?.scheme) headers.authorization = `${config.authentication.scheme} ${config.authentication.credentials ?? ''}`.trim();
  if (config.token) headers['x-a2a-notification-token'] = config.token;
  const body = streamResponseFor(task, terminal);
  const res = await fetchJson(config.url, { method: 'POST', headers, body, timeoutMs });
  return { ...res, request: { url: config.url, body, at: nowIso() } };
}

export const v1Result = (id, result) => rpcResult(id, result);
