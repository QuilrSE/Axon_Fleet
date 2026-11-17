import { CFG, api, render, esc, badge } from './common.js';
import { initChrome } from './common.js';

async function refresh() {
  const card = async (name, base, page) => {
    try {
      const h = await api(base, '/health');
      const mode = h.gatewayEnabled === undefined ? '' : badge(h.gatewayEnabled ? 'Gateway Enabled' : 'Gateway Disabled — Direct Mode', h.gatewayEnabled ? 'ok' : 'warn');
      return `<a class="wm-panel" href="${page}" style="text-decoration:none;color:inherit;display:grid;gap:8px"><strong>${esc(name)}</strong><span>${badge('healthy')} ${mode}</span><span class="wm-code wm-muted">${esc(base)}</span></a>`;
    } catch {
      return `<a class="wm-panel" href="${page}" style="text-decoration:none;color:inherit;display:grid;gap:8px"><strong>${esc(name)}</strong><span>${badge('unreachable')}</span><span class="wm-code wm-muted">${esc(base)}</span></a>`;
    }
  };
  const cards = await Promise.all([card('Vehicle agent (Agent A)', CFG.agentAUrl, '/agent-a.html'), card('A2A Gateway', CFG.gatewayUrl, '/gateway.html'), card('Dealership agent (Agent B)', CFG.agentBUrl, '/agent-b.html')]);
  render('overview', `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px">${cards.join('')}</div>`);
}
refresh();
setInterval(refresh, 3000);
initChrome();
