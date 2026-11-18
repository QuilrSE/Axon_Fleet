// "A2A gateways" panel: add a gateway (custom URL, third-party, Bifrost), set every authentication header
// explicitly (name + value), see the equivalent curl for each hop, register, test, route, edit, remove.
import { api, render, esc, badge, toast, time, netChips, note, icon, copyField } from './common.js';

const lastTest = new Map();
const curlState = new Map();   // gateway id -> { reveal, data, html }
let meta = null;
let base = null;
let onChange = () => {};
let scheme = 'http';
let currentList = [];
let previewTimer = null;
const $f = (name) => document.querySelector(`#gwForm [name="${name}"]`);
const MAPPING = ['registerMethod', 'registerPath', 'registerBody', 'deregisterPath', 'discoverPath', 'invokePath', 'healthPath', 'resultsPath', 'agentIdField', 'protocol'];
const TEXT = ['name', 'kind', 'pushMode', 'authScheme', 'authHeader', 'credential', 'inboundHeaderName', 'inboundCredential', 'callerHeader', 'managementAuthScheme', 'managementHeaderName', 'managementCredential', 'agentNames', 'virtualKeyIds'];
const SECRET = ['credential', 'inboundCredential', 'managementCredential'];

const secretInput = (name, placeholder) => `<span class="wm-secret"><input class="wm-input" name="${name}" type="password" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"><button type="button" class="wm-eye" data-toggle-secret="${name}" aria-label="Show value">${icon('pulse', { size: 13 })}<span>Show</span></button></span>`;

export async function initGatewayPanel({ baseUrl, hostId = 'gwPanel', refresh }) {
  base = baseUrl;
  onChange = refresh;
  meta = (await api(base, '/api/gateways')).meta;
  const host = document.getElementById(hostId);
  host.innerHTML = `
    <p class="wm-muted" style="margin-top:0">The agent publishes its Agent Card to every gateway with registration on. Traffic goes through the one marked <em>routing</em> while the A2A Gateway switch is on. Open <strong>Equivalent curl</strong> on any gateway to see exactly which headers go to the gateway and which the gateway must send to this agent.</p>
    <div id="gwList"></div>
    <details class="wm-json" id="gwFormWrap" style="margin-top:12px">
      <summary><strong id="gwFormTitle">Add a gateway</strong> <span class="wm-muted">custom URL, third-party gateway or Bifrost</span></summary>
      <form id="gwForm" class="wm-form" autocomplete="off">
        <input type="hidden" name="id">
        <label class="wm-field">Start from
          <select class="wm-select" name="preset"><option value="">Choose a template…</option>${Object.entries(meta.presets).map(([k, p]) => `<option value="${esc(k)}">${esc(p.label)}</option>`).join('')}</select>
        </label>
        <label class="wm-field">Name<input class="wm-input" name="name" required maxlength="80" placeholder="Acme A2A Gateway"></label>
        <div class="wm-field">Gateway address
          <div class="wm-urlfield">
            <div class="wm-seg" role="group" aria-label="Protocol">
              <button type="button" data-scheme="http" aria-pressed="true">${icon('unlock', { size: 12 })}http</button>
              <button type="button" data-scheme="https" aria-pressed="false">${icon('lock', { size: 12 })}https</button>
            </div>
            <input name="url" required placeholder="localhost:8080 · 10.0.0.5:8080 · gateway.example.com" autocomplete="off" spellcheck="false">
          </div>
          <div class="wm-urlpreview" id="gwUrlPreview"></div>
        </div>
        <label class="wm-field">Gateway type<select class="wm-select" name="kind">${Object.entries(meta.kinds).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('')}</select></label>

        <fieldset class="wm-fs">
          <legend>Authentication headers</legend>
          <p class="wm-help">Type values directly (stored on the agent, always shown masked), or use <span class="wm-code">env:VAR_NAME</span> to read them from the agent's environment.</p>

          <div class="wm-hop"><span class="wm-hop-label">${icon('route', { size: 13 })}Agent → gateway <span class="wm-muted">sent on every call to the gateway</span></span>
            <div class="wm-hdrgrid">
              <label class="wm-field">Mode<select class="wm-select" name="authScheme">
                <option value="api-key">Header name + value</option>
                <option value="bearer">Bearer token (Authorization)</option>
                <option value="none">No authentication</option>
              </select></label>
              <label class="wm-field">Header name<input class="wm-input wm-code" name="authHeader" placeholder="x-bf-vk" spellcheck="false"></label>
              <label class="wm-field" id="credLabel">Header value${secretInput('credential', 'sk-bf-… or env:VAR')}</label>
            </div>
          </div>

          <div class="wm-hop"><span class="wm-hop-label">${icon('shield', { size: 13 })}Gateway → agent <span class="wm-muted">the header this agent accepts from the gateway</span></span>
            <div class="wm-hdrgrid two-col">
              <label class="wm-field">Header name<input class="wm-input wm-code" name="inboundHeaderName" placeholder="Authorization" spellcheck="false"></label>
              <label class="wm-field">Header value${secretInput('inboundCredential', 'Bearer my-forward-token')}</label>
            </div>
            <label class="wm-field" id="callerRow">Caller identity header (set by the gateway)<input class="wm-input wm-code" name="callerHeader" placeholder="x-a2a-caller" spellcheck="false"></label>
          </div>

          <div class="wm-hop"><span class="wm-hop-label">${icon('plus', { size: 13 })}Additional headers to the gateway <span class="wm-muted">optional, e.g. tenant or routing headers</span></span>
            <div id="gwExtra"></div>
            <button type="button" class="wm-btn quiet" id="gwAddHeader">${icon('plus', { size: 13 })}Add header</button>
          </div>
        </fieldset>

        <fieldset id="gwBifrost" class="wm-fs">
          <legend>Bifrost registration</legend>
          <p class="wm-help">With management auth the agent registers itself through <span class="wm-code">POST /api/agents</span> and keeps it in sync; "Manual" only verifies a registration you made in Agents → Agent Catalog. The gateway → agent header above becomes the registration's request authentication.</p>
          <div class="wm-hdrgrid">
            <label class="wm-field">Management auth<select class="wm-select" name="managementAuthScheme">${Object.entries(meta.managementAuth ?? {}).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
            <label class="wm-field" id="mgmtHeaderRow">Header name<input class="wm-input wm-code" name="managementHeaderName" placeholder="Authorization" spellcheck="false"></label>
            <label class="wm-field" id="mgmtValueLabel">Credential${secretInput('managementCredential', 'admin:password')}</label>
          </div>
          <div class="two">
            <label class="wm-field">Bifrost agent names (optional)<input class="wm-input" name="agentNames" placeholder="agent-b=dealership,agent-a=vehicle"></label>
            <label class="wm-field">Virtual key IDs to grant (optional)<input class="wm-input" name="virtualKeyIds" placeholder="vk-id-1,vk-id-2"></label>
          </div>
          <label class="wm-check"><input type="checkbox" name="allowByDefault" checked> Allow any virtual key to call this agent</label>
        </fieldset>

        <fieldset id="gwWhitematter" class="wm-fs">
          <legend>Whitematter A2A Gateway</legend>
          <p class="wm-help">Address: <span class="wm-code">https://&lt;host&gt;/a2a/&lt;org&gt;</span>; pasting an agent URL from the Whitematter console fills it in. Agents are registered by an admin in the Whitematter console; the caller key (Callers → keys, shown once) goes in <em>Agent → gateway</em> as a Bearer token, and the gateway → agent header must equal the agent's <em>outbound auth</em> in Whitematter.</p>
          <div class="two">
            <label class="wm-field">Agent A slug in Whitematter<input class="wm-input wm-code" data-slug="agent-a" placeholder="in-vehicle-telemetry-driver-assistant-agent" spellcheck="false"></label>
            <label class="wm-field">Agent B slug in Whitematter<input class="wm-input wm-code" data-slug="agent-b" placeholder="synthetic-motors-service-orchestration-agent" spellcheck="false"></label>
          </div>
          <label class="wm-field">Push notifications<select class="wm-select" name="pushMode">
            <option value="auto">Auto: attach a webhook only when this agent is on public HTTPS (Whitematter's rule); otherwise poll</option>
            <option value="on">Always attach a webhook</option>
            <option value="off">Never attach a webhook (poll GetTask)</option>
          </select></label>
        </fieldset>

        <label class="wm-check" id="tlsRow"><input type="checkbox" name="tlsSkipVerify"> Skip TLS certificate verification (self-signed dev gateways only)</label>
        <label class="wm-check"><input type="checkbox" name="registerEnabled" checked> Register this agent's card with the gateway</label>
        <label class="wm-check"><input type="checkbox" name="activate"> Route traffic through this gateway</label>

        <details id="gwMapping">
          <summary>API mapping (third-party gateways)</summary>
          <p class="wm-help">Use <span class="wm-code">{agentId}</span>, <span class="wm-code">{skill}</span> and <span class="wm-code">{tag}</span> as placeholders. Leave a field blank to use the default for the gateway type.</p>
          <label class="wm-field">Wire protocol<select class="wm-select" name="protocol"><option value="">Default (PoC JSON-RPC)</option>${Object.entries(meta.protocols ?? {}).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
          <div class="two">
            <label class="wm-field">Register method<select class="wm-select" name="registerMethod"><option value="">Default</option><option>POST</option><option>PUT</option></select></label>
            <label class="wm-field">Register body<select class="wm-select" name="registerBody"><option value="">Default</option>${Object.entries(meta.registerBodies).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
          </div>
          <div class="two">
            <label class="wm-field">Register path<input class="wm-input" name="registerPath" placeholder="/agents"></label>
            <label class="wm-field">Deregister path<input class="wm-input" name="deregisterPath" placeholder="/agents/{agentId}"></label>
          </div>
          <div class="two">
            <label class="wm-field">Discovery path<input class="wm-input" name="discoverPath" placeholder="/agents?skill={skill}"></label>
            <label class="wm-field">Invoke path<input class="wm-input" name="invokePath" placeholder="/agents/{agentId}/a2a"></label>
          </div>
          <div class="two">
            <label class="wm-field">Health path<input class="wm-input" name="healthPath" placeholder="/health"></label>
            <label class="wm-field">Results field / agent ID field<span class="two"><input class="wm-input" name="resultsPath" placeholder="items"><input class="wm-input" name="agentIdField" placeholder="id"></span></label>
          </div>
          <fieldset style="border:0;padding:0;margin:0"><legend class="wm-help" style="margin-bottom:6px">Controls the gateway operator says it enforces (shown as declared, not verified)</legend>
            <div class="wm-checkgrid">${meta.controls.map((c) => `<label class="wm-check"><input type="checkbox" name="ctl" value="${c.key}"> ${esc(c.short)}</label>`).join('')}</div>
          </fieldset>
        </details>

        <details class="wm-curlwrap" id="gwPreviewWrap" open>
          <summary>${icon('code', { size: 14 })}Equivalent curl (live preview)</summary>
          <div id="gwPreview" class="wm-muted">Fill in the address to preview the requests.</div>
        </details>

        <div class="wm-row"><button class="wm-btn primary" type="submit" id="gwSubmit">Save gateway</button><button class="wm-btn quiet" type="button" id="gwClear">Clear</button></div>
      </form>
    </details>
    <div class="wm-row" style="margin-top:8px"><button class="wm-btn quiet" id="gwRestore">Restore default gateway list</button></div>`;

  const form = document.getElementById('gwForm');
  $f('preset').addEventListener('change', (e) => { const p = meta.presets[e.target.value]; if (p) fillForm(p, false); });
  $f('kind').addEventListener('change', () => { syncKind(); absorbWhitematterSlug(); schedulePreview(); });
  form.addEventListener('input', schedulePreview);
  form.addEventListener('change', () => { syncModes(); schedulePreview(); });
  form.addEventListener('click', (e) => {
    const t = e.target.closest('[data-toggle-secret]');
    if (t) { const el = $f(t.dataset.toggleSecret); const show = el.type === 'password'; el.type = show ? 'text' : 'password'; t.querySelector('span').textContent = show ? 'Hide' : 'Show'; return; }
    const rm = e.target.closest('[data-remove-header]');
    if (rm) { rm.closest('.wm-hdrrow').remove(); schedulePreview(); }
  });
  document.querySelector('#gwForm .wm-seg').addEventListener('click', (e) => { const b = e.target.closest('[data-scheme]'); if (b) setScheme(b.dataset.scheme); });
  $f('url').addEventListener('input', previewUrl);
  // Detect a pasted Whitematter agent URL only on paste / leaving the field, never mid-typing.
  $f('url').addEventListener('paste', () => setTimeout(() => { absorbWhitematterSlug(); previewUrl(); schedulePreview(); }, 0));
  $f('url').addEventListener('change', () => { absorbWhitematterSlug(); previewUrl(); schedulePreview(); });
  document.getElementById('gwAddHeader').addEventListener('click', () => { addHeaderRow(); schedulePreview(); });
  document.getElementById('gwClear').addEventListener('click', () => clearForm());
  form.addEventListener('submit', submit);
  const list = document.getElementById('gwList');
  list.addEventListener('click', listAction);
  list.addEventListener('toggle', (e) => { const d = e.target; if (d.matches?.('details[data-curl]') && d.open && !curlState.get(d.dataset.curl)?.data) loadCurl(d.dataset.curl); }, true);
  document.getElementById('gwRestore').addEventListener('click', async () => {
    if (!confirm('Remove all added gateways and go back to the default from .env?')) return;
    try { await api(base, '/api/gateways/reset', { method: 'POST' }); toast('Gateway list restored'); onChange(); } catch (e) { toast(e.message, 'error'); }
  });
  setScheme('http');
  syncKind();
}

// ── form helpers ───────────────────────────────────────────────────────
const scopeOf = (h) => (/^(localhost|.*\.localhost|127\.)/i.test(h) ? 'loopback' : /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|host\.docker\.internal$)|^[^.]+$|\.(local|internal|lan|corp|svc|cluster\.local)$/i.test(h) ? 'private' : 'public');
function splitUrl(v) {
  const m = /^\s*(https?):\/\//i.exec(v ?? '');
  return m ? { scheme: m[1].toLowerCase(), rest: v.trim().replace(/^https?:\/\//i, '') } : { scheme: null, rest: (v ?? '').trim() };
}
function setScheme(next) {
  scheme = next;
  for (const b of document.querySelectorAll('#gwForm [data-scheme]')) b.setAttribute('aria-pressed', String(b.dataset.scheme === next));
  document.getElementById('tlsRow').style.display = next === 'https' ? '' : 'none';
  previewUrl();
  schedulePreview();
}
const SLUG_HINTS = { 'agent-a': /telemetry|vehicle|driver/i, 'agent-b': /dealer|service|orchestrat|motors/i };
/** Whitematter: an agent (or card) URL pasted into the address → org base + the agent's slug. */
function absorbWhitematterSlug() {
  if ($f('kind').value !== 'whitematter') return;
  const input = $f('url');
  const m = /^(.*?\/a2a\/[^/\s]+)\/([^/\s]+?)(?:\/\.well-known\/agent(?:-card)?\.json)?\/?$/.exec(input.value.trim());
  if (!m || ['catalog', '.well-known'].includes(m[2])) return;
  input.value = m[1];
  const target = Object.keys(SLUG_HINTS).find((k) => SLUG_HINTS[k].test(m[2])) ?? 'agent-b';
  const field = document.querySelector(`#gwForm [data-slug="${target}"]`);
  if (!field.value) field.value = m[2];
  toast(`Detected Whitematter agent slug "${m[2]}" (set as the ${target === 'agent-a' ? 'Agent A' : 'Agent B'} slug).`);
}

function previewUrl() {
  const input = $f('url');
  const { scheme: typed, rest } = splitUrl(input.value);
  if (typed) { input.value = rest; setScheme(typed); return; }
  const host = rest.split('/')[0].replace(/:\d+$/, '');
  const el = document.getElementById('gwUrlPreview');
  if (!host) { el.innerHTML = '<span>Pick http or https, then enter host:port (and an optional base path).</span>'; return; }
  const scope = scopeOf(host);
  el.innerHTML = `<span>Will connect to</span><span class="wm-code">${esc(`${scheme}://${rest.replace(/\/+$/, '')}`)}</span>${netChips({ secure: scheme === 'https', scope })}${scheme === 'http' && scope === 'public' ? '<span>Unencrypted over the internet</span>' : ''}`;
}
function addHeaderRow(h = { name: '', value: '' }, editing = false) {
  const row = document.createElement('div');
  row.className = 'wm-hdrrow';
  row.innerHTML = `<input class="wm-input wm-code" data-h="name" placeholder="X-Tenant" value="${esc(h.name)}" spellcheck="false" aria-label="Header name">
    <input class="wm-input wm-code" data-h="value" type="password" placeholder="${esc(editing && h.value ? `leave blank to keep ${h.value}` : 'value or env:VAR')}" value="${editing ? '' : esc(h.value)}" spellcheck="false" aria-label="Header value">
    <button type="button" class="wm-btn quiet" data-remove-header aria-label="Remove header">Remove</button>`;
  row.dataset.masked = editing && h.value ? h.value : '';
  document.getElementById('gwExtra').append(row);
}
const extraHeaders = () => [...document.querySelectorAll('#gwExtra .wm-hdrrow')].map((r) => ({ name: r.querySelector('[data-h="name"]').value.trim(), value: r.querySelector('[data-h="value"]').value || r.dataset.masked || '' })).filter((h) => h.name || h.value);

function syncModes() {
  const auth = $f('authScheme').value;
  const hn = $f('authHeader');
  hn.disabled = auth !== 'api-key';
  if (auth === 'bearer') hn.value = 'Authorization';
  document.getElementById('credLabel').style.display = auth === 'none' ? 'none' : '';
  document.getElementById('credLabel').firstChild.textContent = auth === 'bearer' ? 'Token (sent as "Bearer <token>")' : 'Header value';
  const m = $f('managementAuthScheme').value;
  document.getElementById('mgmtHeaderRow').style.display = m === 'header' ? '' : 'none';
  document.getElementById('mgmtValueLabel').style.display = m === 'none' ? 'none' : '';
  const mv = { basic: 'Admin username:password', bearer: 'Management API key or session token', 'setup-token': 'Setup token', header: 'Header value' }[m] ?? 'Credential';
  document.getElementById('mgmtValueLabel').firstChild.textContent = mv;
  $f('managementCredential').placeholder = { basic: 'admin:password', bearer: 'management API key', 'setup-token': 'setup token', header: 'value' }[m] ?? '';
}
function syncKind() {
  const kind = $f('kind').value;
  document.getElementById('gwMapping').style.display = kind === 'generic' ? '' : 'none';
  document.getElementById('gwBifrost').style.display = kind === 'bifrost' ? '' : 'none';
  document.getElementById('gwWhitematter').style.display = kind === 'whitematter' ? '' : 'none';
  document.getElementById('callerRow').style.display = ['bifrost', 'whitematter'].includes(kind) ? 'none' : '';
  const reg = $f('registerEnabled').closest('label');
  reg.lastChild.textContent = kind === 'whitematter' ? " Verify this agent is registered in Whitematter (the caller key needs a grant for it)" : " Register this agent's card with the gateway";
  if (kind === 'whitematter' && !$f('pushMode').value) $f('pushMode').value = 'auto';
  if (kind === 'bifrost' && !$f('authHeader').value) $f('authHeader').value = 'x-bf-vk';
  syncModes();
}

function fillForm(p, editing) {
  const f = document.getElementById('gwForm');
  f.elements.id.value = editing ? p.id : '';
  for (const k of [...TEXT, ...MAPPING]) if (f.elements[k] && !SECRET.includes(k)) f.elements[k].value = p[k] ?? '';
  if (!p.authScheme) f.elements.authScheme.value = 'api-key';
  if (!p.managementAuthScheme) f.elements.managementAuthScheme.value = 'none';
  for (const k of SECRET) {
    f.elements[k].value = editing ? '' : (p[k] ?? '');
    f.elements[k].placeholder = editing && p[k] ? `leave blank to keep ${p[k]}` : f.elements[k].placeholder;
    f.elements[k].type = 'password';
  }
  const parts = splitUrl(p.url ?? '');
  f.elements.url.value = parts.rest;
  setScheme(parts.scheme ?? 'http');
  f.elements.tlsSkipVerify.checked = !!p.tlsSkipVerify;
  f.elements.allowByDefault.checked = p.allowByDefault !== false;
  f.elements.registerEnabled.checked = p.registerEnabled !== false;
  f.elements.activate.checked = false;
  for (const c of f.querySelectorAll('[name="ctl"]')) c.checked = (p.declaredControls ?? []).includes(c.value);
  document.getElementById('gwExtra').innerHTML = '';
  for (const h of p.extraHeaders ?? []) addHeaderRow(h, editing);
  const map = Object.fromEntries(String(p.agentNames ?? '').split(',').map((x) => x.split('=').map((y) => y.trim())).filter((x) => x.length === 2));
  for (const el of f.querySelectorAll('[data-slug]')) el.value = map[el.dataset.slug] ?? '';
  if (p.kind === 'whitematter') f.elements.pushMode.value = p.pushMode ?? 'auto';
  document.getElementById('gwFormTitle').textContent = editing ? `Edit ${p.name}` : 'Add a gateway';
  document.getElementById('gwSubmit').textContent = editing ? 'Save changes' : 'Save gateway';
  document.getElementById('gwFormWrap').open = true;
  syncKind();
  schedulePreview();
}
function clearForm() {
  document.getElementById('gwForm').reset();
  $f('id').value = '';
  document.getElementById('gwExtra').innerHTML = '';
  document.getElementById('gwFormTitle').textContent = 'Add a gateway';
  document.getElementById('gwSubmit').textContent = 'Save gateway';
  setScheme('http');
  syncKind();
}

function formBody() {
  const f = document.getElementById('gwForm');
  const body = {};
  for (const k of [...TEXT, 'url', ...MAPPING]) body[k] = (f.elements[k]?.value ?? '').trim();
  for (const k of SECRET) body[k] = f.elements[k].value; // keep exactly as typed
  body.scheme = scheme;
  body.tlsSkipVerify = scheme === 'https' && f.elements.tlsSkipVerify.checked;
  body.registerEnabled = f.elements.registerEnabled.checked;
  body.extraHeaders = extraHeaders();
  if (body.kind === 'generic') body.declaredControls = [...f.querySelectorAll('[name="ctl"]:checked')].map((c) => c.value);
  else for (const k of MAPPING) delete body[k];
  if (body.kind === 'bifrost') body.allowByDefault = f.elements.allowByDefault.checked;
  else { delete body.managementAuthScheme; delete body.managementCredential; delete body.managementHeaderName; }
  if (body.kind === 'whitematter') {
    body.agentNames = [...f.querySelectorAll('[data-slug]')].filter((el) => el.value.trim()).map((el) => `${el.dataset.slug}=${el.value.trim()}`).join(',');
  } else { delete body.pushMode; if (body.kind !== 'bifrost') delete body.agentNames; }
  if (body.authScheme === 'bearer') delete body.authHeader;
  return body;
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const body = formBody();
    if (!body.url) return;
    try {
      const r = await api(base, '/api/gateways/curl-preview', { method: 'POST', body: { ...body, id: $f('id').value || undefined } });
      const errs = (r.errors ?? []).filter((e) => !/^name is required/.test(e));
      document.getElementById('gwPreview').innerHTML = `${errs.length ? note('warn', `Not valid yet: ${errs.join('; ')}`) : ''}${curlBlocks(r.planned ?? [], 'pv')}`;
    } catch (e) { document.getElementById('gwPreview').textContent = e.message; }
  }, 350);
}

async function submit(ev) {
  ev.preventDefault();
  const f = ev.target;
  const body = formBody();
  const id = f.elements.id.value;
  const btn = document.getElementById('gwSubmit');
  btn.disabled = true;
  try {
    if (id) {
      await api(base, `/api/gateways/${encodeURIComponent(id)}`, { method: 'PUT', body });
      if (f.elements.activate.checked) await api(base, `/api/gateways/${encodeURIComponent(id)}/activate`, { method: 'POST' });
      curlState.delete(id);
      toast(`Saved ${body.name}`);
    } else {
      const res = await api(base, '/api/gateways', { method: 'POST', body: { ...body, activate: f.elements.activate.checked } });
      const reg = res.gateway.registration;
      toast(body.registerEnabled ? `Added ${body.name}. Registration: ${reg.status}${reg.error ? ` (${reg.error})` : ''}` : `Added ${body.name}`, reg.status === 'failed' ? 'error' : '');
    }
    clearForm();
    document.getElementById('gwFormWrap').open = false;
    onChange();
  } catch (e) {
    toast(e.message, 'error');
  } finally { btn.disabled = false; }
}

// ── equivalent curl ─────────────────────────────────────────────────────
const OP_TITLES = { health: 'Health check', register: 'Register (create)', update: 'Register (update existing)', check: 'Registration check (heartbeat)', verify: 'Verify manual registration', discover: 'Discovery', invoke: 'Call through the gateway', deregister: 'Deregister' };
function curlBlock(c, key) {
  return `<div class="wm-curlblock">
    <div class="wm-curlhead"><strong>${esc(c.title ?? c.op)}</strong>${c.direction ? badge(c.direction, c.direction.startsWith('gateway') ? 'gateway' : 'info') : ''}${c.status !== undefined ? badge(`HTTP ${c.status}`, c.status >= 200 && c.status < 300 ? 'ok' : 'bad') : ''}${c.at ? `<span class="wm-muted">${esc(time(c.at))}</span>` : ''}
      <button type="button" class="wm-copy-btn" data-copy="${esc(c.curl)}" aria-label="Copy curl">${icon('copy', { size: 13 })}<span>Copy</span></button></div>
    ${c.note ? `<div class="wm-help">${esc(c.note)}</div>` : ''}${c.error ? `<div class="wm-help">Error: ${esc(c.error)}</div>` : ''}
    <pre class="wm-curl" data-key="${esc(key)}">${esc(c.curl)}</pre>
  </div>`;
}
const curlBlocks = (list, prefix) => list.map((c, i) => curlBlock(c, `${prefix}-${c.id ?? c.op}-${i}`)).join('');

async function loadCurl(id, reveal = curlState.get(id)?.reveal ?? false) {
  try {
    const data = await api(base, `/api/gateways/${encodeURIComponent(id)}/curl${reveal ? '?reveal=1' : ''}`);
    const masked = !data.revealed;
    const html = `
      <div class="wm-row" style="justify-content:space-between;margin-bottom:6px">
        <span class="wm-help">${masked ? 'Literal secrets are masked (••••). Values from the environment appear as <span class="wm-code">${VAR}</span> and run as-is in a shell where the variable is set.' : '<strong>Secrets are visible.</strong> Anyone with dashboard access can see them.'}</span>
        ${data.revealAllowed ? `<button type="button" class="wm-btn quiet" data-act="reveal" data-gw="${esc(id)}">${masked ? 'Reveal secrets' : 'Mask secrets'}</button>` : ''}
        <button type="button" class="wm-btn quiet" data-act="curl-refresh" data-gw="${esc(id)}">Refresh</button>
      </div>
      <h4 class="wm-sub" style="margin-top:4px">Planned requests</h4>${curlBlocks(data.planned, `pl-${id}`)}
      <h4 class="wm-sub">Last sent to the gateway</h4>${data.sent.length ? curlBlocks(data.sent.map((x) => ({ ...x, title: OP_TITLES[x.op] ?? x.op, direction: 'agent → gateway' })), `se-${id}`) : '<div class="wm-help">Nothing sent yet.</div>'}
      <h4 class="wm-sub">Last received from this gateway</h4>${data.inbound ? curlBlock({ ...data.inbound, title: `${data.inbound.rpcMethod ?? 'request'} accepted` }, `in-${id}`) : '<div class="wm-help">No request from this gateway yet.</div>'}
      ${data.rejected ? `<h4 class="wm-sub">Last rejected inbound request (any sender)</h4>${curlBlock({ ...data.rejected, title: `${data.rejected.rpcMethod ?? 'request'} rejected: ${data.rejected.reason}` }, `rj-${id}`)}` : ''}`;
    curlState.set(id, { reveal: data.revealed, data, html });
  } catch (e) {
    curlState.set(id, { reveal, data: null, html: note('warn', e.message) });
  }
  renderGatewayList(currentList, lastEnabled, true);
}

// ── list ────────────────────────────────────────────────────────────────
async function listAction(ev) {
  const btn = ev.target.closest('[data-gw]');
  if (!btn) return;
  const id = btn.dataset.gw;
  const action = btn.dataset.act;
  const g = currentList.find((x) => x.id === id);
  if (action === 'reveal') {
    const next = !curlState.get(id)?.reveal;
    if (next && !confirm('Show literal secrets (keys, tokens, passwords) in the curl commands?')) return;
    return loadCurl(id, next);
  }
  if (action === 'curl-refresh') return loadCurl(id);
  btn.disabled = true;
  try {
    if (action === 'edit') return fillForm(g, true);
    if (action === 'remove') {
      if (!confirm(`Remove ${g.name}? The agent will deregister its card from it.`)) return;
      await api(base, `/api/gateways/${encodeURIComponent(id)}`, { method: 'DELETE' });
      toast(`Removed ${g.name}`);
    } else if (action === 'activate') {
      await api(base, `/api/gateways/${encodeURIComponent(id)}/activate`, { method: 'POST' });
      toast(`Routing through ${g.name}`);
    } else if (action === 'register') {
      const r = await api(base, `/api/gateways/${encodeURIComponent(id)}/register`, { method: 'POST' });
      toast(`Registration with ${g.name}: ${r.registration.status}${r.registration.error ? ` (${r.registration.error})` : ''}`, r.registration.status === 'failed' ? 'error' : '');
      if (curlState.get(id)?.data) loadCurl(id);
    } else if (action === 'test') {
      const r = await api(base, `/api/gateways/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} });
      lastTest.set(id, { ...r, at: new Date().toISOString() });
      toast(`${g.name}: health ${r.health.ok ? 'OK' : `failed (${r.health.status})`}, discovery ${r.discovery.ok ? `${r.discovery.agents.length} agent(s)` : `failed (${r.discovery.status})`}`, r.health.ok && r.discovery.ok ? '' : 'error');
      if (curlState.get(id)?.data) loadCurl(id);
    }
    onChange();
  } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; }
}

let lastEnabled = true;
export function renderGatewayList(gateways, gatewayEnabled) {
  currentList = gateways;
  lastEnabled = gatewayEnabled;
  render('gwList', gateways.map((g) => {
    const t = lastTest.get(g.id);
    const regLabel = g.registration.status === 'registered' && g.registration.mode === 'verified' ? 'listed (manual)' : g.registration.status === 'registered' && g.registration.mode === 'management-api' ? 'registered (API)' : g.registration.status;
    const reg = g.registerEnabled === false ? badge('not registering', 'info') : badge(regLabel, g.registration.status === 'not_registered' ? 'warn' : g.registration.status);
    const outName = g.authScheme === 'bearer' ? 'Authorization' : g.authScheme === 'api-key' ? g.authHeader : null;
    const inName = g.inboundCredential ? (g.inboundHeaderName || 'Authorization') : null;
    const cs = curlState.get(g.id);
    return `<article class="wm-gw ${g.active ? 'is-active' : ''}" aria-label="${esc(g.name)}">
      <div class="wm-gw-head"><strong>${esc(g.name)}</strong>${g.active ? badge(gatewayEnabled ? 'routing' : 'routing (bypassed)', gatewayEnabled ? 'gateway' : 'direct') : ''}${g.kind === 'poc-gateway' ? '' : badge('third-party', 'warn')}</div>
      <div class="url">${esc(g.url)}</div>
      <div class="chips">${netChips(g.network)}<span class="wm-chip">${g.protocol === 'a2a-v1' || g.kind === 'bifrost' ? 'A2A v1.0' : 'PoC JSON-RPC (v0.3)'}</span>${reg}${badge(g.health.status)}${g.health.latencyMs !== undefined && g.health.status === 'healthy' ? `<span class="wm-chip">${esc(g.health.latencyMs)} ms</span>` : ''}</div>
      <dl class="wm-hdrsummary">
        <div><dt>Agent → gateway</dt><dd>${outName ? `<span class="wm-code">${esc(outName)}: ${esc(g.authScheme === 'bearer' ? `Bearer ${g.credential}` : g.credential)}</span>` : 'none'}${(g.extraHeaders ?? []).map((h) => `<br><span class="wm-code">${esc(h.name)}: ${esc(h.value)}</span>`).join('')}</dd></div>
        <div><dt>Gateway → agent</dt><dd>${inName ? `<span class="wm-code">${esc(inName)}: ${esc(g.inboundCredential)}</span>` : 'not configured: requests from this gateway are rejected'}</dd></div>
        ${g.kind === 'whitematter' ? `<div><dt>Whitematter agents</dt><dd>${esc(g.agentNames || 'slugs = agent IDs')}</dd></div><div><dt>Push</dt><dd>${esc({ auto: 'auto (public HTTPS only, else polling)', on: 'always', off: 'off (polling)' }[g.pushMode ?? 'auto'])}</dd></div>` : ''}
        ${g.kind === 'bifrost' ? `<div><dt>Registration</dt><dd>${esc((meta?.managementAuth ?? {})[g.managementAuthScheme] ?? g.managementAuthScheme)}${g.managementAuthScheme === 'header' ? ` <span class="wm-code">${esc(g.managementHeaderName)}</span>` : ''}</dd></div>` : ''}
      </dl>
      ${g.registration.mode === 'management-api' && g.registration.action ? `<div class="wm-muted">Bifrost registration "${esc(g.registration.bifrostName ?? '')}": ${esc(g.registration.action)} at ${esc(time(g.registration.at))}</div>` : ''}
      ${g.registration.error ? note('warn', g.registration.status === 'not_registered' ? g.registration.error : `Registration failed: ${g.registration.error}`) : ''}
      ${g.registration.servedCardUrl ? copyField('Card served by this gateway', g.registration.servedCardUrl, { ico: 'link' }) : ''}
      ${g.health.status === 'unreachable' && !g.registration.error ? note('warn', 'Health check failed. Use Test for details.') : ''}
      ${(g.warnings ?? []).map((w) => note(w.level, w.text)).join('')}
      ${t ? note(t.health.ok && t.discovery.ok ? 'ok' : 'warn', `Tested ${time(t.at)}: ${t.health.ok ? 'reachable' : `unreachable (${t.health.error ?? `HTTP ${t.health.status}`})`}; discovery ${t.discovery.ok ? `found ${t.discovery.agents.map((a) => a.agentId).join(', ') || 'no agents'}` : `failed (${t.discovery.error?.error?.message ?? t.discovery.error?.error ?? `HTTP ${t.discovery.status}`})`}`) : ''}
      <details class="wm-curlwrap" data-curl="${esc(g.id)}" data-key="curl-${esc(g.id)}">
        <summary>${icon('code', { size: 14 })}Equivalent curl <span class="wm-muted">headers to the gateway and to this agent</span></summary>
        <div>${cs?.html ?? '<div class="wm-help">Loading…</div>'}</div>
      </details>
      <div class="actions">
        ${g.active ? '' : `<button class="wm-btn" data-gw="${esc(g.id)}" data-act="activate">${icon('route', { size: 13 })}Route through this</button>`}
        <button class="wm-btn" data-gw="${esc(g.id)}" data-act="register">Register now</button>
        <button class="wm-btn" data-gw="${esc(g.id)}" data-act="test">Test</button>
        <button class="wm-btn quiet" data-gw="${esc(g.id)}" data-act="edit">Edit</button>
        ${gateways.length > 1 ? `<button class="wm-btn quiet" data-gw="${esc(g.id)}" data-act="remove">Remove</button>` : ''}
      </div>
    </article>`;
  }).join(''));
}
