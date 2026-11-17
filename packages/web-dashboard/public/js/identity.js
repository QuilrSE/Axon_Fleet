// Identity hero: the URLs other systems need to configure this agent, with copy buttons, plus
// editors for the advertised URL (what goes in the Agent Card) and, on Agent A, the peer card URL.
import { api, render, esc, badge, toast, copyField, netChips, note, icon } from './common.js';
import { SCOPE_ICON } from './icons.js';

let base;
let last = null;

export function initIdentity({ baseUrl }) {
  base = baseUrl;
  const edit = document.getElementById('heroEdit');
  edit.innerHTML = `
    <details class="wm-edit" id="advEdit">
      <summary>${icon('route', { size: 14 })}URL other systems use to reach this agent</summary>
      <div class="body">
        <p class="wm-help">Gateways and peers call the address published in the Agent Card. Keep <span class="wm-code">localhost</span> when everything runs on this machine; use a LAN address, a Docker hostname or a public/tunnel URL when the gateway runs elsewhere. Saving re-registers the card with every gateway.</p>
        <div class="wm-inline"><input class="wm-input wm-code" id="advInput" placeholder="http://192.168.1.20:4001" autocomplete="off"><button class="wm-btn primary" id="advSave">Save</button><button class="wm-btn quiet" id="advReset">Use default</button></div>
        <div class="wm-suggest" id="advSuggest"></div>
      </div>
    </details>
    <details class="wm-edit" id="fmtEdit">
      <summary>${icon('code', { size: 14 })}Agent Card format</summary>
      <div class="body">
        <p class="wm-help">The card always advertises an A2A v1.0 JSON-RPC interface in <span class="wm-code">supportedInterfaces</span> (what Bifrost and other v1 gateways require). "v1 + v0.3" also keeps the older <span class="wm-code">url</span> / <span class="wm-code">preferredTransport</span> fields for legacy clients; choose strict v1 if a gateway rejects unknown fields.</p>
        <div class="wm-inline" style="grid-template-columns:minmax(0,1fr) auto"><select class="wm-select" id="fmtSelect"></select><button class="wm-btn primary" id="fmtSave">Apply</button></div>
      </div>
    </details>
    <details class="wm-edit" id="peerEdit" hidden>
      <summary>${icon('link', { size: 14 })}Agent B card URL for direct mode</summary>
      <div class="body">
        <p class="wm-help">Used to find Agent B when the A2A Gateway is off. Paste Agent B's card URL, its base URL or just <span class="wm-code">host:port</span>.</p>
        <div class="wm-inline"><input class="wm-input wm-code" id="peerInput" placeholder="http://localhost:4002/.well-known/agent-card.json" autocomplete="off"><button class="wm-btn primary" id="peerSave">Save</button><button class="wm-btn" id="peerCheck">Check</button></div>
        <div id="peerResult"></div>
      </div>
    </details>`;
  document.getElementById('advSave').addEventListener('click', () => saveAdv(document.getElementById('advInput').value));
  document.getElementById('advReset').addEventListener('click', () => saveAdv(''));
  document.getElementById('advSuggest').addEventListener('click', (e) => {
    const b = e.target.closest('[data-url]'); if (b) document.getElementById('advInput').value = b.dataset.url;
  });
  document.getElementById('peerSave').addEventListener('click', savePeer);
  document.getElementById('fmtSave').addEventListener('click', async () => {
    try { await api(base, '/api/identity', { method: 'PUT', body: { cardFormat: document.getElementById('fmtSelect').value } }); toast('Agent Card format updated. Re-registered with all gateways.'); refreshIdentity(true); } catch (e) { toast(e.message, 'error'); }
  });
  document.getElementById('peerCheck').addEventListener('click', checkPeer);
  refreshIdentity();
  setInterval(refreshIdentity, 4000);
}

async function saveAdv(value) {
  try {
    const r = await api(base, '/api/identity', { method: 'PUT', body: { advertisedBaseUrl: value } });
    toast(`Agent Card now advertises ${r.baseUrl}. Re-registered with all gateways.`);
    document.getElementById('advEdit').open = false;
    refreshIdentity(true);
  } catch (e) { toast(e.message, 'error'); }
}

async function savePeer() {
  try {
    const r = await api(base, '/api/identity', { method: 'PUT', body: { peerCardUrl: document.getElementById('peerInput').value } });
    toast(`Direct mode will use ${r.peer.cardUrl}`);
    refreshIdentity(true);
    checkPeer();
  } catch (e) { toast(e.message, 'error'); }
}

async function checkPeer() {
  try {
    const r = await api(base, '/api/identity/check-peer', { method: 'POST' });
    render('peerResult', r.ok ? note('ok', `Reached "${r.name}" at ${r.url}. A2A endpoint: ${r.endpoint}`) : note('warn', `Could not load ${r.url}: ${r.error}`));
  } catch (e) { render('peerResult', note('warn', e.message)); }
}

export async function refreshIdentity(force) {
  let id;
  try { id = await api(base, '/api/identity'); } catch { return; }
  last = id;
  const overridden = !!id.advertisedBaseUrl;
  render('heroConn', `
    ${copyField('Agent Card URL', id.cardUrl, { primary: true, ico: 'link', hint: overridden ? '(advertised override)' : '' })}
    <div class="wm-copy-row">
      ${copyField('A2A endpoint (JSON-RPC)', id.a2aEndpoint, { ico: 'code' })}
      ${copyField('Agent ID', id.agentId, { ico: 'shield' })}
    </div>
    <div class="wm-hero-tags">${netChips(id.network)}<span class="wm-chip https" title="${esc(id.cardFormats?.[id.cardFormat] ?? '')}">${icon('check', { size: 12 })}A2A 1.0${id.cardFormat === 'v1' ? ' strict' : ' + 0.3'}</span>${overridden ? `<span class="wm-muted">Listening locally at ${esc(id.configuredBaseUrl)}</span>` : ''}</div>
    ${id.peer ? `<div style="margin-top:4px">${copyField(`${id.peer.label} card URL (direct mode)`, id.peer.cardUrl, { ico: 'car', hint: id.peer.isDefault ? '(default)' : '(custom)' })}</div>` : ''}
  `);
  const fmt = document.getElementById('fmtSelect');
  const fmtHtml = Object.entries(id.cardFormats ?? {}).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
  if (fmt.dataset.html !== fmtHtml) { fmt.innerHTML = fmtHtml; fmt.dataset.html = fmtHtml; }
  if (force || document.activeElement !== fmt) fmt.value = id.cardFormat;
  const sug = document.getElementById('advSuggest');
  const sugHtml = id.suggestions.map((s) => `<button type="button" data-url="${esc(s.url)}" title="${esc(s.label)}">${icon(SCOPE_ICON[s.scope] ?? 'link', { size: 12 })}${esc(s.url)}</button>`).join('');
  if (sug.dataset.html !== sugHtml) { sug.innerHTML = sugHtml; sug.dataset.html = sugHtml; }
  const adv = document.getElementById('advInput');
  if (force || (!adv.value && document.activeElement !== adv)) adv.value = id.advertisedBaseUrl ?? '';
  const peerEdit = document.getElementById('peerEdit');
  if (id.peer) {
    peerEdit.hidden = false;
    const pi = document.getElementById('peerInput');
    if (force || (!pi.value && document.activeElement !== pi)) pi.value = id.peer.isDefault ? '' : id.peer.cardUrl;
    pi.placeholder = id.peer.defaultCardUrl;
  }
}

/** Status tags under the hero title. */
export function heroTags(mode) {
  const gw = mode.activeGateway;
  return `${badge(mode.gatewayEnabled ? 'Gateway Enabled' : 'Gateway Disabled — Direct Mode', mode.gatewayEnabled ? 'ok' : 'warn')}
    ${mode.gatewayEnabled ? `<span class="wm-chip">${icon('route', { size: 12 })}${esc(gw.name)}</span>` : ''}
    <span class="wm-chip">${icon('pulse', { size: 12 })}Published to ${esc(String((mode.registeredWith ?? []).length))} gateway${(mode.registeredWith ?? []).length === 1 ? '' : 's'}</span>`;
}
export const identityState = () => last;
