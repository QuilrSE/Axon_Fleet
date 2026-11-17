// Telemetry schema + validation. All data in this PoC is synthetic.
export const TELEMETRY_SCHEMA = {
  vehicleId: 'string', vin: 'string (17 chars, synthetic)', timestamp: 'ISO-8601',
  odometerKm: 'number >= 0', batterySocPct: 'number 0-100', batterySohPct: 'number 0-100',
  drivetrainTempC: 'number -40..200', ambientTempC: 'number',
  tirePressurePsi: '{ fl, fr, rl, rr: number }', brakePadWearPct: '{ front, rear: number 0-100 }',
  faultCodes: 'string[] (OBD-II style)', powertrain: '"BEV" | "HEV"', synthetic: 'true',
};

const isNum = (v, min = -Infinity, max = Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

export function validateTelemetry(t) {
  const errors = [];
  if (!t || typeof t !== 'object') return ['telemetry must be an object'];
  if (typeof t.vehicleId !== 'string' || !t.vehicleId) errors.push('vehicleId is required');
  if (typeof t.vin !== 'string' || t.vin.length !== 17) errors.push('vin must be a 17-character string');
  if (Number.isNaN(Date.parse(t.timestamp))) errors.push('timestamp must be ISO-8601');
  if (!isNum(t.odometerKm, 0)) errors.push('odometerKm must be >= 0');
  if (!isNum(t.batterySocPct, 0, 100)) errors.push('batterySocPct must be 0-100');
  if (!isNum(t.batterySohPct, 0, 100)) errors.push('batterySohPct must be 0-100');
  if (!isNum(t.drivetrainTempC, -40, 200)) errors.push('drivetrainTempC must be -40..200');
  for (const k of ['fl', 'fr', 'rl', 'rr']) if (!isNum(t.tirePressurePsi?.[k], 0, 80)) errors.push(`tirePressurePsi.${k} must be 0-80`);
  for (const k of ['front', 'rear']) if (!isNum(t.brakePadWearPct?.[k], 0, 100)) errors.push(`brakePadWearPct.${k} must be 0-100`);
  if (!Array.isArray(t.faultCodes) || t.faultCodes.some((c) => !/^[PCBU][0-9A-F]{4}$/.test(c))) errors.push('faultCodes must be OBD-II style codes');
  return errors;
}
