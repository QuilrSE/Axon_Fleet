import { CFG, api, render, esc, $, toast, time, badge, table, jsonBlock, poll, offline, stageLabel, copyField } from './common.js';
import { initChrome } from './common.js';

const BASE = CFG.gatewayUrl;

async function refresh() {
  let s;
  try { s = await api(BASE, '/api/state'); } catch (e) { return offline('stats', 'A2A Gateway', BASE, e); }
  const st = s.stats;
  render('stats', `<div class="wm-metrics">
    ${[['Registered agents', s.agents.length], ['Requests routed', st.routed], ['Denied (authz)', st.denied, st.denied ? 'warn' : ''], ['Unauthenticated', st.unauthenticated, st.unauthenticated ? 'warn' : ''], ['Rate-limited', st.rateLimited, st.rateLimited ? 'warn' : ''], ['Invalid requests', st.invalid], ['Upstream errors', st.upstreamErrors, st.upstreamErrors ? 'alert' : '']]
      .map(([k, v, c = '']) => `<div class="wm-metric ${c}"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join('')}
  </div>`);

  render('agents', s.agents.length ? s.agents.map((a) => `<div class="wm-agentcard">
    <div class="wm-row" style="justify-content:space-between"><strong>${esc(a.name)}</strong>${badge(a.health.status)}</div>
    <div class="wm-muted"><span class="wm-code">${esc(a.agentId)}</span>, ${esc(a.provider)}, v${esc(a.version)}${a.health.gatewayMode === false ? ` ${badge('agent in direct mode', 'direct')}` : ''}</div>
    ${copyField('Agent Card URL', a.agentCardUrl ?? `${new URL(a.url).origin}/.well-known/agent-card.json`, { ico: 'link' })}
    ${copyField('A2A endpoint', a.url, { ico: 'code' })}
    <div>${a.skills.map((k) => `<div><span class="wm-code">${esc(k.id)}</span> <span class="wm-muted">${esc((k.tags ?? []).join(', '))}</span></div>`).join('')}</div>
    ${jsonBlock(`card-${a.agentId}`, 'Agent Card JSON', a.card)}
  </div>`).join('') : '<div class="wm-empty">No agents registered. Agents register automatically on start.</div>');

  const p = s.policy;
  render('policy', `
    <p class="wm-muted">Default decision: <strong>${esc(p.defaultDecision)}</strong>. Auth: ${esc(s.auth.scheme)} (${esc(s.auth.mode)}). Rate limit: ${esc(p.rateLimit.limit)} requests per ${esc(p.rateLimit.windowMs / 1000)} s per caller.</p>
    ${table(['Caller', 'Target', 'Allowed skills'], p.rules.map((r) => `<tr><td>${esc(r.caller)}</td><td>${esc(r.target)}</td><td>${r.skills.map((k) => `<span class="wm-code">${esc(k)}</span>`).join('<br>')}</td></tr>`))}
    <h3 class="wm-sub">Enforcement order</h3>
    <ol class="wm-timeline">${p.enforcementOrder.map((x) => `<li><div class="t">${esc(x)}</div></li>`).join('')}</ol>
    ${jsonBlock('policy-json', 'Policy JSON', p)}`);

  render('routes', table(['Time', 'Caller → target', 'Method / skill', 'Decision', 'HTTP', 'ms'], s.routes.slice(0, 30).map((r) => `<tr>
    <td>${esc(time(r.timestamp))}</td><td>${esc(r.caller)} → ${esc(r.target)}</td>
    <td><span class="wm-code">${esc(r.method ?? '—')}</span><br><span class="wm-muted">${esc(r.skill ?? '')}</span></td>
    <td>${badge(r.decision)}${r.reason ? `<br><span class="wm-muted">${esc(r.reason)}</span>` : ''}</td><td class="num">${esc(r.httpStatus)}</td><td class="num">${esc(r.durationMs)}</td></tr>`), { empty: 'No A2A traffic has passed through the gateway yet.' }));

  const type = $('#auditType').value;
  const audit = s.audit.filter((e) => !type || e.type === type).slice(0, 40);
  render('audit', table(['Time', 'Type', 'Caller → target', 'Skill', 'AuthN', 'AuthZ', 'Routing', 'Status'], audit.map((e) => `<tr>
    <td>${esc(time(e.timestamp))}</td><td>${esc(e.type.replace(/_/g, ' '))}</td><td>${esc(e.caller)} → ${esc(e.target)}</td><td>${esc(e.skill ?? (e.query ? JSON.stringify(e.query) : '—'))}</td>
    <td>${badge(e.authentication ?? 'n/a')}</td><td>${badge(e.authorization ?? 'n/a')}</td>
    <td>${e.routing ? badge(e.routing) : '—'}${e.reason ? `<br><span class="wm-muted">${esc(e.reason)}</span>` : ''}</td><td class="num">${esc(e.responseStatus ?? '')}</td></tr>`), { empty: 'No audit events.' }));

  render('ratelimits', table(['Time', 'Caller', 'Count / limit'], s.rateLimitEvents.slice(0, 15).map((r) => `<tr><td>${esc(time(r.timestamp))}</td><td>${esc(r.caller)}</td><td class="num">${r.count} / ${r.limit}</td></tr>`), { empty: 'No rate-limit events. Try the rate-limit burst probe on Agent A.' }));

  render('tasks', table(['Task', 'Requester → provider', 'Skill', 'Stage', 'State', 'Hops'], s.tasks.map((t) => `<tr>
    <td><span class="wm-code">${esc(t.taskId)}</span></td><td>${esc(t.requester)} → ${esc(t.provider)}</td><td>${esc(t.skill)}</td><td>${esc(stageLabel(t.stage))}</td><td>${badge(t.state)}</td><td class="num">${t.hops}</td></tr>`), { empty: 'No tasks routed yet.' }));
}

$('#auditType').addEventListener('change', refresh);
$('#clearLogs').addEventListener('click', async () => { try { await api(BASE, '/api/logs/clear', { method: 'POST' }); toast('Gateway logs cleared'); refresh(); } catch (e) { toast(e.message, 'error'); } });
poll(refresh, 1500);
initChrome();
