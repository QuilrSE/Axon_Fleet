#!/usr/bin/env node
// Starts gateway → Agent B → Agent A → dashboard with prefixed, colourised output. Ctrl+C stops all.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const services = [
  { name: 'gateway  ', color: 35, file: 'packages/a2a-gateway/src/index.js' },
  { name: 'partner  ', color: 34, file: 'packages/partner-gateway-mock/src/index.js', delay: 200 },
  { name: 'agent-b  ', color: 33, file: 'packages/agent-b/src/index.js', delay: 500 },
  { name: 'agent-a  ', color: 36, file: 'packages/agent-a/src/index.js', delay: 900 },
  { name: 'dashboard', color: 32, file: 'packages/web-dashboard/src/server.js', delay: 1100 },
];
const children = [];
const prefix = (s, line) => `\x1b[${s.color}m[${s.name}]\x1b[0m ${line}`;

for (const s of services) {
  setTimeout(() => {
    const child = spawn(process.execPath, [path.join(root, s.file)], { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    for (const stream of [child.stdout, child.stderr]) {
      let buf = '';
      stream.on('data', (d) => {
        buf += d;
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const l of lines) if (l.trim()) console.log(prefix(s, l));
      });
    }
    child.on('exit', (code) => console.log(prefix(s, `exited with code ${code}`)));
  }, s.delay ?? 0);
}

setTimeout(() => console.log('\n  Dashboard → http://localhost:' + (process.env.DASHBOARD_PORT ?? 5173) + '\n'), 2500);
const stop = () => { for (const c of children) c.kill('SIGTERM'); setTimeout(() => process.exit(0), 300); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
