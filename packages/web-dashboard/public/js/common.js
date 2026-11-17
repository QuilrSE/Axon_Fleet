// Shared dashboard helpers (no framework). Each page polls its service's /api/state and
// re-renders only the sections whose data changed, preserving open <details>.
import { icon, SCOPE_ICON, SCOPE_TEXT, hydrateIcons, BRAND_MARK } from './icons.js';

export const CFG = window.POC_CONFIG ?? { agentAUrl: 'http://localhost:4001', agentBUrl: 'http://localhost:4002', gatewayUrl: 'http://localhost:4000' };

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const $ = (sel, root = document) => root.querySelector(sel);

export async function api(base, path, { method = 'GET', body } = {}) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
  if (!res.ok && !data?.taskId && !data?.calls) {
    const msg = data?.error?.message ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status, data });
  }
  return data;
}

let toastTimer;
export function toast(msg, kind = '') {
  let el = $('.wm-toast');
  if (!el) { el = document.createElement('div'); el.className = 'wm-toast'; el.setAttribute('role', 'status'); document.body.append(el); }
  el.className = `wm-toast show ${kind}`;
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3800);
}

const cache = new Map();
/** Replace innerHTML only when the rendered markup changed; keep <details data-key> open state. */
export function render(id, html) {
  const el = document.getElementById(id);
  if (!el || cache.get(id) === html) return;
  const open = new Set([...el.querySelectorAll('details[open][data-key]')].map((d) => d.dataset.key));
  el.innerHTML = html;
  for (const d of el.querySelectorAll('details[data-key]')) if (open.has(d.dataset.key)) d.open = true;
  cache.set(id, html);
}

export const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
export const dateTime = (iso) => (iso ? new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export { icon };
export const badge = (label, cls = label) => `<span class="wm-badge ${esc(String(cls).toLowerCase().replace(/[^a-z_]/g, '_'))}">${esc(String(label).replace(/_/g, ' '))}</span>`;
export const stageLabel = (s) => (s ? s.replace(/_/g, ' ') : '—');

export function jsonBlock(key, title, obj, extra = '') {
  return `<details class="wm-json" data-key="${esc(key)}"><summary>${title}${extra}</summary><pre>${esc(JSON.stringify(obj, null, 2))}</pre></details>`;
}

export function table(headers, rows, { empty = 'Nothing yet.' } = {}) {
  if (!rows.length) return `<div class="wm-empty">${esc(empty)}</div>`;
  return `<div class="wm-table-wrap"><table class="wm-table"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
}

/** The mode band: toggle, routing strip, facts, warning. */
export function modeBand({ mode, self, peer }) {
  const on = mode.gatewayEnabled;
  const gw = mode.activeGateway ?? { name: 'A2A Gateway', kind: 'poc-gateway' };
  const gwControls = (mode.controls ?? []).filter((c) => !['endpoint_credential', 'local_validation'].includes(c.key));
  const checks = on ? gwControls.filter((c) => c.applied).map((c) => c.short) : gwControls.map((c) => c.short);
  const node = (name, sub, cls = '', extra = '') => `<div class="wm-node ${cls}">${esc(name)}<small>${esc(sub)}</small>${extra}</div>`;
  const gwNode = node(gw.name, on ? (gw.kind === 'poc-gateway' ? 'enforcing' : 'third-party gateway') : 'bypassed', on ? 'is-gateway' : 'is-bypassed', `<div class="wm-checks">${checks.map((c) => `<span>${esc(c)}</span>`).join('')}</div>`);
  const link = `<div class="wm-link ${on ? '' : 'is-direct'}"></div>`;
  const route = [node('Agent A', 'in-vehicle', self === 'agent-a' ? 'is-self' : ''), link, gwNode, link, node('Agent B', 'dealership', self === 'agent-b' ? 'is-self' : '')];
  const reg = mode.registration ?? {};
  const facts = on
    ? [
      ['Communication mode', `<strong>${esc(mode.communicationMode)}</strong>`],
      ['Active gateway', `${esc(gw.name)}<br><span class="wm-code">${esc(mode.gatewayUrl)}</span><div class="wm-hero-tags" style="margin-top:4px">${netChips(gw.network)}</div>`],
      ['Gateway health', badge(mode.gatewayHealth?.status ?? 'unknown')],
      ['Registration', `${badge(reg.status ?? 'pending')} ${reg.error ? `<span class="wm-muted">${esc(reg.error)}</span>` : ''}`],
      ...(self === 'agent-a' ? [['Discovery method', esc(mode.discovery?.mode === 'gateway' ? mode.discovery.method : 'Gateway registry lookup by skill (runs on next request)')]] : []),
      ['Routing path', `<span class="wm-code">${esc(mode.routingPath.join(' → '))}</span>`],
      ['Inbound route', `<span class="wm-code">${esc(mode.inboundRoute)}</span>`],
      ['Audit visibility', esc(mode.auditVisibility)],
      ['Agent Card published to', esc((mode.registeredWith ?? []).join(', ') || 'none yet')],
    ]
    : [
      ['Communication mode', `<strong>${esc(mode.communicationMode)}</strong>`],
      [`${peer} direct endpoint`, `<span class="wm-code">${esc(mode.peer?.directEndpoint)}</span>`],
      ['Security mode', esc(mode.securityMode)],
      ...(self === 'agent-a' ? [['Discovery method', esc(mode.discovery?.mode === 'direct' ? mode.discovery.method : 'Direct Agent Card fetch (runs on next request)')]] : []),
      ['Routing path', `<span class="wm-code">${esc(mode.routingPath.join(' → '))}</span>`],
      ['Inbound route', `<span class="wm-code">${esc(mode.inboundRoute)}</span>`],
      ['Gateway registration', `${badge(reg.status ?? 'pending')} <span class="wm-muted">not used</span>`],
      ['Audit visibility', esc(mode.auditVisibility)],
    ];
  return `
  <section class="wm-mode" data-mode="${on ? 'gateway' : 'direct'}" aria-label="A2A Gateway mode">
    <div class="wm-mode-head">
      <button class="wm-switch" role="switch" aria-checked="${on}" data-action="toggle-gateway" aria-label="A2A Gateway">
        <span class="wm-switch-track"></span>
        <span><span class="wm-switch-label">A2A Gateway</span><br><span class="wm-switch-state">${on ? 'Enabled' : 'Disabled'}</span></span>
      </button>
      <span class="wm-badge big ${on ? 'ok' : 'warn'}">${esc(mode.badge)}</span>
      <h2>${esc(mode.communicationMode)}</h2>
      <button class="wm-btn quiet" data-action="reset-mode" style="margin-left:auto">Reset to default</button>
    </div>
    <div class="wm-route" aria-label="Routing path">${route.join('')}</div>
    ${mode.warning ? `<div class="wm-warning" role="alert"><strong>Gateway controls bypassed.</strong> ${esc(mode.warning)}</div>` : ''}
    <dl class="wm-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>
    <div class="wm-muted">Mode last changed ${esc(time(mode.updatedAt))} by ${esc(mode.updatedBy)}. Takes effect immediately and is persisted in the agent runtime config.</div>
  </section>`;
}

export function controlsList(controls) {
  return `<ul class="wm-controls">${controls.map((c) => `<li class="${c.applied ? 'on' : 'off'}"><span class="mark" aria-label="${c.applied ? 'applied' : 'not applied'}">${c.applied ? '✓' : '✕'}</span><span><span class="name">${esc(c.name)}</span><small>${esc(c.enforcedBy)}</small></span></li>`).join('')}</ul>`;
}

export function eventsTable(events) {
  if (!events.length) return '<div class="wm-empty">No security events yet.</div>';
  return `<ul class="wm-feed">${events.map((e) => {
    const route = e.via ?? e.mode;
    const who = e.skill ? `skill ${e.skill}${e.caller ? `, caller ${e.caller}${e.direction === 'inbound' && e.callerVerified === false ? ' (unverified)' : ''}` : ''}` : '';
    return `<li>
      <div class="meta"><span class="when">${esc(time(e.timestamp))}</span>${badge(e.decision, e.severity === 'critical' ? 'critical' : e.decision)}${route ? badge(route, route === 'gateway' ? 'gateway' : 'direct') : ''}<span class="sub">${esc(e.direction)}${e.kind ? ` ${esc(e.kind)}` : ''}${e.gateway ? ` via ${esc(e.gateway)}` : ''}${e.httpStatus !== undefined ? `, HTTP ${esc(e.httpStatus)}` : ''}</span></div>
      <div>${esc(e.detail ?? e.reason ?? '')}</div>
      ${who ? `<div class="sub">${esc(who)}</div>` : ''}
    </li>`;
  }).join('')}</ul>`;
}

export function exchangesList(prefix, exchanges) {
  if (!exchanges.length) return '<div class="wm-empty">No A2A traffic yet.</div>';
  return exchanges.map((x, i) => jsonBlock(`${prefix}-${x.id ?? i}`,
    `${badge(x.direction)} ${badge(x.mode ?? '—', x.mode === 'gateway' ? 'gateway' : 'direct')} <strong>${esc(x.request?.method ?? x.kind)}</strong> <span class="wm-muted">${esc(x.request?.params?.metadata?.envelope?.skill ?? '')} · HTTP ${esc(x.response?.status)} · ${esc(time(x.timestamp))}</span>`,
    { request: x.request, response: x.response, url: x.url })).join('');
}

/** Wire up the toggle + reset buttons inside the mode band. */
export function bindModeBand(rootId, base, onDone) {
  document.getElementById(rootId).addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-action]');
    if (!btn) return;
    try {
      if (btn.dataset.action === 'toggle-gateway') {
        const next = btn.getAttribute('aria-checked') !== 'true';
        btn.setAttribute('aria-checked', String(next));
        await api(base, '/api/config', { method: 'PUT', body: { gatewayEnabled: next } });
        toast(next ? 'A2A Gateway enabled — gateway-mediated A2A' : 'A2A Gateway disabled — direct A2A, gateway controls bypassed');
      } else if (btn.dataset.action === 'reset-mode') {
        await api(base, '/api/config/reset', { method: 'POST' });
        toast('Mode reset to default');
      }
      onDone();
    } catch (e) { toast(e.message, 'error'); }
  });
}

export function poll(fn, ms = 1500) {
  let stopped = false;
  const tick = async () => { if (stopped) return; try { await fn(); } catch (e) { console.warn(e); } setTimeout(tick, document.hidden ? ms * 3 : ms); };
  tick();
  return () => { stopped = true; };
}

export function offline(id, name, url, err) {
  render(id, `<div class="wm-warning" role="alert"><strong>${esc(name)} is not reachable.</strong> Start it with <span class="wm-code">npm start</span> and check ${esc(url)}. (${esc(err.message)})</div>`);
}

export const kvList = (pairs) => `<dl class="wm-facts" style="grid-template-columns:1fr">${pairs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>`;

// ── Copy-to-clipboard fields ────────────────────────────────────────────
export function copyField(label, value, { primary = false, ico = 'link', hint = '' } = {}) {
  return `<div class="wm-copy ${primary ? 'primary' : ''}">
    <span class="k">${icon(ico, { size: 13 })}${esc(label)}${hint ? ` <span class="wm-muted">${esc(hint)}</span>` : ''}</span>
    <code>${esc(value)}</code>
    <button type="button" class="wm-copy-btn" data-copy="${esc(value)}" aria-label="Copy ${esc(label)}">${icon('copy', { size: 13 })}<span>Copy</span></button>
  </div>`;
}

async function writeClipboard(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* insecure origin (e.g. LAN IP over http): fall back */ }
  const ta = Object.assign(document.createElement('textarea'), { value: text });
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta); ta.select();
  const ok = document.execCommand('copy'); ta.remove();
  return ok;
}

document.addEventListener('click', async (ev) => {
  const btn = ev.target.closest('[data-copy]');
  if (!btn) return;
  const ok = await writeClipboard(btn.dataset.copy);
  const label = btn.querySelector('span');
  btn.classList.toggle('done', ok);
  if (label) label.textContent = ok ? 'Copied' : 'Select & copy';
  btn.innerHTML = `${icon(ok ? 'check' : 'copy', { size: 13 })}<span>${ok ? 'Copied' : 'Select & copy'}</span>`;
  setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = `${icon('copy', { size: 13 })}<span>Copy</span>`; }, 1600);
});

/** Protocol + network-scope chips for a described URL ({ protocol, scope, host }). */
export function netChips(n) {
  if (!n) return '';
  const proto = n.secure ? `<span class="wm-chip https">${icon('lock', { size: 12 })}HTTPS</span>` : `<span class="wm-chip http ${n.scope}">${icon('unlock', { size: 12 })}HTTP</span>`;
  return `${proto}<span class="wm-chip scope-${n.scope}">${icon(SCOPE_ICON[n.scope], { size: 12 })}${esc(SCOPE_TEXT[n.scope])}</span>`;
}

export function note(level, text) {
  return `<div class="wm-note ${level === 'warn' ? '' : level}">${icon(level === 'ok' ? 'check' : 'alert', { size: 14 })}<span>${esc(text)}</span></div>`;
}

/** Brand + nav icons, run once per page. */
export function initChrome() {
  const env = document.querySelector('.wm-env');
  if (env && CFG.platform === 'cloudflare-workers') env.textContent = 'Cloudflare Workers';
  const brand = document.querySelector('.wm-brand');
  if (brand && !brand.querySelector('.wm-mark')) brand.insertAdjacentHTML('afterbegin', `<span class="wm-mark">${BRAND_MARK}</span>`);
  hydrateIcons();
}
