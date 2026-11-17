// Telemetry engine: synthetic source + local analysis + per-vehicle history.
// Swap TelemetryGenerator for a CAN/OBD/OEM-cloud adapter with the same generate() contract.
import { TelemetryGenerator, SCENARIOS, validateTelemetry } from '@axon-fleet/shared';
import { evaluate } from './maintenanceRules.js';

export class TelemetryEngine {
  constructor({ seed = 42, historySize = 50 } = {}) {
    this.generator = new TelemetryGenerator({ seed });
    this.historySize = historySize;
    this.history = new Map();
  }

  vehicles() { return this.generator.vehicles(); }
  scenarios() { return SCENARIOS; }

  generate(vehicleId, scenario = 'normal') {
    const telemetry = this.generator.generate(vehicleId, scenario);
    const errors = validateTelemetry(telemetry);
    if (errors.length) throw new Error(`Generated telemetry failed validation: ${errors.join('; ')}`);
    const analysis = evaluate(telemetry);
    const record = { telemetry: { ...telemetry, predictedMaintenance: analysis.predictedMaintenance }, analysis };
    const list = this.history.get(vehicleId) ?? [];
    list.unshift(record);
    if (list.length > this.historySize) list.length = this.historySize;
    this.history.set(vehicleId, list);
    return record;
  }

  latest(vehicleId) { return this.history.get(vehicleId)?.[0] ?? null; }
  historyFor(vehicleId, limit = 12) { return (this.history.get(vehicleId) ?? []).slice(0, limit); }
}
