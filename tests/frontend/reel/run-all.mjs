// SPDX-License-Identifier: MIT
/** tests/frontend/reel/run-all.mjs — rejoue tous les parcours `*-reel-verify.mjs` contre le core TS réel, en série, et résume */
// Usage : ELPIS_NODE_MODULES=…/browser-service/node_modules [ELPIS_CHROMIUM=…] node tests/frontend/reel/run-all.mjs [filtre]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { construireCore } from '../lib/core-reel.mjs';

const dir = path.dirname(new URL(import.meta.url).pathname);
const filtre = process.argv[2] || '';
const parcours = fs.readdirSync(dir).filter((n) => n.endsWith('-reel-verify.mjs') && n.includes(filtre)).sort();
construireCore({ forcer: process.env.ELPIS_CORE_BUILD !== '0' });
const bilan = [];
for (const p of parcours) {
    console.log(`▶ ${p}`);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [path.join(dir, p)], { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', timeout: 300000 });
    process.stdout.write(r.stdout || '');
    const ligne = (r.stdout || '').trim().split('\n').pop();
    bilan.push({ p, ok: r.status === 0, ligne, s: Math.round((Date.now() - t0) / 1000) });
}
console.log('\n— Parcours réels —');
for (const b of bilan) console.log(`${b.ok ? '✓' : '✗'} ${b.p.padEnd(32)} ${String(b.s).padStart(3)} s  ${b.ligne}`);
const ko = bilan.filter((b) => !b.ok).length;
console.log(`${bilan.length - ko}/${bilan.length} parcours OK`);
process.exit(ko || !bilan.length ? 1 : 0);
