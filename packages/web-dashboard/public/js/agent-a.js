import { CFG, api, render, esc, $, toast, time, badge, stageLabel, table, jsonBlock, modeBand, bindModeBand, controlsList, eventsTable, exchangesList, poll, offline, dateTime, kvList } from './common.js';
import { initGatewayPanel, renderGatewayList } from './gateways.js';
import { initIdentity, heroTags } from './identity.js';
import { initChrome } from './common.js';

const BASE = CFG.agentAUrl;
let vehicleId = new URLSearchParams(location.search).get('vehicle') ?? 'veh-001';
let selectedTask = null;
let selectsReady = false;

async function refresh() {
  let s;
  try { s = await api(BASE, `/api/state?vehicleId=${encodeURIComponent(vehicleId)}`); } catch (e) { return offline('mode', 'Agent A', BASE, e); }

  if (!selectsReady) {
    $('#vehicle').innerHTML = s.vehicles.map((v) => `<option value="${esc(v.vehicleId)}">${esc(v.label)}</option>`).join('');
    $('#scenario').innerHTML = Object.entries(s.scenarios).map(([k, v]) => `<option value="${esc(k)}" ${k === 'brake_wear' ? 'selected' : ''}>${esc(v)}</option>`).join('');
    $('#vehicle').value = vehicleId;
    selectsReady = true;
  }

  render('heroTags', heroTags(s.mode));
  render('mode', modeBand({ mode: s.mode, self: 'agent-a', peer: 'Agent B' }));
  renderTelemetry(s);
  renderTasks(s);
  render('status', kvList([
    ['Agent ID', `<span class="wm-code">${esc(s.agent.id)}</span>`],
    ['Agent Card', `<a href="${esc(s.agent.cardUrl)}" target="_blank" rel="noopener">Open card JSON</a>`],
    ['Registration', badge(s.mode.registration.status)],
    ['Gateway health', badge(s.mode.gatewayHealth.status)],
    ['Skills', s.card.skills.map((k) => `<span class="wm-code">${esc(k.id)}</span>`).join('<br>')],
  ]));
  render('controls', controlsList(s.mode.controls));
  if (s.mode.gateways) renderGatewayList(s.mode.gateways, s.mode.gatewayEnabled);
  render('probes', s.probes.length ? s.probes.slice(0, 5).map((p) => `<div style="padding:8px 0;border-bottom:1px solid var(--wm-hairline)">
      <div class="wm-row">${badge(p.blocked ? 'blocked' : 'allowed', p.blocked ? 'ok' : 'critical')} ${badge(p.mode === 'gateway' ? (p.gateway ?? 'gateway') : p.mode, p.mode === 'gateway' ? 'gateway' : 'direct')} <strong>${esc(p.type.replace(/_/g, ' '))}</strong></div>
      <div class="wm-muted">${esc(p.outcome)}</div>
      ${p.calls[0]?.message ? `<div class="wm-muted">${esc(p.calls[0].message)}</div>` : ''}
    </div>`).join('') : '<div class="wm-empty">No probes run yet.</div>');
  render('events', eventsTable(s.securityEvents.slice(0, 25)));
  render('exchanges', exchangesList('a-x', s.exchanges.slice(0, 15)));
  renderCentralAudit(s.mode.gatewayEnabled);
}

function renderTelemetry(s) {
  const rec = s.latest;
  if (!rec) return render('telemetry', '<div class="wm-empty">Generate telemetry to begin.</div>');
  const t = rec.telemetry;
  const minTire = Math.min(...Object.values(t.tirePressurePsi));
  const m = (k, v, cls = '') => `<div class="wm-metric ${cls}"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`;
  render('telemetry', `
    <div class="wm-muted" style="margin-bottom:8px">${esc(t.model)} · VIN <span class="wm-code">${esc(t.vin)}</span> · ${esc(time(t.timestamp))} · scenario: ${esc(t.scenario.replace(/_/g, ' '))}</div>
    <div class="wm-metrics">
      ${m('Odometer', `${t.odometerKm.toLocaleString()} km`)}
      ${m('Battery charge', `${t.batterySocPct}%`)}
      ${m('Battery health', `${t.batterySohPct}%`, t.batterySohPct < 75 ? 'alert' : t.batterySohPct < 80 ? 'warn' : '')}
      ${m('Drivetrain temp', `${t.drivetrainTempC} °C`, t.drivetrainTempC > 110 ? 'alert' : t.drivetrainTempC > 95 ? 'warn' : '')}
      ${m('Lowest tire', `${minTire} psi`, minTire < 26 ? 'alert' : minTire < 30 ? 'warn' : '')}
      ${m('Front pads worn', `${t.brakePadWearPct.front}%`, t.brakePadWearPct.front >= 85 ? 'alert' : t.brakePadWearPct.front >= 70 ? 'warn' : '')}
      ${m('Rear pads worn', `${t.brakePadWearPct.rear}%`, t.brakePadWearPct.rear >= 85 ? 'alert' : t.brakePadWearPct.rear >= 70 ? 'warn' : '')}
      ${m('Fault codes', t.faultCodes.length ? t.faultCodes.join(', ') : 'none', t.faultCodes.length ? 'alert' : '')}
    </div>
    <p class="wm-muted" style="margin:8px 0 0">Predicted maintenance: ${esc(t.predictedMaintenance.length ? t.predictedMaintenance.join('; ') : 'none')}</p>`);
  render('alerts', rec.analysis.alerts.length
    ? `<ul class="wm-alerts">${rec.analysis.alerts.map((a) => `<li>${badge(a.severity)}<div><div class="title">${esc(a.title)}</div><div class="detail">${esc(a.detail)} → ${esc(a.predictedService)}</div></div></li>`).join('')}</ul>`
    : '<div class="wm-empty">No maintenance issues in the latest reading.</div>');
  render('history', table(['Time', 'Scenario', 'Odometer', 'SoH', 'Temp', 'Min tire', 'Front pads', 'Faults', 'Alerts'], s.history.map((h) => {
    const x = h.telemetry;
    return `<tr><td>${esc(time(x.timestamp))}</td><td>${esc(x.scenario.replace(/_/g, ' '))}</td><td class="num">${x.odometerKm.toLocaleString()}</td><td class="num">${x.batterySohPct}%</td><td class="num">${x.drivetrainTempC}</td><td class="num">${Math.min(...Object.values(x.tirePressurePsi))}</td><td class="num">${x.brakePadWearPct.front}%</td><td>${esc(x.faultCodes.join(', ') || '—')}</td><td class="num">${h.analysis.alerts.filter((a) => a.severity !== 'info').length}</td></tr>`;
  })));
}

function renderTasks(s) {
  $('#taskCount').textContent = s.tasks.length ? `${s.tasks.length}` : '';
  if (!selectedTask && s.tasks[0]) selectedTask = s.tasks[0].taskId;
  render('tasks', table(['Task', 'Vehicle', 'Route', 'Stage', 'State', 'Created'], s.tasks.map((t) => `<tr data-select="${esc(t.taskId)}" class="${t.taskId === selectedTask ? 'is-selected' : ''}">
    <td><span class="wm-code">${esc(t.taskId)}</span></td><td>${esc(t.vehicleId ?? '—')}</td>
    <td>${badge(t.mode === 'gateway' ? (t.gateway ?? 'gateway') : t.mode, t.mode === 'gateway' ? 'gateway' : 'direct')}</td><td>${esc(stageLabel(t.stage))}</td><td>${badge(t.state)}</td><td>${esc(time(t.createdAt))}</td></tr>`),
  { empty: 'No service tasks yet. Generate telemetry with an issue, then send it to the service agent.' }));
  const t = s.tasks.find((x) => x.taskId === selectedTask);
  if (!t) return render('taskDetail', '');
  const r = t.result;
  const resultHtml = r ? `
    <h3 class="wm-sub">Agent B response</h3>
    <div class="wm-result">
      <div class="wm-kv"><span class="k">Recommendation</span><span class="v">${esc(r.recommendation.replace(/_/g, ' '))}</span></div>
      <div class="wm-kv"><span class="k">Proposed appointment</span><span class="v">${r.appointment ? esc(dateTime(r.appointment.start)) : '—'}</span>${r.appointment ? `<span class="wm-muted">${esc(r.appointment.mechanic.name)}, ${esc(r.appointment.bay.name)}</span>` : ''}</div>
      <div class="wm-kv"><span class="k">Parts order</span><span class="v">${r.partsOrder ? esc(r.partsOrder.orderId) : 'Not needed'}</span>${r.partsOrder ? `<span class="wm-muted">ETA ${esc(r.partsOrder.eta)}</span>` : ''}</div>
      <div class="wm-kv"><span class="k">Estimate</span><span class="v">${esc(r.estimate.currency)} ${esc(r.estimate.total.toLocaleString())}</span><span class="wm-muted">${esc(r.estimate.laborHours)} h labour</span></div>
    </div>
    <h3 class="wm-sub">Parts</h3>
    ${table(['Part', 'Required', 'Reserved', 'Ordered', 'Stock'], r.inventory.map((c) => {
      const rsv = r.reservations.filter((x) => x.partNo === c.partNo).reduce((a, x) => a + x.qty, 0);
      const ord = r.partsOrder?.lines.find((l) => l.partNo === c.partNo)?.qty ?? 0;
      return `<tr><td>${esc(c.name)}<br><span class="wm-code wm-muted">${esc(c.partNo)}</span></td><td class="num">${c.required}</td><td class="num">${rsv}</td><td class="num">${ord}</td><td>${badge(c.status)}</td></tr>`;
    }), { empty: 'No parts required.' })}` : (t.error ? `<div class="wm-warning" role="alert" style="margin-top:12px"><strong>Request failed.</strong> ${esc(t.error)}</div>` : '');
  render('taskDetail', `
    <div class="wm-section" style="margin-top:16px">
      <div class="wm-row" style="justify-content:space-between">
        <h3 class="wm-h" style="margin:0">Task timeline <span class="wm-count wm-code">${esc(t.taskId)}</span></h3>
        <div class="wm-row"><button class="wm-btn" data-task-action="refresh">Get task status</button><button class="wm-btn quiet" data-task-action="cancel">Cancel task</button></div>
      </div>
      <p class="wm-muted">Route at send time: <span class="wm-code">${esc((t.route ?? []).join(' → ') || '—')}</span></p>
      <ol class="wm-timeline">${t.timeline.map((e) => `<li><div class="t">${esc(stageLabel(e.stage))} ${badge(e.state)} ${badge(`via ${e.via}`, e.via === 'gateway' ? 'gateway' : 'direct')}</div><div class="d">${esc(e.text ?? '')} <span class="wm-muted">${esc(time(e.at))}</span></div></li>`).join('')}</ol>
      ${resultHtml}
      ${jsonBlock(`a-task-${t.taskId}`, 'Raw task record', t)}
    </div>`);
}

let lastCentral = 0;
async function renderCentralAudit(gatewayEnabled) {
  if (Date.now() - lastCentral < 3000) return;
  lastCentral = Date.now();
  try {
    const { events } = await api(CFG.gatewayUrl, '/api/audit?agent=agent-a&limit=12');
    render('central', `${gatewayEnabled ? '' : '<div class="wm-warning" style="margin-bottom:8px"><strong>Direct mode.</strong> New calls do not reach the gateway, so nothing new is recorded here.</div>'}
      ${table(['Time', 'Caller → target', 'Skill', 'AuthN', 'AuthZ', 'Result'], events.map((e) => `<tr><td>${esc(time(e.timestamp))}</td><td>${esc(e.caller)} → ${esc(e.target)}</td><td>${esc(e.skill ?? e.type)}</td><td>${badge(e.authentication ?? 'n/a')}</td><td>${badge(e.authorization ?? 'n/a')}</td><td>${badge(String(e.responseStatus ?? ''), e.responseStatus < 300 ? 'ok' : 'bad')}</td></tr>`), { empty: 'No gateway audit records for agent-a yet.' })}`);
  } catch {
    render('central', '<div class="wm-empty">Gateway dashboard API not reachable.</div>');
  }
}

async function run(btn, fn) {
  btn.disabled = true;
  try { await fn(); } catch (e) { toast(e.message, 'error'); } finally { btn.disabled = false; refresh(); }
}

$('#vehicle').addEventListener('change', (e) => { vehicleId = e.target.value; selectedTask = null; refresh(); });
$('#gen').addEventListener('click', (e) => run(e.currentTarget, async () => {
  await api(BASE, '/api/telemetry', { method: 'POST', body: { vehicleId, scenario: $('#scenario').value } });
  toast('Telemetry generated');
}));
$('#send').addEventListener('click', (e) => run(e.currentTarget, async () => {
  const rec = await api(BASE, '/api/service-request', { method: 'POST', body: { vehicleId } });
  selectedTask = rec.taskId;
  toast(rec.state === 'failed' ? `Request failed: ${rec.error}` : `Task ${rec.taskId} sent (${rec.mode === 'gateway' ? 'via A2A Gateway' : 'direct A2A'})`, rec.state === 'failed' ? 'error' : '');
}));
$('#tasks').addEventListener('click', (e) => { const tr = e.target.closest('[data-select]'); if (tr) { selectedTask = tr.dataset.select; refresh(); } });
$('#taskDetail').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-task-action]');
  if (!btn || !selectedTask) return;
  run(btn, async () => {
    const res = await api(BASE, `/api/tasks/${encodeURIComponent(selectedTask)}/${btn.dataset.taskAction}`, { method: 'POST' });
    const err = res.response?.body?.error;
    toast(err ? err.message : btn.dataset.taskAction === 'cancel' ? 'Task canceled' : `Task is ${res.record.state}`, err ? 'error' : '');
  });
});
$('#probeButtons').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-probe]');
  if (!btn) return;
  run(btn, async () => { const p = await api(BASE, '/api/probe', { method: 'POST', body: { type: btn.dataset.probe } }); toast(`${p.type.replace(/_/g, ' ')}: ${p.outcome}`, p.blocked ? '' : 'error'); });
});
bindModeBand('mode', BASE, refresh);
initChrome();
initIdentity({ baseUrl: BASE });
initGatewayPanel({ baseUrl: BASE, refresh }).catch((e) => console.warn('gateway panel', e));
poll(refresh, 1200);
