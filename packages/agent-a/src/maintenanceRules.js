// Local, on-vehicle maintenance rules (Agent A's own analysis — independent of the dealer's diagnosis).
export const THRESHOLDS = Object.freeze({
  brakeWarn: 70, brakeCritical: 85,
  tireWarnPsi: 30, tireCriticalPsi: 26,
  sohWarn: 80, sohCritical: 75,
  tempWarnC: 95, tempCriticalC: 110,
  serviceIntervalKm: 15000, serviceSoonKm: 1000,
});

export function evaluate(t) {
  const alerts = [];
  const add = (code, severity, title, detail, predictedService) => alerts.push({ code, severity, title, detail, predictedService });
  const T = THRESHOLDS;

  for (const axle of ['front', 'rear']) {
    const w = t.brakePadWearPct[axle];
    if (w >= T.brakeWarn) add(`BRAKE_${axle.toUpperCase()}`, w >= T.brakeCritical ? 'critical' : 'warning', `${axle === 'front' ? 'Front' : 'Rear'} brake pads worn`, `${w}% wear (threshold ${T.brakeWarn}%)`, `${axle} brake pad replacement`);
  }
  for (const [pos, psi] of Object.entries(t.tirePressurePsi)) {
    if (psi < T.tireWarnPsi) add(`TIRE_${pos.toUpperCase()}`, psi < T.tireCriticalPsi ? 'critical' : 'warning', `Low tire pressure ${pos.toUpperCase()}`, `${psi} psi (min ${T.tireWarnPsi} psi)`, 'tire inspection / TPMS service');
  }
  if (t.batterySohPct < T.sohWarn) add('BATTERY_SOH', t.batterySohPct < T.sohCritical ? 'critical' : 'warning', 'Battery degradation', `State of health ${t.batterySohPct}% (min ${T.sohWarn}%)`, 'HV battery module assessment');
  if (t.drivetrainTempC > T.tempWarnC) add('DRIVETRAIN_TEMP', t.drivetrainTempC > T.tempCriticalC ? 'critical' : 'warning', 'Drivetrain overheating', `${t.drivetrainTempC} °C (max ${T.tempWarnC} °C)`, 'drive-unit cooling service');
  for (const code of t.faultCodes) add(`DTC_${code}`, code.startsWith('U') ? 'warning' : 'critical', `Fault code ${code}`, 'Diagnostic trouble code reported by vehicle ECU', `diagnose ${code}`);

  const kmToService = T.serviceIntervalKm - (t.odometerKm % T.serviceIntervalKm);
  if (kmToService <= T.serviceSoonKm) add('SERVICE_INTERVAL', 'info', 'Scheduled service due soon', `${kmToService} km to next ${T.serviceIntervalKm} km service`, 'scheduled maintenance');

  const severityRank = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);
  return {
    alerts,
    predictedMaintenance: [...new Set(alerts.map((a) => a.predictedService))],
    serviceNeeded: alerts.some((a) => a.severity !== 'info'),
    kmToScheduledService: kmToService,
  };
}
