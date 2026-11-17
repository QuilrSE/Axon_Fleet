// Structured JSON-lines logger. LOG_LEVEL=debug|info|warn|error|silent
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

export function createLogger(service, level = process.env.LOG_LEVEL || 'info') {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const write = (lvl, msg, fields = {}) => {
    if (LEVELS[lvl] < threshold) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), level: lvl, service, msg, ...fields });
    if (lvl === 'error' || lvl === 'warn') console.error(line);
    else console.log(line);
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

/** Express middleware: one structured log line per HTTP request (dashboard polling is skipped). */
export function requestLogger(logger) {
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      if (req.path.startsWith('/api/') || req.path === '/health') return;
      logger.info('http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
    });
    next();
  };
}
