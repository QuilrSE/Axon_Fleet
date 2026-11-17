// Deletes persisted gateway-toggle state so both agents start in the default mode.
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve(process.env.RUNTIME_DIR ?? '.runtime');
fs.rmSync(dir, { recursive: true, force: true });
console.log(`Removed ${dir}`);
