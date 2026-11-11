// SPDX-License-Identifier: MIT
// A/B entrelacé : deux arbres (chacun avec son frontend/dist construit) servis sur deux ports, runs alternés A, B, A, B…
// puis médianes par cellule. Neutralise la dérive de la machine entre deux campagnes ; lancer aussi l'ordre inverse
// (--a et --b permutés) : le second côté d'une paire paie un biais de quelques pour cent.
// Usage : node tests/perf/ab.mjs --a /chemin/arbreA --b /chemin/arbreB --only f_stream_tools --n 5 --label ab-x
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : args[i + 1]; };
const A = path.resolve(opt('a', '')), B = path.resolve(opt('b', ''));
const only = opt('only', null), n = Number(opt('n', 5)), label = opt('label', 'ab');
if (!only || !fs.existsSync(path.join(A, 'tests/perf/run.mjs')) || !fs.existsSync(path.join(B, 'tests/perf/run.mjs'))) {
    console.error('usage : --a ARBRE --b ARBRE --only SCENARIO [--n 5] [--label ab]'); process.exit(2);
}
const cotes = [['a', A, 8911], ['b', B, 8912]];
for (let i = 1; i <= n; i++) for (const [c, arbre, port] of cotes) {
    const r = spawnSync('node', ['tests/perf/run.mjs', '--label', `${label}-${c}-${i}`, '--quick', '--runs', '1', '--only', only],
        { cwd: arbre, env: { ...process.env, PERF_PORT: String(port) }, encoding: 'utf8' });
    const ligne = (r.stdout || '').split('\n').find((l) => l.startsWith('▶')) || r.stderr.split('\n')[0];
    console.log(`${c}${i} ${ligne}`);
}

const med = (v) => { v = v.filter((x) => x != null).sort((x, y) => x - y); return v.length ? v[Math.floor(v.length / 2)] : null; };
const cellules = {};
for (const [c, arbre] of cotes) {
    const base = path.join(arbre, 'tests/perf/results');
    for (const d of fs.readdirSync(base).filter((x) => x.startsWith(`${label}-${c}-`)))
        for (const f of fs.readdirSync(path.join(base, d)).filter((f) => f.endsWith('.json') && f !== '_meta.json')) {
            const k = f.replace(/__r\d+\.json$/, '');
            ((cellules[k] ??= { a: [], b: [] })[c]).push(JSON.parse(fs.readFileSync(path.join(base, d, f), 'utf8')));
        }
}
for (const [k, v] of Object.entries(cellules)) {
    console.log(`\n## ${k} (A n=${v.a.length}, B n=${v.b.length})`);
    const lignes = k.startsWith('i_boot')
        ? [['FCP ms', (j) => j.fcpMs], ['montage ms', (j) => j.montageMs], ['DCL ms', (j) => j.dclMs]]
        : [['TBT ms', (j) => j.longTasks?.tbtMs], ['script s', (j) => j.cdp?.ScriptDuration],
           ['layout s', (j) => j.cdp?.LayoutDuration], ['tâches s', (j) => j.cdp?.TaskDuration]];
    for (const [nom, fn] of lignes) {
        const a = med(v.a.map(fn)), b = med(v.b.map(fn));
        console.log(`${nom.padEnd(11)} ${String(a).padStart(8)} ${String(b).padStart(8)}  ${a ? Math.round((b - a) / a * 100) + ' %' : ''}`);
    }
}
