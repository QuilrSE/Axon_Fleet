// Minimal Express-compatible framework on the Fetch API, so the services' route code runs unchanged on
// Cloudflare Workers. Covers what this repository uses: express(), express.Router(), express.json(),
// app.use / get / post / put / delete with ":param" paths, middleware and error middleware (4 args),
// req.{method,path,url,originalUrl,query,params,headers,body,get()}, res.{status,set,setHeader,
// getHeader,type,json,send,end,on('finish')}. Wired in through wrangler.jsonc "alias".
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function compile(path) {
  const keys = [];
  const segs = path.split('/').filter(Boolean).map((seg) => {
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
    return escapeRe(seg);
  });
  return { re: new RegExp(`^/${segs.join('/')}/?$`), keys };
}

class Router {
  constructor() { this.stack = []; }
  use(...args) {
    const path = typeof args[0] === 'string' ? args.shift() : null;
    for (const fn of args.flat()) this.stack.push({ type: 'use', path, fn });
    return this;
  }
  route(method, path, fns) {
    this.stack.push({ type: 'route', method, path, ...compile(path), fns: fns.flat() });
    return this;
  }
  get(path, ...fns) { return this.route('GET', path, fns); }
  post(path, ...fns) { return this.route('POST', path, fns); }
  put(path, ...fns) { return this.route('PUT', path, fns); }
  patch(path, ...fns) { return this.route('PATCH', path, fns); }
  delete(path, ...fns) { return this.route('DELETE', path, fns); }

  async run(req, res, out) {
    let i = 0;
    const next = async (err) => {
      if (res.finished) return;
      const layer = this.stack[i++];
      if (!layer) return out(err);
      try {
        if (layer.type === 'use') {
          if (layer.path && !(req.path === layer.path || req.path.startsWith(`${layer.path}/`))) return next(err);
          const fn = layer.fn;
          if (fn instanceof Router) return await fn.run(req, res, next);
          const isErrorHandler = fn.length === 4;
          if (err && !isErrorHandler) return next(err);
          if (!err && isErrorHandler) return next();
          return await (isErrorHandler ? fn(err, req, res, next) : fn(req, res, next));
        }
        if (err) return next(err);
        if (layer.method !== req.method && !(layer.method === 'GET' && req.method === 'HEAD')) return next();
        const m = layer.re.exec(req.path);
        if (!m) return next();
        req.params = Object.fromEntries(layer.keys.map((k, n) => [k, decodeURIComponent(m[n + 1])]));
        (req.matchedRoutes ??= []).push(`${layer.method} ${layer.path}`);
        let j = 0;
        const inner = async (e) => {
          if (e) return next(e);
          const f = layer.fns[j++];
          if (!f) return next();
          return f(req, res, inner);
        };
        return await inner();
      } catch (e) {
        // An empty thrown value is still a failure (never "continue routing" → misleading 404).
        return next(e ?? new Error('Request handler failed without an error object'));
      }
    };
    await next();
  }
}

class Response_ {
  constructor() {
    this.statusCode = 200;
    this.headers = new Headers();
    this.finished = false;
    this.body = null;
    this.listeners = {};
    this.done = new Promise((r) => { this.resolveDone = r; });
  }
  status(code) { this.statusCode = code; return this; }
  set(k, v) {
    if (typeof k === 'object') { for (const [a, b] of Object.entries(k)) this.headers.set(a, String(b)); } else this.headers.set(k, String(v));
    return this;
  }
  header(k, v) { return this.set(k, v); }
  setHeader(k, v) { this.headers.set(k, String(v)); }
  getHeader(k) { return this.headers.get(k); }
  removeHeader(k) { this.headers.delete(k); }
  type(t) { this.headers.set('content-type', t.includes('/') ? t : t === 'json' ? 'application/json' : `text/${t}`); return this; }
  json(obj) {
    if (!this.headers.has('content-type')) this.headers.set('content-type', 'application/json; charset=utf-8');
    return this.send(JSON.stringify(obj));
  }
  send(body) {
    if (this.finished) return this;
    if (body !== null && body !== undefined && typeof body === 'object' && !(body instanceof ArrayBuffer) && !(body instanceof Uint8Array)) return this.json(body);
    this.body = body ?? null;
    this.finished = true;
    for (const fn of this.listeners.finish ?? []) { try { fn(); } catch { /* listeners never break a response */ } }
    this.resolveDone();
    return this;
  }
  end(body) { return this.send(body); }
  on(evt, fn) { (this.listeners[evt] ??= []).push(fn); return this; }
  toResponse() {
    const empty = this.statusCode === 204 || this.statusCode === 304;
    return new Response(empty ? null : this.body, { status: this.statusCode, headers: this.headers });
  }
}

function express() {
  const app = new Router();
  app.settings = {};
  app.disable = (k) => { app.settings[k] = false; return app; };
  app.enable = (k) => { app.settings[k] = true; return app; };
  app.listen = () => { throw new Error('app.listen() is not available on Cloudflare Workers; use app.fetch(request)'); };

  /** Run the app against a Fetch API Request and return a Response. */
  app.fetch = async (request) => {
    const url = new URL(request.url);
    const hasBody = !['GET', 'HEAD'].includes(request.method);
    const headers = {};
    request.headers.forEach((v, k) => { headers[k] = v; });
    const req = {
      method: request.method,
      url: url.pathname + url.search,
      originalUrl: url.pathname + url.search,
      path: url.pathname,
      hostname: url.hostname,
      protocol: url.protocol.replace(':', ''),
      query: Object.fromEntries(url.searchParams),
      params: {},
      headers,
      body: undefined,
      rawBody: hasBody ? await request.text() : '',
      get(name) { return this.headers[String(name).toLowerCase()]; },
      header(name) { return this.get(name); },
    };
    const res = new Response_();
    await app.run(req, res, (err) => {
      if (res.finished) return;
      if (err) res.status(err.status || 500).json({ error: { code: err.code || 'INTERNAL', message: err.message ?? String(err) } });
      else res.status(404).json({ error: { code: 'NOT_FOUND', message: `${req.method} ${req.path} not found` } });
    });
    if (!res.finished) await Promise.race([res.done, new Promise((r) => setTimeout(r, 30_000))]);
    if (!res.finished) res.status(504).json({ error: { code: 'TIMEOUT', message: 'Handler did not respond' } });
    return res.toResponse();
  };
  return app;
}

express.Router = () => new Router();
/** Parses JSON bodies like body-parser: empty body → {}, malformed → 400 entity.parse.failed. */
express.json = ({ type } = {}) => (req, res, next) => {
  if (req.body !== undefined) return next();
  const ct = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const types = [].concat(type ?? ['application/json']);
  const matches = !ct || types.some((t) => t === ct || (t.endsWith('/*+json') && ct.endsWith('+json')) || (t === 'application/*+json' && ct.endsWith('+json')));
  if (!req.rawBody || !matches) { req.body = {}; return next(); }
  try {
    req.body = JSON.parse(req.rawBody);
    return next();
  } catch (e) {
    const err = new Error(`Invalid JSON: ${e.message}`);
    err.type = 'entity.parse.failed';
    err.status = 400;
    return next(err);
  }
};
express.static = () => { throw new Error('express.static is not used on Workers; the dashboard is served from Workers static assets'); };

export default express;
export { Router };
