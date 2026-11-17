// Node.js-only helpers. Import from '@axon-fleet/shared/node' (never from Workers code).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { setNetworkInterfacesProvider } from './utils/network.js';

// LAN address suggestions in the dashboard need the host's network interfaces.
setNetworkInterfacesProvider(() => os.networkInterfaces());

let loaded = false;
/** Minimal .env loader (no dotenv dependency). Real env vars always win. */
export function loadEnv(fileName = '.env') {
  if (loaded) return null;
  loaded = true;
  let dir = process.cwd();
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, fileName);
    if (fs.existsSync(candidate)) {
      for (const raw of fs.readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq < 1) continue;
        const key = line.slice(0, eq).trim();
        let value = line.slice(eq + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        if (process.env[key] === undefined) process.env[key] = value;
      }
      return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** RuntimeConfig store backed by a JSON file (the gateway toggle and gateway profiles survive restarts). */
export function fileStore(file) {
  return {
    load: () => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null),
    save: (values) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(values, null, 2)); },
  };
}
