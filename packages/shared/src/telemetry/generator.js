// Deterministic (seeded) synthetic telemetry generator.
// Replace with a real telemetry source by implementing the same generate(vehicleId, scenario) contract.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const VEHICLES = Object.freeze([
  { vehicleId: 'veh-001', vin: 'SYNTH0EV0SEDAN001', label: 'EV sedan (SYN-001)', model: 'Aurora E-Sedan (synthetic)', powertrain: 'BEV', baseOdometerKm: 28140 },
  { vehicleId: 'veh-002', vin: 'SYNTH0EV00SUV0002', label: 'EV SUV (SYN-002)', model: 'Meridian E-SUV (synthetic)', powertrain: 'BEV', baseOdometerKm: 61220 },
  { vehicleId: 'veh-003', vin: 'SYNTH0HEV0HATCH03', label: 'Hybrid hatch (SYN-003)', model: 'Kestrel HEV (synthetic)', powertrain: 'HEV', baseOdometerKm: 44700 },
]);

export const SCENARIOS = Object.freeze({
  normal: 'Normal driving',
  brake_wear: 'Brake-pad wear above threshold',
  low_tire: 'Low tire pressure',
  battery_degradation: 'Battery degradation',
  drivetrain_overheat: 'Overheating drivetrain',
  fault_code: 'Fault code detected',
  multi_issue: 'Multiple issues',
});

const r1 = (n) => Math.round(n * 10) / 10;

export class TelemetryGenerator {
  constructor({ seed = 42 } = {}) {
    this.rand = mulberry32(seed);
    this.state = new Map(VEHICLES.map((v) => [v.vehicleId, { odometerKm: v.baseOdometerKm, soc: 78, frontPad: 38, rearPad: 27 }]));
  }

  vehicles() { return VEHICLES.map((v) => ({ ...v })); }

  generate(vehicleId, scenario = 'normal') {
    const vehicle = VEHICLES.find((v) => v.vehicleId === vehicleId);
    if (!vehicle) throw new Error(`Unknown vehicle ${vehicleId}`);
    if (!SCENARIOS[scenario]) throw new Error(`Unknown scenario ${scenario}`);
    const r = this.rand;
    const s = this.state.get(vehicleId);
    s.odometerKm = Math.round(s.odometerKm + 25 + r() * 90);
    s.soc = s.soc - (2 + r() * 5);
    if (s.soc < 15) s.soc = 92; // simulated overnight charge
    s.frontPad = Math.min(99, s.frontPad + r() * 0.4);
    s.rearPad = Math.min(99, s.rearPad + r() * 0.3);

    const t = {
      vehicleId,
      vin: vehicle.vin,
      model: vehicle.model,
      powertrain: vehicle.powertrain,
      timestamp: new Date().toISOString(),
      odometerKm: s.odometerKm,
      batterySocPct: r1(s.soc),
      batterySohPct: r1(91 - r() * 4),
      drivetrainTempC: r1(64 + r() * 12),
      ambientTempC: r1(24 + r() * 8),
      tirePressurePsi: { fl: r1(35 + r()), fr: r1(35 + r()), rl: r1(34.5 + r()), rr: r1(34.5 + r()) },
      brakePadWearPct: { front: r1(s.frontPad), rear: r1(s.rearPad) },
      faultCodes: [],
      scenario,
      synthetic: true,
    };

    switch (scenario) {
      case 'brake_wear':
        t.brakePadWearPct.front = r1(86 + r() * 8);
        t.brakePadWearPct.rear = r1(58 + r() * 10);
        break;
      case 'low_tire':
        t.tirePressurePsi.rl = r1(24 + r() * 1.5);
        t.tirePressurePsi.fr = r1(28.5 + r());
        break;
      case 'battery_degradation':
        t.batterySohPct = r1(73 + r() * 4);
        t.faultCodes.push(vehicle.powertrain === 'HEV' ? 'P0A80' : 'P0A7F');
        break;
      case 'drivetrain_overheat':
        t.drivetrainTempC = r1(108 + r() * 9);
        t.faultCodes.push('P0C73');
        break;
      case 'fault_code':
        t.faultCodes.push(r() < 0.5 ? 'C0035' : 'P0AA6', 'U0100');
        break;
      case 'multi_issue':
        t.brakePadWearPct.front = r1(88 + r() * 4);
        t.tirePressurePsi.fr = r1(27 + r());
        t.drivetrainTempC = r1(97 + r() * 4);
        break;
      default:
        break;
    }
    return t;
  }
}
