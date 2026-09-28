// SPDX-License-Identifier: MIT
// Orchestrateur du harnais perf : démarre perf-server, déroule la matrice
// scénarios × reducedMotion × CPU × runs, écrit un JSON par run et imprime
// un résumé. Usage :
//   node tests/perf/run.mjs --label baseline-20260612 [--quick] [--only a_stream_code]
import { spawn, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PERF_PORT || 8901);
const BASE = `http://127.0.0.1:${PORT}`;

const args = process.argv.slice(2);
function arg(name, dflt) {
    const i = args.indexOf('--' + name);
    if (i === -1) return dflt;
    const v = args[i + 1];
    return (v === undefined || v.startsWith('--')) ? true : v;
}
const label = arg('label');
const quick = !!arg('quick', false);
const only = arg('only', null);
if (!label || label === true) { console.error('--label requis (ex: --label baseline-20260612)'); process.exit(2); }

// ── Matrice ────────────────────────────────────────────────────────────────
// Cellule primaire de streaming = reduce × cpu4 × 60 tok/s (3 runs, médiane).
// reduce = le réglage OS réel de l'utilisateur ; no-preference exerce les
// animations CSS ; cpu ×4 simule un poste modeste.
const FULL = [
    { s: 'a_stream_code',    p: { reducedMotion: 'reduce', cpuRate: 4, toks: 60 }, runs: 3 },
    { s: 'a_stream_code',    p: { reducedMotion: 'reduce', cpuRate: 1, toks: 60 }, runs: 2 },
    { s: 'a_stream_code',    p: { reducedMotion: 'no-preference', cpuRate: 4, toks: 60 }, runs: 2 },
    { s: 'a_stream_code',    p: { reducedMotion: 'reduce', cpuRate: 4, toks: 30 }, runs: 1 },
    { s: 'a_stream_code',    p: { reducedMotion: 'reduce', cpuRate: 4, toks: 80 }, runs: 1 },
    { s: 'b_stream_longchat', p: { reducedMotion: 'reduce', cpuRate: 4, toks: 60 }, runs: 2 },
    // Boucle agentic (chemin réel dominant en usage outillé) : cellule
    // primaire 30 rounds + variante lourde 60 rounds.
    { s: 'f_stream_tools',   p: { reducedMotion: 'reduce', cpuRate: 4, toks: 60, rounds: 30 }, runs: 3 },
    { s: 'f_stream_tools',   p: { reducedMotion: 'reduce', cpuRate: 4, toks: 60, rounds: 60 }, runs: 1 },
    { s: 'g_compress_burst', p: { reducedMotion: 'reduce', cpuRate: 4, toks: 60 }, runs: 2 },
    { s: 'c_open_longchat',  p: { reducedMotion: 'reduce', cpuRate: 4 }, runs: 3 },
    { s: 'c_open_longchat',  p: { reducedMotion: 'reduce', cpuRate: 4, chat: 'long400' }, runs: 2 },
    { s: 'd_ui_anim',        p: { reducedMotion: 'reduce', cpuRate: 4 }, runs: 2 },
    { s: 'd_ui_anim',        p: { reducedMotion: 'no-preference', cpuRate: 4 }, runs: 2 },
    // Démarrage à froid : 3 runs, la médiane fait foi (le premier chargement
    // d'un navigateur neuf paie encore des caches disque).
    { s: 'i_boot',           p: { reducedMotion: 'reduce', cpuRate: 4 }, runs: 3 },
    { s: 'i_boot',           p: { reducedMotion: 'reduce', cpuRate: 1 }, runs: 2 },
    { s: 'e_idle',           p: { reducedMotion: 'reduce', cpuRate: 1 }, runs: 2 },
    { s: 'e_idle',           p: { reducedMotion: 'reduce', cpuRate: 1, admin: true }, runs: 1 },
    // Fuites : cpu ×1 (le throttle allongerait la campagne sans rien changer
    // à ce qui RESTE après chaque cycle). Le témoin passe EN PREMIER — il
    // valide le détecteur avant qu'on accorde du crédit aux verdicts suivants.
    { s: 'h_leak_cycles',    p: { reducedMotion: 'reduce', cpuRate: 1, mode: 'temoin', cycles: 8 }, runs: 1 },
    // Les deux contrôles encadrent la lecture : `repos` donne le plancher de
    // l'instrument, `saisie` donne la pente qu'un simple passage par le
    // composeur ajoute (comptabilité navigateur, pas fuite applicative).
    { s: 'h_leak_cycles',    p: { reducedMotion: 'reduce', cpuRate: 1, mode: 'repos', cycles: 8 }, runs: 1 },
    { s: 'h_leak_cycles',    p: { reducedMotion: 'reduce', cpuRate: 1, mode: 'saisie', cycles: 10 }, runs: 1 },
    { s: 'h_leak_cycles',    p: { reducedMotion: 'reduce', cpuRate: 1, mode: 'chats', cycles: 12 }, runs: 1 },
    { s: 'h_leak_cycles',    p: { reducedMotion: 'reduce', cpuRate: 1, mode: 'modals', cycles: 12 }, runs: 1 },
    { s: 'h_leak_cycles',    p: { reducedMotion: 'reduce', cpuRate: 1, mode: 'stream', cycles: 10 }, runs: 1 },
];
const QUICK = [
    { s: 'a_stream_code',   p: { reducedMotion: 'reduce', cpuRate: 4, toks: 60 }, runs: 1 },
    { s: 'f_stream_tools',  p: { reducedMotion: 'reduce', cpuRate: 4, toks: 60, rounds: 30 }, runs: 1 },
    { s: 'c_open_longchat', p: { reducedMotion: 'reduce', cpuRate: 4 }, runs: 1 },
    { s: 'e_idle',          p: { reducedMotion: 'reduce', cpuRate: 1, idleMs: 15000 }, runs: 1 },
];

let cells = quick ? QUICK : FULL;
if (only) cells = cells.filter((c) => c.s === only);

function cellKey(p) {
    const bits = [`rm-${p.reducedMotion === 'reduce' ? 'reduce' : 'nopref'}`, `cpu${p.cpuRate}`];
    if (p.toks) bits.push(`toks${p.toks}`);
    if (p.admin) bits.push('admin');
    if (p.chat) bits.push(p.chat);
    if (p.mode) bits.push(p.mode);
    return bits.join('_');
}

async function serverAlive() {
    try { const r = await fetch(`${BASE}/__perf/config`); return r.ok; } catch (_) { return false; }
}

async function main() {
    let server = null;
    if (!(await serverAlive())) {
        server = spawn('node', [path.join(__dirname, 'perf-server.mjs')], {
            env: { ...process.env, PERF_PORT: String(PORT) }, stdio: 'ignore', detached: false,
        });
        for (let i = 0; i < 30; i++) {
            if (await serverAlive()) break;
            await new Promise((r) => setTimeout(r, 200));
        }
        if (!(await serverAlive())) { console.error('perf-server injoignable sur ' + BASE); process.exit(1); }
    }

    let commit = 'unknown';
    try { commit = execSync('git rev-parse --short HEAD', { cwd: decodeURIComponent(new URL('../..', import.meta.url).pathname) }).toString().trim(); } catch (_) {}
    const outDir = path.join(__dirname, 'results', String(label));
    fs.mkdirSync(outDir, { recursive: true });

    // Chauffe : un chargement à blanc remplit les caches disque (vendors).
    try {
        const { launch, gotoApp } = await import('./lib/harness.mjs');
        const h = await launch({});
        await gotoApp(h.page);
        await h.browser.close();
        console.log('chauffe OK');
    } catch (e) { console.error('chauffe en échec :', e.message); }

    const summaryRows = [];
    for (const cell of cells) {
        const mod = await import(`./scenarios/${cell.s}.mjs`);
        const key = cellKey(cell.p);
        for (let r = 1; r <= cell.runs; r++) {
            const t0 = Date.now();
            process.stdout.write(`▶ ${cell.s} [${key}] run ${r}/${cell.runs} … `);
            try {
                const result = await mod.run({ ...cell.p });
                const payload = { scenario: cell.s, cell: cell.p, run: r, label, commit,
                                  ts: new Date().toISOString(), ...result };
                const fname = `${cell.s}__${key}__r${r}.json`;
                fs.writeFileSync(path.join(outDir, fname), JSON.stringify(payload, null, 1));
                const lt = result.longTasks || (result.sub && result.sub[0] && result.sub[0].longTasks) || {};
                if (result.montageMs !== undefined) {
                    summaryRows.push({ cell: `${cell.s} ${key} r${r}`,
                                       tbt: `fcp${result.fcpMs}`, ltCount: `m${result.montageMs}`,
                                       parses: `${result.koTransferes}Ko`, errs: (result.errors || []).length });
                    console.log(`OK en ${Math.round((Date.now() - t0) / 1000)}s (FCP ${result.fcpMs} ms, `
                        + `montage ${result.montageMs} ms, ${result.requetes} req, ${result.koTransferes} Ko`
                        + (result.police ? `, police prête à ${result.police.finMs} ms` : '') + ')');
                } else if (result.pentes) {
                    // Scénario de fuites : le résumé porte les pentes par cycle,
                    // pas le TBT (il n'y a pas de fenêtre d'animation ici).
                    const p = result.pentes;
                    summaryRows.push({ cell: `${cell.s} ${key} r${r}`,
                                       tbt: `tas${p.tasMo.pente}Mo`, ltCount: `n${p.noeuds.pente}`,
                                       parses: `L${p.listeners.pente}`, errs: (result.errors || []).length });
                    console.log(`OK en ${Math.round((Date.now() - t0) / 1000)}s (pente/cycle : `
                        + `tas=${p.tasMo.pente} Mo, nœuds=${p.noeuds.pente}, listeners=${p.listeners.pente})`);
                } else {
                summaryRows.push({ cell: `${cell.s} ${key} r${r}`,
                                   tbt: lt.tbtMs, ltCount: lt.count,
                                   parses: result.markdown ? result.markdown.parseCalls : '-',
                                   errs: (result.errors || []).length });
                console.log(`OK en ${Math.round((Date.now() - t0) / 1000)}s (TBT=${lt.tbtMs}ms, LT=${lt.count})`);
                }
            } catch (e) {
                console.log('ÉCHEC : ' + e.message.split('\n')[0]);
                summaryRows.push({ cell: `${cell.s} ${key} r${r}`, tbt: 'ERR', ltCount: '-', parses: '-', errs: '-' });
            }
        }
    }

    console.log('\n— Résumé (' + label + ') —');
    for (const row of summaryRows) {
        console.log(`${row.cell.padEnd(55)} TBT=${String(row.tbt).padStart(7)}  LT=${String(row.ltCount).padStart(4)}  parses=${String(row.parses).padStart(5)}  pageErrors=${row.errs}`);
    }
    console.log(`\nRésultats : ${outDir}`);
    if (server) server.kill();
}

main().catch((e) => { console.error(e); process.exit(1); });
