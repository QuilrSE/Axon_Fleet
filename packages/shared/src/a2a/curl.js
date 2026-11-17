// Render HTTP requests as copy-pasteable curl commands without leaking secrets.
//   - values from env references become ${VAR} (or a base64 pipeline), so the command runs as-is
//     in a shell where the variable is set;
//   - literal secrets are masked (••••abcd) unless reveal is requested;
//   - anything else is shown verbatim.
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const dqEsc = (s) => String(s).replace(/(["\\`$])/g, '\\$1');
export const maskValue = (s) => (String(s).length <= 4 ? '••••' : `••••${String(s).slice(-4)}`);

/** Split a string into literal / env segments around known secrets. */
export function segments(str, sources = [], { reveal = false } = {}) {
  const text = String(str);
  for (const src of sources) {
    if (!src.secret || src.secret.length < 4) continue;
    const i = text.indexOf(src.secret);
    if (i === -1) continue;
    const before = segments(text.slice(0, i), sources, { reveal });
    const after = segments(text.slice(i + src.secret.length), sources, { reveal });
    const mid = src.env ? [{ env: src.env, encode: src.encode }] : [{ lit: reveal ? src.secret : maskValue(src.secret), masked: !reveal }];
    return [...before, ...mid, ...after];
  }
  return text ? [{ lit: text }] : [];
}

/** Quote one shell argument, expanding env segments. */
export function quoteArg(str, sources, opts) {
  const segs = segments(str, sources, opts);
  if (!segs.some((s) => s.env)) return sq(segs.map((s) => s.lit).join(''));
  return `"${segs.map((s) => (s.env ? (s.encode === 'base64' ? `$(printf '%s' "$${s.env}" | base64 | tr -d '\\n')` : `\${${s.env}}`) : dqEsc(s.lit))).join('')}"`;
}

/**
 * @param {{method:string,url:string,headers?:object,body?:any,bodyFrom?:string,dataFile?:string}} req
 * @param {{sources?:Array, reveal?:boolean}} opts
 */
export function toCurl(req, { sources = [], reveal = false } = {}) {
  const lines = [];
  const method = (req.method ?? 'GET').toUpperCase();
  lines.push(`curl -sS -X ${method} ${quoteArg(req.url, sources, { reveal })}`);
  for (const [k, v] of Object.entries(req.headers ?? {})) lines.push(`  -H ${quoteArg(`${k}: ${v}`, sources, { reveal })}`);
  if (req.bodyFrom) lines.push('  --data-binary @-');
  else if (req.dataFile) lines.push(`  --data-binary @${req.dataFile}`);
  else if (req.body !== undefined) lines.push(`  --data ${quoteArg(typeof req.body === 'string' ? req.body : JSON.stringify(req.body), sources, { reveal })}`);
  const cmd = lines.join(' \\\n');
  return req.bodyFrom ? `${req.bodyFrom} \\\n| ${cmd}` : cmd;
}

/** True when the rendered command contains masked secrets (it will not work until revealed). */
export const hasMasked = (req, sources) => JSON.stringify(req).length > 0 && sources.some((s) => !s.env && s.secret && JSON.stringify(req).includes(s.secret));
