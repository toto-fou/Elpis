// SPDX-License-Identifier: MIT
// Agrège les profils CPU de `run.mjs --trace` : temps self et total (moyenne par profil) par fonction et par fichier
// source, positions du build Vite ramenées aux sources par les `.map` voisines (build `vite build --sourcemap`).
// Usage : node tests/perf/profil.mjs <dossier|fichiers.cpuprofile…> [--filtre a_stream_code] [--top 30]
//         [--dist frontend/dist/assets] [--json sortie.json]
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i === -1 ? d : args[i + 1]; };
const top = Number(opt('top', 30));
const filtre = opt('filtre', '');
const dist = path.resolve(opt('dist', 'frontend/dist/assets'));
const sortieJson = opt('json', null);
const positionnels = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));

const fichiers = positionnels.flatMap((p) => (fs.statSync(p).isDirectory()
    ? fs.readdirSync(p).filter((f) => f.endsWith('.cpuprofile')).map((f) => path.join(p, f)) : [p]))
    .filter((f) => !filtre || path.basename(f).includes(filtre));
if (!fichiers.length) { console.error('aucun profil'); process.exit(2); }

let SourceMapConsumer = null;
try { ({ SourceMapConsumer } = require('source-map-js')); } catch (_) {}
const cartes = new Map();
function carte(url) {
    if (cartes.has(url)) return cartes.get(url);
    let c = null;
    const base = url.split('?')[0].split('/').pop();
    const f = path.join(dist, base + '.map');
    if (SourceMapConsumer && base && fs.existsSync(f)) c = new SourceMapConsumer(JSON.parse(fs.readFileSync(f, 'utf8')));
    cartes.set(url, c);
    return c;
}

function source(cf) {
    const url = cf.url || '';
    if (!url) {
        const nom = cf.functionName || '(anonyme)';
        return { fichier: nom.startsWith('(') ? nom : '(natif)', fn: nom };
    }
    const c = carte(url);
    const court = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (c) {
        const o = c.originalPositionFor({ line: cf.lineNumber + 1, column: cf.columnNumber });
        if (o && o.source) {
            const src = o.source.replace(/^(\.\.\/)+/, '').replace(/^webpack:\/\//, '');
            return { fichier: src, fn: `${cf.functionName || o.name || '(anonyme)'} ${src.split('/').pop()}:${o.line}` };
        }
    }
    return { fichier: court, fn: `${cf.functionName || '(anonyme)'} ${court.split('/').pop()}:${cf.lineNumber + 1}` };
}

const parFn = new Map();
const parFichier = new Map();
let dureeTotale = 0;
const ajoute = (m, k, champ, v) => { const e = m.get(k) || { self: 0, total: 0 }; e[champ] += v; m.set(k, e); };

for (const f of fichiers) {
    const p = JSON.parse(fs.readFileSync(f, 'utf8'));
    const noeuds = new Map(p.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of p.nodes) for (const c of n.children || []) parent.set(c, n.id);
    const info = new Map();
    for (const n of p.nodes) info.set(n.id, source(n.callFrame));
    for (let i = 0; i < p.samples.length; i++) {
        const dt = (p.timeDeltas[i + 1] ?? 0) / 1000;
        if (dt <= 0) continue;
        dureeTotale += dt;
        let id = p.samples[i];
        const s = info.get(id);
        ajoute(parFn, s.fn, 'self', dt);
        ajoute(parFichier, s.fichier, 'self', dt);
        const vusFn = new Set(); const vusF = new Set();
        while (id !== undefined) {
            const x = info.get(id);
            if (!vusFn.has(x.fn)) { vusFn.add(x.fn); ajoute(parFn, x.fn, 'total', dt); }
            if (!vusF.has(x.fichier)) { vusF.add(x.fichier); ajoute(parFichier, x.fichier, 'total', dt); }
            id = parent.get(id);
            if (id !== undefined && noeuds.get(id).callFrame.functionName === '(root)') break;
        }
    }
}

const n = fichiers.length;
const trier = (m, champ) => [...m.entries()].map(([k, v]) => ({ k, self: v.self / n, total: v.total / n }))
    .filter((x) => !['(idle)', '(root)'].includes(x.k.split(' ')[0])).sort((a, b) => b[champ] - a[champ]);
const ms = (x) => String(Math.round(x)).padStart(7);
const occupe = trier(parFichier, 'self').reduce((s, x) => s + x.self, 0);
console.log(`${n} profil(s), ${Math.round(dureeTotale / n)} ms de fenêtre, ${Math.round(occupe)} ms occupés (moyenne par profil)\n`);
console.log('— Fichiers (self / total ms) —');
for (const x of trier(parFichier, 'self').slice(0, top)) console.log(`${ms(x.self)} ${ms(x.total)}  ${x.k}`);
console.log('\n— Fonctions par temps self —');
for (const x of trier(parFn, 'self').slice(0, top)) console.log(`${ms(x.self)} ${ms(x.total)}  ${x.k}`);
console.log('\n— Fonctions par temps total —');
for (const x of trier(parFn, 'total').slice(0, top)) console.log(`${ms(x.self)} ${ms(x.total)}  ${x.k}`);
if (sortieJson) fs.writeFileSync(sortieJson, JSON.stringify({ profils: n, fichiers: trier(parFichier, 'self'), fonctions: trier(parFn, 'self') }, null, 1));
