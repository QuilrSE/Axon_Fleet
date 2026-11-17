// Minimal "cors" middleware for the Workers Express shim.
export default function cors({ origin = true } = {}) {
  return (req, res, next) => {
    const reqOrigin = req.headers.origin;
    const allowed = origin === true ? (reqOrigin ?? '*') : Array.isArray(origin) ? (origin.includes(reqOrigin) ? reqOrigin : null) : origin;
    if (allowed) { res.set('access-control-allow-origin', allowed); res.set('vary', 'Origin'); }
    if (req.method === 'OPTIONS') {
      res.set('access-control-allow-methods', 'GET,HEAD,PUT,PATCH,POST,DELETE');
      res.set('access-control-allow-headers', req.headers['access-control-request-headers'] ?? '*');
      return res.status(204).end();
    }
    return next();
  };
}
