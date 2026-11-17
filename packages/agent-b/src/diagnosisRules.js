// Telemetry → findings, parts and labour. Pure function so it can be unit-tested and later
// replaced by an OEM repair-procedure service.
const FAULT_CATALOG = {
  P0A80: { description: 'Replace hybrid battery pack', severity: 'critical', skill: 'ev_hv', parts: { HEV: 'HYB-BAT-MOD', BEV: 'HV-BAT-MOD' }, laborHours: 3 },
  P0A7F: { description: 'HV battery pack deterioration', severity: 'warning', skill: 'ev_hv', parts: { HEV: 'HYB-BAT-MOD', BEV: 'HV-BAT-MOD' }, laborHours: 3 },
  P0AA6: { description: 'HV isolation fault', severity: 'critical', skill: 'ev_hv', parts: { HEV: 'HV-ISO-KIT', BEV: 'HV-ISO-KIT' }, laborHours: 2 },
  P0C73: { description: 'Electric coolant pump performance', severity: 'critical', skill: 'ev_hv', parts: { HEV: 'EDU-COOL-PUMP', BEV: 'EDU-COOL-PUMP' }, laborHours: 1.5 },
  C0035: { description: 'Left-front wheel speed sensor circuit', severity: 'warning', skill: 'brakes', parts: { HEV: 'WSS-FL', BEV: 'WSS-FL' }, laborHours: 1 },
  U0100: { description: 'Lost communication with powertrain control module', severity: 'warning', skill: 'electrical', parts: null, laborHours: 1 },
};

export const LABOR_RATE = { amount: 95, currency: 'USD', unit: 'hour', note: 'synthetic rate' };

export function diagnose(telemetry) {
  const findings = [];
  const parts = new Map();
  const services = [];
  const addPart = (partNo, qty, reason) => {
    const cur = parts.get(partNo);
    parts.set(partNo, { partNo, qty: Math.max(qty, cur?.qty ?? 0), reasons: [...(cur?.reasons ?? []), reason] });
  };
  const addService = (skill, laborHours, description) => services.push({ skill, laborHours, description });
  const pt = telemetry.powertrain === 'HEV' ? 'HEV' : 'BEV';

  const { front, rear } = telemetry.brakePadWearPct;
  if (front >= 70) {
    findings.push({ code: 'BRAKE_FRONT_WEAR', severity: front >= 85 ? 'critical' : 'warning', description: `Front brake pads ${front}% worn` });
    addPart('BRK-PAD-FR', 1, 'front pad wear');
    if (front >= 85) addPart('BRK-ROT-FR', 2, 'rotor resurfacing limit likely exceeded');
    addService('brakes', front >= 85 ? 2 : 1.2, 'Front brake service');
  }
  if (rear >= 70) {
    findings.push({ code: 'BRAKE_REAR_WEAR', severity: rear >= 85 ? 'critical' : 'warning', description: `Rear brake pads ${rear}% worn` });
    addPart('BRK-PAD-RR', 1, 'rear pad wear');
    addService('brakes', 1.2, 'Rear brake service');
  }

  const tires = Object.entries(telemetry.tirePressurePsi);
  const low = tires.filter(([, psi]) => psi < 30);
  if (low.length) {
    const worst = Math.min(...low.map(([, p]) => p));
    findings.push({ code: 'TIRE_LOW_PRESSURE', severity: worst < 26 ? 'critical' : 'warning', description: `Low pressure: ${low.map(([k, p]) => `${k.toUpperCase()} ${p} psi`).join(', ')}` });
    addPart('TPMS-SVC-KIT', low.length, 'TPMS valve service per low tire');
    addPart('TIRE-PLUG-KIT', 1, 'puncture inspection/repair');
    if (worst < 26) addPart('TIRE-235-45R18', 1, 'possible sidewall damage below 26 psi');
    addService('tires', 0.5 + 0.3 * low.length, 'Tire inspection, repair and TPMS service');
  }

  if (telemetry.batterySohPct < 80) {
    findings.push({ code: 'BATTERY_DEGRADATION', severity: telemetry.batterySohPct < 75 ? 'critical' : 'warning', description: `Battery state of health ${telemetry.batterySohPct}%` });
    addPart(pt === 'HEV' ? 'HYB-BAT-MOD' : 'HV-BAT-MOD', 1, 'battery module replacement');
    addPart('COOLANT-EV', 1, 'refill after HV work');
    addService('ev_hv', 3, 'HV battery module replacement');
  }

  if (telemetry.drivetrainTempC > 95) {
    findings.push({ code: 'DRIVETRAIN_OVERHEAT', severity: telemetry.drivetrainTempC > 110 ? 'critical' : 'warning', description: `Drivetrain temperature ${telemetry.drivetrainTempC} °C` });
    addPart('EDU-COOL-PUMP', 1, 'coolant pump suspected');
    addPart('COOLANT-EV', 2, 'coolant flush');
    addService('ev_hv', 1.5, 'Drive-unit cooling service');
  }

  for (const code of telemetry.faultCodes ?? []) {
    const f = FAULT_CATALOG[code];
    if (!f) { findings.push({ code, severity: 'warning', description: 'Unrecognised fault code — diagnostic required' }); addService('electrical', 1, `Diagnose ${code}`); continue; }
    findings.push({ code, severity: f.severity, description: f.description });
    if (f.parts) addPart(f.parts[pt], 1, `fault ${code}`);
    if (!services.some((s) => s.skill === f.skill)) addService(f.skill, f.laborHours, f.description);
  }

  return { findings, parts: [...parts.values()], services, laborHours: Math.round(services.reduce((a, s) => a + s.laborHours, 0) * 10) / 10 };
}
