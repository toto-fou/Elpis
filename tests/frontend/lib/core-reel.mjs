// SPDX-License-Identifier: MIT
/** tests/frontend/lib/core-reel.mjs — lance le core TS réel (main + admin) sur une instance jetable : SQLite, config et racine temporaires, faux LLM, comptes et chats de fixture */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { demarrerFauxLlm } from './faux-llm.mjs';
import { brancherReleveCsp } from './releve-csp.mjs';

export const DEPOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../..');
const MAIN_MJS = path.join(DEPOT, 'apps/core/dist/main.mjs');
// Données d'instance jamais partagées avec la copie de travail : la racine jetable les remplace.
const HORS_RACINE = new Set(['user_db', 'user_sandboxes', 'logs', 'config.json', 'mcp.json', '.git', 'node_modules']);

// Familles servies par le core lui-même (aucun hôte d'outils) : graphiques, mémoire, skills, tâches.
const MANIFESTE_EN_PROCESSUS = {
    version: 1,
    mcpServers: Object.fromEntries(['chart', 'memory', 'skill', 'todo'].map((f) => [`elpis-${f}`, { type: 'inprocess', description: `famille ${f}`, 'x-elpis': { role: 'app', families: [f] } }])),
    placement: { strategy: 'single', host: 'main' },
};

export const COMPTES = {
    admin: { username: 'admin', password: 'Admin-fixture-2026!' },
    user: { username: 'alice', password: 'Alice-fixture-2026!' },
};

export function portLibre() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once('error', reject);
        s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
    });
}

// Construit apps/core/dist si absent, ou toujours avec ELPIS_CORE_BUILD=1 (≈ 2 s).
export function construireCore({ forcer = process.env.ELPIS_CORE_BUILD === '1' } = {}) {
    if (forcer || !fs.existsSync(MAIN_MJS)) execFileSync('npm', ['run', 'build', '-w', '@elpis/core'], { cwd: DEPOT, stdio: 'inherit' });
    construireFront({ forcer });
}

// Dès que frontend/ est un workspace avec un script build (lot L01), le parcours réel teste le build, pas les sources.
export function construireFront({ forcer = false } = {}) {
    const pj = path.join(DEPOT, 'frontend/package.json');
    if (!fs.existsSync(pj) || process.env.ELPIS_FRONT_BUILD === '0') return;
    const { name, scripts } = JSON.parse(fs.readFileSync(pj, 'utf8'));
    if (!scripts || !scripts.build || (!forcer && process.env.ELPIS_FRONT_BUILD !== '1' && fs.existsSync(path.join(DEPOT, 'frontend/dist')))) return;
    execFileSync('npm', ['run', 'build', '-w', name], { cwd: DEPOT, stdio: 'inherit' });
}

function racineJetable(dossier) {
    const racine = path.join(dossier, 'racine');
    fs.mkdirSync(path.join(racine, 'user_db'), { recursive: true });
    for (const nom of fs.readdirSync(DEPOT)) {
        if (HORS_RACINE.has(nom)) continue;
        fs.symlinkSync(path.join(DEPOT, nom), path.join(racine, nom));
    }
    fs.symlinkSync(path.join(DEPOT, 'node_modules'), path.join(racine, 'node_modules'));
    return racine;
}

// Client HTTP minimal à cookie de session, pour poser les fixtures par l'API publique.
export class Client {
    constructor(base) { this.base = base; this.cookies = new Map(); }
    async req(methode, chemin, corps) {
        const entetes = { 'sec-fetch-site': 'same-origin' };
        if (this.cookies.size) entetes.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
        if (corps !== undefined) entetes['content-type'] = 'application/json';
        const r = await fetch(this.base + chemin, { method: methode, headers: entetes, body: corps === undefined ? undefined : JSON.stringify(corps), redirect: 'manual' });
        for (const c of r.headers.getSetCookie()) {
            const [kv] = c.split(';');
            const i = kv.indexOf('=');
            this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
        }
        const texte = await r.text();
        let json = null;
        try { json = JSON.parse(texte); } catch { json = null; }
        if (!r.ok) throw new Error(`${methode} ${chemin} → ${r.status} ${texte.slice(0, 200)}`);
        return json;
    }
}

async function attendrePret(url, proc, journal, delaiMs = 60000) {
    const t0 = Date.now();
    while (Date.now() - t0 < delaiMs) {
        if (proc.exitCode !== null) throw new Error(`core sorti (code ${proc.exitCode}) :\n${journal.join('').slice(-3000)}`);
        try { const r = await fetch(url + '/api/public-config'); if (r.ok) return; } catch { /* pas encore à l'écoute */ }
        await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error(`core injoignable sur ${url} :\n${journal.join('').slice(-3000)}`);
}

// Messages d'une conversation de fixture : n échanges question/réponse.
export function messagesFixture(n, sujet) {
    const m = [];
    for (let i = 1; i <= n; i++) {
        m.push({ role: 'user', content: `${sujet} : question ${i}` });
        m.push({ role: 'assistant', content: `Réponse ${i} sur **${sujet}**.\n\n- point A\n- point B` });
    }
    return m;
}

// Comptes (admin par amorçage local, alice par la console) et trois chats d'alice.
async function poserFixtures(urlMain, urlAdmin) {
    const adminMain = new Client(urlMain);
    await adminMain.req('POST', '/api/login-lite', COMPTES.admin);
    const adminConsole = new Client(urlAdmin);
    await adminConsole.req('POST', '/api/login-lite', COMPTES.admin);
    await adminConsole.req('POST', '/api/admin/users/new', { ...COMPTES.user, role: 'user' });
    const alice = new Client(urlMain);
    await alice.req('POST', '/api/login-lite', COMPTES.user);
    await alice.req('POST', '/api/users/change-password', { new_password: COMPTES.user.password });
    const chats = [];
    for (const [titre, n] of [['Recettes de cuisine', 3], ['Voyage en Italie', 5], ['Notes de lecture', 2]]) {
        const { id } = await alice.req('POST', '/api/saved/chats/new', {});
        await alice.req('PUT', `/api/saved/chats/${id}/save-messages`, { title: titre, messages: messagesFixture(n, titre) });
        chats.push({ id, titre, echanges: n });
    }
    return { chats };
}

function lancerProcess(mode, port, env, journal) {
    const proc = spawn(process.execPath, [MAIN_MJS], {
        cwd: env.ELPIS_RACINE,
        env: { ...env, APP_MODE: mode, BIND: `127.0.0.1:${port}` },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => journal.push(String(d)));
    proc.stderr.on('data', (d) => journal.push(String(d)));
    return proc;
}

// Démarre une instance complète (`outilsEnProcessus` : manifeste des familles servies par le core ; `hotesOutils` : { url, token } d'un hôte d'outils simulé déclaré au placement) ; ELPIS_CORE_LOG=1 recopie les journaux du core sur stderr.
export async function demarrerCoreReel({ tokParS = 120, avecAdmin = true, fixtures = true, slots = 1, envSup = {}, configSup = {}, llm: optsLlm = {}, outilsEnProcessus = false, hotesOutils = null } = {}) {
    construireCore();
    const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'elpis-reel-'));
    const racine = racineJetable(dossier);
    const llm = await demarrerFauxLlm({ tokParS, slots, ...optsLlm });
    const [portMain, portAdmin, portMcp] = [await portLibre(), await portLibre(), await portLibre()];
    const urlMain = `http://127.0.0.1:${portMain}`;
    const urlAdmin = `http://127.0.0.1:${portAdmin}`;
    const configPath = path.join(dossier, 'config.json');
    const manifeste = path.join(dossier, outilsEnProcessus || hotesOutils ? 'mcp.json' : 'mcp-absent.json');
    if (outilsEnProcessus || hotesOutils) {
        const base = outilsEnProcessus ? MANIFESTE_EN_PROCESSUS : { version: 1, mcpServers: {}, placement: { strategy: 'single', host: 'main' } };
        fs.writeFileSync(manifeste, JSON.stringify(hotesOutils ? { ...base, toolHosts: { main: { url: hotesOutils.url, token: hotesOutils.token } } } : base, null, 2));
    }
    // ELPIS_CSP : mode de la CSP des pages (report-only pour un relevé), sinon le défaut du core.
    const csp = process.env.ELPIS_CSP ? { security: { csp: process.env.ELPIS_CSP } } : {};
    fs.writeFileSync(configPath, JSON.stringify({ llama: { model: 'faux-modele' }, ...csp, ...configSup }, null, 2));
    const env = {
        PATH: process.env.PATH, HOME: process.env.HOME, TZ: 'Europe/Paris', LANG: 'C.UTF-8',
        ELPIS_RACINE: racine,
        APP_CONFIG_PATH: configPath,
        APP_DB_BACKEND: 'sqlite',
        APP_DB_PATH: path.join(racine, 'user_db', 'app.db'),
        APP_SANDBOX_DIR: path.join(dossier, 'user_sandboxes'),
        APP_FILE_HISTORY_DIR: path.join(dossier, 'file_history'),
        APP_USER_SKILLS_DIR: path.join(dossier, 'user_skills'),
        SKILLS_LOCK_PATH: path.join(dossier, '.skills_write.lock'),
        ELPIS_AUDIT_DIR: path.join(dossier, 'audit'),
        ELPIS_RUNTIME_DIR: path.join(dossier, 'run'),
        APP_OFFICE_CACHE_DIR: path.join(dossier, 'office-cache'),
        APP_MCP_MANIFEST: manifeste,
        APP_SESSION_SECRET: 'secret-de-session-du-harnais-reel-0123456789abcdef',
        APP_HTTPS_CHECK_SKIP: '1',
        LLAMA_IP: '127.0.0.1', LLAMA_PORT: String(llm.port), LLAMA_MODEL: 'faux-modele',
        LOCAL_MCP_URL: `http://127.0.0.1:${portMcp}/mcp`,
        RAG_SERVICE_URL: `http://127.0.0.1:${portMcp}`,
        MAIN_INTERNAL_URL: urlMain, MAIN_PUBLIC_URL: urlMain, ADMIN_PUBLIC_URL: urlAdmin,
        ...envSup,
    };
    const journaux = { main: [], admin: [] };
    const procs = [];
    const arreter = async () => {
        for (const p of procs) if (p.exitCode === null) p.kill('SIGTERM');
        await Promise.all(procs.map((p) => (p.exitCode !== null ? null : new Promise((r) => {
            const t = setTimeout(() => { p.kill('SIGKILL'); r(); }, 8000);
            p.once('exit', () => { clearTimeout(t); r(); });
        }))));
        await llm.arreter();
        if (process.env.ELPIS_REEL_GARDER !== '1') fs.rmSync(dossier, { recursive: true, force: true });
    };
    try {
        const main = lancerProcess('main', portMain, env, journaux.main);
        procs.push(main);
        await attendrePret(urlMain, main, journaux.main);
        if (avecAdmin) {
            const admin = lancerProcess('admin', portAdmin, env, journaux.admin);
            procs.push(admin);
            await attendrePret(urlAdmin, admin, journaux.admin);
        }
        const fx = fixtures && avecAdmin ? await poserFixtures(urlMain, urlAdmin) : { chats: [] };
        if (process.env.ELPIS_CORE_LOG === '1') {
            for (const [m, j] of Object.entries(journaux)) process.stderr.write(j.map((l) => `[${m}] ${l}`).join(''));
        }
        return { urlMain, urlAdmin, llm, dossier, journaux, comptes: COMPTES, chats: fx.chats, arreter };
    } catch (e) {
        await arreter();
        throw e;
    }
}

// Chromium du harnais : ELPIS_NODE_MODULES pour playwright, ELPIS_CHROMIUM pour un binaire imposé.
export async function lancerNavigateur() {
    const nm = process.env.ELPIS_NODE_MODULES || path.join(DEPOT, 'browser-service/node_modules');
    const { chromium } = createRequire(nm.replace(/\/?$/, '/'))('playwright');
    const opts = { headless: true };
    if (process.env.ELPIS_CHROMIUM) opts.executablePath = process.env.ELPIS_CHROMIUM;
    return chromium.launch(opts);
}

// Ouvre un contexte connecté (cookie de session posé par l'API) sur `url` ; `options` complète celles du contexte Playwright.
export async function contexteConnecte(navigateur, url, compte, options = {}) {
    const c = new Client(url);
    await c.req('POST', '/api/login-lite', compte);
    const ctx = await navigateur.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', ...options });
    const { hostname } = new URL(url);
    await ctx.addCookies([...c.cookies].map(([name, value]) => ({ name, value, domain: hostname, path: '/' })));
    await ctx.addInitScript({ path: path.join(DEPOT, 'tests/frontend/lib/acces-racine.js') });
    await brancherReleveCsp(ctx);
    return ctx;
}

// Montage Vue réel de la page (retrait de v-cloak), comme le harnais perf.
export async function attendreMontage(page, timeout = 30000) {
    await page.waitForFunction(() => {
        const app = document.getElementById('app');
        return app && !app.hasAttribute('v-cloak');
    }, null, { timeout, polling: 100 });
}

// Attend qu'un élément paraisse (ou disparaisse) : vrai si c'est arrivé avant le délai, faux sinon — jamais une lecture instantanée après un chargement.
export function apparait(locator, timeout = 10000) {
    return locator.first().waitFor({ state: 'visible', timeout }).then(() => true, () => false);
}
export function disparait(locator, timeout = 10000) {
    return locator.first().waitFor({ state: 'hidden', timeout }).then(() => true, () => false);
}

// Compteur de vérifications commun aux parcours : `ok(nom, condition, détail)`, `bilan()` → code de sortie.
export function verifications(titre) {
    const res = [];
    return {
        ok(nom, cond, detail = '') {
            res.push({ nom, ok: !!cond });
            console.log(`  ${cond ? '✓' : '✗'} ${nom}${!cond && detail ? `  — ${detail}` : ''}`);
        },
        bilan() {
            const ko = res.filter((r) => !r.ok).length;
            console.log(`${titre} : ${res.length - ko}/${res.length} vérifications OK`);
            return ko ? 1 : 0;
        },
    };
}
