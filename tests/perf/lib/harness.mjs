// SPDX-License-Identifier: MIT
// Boîte à outils du harnais perf : lancement Chromium (via le node_modules du
// browser-service, recette validée), session CDP, fenêtres de mesure et
// agrégation des métriques du collecteur in-page.
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(process.env.ELPIS_NODE_MODULES ? process.env.ELPIS_NODE_MODULES.replace(/\/?$/, '/') : new URL('../../../browser-service/node_modules/', import.meta.url));
const { chromium } = require('playwright');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BASE_URL = `http://127.0.0.1:${process.env.PERF_PORT || 8901}`;

export async function launch({ reducedMotion = 'reduce', cpuRate = 1 } = {}) {
    // channel:'chromium' = nouveau headless du build complet (pipeline de rendu
    // plus proche du réel que le headless shell). Fallback : build par défaut.
    let browser;
    try { browser = await chromium.launch({ channel: 'chromium', headless: true }); }
    catch (_) { browser = await chromium.launch({ headless: true }); }
    const ctx = await browser.newContext({ reducedMotion, viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e && e.message || e)));
    const reqLog = [];
    page.on('request', (r) => reqLog.push({ url: r.url().replace(BASE_URL, ''), t: Date.now() }));
    await page.addInitScript({ path: path.join(__dirname, 'collector.js') });
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Performance.enable');
    // Domaine nécessaire à HeapProfiler.collectGarbage (cf. releveMemoire).
    await cdp.send('HeapProfiler.enable').catch(() => {});
    if (cpuRate > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuRate });
    return { browser, ctx, page, cdp, errors, reqLog, meta: { reducedMotion, cpuRate } };
}

// À appeler après le chargement de l'app (les vendors sont posés sur window).
// 1 appel marked.parse = 1 miss du cache LRU de renderMarkdown → compteur
// exact des re-parses markdown.
export async function wrapLibs(page) {
    await page.evaluate(() => {
        // Le compartiment est résolu PAR NOM à chaque appel : startWindow
        // remplace __perf.parse & co par des objets neufs, une référence
        // capturée au wrap deviendrait silencieusement orpheline.
        const wrap = (obj, key, bucketName) => {
            if (!obj || typeof obj[key] !== 'function' || obj[key].__wrapped) return;
            const orig = obj[key].bind(obj);
            obj[key] = function (...a) {
                const t0 = performance.now();
                const r = orig(...a);
                const d = performance.now() - t0;
                const b = __perf[bucketName];
                b.n++; b.ms += d; b.max = Math.max(b.max, d);
                return r;
            };
            obj[key].__wrapped = true;
        };
        wrap(window.hljs, 'highlight', 'hl');
        wrap(window.hljs, 'highlightAuto', 'hlAuto');
        // marked.parse est un getter non-configurable sur l'export UMD →
        // impossible à remplacer. On passe par l'API marked.use({hooks}) :
        // preprocess/postprocess encadrent chaque parse (durée totale, y
        // compris le postprocess sanitize déjà enregistré par utils.js).
        if (window.marked && window.marked.use && !window.__markedCounted) {
            window.__markedCounted = true;
            let t0 = 0;
            window.marked.use({ hooks: {
                preprocess(md) { t0 = performance.now(); return md; },
                postprocess(html) {
                    const b = __perf.parse;
                    const d = performance.now() - t0;
                    b.n++; b.ms += d; b.max = Math.max(b.max, d);
                    return html;
                },
            } });
        }
    });
}

// ── Mesure mémoire ─────────────────────────────────────────────────────────
// Un relevé de tas JS sans ramasse-miettes préalable ne mesure rien : il
// dépend de l'instant où V8 a décidé de collecter. On force donc une collecte
// AVANT chaque relevé, et deux fois — la première libère les objets, la
// seconde ce que la première a rendu inaccessible (finaliseurs, tables
// faibles). Sans ça, chaque cycle semble fuir d'un déchet de retard.
export async function releveMemoire(page, cdp) {
    await cdp.send('HeapProfiler.collectGarbage');
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(120);
    const dom = await cdp.send('Memory.getDOMCounters');
    const perf = (await cdp.send('Performance.getMetrics')).metrics
        .reduce((m, { name, value }) => (m[name] = value, m), {});
    // `dom.nodes` compte TOUS les nœuds vivants, y compris ceux détachés du
    // document mais retenus par une référence JS — le DOM fantôme. Le recensement
    // in-page ne voit que l'attaché : la différence des deux sépare « l'écran
    // s'alourdit » de « on retient des morceaux invisibles ».
    const dedans = await page.evaluate(() => {
        const w = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
        let n = 1;
        while (w.nextNode()) n++;
        return n;
    });
    const leak = await page.evaluate(() => JSON.parse(JSON.stringify(window.__leak || {})));
    return {
        tasMo: round((perf.JSHeapUsedSize || 0) / 1048576),
        noeuds: dom.nodes,
        noeudsAttaches: dedans,
        noeudsDetaches: dom.nodes - dedans,
        listeners: dom.jsEventListeners,
        documents: dom.documents,
        intervalsVifs: leak.liveIntervals,
        timeoutsVifs: leak.liveTimeouts,
        _leak: leak,
    };
}

// Pente par cycle sur la SECONDE MOITIÉ des relevés.
// Le début d'une session alloue légitimement (caches LRU de rendu, hljs qui
// enregistre ses langages, fixtures) : mesurer de bout en bout donne toujours
// une pente positive et donc une fuite imaginaire. Ce qui prouve une fuite,
// c'est que ça monte ENCORE une fois le régime atteint.
export function penteParCycle(valeurs) {
    const q = valeurs.slice(Math.floor(valeurs.length / 2));
    if (q.length < 2) return { pente: 0, debut: valeurs[0] || 0, fin: valeurs[valeurs.length - 1] || 0, n: q.length };
    const n = q.length;
    const mx = (n - 1) / 2;
    const my = q.reduce((s, v) => s + v, 0) / n;
    let num = 0, den = 0;
    q.forEach((v, i) => { num += (i - mx) * (v - my); den += (i - mx) ** 2; });
    return { pente: round(den ? num / den : 0), debut: q[0], fin: q[n - 1], n };
}

// Soldes pose/retrait non nuls, du pire au meilleur. Un solde positif sur
// window/document = un listener global qui survit au composant qui l'a posé.
export function listenersOrphelins(leak, seuil = 1) {
    const out = [];
    for (const [cle, [pose, retire]] of Object.entries(leak.lis || {})) {
        const solde = pose - retire;
        if (solde >= seuil) out.push({ cle, pose, retire, solde, site: (leak.sites || {})[cle] || '' });
    }
    return out.sort((a, b) => b.solde - a.solde);
}

export function observateursOrphelins(leak) {
    const out = [];
    for (const [nom, [crees, obs, dis]] of Object.entries(leak.obs || {})) {
        if (crees - dis > 0) out.push({ nom, crees, observe: obs, disconnect: dis, solde: crees - dis });
    }
    return out.sort((a, b) => b.solde - a.solde);
}

export async function configureServer(opts) {
    const res = await fetch(`${BASE_URL}/__perf/config`, {
        method: 'POST', body: JSON.stringify(opts),
    });
    return res.json();
}

export async function startWindow(page, cdp, { frames = true } = {}) {
    const m0 = metricsMap((await cdp.send('Performance.getMetrics')).metrics);
    await page.evaluate((f) => {
        __perf.lt = []; __perf.ev = []; __perf.cls = 0;
        __perf.parse = { n: 0, ms: 0, max: 0 };
        __perf.hl = { n: 0, ms: 0, max: 0 };
        __perf.hlAuto = { n: 0, ms: 0, max: 0 };
        if (f) __perfStartFrames();
    }, frames);
    return { m0, t0: Date.now() };
}

export async function stopWindow(page, cdp, win) {
    await page.evaluate(() => { if (window.__perfStopFrames) __perfStopFrames(); });
    const raw = await page.evaluate(() => ({
        lt: __perf.lt, ev: __perf.ev, cls: __perf.cls, frames: __perf.frames,
        parse: __perf.parse, hl: __perf.hl, hlAuto: __perf.hlAuto,
        intervals: __perf.intervals,
    }));
    const m1 = metricsMap((await cdp.send('Performance.getMetrics')).metrics);
    return summarize(raw, win, m1, Date.now());
}

function metricsMap(list) {
    const m = {};
    for (const { name, value } of list) m[name] = value;
    return m;
}

function pct(sorted, p) {
    if (!sorted.length) return 0;
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function summarize(raw, win, m1, t1) {
    const durs = raw.lt.map(([, d]) => d).sort((a, b) => a - b);
    const evDurs = raw.ev.map(([, d]) => d).sort((a, b) => a - b);
    const frames = raw.frames;
    const fps = frames.length
        ? {
            mean: round(1000 / (frames.reduce((s, d) => s + d, 0) / frames.length)),
            p5: round(1000 / pct([...frames].sort((a, b) => a - b), 0.95) || 0),
            droppedPct: round(frames.filter((d) => d > 25).length / frames.length),
            frozen: frames.filter((d) => d > 700).length,
        }
        : null;
    const cdpDelta = {};
    for (const k of ['ScriptDuration', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration']) {
        cdpDelta[k] = round((m1[k] || 0) - (win.m0[k] || 0));
    }
    cdpDelta.JSHeapUsedMB = round((m1.JSHeapUsedSize || 0) / 1048576);
    return {
        durationMs: t1 - win.t0,
        longTasks: {
            count: durs.length,
            p50: pct(durs, 0.5), p95: pct(durs, 0.95), max: durs[durs.length - 1] || 0,
            tbtMs: Math.round(durs.reduce((s, d) => s + Math.max(0, d - 50), 0)),
        },
        fps,
        inputEvents: { countOver50ms: raw.ev.filter(([, d]) => d > 50).length, p95: pct(evDurs, 0.95) },
        cls: round(raw.cls),
        markdown: {
            parseCalls: raw.parse.n, parseMs: Math.round(raw.parse.ms), parseMaxMs: Math.round(raw.parse.max),
            hljsCalls: raw.hl.n, hljsAutoCalls: raw.hlAuto.n,
            hljsMs: Math.round(raw.hl.ms + raw.hlAuto.ms),
        },
        cdp: cdpDelta,
        intervals: raw.intervals,
        _window: [win.t0, t1],
    };
}

function round(x) { return Math.round((x + Number.EPSILON) * 100) / 100; }

export function requestsInWindow(reqLog, summary) {
    const [t0, t1] = summary._window;
    const inWin = reqLog.filter((r) => r.t >= t0 && r.t <= t1);
    const byUrl = {};
    for (const r of inWin) {
        const u = r.url.split('?')[0];
        byUrl[u] = (byUrl[u] || 0) + 1;
    }
    return { total: inWin.length, byUrl };
}

export async function writeReport(outDir, name, data) {
    fs.mkdirSync(outDir, { recursive: true });
    const f = path.join(outDir, name + '.json');
    fs.writeFileSync(f, JSON.stringify(data, null, 1));
    return f;
}

// Navigation standard : charge l'app et attend le VRAI montage Vue (retrait
// de v-cloak). Sous CPU throttle, le montage dépasse les 4 s du diagnostic
// one-shot d'index.html → l'overlay #vue-error-overlay s'active à tort et
// intercepte tous les clics (bug réel sur poste lent, fix prévu en vague 1) ;
// on le retire si l'app a fini par monter.
export async function gotoApp(page, pathName = '/') {
    await page.goto(BASE_URL + pathName);
    await page.waitForFunction(() => {
        const app = document.getElementById('app');
        return app && !app.hasAttribute('v-cloak');
    }, null, { timeout: 60000, polling: 200 });
    await page.waitForTimeout(4200);   // laisse passer le timer diagnostic de 4 s
    await page.evaluate(() => {
        const o = document.getElementById('vue-error-overlay');
        if (o) o.classList.remove('active');
    });
    await page.waitForTimeout(800);
}

// Envoie un message via le composer et retourne quand le stream est FINI.
// Signal de stream = bouton « Arrêter la génération » (v-if="isStreaming").
// (Avant : textarea[disabled] — le composer ne désactive PLUS le textarea
// pendant le stream depuis la refonte du composer → tous les scénarios
// timeoutaient sur l'entrée en stream.)
export async function sendAndWaitStream(page, text, { timeout = 180000 } = {}) {
    const IN_STREAM = 'button[title="Arrêter la génération"], textarea[disabled]';
    const ta = page.locator('textarea[placeholder]').last();
    await ta.fill(text);
    await page.locator('button:has(i.ph-paper-plane-right)').last().click();
    // D'abord attendre l'ENTRÉE en stream, sinon le prédicat « fini »
    // serait vrai immédiatement après le clic.
    await page.waitForFunction(
        (sel) => !!document.querySelector(sel),
        IN_STREAM, { timeout: 10000, polling: 100 },
    );
    await page.waitForFunction(
        (sel) => !document.querySelector(sel),
        IN_STREAM, { timeout, polling: 500 },
    );
}
