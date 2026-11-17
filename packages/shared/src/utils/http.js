import cors from 'cors';
import { fetch as undiciFetch } from 'undici';
import { dispatcherFor, explainNetworkError } from './network.js';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function corsMiddleware(origins = process.env.CORS_ORIGINS || '*') {
  const list = origins.split(',').map((s) => s.trim()).filter(Boolean);
  return cors({ origin: list.includes('*') ? true : list });
}

export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function errorHandler(logger) {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    }
    const status = err.status || 500;
    if (status >= 500) logger?.error('unhandled_error', { path: req.path, err: err.message, stack: err.stack });
    res.status(status).json({ error: { code: err.code || 'INTERNAL', message: err.message, details: err.details } });
  };
}

/**
 * fetch + JSON + timeout; never throws, always returns { ok, status, data, ms }.
 * Works for http:// and https:// alike. Options:
 *   tlsSkipVerify  accept self-signed certs (dev gateways only)
 *   redirect       'follow' (default for GET) or 'manual' (default for writes, so a POST is never
 *                  silently replayed as a GET after an http→https redirect)
 */
export async function fetchJson(url, { method = 'GET', headers = {}, body, timeoutMs = 5000, tlsSkipVerify = false, redirect } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await undiciFetch(url, {
      method,
      headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
      redirect: redirect ?? (method === 'GET' ? 'follow' : 'manual'),
      dispatcher: dispatcherFor({ tlsSkipVerify }),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      return { ok: false, status: res.status, data: { error: { code: 'REDIRECT', message: `Gateway redirected ${method} ${url} to ${location ?? '(no location)'}. Update the gateway URL to the final address${location?.startsWith('https:') ? ' (it wants https://)' : ''}.` } }, headers: Object.fromEntries(res.headers), ms: Date.now() - started };
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 500) }; }
    return { ok: res.ok, status: res.status, data, headers: Object.fromEntries(res.headers), ms: Date.now() - started };
  } catch (e) {
    const { code, message } = explainNetworkError(e, url);
    return { ok: false, status: 0, data: { error: { code, message } }, ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

export function listen(app, port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => resolve(server));
    server.on('error', reject);
  });
}

export function closeServer(server) {
  return new Promise((resolve) => {
    if (!server) return resolve();
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}
