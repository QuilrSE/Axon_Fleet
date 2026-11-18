import { CFG, api, render, esc, $, toast, time, badge, stageLabel, table, jsonBlock, modeBand, bindModeBand, controlsList, eventsTable, exchangesList, poll, offline, dateTime, kvList } from './common.js';
import { initGatewayPanel, renderGatewayList } from './gateways.js';
import { initIdentity, heroTags } from './identity.js';
import { initChrome } from './common.js';

const BASE = CFG.agentBUrl;
let selectedTask = null;

async function refresh() {
  let s;
  try { s = await api(BASE, '/api/state'); } catch (e) { return offline('mode', 'Agent B', BASE, e); }
  render('heroTags', heroTags(s.mode));
  render('mode', modeBand({ mode: s.mode, self: 'agent-b', peer: 'Agent A' }));
  renderTasks(s);
  render('inventory', table(['Part', 'On hand', 'Reserved', 'Available', 'Lead time', 'Unit price'], s.inventory.map((p) => `<tr>
    <td>${esc(p.name)}<br><span class="wm-code wm-muted">${esc(p.partNo)}</span></td><td class="num">${p.onHand}</td><td class="num">${p.reserved}</td>
    <td class="num">${p.available > 0 ? p.available : badge('0', 'out_of_stock')}</td><td class="num">${p.leadTimeDays} d</td><td class="num">${esc(p.currency)} ${p.unitPrice}</td></tr>`)));
  render('orders', table(['Order', 'Task', 'Lines', 'ETA', 'Status'], s.orders.map((o) => `<tr>
    <td><span class="wm-code">${esc(o.orderId)}</span></td><td><span class="wm-code">${esc(o.taskId)}</span></td>
    <td>${o.lines.map((l) => `${l.qty} × ${esc(l.name)}`).join('<br>')}</td><td>${esc(o.eta)}</td><td>${badge(o.status)}</td></tr>`), { empty: 'No parts orders yet. Orders are created when stock cannot cover a request.' }));
  renderSchedule(s.schedule);
  render('appointments', table(['When', 'Vehicle', 'Mechanic', 'Bay', 'Status'], s.schedule.appointments.map((a) => `<tr>
    <td>${esc(dateTime(a.start))}</td><td>${esc(a.vehicleId)}</td><td>${esc(a.mechanic.name)}</td><td>${esc(a.bay.name)}</td><td>${badge(a.status)}</td></tr>`), { empty: 'No appointments proposed yet.' }));
  render('status', kvList([
    ['Agent ID', `<span class="wm-code">${esc(s.agent.id)}</span>`],
    ['Agent Card', `<a href="${esc(s.agent.cardUrl)}" target="_blank" rel="noopener">Open card JSON</a>`],
    ['Agent runtime', `${esc(s.agent.runtime.runtime)} graph: ${s.agent.runtime.nodes.map((n) => `<span class="wm-code">${esc(n.id)}</span>`).join(' → ')}`],
    ['Registration', badge(s.mode.registration.status)],
    ['Gateway health', badge(s.mode.gatewayHealth.status)],
  ]));
  render('controls', controlsList(s.mode.controls));
  if (s.mode.gateways) renderGatewayList(s.mode.gateways, s.mode.gatewayEnabled);
  render('events', eventsTable(s.securityEvents.slice(0, 30), { showCallerVerification: false }));
  render('exchanges', exchangesList('b-x', s.exchanges.slice(0, 15)));
}

function renderTasks(s) {
  $('#taskCount').textContent = s.tasks.length ? `${s.tasks.length}` : '';
  if (!selectedTask && s.tasks[0]) selectedTask = s.tasks[0].id;
  render('tasks', table(['Task', 'Vehicle', 'Arrived via', 'Caller', 'Stage', 'State'], s.tasks.map((t) => {
    const ib = t.metadata.inbound ?? {};
    return `<tr data-select="${esc(t.id)}" class="${t.id === selectedTask ? 'is-selected' : ''}">
      <td><span class="wm-code">${esc(t.id)}</span><br><span class="wm-muted">${esc(t.metadata.envelope?.skill ?? '')}</span></td>
      <td>${esc(t.metadata.vehicleId ?? '—')}</td><td>${badge(ib.via === 'gateway' ? (ib.gateway ?? 'gateway') : (ib.via ?? '—'), ib.via === 'gateway' ? 'gateway' : 'direct')}</td>
      <td>${esc(ib.verifiedCaller ?? ib.claimedSender ?? '—')}</td>
      <td>${esc(stageLabel(t.metadata.stage))}</td><td>${badge(t.status.state)}</td></tr>`;
  }), { empty: 'Waiting for A2A tasks from Agent A.' }));

  const task = s.tasks.find((t) => t.id === selectedTask);
  const wo = s.workOrders.find((w) => w.taskId === selectedTask);
  if (!task) return render('taskDetail', '');
  const t = wo?.telemetry;
  const summary = t ? `<div class="wm-metrics">
      ${[['Vehicle', `${wo.vehicle.vehicleId}`], ['Odometer', `${t.odometerKm.toLocaleString()} km`], ['Battery health', `${t.batterySohPct}%`], ['Drivetrain', `${t.drivetrainTempC} °C`], ['Lowest tire', `${Math.min(...Object.values(t.tirePressurePsi))} psi`], ['Front pads', `${t.brakePadWearPct.front}%`], ['Faults', t.faultCodes.join(', ') || 'none']]
        .map(([k, v]) => `<div class="wm-metric"><div class="v">${esc(v)}</div><div class="k">${esc(k)}</div></div>`).join('')}
    </div>` : '';
  const findings = wo?.diagnosis ? `<h3 class="wm-sub">Findings &amp; required parts</h3>
    <ul class="wm-alerts">${wo.diagnosis.findings.map((f) => `<li>${badge(f.severity)}<div><div class="title">${esc(f.description)}</div><div class="detail wm-code">${esc(f.code)}</div></div></li>`).join('') || '<li>No findings — vehicle healthy.</li>'}</ul>` : '';
  const inv = wo?.inventory ? `<h3 class="wm-sub">Inventory status</h3>${table(['Part', 'Required', 'Available', 'Shortfall', 'Status'], wo.inventory.map((c) => `<tr><td>${esc(c.name)}</td><td class="num">${c.required}</td><td class="num">${c.available}</td><td class="num">${c.shortfall}</td><td>${badge(c.status)}</td></tr>`), { empty: 'No parts required.' })}` : '';
  const rsv = wo?.reservations ? `<h3 class="wm-sub">Reservations</h3>${table(['Reservation', 'Part', 'Qty', 'Status'], wo.reservations.map((r) => `<tr><td><span class="wm-code">${esc(r.reservationId)}</span></td><td>${esc(r.name)}</td><td class="num">${r.qty}</td><td>${badge(r.status)}</td></tr>`), { empty: 'Nothing reserved.' })}` : '';
  const order = wo && wo.partsOrder !== undefined && wo.diagnosis ? `<h3 class="wm-sub">Parts order</h3>${wo.partsOrder ? `<p>${badge(wo.partsOrder.status)} <span class="wm-code">${esc(wo.partsOrder.orderId)}</span> from ${esc(wo.partsOrder.supplier)}, ETA ${esc(wo.partsOrder.eta)}</p>` : '<p class="wm-muted">No order needed.</p>'}` : '';
  const appt = wo?.appointment ? `<h3 class="wm-sub">Proposed appointment</h3><p><strong>${esc(dateTime(wo.appointment.start))}</strong> with ${esc(wo.appointment.mechanic.name)} in ${esc(wo.appointment.bay.name)}, about ${esc(wo.appointment.estDurationHours)} h. ${badge(wo.appointment.status)}</p>` : '';
  render('taskDetail', `<div class="wm-section" style="margin-top:16px">
    <h3 class="wm-h">Task <span class="wm-code wm-count">${esc(task.id)}</span> ${badge(task.status.state)}</h3>
    ${summary}${findings}${inv}${rsv}${order}${appt}
    <h3 class="wm-sub">A2A task timeline</h3>
    <ol class="wm-timeline">${task.metadata.stageHistory.map((h) => `<li><div class="t">${esc(stageLabel(h.stage))} ${badge(h.state)}</div><div class="d wm-muted">${esc(time(h.at))}</div></li>`).join('')}</ol>
    ${jsonBlock(`b-task-${task.id}`, 'Raw A2A task', task)}
  </div>`);
}

function renderSchedule(sched) {
  const days = [...new Set(sched.slots.map((s) => s.date))].slice(0, 3);
  const slots = sched.slots.filter((s) => days.includes(s.date));
  const cols = `minmax(150px, auto) repeat(${slots.length}, minmax(34px, 1fr))`;
  const hdr = `<div></div>${slots.map((s) => `<div class="hdr" title="${esc(s.start)}">${s.hour === 9 ? `${esc(new Date(s.start).toLocaleDateString([], { weekday: 'short' }))} ` : ''}${s.hour}h</div>`).join('')}`;
  const row = (label, key, id) => `<div class="rowh">${esc(label)}</div>${slots.map((s) => { const st = s[key][id]; return `<div class="cell ${st}" title="${esc(st)}">${st === 'held' ? '●' : st === 'free' ? '' : '–'}</div>`; }).join('')}`;
  render('schedule', `<div class="wm-table-wrap" style="padding:8px"><div class="wm-sched" style="grid-template-columns:${cols}">
    ${hdr}${sched.mechanics.map((m) => row(m.name, 'mechanics', m.id)).join('')}
    ${sched.bays.map((b) => row(b.name, 'bays', b.id)).join('')}
  </div></div>
  <p class="wm-muted">Mechanic skills: ${sched.mechanics.map((m) => `${esc(m.name.replace(' (synthetic)', ''))} (${esc(m.skills.join(', '))})`).join('; ')}</p>`);
}

$('#tasks').addEventListener('click', (e) => { const tr = e.target.closest('[data-select]'); if (tr) { selectedTask = tr.dataset.select; refresh(); } });
$('#resetData').addEventListener('click', async () => {
  try { await api(BASE, '/api/reset', { method: 'POST' }); selectedTask = null; toast('Inventory, schedule and tasks reset'); refresh(); } catch (e) { toast(e.message, 'error'); }
});
bindModeBand('mode', BASE, refresh);
initChrome();
initIdentity({ baseUrl: BASE });
initGatewayPanel({ baseUrl: BASE, refresh }).catch((e) => console.warn('gateway panel', e));
poll(refresh, 1200);
