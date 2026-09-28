// SPDX-License-Identifier: MIT
// Comparaison baseline vs candidat : agrège par médiane des runs de chaque
// cellule, imprime un tableau markdown des métriques clefs, et sort en code 1
// si régression > 15 % sur tbtMs ou parseCalls (utilisable en garde pre-merge).
// Usage : node tests/perf/compare.mjs --base results/baseline-X --cand results/fix-Y
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
function arg(name) {
    const i = args.indexOf('--' + name);
    return i === -1 ? null : args[i + 1];
}
function resolveDir(d) {
    if (!d) return null;
    return path.isAbsolute(d) ? d : path.join(__dirname, d.startsWith('results') ? d : path.join('results', d));
}
const baseDir = resolveDir(arg('base'));
const candDir = resolveDir(arg('cand'));
if (!baseDir || !candDir) { console.error('--base et --cand requis'); process.exit(2); }

const METRICS = [
    ['longTasks.tbtMs', 'TBT ms', 'lower'],
    ['longTasks.count', 'LongTasks', 'lower'],
    ['longTasks.p95', 'LT p95 ms', 'lower'],
    ['fps.mean', 'FPS', 'higher'],
    ['fps.droppedPct', 'Dropped', 'lower'],
    ['markdown.parseCalls', 'md parses', 'lower'],
    ['markdown.hljsMs', 'hljs ms', 'lower'],
    ['cdp.ScriptDuration', 'Script s', 'lower'],
    ['cdp.LayoutDuration', 'Layout s', 'lower'],
    ['cls', 'CLS', 'lower'],
];
const GUARD = [['longTasks.tbtMs', 50], ['markdown.parseCalls', 20]];   // [chemin, plancher]

function getPath(o, p) {
    return p.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
}
function median(vals) {
    const v = vals.filter((x) => typeof x === 'number' && !Number.isNaN(x)).sort((a, b) => a - b);
    if (!v.length) return undefined;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

// Charge un dossier → { groupKey: [entries] }. Les sous-fenêtres du scénario
// d sont éclatées en groupes distincts (clé suffixée ::label).
function load(dir) {
    const groups = {};
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        const key = f.replace(/__r\d+\.json$/, '');
        if (Array.isArray(data.sub)) {
            for (const sub of data.sub) {
                (groups[`${key}::${sub.label}`] ||= []).push(sub);
            }
        } else {
            (groups[key] ||= []).push(data);
        }
    }
    return groups;
}

const base = load(baseDir);
const cand = load(candDir);
const failures = [];

for (const key of Object.keys(base).sort()) {
    if (!cand[key]) { console.log(`\n## ${key}\n_absent du candidat_`); continue; }
    console.log(`\n## ${key}  (base n=${base[key].length}, cand n=${cand[key].length})`);
    console.log('| métrique | base | cand | Δ |');
    console.log('|---|---|---|---|');
    for (const [p, lbl, dir] of METRICS) {
        const b = median(base[key].map((e) => getPath(e, p)));
        const c = median(cand[key].map((e) => getPath(e, p)));
        if (b === undefined && c === undefined) continue;
        let delta = '';
        if (typeof b === 'number' && typeof c === 'number' && b !== 0) {
            const pctD = ((c - b) / Math.abs(b)) * 100;
            const better = dir === 'lower' ? pctD < 0 : pctD > 0;
            delta = `${pctD > 0 ? '+' : ''}${pctD.toFixed(0)} % ${Math.abs(pctD) < 5 ? '≈' : better ? '✓' : '✗'}`;
        }
        console.log(`| ${lbl} | ${fmt(b)} | ${fmt(c)} | ${delta} |`);
    }
    for (const [p, floor] of GUARD) {
        const b = median(base[key].map((e) => getPath(e, p)));
        const c = median(cand[key].map((e) => getPath(e, p)));
        if (typeof b === 'number' && typeof c === 'number' && b >= floor && c > b * 1.15) {
            failures.push(`${key} : ${p} ${fmt(b)} → ${fmt(c)} (>+15 %)`);
        }
    }
}

function fmt(x) {
    if (x === undefined) return '—';
    return Math.abs(x) >= 100 ? String(Math.round(x)) : String(Math.round(x * 100) / 100);
}

if (failures.length) {
    console.log('\n✗ RÉGRESSIONS :\n' + failures.map((f) => '  - ' + f).join('\n'));
    process.exit(1);
}
console.log('\n✓ Pas de régression au-delà du seuil (+15 %).');
