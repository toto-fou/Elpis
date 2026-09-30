// SPDX-License-Identifier: MIT
import express from 'express';
import { chromium, firefox, webkit, devices } from 'playwright';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { execSync } from 'child_process';
import os from 'os';
import dns from 'dns';
import { classifyNavOutcome, authHint } from './nav_util.js';
import { pingPage, planScreenshotQuota, safeOwner, ownerFromRequest, ownerMatches,
         stateFileName, safeDownloadName, planArtifactPurge } from './session_util.js';
import { makeLock, acquireLock, lockIdle } from './session_lock.js';
import { analyserUrl, motifIp, motifUrl, hoteDepuisInterfaces, analyserListeBlanche,
         messageRefus, makeCache } from './url_guard.js';
import { lirePs, orphelins } from './proc_util.js';
import { demarrerRelais, verifierDepuisPolitique } from './proxy_guard.js';
import { compactConsole, summarizeNetwork, describeLocator, selectOptionArg, hostOf } from './result_util.js';

// ── Mutex par session (AUDIT 2026-06) ───────────────────────────────
// Sérialise les requêtes qui opèrent sur la même page Playwright (non
// réentrante). Kill switch PW_SESSION_MUTEX=0 → comportement historique
// exact (aucune sérialisation). Sessions différentes : toujours parallèles.
const PW_MUTEX     = process.env.PW_SESSION_MUTEX !== '0';
const LOCK_WAIT_MS = parseInt(process.env.PW_LOCK_WAIT_MS || '90000', 10);     // > goto 60 s
const LOCK_MAX_W   = parseInt(process.env.PW_LOCK_MAX_WAITERS || '8', 10);

const app = express();
app.use(express.json({ limit: '50mb' }));

// ════════════════════════════════════════════════════════════════════
//  SÉCURITÉ — bind interface
// ════════════════════════════════════════════════════════════════════
//
//  Le service n'a pas d'authentification propre : il écoute sur
//  ``FIREFOX_SERVICE_HOST`` (défaut ``127.0.0.1``) et ne doit JAMAIS être
//  exposé publiquement — quiconque atteint le port pilote le navigateur.

// (2026-09-30) Un seul ``/health``, détaillé, plus bas : celui-ci, déclaré
// en premier, masquait l'autre (Express sert la première route qui correspond).

// ── Captures servies en statique (sans cache). Pas d'en-tête CORS : seul le
// backend d'Elpis les relit, de serveur à serveur.
app.use('/screenshots', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    next();
}, express.static(path.join(process.cwd(), 'screenshots')));

// ── DELETE single screenshot file (1-shot consume from Python proxy) ──
app.delete('/screenshots/:filename', (req, res) => {
    const fname = path.basename(req.params.filename);
    if (!fname.endsWith('.png') || fname.includes('..')) {
        return res.status(400).json({ error: 'Invalid filename' });
    }
    const fpath = path.join(process.cwd(), 'screenshots', fname);
    fs.unlink(fpath, (err) => {
        // Idempotent: ENOENT n'est pas une erreur (déjà supprimé)
        if (err && err.code !== 'ENOENT') {
            return res.status(500).json({ error: err.message });
        }
        res.json({ status: 'deleted', filename: fname });
    });
});

// ==========================================
// CONFIGURATION
// ==========================================
const BASE_DIR = process.cwd();
const SCREENSHOT_DIR = path.join(BASE_DIR, 'screenshots');
const DOWNLOAD_DIR = path.join(BASE_DIR, 'downloads');
const COOKIES_DIR = path.join(BASE_DIR, 'cookies');
const HAR_DIR = path.join(BASE_DIR, 'har');
const BASELINE_DIR = path.join(BASE_DIR, 'baselines');  // goldens régression visuelle (persistants, non reapés)
const VIDEO_DIR = path.join(BASE_DIR, 'videos');        // enregistrements vidéo de session (Phase 5)
const TRACE_DIR = path.join(BASE_DIR, 'traces');        // traces Playwright (Phase 5)

[SCREENSHOT_DIR, DOWNLOAD_DIR, COOKIES_DIR, HAR_DIR, BASELINE_DIR, VIDEO_DIR, TRACE_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// ── Serve videos & traces statically (Phase 5) — registered after the dirs
//    are defined (VIDEO_DIR/TRACE_DIR consts) to avoid a TDZ at module load.
app.use('/videos', express.static(VIDEO_DIR));
app.use('/traces', express.static(TRACE_DIR));

// ════════════════════════════════════════════════════════════════════
//  DESTINATIONS AUTORISÉES (2026-09-30, cf. url_guard.js)
// ════════════════════════════════════════════════════════════════════
//  Appliquées à chaque contexte de navigateur : navigation directe (avant
//  page.goto), toutes les requêtes du contexte (context.route : navigations,
//  redirections, sous-ressources) et les WebSocket (routeWebSocket). Les
//  service workers sont bloqués, sinon leurs requêtes échapperaient au
//  routage. Liste blanche du réseau local : ``browser.url_allowlist`` du
//  config.json d'Elpis (relue quand le fichier change) ou la variable
//  ``BROWSER_URL_ALLOWLIST``.
const CONFIG_PATH = process.env.APP_CONFIG_PATH || path.join(BASE_DIR, '..', 'config.json');
let _politique = { mtime: -1, listeBlanche: analyserListeBlanche(process.env.BROWSER_URL_ALLOWLIST || '') };
function listeBlancheCourante() {
    try {
        const st = fs.statSync(CONFIG_PATH);
        if (st.mtimeMs !== _politique.mtime) {
            const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            const brut = (cfg && cfg.browser && cfg.browser.url_allowlist) || process.env.BROWSER_URL_ALLOWLIST || '';
            _politique = { mtime: st.mtimeMs, listeBlanche: analyserListeBlanche(brut) };
            _verdicts = makeCache({ ttlMs: 30000 });
        }
    } catch (_) { /* pas de config lisible : on garde la politique courante */ }
    return _politique.listeBlanche;
}
let _hote = { t: 0, v: hoteDepuisInterfaces(os.networkInterfaces()) };
function hoteCourant() {
    if (Date.now() - _hote.t > 60000) {
        try { _hote = { t: Date.now(), v: hoteDepuisInterfaces(os.networkInterfaces()) }; } catch (_) {}
    }
    return _hote.v;
}
const _resoudre = async (nom) => (await dns.promises.lookup(nom, { all: true, verbatim: true })).map(r => r.address);
// Verdict par nom d'hôte (une page charge des dizaines d'URL du même hôte).
let _verdicts = makeCache({ ttlMs: 30000 });

/** Motif de refus d'une URL (``null`` = permise). */
async function refusUrl(url) {
    const a = analyserUrl(url);
    if (!a.ok) return a.motif;
    if (a.vide) return null;
    const listeBlanche = listeBlancheCourante();
    const cle = a.hote;
    const connu = _verdicts.get(cle);
    if (connu !== undefined) return connu;
    const m = await motifUrl(url, { resoudre: _resoudre, hote: hoteCourant(), listeBlanche });
    _verdicts.set(cle, m);
    return m;
}

// Relais filtrant (proxy_guard.js) : TOUT le trafic du navigateur y passe,
// boucle locale comprise. C'est lui qui fait foi (redirections, changements
// d'adresse DNS) ; context.route ci-dessous n'est qu'un refus anticipé.
const _relais = await demarrerRelais({
    verifier: verifierDepuisPolitique({
        resoudre: _resoudre,
        motifIp: (ip, nom) => motifIp(ip, { hote: hoteCourant(), listeBlanche: listeBlancheCourante(), nomHote: nom }),
    }),
    journal: (m) => console.warn(`[GARDE] ${m}`),
});
console.log(`[GARDE] relais filtrant sur 127.0.0.1:${_relais.port}`);
const PROXY_NAVIGATEUR = { server: `http://127.0.0.1:${_relais.port}`, bypass: '<-loopback>' };

/** Réponse 403 uniforme pour une navigation directe refusée. */
function repondreRefus(res, url, motif) {
    return res.status(403).json({ error: messageRefus(url, motif), code: 'url_blocked' });
}

// Schémas qu'une page ne doit jamais afficher, même atteints par un autre
// chemin que page.goto (script de la page) : on la ramène à une page vide.
const _SCHEMAS_INTERDITS = /^(file|view-source|chrome|chrome-extension|devtools|filesystem|resource|moz-extension):/i;

function gardePage(page) {
    page.on('framenavigated', (frame) => {
        try {
            if (frame !== page.mainFrame()) return;
            if (_SCHEMAS_INTERDITS.test(frame.url())) page.goto('about:blank').catch(() => {});
        } catch (_) { /* page fermée */ }
    });
}

/** Pose la garde sur un contexte neuf, AVANT toute autre route. */
async function installerGarde(context) {
    // Enregistrée en premier, elle passe en DERNIER : les autres routes
    // (mocks, interception) terminent par route.fallback(), elle a donc
    // toujours le dernier mot avant le réseau.
    await context.route('**/*', async (route, request) => {
        let motif = null;
        try { motif = await refusUrl(request.url()); } catch (_) { motif = 'vérification impossible'; }
        if (motif) {
            if (request.isNavigationRequest()) console.warn(`[GARDE] navigation refusée : ${motif}`);
            return route.abort('blockedbyclient').catch(() => {});
        }
        return route.fallback().catch(() => {});
    });
    if (typeof context.routeWebSocket === 'function') {
        await context.routeWebSocket(/.*/, async (ws) => {
            let motif = null;
            try { motif = await refusUrl(ws.url()); } catch (_) { motif = 'vérification impossible'; }
            if (motif) { try { ws.close({ code: 1008, reason: 'refusé' }); } catch (_) {} return; }
            ws.connectToServer();
        });
    }
    context.on('page', gardePage);
}

// ── Moteur navigateur configurable (V13) ───────────────────────────────────
// BROWSER_ENGINE = chromium (défaut) | firefox | webkit. Chromium est le moteur
// de référence Playwright (le plus complet/stable, meilleure émulation device,
// CDP pour perfs/trace). Firefox/WebKit restent dispo pour le cross-browser.
const BROWSER_ENGINE = (process.env.BROWSER_ENGINE || 'chromium').toLowerCase();
const ENGINES = { chromium, firefox, webkit };

const USER_AGENTS = {
    chromium: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
    firefox:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    webkit:   'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
};
const USER_AGENT = USER_AGENTS[BROWSER_ENGINE] || USER_AGENTS.chromium;

// Prefs Firefox (about:config) — appliquées UNIQUEMENT quand BROWSER_ENGINE=firefox.
const FIREFOX_PREFS = {
    "dom.webdriver.enabled": false,
    "useAutomationExtension": false,
    "general.useragent.override": USER_AGENT,
    "intl.accept_languages": "fr-FR, fr, en-US, en",
    "browser.download.dir": DOWNLOAD_DIR,
    "browser.download.useDownloadDir": true,
    "network.auth.use-sspi": false,
    "network.http.connection-timeout": 90,
    "dom.max_script_run_time": 60,
    "dom.disable_beforeunload": true,
    "browser.tabs.warnOnClose": false,
    "browser.tabs.warnOnCloseOtherTabs": false,
    "security.fileuri.strict_origin_policy": false,
    "security.cert_pinning.enforcement_level": 0,
};

let globalBrowser = null;
const sessions = new Map();

// ==========================================
// SESSION REAPER — Auto-cleanup (Feature 1)
// ==========================================
const SESSION_TTL_MS = 15 * 60 * 1000;  // 15 minutes
const REAPER_INTERVAL_MS = 60 * 1000;   // check every 60s
const MAX_SESSIONS = 10;                 // hard limit
// Budget accordé à la tentative « locator officiel » QUAND un selector de
// repli est disponible. Court exprès : le repli smartResolveLocator doit
// pouvoir s'exécuter dans le temps que le client accorde à la requête.
const OFFICIAL_TRY_MS = parseInt(process.env.PW_OFFICIAL_TRY_MS || '2500', 10);

function touchSession(sid) {
    const s = sessions.get(sid);
    if (s) s.lastActivity = Date.now();
}

async function closeSession(sid, reason = 'unknown', { lockHeld = false } = {}) {
    const s = sessions.get(sid);
    if (!s) return;
    console.log(`[REAPER] Closing session ${sid.substring(0, 8)}… (reason: ${reason})`);
    // AUDIT 2026-06 — ordre important :
    //  1) delete AVANT d'attendre : plus aucune nouvelle requête ne mappe la
    //     session (getSession → 404, waiters du mutex → re-check → 410) ;
    //  2) on attend (borné 15 s) la fin de l'op en vol via le mutex, puis on
    //     ferme. Si l'op est gelée, force-close : elle recevra l'erreur
    //     Playwright « context closed », déjà gérée par les catch des handlers.
    sessions.delete(sid);
    // ``lockHeld`` : l'appelant (``/stop``) tient déjà le verrou de la
    // session ; l'attendre ici bloquerait 15 s avant de forcer.
    if (PW_MUTEX && s._lock && !lockHeld) {
        try { (await acquireLock(s._lock, { waitMs: 15000, maxWaiters: Infinity }))(); }
        catch (e) { /* timeout → force close */ }
    }
    try { await s.context.close(); } catch (e) {}
    cleanupSessionScreenshots(sid);
}

// ── Une instance par utilisateur ────────────────────────────────────
// Retourne [sid, session] de la session vivante appartenant à `owner`,
// ou null. Une session dont la page a crashé est fermée au passage afin
// que l'appelant puisse en recréer une proprement.
async function findLiveSessionByOwner(owner) {
    if (!owner) return null;
    for (const [sid, s] of sessions) {
        if (s.owner !== owner) continue;
        // AUDIT 2026-06 — ping borné : une page gelée ne bloque plus la
        // recherche. 'frozen' = fail-open (page sans doute juste occupée,
        // les handlers ont leurs propres timeouts).
        const verdict = await pingPage(s.page, 3000);
        if (verdict === 'crashed') { await closeSession(sid, 'owner_session_dead'); continue; }
        return [sid, s];
    }
    return null;
}

async function reapStaleSessions() {
    const now = Date.now();
    // Track reasons per sid so we can log them after closeSession deletes the entry
    const stale = new Map(); // sid -> reason string
    for (const [sid, s] of sessions) {
        const idle = now - (s.lastActivity || s.createdAt || now);
        if (idle > SESSION_TTL_MS) {
            stale.set(sid, `idle ${Math.round(idle / 1000)}s`);
            continue; // no need to ping a session we're already closing
        }
        // Also kill sessions with crashed pages.
        // AUDIT 2026-06 — ping borné (avant : un evaluate non borné sur une
        // page gelée bloquait TOUT le reaper). 'frozen' ne tue qu'après
        // 3 cycles consécutifs : une page qui exécute du JS lourd ~60 s
        // (dom.max_script_run_time) ne doit pas mourir au premier timeout.
        const verdict = await pingPage(s.page, 5000);
        if (verdict === 'crashed') {
            stale.set(sid, 'page_crash');
        } else if (verdict === 'frozen') {
            s._frozenPings = (s._frozenPings || 0) + 1;
            if (s._frozenPings >= 3) stale.set(sid, `page_frozen x${s._frozenPings}`);
            else console.warn(`[REAPER] Session ${sid.substring(0, 8)}… frozen (strike ${s._frozenPings}/3)`);
        } else {
            s._frozenPings = 0;
        }
    }
    for (const [sid, reason] of stale) {
        await closeSession(sid, reason);
    }
    if (stale.size > 0) console.log(`[REAPER] Cleaned ${stale.size} session(s). Active: ${sessions.size}`);
}

// Processus navigateur ORPHELINS seulement (cf. proc_util.js) : avant, tout
// renderer de plus de 20 min était tué, onglets actifs compris.
function killZombieProcesses() {
    try {
        const uid = typeof process.getuid === 'function' ? process.getuid() : null;
        const cmd = uid === null ? 'ps -eo pid=,ppid=,etimes=,args='
                                 : `ps -u ${uid} -o pid=,ppid=,etimes=,args=`;
        const texte = execSync(cmd, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        let navPid = null;
        try { navPid = globalBrowser && globalBrowser.process ? globalBrowser.process()?.pid : null; } catch (_) {}
        const cibles = orphelins(lirePs(texte), { ageMinS: 1200, epargner: [process.pid, navPid] });
        for (const pid of cibles) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
        if (cibles.length) console.log(`[REAPER] ${cibles.length} processus navigateur orphelin(s) arrêté(s).`);
    } catch (e) { /* ps indisponible : rien à faire */ }
}

// Verrous de démarrage par propriétaire : purgés quand ils sont au repos et
// que le propriétaire n'a plus de session (la Map ne grossit plus sans fin).
function purgeOwnerStartLocks() {
    const vivants = new Set([...sessions.values()].map(s => s.owner).filter(Boolean));
    for (const [owner, lock] of ownerStartLocks) {
        if (!vivants.has(owner) && lockIdle(lock)) ownerStartLocks.delete(owner);
    }
}

// Start reaper
const _reaperInterval = setInterval(async () => {
    try {
        await reapStaleSessions();
        killZombieProcesses();
        purgeOwnerStartLocks();
    } catch (e) { console.error('[REAPER] Error:', e.message); }
}, REAPER_INTERVAL_MS);


// ==========================================
// SCREENSHOT REAPER — disk-space safety net
// ==========================================
// Even with cleanupSessionScreenshots() being called on session close,
// leaked files accumulate when:
//   - the Node process crashes between screenshot write and session close
//   - the client forgets to POST /cleanup_screenshots on tab close
//   - a session was abandoned with a broken WebSocket
// This reaper catches both cases:
//   (1) orphan screenshots — PNG files whose session_id is no longer in
//       the active `sessions` Map AND whose mtime is older than the grace
//       period (we avoid racing a screenshot write that just happened
//       but hasn't been registered yet).
//   (2) stale screenshots — files older than MAX_SCREENSHOT_AGE_MS even
//       if their session is still active. Defends against a single
//       long-lived session growing forever.
const SCREENSHOT_ORPHAN_GRACE_MS = 5 * 60 * 1000;    // 5 min after session end before deletion
const MAX_SCREENSHOT_AGE_MS      = 4 * 60 * 60 * 1000; // 4h hard cap even for active sessions
const SCREENSHOT_REAPER_INTERVAL_MS = 10 * 60 * 1000;  // run every 10 min
// AUDIT 2026-06 — quota PAR SESSION (count + bytes) pour les fichiers qui
// s'accumulent (step_/shot_/fail_) : les caps d'âge ci-dessus laissaient
// une session active < 4h accumuler sans limite.
const MAX_SHOTS_PER_SESSION    = parseInt(process.env.PW_MAX_SHOTS_PER_SESSION || '300', 10);
const MAX_SHOTS_MB_PER_SESSION = parseInt(process.env.PW_MAX_SHOTS_MB_PER_SESSION || '200', 10);

// Matches step_<sid>_<n>.png, live_<sid>.png, smart_<sid>.png, view_<sid>.png,
// shot_<sid>_<ts>.png, fail_<sid8>_<ts>.png. fail_ uses the first 8 chars of
// the sid so we accept that too.
// Session id is 8-64 chars of [A-Za-z0-9-].
const SCREENSHOT_SID_RE = /^(?:step|live|smart|view|shot|fail)_([A-Za-z0-9-]{8,64})(?:_\d+)?\.png$/;

function reapScreenshots() {
    let files;
    try {
        files = fs.readdirSync(SCREENSHOT_DIR);
    } catch (e) {
        return; // dir missing / IO error — nothing to do
    }
    const now = Date.now();
    const activeSids = new Set(sessions.keys());
    let orphaned = 0, stale = 0, quota = 0, bytesFreed = 0;
    const survivors = []; // pour le quota par session (fichiers non supprimés)

    for (const f of files) {
        const m = SCREENSHOT_SID_RE.exec(f);
        if (!m) continue;
        const sid = m[1];
        const fpath = path.join(SCREENSHOT_DIR, f);

        let stat;
        try { stat = fs.statSync(fpath); } catch (e) { continue; }
        const age = now - stat.mtimeMs;

        const isOrphan = !activeSids.has(sid) && age > SCREENSHOT_ORPHAN_GRACE_MS;
        const isStale  = age > MAX_SCREENSHOT_AGE_MS;

        if (isOrphan || isStale) {
            try {
                fs.unlinkSync(fpath);
                bytesFreed += stat.size;
                if (isOrphan) orphaned++; else stale++;
            } catch (e) { /* file may have been deleted meanwhile */ }
        } else {
            survivors.push({ name: f, sid, mtimeMs: stat.mtimeMs, size: stat.size });
        }
    }

    // Quota par session sur les survivants (cf. session_util.js).
    for (const name of planScreenshotQuota(survivors, {
        maxPerSession: MAX_SHOTS_PER_SESSION,
        maxBytesPerSession: MAX_SHOTS_MB_PER_SESSION * 1024 * 1024,
    })) {
        try {
            const fpath = path.join(SCREENSHOT_DIR, name);
            const sz = fs.statSync(fpath).size;
            fs.unlinkSync(fpath);
            bytesFreed += sz;
            quota++;
        } catch (e) { /* file may have been deleted meanwhile */ }
    }

    if (orphaned || stale || quota) {
        const mb = (bytesFreed / (1024 * 1024)).toFixed(1);
        console.log(`[SCREENSHOT-REAPER] orphans=${orphaned} stale=${stale} quota=${quota} freed=${mb}MB (active sessions=${activeSids.size})`);
    }
}

// ── Autres artefacts : purgés par âge (2026-09-30). Téléchargements, HAR,
// vidéos et traces servent le temps d'une session ; les états sauvegardés
// (cookies) se rechargent plus tard, d'où une durée plus longue.
const ARTIFACT_MAX_AGE_MS = parseInt(process.env.PW_ARTIFACT_MAX_AGE_H || '24', 10) * 3600 * 1000;
const STATE_MAX_AGE_MS = parseInt(process.env.PW_STATE_MAX_AGE_D || '30', 10) * 86400 * 1000;

function _purgerDossier(dir, maxAgeMs, { recursif = false } = {}) {
    let n = 0;
    let noms;
    try { noms = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
    const entrees = [];
    for (const d of noms) {
        const f = path.join(dir, d.name);
        if (d.isDirectory()) {
            if (recursif) {
                n += _purgerDossier(f, maxAgeMs);
                try { if (!fs.readdirSync(f).length) fs.rmdirSync(f); } catch (_) {}
            }
            continue;
        }
        try { entrees.push({ name: d.name, mtimeMs: fs.statSync(f).mtimeMs }); } catch (_) {}
    }
    for (const nom of planArtifactPurge(entrees, { maxAgeMs })) {
        try { fs.unlinkSync(path.join(dir, nom)); n++; } catch (_) {}
    }
    return n;
}

function reapArtifacts() {
    const n = _purgerDossier(DOWNLOAD_DIR, ARTIFACT_MAX_AGE_MS, { recursif: true })
            + _purgerDossier(HAR_DIR, ARTIFACT_MAX_AGE_MS)
            + _purgerDossier(VIDEO_DIR, ARTIFACT_MAX_AGE_MS)
            + _purgerDossier(TRACE_DIR, ARTIFACT_MAX_AGE_MS)
            + _purgerDossier(COOKIES_DIR, STATE_MAX_AGE_MS);
    if (n) console.log(`[ARTIFACT-REAPER] ${n} fichier(s) purgé(s).`);
}

// Run once on startup (catches crashes that left files behind across restarts)
// and then on a timer.
setImmediate(() => {
    try { reapScreenshots(); } catch (e) { console.error('[SCREENSHOT-REAPER] startup:', e.message); }
    try { reapArtifacts(); } catch (e) { console.error('[ARTIFACT-REAPER] startup:', e.message); }
});
const _screenshotReaperInterval = setInterval(() => {
    try { reapScreenshots(); }
    catch (e) { console.error('[SCREENSHOT-REAPER] Error:', e.message); }
    try { reapArtifacts(); }
    catch (e) { console.error('[ARTIFACT-REAPER] Error:', e.message); }
}, SCREENSHOT_REAPER_INTERVAL_MS);


// Graceful shutdown. ``code`` ≠ 0 après une exception : le gestionnaire de
// services doit voir un échec (et relancer), pas un arrêt voulu.
async function gracefulShutdown(signal, code = 0) {
    console.log(`\n[SHUTDOWN] ${signal} received. Closing ${sessions.size} session(s)…`);
    clearInterval(_reaperInterval);
    clearInterval(_screenshotReaperInterval);
    for (const [sid] of sessions) {
        await closeSession(sid, 'shutdown');
    }
    if (globalBrowser) {
        try { await globalBrowser.close(); } catch (e) {}
        globalBrowser = null;
    }
    console.log(code ? `[SHUTDOWN] Exit ${code}.` : '[SHUTDOWN] Clean exit.');
    process.exit(code);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('uncaughtException', (e) => {
    console.error('[FATAL]', e && e.stack ? e.stack : e);
    // Arrêt borné : une fermeture de session gelée ne doit pas empêcher la
    // sortie (et donc la relance).
    setTimeout(() => process.exit(1), 15000).unref();
    gracefulShutdown('uncaughtException', 1);
});
// Une promesse rejetée sans gestionnaire (souvent une page fermée pendant
// une attente Playwright) est journalisée : elle ne doit ni passer inaperçue
// ni arrêter le service pour toutes les sessions.
process.on('unhandledRejection', (raison) => {
    console.error('[UNHANDLED]', raison && raison.stack ? raison.stack : raison);
});

// ==========================================
// BROWSER LIFECYCLE
// ==========================================
// Override opérateur : si FIREFOX_FORCE_HEADLESS=true, le service force le
// headless quelle que soit la valeur envoyée par le client. Robuste même si
// le backend Python n'a pas été redémarré ou envoie encore headless:false.
const FORCE_HEADLESS = process.env.BROWSER_FORCE_HEADLESS === 'true'
                    || process.env.FIREFOX_FORCE_HEADLESS === 'true'; // compat ascendante

// Options de launch par moteur. Les prefs Firefox (about:config) n'ont pas
// d'équivalent direct sur Chromium/WebKit : ce qui compte (langue, downloads,
// HTTPS, CSP) est porté côté contexte dans /start. Ici on ne met que le
// moteur-spécifique (args anti-détection, prefs headless Firefox).
function buildLaunchOptions(engine, headlessMode) {
    const common = { headless: headlessMode, args: ['--no-sandbox', '--disable-setuid-sandbox'],
                     proxy: PROXY_NAVIGATEUR };
    if (engine === 'firefox') {
        return {
            ...common,
            firefoxUserPrefs: {
                ...FIREFOX_PREFS,
                // Sans cela Firefox contourne le proxy pour localhost.
                'network.proxy.allow_hijacking_localhost': true,
                'network.proxy.no_proxies_on': '',
                ...(headlessMode ? {
                    'layers.acceleration.force-enabled': false,
                    'gfx.webrender.software': true,
                    'browser.sessionstore.resume_from_crash': false,
                } : {}),
            },
            env: headlessMode
                ? { ...process.env, MOZ_HEADLESS_WIDTH: '1920', MOZ_HEADLESS_HEIGHT: '1080' }
                : undefined,
        };
    }
    if (engine === 'chromium') {
        return {
            ...common,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',                        // stabilité en conteneur (/dev/shm petit)
                '--disable-blink-features=AutomationControlled',  // anti-détection
            ],
        };
    }
    return common; // webkit : pas d'options moteur-spécifiques
}

// Une seule promesse de lancement : deux /start simultanés ne lancent plus
// deux navigateurs (le second écrasait le premier, resté orphelin).
let _lancement = null;
async function ensureBrowser(headless) {
    if (globalBrowser && globalBrowser.isConnected()) return globalBrowser;
    if (_lancement) return _lancement;
    _lancement = _lancerNavigateur(headless).finally(() => { _lancement = null; });
    return _lancement;
}

async function _lancerNavigateur(headless) {
    if (!globalBrowser || !globalBrowser.isConnected()) {
        // Headless par défaut. Seul un `false` explicite force le mode fenêtré,
        // sauf si FORCE_HEADLESS est actif.
        const headlessMode = FORCE_HEADLESS ? true : (headless !== false);
        const launcher = ENGINES[BROWSER_ENGINE] || chromium;
        console.log(`[GLOBAL] Démarrage ${BROWSER_ENGINE} (Headless: ${headlessMode}${FORCE_HEADLESS ? ', forcé' : ''})`);
        globalBrowser = await launcher.launch(buildLaunchOptions(BROWSER_ENGINE, headlessMode));
        globalBrowser.on('disconnected', () => {
            console.warn('[GLOBAL] Browser déconnecté, reset...');
            globalBrowser = null;
            sessions.clear();
        });
    }
    return globalBrowser;
}

// ==========================================
// UTILITAIRES COULEURS
// ==========================================
function rgbToHex(rgb) {
    if (!rgb) return null;
    const m = rgb.match(/[\d.]+/g);
    if (!m || m.length < 3) return null;
    const [r, g, b, a] = m.map(Number);
    if (a !== undefined && a < 0.05) return 'transparent';
    return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
}

// ==========================================
// SHADOW DOM — SCAN RÉCURSIF PROFOND
// ==========================================
/**
 * Trouve un élément dans le shadow DOM (toute profondeur) via JS evaluate.
 * Retourne { found, x, y, w, h, text, tag } ou null.
 */
async function shadowDOMQuery(page, selector) {
    try {
        return await page.evaluate((sel) => {
            function deepQuery(root, selector) {
                try {
                    const el = root.querySelector(selector);
                    if (el) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            return {
                                found: true,
                                x: Math.round(rect.left + rect.width / 2),
                                y: Math.round(rect.top + rect.height / 2),
                                w: Math.round(rect.width), h: Math.round(rect.height),
                                text: (el.textContent || el.value || '').trim().substring(0, 100),
                                tag: el.tagName.toLowerCase(),
                            };
                        }
                    }
                } catch (e) {}
                // Scan shadow roots
                const allEls = root.querySelectorAll('*');
                for (const child of allEls) {
                    if (child.shadowRoot) {
                        const result = deepQuery(child.shadowRoot, selector);
                        if (result) return result;
                    }
                }
                return null;
            }
            return deepQuery(document, sel);
        }, selector);
    } catch (e) { return null; }
}

/**
 * Trouve un élément dans le shadow DOM par son texte visible.
 */
async function shadowDOMQueryByText(page, text) {
    try {
        return await page.evaluate((txt) => {
            function deepTextQuery(root, text) {
                const allEls = root.querySelectorAll('button, a, [role="button"], [role="link"], span, div, li, td, th, label');
                for (const el of allEls) {
                    const elText = (el.textContent || '').trim();
                    if (elText.toLowerCase().includes(text.toLowerCase()) && elText.length < 200) {
                        const rect = el.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0) {
                            const style = window.getComputedStyle(el);
                            if (style.display !== 'none' && style.visibility !== 'hidden') {
                                return { found: true, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
                            }
                        }
                    }
                    if (el.shadowRoot) {
                        const result = deepTextQuery(el.shadowRoot, text);
                        if (result) return result;
                    }
                }
                return null;
            }
            return deepTextQuery(document, txt);
        }, text);
    } catch (e) { return null; }
}

// ==========================================
// LOCATOR RÉSILIENT v3 — 10 STRATÉGIES
// ==========================================
function getAllFrames(page, maxDepth = 5) {
    const frames = [];
    function collect(frameList, depth) {
        if (depth > maxDepth) return;
        for (const f of frameList) {
            if (f.isDetached()) continue;
            frames.push(f);
            try { collect(f.childFrames(), depth + 1); } catch (e) {}
        }
    }
    collect(page.frames(), 0);
    return frames;
}

function isLikelyText(selector) {
    // More permissive: accept anything that looks like human-readable text.
    // Only exclude clear CSS/XPath patterns.
    if (!selector || selector.length < 2) return false;
    if (selector.startsWith('#') || selector.startsWith('.') || selector.startsWith('[')) return false;
    if (selector.startsWith('//') || selector.startsWith('(//')) return false;
    if (selector.startsWith('css=') || selector.startsWith('xpath=') || selector.startsWith('id=')) return false;
    if (selector.includes('>>') || selector.includes('::')) return false;
    // If it has alphabetic characters (any script) and no CSS combinators, it's likely text
    if (/[{}>+~]/.test(selector)) return false;
    return /[a-zA-ZÀ-ÿа-яА-Я\u4e00-\u9fff]/.test(selector);
}

async function tryLocatorInContext(ctx, selector, visTimeout = 150) {
    try {
        const isXPath = selector.startsWith('//') || selector.startsWith('(//');
        const loc = isXPath ? ctx.locator(`xpath=${selector}`) : ctx.locator(selector);
        const count = await loc.count().catch(() => 0);
        if (count > 0) {
            const first = loc.first();
            const visible = await first.isVisible({ timeout: visTimeout }).catch(() => false);
            if (visible) return first;
        }
    } catch (e) {}
    return null;
}

// ═══════════════════════════════════════════════════════════════════
//  Official Playwright Locator API resolver
// ═══════════════════════════════════════════════════════════════════
// Convertit un set de paramètres EXPLICITES (by_role, by_text, etc.) en
// Locator Playwright officiel via getByRole/Text/Label/etc.
// → Aucune chaîne CSS à parser, aucune ambiguïté, fiabilité maximale.
function escapeRegex(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function resolveOfficialLocator(page, params) {
    const {
        by_role, by_name, by_text, by_label, by_placeholder, by_test_id,
        by_alt, by_title, by_css, by_xpath,
        filter_has_text, filter_has,
        nth, exact = false,
    } = params;
    let loc = null;
    if (by_role) {
        const opts = {};
        if (by_name) opts.name = exact ? by_name : new RegExp(escapeRegex(by_name), 'i');
        if (exact) opts.exact = true;
        loc = page.getByRole(by_role, opts);
    } else if (by_text) {
        loc = page.getByText(by_text, { exact });
    } else if (by_label) {
        loc = page.getByLabel(by_label, { exact });
    } else if (by_placeholder) {
        loc = page.getByPlaceholder(by_placeholder, { exact });
    } else if (by_alt) {
        loc = page.getByAltText(by_alt, { exact });
    } else if (by_title) {
        loc = page.getByTitle(by_title, { exact });
    } else if (by_test_id) {
        loc = page.getByTestId(by_test_id);
    } else if (by_css) {
        loc = page.locator(by_css);
    } else if (by_xpath) {
        loc = page.locator(`xpath=${by_xpath}`);
    } else {
        return null;
    }
    if (filter_has_text) loc = loc.filter({ hasText: filter_has_text });
    if (filter_has) loc = loc.filter({ has: page.locator(filter_has) });
    if (nth !== undefined && nth !== null && nth >= 0) loc = loc.nth(nth);
    return loc;
}

// Store des Locators par session : ref opaque → { sid, locator, expires_at }
// Permet à pw_find de renvoyer un ref que pw_act peut réutiliser sans
// reconstruire la stratégie.
const locatorRefs = new Map();
const REF_TTL_MS = 5 * 60 * 1000; // 5 minutes

function storeLocatorRef(sid, locator, params, frame = null) {
    const ref = `loc_${Math.random().toString(36).substring(2, 14)}`;
    locatorRefs.set(ref, {
        sid, locator, params, frame,
        expires_at: Date.now() + REF_TTL_MS,
    });
    // GC périodique opportuniste
    if (locatorRefs.size > 200) {
        const now = Date.now();
        for (const [k, v] of locatorRefs.entries()) {
            if (v.expires_at < now) locatorRefs.delete(k);
        }
    }
    return ref;
}

function resolveRef(ref, page, sid = null) {
    const entry = locatorRefs.get(ref);
    if (!entry) return null;
    if (entry.expires_at < Date.now()) {
        locatorRefs.delete(ref);
        return null;
    }
    // Cross-session safety: a ref minted for session A must not be usable in B.
    if (sid && entry.sid !== sid) return null;
    // Reconstruit le locator depuis params (le Locator stocké peut être
    // détaché si la page a navigué). Plus robuste de re-résoudre — mais sur le
    // BON scope : si le ref provient d'une iframe, on retrouve ce frame dans
    // page.frames() et on re-résout dessus (sinon l'élément serait introuvable
    // côté page principale). Mécanisme Playwright natif (Frame == API Locator).
    let scope = page;
    if (entry.frame && (entry.frame.name || entry.frame.url)) {
        const fr = page.frames().find(f =>
            (entry.frame.name && f.name() === entry.frame.name) ||
            (entry.frame.url && f.url() === entry.frame.url));
        if (fr) scope = fr;
    }
    return resolveOfficialLocator(scope, entry.params);
}

async function smartResolveLocator(page, selector, opts = {}) {
    // ── Auto-correct: tag:text("X") and text="X" → tag:has-text("X") ──
    // Le LLM utilise souvent ces syntaxes inspirées de la doc Playwright,
    // mais elles ne sont PAS valides dans page.locator() / page.click().
    // :has-text() est l'extension CSS officielle Playwright qui marche partout.
    const origSelector = selector;
    // tag:text("X") → tag:has-text("X")  (et :text='X', :text=`X`)
    selector = selector.replace(/:text\((["'`])([^"'`]+)\1\)/g, ':has-text($1$2$1)');
    selector = selector.replace(/:text=(["'`])([^"'`]+)\1/g, ':has-text($1$2$1)');
    // text="X" en début / standalone → has-text. Note : on garde si combiné avec tag:.
    if (/^text=["']/.test(selector)) {
        const m = selector.match(/^text=(["'])(.+)\1$/);
        if (m) selector = `*:has-text("${m[2].replace(/"/g, '\\"')}")`;
    }
    if (selector !== origSelector) {
        console.log(`[smartResolve] Auto-rewrite: ${origSelector} → ${selector}`);
    }

    const isXPath = selector.startsWith('//') || selector.startsWith('(//');
    const isPlaywrightSyntax = selector.includes('text=') || selector.includes('role=') ||
        selector.includes('>>') || selector.startsWith('css=') || selector.startsWith('xpath=');
    const textLike = isLikelyText(selector);
    const VIS_T = 150; // fast visibility probe timeout

    // ─── Strategy 1 : Direct selector (CSS, XPath, Playwright syntax) ───
    const mainLoc = await tryLocatorInContext(page, selector, VIS_T);
    if (mainLoc) return { locator: mainLoc, frame: page, strategy: 'direct' };

    // ─── Strategy 2 : Text-based matching (LLM's most common usage) ─────
    // This is the key improvement for div/span-based apps.
    if (!isXPath && !isPlaywrightSyntax && textLike) {
        // 2a. getByText — direct text content match (case-insensitive)
        try {
            const tl = page.getByText(selector, { exact: false }).first();
            if (await tl.count().catch(() => 0) > 0 && await tl.isVisible({ timeout: VIS_T }).catch(() => false)) {
                // Found text, but check if we should climb to interactive ancestor
                const climbed = await climbToInteractive(tl);
                return { locator: climbed || tl, frame: page, strategy: climbed ? 'text+climb' : 'text' };
            }
        } catch (e) {}

        // 2b. :has-text() — finds CONTAINER that contains this text anywhere in descendants.
        // Critical for: <div class="btn"><span>Valider</span></div>
        try {
            for (const tag of ['button', 'a', '[role="button"]', '[onclick]', 'div', 'span', 'li', 'td', 'label']) {
                const ht = page.locator(`${tag}:has-text("${selector.replace(/"/g, '\\"')}")`).first();
                if (await ht.count().catch(() => 0) > 0 && await ht.isVisible({ timeout: VIS_T }).catch(() => false))
                    return { locator: ht, frame: page, strategy: `has-text(${tag})` };
            }
        } catch (e) {}

        // 2c. getByRole with name — covers buttons, links, etc. with accessible name
        try {
            for (const role of ['button', 'link', 'menuitem', 'tab', 'option', 'checkbox', 'radio']) {
                const rl = page.getByRole(role, { name: selector, exact: false }).first();
                if (await rl.count().catch(() => 0) > 0 && await rl.isVisible({ timeout: VIS_T }).catch(() => false))
                    return { locator: rl, frame: page, strategy: `role(${role})` };
            }
        } catch (e) {}

        // 2d. XPath normalize-space contains — handles whitespace, nested text, case variations
        try {
            const escaped = selector.replace(/'/g, "\\'");
            const xpaths = [
                `//*[contains(normalize-space(), '${escaped}')]`,
                `//*[contains(translate(normalize-space(), 'ABCDEFGHIJKLMNOPQRSTUVWXYZÀÂÄÉÈÊËÏÎÔÙÛÜÇ', 'abcdefghijklmnopqrstuvwxyzàâäéèêëïîôùûüç'), '${escaped.toLowerCase()}')]`,
            ];
            for (const xp of xpaths) {
                const xl = page.locator(`xpath=${xp}`).first();
                if (await xl.count().catch(() => 0) > 0 && await xl.isVisible({ timeout: VIS_T }).catch(() => false)) {
                    const climbed = await climbToInteractive(xl);
                    return { locator: climbed || xl, frame: page, strategy: climbed ? 'xpath-text+climb' : 'xpath-text' };
                }
            }
        } catch (e) {}

        // 2e. Text search in iframes
        try {
            const allFrames = getAllFrames(page);
            for (const frame of allFrames) {
                if (frame === page.mainFrame() || frame.isDetached()) continue;
                try {
                    const fl = frame.getByText(selector, { exact: false }).first();
                    if (await fl.count().catch(() => 0) > 0)
                        return { locator: fl, frame, strategy: 'iframe-text' };
                } catch (e) {}
            }
        } catch (e) {}
    }

    // ─── Strategy 3 : Iframes with original selector ───
    try {
        const allFrames = getAllFrames(page);
        for (const frame of allFrames) {
            if (frame === page.mainFrame() || frame.isDetached()) continue;
            const frameLoc = await tryLocatorInContext(frame, selector, VIS_T);
            if (frameLoc) return { locator: frameLoc, frame, strategy: 'iframe' };
        }
    } catch (e) {}

    // ─── Strategy 4 : Attribute matching (aria-label, placeholder, name, title) ───
    if (!isXPath && !isPlaywrightSyntax) {
        const escapedSel = selector.replace(/"/g, '\\"');
        const attrChecks = [
            { sel: `[aria-label="${escapedSel}"]`, name: 'aria-label' },
            { sel: `[placeholder="${escapedSel}"]`, name: 'placeholder' },
            { sel: `[name="${escapedSel}"]`, name: 'name' },
            { sel: `[title="${escapedSel}"]`, name: 'title' },
            // Case-insensitive via CSS i flag (works in modern browsers)
            { sel: `[aria-label="${escapedSel}" i]`, name: 'aria-label-i' },
        ];
        for (const { sel, name } of attrChecks) {
            try {
                const al = page.locator(sel).first();
                if (await al.count().catch(() => 0) > 0 && await al.isVisible({ timeout: VIS_T }).catch(() => false))
                    return { locator: al, frame: page, strategy: name };
            } catch (e) {}
        }

        // data-testid, data-cy, data-qa
        for (const attr of ['data-testid', 'data-cy', 'data-qa', 'data-automation', 'data-test']) {
            try {
                const al = page.locator(`[${attr}="${escapedSel}"]`).first();
                if (await al.count().catch(() => 0) > 0 && await al.isVisible({ timeout: VIS_T }).catch(() => false))
                    return { locator: al, frame: page, strategy: attr };
            } catch (e) {}
        }
    }

    // ─── Strategy 5 : Shadow DOM ───
    if (!isXPath) {
        const shadowResult = await shadowDOMQuery(page, selector);
        if (shadowResult?.found)
            return { locator: null, frame: page, strategy: 'shadow-dom', coords: { x: shadowResult.x, y: shadowResult.y } };
        if (textLike) {
            const shadowTextResult = await shadowDOMQueryByText(page, selector);
            if (shadowTextResult?.found)
                return { locator: null, frame: page, strategy: 'shadow-dom-text', coords: { x: shadowTextResult.x, y: shadowTextResult.y } };
        }
    }

    // ─── Strategy 6 : JS deep text search with interactive ancestor climb ───
    // Last resort: find ANY element containing the text via JS, then climb to clickable ancestor
    if (textLike) {
        try {
            const jsResult = await page.evaluate((text) => {
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null);
                const needle = text.toLowerCase().trim();
                while (walker.nextNode()) {
                    const node = walker.currentNode;
                    if (node.textContent.toLowerCase().trim().includes(needle)) {
                        let el = node.parentElement;
                        // Climb to nearest interactive ancestor
                        const interactiveTags = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL']);
                        const interactiveAttrs = ['onclick', 'role', 'tabindex', 'href'];
                        let candidate = el;
                        for (let i = 0; i < 8 && candidate; i++) {
                            if (interactiveTags.has(candidate.tagName)) { el = candidate; break; }
                            if (candidate.getAttribute('role') === 'button' ||
                                candidate.getAttribute('role') === 'link' ||
                                candidate.getAttribute('role') === 'menuitem' ||
                                candidate.getAttribute('role') === 'tab' ||
                                candidate.hasAttribute('onclick') ||
                                candidate.hasAttribute('tabindex') ||
                                candidate.style.cursor === 'pointer' ||
                                window.getComputedStyle(candidate).cursor === 'pointer') {
                                el = candidate; break;
                            }
                            candidate = candidate.parentElement;
                        }
                        if (!el) continue;
                        const rect = el.getBoundingClientRect();
                        if (rect.width === 0 || rect.height === 0) continue;
                        return { found: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
                    }
                }
                return { found: false };
            }, selector);
            if (jsResult?.found)
                return { locator: null, frame: page, strategy: 'js-text-walk', coords: { x: jsResult.x, y: jsResult.y } };
        } catch (e) {}
    }

    // ─── Strategy 7 : Fallback without visibility check ───
    const fallback = isXPath ? page.locator(`xpath=${selector}`) : page.locator(selector);
    return { locator: fallback.first(), frame: page, strategy: 'fallback' };
}

// Remonte d'un nœud de texte vers l'ancêtre RÉELLEMENT interactif.
//
// Motif canonique des applis à base de <div> (GWT, GXT, SmartGWT, ExtJS) :
//     <div class="x-btn"><table><tr><td class="x-btn-text"><span>Valider</span>
// getByText() rend le <span>. Cliquer dessus marche par bouillonnement, mais
// fill/check/hover/état visent le mauvais nœud, et l'ancêtre porte souvent le
// vrai `cursor:pointer`, le `disabled`, le rôle.
//
// Historique : cette fonction a longtemps été un stub `return null`, alors que
// ses deux appelants testaient son résultat et annonçaient une stratégie
// `text+climb` qui ne pouvait jamais se produire (audit 2026-08-08).
//
// Règle : on ne remonte QUE si l'ancêtre reste « serré » autour du texte
// (aire ≤ 6× celle du nœud de départ) — sinon on finit sur <body> et on clique
// n'importe où. Retourne null quand rien de mieux n'est trouvé.
async function climbToInteractive(_locator) {
    try {
        const handle = await _locator.elementHandle({ timeout: 500 }).catch(() => null);
        if (!handle) return null;
        // On renvoie un CHEMIN, pas un handle : marquer le nœud (setAttribute)
        // déclencherait les MutationObserver de la page — précisément ce que
        // font les frameworks qu'on essaie d'aider.
        const xpath = await handle.evaluate((el) => {
            const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label', 'summary']);
            const INTERACTIVE_ROLES = new Set([
                'button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'option',
                'combobox', 'switch', 'slider', 'spinbutton', 'treeitem', 'gridcell',
            ]);
            function looksInteractive(node) {
                if (!node || node.nodeType !== 1) return false;
                const tag = node.tagName.toLowerCase();
                if (INTERACTIVE_TAGS.has(tag)) return true;
                const role = (node.getAttribute('role') || '').toLowerCase();
                if (INTERACTIVE_ROLES.has(role)) return true;
                if (node.hasAttribute('onclick')) return true;
                if (typeof node.onclick === 'function') return true;
                const ti = node.getAttribute('tabindex');
                if (ti !== null && ti !== '-1') return true;
                try {
                    if (window.getComputedStyle(node).cursor === 'pointer') return true;
                } catch (e) {}
                return false;
            }
            function absXPath(node) {
                const parts = [];
                while (node && node.nodeType === 1 && node.tagName !== 'HTML') {
                    let i = 1, sib = node.previousElementSibling;
                    while (sib) { if (sib.tagName === node.tagName) i++; sib = sib.previousElementSibling; }
                    parts.unshift(node.tagName.toLowerCase() + '[' + i + ']');
                    node = node.parentElement;
                }
                return '/html/' + parts.join('/');
            }
            const startRect = el.getBoundingClientRect();
            const startArea = Math.max(1, startRect.width * startRect.height);
            // Le nœud de départ est déjà le bon : ne rien faire.
            if (looksInteractive(el)) return null;
            let node = el.parentElement;
            let hops = 0;
            while (node && hops < 6 && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
                const r = node.getBoundingClientRect();
                if (r.width * r.height > startArea * 6) break;   // trop large : on s'arrête
                if (looksInteractive(node)) return absXPath(node);
                node = node.parentElement;
                hops++;
            }
            return null;
        }).catch(() => null);
        try { await handle.dispose(); } catch (e) {}
        if (!xpath) return null;
        // Les deux appelants construisent leur locator sur la page principale
        // (getByText / xpath) — on relocalise donc dans le même contexte.
        const loc = _locator.page().locator(`xpath=${xpath}`).first();
        if (await loc.count().catch(() => 0) === 0) return null;
        return loc;
    } catch (e) {
        return null;
    }
}

async function scrollIntoViewIfNeeded(locator) {
    try { await locator.scrollIntoViewIfNeeded({ timeout: 3000 }); }
    catch (e) {
        try { await locator.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })); } catch (e2) {}
    }
}

async function safeRemoveOverlays(page, aggressive = false) {
    try {
        await page.evaluate((agg) => {
            // ── Phase 1: Known cookie/GDPR banners (always safe) ──
            const cookieSelectors = [
                '#onetrust-banner-sdk', '#onetrust-consent-sdk', '.cookie-banner', '.cookie-consent',
                '#cookie-law-info-bar', '.fc-consent-root', '#CybotCookiebotDialog', '.cc-window',
                '#gdpr-consent-tool-wrapper', '.cc-banner', '#cookie-notice', '.cookie-notice',
                '#cookiebanner', '.cookie-wall', '#cookies-eu-banner', '.js-cookie-consent',
                '#tarteaucitron', '.tarteaucitronAlertBig', '#axeptio_overlay', '.didomi-popup',
                '#usercentrics-root', '.cky-consent-container', '.qc-cmp-ui-container',
            ];
            cookieSelectors.forEach(sel => document.querySelectorAll(sel).forEach(el => {
                try { el.remove(); } catch (e) {}
            }));

            // ── Phase 2: Chat widgets & newsletter popups ──
            const widgetSelectors = [
                '#hubspot-messages-iframe-container', '#intercom-container', '#drift-widget',
                '.crisp-client', '#tidio-chat', '#zsiq_float', '.zopim', '#launcher',
                '[class*="newsletter-popup"]', '[class*="popup-modal"]', '[class*="exit-intent"]',
                '[class*="subscribe-popup"]', '[id*="newsletter"]',
                // Toast notifications
                '.toast', '.Toastify', '[class*="snackbar"]', '[class*="notification-bar"]',
                '.notistack-SnackbarContainer', '.notyf',
            ];
            widgetSelectors.forEach(sel => document.querySelectorAll(sel).forEach(el => {
                try { el.remove(); } catch (e) {}
            }));

            // ── Phase 3: Generic modal backdrops (only the backdrop, not the modal itself) ──
            document.querySelectorAll('.modal-backdrop, .overlay-backdrop, [class*="backdrop"]').forEach(el => {
                try { el.remove(); } catch (e) {}
            });

            // ── Phase 4: Unlock body scroll ──
            document.body.style.overflow = '';
            document.body.style.position = '';
            document.body.style.top = '';
            document.body.style.width = '';
            document.body.classList.remove('modal-open', 'no-scroll', 'overflow-hidden');
            document.documentElement.style.overflow = '';

            // ── Phase 5: High z-index fixed overlays (only if aggressive or clearly blocking) ──
            document.querySelectorAll('*').forEach(el => {
                const style = window.getComputedStyle(el);
                const z = parseInt(style.zIndex) || 0;
                const pos = style.position;
                if (z > 9000 && (pos === 'fixed' || pos === 'absolute')) {
                    const rect = el.getBoundingClientRect();
                    const tag = el.tagName.toLowerCase();
                    // Never remove navigation, headers, or sidebars
                    if (['nav', 'header', 'aside', 'footer'].includes(tag)) return;
                    const role = el.getAttribute('role');
                    // In non-aggressive mode, don't remove dialogs (they might be intentional)
                    if (!agg && (role === 'dialog' || role === 'alertdialog')) return;
                    // Only remove if it covers a significant portion of the viewport
                    if (rect.width > window.innerWidth * 0.3 && rect.height > window.innerHeight * 0.15) {
                        try { el.remove(); } catch (e) {}
                    }
                }
            });

            // ── Phase 6: position:sticky elements that may cover content ──
            document.querySelectorAll('*').forEach(el => {
                const style = window.getComputedStyle(el);
                if (style.position === 'sticky' || style.position === 'fixed') {
                    const z = parseInt(style.zIndex) || 0;
                    if (z > 100 && el.tagName.toLowerCase() !== 'nav' && el.tagName.toLowerCase() !== 'header') {
                        const rect = el.getBoundingClientRect();
                        // Small sticky bars (cookie bars, notification bars)
                        if (rect.height < 100 && rect.width > window.innerWidth * 0.5) {
                            try { el.remove(); } catch (e) {}
                        }
                    }
                }
            });
        }, aggressive);
    } catch (e) {}
}

// ==========================================
// SMART LABEL → INPUT RESOLUTION
// ==========================================
// When a selector matches a <label> or text near a form field,
// find the actual input element to fill.
async function resolveFormInput(page, locator, originalSelector) {
    try {
        const resolved = await locator.evaluate((el, sel) => {
            const tag = el.tagName.toLowerCase();

            // Already an input? Return as-is
            if (['input', 'textarea', 'select'].includes(tag)) return null;

            // It's a <label> — find associated input
            if (tag === 'label') {
                // Method 1: <label for="xxx">
                const forAttr = el.getAttribute('for');
                if (forAttr) {
                    const target = document.getElementById(forAttr);
                    if (target) return { method: 'label-for', id: forAttr };
                }
                // Method 2: <label><input> nested inside
                const nested = el.querySelector('input, textarea, select');
                if (nested) {
                    const nid = nested.id || nested.name || nested.getAttribute('data-testid');
                    return { method: 'label-nested', selector: nid ? `#${nid}` : null, index: true };
                }
            }

            // It's text near a form field — find the closest input
            // Strategy: look for inputs in the same form-row, parent container, or nearby
            const searchContainers = [];
            let parent = el.parentElement;
            for (let i = 0; i < 5 && parent; i++) {
                searchContainers.push(parent);
                parent = parent.parentElement;
            }

            for (const container of searchContainers) {
                const inputs = container.querySelectorAll('input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea, select');
                if (inputs.length === 1) {
                    // Only one input in the container — it's probably the target
                    const inp = inputs[0];
                    const id = inp.id || inp.name || inp.getAttribute('data-testid');
                    return { method: 'nearby-single', selector: id ? (inp.id ? `#${id}` : `[name="${id}"]`) : null, index: true };
                }
                if (inputs.length > 1) {
                    // Multiple inputs — find the one closest to our text
                    const elRect = el.getBoundingClientRect();
                    let closest = null, minDist = Infinity;
                    for (const inp of inputs) {
                        const inpRect = inp.getBoundingClientRect();
                        const dx = inpRect.left - elRect.right;
                        const dy = Math.abs(inpRect.top - elRect.top);
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist < minDist) { minDist = dist; closest = inp; }
                    }
                    if (closest && minDist < 500) {
                        const id = closest.id || closest.name || closest.getAttribute('data-testid');
                        return { method: 'nearby-closest', selector: id ? (closest.id ? `#${id}` : `[name="${id}"]`) : null, index: true };
                    }
                }
            }

            // Also try: aria-labelledby reverse lookup
            const elText = el.textContent.trim().toLowerCase();
            const allInputs = document.querySelectorAll('input, textarea, select');
            for (const inp of allInputs) {
                const ariaLabel = (inp.getAttribute('aria-label') || '').toLowerCase();
                const placeholder = (inp.getAttribute('placeholder') || '').toLowerCase();
                const name = (inp.getAttribute('name') || '').toLowerCase();
                if (ariaLabel.includes(elText) || placeholder.includes(elText) || name.includes(elText)) {
                    const id = inp.id || inp.name;
                    return { method: 'aria-match', selector: id ? (inp.id ? `#${id}` : `[name="${id}"]`) : null, index: true };
                }
            }

            return null;
        }, originalSelector);

        if (resolved) {
            // Re-resolve to get the actual input locator
            if (resolved.selector) {
                const inputLoc = page.locator(resolved.selector).first();
                if (await inputLoc.count().catch(() => 0) > 0) {
                    return { locator: inputLoc, method: resolved.method };
                }
            }
            if (resolved.index) {
                // Fallback: find nearest input via label's container
                const containerInput = locator.locator('..').locator('input, textarea, select').first();
                if (await containerInput.count().catch(() => 0) > 0) {
                    return { locator: containerInput, method: 'container-child' };
                }
            }
        }
    } catch (e) {}
    return null; // Return null = use original locator
}

// ==========================================
// SMART CLICK — 7 STRATÉGIES CASCADÉES
// ==========================================
// ── AX Memory : capture DOM ancestors for hierarchy tracking ─────────
// Called after a successful action to extract the semantic ancestor chain
// (max 3 levels) of the acted-on element. Used by backend/ax_memory.py
// to build a deep DOM hierarchy per page across runs.
//
// Returned format: [
//   { tag: 'menu', role: 'menu', name: 'Admin', expandable: true },
//   { tag: 'nav',  role: 'navigation', name: 'Main', expandable: false },
//   { tag: 'header', role: 'banner', name: '', expandable: false },
// ]
// Order: closest ancestor first. Empty array if nothing semantic found.
// Safe : catches all errors, returns [] on failure. Never throws.
async function captureAncestors(locator) {
    if (!locator) return [];
    try {
        const handle = await locator.elementHandle({ timeout: 500 }).catch(() => null);
        if (!handle) return [];
        const ancestors = await handle.evaluate((el) => {
            const SEMANTIC_TAGS = new Set([
                'header', 'nav', 'main', 'aside', 'footer', 'form',
                'section', 'article', 'dialog',
            ]);
            const SEMANTIC_ROLES = new Set([
                'banner', 'navigation', 'main', 'complementary', 'contentinfo',
                'form', 'search', 'dialog', 'menu', 'menubar', 'menuitem',
                'toolbar', 'tablist', 'tab', 'tabpanel', 'region',
            ]);
            const out = [];
            let cur = el.parentElement;
            let depth = 0;
            const MAX_DEPTH = 3;
            while (cur && depth < MAX_DEPTH) {
                const tag = (cur.tagName || '').toLowerCase();
                const role = (cur.getAttribute('role') || '').toLowerCase();
                const ariaLabel = cur.getAttribute('aria-label') || '';
                const ariaHaspopup = cur.getAttribute('aria-haspopup');
                const ariaExpanded = cur.getAttribute('aria-expanded');
                // An ancestor qualifies as "semantic" if:
                //   - it's a landmark tag (header/nav/main...)
                //   - OR it has an explicit role
                //   - OR it's expandable (menu/dropdown)
                //   - OR it has a meaningful aria-label
                const isSemanticTag = SEMANTIC_TAGS.has(tag);
                const isSemanticRole = role && SEMANTIC_ROLES.has(role);
                const isExpandable = ariaHaspopup !== null
                    || ariaExpanded !== null;
                const hasAriaLabel = ariaLabel && ariaLabel.length > 0;
                if (isSemanticTag || isSemanticRole || isExpandable || hasAriaLabel) {
                    // Extract accessible name : aria-label > heading > text
                    let name = ariaLabel;
                    if (!name) {
                        const heading = cur.querySelector('h1,h2,h3,h4,h5,h6,legend');
                        if (heading) name = (heading.textContent || '').trim().slice(0, 80);
                    }
                    if (!name) {
                        // Fallback : first meaningful text child
                        const txt = (cur.textContent || '').trim();
                        if (txt.length > 0 && txt.length < 80) name = txt;
                    }
                    // Determine effective role (landmark tags map to aria roles)
                    let effRole = role;
                    if (!effRole) {
                        const TAG_TO_ROLE = {
                            'header': 'banner', 'nav': 'navigation',
                            'main': 'main', 'aside': 'complementary',
                            'footer': 'contentinfo', 'form': 'form',
                            'section': 'region', 'article': 'article',
                            'dialog': 'dialog',
                        };
                        effRole = TAG_TO_ROLE[tag] || tag;
                    }
                    out.push({
                        tag: tag,
                        role: effRole,
                        name: (name || '').slice(0, 80),
                        expandable: isExpandable,
                    });
                    depth += 1;
                }
                cur = cur.parentElement;
            }
            return out;
        });
        return Array.isArray(ancestors) ? ancestors : [];
    } catch (e) {
        return [];
    }
}


async function smartClick(page, selector, opts = {}) {
    const { timeout = 8000, button = 'left', modifiers = [], human = false } = opts;
    // Reduced cascade timeouts: element is already resolved, no need for long waits
    const FAST = 2000;

    // Résoudre le locateur d'abord
    let resolved;
    try { resolved = await smartResolveLocator(page, selector, opts); }
    catch (e) { resolved = { locator: page.locator(selector).first(), frame: page, strategy: 'direct' }; }

    // Cas shadow DOM / JS text walk : clic par coordonnées directement
    if (resolved.coords) {
        try {
            if (human) await humanClick(page, resolved.coords.x, resolved.coords.y);
            else await page.mouse.click(resolved.coords.x, resolved.coords.y, { button });
            return { success: true, strategy: resolved.strategy };
        } catch (e) {}
    }

    const loc = resolved.locator;
    const errors = [];

    // Stratégie 1 : Clic Playwright normal
    try {
        await scrollIntoViewIfNeeded(loc);
        if (human) {
            const box = await loc.boundingBox({ timeout: FAST });
            if (box) {
                const ox = box.width * (0.3 + Math.random() * 0.4);
                const oy = box.height * (0.3 + Math.random() * 0.4);
                await humanClick(page, box.x + ox, box.y + oy);
                return { success: true, strategy: '1-human', resolved: resolved.strategy };
            }
        }
        await loc.click({ timeout, button, modifiers });
        return { success: true, strategy: '1-playwright', resolved: resolved.strategy };
    } catch (e) { errors.push(`S1: ${e.message.substring(0, 80)}`); }

    // Stratégie 2 : Suppression d'overlays + pointer-events fix + clic
    try {
        await safeRemoveOverlays(page);
        // Fix pointer-events:none on element and ancestors
        await loc.evaluate(el => {
            let node = el;
            for (let i = 0; i < 10 && node; i++) {
                const style = window.getComputedStyle(node);
                if (style.pointerEvents === 'none') {
                    node.style.pointerEvents = 'auto';
                }
                node = node.parentElement;
            }
        }).catch(() => {});
        await page.waitForTimeout(100);
        await scrollIntoViewIfNeeded(loc);
        await loc.click({ timeout: FAST, button, modifiers });
        return { success: true, strategy: '2-overlay+pointer-fix', resolved: resolved.strategy };
    } catch (e) { errors.push(`S2: ${e.message.substring(0, 80)}`); }

    // Stratégie 3 : Force click
    try {
        await loc.click({ timeout: FAST, force: true, button, modifiers });
        return { success: true, strategy: '3-force', resolved: resolved.strategy };
    } catch (e) { errors.push(`S3: ${e.message.substring(0, 80)}`); }

    // Stratégie 4 : Scroll au centre + pause + clic
    try {
        await loc.evaluate(el => el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' }));
        await page.waitForTimeout(200);
        await loc.click({ timeout: FAST, button, modifiers });
        return { success: true, strategy: '4-scroll-center', resolved: resolved.strategy };
    } catch (e) { errors.push(`S4: ${e.message.substring(0, 80)}`); }

    // Stratégie 5 : JS element.click()
    try {
        await loc.evaluate(el => el.click());
        return { success: true, strategy: '5-js-click', resolved: resolved.strategy };
    } catch (e) { errors.push(`S5: ${e.message.substring(0, 80)}`); }

    // Stratégie 6 : Dispatch MouseEvent complet (mousedown + mouseup + click + pointer)
    try {
        await loc.evaluate(el => {
            const rect = el.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const init = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, which: 1, button: 0, view: window };
            el.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1 }));
            el.dispatchEvent(new MouseEvent('mousedown', init));
            el.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1 }));
            el.dispatchEvent(new MouseEvent('mouseup', init));
            el.dispatchEvent(new MouseEvent('click', init));
        });
        return { success: true, strategy: '6-mouse-event-dispatch', resolved: resolved.strategy };
    } catch (e) { errors.push(`S6: ${e.message.substring(0, 80)}`); }

    // Stratégie 7 : Clic par coordonnées via boundingBox
    try {
        const box = await loc.boundingBox({ timeout: FAST });
        if (!box) throw new Error('No bounding box');
        const cx = box.x + box.width / 2;
        const cy = box.y + box.height / 2;
        if (human) await humanClick(page, cx, cy);
        else await page.mouse.click(cx, cy, { button });
        return { success: true, strategy: '7-coords', resolved: resolved.strategy };
    } catch (e) { errors.push(`S7: ${e.message.substring(0, 80)}`); }

    throw new Error(`smartClick failed on "${selector}" (resolved via ${resolved.strategy}):\n${errors.join('\n')}`);
}

// ==========================================
// MOUVEMENT DE SOURIS HUMAIN (Courbes de Bézier)
// ==========================================
function bezierCurve(start, end, steps = 25) {
    const cp1x = start.x + (end.x - start.x) * 0.3 + (Math.random() - 0.5) * 80;
    const cp1y = start.y + (end.y - start.y) * 0.1 + (Math.random() - 0.5) * 80;
    const cp2x = start.x + (end.x - start.x) * 0.7 + (Math.random() - 0.5) * 40;
    const cp2y = start.y + (end.y - start.y) * 0.9 + (Math.random() - 0.5) * 40;
    const points = [];
    for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const it = 1 - t;
        points.push({
            x: it * it * it * start.x + 3 * it * it * t * cp1x + 3 * it * t * t * cp2x + t * t * t * end.x,
            y: it * it * it * start.y + 3 * it * it * t * cp1y + 3 * it * t * t * cp2y + t * t * t * end.y,
        });
    }
    return points;
}

async function humanMouseMove(page, fromX, fromY, toX, toY) {
    const points = bezierCurve({ x: fromX, y: fromY }, { x: toX, y: toY }, 20 + Math.floor(Math.random() * 15));
    for (const p of points) {
        await page.mouse.move(p.x, p.y);
        await page.waitForTimeout(3 + Math.floor(Math.random() * 8));
    }
}

async function humanClick(page, x, y) {
    const fromX = 960 + (Math.random() - 0.5) * 200;
    const fromY = 540 + (Math.random() - 0.5) * 200;
    await humanMouseMove(page, fromX, fromY, x, y);
    await page.waitForTimeout(50 + Math.floor(Math.random() * 120));
    await page.mouse.click(x, y);
}

// ==========================================
// MIDDLEWARE
// ==========================================
async function getSession(req, res, next) {
    const sid = req.body?.session_id || req.query?.session_id;
    // Propriétaire obligatoire (2026-09-30) : une session d'un autre compte
    // répond exactement comme une session inconnue.
    if (!sid || !sessions.has(sid) || !ownerMatches(sessions.get(sid), ownerFromRequest(req))) {
        return res.status(404).json({ error: "Session introuvable." });
    }
    const session = sessions.get(sid);
    // AUDIT 2026-06 — ping borné (3 s) : une page gelée ne bloque plus la
    // requête entrante ('frozen' = fail-open, les handlers ont leurs propres
    // timeouts). Crash → closeSession (et plus un simple delete de la Map,
    // qui laissait le context Playwright ouvert → fuite RAM).
    const verdict = await pingPage(session.page, 3000);
    if (verdict === 'crashed') {
        await closeSession(sid, 'page_crash_on_request');
        return res.status(410).json({ error: "Session expirée (page crash)." });
    }
    touchSession(sid);
    // AUDIT 2026-06 — mutex par session : UN SEUL point d'intégration pour
    // les ~80 routes. Le verrou est relâché au finish/close de la réponse
    // (close couvre la déconnexion client). Voir session_lock.js.
    if (PW_MUTEX) {
        if (!session._lock) session._lock = makeLock();
        let release;
        try {
            release = await acquireLock(session._lock, { waitMs: LOCK_WAIT_MS, maxWaiters: LOCK_MAX_W });
        } catch (e) {
            const code = e.code === 429 ? 429 : 423;
            return res.status(code).json({
                error: code === 429
                    ? "File d'attente de la session pleine — réessaie dans un instant."
                    : "Session occupée (opération longue en cours) — réessaie.",
                retryable: true,
            });
        }
        // Re-check post-attente : le reaper a pu fermer la session pendant
        // qu'on attendait notre tour.
        if (!sessions.has(sid)) {
            release();
            return res.status(410).json({ error: "Session expirée." });
        }
        res.once('finish', release);
        res.once('close', release);
    }
    req.session = session;
    req.sessionId = sid;
    next();
}

// ── Screenshot write for a specific step number (file I/O only).
async function liveSnapshotForStep(page, sid, n) {
    if (!page || !sid || !n) return null;
    const liveName = `live_${sid}.png`;
    const stepName = `step_${sid}_${n}.png`;
    const livePath = path.join(SCREENSHOT_DIR, liveName);
    const stepPath = path.join(SCREENSHOT_DIR, stepName);
    try {
        await page.screenshot({ path: livePath, fullPage: false, timeout: 3000 });
        try { fs.copyFileSync(livePath, stepPath); } catch (e) {}
        return stepName;
    } catch (e) {
        return null;
    }
}

// ── Cleanup all step_<sid>_*.png and friends for a given session ────
function cleanupSessionScreenshots(sid) {
    if (!sid) return;
    try {
        const files = fs.readdirSync(SCREENSHOT_DIR);
        const sid8 = sid.substring(0, 8);
        for (const f of files) {
            // exact-match files we own for this session
            if (f === `live_${sid}.png` || f === `smart_${sid}.png` || f === `view_${sid}.png`
                || f.startsWith(`step_${sid}_`) || f.startsWith(`shot_${sid}_`)
                || f.startsWith(`fail_${sid8}_`)) {
                try { fs.unlinkSync(path.join(SCREENSHOT_DIR, f)); } catch (e) {}
            }
        }
    } catch (e) {}
}

// ── Auto-snapshot middleware (SYNC wrap of res.json, SAFE).
// Incrémente le compteur de session et injecte `screenshot_step` dans
// le payload JSON de la réponse SYNCHRONIQUEMENT (aucun await).
// Le fichier est écrit en fire-and-forget via setImmediate après la réponse.
// → Pas de blocage, pas de Promise retournée, comportement identique à res.json normal.
// NB mutex (AUDIT 2026-06) : ce screenshot différé s'exécute APRÈS le release
// du verrou de session (post-finish) — choix assumé : page.screenshot est
// sérialisé par le protocole Playwright lui-même, et verrouiller l'après-
// réponse retarderait la requête suivante pour un simple PNG best-effort.
function autoSnapshot(req, res, next) {
    const origJson = res.json.bind(res);
    res.json = function(payload) {
        try {
            const ok = this.statusCode >= 200 && this.statusCode < 300;
            const s = sessions.get(req.sessionId);
            const page = req.session && req.session.page;
            if (ok && s && page &&
                payload && typeof payload === 'object' && !Array.isArray(payload)) {
                s.screenshotCounter = (s.screenshotCounter || 0) + 1;
                const n = s.screenshotCounter;
                payload.screenshot_step = n;
                console.log(`[autoSnapshot] sid=${req.sessionId.substring(0,8)} step=${n} → step_${req.sessionId}_${n}.png`);
                // Fire-and-forget : écriture après envoi de la réponse HTTP
                setImmediate(() => {
                    liveSnapshotForStep(page, req.sessionId, n)
                        .then(name => {
                            if (name) console.log(`[autoSnapshot] WROTE ${name}`);
                            else console.warn(`[autoSnapshot] FAILED to write step ${n} for sid=${req.sessionId.substring(0,8)}`);
                        })
                        .catch(e => console.error(`[autoSnapshot] ERROR writing step ${n}:`, e.message));
                });
            } else if (ok) {
                console.log(`[autoSnapshot] SKIP sid=${req.sessionId ? req.sessionId.substring(0,8) : '?'} (s=${!!s} page=${!!page} payload=${typeof payload})`);
            }
        } catch (e) {
            console.error(`[autoSnapshot] EXCEPTION:`, e.message);
        }
        return origJson(payload);
    };
    next();
}

// ── <select> natif : choisir SANS essai-erreur ────────────────────────
//
// L'ancienne échelle tentait selectOption({value}) puis, en cas d'échec,
// selectOption({label}). Or un selectOption qui ne matche rien consomme la
// TOTALITÉ de son timeout avant de lever : mesuré à 10,05 s pour un choix par
// libellé (0,05 s par valeur), pendant que le client Python coupe à 10 s.
// Autrement dit : choisir une option par son texte affiché — le cas NORMAL,
// puisque c'est la seule chose que le modèle voit — échouait par construction.
//
// On lit donc la liste des options UNE fois (un evaluate, ~1 ms), on décide en
// JS, et on ne fait qu'un seul selectOption qui ne peut plus échouer.
// Ordre de correspondance : valeur exacte → libellé exact → libellé trimé →
// insensible à la casse → sous-chaîne. Renvoie l'option retenue, ou lève une
// erreur qui LISTE les libellés disponibles.
async function selectOptionSmart(locator, { option_value, option_label, value, text, timeout = 10000 }) {
    const opts = await locator.evaluate((el) => {
        if (!el.options) return null;
        return Array.from(el.options).map((o, i) => ({
            i, value: o.value, label: (o.text || '').trim(), disabled: !!o.disabled,
        }));
    }).catch(() => null);
    if (opts === null) {
        const tag = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => '?');
        const e = new Error(
            `select: <${tag}> is not a native <select>. For a custom dropdown ` +
            `(div/ul/role=listbox) use action="pick", which opens it and clicks the option.`);
        e.notASelect = true;
        throw e;
    }
    const pick = (pred) => opts.find(o => !o.disabled && pred(o));
    let hit = null;
    if (option_value) hit = pick(o => o.value === option_value);
    else if (option_label) {
        const w = String(option_label).trim();
        hit = pick(o => o.label === w)
           || pick(o => o.label.toLowerCase() === w.toLowerCase())
           || pick(o => o.label.toLowerCase().includes(w.toLowerCase()));
    }
    if (!hit) {
        const w = String(value || text || '').trim();
        if (w) {
            hit = pick(o => o.value === w)
               || pick(o => o.label === w)
               || pick(o => o.label.toLowerCase() === w.toLowerCase())
               || pick(o => o.value.toLowerCase() === w.toLowerCase())
               || pick(o => o.label.toLowerCase().includes(w.toLowerCase()));
        }
    }
    if (!hit) {
        const wanted = option_value || option_label || value || text || '(rien)';
        throw new Error(
            `No <option> matching "${wanted}". Available: ` +
            opts.slice(0, 12).map(o => `"${o.label}"(${o.value})`).join(', ') +
            (opts.length > 12 ? `, … ${opts.length - 12} more` : ''));
    }
    await locator.selectOption({ index: hit.i }, { timeout });
    return { value: hit.value, label: hit.label, index: hit.i };
}

// ── Dialogues natifs (alert / confirm / prompt) ───────────────────────
//
// Sans handler, Playwright BLOQUE la page au premier confirm() — d'où le
// « accepte tout » historique, posé à trois endroits différents. Mais
// « accepte toujours » veut dire : impossible de refuser un confirm,
// impossible de répondre à un prompt (mesuré : prompt() rendait ""). Le
// service avait bien /handle_next_dialog, mais il BLOQUE la réponse HTTP
// jusqu'à ce qu'un dialogue survienne — donc inutilisable depuis un agent,
// qui doit rendre la main pour déclencher l'action qui l'ouvre.
//
// On garde donc une politique ARMABLE, consommée N fois puis oubliée, et un
// journal du dernier dialogue vu. Défaut inchangé : accepter.
function makeDialogState() {
    return { pending: null, last: null, count: 0, history: [] };
}

// Ce que fait le navigateur quand rien n'est armé — DIT dans chaque status.
const DIALOG_DEFAULT_WHEN_UNARMED = 'accept';

function attachDialogHandler(page, dialogState) {
    page.on('dialog', async (dialog) => {
        const type = dialog.type();
        const message = dialog.message();
        let action = DIALOG_DEFAULT_WHEN_UNARMED;
        let input = '';
        const pol = dialogState.pending;
        const armed = !!(pol && (pol.sticky || pol.remaining > 0));
        if (armed) {
            action = pol.action === 'dismiss' ? 'dismiss' : 'accept';
            input = pol.input_text || '';
            if (!pol.sticky) {
                pol.remaining -= 1;
                if (pol.remaining <= 0) dialogState.pending = null;
            }
        }
        dialogState.count += 1;
        dialogState.last = { type, message, action, input_text: input, seq: dialogState.count,
                             policy: armed ? 'armed' : 'default' };
        dialogState.history = dialogState.history || [];
        dialogState.history.push(dialogState.last);
        if (dialogState.history.length > 20) dialogState.history.shift();
        console.log(`[DIALOG] ${type}: ${message} → ${action}${input ? ` ("${input}")` : ''}${armed ? '' : ' (default)'}`);
        try {
            if (action === 'dismiss') await dialog.dismiss();
            else if (type === 'prompt') await dialog.accept(input);
            else await dialog.accept();
        } catch (e) {}
    });
}

async function postActionWait(page, wait_after) {
    if (!wait_after) return;
    if (typeof wait_after === 'number') await page.waitForTimeout(wait_after);
    else if (wait_after === 'network') await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(6000)]);
    else if (typeof wait_after === 'string' && wait_after.startsWith('selector:')) {
        const sel = wait_after.replace('selector:', '');
        await page.waitForSelector(sel, { state: 'visible', timeout: 12000 }).catch(() => {});
    } else if (typeof wait_after === 'string' && wait_after.startsWith('text:')) {
        const txt = wait_after.replace('text:', '');
        await page.waitForFunction(t => document.body.textContent.includes(t), txt, { timeout: 12000 }).catch(() => {});
    }
}

// ==========================================
// ENDPOINTS
// ==========================================

// ======================== START ========================
// AUDIT 2026-06 — deux /start concurrents du MÊME owner passaient tous deux
// findLiveSessionByOwner(null) → double session (violation de « une instance
// par utilisateur »). Verrou par owner le temps du start. Map bornée par le
// nombre d'utilisateurs distincts (pas de fuite).
const ownerStartLocks = new Map();
// ── Journaux console + réseau d'une page ─────────────────────────────
// Audit tools web 2026-09-05 — le journal réseau ne retenait que xhr/fetch :
// la navigation elle-même (POST /authenticate → 303 → GET /secure) n'y était
// jamais, et rien ne distinguait l'appli des traqueurs tiers. On garde aussi
// les documents, on note l'hôte et le same-origin. Attaché à CHAQUE page
// (onglets compris) — avant, seule la première page de la session l'était.
const NET_TYPES = new Set(['document', 'xhr', 'fetch']);
function attachPageLoggers(page, consoleLogs, networkLog) {
    if (!page || page.__pwLoggersAttached || !consoleLogs || !networkLog) return;
    page.__pwLoggersAttached = true;
    page.on('console', msg => {
        if (['error', 'warning'].includes(msg.type())) {
            consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
            if (consoleLogs.length > 100) consoleLogs.shift();
        }
    });
    const pageHost = () => { try { return hostOf(page.url()); } catch (_) { return ''; } };
    const entry = (req, rtype) => {
        const url = req.url();
        const host = hostOf(url);
        let sameOrigin = host !== '' && host === pageHost();
        // Une navigation principale vers un autre hôte DEVIENT la page : c'est
        // du same-origin pour la suite (redirection d'auth, SSO).
        try { if (rtype === 'document' && req.isNavigationRequest() && req.frame() === page.mainFrame()) sameOrigin = true; } catch (_) {}
        return { url: url.substring(0, 300), type: rtype, host, same_origin: sameOrigin };
    };
    page.on('request', req => {
        const rtype = req.resourceType();
        if (!NET_TYPES.has(rtype)) return;
        networkLog.push({ ts: Date.now(), dir: 'REQ', method: req.method(), ...entry(req, rtype), postData: req.postData()?.substring(0, 500) || null });
        if (networkLog.length > 300) networkLog.shift();
    });
    page.on('response', resp => {
        const req = resp.request();
        const rtype = req.resourceType();
        if (!NET_TYPES.has(rtype)) return;
        networkLog.push({ ts: Date.now(), dir: 'RES', status: resp.status(), ...entry(req, rtype) });
        if (networkLog.length > 300) networkLog.shift();
    });
}

// ── Déplier / replier un nœud d'arbre ───────────────────────────────
// Un clic simple sur un treeitem GWT (CellTree) SÉLECTIONNE sans déplier :
// mesuré `click role=treeitem|name=Tables → success, expanded:false`. On
// essaie ce qu'un humain ferait, dans l'ordre, et on VÉRIFIE l'état après
// chaque geste : l'icône de bascule, le clavier (ArrowRight/ArrowLeft —
// CellTree comme tout arbre ARIA), le double-clic, le clic.
async function readExpanded(locator) {
    return locator.evaluate(el => {
        const a = el.getAttribute('aria-expanded');
        if (a !== null) return a === 'true';
        const cls = typeof el.className === 'string' ? el.className : '';
        if (/(^|\s)[\w-]*(open|expanded)[\w-]*(\s|$)/i.test(cls)) return true;
        if (/(^|\s)[\w-]*(closed|collapsed)[\w-]*(\s|$)/i.test(cls)) return false;
        return null;
    }).catch(() => null);
}
async function expandTreeItem(page, locator, wantOpen, timeout) {
    const before = await readExpanded(locator);
    if (before === wantOpen) return { expanded_before: before, expanded: before, method: 'noop', attempts: [] };
    const t = Math.min(timeout || 5000, 5000);
    const gestures = [
        ['toggle', async () => {
            const tg = locator.locator('img, svg, [class*="Image"], [class*="image"], [class*="toggle"], [class*="Toggle"], [class*="caret"], [class*="expand"], [class*="arrow"], [class*="twist"]').first();
            if ((await tg.count().catch(() => 0)) === 0) throw new Error('no toggle child');
            await tg.click({ timeout: t });
        }],
        ['keyboard', async () => {
            await locator.focus({ timeout: t }).catch(() => locator.click({ timeout: t }));
            await page.keyboard.press(wantOpen ? 'ArrowRight' : 'ArrowLeft');
        }],
        ['dblclick', async () => locator.dblclick({ timeout: t })],
        ['click', async () => locator.click({ timeout: t })],
    ];
    const attempts = [];
    for (const [via, fn] of gestures) {
        try { await fn(); } catch (e) { attempts.push({ via, ok: false, error: String(e.message || e).slice(0, 80) }); continue; }
        await page.waitForTimeout(250);
        const now = await readExpanded(locator);
        attempts.push({ via, ok: now === wantOpen });
        if (now === wantOpen) return { expanded_before: before, expanded: now, method: via, attempts };
    }
    return { expanded_before: before, expanded: await readExpanded(locator), method: null, attempts,
             warning: 'state did not change — check with pw_page(action="inspect"), or navigate directly (goto …#!Page)' };
}

// ── Glisser-déposer ──────────────────────────────────────────────────
// dragTo (pointeur) d'abord ; s'il lève, événements HTML5 synthétiques avec
// un DataTransfer partagé (pages qui écoutent dragstart/drop sans suivre la
// souris). Sans destination : décalage en pixels.
async function html5DragDrop(srcLoc, dstLoc) {
    const dstHandle = await dstLoc.elementHandle({ timeout: 2000 }).catch(() => null);
    if (!dstHandle) return false;
    return srcLoc.evaluate((src, dst) => {
        const dt = new DataTransfer();
        const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
        fire(src, 'dragstart'); fire(dst, 'dragenter'); fire(dst, 'dragover'); fire(dst, 'drop'); fire(src, 'dragend');
        return true;
    }, dstHandle).catch(() => false);
}
async function performDrag(page, srcLoc, body, timeout) {
    const { to, target_selector, dx, dy, direction, amount, human = false } = body || {};
    let dstLoc = null, dstVia = null;
    if (to && typeof to === 'object' && Object.values(to).some(v => v !== undefined && v !== null && v !== '')) {
        dstLoc = locatorFromParams(page, to, null); dstVia = 'official';
    }
    if (!dstLoc && target_selector) {
        const r = await smartResolveLocator(page, target_selector).catch(() => null);
        if (r && r.locator) { dstLoc = r.locator; dstVia = `smart:${r.strategy || 'selector'}`; }
    }
    if (dstLoc) {
        const sb = await srcLoc.boundingBox().catch(() => null);
        const db = await dstLoc.boundingBox().catch(() => null);
        if (human && sb && db) {
            await humanMouseMove(page, 960, 540, sb.x + sb.width / 2, sb.y + sb.height / 2);
            await page.mouse.down();
            await humanMouseMove(page, sb.x + sb.width / 2, sb.y + sb.height / 2, db.x + db.width / 2, db.y + db.height / 2);
            await page.mouse.up();
            return { method: 'human-drag', destination: dstVia };
        }
        let dragErr = null;
        try { await srcLoc.dragTo(dstLoc, { timeout }); }
        catch (e) { dragErr = String(e.message || e).slice(0, 120); }
        if (!dragErr) return { method: 'dragTo', destination: dstVia };
        if (await html5DragDrop(srcLoc, dstLoc)) return { method: 'html5-events', destination: dstVia, dragto_error: dragErr };
        throw new Error(`drag failed: ${dragErr}`);
    }
    let ddx = dx, ddy = dy;
    const noXY = (ddx === undefined || ddx === null) && (ddy === undefined || ddy === null);
    if (noXY && (direction || amount !== undefined)) {
        const amt = amount === undefined ? 100 : Number(amount);
        const map = { down: [0, amt], up: [0, -amt], right: [amt, 0], left: [-amt, 0] };
        [ddx, ddy] = map[direction || 'right'] || [amt, 0];
    }
    if ((ddx === undefined || ddx === null) && (ddy === undefined || ddy === null))
        throw new Error('drag needs a destination (to=/target_selector=) or an offset (direction=/amount=, dx/dy)');
    const box = await srcLoc.boundingBox();
    if (!box) throw new Error('drag source has no bounding box (hidden?)');
    const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy); await page.mouse.down();
    await page.mouse.move(cx + (ddx || 0), cy + (ddy || 0), { steps: 15 }); await page.mouse.up();
    return { method: 'offset', dx: ddx || 0, dy: ddy || 0 };
}

function _ownerStartLock(owner) {
    if (!ownerStartLocks.has(owner)) ownerStartLocks.set(owner, makeLock());
    return ownerStartLocks.get(owner);
}

app.post('/start', async (req, res) => {
    let _startRelease = null;
    try {
        const { url, username, password, headless, load_state_id, record_har = false,
                device, viewport, locale, timezone, color_scheme, touch,
                isolated = false, trace = false, record_video = false } = req.body;
        // Propriétaire obligatoire (2026-09-30) : c'est lui qui borne l'accès
        // à la session, à ses états sauvegardés et à ses téléchargements.
        const owner = safeOwner(req.body.owner);
        if (!owner) return res.status(400).json({ error: 'owner requis.' });
        if (url) {
            const motif = await refusUrl(url);
            if (motif) return repondreRefus(res, url, motif);
        }

        if (PW_MUTEX && owner && !isolated) {
            try {
                _startRelease = await acquireLock(_ownerStartLock(owner), { waitMs: LOCK_WAIT_MS });
            } catch (e) {
                return res.status(e.code === 429 ? 429 : 423)
                          .json({ error: 'Un démarrage de session est déjà en cours pour cet utilisateur — réessaie.', retryable: true });
            }
        }

        // ── Une instance par utilisateur ────────────────────────────
        // Si cet `owner` a déjà une session vivante, on la réutilise au
        // lieu d'ouvrir un second contexte. L'URL demandée (le cas
        // échéant) s'ouvre dans un NOUVEL ONGLET de l'instance existante :
        // rien en cours n'est perdu, et l'utilisateur accumule des
        // onglets entre lesquels il peut basculer (switch_tab).
        if (owner && !isolated) {   // isolated=true → contexte neuf, pas de réutilisation (isolation des tests)
            const existing = await findLiveSessionByOwner(owner);
            if (existing) {
                const [existingSid, s] = existing;
                // AUDIT 2026-06 — la mutation tabs/page se fait SOUS le mutex
                // de la session réutilisée (une op en vol sur cette page ne
                // doit pas voir s.page changer sous ses pieds).
                let _reuseRelease = null;
                if (PW_MUTEX && s._lock) {
                    try {
                        _reuseRelease = await acquireLock(s._lock, { waitMs: LOCK_WAIT_MS, maxWaiters: LOCK_MAX_W });
                    } catch (e) {
                        return res.status(423).json({ error: 'Session occupée — réessaie.', retryable: true });
                    }
                }
                try {
                    s.lastActivity = Date.now();
                    let tabIndex = s.tabs.indexOf(s.page);
                    if (url) {
                        const reusePage = await s.context.newPage();
                        attachDialogHandler(reusePage, s.dialogState || (s.dialogState = makeDialogState()));
                        attachPageLoggers(reusePage, s.consoleLogs, s.networkLog);
                        try {
                            await reusePage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
                            await Promise.race([reusePage.waitForLoadState('networkidle').catch(() => {}), reusePage.waitForTimeout(3000)]);
                        } catch (e) { console.log('Nav warning (reuse):', e.message); }
                        s.tabs.push(reusePage);
                        s.page = reusePage;
                        tabIndex = s.tabs.length - 1;
                        await reusePage.bringToFront().catch(() => {});
                    }
                    console.log(`[START] Réutilisation session ${existingSid.substring(0, 8)}… (owner=${owner}, tabs=${s.tabs.length})`);
                    return res.json({
                        status: 'reused',
                        reused: true,
                        session_id: existingSid,
                        tab_index: tabIndex,
                        total_tabs: s.tabs.length,
                        url: s.page.url(),
                        title: await s.page.title().catch(() => ''),
                        note: 'Instance unique par utilisateur : session existante réutilisée'
                            + (url ? ', URL ouverte dans un nouvel onglet (utilisez switch_tab pour basculer).' : '.'),
                    });
                } finally {
                    if (_reuseRelease) _reuseRelease();
                }
            }
        }

        const browser = await ensureBrowser(headless);
        const sessionId = uuidv4();

        // État sauvegardé : seulement ceux du même propriétaire.
        let storageState = undefined;
        if (load_state_id) {
            const nom = stateFileName(owner, load_state_id);
            const p = nom ? path.join(COOKIES_DIR, nom) : null;
            if (!p || !fs.existsSync(p)) {
                return res.status(404).json({ error: 'État sauvegardé introuvable (load_state_id).' });
            }
            storageState = p;
        }

        // ── Émulation device/viewport (V13) ─────────────────────────────
        // device = preset Playwright ("iPhone 13", "Pixel 7", "iPad Mini"…) qui
        // fixe viewport + UA + deviceScaleFactor + touch + isMobile. Les options
        // explicites (viewport/locale/timezone/color_scheme/touch) surchargent.
        const preset = (device && devices[device]) ? devices[device] : {};
        const contextOpts = {
            ...preset,
            userAgent: preset.userAgent || USER_AGENT,
            viewport: viewport || preset.viewport || { width: 1920, height: 1080 },
            locale: locale || 'fr-FR',
            timezoneId: timezone || 'Europe/Paris',
            colorScheme: color_scheme || undefined,   // 'light' | 'dark' | 'no-preference'
            ignoreHTTPSErrors: true,
            acceptDownloads: true,
            storageState,
            httpCredentials: (username && password) ? { username, password } : undefined,
            permissions: ['geolocation'],
            bypassCSP: true,
            // Les requêtes d'un service worker échapperaient à la garde
            // (context.route ne les voit pas).
            serviceWorkers: 'block',
        };
        if (typeof touch === 'boolean') contextOpts.hasTouch = touch;
        // isMobile/hasTouch ne sont supportés que sur Chromium → on les retire
        // pour firefox/webkit (sinon Playwright lève une exception au newContext).
        if (BROWSER_ENGINE !== 'chromium') { delete contextOpts.isMobile; delete contextOpts.hasTouch; }
        delete contextOpts.defaultBrowserType;  // clé du preset non valide pour newContext

        if (record_har) contextOpts.recordHar = { path: path.join(HAR_DIR, `har_${sessionId}.har`), mode: 'minimal' };

        if (record_video) contextOpts.recordVideo = { dir: VIDEO_DIR };  // vidéo finalisée à la fermeture du contexte (Phase 5)

        const context = await browser.newContext(contextOpts);
        await installerGarde(context);

        // Trace Playwright (Phase 5) : screenshots + snapshots DOM + sources,
        // exportable en .zip ouvrable avec `npx playwright show-trace`.
        let _traceActive = false;
        if (trace) {
            try { await context.tracing.start({ screenshots: true, snapshots: true, sources: true }); _traceActive = true; }
            catch (e) { console.warn('[trace] start KO:', e.message); }
        }

        await context.addInitScript(() => {
            Object.defineProperty(Object.getPrototypeOf(navigator), 'webdriver', { get: () => undefined });
            if (window.chrome) window.chrome.runtime = undefined;
            // Expose clipboard API si manquant
            if (!navigator.clipboard) {
                navigator.clipboard = { readText: () => Promise.resolve(''), writeText: () => Promise.resolve() };
            }
        });

        // Téléchargements rangés par propriétaire, pour TOUS les onglets.
        const dossierTelechargements = path.join(DOWNLOAD_DIR, owner);
        context.on('page', (pg) => pg.on('download', async download => {
            try {
                fs.mkdirSync(dossierTelechargements, { recursive: true });
                await download.saveAs(path.join(dossierTelechargements, safeDownloadName(download.suggestedFilename())));
            } catch (e) {}
        }));
        const page = await context.newPage();

        const dialogState = makeDialogState();
        attachDialogHandler(page, dialogState);

        const consoleLogs = [];
        const networkLog = [];
        attachPageLoggers(page, consoleLogs, networkLog);

        const now = Date.now();
        // Enforce max sessions — close oldest if at limit
        if (sessions.size >= MAX_SESSIONS) {
            let oldestSid = null, oldestTime = Infinity;
            for (const [sid, s] of sessions) {
                if ((s.lastActivity || s.createdAt || now) < oldestTime) {
                    oldestTime = s.lastActivity || s.createdAt || now;
                    oldestSid = sid;
                }
            }
            if (oldestSid) await closeSession(oldestSid, 'max_sessions');
        }

        sessions.set(sessionId, { context, page, owner, consoleLogs, networkLog, downloads: [], tabs: [page], mousePos: { x: 960, y: 540 }, createdAt: now, lastActivity: now, traceActive: _traceActive, _lock: makeLock(), dialogState });

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(3000)]);
        } catch (e) { console.log("Nav warning:", e.message); }

        // Auto-dismiss popups after page load (cookies, newsletters, chat widgets)
        await page.waitForTimeout(800);
        await safeRemoveOverlays(page, false);

        res.json({ status: 'started', session_id: sessionId, url: page.url(), title: await page.title().catch(() => '') });
    } catch (e) { res.status(500).json({ error: e.message }); }
    finally { if (_startRelease) _startRelease(); }
});


// ======================== SMART CLICK (endpoint dédié) ========================
app.post('/smart_click', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector, human = false, button = 'left', modifiers = [], wait_after = null, timeout = 8000 } = req.body;
        const result = await smartClick(page, selector, { human, button, modifiers, timeout });
        await postActionWait(page, wait_after);
        res.json({ status: 'success', ...result });
    } catch (e) {
        // Feature 3: Smart retry — find alternatives
        const alternatives = await findAlternatives(req.session.page, req.body.selector).catch(() => []);
        // Feature 4: Screenshot on failure
        const ss = await screenshotOnFailure(req.session.page, req.sessionId, 'smart_click');
        res.status(500).json({
            error: e.message,
            selector: req.body.selector,
            alternatives,
            hint: alternatives.length > 0
                ? `${alternatives.length} similar element(s) found. Try: ${alternatives.map(a => a.selector || a.text).join(', ')}`
                : 'No similar elements found. Try pw_inspect to see the page structure.',
            ...ss,
        });
    }
});


// ======================== ACTIONS ========================
app.post('/action', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const {
            type: rawType, selector: rawSelector, text, key, filePath, url: targetUrl,
            relative_to, position, timeout = 10000,
            force = false, modifiers = [], button = 'left',
            option_value, option_label, dx, dy, delay,
            target_selector, human = false, wait_after = null,
            // Nouveau : API Playwright officielle
            ref, by_role, by_name, by_text, by_label, by_placeholder,
            by_test_id, by_alt, by_title, by_css, by_xpath,
            value, files,
            direction, amount,
        } = req.body;
        // Le chemin « locator officiel » et le chemin « selector » n'ont jamais
        // parlé le même dialecte : le premier accepte double_click/rclick/
        // scroll_into_view, le second ne connaît que dblclick/right_click/
        // scroll. Tant que le repli n'existait pas, ça ne se voyait pas. Une
        // seule table d'alias, appliquée en entrée.
        const _TYPE_ALIASES = {
            double_click: 'dblclick', rclick: 'right_click',
            select_option: 'select', scroll_to: 'scroll_into_view',
        };
        const type = _TYPE_ALIASES[rawType] || rawType;
        const opts = { timeout, button, modifiers };
        let selectedOption = null;
        let officialError = null;   // renseigné quand on retombe sur smartResolve
        let extra = {};             // champs additionnels du résultat (expanded, drag…)
        const _t0 = Date.now();

        // NAVIGATION
        if (type === 'goto') {
            // BUG FIX (Playwright 500 sur http://IP:port) : on ne laisse plus
            // l'exception de goto remonter au catch externe (500 opaque). On la
            // capture et on classe le résultat (cf. nav_util.classifyNavOutcome) :
            // succès, succès partiel (page atteinte malgré un timeout de
            // load-state), ou erreur de navigation propre (502).
            const _motif = await refusUrl(targetUrl);
            if (_motif) return repondreRefus(res, targetUrl, _motif);
            const prevUrl = page.url();
            let navError = null, gotoResp = null;
            try {
                gotoResp = await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
            } catch (e) { navError = e.message; }
            // ROBUSTESSE : après un goto en ERREUR (ex. timeout sur IP black-hole
            // non-routable), la frame reste « loading » et les opérations qui
            // font page.evaluate (safeRemoveOverlays) ou attendent le réseau
            // BLOQUENT jusqu'à l'abandon TCP de l'OS (~minutes). On saute donc
            // ces étapes quand navError, et on lit page.url() de façon défensive.
            if (!navError) {
                await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(3000)]);
                await safeRemoveOverlays(page, false);
            }
            recordEvent(req.session, { action: 'goto', url: targetUrl });
            let landed; try { landed = page.url(); } catch (_) { landed = prevUrl; }
            const outcome = classifyNavOutcome(targetUrl, prevUrl, landed, navError);
            // GUIDAGE MODÈLE : si la page répond 401/407, elle est protégée par
            // auth HTTP. On joint un hint expliquant que username/password se
            // passent au pw_session(start) (httpCredentials), pas au goto.
            let httpStatus = null;
            try { httpStatus = gotoResp ? gotoResp.status() : null; } catch (_) {}
            const hint = authHint(httpStatus);
            if (hint) { outcome.body.http_status = httpStatus; outcome.body.auth_hint = hint; }
            return res.status(outcome.httpStatus).json(outcome.body);
        }
        if (type === 'back') { await page.goBack({ waitUntil: 'domcontentloaded' }).catch(() => {}); return res.json({ status: 'success', url: page.url() }); }
        if (type === 'forward') { await page.goForward({ waitUntil: 'domcontentloaded' }).catch(() => {}); return res.json({ status: 'success', url: page.url() }); }
        if (type === 'reload') { await page.reload({ waitUntil: 'domcontentloaded' }); return res.json({ status: 'success' }); }

        // ── Résolution prioritaire : ref ou by_* (API officielle) ──
        // Si on a un ref ou des params by_*, on utilise un Locator officiel
        // au lieu de passer par smartClick (qui parse une chaîne CSS ambiguë).
        // → Fiabilité maximale, mappe direct sur l'API Playwright.
        let officialLocator = null;
        if (ref) {
            // Format ref : "loc_xxx" ou "loc_xxx#N" (index)
            const [baseRef, idxStr] = String(ref).split('#');
            officialLocator = resolveRef(baseRef, page, req.sessionId);
            if (officialLocator && idxStr !== undefined) {
                officialLocator = officialLocator.nth(parseInt(idxStr, 10));
            }
            if (!officialLocator) {
                return res.status(404).json({ error: `Ref expired or invalid: ${ref}. Re-call pw_find.` });
            }
        } else if (by_role || by_text || by_label || by_placeholder || by_test_id || by_alt || by_title || by_css || by_xpath) {
            officialLocator = resolveOfficialLocator(page, {
                by_role, by_name, by_text, by_label, by_placeholder,
                by_test_id, by_alt, by_title, by_css, by_xpath,
            });
            if (officialLocator) officialLocator = officialLocator.first();
        }

        // ── Actions page-level (sans cible) ──
        // press, type sans cible → utilise page.keyboard (focus actuel)
        if (!officialLocator && !rawSelector) {
            // DÉFILEMENT DE PAGE. `scroll_into_view` sans cible n'était traité
            // NULLE PART : la requête traversait tout le handler pour finir en
            // 400 « Type d'action inconnu ». Il n'existait donc aucun moyen de
            // faire défiler la page — bloquant sur toute liste virtualisée ou
            // à défilement infini (audit 2026-08-08).
            if (type === 'scroll' || type === 'scroll_into_view') {
                const dir = direction || 'down';
                const amt = amount === undefined ? 500 : amount;
                const map = { down: [0, amt], up: [0, -amt], right: [amt, 0], left: [-amt, 0] };
                const [dxs, dys] = map[dir] || [0, amt];
                // window.scrollBy, PAS mouse.wheel : la molette fait défiler ce
                // qui se trouve SOUS LE CURSEUR. Si la souris est restée sur un
                // panneau à ascenseur après un clic, un « défile la page »
                // faisait défiler ce panneau — non déterministe, et invisible
                // dans le résultat (constaté en repassant les outils en direct).
                // Le mode `human` garde la molette : c'est son intérêt.
                if (human) await page.mouse.wheel(dxs, dys);
                else await page.evaluate(([x, y]) => window.scrollBy(x, y), [dxs, dys]);
                await postActionWait(page, wait_after);
                const pos = await page.evaluate(() => ({
                    y: Math.round(window.scrollY), x: Math.round(window.scrollX),
                    max_y: Math.round(Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight)),
                })).catch(() => null);
                // Audit tools web 2026-09-05 — sur une appli GWT/desktop-like la
                // PAGE ne défile pas (max_y:0) : tout se passe dans un
                // ScrollPanel. Mesuré `scroll page down 800 → y:0 max_y:0` avec
                // deux panneaux internes défilables. On défile alors le plus
                // grand conteneur défilable visible, et on le NOMME.
                let container = null;
                if (!human && pos && pos.max_y === 0) {
                    container = await page.evaluate(([x, y]) => {
                        const GEN_ID = /^(gwt-uid-|ext-gen|ext-comp-|x-auto-|yui_|:r|ember\d)/i;
                        const stableId = (el) => el.id && !/^\d/.test(el.id) && !GEN_ID.test(el.id) && el.id.length < 60;
                        const sel = (el) => {
                            if (stableId(el)) return `#${el.id}`;
                            // Chemin positionnel ancré (premier id stable ou body) —
                            // la MÊME chaîne que `scrollables` dans inspect, pour que
                            // le modèle retrouve son panneau d'un appel à l'autre.
                            const parts = []; let cur = el, d = 0;
                            while (cur && cur.nodeType === 1 && cur.tagName !== 'HTML' && d < 40) {
                                const tag = cur.tagName.toLowerCase();
                                if (stableId(cur)) { parts.unshift(`#${cur.id}`); break; }
                                if (tag === 'body') { parts.unshift('body'); break; }
                                const par = cur.parentElement;
                                if (!par) { parts.unshift(tag); break; }
                                parts.unshift(`${tag}:nth-child(${Array.from(par.children).indexOf(cur) + 1})`);
                                cur = par; d++;
                            }
                            return parts.join(' > ');
                        };
                        const cands = [];
                        for (const el of document.querySelectorAll('div, section, main, article, ul, ol, table, tbody, aside, form')) {
                            let cs; try { cs = getComputedStyle(el); } catch (e) { continue; }
                            if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 2) continue;
                            if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') continue;
                            const r = el.getBoundingClientRect();
                            if (r.width < 40 || r.height < 40 || r.bottom < 0 || r.top > innerHeight) continue;
                            cands.push({ el, area: r.width * r.height });
                        }
                        if (!cands.length) return null;
                        cands.sort((a, b) => b.area - a.area);
                        const el = cands[0].el, before = Math.round(el.scrollTop);
                        el.scrollBy(x, y);
                        return { selector: sel(el), before, top: Math.round(el.scrollTop),
                                 max: Math.round(el.scrollHeight - el.clientHeight), candidates: cands.length };
                    }, [dxs, dys]).catch(() => null);
                }
                return res.json({
                    status: 'success', strategy: container ? 'container-scroll' : 'page-scroll',
                    direction: dir, amount: amt, scroll: pos,
                    ...(container ? { container, note: `page not scrollable — scrolled the largest scrollable panel (${container.selector}); target it explicitly next time: target="css=${container.selector}"` } : {}),
                });
            }
            if (type === 'press' && key) {
                await page.keyboard.press(key);
                await postActionWait(page, wait_after);
                return res.json({ status: 'success', strategy: 'keyboard' });
            }
            if (type === 'type' && (text || value)) {
                await page.keyboard.type(text || value, { delay: delay || 30 });
                await postActionWait(page, wait_after);
                return res.json({ status: 'success', strategy: 'keyboard' });
            }
        }

        // Si on a un Locator officiel, on l'utilise directement sur l'action
        if (officialLocator) {
            // Quand un `selector` de repli est joint, l'essai officiel doit
            // ÉCHOUER VITE : sinon il consomme les 10 s de budget, le client
            // Python coupe, et le repli — qui aurait trouvé — ne s'exécute
            // jamais. Mesuré sur un champ dans une <iframe> : timeout côté
            // outil alors que smartResolveLocator le résout (audit 2026-08-08).
            const officialTimeout = rawSelector
                ? Math.min(timeout, OFFICIAL_TRY_MS)
                : timeout;
            const _t = officialTimeout;
            try {
                if (type === 'click') {
                    await officialLocator.click({ timeout: _t, button, modifiers, force });
                    // Un treeitem / disclosure dit s'il s'est ouvert : sans ça un
                    // clic « réussi » qui n'a fait que SÉLECTIONNER passait pour
                    // un dépliage (audit tools web 2026-09-05).
                    const _ae = await officialLocator.getAttribute('aria-expanded', { timeout: 500 }).catch(() => null);
                    if (_ae !== null && _ae !== undefined) extra.expanded = _ae === 'true';
                } else if (type === 'double_click' || type === 'dblclick') {
                    await officialLocator.dblclick({ timeout: _t, button, modifiers });
                } else if (type === 'right_click' || type === 'rclick') {
                    await officialLocator.click({ timeout: _t, button: 'right', modifiers });
                } else if (type === 'hover') {
                    await officialLocator.hover({ timeout: _t, modifiers });
                } else if (type === 'check') {
                    await officialLocator.check({ timeout: _t, force });
                } else if (type === 'uncheck') {
                    await officialLocator.uncheck({ timeout: _t, force });
                } else if (type === 'focus') {
                    await officialLocator.focus({ timeout: _t });
                } else if ((type === 'scroll_into_view' || type === 'scroll') && (direction || amount !== undefined)) {
                    // Cible + direction = défiler DANS ce conteneur (liste
                    // virtualisée, panneau à ascenseur), pas l'amener à l'écran.
                    await officialLocator.evaluate((el, { direction, amount }) => {
                        const map = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
                        const [x, y] = map[direction || 'down'] || [0, amount];
                        el.scrollBy(x, y);
                    }, { direction, amount: amount === undefined ? 500 : amount });
                } else if (type === 'scroll_into_view' || type === 'scroll') {
                    await officialLocator.scrollIntoViewIfNeeded({ timeout: _t });
                } else if (type === 'fill') {
                    await officialLocator.fill(text || value || '', { timeout: _t, force });
                } else if (type === 'type') {
                    await officialLocator.click({ timeout: _t }).catch(() => {});
                    await officialLocator.fill(''); // clear first
                    await officialLocator.type(text || value || '', { delay: delay || 30, timeout: _t });
                } else if (type === 'clear') {
                    await officialLocator.fill('', { timeout: _t, force });
                } else if (type === 'press') {
                    await officialLocator.press(key, { timeout: _t });
                } else if (type === 'select_option' || type === 'select') {
                    if (!option_value && !option_label && !value && !text)
                        throw new Error('select requires option_value=, option_label=, value= or text=');
                    selectedOption = await selectOptionSmart(officialLocator, {
                        option_value, option_label, value, text, timeout: _t });
                } else if (type === 'upload') {
                    await officialLocator.setInputFiles(files || filePath, { timeout: _t });
                } else if (type === 'expand' || type === 'collapse') {
                    extra = { ...extra, ...(await expandTreeItem(page, officialLocator, type === 'expand', _t)) };
                } else if (type === 'drag') {
                    extra = { ...extra, ...(await performDrag(page, officialLocator, req.body, _t)) };
                } else {
                    return res.status(400).json({ error: `Action '${type}' incompatible avec API Playwright officielle. Utilise selector= au lieu de by_*/ref.` });
                }
                await postActionWait(page, wait_after);
                // AX Memory : capture la chaine d'ancetres du locator
                // pour construire la hierarchie DOM multi-niveaux cote Python
                const ancestors = await captureAncestors(officialLocator).catch(() => []);
                // Recorder hook (no-op when not recording)
                recordEvent(req.session, {
                    action: type === 'select_option' ? 'select' : (type === 'double_click' ? 'dblclick' : type === 'right_click' ? 'rclick' : type),
                    locator: { role: by_role, name: by_name, text: by_text, label: by_label, placeholder: by_placeholder, test_id: by_test_id, css: by_css, xpath: by_xpath, alt: by_alt, title: by_title },
                    value: text || value, key,
                    // L'option RÉELLEMENT choisie — le rejeu n'écrit plus
                    // selectOption('') (audit tools web 2026-09-05).
                    ...(selectedOption ? { value: selectedOption.value, option_label: selectedOption.label, selected: selectedOption } : {}),
                    url: page.url(), ref,
                });
                return res.json({
                    status: 'success',
                    strategy: ref ? 'ref' : 'by_official',
                    // Ce que le service a RÉELLEMENT résolu, et par quel chemin :
                    // un succès par repli n'est plus indiscernable d'un succès
                    // direct (audit tools web 2026-09-05).
                    resolved_selector: describeLocator(ref ? { ref } : { by_role, by_name, by_text, by_label, by_placeholder, by_test_id, by_alt, by_title, by_css, by_xpath }, { first: true }),
                    attempts: [{ via: ref ? 'ref' : 'official', ok: true, ms: Date.now() - _t0 }],
                    url: page.url(),
                    ...(selectedOption ? { selected: selectedOption } : {}),
                    ...extra,
                    ancestors: ancestors,
                });
            } catch (e) {
                // ── REPLI sur l'échelle « smart » ──────────────────────────
                // Un locator officiel qui échoue renvoyait un 500 sec. Or
                // l'échelle smartResolveLocator sait faire ce que l'API
                // officielle ne fait pas : remonter du texte vers l'ancêtre
                // porteur du handler (applis GWT/GXT en <div>), chercher DANS
                // les iframes, retomber sur aria-label/placeholder/title. Elle
                // était morte depuis la couche outil, qui n'envoie que des
                // by_* (audit 2026-08-08). On l'utilise maintenant comme
                // second souffle quand — et seulement quand — l'appelant a
                // joint un `selector` de repli.
                //
                // `notASelect` est une erreur de DIAGNOSTIC (« ce n'est pas un
                // <select>, utilise pick ») : la répéter via l'autre chemin ne
                // ferait que la rendre plus confuse.
                if (rawSelector && !e.notASelect) {
                    console.log(`[action] official KO (${e.message.slice(0, 80)}) → repli smartResolve sur ${rawSelector}`);
                    officialLocator = null;
                    officialError = e.message;
                } else {
                    const ss = await screenshotOnFailure(page, req.sessionId, type).catch(() => null);
                    return res.status(500).json({ error: e.message, screenshot: ss });
                }
            }
        }

        // ── Sinon, fallback sur le code existant (selector= chaîne) ──
        const selector = rawSelector;
        // Quand on arrive ici APRÈS l'échec d'un locator officiel, on le dit :
        // sans ça, un succès par repli est indiscernable d'un succès direct et
        // personne ne voit que la cible demandée était mauvaise.
        const _fb = officialError
            ? { fallback_after: officialError.slice(0, 200),
                attempts: [{ via: 'official', ok: false, error: officialError.slice(0, 120) }] }
            : {};
        // Chaque réponse de repli complète la liste des tentatives : la dernière
        // est celle qui a atterri (via = stratégie smartResolve).
        const _landed = (via) => ({
            ..._fb,
            attempts: [...(_fb.attempts || []), { via: `smart:${via || 'selector'}`, ok: true, ms: Date.now() - _t0 }],
            resolved_selector: describeLocator({ selector }, { first: true }),
        });
        // Budget du repli : l'essai officiel a déjà consommé jusqu'à
        // OFFICIAL_TRY_MS. Sans plafond ici, une cible RÉELLEMENT absente
        // dépassait le budget du client, qui rendait « Timeout (10s) » à la
        // place de l'erreur serveur — laquelle liste les éléments proches.
        const _lt = officialError ? Math.min(timeout, 5000) : timeout;

        // AMENER À L'ÉCRAN (cible + pas de direction)
        if (type === 'scroll_into_view') {
            const { locator } = await smartResolveLocator(page, selector);
            await scrollIntoViewIfNeeded(locator);
            await postActionWait(page, wait_after);
            return res.json({ status: 'success', strategy: 'scroll_into_view', ..._landed('scroll_into_view') });
        }

        // CLIC SMART (via smartClick)
        if (type === 'click') {
            const result = await smartClick(page, selector, { timeout: _lt, button, modifiers, human, force });
            await postActionWait(page, wait_after);
            // AX Memory : essai de capture des ancetres (best-effort)
            let ancestors = [];
            try {
                const loc = page.locator(selector).first();
                ancestors = await captureAncestors(loc).catch(() => []);
            } catch (e) { ancestors = []; }
            recordEvent(req.session, { action: 'click', selector, url: page.url() });
            return res.json({
                status: 'success', ...result,
                url: page.url(), ancestors, ..._landed(result && result.strategy),
            });
        }

        // CLIC RELATIF
        if (type === 'click_relative') {
            const layoutSelector = `${selector}:${position}(${relative_to})`;
            const result = await smartClick(page, layoutSelector, { timeout: _lt, button, modifiers, human });
            await postActionWait(page, wait_after);
            return res.json({ status: 'success', ...result });
        }

        // CLIC COORDONNÉES
        if (type === 'click_coords') {
            const { x, y } = req.body;
            if (human) await humanClick(page, x, y);
            else await page.mouse.click(x, y, { button });
            await postActionWait(page, wait_after);
            return res.json({ status: 'success' });
        }

        // DOUBLE-CLIC
        if (type === 'dblclick') {
            const { locator } = await smartResolveLocator(page, selector);
            await scrollIntoViewIfNeeded(locator);
            await locator.dblclick({ timeout: _lt, force });
            await postActionWait(page, wait_after);
            return res.json({ status: 'success' });
        }

        // CLIC DROIT
        if (type === 'right_click') {
            const { locator } = await smartResolveLocator(page, selector);
            await scrollIntoViewIfNeeded(locator);
            await locator.click({ timeout: _lt, button: 'right', force });
            await postActionWait(page, wait_after);
            return res.json({ status: 'success' });
        }

        // HOVER
        if (type === 'hover') {
            const { locator } = await smartResolveLocator(page, selector);
            if (human) {
                const box = await locator.boundingBox().catch(() => null);
                if (box) { await humanMouseMove(page, 960, 540, box.x + box.width / 2, box.y + box.height / 2); }
                else await locator.hover({ timeout: _lt, force });
            } else {
                await scrollIntoViewIfNeeded(locator);
                await locator.hover({ timeout: _lt, force });
            }
            await postActionWait(page, wait_after);
            return res.json({ status: 'success' });
        }

        // FILL — gère input natif, contentEditable, React/Vue/Angular
        if (type === 'fill') {
            let resolved = await smartResolveLocator(page, selector);
            let loc = resolved.locator;
            let fillMethod = '';

            // ── Smart label→input resolution ──
            // If the resolved element is a label/span/div (not an input),
            // try to find the associated form input
            const inputResolved = await resolveFormInput(page, loc, selector);
            if (inputResolved) {
                loc = inputResolved.locator;
                fillMethod = `via-${inputResolved.method}→`;
            }

            const errors = [];

            // Tentative 1 : vérifier si contentEditable
            let isCE = false;
            try {
                const info = await loc.evaluate(el => ({
                    tag: el.tagName.toLowerCase(),
                    isCE: el.contentEditable === 'true' || el.isContentEditable,
                    isInput: ['input', 'textarea'].includes(el.tagName.toLowerCase()),
                }));
                isCE = info.isCE;

                if (isCE) {
                    await loc.click({ timeout: 3000 }).catch(() => {});
                    await loc.evaluate((el, val) => {
                        el.focus();
                        el.innerHTML = '';
                        el.textContent = val;
                        ['input', 'change', 'blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
                    }, text);
                } else {
                    // Tentative fill Playwright
                    await scrollIntoViewIfNeeded(loc);
                    await loc.fill('', { timeout: 3000 }).catch(() => {});
                    await loc.fill(text, { timeout: _lt, force: true });
                    await loc.evaluate(el => {
                        ['input', 'change', 'blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
                    }).catch(() => {});
                }
                await postActionWait(page, wait_after);
                recordEvent(req.session, { action: 'fill', selector, value: text, url: page.url() });
                return res.json({ status: 'success', method: `${fillMethod}${isCE ? 'contenteditable' : 'fill'}` });
            } catch (e) { errors.push(`fill: ${e.message.substring(0, 80)}`); }

            // Tentative 2 : Sélectionner tout + type
            try {
                await loc.click({ clickCount: 3, timeout: 3000 }).catch(() => {});
                await page.keyboard.press('Control+a');
                await page.keyboard.press('Backspace');
                await loc.type(text, { delay: delay || 30 });
                await postActionWait(page, wait_after);
                recordEvent(req.session, { action: 'fill', selector, value: text, url: page.url() });
                return res.json({ status: 'success', method: `${fillMethod}ctrl-a-type` });
            } catch (e) { errors.push(`ctrl+a: ${e.message.substring(0, 80)}`); }

            // Tentative 3 : JS value + React/Vue native setter
            try {
                await loc.evaluate((el, val) => {
                    // React native setter (works with React 16+, 17, 18)
                    const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value') ||
                        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value');
                    if (nativeInput?.set) nativeInput.set.call(el, val);
                    else el.value = val;
                    // Dispatch comprehensive events for React/Vue/Angular
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                    // React synthetic events
                    const tracker = el._valueTracker;
                    if (tracker) tracker.setValue('');
                }, text);
                await postActionWait(page, wait_after);
                recordEvent(req.session, { action: 'fill', selector, value: text, url: page.url() });
                return res.json({ status: 'success', method: `${fillMethod}js-value` });
            } catch (e) { errors.push(`js-value: ${e.message.substring(0, 80)}`); }

            // Feature 3+4: Smart retry + screenshot on failure
            const alternatives = await findAlternatives(page, selector, 3).catch(() => []);
            const ss = await screenshotOnFailure(page, req.sessionId, 'fill');
            res.status(500).json({ error: `fill failed: ${errors.join(' | ')}`, alternatives, ...ss });
            return;
        }

        // TYPE (frappe humaine)
        if (type === 'type') {
            const { locator } = await smartResolveLocator(page, selector);
            await locator.click({ timeout: 3000 }).catch(() => {});
            if (human) {
                for (const char of text) {
                    await page.keyboard.type(char);
                    const d = char === ' ' ? (80 + Math.random() * 120) : (30 + Math.random() * 80);
                    await page.waitForTimeout(d);
                }
            } else {
                await locator.type(text, { delay: delay || 50 });
            }
            await postActionWait(page, wait_after);
            return res.json({ status: 'success' });
        }

        // CLAVIER
        if (type === 'press') {
            if (selector) {
                const { locator } = await smartResolveLocator(page, selector);
                await locator.press(key, { timeout: _lt });
            } else {
                await page.keyboard.press(key);
            }
            await postActionWait(page, wait_after);
            recordEvent(req.session, { action: 'press', selector, key, url: page.url() });
            return res.json({ status: 'success' });
        }

        // SELECT (natif)
        if (type === 'select') {
            const { locator } = await smartResolveLocator(page, selector);
            // Même résolution sans essai-erreur que la branche officielle : on
            // lit les <option> puis on choisit. L'ancien code enchaînait deux
            // selectOption avec le timeout PLEIN chacun (10 s + 10 s).
            const picked = await selectOptionSmart(locator, {
                option_value, option_label, value, text, timeout: _lt });
            await postActionWait(page, wait_after);
            recordEvent(req.session, { action: 'select', selector, value: picked.value, option_label: picked.label, selected: picked, url: page.url() });
            return res.json({ status: 'success', selected: picked, ..._landed('select') });
        }

        // CHECK/UNCHECK
        if (type === 'check') {
            const { locator } = await smartResolveLocator(page, selector);
            try { await locator.check({ timeout: _lt, force }); }
            catch { await locator.evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change', { bubbles: true })); }); }
            recordEvent(req.session, { action: 'check', selector, url: page.url() });
            return res.json({ status: 'success' });
        }
        if (type === 'uncheck') {
            const { locator } = await smartResolveLocator(page, selector);
            try { await locator.uncheck({ timeout: _lt, force }); }
            catch { await locator.evaluate(el => { el.checked = false; el.dispatchEvent(new Event('change', { bubbles: true })); }); }
            recordEvent(req.session, { action: 'uncheck', selector, url: page.url() });
            return res.json({ status: 'success' });
        }

        // DÉPLIER / REPLIER (arbre, accordéon)
        if (type === 'expand' || type === 'collapse') {
            const { locator } = await smartResolveLocator(page, selector);
            const r = await expandTreeItem(page, locator, type === 'expand', _lt);
            await postActionWait(page, wait_after);
            return res.json({ status: 'success', ...r, ..._landed(type) });
        }

        // DRAG & DROP (même moteur que le chemin officiel : dragTo → HTML5 → décalage)
        if (type === 'drag') {
            const { locator } = await smartResolveLocator(page, selector);
            const r = await performDrag(page, locator, req.body, _lt);
            await postActionWait(page, wait_after);
            return res.json({ status: 'success', ...r, ..._landed('drag') });
        }

        // UPLOAD
        if (type === 'upload') {
            const { locator } = await smartResolveLocator(page, selector);
            await locator.setInputFiles(filePath, { timeout: _lt });
            return res.json({ status: 'success' });
        }

        // SCROLL
        if (type === 'scroll') {
            const { direction = 'down', amount = 500 } = req.body;
            if (selector) {
                const { locator } = await smartResolveLocator(page, selector);
                await locator.evaluate((el, { direction, amount }) => {
                    const map = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
                    const [x, y] = map[direction] || [0, amount];
                    el.scrollBy(x, y);
                }, { direction, amount });
            } else {
                if (human) {
                    const steps = 5 + Math.floor(Math.random() * 5);
                    const perStep = amount / steps;
                    const dir = direction === 'up' ? -1 : 1;
                    for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, perStep * dir); await page.waitForTimeout(30 + Math.random() * 50); }
                } else {
                    const map = { down: [0, amount], up: [0, -amount], right: [amount, 0], left: [-amount, 0] };
                    const [x, y] = map[direction] || [0, amount];
                    await page.mouse.wheel(x, y);
                }
            }
            return res.json({ status: 'success' });
        }

        // WAIT
        if (type === 'wait') {
            const { wait_for, wait_timeout = 15000 } = req.body;
            if (wait_for === 'network') await page.waitForLoadState('networkidle', { timeout: wait_timeout });
            else if (wait_for === 'navigation') await page.waitForNavigation({ timeout: wait_timeout, waitUntil: 'domcontentloaded' });
            else if (selector) await page.waitForSelector(selector, { state: 'visible', timeout: wait_timeout });
            else await page.waitForTimeout(wait_timeout);
            return res.json({ status: 'success' });
        }

        // REMOVE OVERLAYS
        if (type === 'remove_overlays') { await safeRemoveOverlays(page); return res.json({ status: 'success' }); }

        return res.status(400).json({ error: `Type d'action inconnu: "${type}"` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== LOCATOR (officiel Playwright API) ========================
// Utilise getByRole/getByText/getByLabel/etc. — l'API officielle Playwright.
// Renvoie un `ref` opaque que pw_act peut utiliser pour cliquer/taper sans
// reconstruire de sélecteur.
app.post('/locator', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const params = req.body;
        const max = Math.min(params.max || 5, 20);
        const visible_only = params.visible_only !== false;

        const includeFrames = params.include_frames === true;

        // Validation des critères (indépendant du scope).
        if (!resolveOfficialLocator(page, params)) {
            return res.status(400).json({
                error: "Au moins un critère requis: by_role, by_text, by_label, by_placeholder, by_test_id, by_alt, by_title, by_css, by_xpath"
            });
        }

        // Mécanisme Playwright natif : page.frames() renvoie le frame principal
        // + chaque iframe (imbriquée incluse). Frame expose la MÊME API Locator
        // que Page → on résout la même stratégie sur chaque scope et on agrège.
        // Sans include_frames on scope sur mainFrame() (PAS `page`) : un objet
        // Page échoue le test `scope === page.mainFrame()` ci-dessous et le
        // code tentait alors `scope.name()` — inexistant sur Page → TypeError
        // « scope.name is not a function » sur 100 % des pw_find.
        const scopes = includeFrames ? page.frames() : [page.mainFrame()];
        const matches = [];
        let total = 0;

        for (const scope of scopes) {
            if (matches.length >= max) break;
            const loc = resolveOfficialLocator(scope, params);
            if (!loc) continue;
            const count = await loc.count().catch(() => 0);
            if (count === 0) continue;
            total += count;
            const isMain = scope === page.mainFrame();
            const frameInfo = isMain ? null : { name: scope.name() || '', url: scope.url() || '' };
            // Le ref mémorise le frame d'origine → resolveRef re-résout sur CE frame
            // (pw_act peut donc agir sur un élément d'iframe).
            const baseRef = storeLocatorRef(req.sessionId, loc, params, frameInfo);

            for (let i = 0; i < Math.min(count, max); i++) {
                if (matches.length >= max) break;
                const item = loc.nth(i);
                try {
                    const visible = await item.isVisible({ timeout: 200 }).catch(() => false);
                    if (visible_only && !visible) continue;

                    const info = await item.evaluate((el) => {
                        function getXPath(el) {
                            if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `//*[@id="${el.id}"]`;
                            const parts = [];
                            while (el && el.nodeType === 1 && el.tagName !== 'HTML') {
                                let i = 1, sib = el.previousElementSibling;
                                while (sib) { if (sib.tagName === el.tagName) i++; sib = sib.previousElementSibling; }
                                parts.unshift(`${el.tagName.toLowerCase()}[${i}]`);
                                el = el.parentElement;
                            }
                            return '/html/' + parts.join('/');
                        }
                        const r = el.getBoundingClientRect();
                        let role = el.getAttribute('role');
                        if (!role) {
                            if (el.tagName === 'BUTTON') role = 'button';
                            else if (el.tagName === 'A') role = 'link';
                            else if (el.tagName === 'INPUT') role = 'textbox';
                        }
                        return {
                            tag: el.tagName.toLowerCase(),
                            text: (el.textContent || el.value || '').trim().substring(0, 80),
                            role,
                            in_viewport: r.top >= 0 && r.top <= window.innerHeight,
                            xpath: getXPath(el),
                        };
                    }).catch(() => null);

                    if (!info) continue;
                    matches.push({
                        ...info,
                        visible,
                        enabled: await item.isEnabled().catch(() => true),
                        ref: count > 1 ? `${baseRef}#${i}` : baseRef,
                        ...(frameInfo ? { frame: frameInfo } : {}),
                    });
                } catch (e) { /* ignore individual failures */ }
            }
        }

        const ttlS = Math.round(REF_TTL_MS / 1000);
        res.json({
            count: matches.length,
            total,
            matches,
            ...(includeFrames ? { frames_searched: scopes.length } : {}),
            // Durée de vie du ref, DITE : un ref rejoué sur un contenu qui a
            // disparu entre-temps est le piège classique des pages instables.
            ref_ttl_s: ttlS,
            ref_reusable: true,
            // Hint pour le LLM
            usage_hint: matches.length === 1
                ? `Pass ref="${matches[0].ref}" to pw_act for this element (reusable for ${ttlS}s — re-run pw_find on content that shifts/disappears)`
                : matches.length > 1
                ? `Multiple matches. Use refs above, or refine with filter_has_text/nth (refs reusable for ${ttlS}s).`
                : 'No visible matches found.',
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== LOCATE (legacy, kept for compat) ========================
app.post('/locate', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const {
            text,                  // Texte affiché (ex: "Login", "S'inscrire")
            role,                  // ARIA role (button, link, textbox, checkbox, radio, combobox, ...)
            label,                 // aria-label OU <label for=> associé
            placeholder,           // input placeholder
            test_id,               // data-testid / data-cy / data-qa
            tag,                   // restriction par tag (button, a, input, ...)
            exact = false,         // matching exact ou contains
            visible_only = true,
            max = 5,
        } = req.body;

        if (!text && !role && !label && !placeholder && !test_id && !tag) {
            return res.status(400).json({ error: "Au moins un critère requis: text, role, label, placeholder, test_id, ou tag" });
        }

        const matches = await page.evaluate((opts) => {
            const { text, role, label, placeholder, test_id, tag, exact, visible_only, max } = opts;

            function isVisible(el) {
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const cs = window.getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
                return true;
            }
            function txtMatch(haystack, needle) {
                if (!needle) return true;
                if (!haystack) return false;
                if (exact) return haystack.trim() === needle.trim();
                return haystack.toLowerCase().includes(needle.toLowerCase());
            }
            function getXPath(el) {
                if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `//*[@id="${el.id}"]`;
                const parts = [];
                while (el && el.nodeType === 1 && el.tagName !== 'HTML') {
                    let i = 1, sib = el.previousElementSibling;
                    while (sib) { if (sib.tagName === el.tagName) i++; sib = sib.previousElementSibling; }
                    parts.unshift(`${el.tagName.toLowerCase()}[${i}]`);
                    el = el.parentElement;
                }
                return '/html/' + parts.join('/');
            }
            function escapeAttr(v) { return String(v).replace(/"/g, '\\"'); }
            function escapeCssIdent(v) {
                // Escape pour utilisation dans un sélecteur CSS class (.xxx)
                return String(v).replace(/([!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
            }
            function isStableClass(cls) {
                // Filtre les classes générées (CSS-in-JS, BEM hashés, framework runtime)
                if (!cls || cls.length < 2 || cls.length > 60) return false;
                // Heuristiques de hashes (jss-123, css-1abc2de, sc-xxx, _abc123, MuiButton-root-23)
                if (/^(jss|css|sc-|emotion-|styled-|_)[\w-]{3,}/i.test(cls)) return false;
                if (/-\d{2,}$/.test(cls)) return false;       // suffix numérique long (Mui-root-123)
                if (/^[a-f0-9]{6,}$/i.test(cls)) return false; // hash hex pur
                if (/^[A-Za-z]{1,2}_[A-Za-z0-9]{4,}$/.test(cls)) return false; // pattern type "a_xY3z"
                return true;
            }
            function buildCssSelectors(el) {
                const sel = [];
                const tag = el.tagName.toLowerCase();

                // 1. ID stable
                if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) sel.push(`#${el.id}`);

                // 2. Test-IDs (les plus fiables pour SPA)
                const tid = el.getAttribute('data-testid') || el.getAttribute('data-cy') ||
                            el.getAttribute('data-qa') || el.getAttribute('data-test') || el.getAttribute('data-id');
                if (tid) sel.push(`[data-testid="${escapeAttr(tid)}"]`);

                // 3. Name attribute
                const name = el.getAttribute('name');
                if (name) sel.push(`${tag}[name="${escapeAttr(name)}"]`);

                // 4. ARIA label
                const aria = el.getAttribute('aria-label');
                if (aria && aria.length < 80) sel.push(`[aria-label="${escapeAttr(aria)}"]`);

                // 5. Placeholder
                const ph = el.getAttribute('placeholder');
                if (ph && ph.length < 80) sel.push(`${tag}[placeholder="${escapeAttr(ph)}"]`);

                // 6. Role attribute
                const role = el.getAttribute('role');
                if (role) sel.push(`[role="${escapeAttr(role)}"]`);

                // 7. href pour les liens
                if (tag === 'a' && el.getAttribute('href')) {
                    const h = el.getAttribute('href');
                    if (h.length < 100) sel.push(`a[href="${escapeAttr(h)}"]`);
                }

                // 8. SPA-friendly : classes stables (filtrées)
                const cls = el.className && typeof el.className === 'string' ? el.className.trim() : '';
                if (cls) {
                    const stable = cls.split(/\s+/).filter(isStableClass);
                    if (stable.length > 0) {
                        // Utilise jusqu'à 2 classes stables pour spécificité raisonnable
                        const c1 = stable[0];
                        sel.push(`${tag}.${escapeCssIdent(c1)}`);
                        if (stable.length > 1) {
                            sel.push(`${tag}.${escapeCssIdent(c1)}.${escapeCssIdent(stable[1])}`);
                        }
                    }
                }

                // 9. Fallback : nth-of-type avec parent contexte (utile quand rien d'autre)
                if (sel.length === 0) {
                    const parent = el.parentElement;
                    if (parent) {
                        const parentTag = parent.tagName.toLowerCase();
                        const parentId = parent.id && /^[a-zA-Z][\w-]*$/.test(parent.id) ? `#${parent.id}` : null;
                        const sameTag = Array.from(parent.children).filter(c => c.tagName === el.tagName);
                        const idx = sameTag.indexOf(el) + 1;
                        if (parentId) {
                            sel.push(`${parentId} > ${tag}:nth-of-type(${idx})`);
                        } else if (sameTag.length > 1) {
                            sel.push(`${parentTag} > ${tag}:nth-of-type(${idx})`);
                        }
                    }
                }

                return sel;
            }
            function buildPlaywrightSelectors(el, txt) {
                // ⚠️ IMPORTANT : on émet :has-text() (CSS extension Playwright)
                // PLUTÔT QUE text= ou tag:text=, car :has-text() est compatible
                // avec page.locator() ET page.click() de manière fiable.
                // Le format "tag:text=..." n'est pas valide CSS et échoue souvent.
                const sel = [];
                const tag = el.tagName.toLowerCase();
                let role = el.getAttribute('role');
                if (!role) {
                    if (el.tagName === 'BUTTON') role = 'button';
                    else if (el.tagName === 'A' && el.getAttribute('href')) role = 'link';
                    else if (el.tagName === 'INPUT') {
                        const t = (el.getAttribute('type') || 'text').toLowerCase();
                        if (t === 'checkbox') role = 'checkbox';
                        else if (t === 'radio') role = 'radio';
                        else if (t === 'submit' || t === 'button') role = 'button';
                        else role = 'textbox';
                    }
                    else if (el.tagName === 'SELECT') role = 'combobox';
                    else if (el.tagName === 'TEXTAREA') role = 'textbox';
                }
                if (!role) {
                    let cs;
                    try { cs = window.getComputedStyle(el); } catch (e) { cs = null; }
                    if (cs && cs.cursor === 'pointer') role = 'button';
                }

                const accName = el.getAttribute('aria-label') || (txt && txt.trim().substring(0, 60));
                // 1. role= (Playwright officiel, recommandé)
                if (role && accName) sel.push(`role=${role}[name="${escapeAttr(accName)}"]`);
                // 2. :has-text() — fiable, CSS pur Playwright (préféré à text=)
                if (txt && txt.trim().length > 0 && txt.trim().length < 50) {
                    sel.push(`${tag}:has-text("${escapeAttr(txt.trim())}")`);
                }
                return sel;
            }

            // 1. Sélection candidate par tag/role/test_id
            // SPA-friendly : pour les apps modernes (React/Vue/Angular), les éléments
            // cliquables sont souvent des <div>/<span> sans semantic. On élargit.
            let pool;
            if (test_id) {
                pool = Array.from(document.querySelectorAll(
                    `[data-testid="${test_id}"], [data-cy="${test_id}"], [data-qa="${test_id}"]`
                ));
            } else if (tag) {
                pool = Array.from(document.querySelectorAll(tag));
            } else {
                // Pool large : éléments natifs interactifs + heuristique SPA
                const candidates = new Set();

                // (a) Éléments natifs / ARIA-rolés (rapide, indispensable)
                document.querySelectorAll(
                    'a, button, input, select, textarea, label, summary, ' +
                    '[role], [tabindex]:not([tabindex="-1"]), ' +
                    '[data-testid], [data-cy], [data-qa], [data-test], [data-id], ' +
                    '[onclick], [contenteditable="true"]'
                ).forEach(el => candidates.add(el));

                // (b) Heuristique SPA : div/span/li/p avec signaux d'interactivité
                // - cursor:pointer (le plus fiable pour les SPA modernes)
                // - classnames typiques (btn, button, click, action, link, item, card, tab, menu, option)
                // - ng-click / v-on:click / @click attributes (Angular/Vue)
                const SPA_TAGS = 'div, span, li, p, td, th, section, article, header, footer, nav, aside, figure, h1, h2, h3, h4, h5, h6, img, svg, i';
                const CLASS_HINTS = /\b(btn|button|click|clickable|action|link|item|card|tab|menu|option|toggle|trigger|select|control|nav-item|menu-item|list-item|tile|chip|badge|cta|press|tap)\b/i;

                document.querySelectorAll(SPA_TAGS).forEach(el => {
                    if (candidates.has(el)) return;

                    // Skip rapides : très grand container, body wrapper
                    const r = el.getBoundingClientRect();
                    if (r.width === 0 || r.height === 0) return;
                    // skip "page wrappers" : trop gros (probable container, pas un bouton)
                    if (r.width > window.innerWidth * 0.95 && r.height > window.innerHeight * 0.7) return;

                    // Signal 1: cursor pointer (très bon indicateur SPA)
                    let cs;
                    try { cs = window.getComputedStyle(el); } catch (e) { return; }
                    if (cs.cursor === 'pointer') {
                        candidates.add(el);
                        return;
                    }

                    // Signal 2: classes évocatrices
                    const cls = el.className && typeof el.className === 'string' ? el.className : '';
                    if (cls && CLASS_HINTS.test(cls)) {
                        candidates.add(el);
                        return;
                    }

                    // Signal 3: framework markers (Angular/Vue/React handlers serializés en attribut)
                    const attrs = el.attributes;
                    for (let i = 0; i < attrs.length; i++) {
                        const an = attrs[i].name;
                        if (an.startsWith('ng-click') || an.startsWith('v-on:click') ||
                            an === '@click' || an.startsWith('(click)') ||
                            an.startsWith('data-on-') || an.startsWith('data-action')) {
                            candidates.add(el);
                            return;
                        }
                    }
                });

                pool = Array.from(candidates);
            }

            const found = [];
            for (const el of pool) {
                if (visible_only && !isVisible(el)) continue;

                const elText = (el.textContent || el.value || el.getAttribute('alt') || el.getAttribute('title') || '').trim();
                const elLabel = el.getAttribute('aria-label') ||
                                (el.id && document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim()) || '';
                const elPlaceholder = el.getAttribute('placeholder') || '';

                // Role inference SPA-friendly
                let elRole = el.getAttribute('role');
                let cs;
                try { cs = window.getComputedStyle(el); } catch (e) { cs = null; }
                if (!elRole) {
                    if (el.tagName === 'BUTTON') elRole = 'button';
                    else if (el.tagName === 'A' && el.getAttribute('href')) elRole = 'link';
                    else if (el.tagName === 'INPUT') {
                        const t = (el.getAttribute('type') || 'text').toLowerCase();
                        elRole = (t === 'checkbox') ? 'checkbox' :
                                 (t === 'radio') ? 'radio' :
                                 (t === 'submit' || t === 'button') ? 'button' : 'textbox';
                    }
                    else if (el.tagName === 'SELECT') elRole = 'combobox';
                    else if (el.tagName === 'TEXTAREA') elRole = 'textbox';
                    else if (cs && cs.cursor === 'pointer') elRole = 'button'; // SPA pseudo-button
                }

                // Filtres
                if (text && !txtMatch(elText, text) && !txtMatch(elLabel, text) && !txtMatch(elPlaceholder, text)) continue;
                if (label && !txtMatch(elLabel, label)) continue;
                if (placeholder && !txtMatch(elPlaceholder, placeholder)) continue;
                if (role && elRole !== role) continue;

                const r = el.getBoundingClientRect();
                const cssSelectors = buildCssSelectors(el);
                const pwSelectors = buildPlaywrightSelectors(el, elText);

                // Score : favorise id > test_id > aria > role+name > href > class stable > cursor:pointer > text
                let score = 0;
                if (cssSelectors.find(s => s.startsWith('#'))) score += 100;
                if (cssSelectors.find(s => s.includes('data-testid'))) score += 90;
                if (cssSelectors.find(s => s.includes('aria-label'))) score += 70;
                if (pwSelectors.find(s => s.startsWith('role='))) score += 60;
                if (cssSelectors.find(s => s.includes('[name='))) score += 50;
                if (cssSelectors.find(s => s.includes('placeholder'))) score += 40;
                if (cssSelectors.find(s => /^[a-z]+\.[\w-]+/i.test(s))) score += 30; // class stable
                if (cs && cs.cursor === 'pointer') score += 15;                       // SPA pseudo-button
                if (r.top >= 0 && r.top <= window.innerHeight) score += 10;          // viewport bonus

                found.push({
                    tag: el.tagName.toLowerCase(),
                    text: elText.substring(0, 80),
                    role: elRole,
                    visible: isVisible(el),
                    enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
                    in_viewport: r.top >= 0 && r.top <= window.innerHeight,
                    // Sélecteurs : on garde 3 candidats max, ordonnés par robustesse.
                    // Le LLM doit utiliser `selector` en priorité ; alternatives en fallback.
                    selector: cssSelectors[0] || pwSelectors[0] || getXPath(el),
                    alt_selectors: [
                        ...cssSelectors.slice(1, 3),
                        ...pwSelectors.slice(0, 2),
                    ].filter((s, i, a) => s && a.indexOf(s) === i).slice(0, 3),
                    xpath: getXPath(el),
                    score,
                    _meta: {
                        // Champs internes ignorables par le LLM, utiles pour debug
                        label: elLabel.substring(0, 80),
                        placeholder: elPlaceholder.substring(0, 80),
                        href: el.getAttribute('href'),
                        test_id: el.getAttribute('data-testid') || el.getAttribute('data-cy') || el.getAttribute('data-qa'),
                        cursor_pointer: cs ? cs.cursor === 'pointer' : false,
                        rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
                    },
                });
            }

            // Tri par score décroissant
            found.sort((a, b) => b.score - a.score);
            return found.slice(0, max);
        }, { text, role, label, placeholder, test_id, tag, exact, visible_only, max });

        // Format de retour compact : best en haut, alternatives uniquement si pertinent.
        // On omet _meta du top-level pour réduire le contexte vu par le LLM.
        const cleanMatch = (m) => {
            const { _meta, ...rest } = m;
            return rest;
        };
        const best = matches[0] ? cleanMatch(matches[0]) : null;
        // Si 1 seul match : pas besoin d'alternatives. Si plusieurs : top 3.
        const altMatches = matches.length > 1 ? matches.slice(1, 3).map(cleanMatch) : [];

        res.json({
            count: matches.length,
            best,                   // ← À utiliser directement : best.selector
            alternatives: altMatches,
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== QUERY (raw CSS/XPath, returns matches with details) ========================
app.post('/query', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector, xpath, max = 20, visible_only = false } = req.body;

        if (!selector && !xpath) {
            return res.status(400).json({ error: "Fournir 'selector' (CSS) ou 'xpath'" });
        }

        const result = await page.evaluate(({ selector, xpath, max, visible_only }) => {
            function isVisible(el) {
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const cs = window.getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
                return true;
            }
            function getXPath(el) {
                if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `//*[@id="${el.id}"]`;
                const parts = [];
                while (el && el.nodeType === 1 && el.tagName !== 'HTML') {
                    let i = 1, sib = el.previousElementSibling;
                    while (sib) { if (sib.tagName === el.tagName) i++; sib = sib.previousElementSibling; }
                    parts.unshift(`${el.tagName.toLowerCase()}[${i}]`);
                    el = el.parentElement;
                }
                return '/html/' + parts.join('/');
            }

            let nodes = [];
            try {
                if (xpath) {
                    const it = document.evaluate(xpath, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
                    for (let i = 0; i < it.snapshotLength && nodes.length < max * 2; i++) {
                        nodes.push(it.snapshotItem(i));
                    }
                } else {
                    nodes = Array.from(document.querySelectorAll(selector)).slice(0, max * 2);
                }
            } catch (e) {
                return { error: 'Sélecteur invalide: ' + e.message, count: 0, matches: [] };
            }

            const matches = [];
            for (const el of nodes) {
                if (matches.length >= max) break;
                if (!el || el.nodeType !== 1) continue;
                if (visible_only && !isVisible(el)) continue;

                // Garde uniquement les attrs utiles : id/class/href/data-*/name/type/aria-*
                // Évite d'envoyer 50 attrs framework (style, srcset gigantesque, etc.)
                const usefulAttrs = {};
                for (const a of el.attributes) {
                    const n = a.name;
                    if (n === 'id' || n === 'class' || n === 'href' || n === 'name' ||
                        n === 'type' || n === 'value' || n === 'placeholder' || n === 'title' ||
                        n === 'alt' || n === 'role' || n === 'src' ||
                        n.startsWith('data-') || n.startsWith('aria-')) {
                        if (a.value && a.value.length < 120) usefulAttrs[n] = a.value;
                        else if (a.value) usefulAttrs[n] = a.value.substring(0, 120) + '…';
                    }
                }
                matches.push({
                    tag: el.tagName.toLowerCase(),
                    text: (el.textContent || '').trim().substring(0, 100),
                    value: el.value !== undefined && el.value !== '' ? String(el.value).substring(0, 100) : undefined,
                    attrs: usefulAttrs,
                    visible: isVisible(el),
                    enabled: !el.disabled && el.getAttribute('aria-disabled') !== 'true',
                    xpath: getXPath(el),
                });
            }

            return { count: matches.length, matches };
        }, { selector, xpath, max, visible_only });

        if (result.error) return res.status(400).json({ error: result.error });
        // Drop undefined fields (JSON sérialise pas, mais c'est plus propre)
        result.matches = result.matches.map(m => Object.fromEntries(Object.entries(m).filter(([_, v]) => v !== undefined)));
        res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== HANDLE DROPDOWN (custom + natif) ========================
app.post('/handle_dropdown', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector, option_text, option_value, search_text } = req.body;

        const { locator } = await smartResolveLocator(page, selector);
        const tag = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => '');

        // Cas 1 : select natif
        if (tag === 'select') {
            if (option_value) await locator.selectOption({ value: option_value });
            else if (option_text) await locator.selectOption({ label: option_text });
            return res.json({ status: 'success', type: 'native-select' });
        }

        // Cas 2 : combobox/input avec datalist
        const inputType = await locator.evaluate(el => el.getAttribute('type') || '').catch(() => '');
        if (tag === 'input' && inputType !== 'hidden') {
            await locator.fill(search_text || option_text || option_value || '');
            await page.waitForTimeout(400);
            // Chercher dans les suggestions (datalist, autocomplete)
            const suggestions = [
                `[role="option"]:has-text("${option_text || option_value}")`,
                `datalist option[value="${option_value || option_text}"]`,
                `li:has-text("${option_text || option_value}")`,
                `.autocomplete-suggestion:has-text("${option_text || option_value}")`,
            ];
            for (const s of suggestions) {
                const sl = page.locator(s).first();
                if (await sl.count().catch(() => 0) > 0) { await sl.click(); return res.json({ status: 'success', type: 'input-autocomplete' }); }
            }
            await page.keyboard.press('Enter');
            return res.json({ status: 'success', type: 'input-enter' });
        }

        // Cas 3 : dropdown custom (div/button)
        await smartClick(page, selector);
        await page.waitForTimeout(350);

        // Chercher l'option dans la liste déroulante ouverte
        const optionText = option_text || option_value || '';
        const optionSelectors = [
            `[role="option"]:has-text("${optionText}")`,
            `[role="listbox"] *:has-text("${optionText}")`,
            `[role="menu"] *:has-text("${optionText}")`,
            `[class*="option"]:has-text("${optionText}")`,
            `[class*="item"]:has-text("${optionText}")`,
            `[class*="choice"]:has-text("${optionText}")`,
            `li:has-text("${optionText}")`,
            `td:has-text("${optionText}")`,
        ];

        for (const s of optionSelectors) {
            const optLoc = page.locator(s).first();
            if (await optLoc.count().catch(() => 0) > 0 && await optLoc.isVisible({ timeout: 500 }).catch(() => false)) {
                await optLoc.click();
                return res.json({ status: 'success', type: 'custom-dropdown', matched_by: s });
            }
        }

        // Fallback : chercher par text dans shadow DOM
        const shadowOpt = await shadowDOMQueryByText(page, optionText);
        if (shadowOpt?.found) {
            await page.mouse.click(shadowOpt.x, shadowOpt.y);
            return res.json({ status: 'success', type: 'shadow-dom-dropdown' });
        }

        return res.status(404).json({ error: `Option "${optionText}" introuvable dans le dropdown` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== SELECT DATE ========================
app.post('/select_date', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector, date, format = 'YYYY-MM-DD' } = req.body;
        // date doit être au format ISO : "2024-03-15"
        const [year, month, day] = date.split('-');

        const { locator } = await smartResolveLocator(page, selector);
        const inputType = await locator.evaluate(el => el.getAttribute('type') || '').catch(() => '');

        if (inputType === 'date') {
            // Input natif date
            await locator.fill(date);
            await locator.evaluate(el => ['input', 'change', 'blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true }))));
            return res.json({ status: 'success', type: 'native-date-input' });
        }

        if (inputType === 'datetime-local') {
            const dtValue = `${date}T${req.body.time || '00:00'}`;
            await locator.fill(dtValue);
            return res.json({ status: 'success', type: 'datetime-local' });
        }

        // Essayer de mettre la date via JS
        try {
            await locator.evaluate((el, val) => {
                const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                if (nativeInput?.set) nativeInput.set.call(el, val);
                else el.value = val;
                ['input', 'change', 'blur'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
            }, date);
            return res.json({ status: 'success', type: 'js-value' });
        } catch (e) {}

        // Essai : format affiché (DD/MM/YYYY)
        const formatted = format === 'DD/MM/YYYY' ? `${day}/${month}/${year}` :
            format === 'MM/DD/YYYY' ? `${month}/${day}/${year}` : date;
        await locator.fill(formatted);
        return res.json({ status: 'success', type: 'fill-formatted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== SELECT COLOR ========================
app.post('/select_color', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector, hex_color } = req.body;
        // hex_color : ex "#ff5733"
        const { locator } = await smartResolveLocator(page, selector);
        const inputType = await locator.evaluate(el => el.getAttribute('type') || '').catch(() => '');

        if (inputType === 'color') {
            await locator.evaluate((el, color) => {
                const nativeInput = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
                if (nativeInput?.set) nativeInput.set.call(el, color);
                else el.value = color;
                ['input', 'change'].forEach(ev => el.dispatchEvent(new Event(ev, { bubbles: true })));
            }, hex_color);
            return res.json({ status: 'success', type: 'native-color-input', color: hex_color });
        }

        // Tenter fill direct
        await locator.fill(hex_color);
        return res.json({ status: 'success', type: 'fill', color: hex_color });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== GET COLORS ========================
app.post('/get_colors', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector } = req.body;

        if (selector) {
            const { locator } = await smartResolveLocator(page, selector);
            const colors = await locator.evaluate(el => {
                const style = window.getComputedStyle(el);
                function toHex(rgb) {
                    if (!rgb || rgb === 'transparent') return null;
                    const m = rgb.match(/[\d.]+/g);
                    if (!m || m.length < 3) return null;
                    const [r, g, b, a] = m.map(Number);
                    if (a !== undefined && a < 0.05) return null;
                    return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
                }
                function luminance(hex) {
                    if (!hex) return null;
                    const r = parseInt(hex.slice(1, 3), 16) / 255;
                    const g = parseInt(hex.slice(3, 5), 16) / 255;
                    const b = parseInt(hex.slice(5, 7), 16) / 255;
                    const toLinear = c => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
                    return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
                }
                const textHex = toHex(style.color);
                const bgHex = toHex(style.backgroundColor);
                const lText = luminance(textHex);
                const lBg = luminance(bgHex);
                let contrast = null;
                if (lText !== null && lBg !== null) {
                    const lighter = Math.max(lText, lBg);
                    const darker = Math.min(lText, lBg);
                    contrast = parseFloat(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
                }
                return {
                    text: textHex,
                    background: bgHex,
                    border: toHex(style.borderColor),
                    outline: toHex(style.outlineColor),
                    boxShadow: style.boxShadow !== 'none' ? style.boxShadow.substring(0, 100) : null,
                    opacity: style.opacity,
                    contrast_ratio: contrast,
                    wcag_aa: contrast ? contrast >= 4.5 : null,
                    wcag_aaa: contrast ? contrast >= 7 : null,
                    is_disabled_looking: contrast !== null && contrast < 2.5,
                };
            });
            return res.json({ selector, ...colors });
        }

        // Palette globale de la page
        const palette = await page.evaluate(() => {
            const colorCounts = {};
            document.querySelectorAll('*').forEach(el => {
                try {
                    const style = window.getComputedStyle(el);
                    [style.color, style.backgroundColor, style.borderColor].forEach(c => {
                        if (!c || c.includes('rgba(0, 0, 0, 0)') || c === 'transparent') return;
                        colorCounts[c] = (colorCounts[c] || 0) + 1;
                    });
                } catch (e) {}
            });
            function toHex(rgb) {
                const m = rgb.match(/[\d.]+/g);
                if (!m || m.length < 3) return null;
                const [r, g, b, a] = m.map(Number);
                if (a !== undefined && a < 0.05) return null;
                return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
            }
            return Object.entries(colorCounts)
                .sort(([, a], [, b]) => b - a)
                .slice(0, 30)
                .map(([rgb, count]) => ({ hex: toHex(rgb), rgb, count }))
                .filter(x => x.hex);
        });
        res.json({ palette });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== FIND ELEMENTS ========================
app.post('/find_elements', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { query, type: elemType, visible_only = true, max = 20, in_viewport = false } = req.body;

        const results = await page.evaluate(({ query, elemType, visibleOnly, max, inViewport }) => {
            function toHex(rgb) {
                const m = rgb?.match(/[\d.]+/g);
                if (!m || m.length < 3) return null;
                const [r, g, b, a] = m.map(Number);
                if (a !== undefined && a < 0.05) return null;
                return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
            }
            function buildSelector(el) {
                if (el.id && !/^\d/.test(el.id)) return `#${el.id}`;
                const testId = el.getAttribute('data-testid') || el.getAttribute('data-cy') || el.getAttribute('data-qa');
                if (testId) return `[data-testid="${testId}"]`;
                const name = el.getAttribute('name');
                if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
                const ariaLabel = el.getAttribute('aria-label');
                if (ariaLabel) return `[aria-label="${ariaLabel.substring(0, 60)}"]`;
                const text = el.textContent?.trim().substring(0, 40);
                if (text) return `${el.tagName.toLowerCase()}:has-text("${text}")`;
                return el.tagName.toLowerCase();
            }

            let candidates = [];

            if (elemType) {
                const typeMap = {
                    'button': 'button, [role="button"], input[type="button"], input[type="submit"]',
                    'input': 'input:not([type="hidden"]), textarea',
                    'link': 'a[href]',
                    'select': 'select, [role="combobox"], [role="listbox"]',
                    'checkbox': 'input[type="checkbox"], [role="checkbox"]',
                    'radio': 'input[type="radio"], [role="radio"]',
                    'image': 'img',
                    'table': 'table, [role="grid"], [role="table"]',
                    'interactive': 'a, button, input, select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])',
                };
                candidates = Array.from(document.querySelectorAll(typeMap[elemType] || elemType));
            } else {
                candidates = Array.from(document.querySelectorAll('*'));
            }

            const results = [];
            for (const el of candidates) {
                if (results.length >= max) break;
                try {
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 && rect.height === 0) continue;
                    const style = window.getComputedStyle(el);
                    if (visibleOnly && (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')) continue;
                    if (inViewport && (rect.top < 0 || rect.top > window.innerHeight || rect.left < 0 || rect.left > window.innerWidth)) continue;

                    const text = (el.textContent || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim().substring(0, 150);

                    // Filtre par query
                    if (query) {
                        const q = query.toLowerCase();
                        const matches = text.toLowerCase().includes(q) ||
                            (el.id && el.id.toLowerCase().includes(q)) ||
                            (el.className?.toString().toLowerCase().includes(q)) ||
                            (el.getAttribute('aria-label') || '').toLowerCase().includes(q) ||
                            (el.getAttribute('placeholder') || '').toLowerCase().includes(q) ||
                            (el.getAttribute('name') || '').toLowerCase().includes(q);
                        if (!matches) continue;
                    }

                    results.push({
                        tag: el.tagName.toLowerCase(),
                        text: text.substring(0, 100),
                        selector: buildSelector(el),
                        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
                        center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
                        role: el.getAttribute('role'),
                        type: el.getAttribute('type'),
                        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
                        checked: el.checked,
                        value: (el.value || '').substring(0, 100),
                        href: el.href || null,
                        color: toHex(style.color),
                        bg: toHex(style.backgroundColor),
                        in_viewport: rect.top >= 0 && rect.top <= window.innerHeight,
                    });
                } catch (e) {}
            }
            return results;
        }, { query, elemType, visibleOnly: visible_only, max, inViewport: in_viewport });

        res.json({ elements: results, count: results.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== SMART INSPECT (carte sémantique) ========================
app.get('/smart_inspect', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const sid = req.query.session_id;
        const skipScreenshot = req.query.skip_screenshot === 'true';
        // ── New context-saving knobs (Python side already sends these) ──
        const level = ['lite', 'nav', 'full'].includes(req.query.level) ? req.query.level : 'lite';
        const viewportOnly = req.query.viewport_only !== 'false';        // default true
        const maxItems = Math.max(1, Math.min(parseInt(req.query.max_items) || 30, 200));
        const sinceStep = parseInt(req.query.since_step) || 0;
        const includeFrames = req.query.include_frames === 'true';
        const pierceShadow = req.query.pierce_shadow !== 'false';       // default true

        if (!skipScreenshot) {
            try { await page.screenshot({ path: path.join(SCREENSHOT_DIR, `smart_${sid}.png`) }); } catch (e) {}
        }

        const collectFn = ({ level, viewportOnly, maxItems, pierceShadow }) => {
            function toHex(rgb) {
                const m = rgb?.match(/[\d.]+/g);
                if (!m || m.length < 3) return null;
                const [r, g, b, a] = m.map(Number);
                if (a !== undefined && a < 0.05) return null;
                return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
            }

            // Ids régénérés à chaque rendu — inutilisables comme ancre.
            // NB : `gwt-debug-*` est au contraire l'ID le plus STABLE d'une appli
            // GWT (posé à la main via ensureDebugId) — surtout ne pas l'exclure.
            const GENERATED_ID = /^(:r|ember\d|gwt-uid-|ext-gen|ext-comp-|x-auto-|yui_|mat-\w+-\d|cdk-|radix-|headlessui-|v-\d)/i;
            function isGeneratedId(id) {
                if (GENERATED_ID.test(id)) return true;
                // Suffixe purement numérique long derrière un préfixe court :
                // « panel1234567 », signature classique d'un compteur global.
                if (/^[a-z]{1,6}[-_]?\d{5,}$/i.test(id)) return true;
                return false;
            }

            // ─── buildBestSelector v2 : priorité stricte, jamais has-text sur div ───
            function buildBestSelector(el) {
                const tag = el.tagName.toLowerCase();

                // 1. ID stable (pas auto-généré par un framework)
                // GWT (`gwt-uid-7`), GXT/ExtJS (`ext-gen1024`, `x-auto-3`),
                // Vaadin, YUI… régénèrent leurs ids à CHAQUE rendu. Le filtre
                // ne couvrait que React/Vue/ember : `#gwt-uid-7` était retourné,
                // et `selector_quality` l'étiquetait « stable » (audit
                // 2026-08-08). Un sélecteur faux annoncé comme sûr est pire
                // qu'un sélecteur absent.
                if (el.id && !/^\d/.test(el.id) && !isGeneratedId(el.id)
                    && el.id.length < 60 && !/[A-Z]{3,}/.test(el.id.slice(1))) {
                    return `#${el.id}`;
                }
                // 2. data-testid / data-cy / data-qa / data-test (attributs QA stables)
                for (const attr of ['data-testid','data-cy','data-qa','data-test','data-automation-id','data-e2e']) {
                    const v = el.getAttribute(attr);
                    if (v && v.length < 100) return `[${attr}="${v.replace(/"/g,'\\"')}"]`;
                }
                // 3. name (inputs, selects)
                if (['input','select','textarea'].includes(tag)) {
                    const name = el.getAttribute('name');
                    if (name) return `${tag}[name="${name.replace(/"/g,'\\"')}"]`;
                    // type+placeholder pour les inputs sans nom
                    const ph = el.getAttribute('placeholder');
                    if (ph) return `${tag}[placeholder="${ph.replace(/"/g,'\\"').substring(0,50)}"]`;
                    if (el.id) return `#${el.id}`;
                }
                // 4. aria-label (boutons et éléments interactifs sans texte)
                const ariaLabel = el.getAttribute('aria-label');
                if (ariaLabel && ariaLabel.length < 80) {
                    return `[aria-label="${ariaLabel.replace(/"/g,'\\"')}"]`;
                }
                // 5. Pour les boutons et liens : texte exact si unique et court
                if (['button','a'].includes(tag)) {
                    const text = (el.textContent || '').trim().replace(/\s+/g,' ');
                    if (text && text.length <= 30 && text.length > 1) {
                        // Vérifier l'unicité dans la page
                        const all = document.querySelectorAll(tag);
                        const matches = Array.from(all).filter(e => e.textContent.trim().replace(/\s+/g,' ') === text);
                        if (matches.length === 1) return `${tag}:text-is("${text.replace(/"/g,'\\"')}")`;
                        if (matches.length <= 3) return `${tag}:has-text("${text.replace(/"/g,'\\"').substring(0,30)}")`;
                    }
                }
                // 6. role + attribut discriminant
                const role = el.getAttribute('role');
                if (role) {
                    const ariaL = el.getAttribute('aria-label');
                    if (ariaL) return `[role="${role}"][aria-label="${ariaL.replace(/"/g,'\\"').substring(0,50)}"]`;
                    const ariaDesc = el.getAttribute('aria-describedby') || el.getAttribute('aria-controls');
                    if (ariaDesc) return `[role="${role}"][aria-describedby="${ariaDesc}"]`;
                }
                // 7. Classes CSS stables (sans hash, sans chiffres aléatoires, sans états)
                if (el.className && typeof el.className === 'string') {
                    const VOLATILE = /^\d|active|hover|focus|open|show|hide|selected|disabled|loading|error|visible|invisible|current/;
                    const cls = el.className.split(' ')
                        .map(c => c.trim())
                        .filter(c => c.length > 2 && c.length < 40 && !VOLATILE.test(c) && !/[A-Z]{4,}/.test(c) && !/\d{3,}/.test(c))
                        .slice(0, 2);
                    if (cls.length >= 1) {
                        const candidate = `.${cls.join('.')}`;
                        // Vérifier que ce sélecteur est raisonnablement discriminant
                        try {
                            const matches = document.querySelectorAll(candidate);
                            if (matches.length === 1) return candidate;
                            // Affiner avec le tag
                            const tagCandidate = `${tag}${candidate}`;
                            const tagMatches = document.querySelectorAll(tagCandidate);
                            if (tagMatches.length === 1) return tagCandidate;
                            if (tagMatches.length <= 5) return tagCandidate;
                        } catch(e) {}
                    }
                }
                // 8. nth-child positionnel (dernier recours, mais stable si DOM fixe)
                try {
                    const parent = el.parentElement;
                    if (parent) {
                        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
                        if (siblings.length > 1) {
                            const idx = siblings.indexOf(el) + 1;
                            const parentSel = buildBestSelector(parent);
                            if (parentSel && !parentSel.startsWith(tag)) {
                                return `${parentSel} > ${tag}:nth-child(${Array.from(parent.children).indexOf(el) + 1})`;
                            }
                        }
                    }
                } catch(e) {}
                // 9. Fallback : tag seul (inutilisable seul, mais le LLM a les coords center)
                return tag;
            }

            // Chemin CSS positionnel, ancré sur le premier id stable rencontré
            // (sinon body). Pour les conteneurs SANS aucune ancre — le
            // ScrollPanel GWT est un <div style="overflow:auto"> nu — où
            // buildBestSelector ne peut rendre que « div », qui n'est pas une
            // cible (mesuré en direct le 2026-09-05).
            function cssPath(el) {
                const parts = [];
                let cur = el, depth = 0;
                while (cur && cur.nodeType === 1 && cur.tagName !== 'HTML' && depth < 40) {
                    const tag = cur.tagName.toLowerCase();
                    if (cur.id && !/^\d/.test(cur.id) && !isGeneratedId(cur.id) && cur.id.length < 60) { parts.unshift(`#${cur.id}`); break; }
                    if (tag === 'body') { parts.unshift('body'); break; }
                    const parent = cur.parentElement;
                    if (!parent) { parts.unshift(tag); break; }
                    parts.unshift(`${tag}:nth-child(${Array.from(parent.children).indexOf(cur) + 1})`);
                    cur = parent; depth++;
                }
                return parts.join(' > ');
            }
            function anchoredSelector(el) {
                // id stable sur l'élément lui-même, sinon chemin positionnel ANCRÉ
                // (id d'ancêtre ou body) — jamais un chemin qui part d'un « tbody »
                // flottant ni une classe obscurcie (GWT : `CMWVMEC-p-b`, change
                // à chaque compilation). Même règle que le repli de /action.
                if (el.id && !/^\d/.test(el.id) && !isGeneratedId(el.id) && el.id.length < 60) return `#${el.id}`;
                return cssPath(el);
            }

            // ─── Rôle + nom accessibles ───
            // The model's most robust locator is role=<role>|name=<name>
            // (resolves to Playwright getByRole). Expose both explicitly so
            // it never has to guess from `type`/`text`.
            function axRole(el) {
                const explicit = el.getAttribute('role');
                if (explicit) return explicit.trim().toLowerCase();
                const tag = el.tagName.toLowerCase();
                if (tag === 'a' && el.hasAttribute('href')) return 'link';
                if (tag === 'button') return 'button';
                if (tag === 'select') return 'combobox';
                if (tag === 'textarea') return 'textbox';
                if (tag === 'input') {
                    const t = (el.getAttribute('type') || 'text').toLowerCase();
                    if (t === 'checkbox') return 'checkbox';
                    if (t === 'radio') return 'radio';
                    if (t === 'range') return 'slider';
                    if (['button', 'submit', 'reset'].includes(t)) return 'button';
                    return 'textbox';
                }
                return '';
            }
            function axName(el) {
                // Accessible-name priority: aria-label > aria-labelledby >
                // associated <label> > control text > placeholder/title/alt.
                try {
                    const al = el.getAttribute('aria-label');
                    if (al && al.trim()) return al.trim().substring(0, 80);
                    const lb = el.getAttribute('aria-labelledby');
                    if (lb) {
                        const txt = lb.split(/\s+/).map(id => {
                            const r = document.getElementById(id);
                            return r ? (r.textContent || '').trim() : '';
                        }).filter(Boolean).join(' ');
                        if (txt) return txt.substring(0, 80);
                    }
                    if (el.id) {
                        const lf = document.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
                        if (lf && lf.textContent.trim()) return lf.textContent.trim().substring(0, 80);
                    }
                    const wrap = el.closest('label');
                    if (wrap && wrap.textContent.trim()) return wrap.textContent.trim().substring(0, 80);
                    // Le texte propre vaut nom accessible pour TOUT contrôle qui
                    // n'a pas de valeur saisie — pas seulement button/a/role=button.
                    // Un `<div role="combobox">Choisir une ville</div>` ressortait
                    // avec name="" : le modèle ne pouvait pas construire
                    // role=combobox|name=… et retombait sur un sélecteur CSS
                    // fragile (audit 2026-08-08).
                    const tag = el.tagName.toLowerCase();
                    const NO_OWN_TEXT = new Set(['input', 'textarea', 'select']);
                    if (!NO_OWN_TEXT.has(tag)) {
                        const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                        // Un conteneur qui agrège le texte de toute une section
                        // n'a pas un « nom » : on borne.
                        if (t && t.length <= 120) return t.substring(0, 80);
                    }
                    return ((el.getAttribute('placeholder') || el.getAttribute('title')
                             || el.getAttribute('alt') || el.value || '') + '').trim().substring(0, 80);
                } catch (e) { return ''; }
            }

            // ─── Éléments interactifs ───
            //
            // `[onclick]` ne matche que l'ATTRIBUT HTML. GWT, GXT, SmartGWT,
            // ExtJS — et tout code qui utilise addEventListener — n'en posent
            // jamais : ces applis branchent tout par event sinking sur une
            // racine. Mesuré sur un banc GWT : 4 widgets vus sur 7, le
            // `<div class="gwt-Label">` et le bouton GXT
            // `<div class="x-btn"><table><td class="x-btn-text">` invisibles
            // (audit 2026-08-08). Le modèle ne peut pas cliquer ce qu'il ne
            // voit pas.
            //
            // On ajoute donc deux passes complémentaires, dans cet ordre :
            //   1. la requête sémantique historique (fiable, prioritaire) ;
            //   2. une passe HEURISTIQUE : `cursor:pointer`, propriété
            //      `onclick` posée en JS, ou classe de widget d'un framework
            //      connu. Chaque trouvaille est marquée `detected_by:"heuristic"`
            //      pour que le modèle sache que le rôle n'est pas déclaré.
            const interactiveQuery = [
                'a[href]', 'a[onclick]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
                '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
                '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="combobox"]',
                '[role="switch"]', '[role="slider"]', '[role="spinbutton"]',
                '[role="treeitem"]', '[role="gridcell"]', '[role="listbox"]', '[role="menuitemcheckbox"]',
                '[onclick]', '[tabindex]:not([tabindex="-1"])',
                // Audit tools web 2026-09-05 — les colonnes d'un glisser-déposer
                // (`div draggable=true`) étaient invisibles à inspect ET à som.
                '[draggable="true"]',
            ].join(', ');

            // Classes de widget des frameworks à base de <div> les plus répandus.
            const WIDGET_CLASS = /(^|\s)(gwt-|x-btn|x-grid|x-tool|x-tab|v-button|v-select|dijit|z-button|ui-button|ui-menu-item|mdc-button|mat-button|ant-btn|el-button|btn|button|clickable|link|menu-item|list-item|option|tab)/i;

            function heuristicallyInteractive(el, cs) {
                if (cs.cursor === 'pointer') return 'cursor';
                if (typeof el.onclick === 'function') return 'onclick-prop';
                const cls = typeof el.className === 'string' ? el.className : '';
                if (cls && WIDGET_CLASS.test(cls)) return 'widget-class';
                return null;
            }

            const seen = new WeakSet();
            const interactives = [];
            const heuristicPool = [];
            let idx = 0;
            const _semantic = Array.from(document.querySelectorAll(interactiveQuery));
            // ── Shadow DOM (ouvert) ────────────────────────────────────
            // querySelectorAll ne traverse JAMAIS un shadow root : un composant
            // web (ou GWT encapsulé) était invisible à inspect — mesuré
            // /shadowdom : 0 élément utile alors qu'eval voyait tout (audit
            // tools web 2026-09-05). Playwright, lui, perce les shadow roots
            // ouverts (css, text=, getByRole) : les cibles restent actionnables.
            const _shadowHosts = [];
            const _inShadow = new WeakMap();   // el → sélecteur de l'hôte
            const _shadowContent = [];         // {hostSel, text, interCount} par hôte
            if (pierceShadow) {
                const shadowText = (sr) => {
                    let t = '';
                    try {
                        const it = document.createTreeWalker(sr, NodeFilter.SHOW_TEXT, {
                            acceptNode: n => {
                                const p = n.parentElement;
                                return p && /^(STYLE|SCRIPT|TEMPLATE|NOSCRIPT)$/.test(p.tagName)
                                    ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
                            },
                        });
                        let n; while ((n = it.nextNode())) t += n.textContent + ' ';
                    } catch (e) {}
                    return t.replace(/\s+/g, ' ').trim();
                };
                const walkShadow = (root, depth) => {
                    if (depth > 4) return;
                    for (const host of root.querySelectorAll('*')) {
                        const sr = host.shadowRoot;
                        if (!sr) continue;
                        _shadowHosts.push(host);
                        const hostSel = buildBestSelector(host);
                        const inter = sr.querySelectorAll(interactiveQuery);
                        for (const el of inter) {
                            if (!_inShadow.has(el)) { _inShadow.set(el, hostSel); _semantic.push(el); }
                        }
                        _shadowContent.push({ hostSel, text: shadowText(sr).slice(0, 160),
                                              interCount: inter.length });
                        walkShadow(sr, depth + 1);
                    }
                };
                try { walkShadow(document, 0); } catch (e) {}
            }
            const _semanticSet = new WeakSet(_semantic);
            // ── Conteneurs défilables ──────────────────────────────────
            // Une appli GWT défile DANS des ScrollPanel, jamais la page : le
            // modèle doit les voir pour cibler `scroll target=css=…`.
            const SCROLL_TAGS = new Set(['DIV', 'SECTION', 'TD', 'LI', 'MAIN', 'ARTICLE', 'UL', 'OL', 'TABLE', 'TBODY', 'ASIDE', 'FORM', 'NAV']);
            const _scrollables = [];
            const noteScrollable = (el, cs) => {
                if (!SCROLL_TAGS.has(el.tagName) || _scrollables.length >= 20) return;
                if (!/(auto|scroll)/.test(cs.overflowY) || el.scrollHeight <= el.clientHeight + 2) return;
                // GWT garde un <div overflow:scroll> en visibility:hidden pour mesurer
                // la barre de défilement : défilable, mais pas un panneau (mesuré).
                if (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0') return;
                const r = el.getBoundingClientRect();
                if (r.width < 40 || r.height < 40) return;
                _scrollables.push({ el, area: r.width * r.height, r });
            };
            for (const el of document.querySelectorAll('main, article, ul, ol, table, tbody, aside, form, nav')) {
                let cs; try { cs = window.getComputedStyle(el); } catch (e) { continue; }
                noteScrollable(el, cs);
            }
            // Passe heuristique : on ne balaie que les conteneurs plausibles
            // (pas tout le DOM), et on écarte tout ce qui contient déjà un
            // candidat sémantique — sinon un <div> englobant un <button> serait
            // listé à sa place et le modèle cliquerait à côté.
            for (const el of document.querySelectorAll('div, span, td, li, i, img, p, label, section, a')) {
                let cs; try { cs = window.getComputedStyle(el); } catch (e) { continue; }
                noteScrollable(el, cs);
                if (_semanticSet.has(el)) continue;
                const why = heuristicallyInteractive(el, cs);
                if (!why) continue;
                if (el.querySelector(interactiveQuery)) continue;   // le vrai bouton est dedans
                // Un ancêtre déjà retenu par heuristique suffit.
                heuristicPool.push({ el, why });
            }
            // Garder le nœud le plus EXTÉRIEUR de chaque chaîne heuristique :
            // sur `<div class="x-btn"><table><td class="x-btn-text">`, la cible
            // utile est le conteneur qui porte le handler, pas la cellule.
            const _hSet = new WeakSet(heuristicPool.map(h => h.el));
            const _why = new WeakMap(heuristicPool.map(h => [h.el, h.why]));
            const _heuristic = heuristicPool
                .filter(h => {
                    let p = h.el.parentElement, hops = 0;
                    while (p && hops < 8) {
                        if (_hSet.has(p)) return false;   // un ancêtre couvre déjà ce nœud
                        p = p.parentElement; hops++;
                    }
                    return true;
                })
                .map(h => h.el);

            const _allCandidates = _semantic.concat(_heuristic);
            // Ce qui est ÉCARTÉ est compté : `viewport_only:true` masquait des
            // éléments sans le dire, et le modèle concluait « n'existe pas »
            // (audit tools web 2026-09-05).
            const omitted = { offscreen: 0, hidden: 0, too_small: 0, over_max: 0 };
            let _consumed = 0;
            for (const el of _allCandidates) {
                if (interactives.length >= maxItems) { omitted.over_max = _allCandidates.length - _consumed; break; }
                _consumed++;
                if (seen.has(el)) continue;
                seen.add(el);
                const rect = el.getBoundingClientRect();
                if (rect.width < 2 || rect.height < 2) { omitted.too_small++; continue; }
                if (viewportOnly && (rect.bottom < -50 || rect.top > window.innerHeight + 50)) { omitted.offscreen++; continue; }
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') { omitted.hidden++; continue; }
                const tag = el.tagName.toLowerCase();
                const role = el.getAttribute('role');
                const text = (el.textContent || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim().replace(/\s+/g,' ').substring(0, 100);

                let elemType = tag;
                if (tag === 'input') elemType = `input:${el.getAttribute('type') || 'text'}`;
                else if (role) elemType = `role:${role}`;
                else if (el.getAttribute('draggable') === 'true') elemType = 'draggable';
                else if (tag === 'a') elemType = 'link';
                else if (tag === 'button') elemType = 'button';
                else if (tag === 'select') elemType = 'select';
                else if (tag === 'textarea') elemType = 'textarea';

                const sel = buildBestSelector(el);
                const item = {
                    idx: idx++, type: elemType, text, selector: sel,
                    role: axRole(el), name: axName(el),
                    in_viewport: rect.top >= -50 && rect.top < window.innerHeight + 50,
                };
                // Trouvé par heuristique et non par rôle déclaré : le dire, pour
                // que le modèle vise par TEXTE plutôt que par role=/name=.
                if (_why.has(el)) { item.detected_by = _why.get(el); }
                if (_inShadow.has(el)) { item.in_shadow = true; item.shadow_host = _inShadow.get(el); }
                if (el.getAttribute('draggable') === 'true') item.draggable = true;

                // ── État des listes déroulantes ────────────────────────────
                // Sans ça, le modèle ne sait pas si la liste est ouverte, ni
                // quel listbox appartient à quel combobox — il rouvre ce qui
                // est déjà ouvert et referme au lieu de choisir.
                const _exp = el.getAttribute('aria-expanded');
                if (_exp !== null) item.expanded = _exp === 'true';
                const _pop = el.getAttribute('aria-haspopup');
                if (_pop) item.haspopup = _pop;
                const _ctl = el.getAttribute('aria-controls');
                if (_ctl) item.controls = _ctl;
                const _act = el.getAttribute('aria-activedescendant');
                if (_act) item.active_option = _act;

                // ── Options d'un <select>, à TOUS les niveaux ──────────────
                // Elles n'étaient exposées qu'en level="full", documenté
                // « exhaustive (heavy) » : au niveau par défaut le modèle
                // devinait le libellé, et un libellé faux coûtait 10 s de
                // timeout. Le seul moyen de choisir juste, c'est de voir.
                if (tag === 'select') {
                    const _o = Array.from(el.options || []);
                    item.options = _o.slice(0, 25).map(o => ({
                        value: o.value, label: (o.text || '').trim(), selected: o.selected,
                    }));
                    if (_o.length > 25) item.options_truncated = _o.length;
                    if (el.multiple) item.multiple = true;
                }
                // 'nav' adds form/href/region context; 'full' adds colors/options/rect.
                if (level !== 'lite') {
                    item.center = { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
                    item.disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
                    if (el.type === 'checkbox' || el.type === 'radio') item.checked = el.checked;
                    if (el.value) item.value = el.value.substring(0, 100);
                    if (el.getAttribute('placeholder')) item.placeholder = el.getAttribute('placeholder');
                    if (tag === 'a') item.href = el.getAttribute('href');
                }
                if (level === 'full') {
                    item.rect = { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) };
                    item.color = toHex(style.color);
                    item.bg = toHex(style.backgroundColor);
                    // `#id` n'est « stable » que si l'id n'est pas régénéré à
                    // chaque rendu — cf. isGeneratedId. buildBestSelector ne les
                    // produit plus, mais l'étiquette doit rester honnête si un
                    // jour il en repasse un.
                    const _idStable = sel.startsWith('#') && !isGeneratedId(sel.slice(1));
                    item.selector_quality = (_idStable || sel.startsWith('[data-') || sel.startsWith('[aria-label') || sel.includes(':text'))
                        ? 'stable' : sel.includes('nth-child') ? 'positional' : 'class-based';
                    // (les options du <select> sont désormais jointes à tous les niveaux)
                }
                interactives.push(item);
            }

            // ─── Contenu de shadow root NON interactif ─────────────────────
            // Un composant web dont le shadow root ne porte que du TEXTE (ex.
            // the-internet /shadowdom : ``<my-paragraph>`` → ``<p>…</p>``) était
            // invisible à inspect (qui ne liste que les interactifs) — le modèle
            // voyait ``shadow_hosts:2`` sans jamais savoir CE QU'IL Y AVAIT
            // dedans (audit tools web 2026-09-05, retest 2). On liste donc ce
            // contenu, marqué ``in_shadow`` : le texte est là, la cible est
            // l'hôte. Les hôtes qui contiennent des interactifs sont déjà listés
            // par ceux-ci — on ne les redouble pas.
            let _scEmitted = 0;
            for (const c of _shadowContent) {
                if (interactives.length >= maxItems || _scEmitted >= 10) break;
                if (c.interCount > 0 || !c.text) continue;
                interactives.push({
                    idx: idx++, type: 'shadow-content', role: '',
                    name: c.text.slice(0, 80), text: c.text,
                    selector: c.hostSel, in_shadow: true, shadow_host: c.hostSel,
                    in_viewport: true,
                });
                _scEmitted++;
            }

            // ─── Formulaires (nav+full only) ───
            const forms = (level === 'lite') ? [] : Array.from(document.querySelectorAll('form')).map((form, i) => {
                const fields = Array.from(form.querySelectorAll('input, select, textarea')).map(f => ({
                    tag: f.tagName.toLowerCase(), name: f.getAttribute('name'),
                    type: f.getAttribute('type') || 'text', id: f.id || null,
                    placeholder: f.getAttribute('placeholder'), required: f.required,
                    value: f.value?.substring(0, 100), label: (() => {
                        if (f.id) { const lb = document.querySelector(`label[for="${f.id}"]`); if (lb) return lb.textContent.trim().substring(0, 60); }
                        const wrapper = f.closest('label'); if (wrapper) return wrapper.textContent.trim().substring(0, 60);
                        return null;
                    })(),
                    selector: buildBestSelector(f),
                }));
                return { index: i, id: form.id || null, action: form.action || null, method: form.method || 'get', fields, submit_btn: (() => {
                    const btn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type="button"])');
                    return btn ? { text: btn.textContent.trim(), selector: buildBestSelector(btn) } : null;
                })() };
            });

            // ─── Tableaux (full only) ───
            const tables = (level !== 'full') ? [] : Array.from(document.querySelectorAll('table, [role="grid"], [role="table"]')).map((t, i) => {
                const headers = Array.from(t.querySelectorAll('th, [role="columnheader"]')).map(h => h.textContent.trim()).filter(Boolean);
                const rows = t.querySelectorAll('tr, [role="row"]').length;
                return { index: i, tag: t.tagName.toLowerCase(), role: t.getAttribute('role'), rows, cols: headers.length || 'unknown', headers: headers.slice(0, 15), selector: buildBestSelector(t) };
            });

            // ─── Structure sémantique (nav+full) ───
            const regions = {};
            if (level !== 'lite') {
                const regionMap = {
                    header: 'header, [role="banner"]',
                    nav: 'nav, [role="navigation"]',
                    main: 'main, [role="main"], #main, #content',
                    footer: 'footer, [role="contentinfo"]',
                    sidebar: 'aside, [role="complementary"]',
                    search: '[role="search"], form[action*="search"]',
                    dialog: '[role="dialog"]:not([hidden]), [role="alertdialog"]:not([hidden])',
                };
                Object.entries(regionMap).forEach(([name, query]) => {
                    const el = document.querySelector(query);
                    if (el) {
                        const rect = el.getBoundingClientRect();
                        regions[name] = {
                            found: true, text_preview: el.textContent?.trim().substring(0, 150),
                            rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
                        };
                    } else regions[name] = { found: false };
                });
            }

            // ─── Alertes (always — they're cheap and important for the LLM) ───
            const alerts = Array.from(document.querySelectorAll('[role="alert"], [role="status"], .alert, .notification, .toast, .snackbar, .error, .warning, .success')).slice(0, 5).map(el => ({
                role: el.getAttribute('role'), text: el.textContent.trim().substring(0, 200), selector: buildBestSelector(el),
            })).filter(a => a.text.length > 0);

            const scrollables = _scrollables.sort((a, b) => b.area - a.area).slice(0, 5).map(x => ({
                selector: anchoredSelector(x.el), h: Math.round(x.el.clientHeight), sh: Math.round(x.el.scrollHeight),
                top: Math.round(x.el.scrollTop), in_viewport: x.r.top < window.innerHeight && x.r.bottom > 0,
            }));
            // maxY : `body.scrollHeight - innerHeight` rendait un NÉGATIF quand
            // le défilement vit dans documentElement ou dans un panneau interne
            // (mesuré -585…-898 sur GWT) — audit tools web 2026-09-05.
            const maxY = Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - window.innerHeight);
            // Résumé des shadow roots (hôte + aperçu du texte + nb d'interactifs)
            // — complète les items ``in_shadow`` : un coup d'œil suffit à savoir
            // ce que chaque composant encapsule.
            const shadow = _shadowContent.slice(0, 10).map(c => ({
                host: c.hostSel, text: c.text, interactive: c.interCount,
            }));
            // ``scrollables`` est TOUJOURS présent (tableau, vide si aucun) : son
            // absence ne doit pas être confondue avec « pas encore implémenté »
            // (audit tools web 2026-09-05, retest 2). Vide = la page défile
            // elle-même (ou rien ne défile), non-vide = viser un conteneur.
            return { interactives, forms, tables, regions, alerts, url: location.href, title: document.title,
                     viewport: { w: window.innerWidth, h: window.innerHeight },
                     scroll: { x: window.scrollX, y: window.scrollY, maxY },
                     candidates_total: _allCandidates.length, omitted,
                     scrollables,
                     ...(scrollables.length ? { scrollables_hint: 'scroll inside one with pw_act(action="scroll", target="css=<selector>", direction="down")' } : {}),
                     shadow_hosts: _shadowHosts.length,
                     ...(shadow.length ? { shadow } : {}) };
        };

        const data = await page.evaluate(collectFn, { level, viewportOnly, maxItems, pierceShadow });

        // ── Contenu des iframes ───────────────────────────────────────────
        // page.evaluate ne s'exécute QUE dans la frame principale : tout ce qui
        // vit dans une <iframe> était invisible pour inspect/observe, donc pour
        // le modèle (mesuré : 2 champs d'un formulaire encadré, jamais listés).
        // Opt-in, car chaque frame coûte un evaluate. On n'ajoute QUE les
        // interactifs — fusionner forms/regions/scroll de plusieurs documents
        // n'aurait pas de sens — et chacun porte `frame` pour que le modèle
        // sache qu'un sélecteur CSS de la frame principale ne l'atteindra pas.
        if (includeFrames) {
            const kids = getAllFrames(page).filter(f => f !== page.mainFrame() && !f.isDetached());
            let framesRead = 0;
            for (const f of kids) {
                if (data.interactives.length >= maxItems) break;
                const budget = maxItems - data.interactives.length;
                let sub = null;
                try {
                    sub = await Promise.race([
                        f.evaluate(collectFn, { level, viewportOnly: false, maxItems: budget, pierceShadow }),
                        new Promise(r => setTimeout(() => r(null), 3000)),
                    ]);
                } catch (e) { sub = null; }
                if (!sub || !Array.isArray(sub.interactives)) continue;
                framesRead++;
                for (const it of sub.interactives) {
                    it.idx = data.interactives.length;
                    it.frame = { name: f.name() || null, url: f.url() };
                    it.frame_hint = 'pw_find(target=…, include_frames=true) → ref, puis pw_act(target="ref=…")';
                    data.interactives.push(it);
                }
            }
            data.frames_read = framesRead;
            data.frames_total = kids.length;
        }

        // ─── since_step diff filter (server-side, after evaluate) ───
        // Compare the current set of (selector|type|text) tuples against the
        // previous snapshot stored on the session under `_inspectSnapshots`.
        // Returns only the items that are new or whose key changed since `step`.
        const s = req.session;
        s._inspectSnapshots = s._inspectSnapshots || {}; // step -> Set<key>
        const currentKeys = new Set(data.interactives.map(it => `${it.selector}|${it.type}|${it.text}`));
        // Snapshot the current state under the upcoming step number for future diffs.
        // (autoSnapshot has already incremented screenshotCounter when we get here? No — middleware
        // runs on res.json. So we register against `screenshotCounter+1`).
        const upcomingStep = (s.screenshotCounter || 0) + 1;
        s._inspectSnapshots[upcomingStep] = currentKeys;
        // Bound the snapshot history so it can't grow forever (keep last 20)
        const snapKeys = Object.keys(s._inspectSnapshots).map(Number).sort((a, b) => a - b);
        while (snapKeys.length > 20) { delete s._inspectSnapshots[snapKeys.shift()]; }

        let filteredInteractives = data.interactives;
        let diffMeta = null;
        if (sinceStep > 0 && s._inspectSnapshots[sinceStep]) {
            const prev = s._inspectSnapshots[sinceStep];
            filteredInteractives = data.interactives.filter(it =>
                !prev.has(`${it.selector}|${it.type}|${it.text}`)
            );
            diffMeta = {
                since_step: sinceStep,
                total_now: data.interactives.length,
                added_or_changed: filteredInteractives.length,
            };
        }

        res.json({
            ...data,
            interactives: filteredInteractives,
            diff: diffMeta,
            level, viewport_only: viewportOnly, max_items: maxItems,
            screenshot: skipScreenshot ? null : `smart_${sid}.png`,
            // Répétitions compactées en « (×N) » (audit tools web 2026-09-05).
            console_errors: compactConsole(req.session.consoleLogs || [], 5),
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== INSPECT (vue textuelle complète) ========================
app.get('/inspect', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const sid = req.query.session_id;
        const skipScreenshot = req.query.skip_screenshot === 'true';

        if (!skipScreenshot) {
            try { await page.screenshot({ path: path.join(SCREENSHOT_DIR, `view_${sid}.png`) }); } catch (e) {}
        }

        const mainView = await inspectFrame(page, 'MAIN');
        let iframeViews = '';
        const frames = getAllFrames(page);
        let frameIdx = 0;
        for (const frame of frames) {
            if (frame === page.mainFrame() || frame.isDetached()) continue;
            try {
                const frameUrl = frame.url();
                if (frameUrl.includes('doubleclick') || frameUrl.includes('facebook.com/tr') || frameUrl.includes('google-analytics')) continue;
                const content = await inspectFrame(frame, `IFRAME_${frameIdx}`);
                if (content && content.trim().length > 10) {
                    iframeViews += `\n\n===== IFRAME #${frameIdx} (${frameUrl.substring(0, 80)}) =====\n${content}`;
                    frameIdx++;
                }
            } catch (e) {}
        }
        res.json({
            url: page.url(),
            title: await page.title().catch(() => ''),
            view: (mainView + iframeViews).replace(/\n{3,}/g, '\n\n').trim(),
            screenshot: skipScreenshot ? null : `view_${sid}.png`,
            console_errors: compactConsole(req.session.consoleLogs || [], 10),
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

async function inspectFrame(frame, label) {
    try {
        return await frame.evaluate(() => {
            const MAX_DEPTH = 30, MAX_TEXT = 200;
            function toHex(rgb) {
                const m = rgb?.match(/[\d.]+/g);
                if (!m || m.length < 3) return null;
                const [r, g, b, a] = m.map(Number);
                if (a !== undefined && a < 0.05) return null;
                return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
            }
            function isVisible(el) {
                if (!el?.getBoundingClientRect) return false;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = el.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            }
            function clean(s) { return s ? s.replace(/\s+/g, ' ').trim().substring(0, MAX_TEXT) : ''; }
            function isTableLike(el) {
                const style = window.getComputedStyle(el);
                return ['table', 'table-row', 'table-cell', 'grid', 'inline-grid'].includes(style.display) ||
                    ['table', 'grid', 'row', 'gridcell', 'columnheader'].includes(el.getAttribute('role'));
            }
            function buildSelector(node) {
                const attrs = [];
                if (node.id && !/^\d/.test(node.id) && !/^:r/.test(node.id) && !node.id.startsWith('ext-')) attrs.push(`#${node.id}`);
                if (node.className && typeof node.className === 'string') {
                    const cls = node.className.split(' ').filter(c => c.length > 2 && c.length < 50 && !/\d{3,}/.test(c) && !['active', 'hover', 'focus', 'selected', 'open', 'show'].some(s => c === s)).slice(0, 3);
                    if (cls.length) attrs.push(`.${cls.join('.')}`);
                }
                for (const a of ['name', 'data-testid', 'data-cy', 'data-automation', 'data-qa', 'aria-label', 'placeholder', 'title']) {
                    const val = node.getAttribute(a);
                    if (val && val.length < 80) attrs.push(`[${a}="${val.replace(/"/g, '\\"')}"]`);
                }
                return attrs.join('').substring(0, 150);
            }
            function getColorHint(node) {
                const style = window.getComputedStyle(node);
                const bg = toHex(style.backgroundColor);
                const clr = toHex(style.color);
                const parts = [];
                if (bg) parts.push(`bg:${bg}`);
                if (clr) parts.push(`clr:${clr}`);
                if (node.disabled || node.getAttribute('aria-disabled') === 'true') parts.push('DISABLED');
                return parts.length ? ` {${parts.join(' ')}}` : '';
            }
            function traverse(node, depth = 0, inTable = false) {
                if (depth > MAX_DEPTH) return '';
                if (node.nodeType === Node.TEXT_NODE) { const t = clean(node.textContent); return t.length > 1 ? t : ''; }
                if (node.nodeType !== Node.ELEMENT_NODE) return '';
                if (!isVisible(node)) return '';
                const tag = node.tagName.toLowerCase();
                if (['script', 'style', 'noscript', 'link', 'meta', 'br', 'hr', 'wbr', 'head'].includes(tag)) return '';
                const role = node.getAttribute('role');
                const ariaLabel = node.getAttribute('aria-label');
                const style = window.getComputedStyle(node);
                const isPointer = style.cursor === 'pointer';
                const hasClick = node.getAttribute('onclick') || node.getAttribute('@click') || node.getAttribute('ng-click') || node.getAttribute('data-action') || node.getAttribute('v-on:click');
                const isNativeInteractive = ['a', 'button', 'input', 'select', 'textarea', 'details', 'summary'].includes(tag);
                const isAriaInteractive = ['button', 'checkbox', 'link', 'menuitem', 'option', 'radio', 'switch', 'tab', 'combobox', 'textbox', 'searchbox', 'slider', 'spinbutton', 'treeitem'].includes(role);
                const isCustomInteractive = (hasClick || (isPointer && node.children.length < 5)) && ['div', 'span', 'li', 'td', 'label', 'img', 'i', 'p', 'section'].includes(tag);
                const isInteractive = isNativeInteractive || isAriaInteractive || isCustomInteractive || tag === 'svg';
                const sel = buildSelector(node);
                const colorHint = isInteractive ? getColorHint(node) : '';

                // Tables
                if (tag === 'table' || (isTableLike(node) && role === 'table'))
                    return `\n📋 TABLE${sel ? ' ' + sel : ''}\n${Array.from(node.childNodes).map(c => traverse(c, depth + 1, true)).join('')}\n`;
                if (tag === 'thead') return `  [HEADER]${Array.from(node.childNodes).map(c => traverse(c, depth + 1, true)).join('')}\n`;
                if (tag === 'tbody' || tag === 'tfoot') return Array.from(node.childNodes).map(c => traverse(c, depth + 1, true)).join('');
                if (tag === 'tr' || role === 'row') return `\n  |${Array.from(node.childNodes).map(c => traverse(c, depth + 1, true)).join('')}`;
                if (tag === 'td' || tag === 'th' || role === 'gridcell' || role === 'columnheader') {
                    const content = Array.from(node.childNodes).map(c => traverse(c, depth + 1, true)).join(' ');
                    const interactive = node.querySelector('button, a, input, select, [role="button"]');
                    if (interactive) return ` ${clean(content)} (→${buildSelector(interactive)}) |`;
                    return ` ${clean(content)} |`;
                }
                if (isTableLike(node) && !['table'].includes(tag)) {
                    const dt = style.display;
                    if (dt === 'table-row' || role === 'row') return `\n  |${Array.from(node.childNodes).map(c => traverse(c, depth + 1, true)).join('')}`;
                    if (dt === 'table-cell' || role === 'gridcell' || role === 'columnheader') return ` ${clean(Array.from(node.childNodes).map(c => traverse(c, depth + 1, true)).join(' '))} |`;
                }

                // Éléments interactifs
                if (isInteractive) {
                    let type = tag.toUpperCase(), lbl = '';
                    if (tag === 'input') {
                        const it = node.getAttribute('type') || 'text';
                        type = `INPUT:${it}`;
                        lbl = node.value || node.getAttribute('placeholder') || ariaLabel || '';
                        if (it === 'checkbox' || it === 'radio') lbl += node.checked ? ' ✓' : ' ○';
                        if (it === 'color') lbl += ` [valeur: ${node.value}]`;
                        if (it === 'date' || it === 'datetime-local') lbl += ` [date: ${node.value}]`;
                        if (it === 'range') lbl += ` [${node.min || 0}-${node.max || 100}, val: ${node.value}]`;
                    } else if (tag === 'select') {
                        type = 'SELECT';
                        const selected = node.options?.[node.selectedIndex];
                        lbl = selected ? selected.text : (ariaLabel || '');
                        const options = Array.from(node.options || []).slice(0, 12).map(o => o.text.trim()).filter(Boolean);
                        if (options.length) lbl += ` [Options: ${options.join(', ')}]`;
                    } else if (tag === 'textarea') {
                        type = 'TEXTAREA'; lbl = clean(node.value) || node.getAttribute('placeholder') || ariaLabel || '';
                    } else if (tag === 'svg' || tag === 'img' || tag === 'i') {
                        type = 'ICON'; lbl = ariaLabel || node.getAttribute('alt') || node.getAttribute('data-icon') || node.getAttribute('title') || node.className?.toString().match(/fa-[\w-]+|icon-[\w-]+|mdi-[\w-]+|bi-[\w-]+/)?.[0] || 'Graphic';
                    } else if (tag === 'a') {
                        type = 'LINK'; lbl = clean(node.textContent) || ariaLabel || '';
                        const href = node.getAttribute('href');
                        if (href && !href.startsWith('javascript:') && href !== '#') lbl += ` → ${href.substring(0, 60)}`;
                    } else {
                        if (role === 'checkbox') type = 'CHECKBOX';
                        else if (role === 'radio') type = 'RADIO';
                        else if (role === 'tab') type = 'TAB';
                        else if (role === 'menuitem' || role === 'menuitemcheckbox') type = 'MENUITEM';
                        else if (role === 'switch') type = 'SWITCH';
                        else if (role === 'slider') type = 'SLIDER';
                        else if (role === 'option') type = 'OPTION';
                        else if (role === 'combobox') type = 'COMBOBOX';
                        else if (tag === 'button' || role === 'button') type = 'BUTTON';
                        else type = `CLICKABLE:${tag}`;
                        lbl = clean(node.textContent) || ariaLabel || '';
                    }
                    if (!lbl) lbl = '(sans texte)';
                    const ariaExpanded = node.getAttribute('aria-expanded');
                    const ariaSelected = node.getAttribute('aria-selected');
                    const stateHint = [ariaExpanded ? `expanded:${ariaExpanded}` : '', ariaSelected ? `selected:${ariaSelected}` : ''].filter(Boolean).join(' ');
                    return `\n[${type}] "${lbl.substring(0, 120)}" ${sel}${colorHint}${stateHint ? ` (${stateHint})` : ''}`;
                }

                // Structure
                const children = Array.from(node.childNodes).map(c => traverse(c, depth + 1, inTable)).join(' ');
                if (['h1', 'h2', 'h3', 'h4', 'h5'].includes(tag)) return `\n${'#'.repeat(parseInt(tag[1]))} ${clean(children)}\n`;
                if (tag === 'form') return `\n─── FORM${sel ? ' ' + sel : ''} ───\n${children}\n─── /FORM ───\n`;
                if (tag === 'nav') return `\n[NAV]\n${children}\n`;
                if (tag === 'main' || role === 'main') return `\n[MAIN]\n${children}\n`;
                if (tag === 'header' || role === 'banner') return `\n[HEADER]\n${children}\n`;
                if (tag === 'footer' || role === 'contentinfo') return `\n[FOOTER]\n${children}\n`;
                if (tag === 'aside' || role === 'complementary') return `\n[SIDEBAR]\n${children}\n`;
                if (tag === 'section' || tag === 'article') return `\n${children}\n`;
                if (tag === 'label') { const forId = node.getAttribute('for'); return `LABEL${forId ? `(for=${forId})` : ''}: ${clean(children)} `; }
                if (tag === 'li') return `\n  • ${children}`;
                if (tag === 'option') return '';
                if (tag === 'iframe') return `\n[IFRAME: ${node.src?.substring(0, 60) || 'embedded'}]\n`;
                if (tag === 'dialog' || role === 'dialog') return `\n[DIALOG]\n${children}\n[/DIALOG]\n`;
                if (role === 'alert' || role === 'status') return `\n[ALERTE: ${clean(children)}]\n`;
                return children;
            }
            return traverse(document.body);
        });
    } catch (e) { return `(Erreur inspection: ${e.message})`; }
}


// ======================== SCREENSHOT ANNOTÉ ========================
app.post('/screenshot', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector, full_page = false, annotate = false, skip_image = false } = req.body;
        const sid = req.body.session_id;
        const filename = `shot_${sid}_${Date.now()}.png`;
        const filepath = path.join(SCREENSHOT_DIR, filename);

        if (selector && !skip_image) {
            const { locator } = await smartResolveLocator(page, selector);
            await locator.screenshot({ path: filepath });
        } else if (annotate) {
            const elementsMap = await page.evaluate(() => {
                const interactives = document.querySelectorAll(
                    'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], ' +
                    '[role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [onclick], ' +
                    '[tabindex]:not([tabindex="-1"]), summary'
                );
                const map = [];
                let idx = 0;
                interactives.forEach(el => {
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 5 || rect.height < 5) return;
                    const style = window.getComputedStyle(el);
                    if (style.display === 'none' || style.visibility === 'hidden') return;
                    const label = document.createElement('div');
                    label.textContent = idx;
                    label.style.cssText = `position:fixed;z-index:99999;background:#FF0000;color:#FFF;font-size:11px;font-weight:bold;padding:1px 4px;border-radius:3px;pointer-events:none;line-height:1.2;left:${rect.left}px;top:${Math.max(0, rect.top - 16)}px;`;
                    label.className = '__pw_annotation__';
                    document.body.appendChild(label);
                    const border = document.createElement('div');
                    border.style.cssText = `position:fixed;z-index:99998;border:2px solid #FF0000;pointer-events:none;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
                    border.className = '__pw_annotation__';
                    document.body.appendChild(border);
                    map.push({
                        idx, tag: el.tagName.toLowerCase(), role: el.getAttribute('role'),
                        text: (el.textContent || el.value || el.placeholder || el.getAttribute('aria-label') || '').trim().substring(0, 80),
                        rect: { x: Math.round(rect.left), y: Math.round(rect.top), w: Math.round(rect.width), h: Math.round(rect.height) },
                        center: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) },
                        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
                    });
                    idx++;
                });
                return map;
            });
            if (!skip_image) await page.screenshot({ path: filepath, fullPage: false });
            await page.evaluate(() => document.querySelectorAll('.__pw_annotation__').forEach(el => el.remove()));
            return res.json({ status: 'success', screenshot: skip_image ? null : filename, elements: elementsMap });
        } else if (!skip_image) {
            await page.screenshot({ path: filepath, fullPage: full_page });
        }
        res.json({ status: 'success', screenshot: skip_image ? null : filename });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== ACCESSIBILITY TREE ========================
app.get('/accessibility', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const snapshot = await page.accessibility.snapshot({ interestingOnly: true });
        function flatten(node, depth = 0) {
            if (!node) return '';
            const indent = '  '.repeat(depth);
            let line = `${indent}[${node.role}] "${node.name || ''}"`;
            if (node.value !== undefined) line += ` value="${node.value}"`;
            if (node.checked !== undefined) line += ` checked=${node.checked}`;
            if (node.selected !== undefined) line += ` selected=${node.selected}`;
            if (node.expanded !== undefined) line += ` expanded=${node.expanded}`;
            if (node.disabled) line += ` DISABLED`;
            if (node.focused) line += ` *FOCUSED*`;
            if (node.required) line += ` REQUIRED`;
            let result = line + '\n';
            if (node.children) for (const child of node.children) result += flatten(child, depth + 1);
            return result;
        }
        res.json({ tree: flatten(snapshot), raw: snapshot });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== A11Y AUDIT (WCAG — dependency-free) ========================
// Checker WCAG maison injecté dans la page. PAS de lib externe (axe-core est
// MPL-2.0, hors politique MIT/Apache-2.0). Couvre les violations à fort impact
// pour une IHM : alt d'image, label de champ, nom accessible, contraste AA,
// ids dupliqués, lang du document, ordre des titres, tabindex positif.
app.post('/a11y_audit', getSession, async (req, res) => {
    try {
        const { page } = req.session;
        const scope = req.body.scope || 'body';
        const report = await page.evaluate((scopeSel) => {
            const root = document.querySelector(scopeSel) || document.body;
            const V = [];
            const sel = (el) => {
                if (!el || !el.tagName) return '';
                if (el.id) return '#' + el.id;
                let s = el.tagName.toLowerCase();
                if (typeof el.className === 'string' && el.className.trim())
                    s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
                return s;
            };
            const add = (rule, impact, el, message) => V.push({
                rule, impact, selector: sel(el), message,
                text: ((el && el.textContent) || '').trim().slice(0, 60),
            });
            const visible = (el) => {
                const r = el.getBoundingClientRect(); const st = getComputedStyle(el);
                return r.width > 0 && r.height > 0 && st.visibility !== 'hidden'
                    && st.display !== 'none' && el.getAttribute('aria-hidden') !== 'true';
            };
            const accName = (el) => {
                const al = el.getAttribute('aria-label'); if (al && al.trim()) return al.trim();
                const lb = el.getAttribute('aria-labelledby');
                if (lb) { const t = lb.split(/\s+/).map(id => { const e = document.getElementById(id); return e ? e.textContent : ''; }).join(' ').trim(); if (t) return t; }
                if (el.labels && el.labels.length) return [...el.labels].map(l => l.textContent).join(' ').trim();
                const ti = el.getAttribute('title'); if (ti && ti.trim()) return ti.trim();
                if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button' || el.tagName === 'A') return (el.textContent || '').trim();
                const ph = el.getAttribute('placeholder'); if (ph && ph.trim()) return ph.trim();
                return '';
            };
            // 1. images sans alt
            root.querySelectorAll('img').forEach(img => {
                if (!visible(img) || img.getAttribute('role') === 'presentation' || img.getAttribute('aria-hidden') === 'true') return;
                if (img.getAttribute('alt') === null) add('image-alt', 'serious', img, '<img> sans attribut alt');
            });
            // 2. champs de formulaire sans nom accessible
            root.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=reset]), select, textarea').forEach(el => {
                if (visible(el) && !accName(el)) add('label', 'serious', el, `<${el.tagName.toLowerCase()}> sans label/aria-label`);
            });
            // 3. boutons/liens sans nom accessible
            root.querySelectorAll('button, a[href], [role=button]').forEach(el => {
                if (visible(el) && !accName(el)) add('control-name', 'serious', el, `${el.tagName.toLowerCase()} sans nom accessible`);
            });
            // 4. ids dupliqués
            const ids = {}; root.querySelectorAll('[id]').forEach(el => { ids[el.id] = (ids[el.id] || 0) + 1; });
            Object.entries(ids).filter(([, n]) => n > 1).forEach(([id, n]) => V.push({ rule: 'duplicate-id', impact: 'moderate', selector: '#' + id, message: `id "${id}" dupliqué ${n}×`, text: '' }));
            // 5. lang du document
            if (!document.documentElement.getAttribute('lang')) V.push({ rule: 'html-lang', impact: 'serious', selector: 'html', message: '<html> sans attribut lang', text: '' });
            // 6. ordre des titres
            let prev = 0; root.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(h => { if (!visible(h)) return; const lvl = +h.tagName[1]; if (prev && lvl > prev + 1) add('heading-order', 'moderate', h, `saut de titre h${prev}→h${lvl}`); prev = lvl; });
            // 7. tabindex positif
            root.querySelectorAll('[tabindex]').forEach(el => { const t = parseInt(el.getAttribute('tabindex'), 10); if (t > 0) add('tabindex', 'moderate', el, `tabindex=${t} (>0) casse l'ordre de tabulation`); });
            // 8. contraste couleur (WCAG AA) — best-effort, plafonné
            const parseRGB = s => { const m = s.match(/\d+(\.\d+)?/g); return m ? m.slice(0, 3).map(Number) : null; };
            const lum = rgb => { const f = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }; return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]); };
            const bgOf = el => { let e = el; while (e) { const b = getComputedStyle(e).backgroundColor; const rgb = parseRGB(b); if (rgb && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') return rgb; e = e.parentElement; } return [255, 255, 255]; };
            let checked = 0;
            root.querySelectorAll('p,span,a,li,td,th,label,button,h1,h2,h3,h4,h5,h6').forEach(el => {
                if (checked > 200 || !visible(el)) return;
                if (![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) return;
                const st = getComputedStyle(el); const fg = parseRGB(st.color); if (!fg) return;
                checked++;
                const L1 = lum(fg) + 0.05, L2 = lum(bgOf(el)) + 0.05;
                const ratio = Math.max(L1, L2) / Math.min(L1, L2);
                const fs = parseFloat(st.fontSize), large = fs >= 24 || (fs >= 18.66 && +st.fontWeight >= 700);
                const min = large ? 3 : 4.5;
                if (ratio < min) add('color-contrast', 'serious', el, `contraste ${ratio.toFixed(2)}:1 < ${min}:1 (AA)`);
            });
            const by_impact = V.reduce((a, v) => { a[v.impact] = (a[v.impact] || 0) + 1; return a; }, {});
            const by_rule = V.reduce((a, v) => { a[v.rule] = (a[v.rule] || 0) + 1; return a; }, {});
            // Audit tools web 2026-09-05 — `total/by_impact` seuls ne disaient pas
            // si 45 violations = 45 contrastes réels ou un checker incomplet.
            return { ok: true, scope: scopeSel, violations: V.slice(0, 100), total: V.length,
                     truncated: V.length > 100, by_impact, by_rule,
                     rules_run: ['image-alt', 'label', 'control-name', 'duplicate-id', 'html-lang', 'heading-order', 'tabindex', 'color-contrast'],
                     contrast_sampled: checked, contrast_capped: checked > 200,
                     passed: V.length === 0 };
        }, scope);
        res.json(report);
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== VISUAL REGRESSION (in-browser canvas diff) ========================
// Compare la page (ou un élément) à un baseline "golden". Premier passage (ou
// update=true) → enregistre le baseline. Sinon → diff pixel via canvas DANS la
// page (0 dépendance Node) + génère une heatmap rouge inspectable par un modèle
// à vision. passed = diff_ratio <= threshold.
app.post('/visual', getSession, async (req, res) => {
    try {
        const { page } = req.session;
        const name = (req.body.name || 'default').replace(/[^a-zA-Z0-9_-]/g, '_');
        const selector = req.body.selector || null;
        const threshold = typeof req.body.threshold === 'number' ? req.body.threshold : 0.01;
        const tol = typeof req.body.pixel_tolerance === 'number' ? req.body.pixel_tolerance : 30;
        const update = req.body.update === true;
        const baselinePath = path.join(BASELINE_DIR, `${name}.png`);

        const target = selector ? page.locator(selector).first() : page;
        const curBuf = await target.screenshot(selector ? {} : { fullPage: true });

        if (!fs.existsSync(baselinePath) || update) {
            fs.writeFileSync(baselinePath, curBuf);
            return res.json({ ok: true, name, baseline_created: true, passed: true,
                size_mismatch: false, pixel_diff_failed: false, fail_reason: null,
                message: update ? 'baseline mise à jour' : 'baseline créée (premier passage)' });
        }

        const baseB64 = 'data:image/png;base64,' + fs.readFileSync(baselinePath).toString('base64');
        const curB64 = 'data:image/png;base64,' + curBuf.toString('base64');
        const result = await page.evaluate(async ({ baseB64, curB64, tol }) => {
            const load = src => new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = ko; i.src = src; });
            const [a, b] = await Promise.all([load(baseB64), load(curB64)]);
            // Une capture fullPage n'est PAS stable au pixel près : mesuré, le
            // scrollHeight passe de 1621 à 1622 entre la pose du baseline et la
            // capture suivante (la capture elle-même déclenche un reflow). Un
            // rejet sec sur « dimensions différentes » rendait donc pw_visual
            // inutilisable : le baseline qu'il venait de créer ne pouvait plus
            // jamais correspondre (audit 2026-08-08).
            //
            // On compare l'INTERSECTION et on rapporte l'écart de taille. Un
            // vrai changement de mise en page reste visible : soit il déplace
            // assez de pixels, soit l'écart de dimensions dépasse la tolérance.
            const dims = { baseline: { w: a.width, h: a.height }, current: { w: b.width, h: b.height } };
            const w = Math.min(a.width, b.width), h = Math.min(a.height, b.height);
            if (w < 2 || h < 2) return { size_mismatch: true, dims };
            const dw = Math.abs(a.width - b.width), dh = Math.abs(a.height - b.height);
            const size_drift = Math.max(dw / Math.max(1, w), dh / Math.max(1, h));
            const c = document.createElement('canvas'); c.width = w; c.height = h;
            const x = c.getContext('2d');
            x.drawImage(a, 0, 0); const da = x.getImageData(0, 0, w, h).data;
            x.clearRect(0, 0, w, h); x.drawImage(b, 0, 0); const db = x.getImageData(0, 0, w, h).data;
            const out = x.createImageData(w, h), od = out.data; let nd = 0;
            for (let i = 0; i < da.length; i += 4) {
                if (Math.abs(da[i] - db[i]) > tol || Math.abs(da[i + 1] - db[i + 1]) > tol || Math.abs(da[i + 2] - db[i + 2]) > tol) {
                    nd++; od[i] = 255; od[i + 1] = 0; od[i + 2] = 0; od[i + 3] = 255;   // rouge = différence
                } else { od[i] = db[i]; od[i + 1] = db[i + 1]; od[i + 2] = db[i + 2]; od[i + 3] = 60; } // fond atténué
            }
            x.putImageData(out, 0, 0);
            return { w, h, diff_pixels: nd, total: w * h, diff_ratio: nd / (w * h),
                     dims, size_drift, diff_png: c.toDataURL('image/png') };
        }, { baseB64, curB64, tol });

        const ts = Date.now();
        const curName = `visual_${name}_current_${ts}.png`;
        fs.writeFileSync(path.join(SCREENSHOT_DIR, curName), curBuf);

        if (result.size_mismatch) {
            return res.json({ ok: true, name, passed: false, size_mismatch: true, pixel_diff_failed: null,
                fail_reason: 'size_mismatch', dims: result.dims,
                screenshot_url: `/screenshots/${curName}`, message: 'images incomparables (relance avec update=true si volontaire)' });
        }
        // Dérive de taille tolérée : au-delà, c'est un vrai changement de mise
        // en page et il doit faire échouer la comparaison, même si les pixels
        // communs sont identiques.
        const SIZE_DRIFT_MAX = 0.02;
        const sizeChanged = (result.size_drift || 0) > SIZE_DRIFT_MAX;

        const diffName = `visual_${name}_diff_${ts}.png`;
        const baseName = `visual_${name}_baseline_${ts}.png`;
        fs.copyFileSync(baselinePath, path.join(SCREENSHOT_DIR, baseName));
        fs.writeFileSync(path.join(SCREENSHOT_DIR, diffName), Buffer.from(result.diff_png.split(',')[1], 'base64'));

        // Audit tools web 2026-09-05 — deux causes d'échec DISTINCTES, dites
        // séparément : pixels au-delà du seuil, et/ou dimensions qui ont bougé.
        const pixelFailed = result.diff_ratio > threshold;
        const failReason = [pixelFailed ? 'pixel_diff' : null, sizeChanged ? 'size_mismatch' : null].filter(Boolean).join('+') || null;
        res.json({ ok: true, name, passed: !pixelFailed && !sizeChanged, threshold,
            pixel_diff_failed: pixelFailed, size_mismatch: sizeChanged, fail_reason: failReason,
            diff_ratio: result.diff_ratio, diff_pixels: result.diff_pixels,
            compared: { w: result.w, h: result.h }, dims: result.dims,
            ...(result.size_drift ? { size_drift: result.size_drift } : {}),
            ...(sizeChanged ? { size_changed: true, message: 'la page a changé de dimensions' } : {}),
            screenshot_url: `/screenshots/${curName}`, baseline_url: `/screenshots/${baseName}`, diff_url: `/screenshots/${diffName}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== ELEMENT INFO ========================
app.post('/element_info', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { locator } = await smartResolveLocator(page, req.body.selector);
        const info = await locator.evaluate(el => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            function toHex(rgb) {
                const m = rgb?.match(/[\d.]+/g);
                if (!m || m.length < 3) return null;
                const [r, g, b, a] = m.map(Number);
                if (a !== undefined && a < 0.05) return null;
                return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
            }
            return {
                tag: el.tagName.toLowerCase(), id: el.id,
                classes: el.className?.toString() || '',
                text: el.textContent?.trim().substring(0, 300),
                value: el.value, href: el.href, src: el.src,
                visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0',
                enabled: !el.disabled, checked: el.checked, readOnly: el.readOnly,
                contentEditable: el.contentEditable === 'true',
                attributes: Object.fromEntries(Array.from(el.attributes).map(a => [a.name, a.value.substring(0, 200)])),
                rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
                in_viewport: rect.top >= 0 && rect.top < window.innerHeight,
                childCount: el.children.length,
                computedStyle: {
                    display: style.display, position: style.position, cursor: style.cursor,
                    zIndex: style.zIndex, overflow: style.overflow, pointerEvents: style.pointerEvents,
                },
                colors: {
                    text: toHex(style.color), bg: toHex(style.backgroundColor),
                    border: toHex(style.borderColor),
                },
                options: el.tagName === 'SELECT' ? Array.from(el.options).map(o => ({ value: o.value, label: o.text, selected: o.selected })) : undefined,
            };
        });
        res.json(info);
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== WAIT FOR ========================
app.post('/wait_for', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector, state = 'visible', timeout = 15000 } = req.body;
        const allFrames = [page, ...getAllFrames(page)];
        let found = false;
        for (const frame of allFrames) {
            if (frame.isDetached?.()) continue;
            try { await frame.waitForSelector(selector, { state, timeout: Math.min(timeout, 5000) }); found = true; break; }
            catch (e) {}
        }
        if (!found) await page.waitForSelector(selector, { state, timeout });
        res.json({ status: 'found' });
    } catch (e) { res.status(500).json({ error: e.message, status: 'not_found' }); }
});


// ======================== NETWORK LOG ========================
// Audit tools web 2026-09-05 — rendait `{logs, count}` avec du XHR tiers
// seulement. Désormais : documents + XHR/fetch, `by_host` sur tout le journal
// filtré, `total` avant plafond, et sous le plafond les entrées document /
// same-origin d'abord (cf. summarizeNetwork).
app.get('/network', getSession, autoSnapshot, async (req, res) => {
    try {
        const { networkLog, page } = req.session;
        const { filter, last = 50, types } = req.query;
        const typeSet = types ? new Set(String(types).split(',').map(t => t.trim()).filter(Boolean)) : null;
        const out = summarizeNetwork(networkLog, { last, filter: filter || '', types: typeSet });
        let pageUrl = ''; try { pageUrl = page.url(); } catch (_) {}
        res.json({ ...out, page_url: pageUrl });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== INTERCEPT REQUESTS ========================
app.post('/intercept', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { block_patterns = [], modify_headers = {} } = req.body;
        await page.route('**/*', (route, request) => {
            const url = request.url();
            for (const pattern of block_patterns) { if (url.includes(pattern)) { route.abort(); return; } }
            // fallback (et non continue) : la garde des destinations, posée
            // sur le contexte, doit encore voir la requête.
            if (Object.keys(modify_headers).length > 0) { route.fallback({ headers: { ...request.headers(), ...modify_headers } }); return; }
            route.fallback();
        });
        res.json({ status: 'intercepting', blocking: block_patterns.length, modifying_headers: Object.keys(modify_headers).length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== CAPTURE API RESPONSE ========================
app.post('/capture_response', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { url_pattern, timeout = 15000 } = req.body;
        const response = await page.waitForResponse(resp => resp.url().includes(url_pattern), { timeout });
        let body;
        try { body = await response.json(); } catch { body = await response.text(); }
        res.json({ status: response.status(), url: response.url(), headers: response.headers(), body });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== EXTRACT TABLE ========================
app.post('/extract_table', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const selector = req.body.selector || 'table';
        const data = await page.evaluate((sel) => {
            function toHex(rgb) {
                const m = rgb?.match(/[\d.]+/g);
                if (!m || m.length < 3) return null;
                const [r, g, b, a] = m.map(Number);
                if (a !== undefined && a < 0.05) return null;
                return '#' + [r, g, b].map(x => Math.round(x).toString(16).padStart(2, '0')).join('');
            }
            const table = document.querySelector(sel);
            if (!table) return { error: `Aucun élément trouvé pour "${sel}"` };
            const tag = table.tagName.toLowerCase();

            if (tag === 'table') {
                const headers = [];
                table.querySelectorAll('thead th, thead td, tr:first-child th').forEach(c => {
                    const style = window.getComputedStyle(c);
                    headers.push({
                        text: c.innerText.replace(/\s+/g, ' ').trim(),
                        bg: toHex(style.backgroundColor),
                        color: toHex(style.color),
                    });
                });
                const rows = [];
                table.querySelectorAll('tbody tr, tr').forEach((row, i) => {
                    if (i === 0 && headers.length > 0 && row.querySelector('th')) return;
                    const cells = row.querySelectorAll('td, th');
                    if (cells.length === 0) return;
                    const rowData = {};
                    const rowStyle = window.getComputedStyle(row);
                    const rowMeta = { _row_bg: toHex(rowStyle.backgroundColor) };
                    cells.forEach((c, j) => {
                        const key = headers[j]?.text || `col_${j}`;
                        const cellStyle = window.getComputedStyle(c);
                        rowData[key] = {
                            text: c.innerText.replace(/\s+/g, ' ').trim(),
                            bg: toHex(cellStyle.backgroundColor),
                            color: toHex(cellStyle.color),
                            // Boutons/liens dans la cellule
                            actions: Array.from(c.querySelectorAll('button, a, [role="button"]')).map(btn => ({
                                text: btn.textContent.trim().substring(0, 50),
                                tag: btn.tagName.toLowerCase(),
                                href: btn.href || null,
                            })),
                        };
                    });
                    rows.push({ ...rowMeta, ...rowData });
                });
                return { headers: headers.map(h => h.text), headers_with_colors: headers, rows, count: rows.length, type: 'html-table' };
            }

            // Pseudo-table (divs avec role=grid, etc.)
            const roleRows = table.querySelectorAll('[role="row"], [style*="display: table-row"], [class*="row"]');
            if (roleRows.length > 0) {
                const rows = [];
                roleRows.forEach(row => {
                    const cells = row.querySelectorAll('[role="gridcell"], [role="columnheader"], [style*="display: table-cell"], [class*="cell"], [class*="col"]');
                    if (cells.length > 0) rows.push(Array.from(cells).map(c => c.innerText.replace(/\s+/g, ' ').trim()));
                });
                return { rows, count: rows.length, type: 'pseudo-table' };
            }

            return { text: table.innerText.substring(0, 5000), type: 'raw' };
        }, selector);
        res.json(data);
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== EXTRACT TEXT ========================
app.post('/extract_text', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector = 'body', include_hidden = false, include_frames = false, pierce_shadow = true } = req.body;
        const { locator } = await smartResolveLocator(page, selector);
        const text = include_hidden
            ? await locator.evaluate(el => el.textContent)
            : await locator.innerText();
        const clean = (t) => (t || '').replace(/\s+/g, ' ').trim();
        // Le texte PROPRE d'un shadow root (ouvert) n'apparaît jamais dans
        // innerText du document — seul le contenu « slotté » (DOM léger) y est.
        // Audit tools web 2026-09-05 : /shadowdom rendait la coquille.
        let shadowText = '';
        if (pierce_shadow !== false) {
            shadowText = await page.evaluate(() => {
                const parts = [];
                const textOf = (root) => {
                    let out = '';
                    const it = document.createNodeIterator(root, NodeFilter.SHOW_TEXT, {
                        acceptNode: n => { const p = n.parentElement; return p && /^(STYLE|SCRIPT|TEMPLATE|NOSCRIPT)$/.test(p.tagName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
                    });
                    let n; while ((n = it.nextNode())) out += n.textContent + ' ';
                    return out.replace(/\s+/g, ' ').trim();
                };
                const walk = (root, depth) => {
                    if (depth > 4) return;
                    for (const host of root.querySelectorAll('*')) {
                        const sr = host.shadowRoot; if (!sr) continue;
                        const t = textOf(sr);
                        if (t) parts.push(`[shadow ${host.tagName.toLowerCase()}] ${t.substring(0, 2000)}`);
                        walk(sr, depth + 1);
                    }
                };
                walk(document, 0);
                return parts.join('\n');
            }).catch(() => '');
        }
        // Le texte d'une <iframe> n'apparaît JAMAIS dans celui du document
        // parent : sur une appli encadrée, extract_text rendait la coquille et
        // rien d'autre. Opt-in pour ne pas mélanger les documents par défaut.
        if (include_frames) {
            const parts = [clean(text)];
            const kids = getAllFrames(page).filter(f => f !== page.mainFrame() && !f.isDetached());
            let read = 0;
            for (const f of kids) {
                try {
                    const ft = await Promise.race([
                        f.locator('body').innerText(),
                        new Promise(r => setTimeout(() => r(null), 2500)),
                    ]);
                    if (ft && clean(ft)) { parts.push(`\n[iframe ${f.url()}]\n` + clean(ft)); read++; }
                } catch (e) {}
            }
            if (shadowText) parts.push(shadowText);
            return res.json({
                text: parts.join('\n').substring(0, 80000),
                frames_read: read, frames_total: kids.length,
                ...(shadowText ? { shadow_text_included: true } : {}),
            });
        }
        res.json({ text: (clean(text) + (shadowText ? '\n' + shadowText : '')).substring(0, 80000),
                   ...(shadowText ? { shadow_text_included: true } : {}) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== MULTI-ONGLETS ========================
app.post('/new_tab', getSession, autoSnapshot, async (req, res) => {
    try {
        const { context } = req.session;
        const { url } = req.body;
        if (url) {
            const motif = await refusUrl(url);
            if (motif) return repondreRefus(res, url, motif);
        }
        const newPage = await context.newPage();
        attachDialogHandler(newPage, req.session.dialogState || (req.session.dialogState = makeDialogState()));
        attachPageLoggers(newPage, req.session.consoleLogs, req.session.networkLog);
        let navError = null;
        if (url) {
            // Même robustesse que /action : un goto qui lève ne doit pas
            // produire un 500 opaque (cf. nav_util.classifyNavOutcome).
            const prevUrl = newPage.url();   // about:blank pour un onglet neuf
            try {
                await newPage.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
            } catch (e) { navError = e.message; }
            // cf. /action : pas d'attente réseau si la nav a échoué (frame stuck).
            if (!navError) {
                await Promise.race([newPage.waitForLoadState('networkidle').catch(() => {}), newPage.waitForTimeout(3000)]);
            }
            let landed; try { landed = newPage.url(); } catch (_) { landed = prevUrl; }
            const outcome = classifyNavOutcome(url, prevUrl, landed, navError);
            if (outcome.httpStatus !== 200) {
                // Échec réel : on garde quand même l'onglet ouvert (about:blank)
                // mais on signale proprement l'erreur de navigation.
                req.session.tabs.push(newPage);
                return res.status(outcome.httpStatus).json({
                    ...outcome.body,
                    tab_index: req.session.tabs.length - 1,
                    total_tabs: req.session.tabs.length,
                });
            }
        }
        req.session.tabs.push(newPage);
        res.json({ status: 'success', tab_index: req.session.tabs.length - 1, url: newPage.url(), title: await newPage.title().catch(() => ''), total_tabs: req.session.tabs.length, ...(navError ? { nav_warning: navError } : {}) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/switch_tab', getSession, autoSnapshot, async (req, res) => {
    try {
        const { tab_index } = req.body;
        if (tab_index < 0 || tab_index >= req.session.tabs.length) return res.status(400).json({ error: `Tab ${tab_index} invalide.` });
        req.session.page = req.session.tabs[tab_index];
        await req.session.page.bringToFront();
        res.json({ status: 'success', tab_index, url: req.session.page.url(), title: await req.session.page.title().catch(() => '') });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/close_tab', getSession, autoSnapshot, async (req, res) => {
    try {
        const { tab_index } = req.body;
        if (req.session.tabs.length === 1) return res.status(400).json({ error: "Impossible de fermer le dernier onglet." });
        await req.session.tabs[tab_index].close();
        req.session.tabs.splice(tab_index, 1);
        req.session.page = req.session.tabs[Math.min(tab_index, req.session.tabs.length - 1)];
        await req.session.page.bringToFront();
        res.json({ status: 'closed', remaining_tabs: req.session.tabs.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/list_tabs', getSession, autoSnapshot, async (req, res) => {
    try {
        const tabs = [];
        for (let i = 0; i < req.session.tabs.length; i++) {
            const p = req.session.tabs[i];
            try { tabs.push({ index: i, url: p.url(), title: await p.title().catch(() => ''), active: p === req.session.page }); }
            catch (e) { tabs.push({ index: i, error: 'page closed' }); }
        }
        res.json({ tabs, count: tabs.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== LIST FRAMES ========================
app.get('/frames', getSession, autoSnapshot, async (req, res) => {
    try {
        const frames = getAllFrames(req.session.page).map((f, i) => ({ index: i, url: f.url(), name: f.name(), isMain: f === req.session.page.mainFrame(), isDetached: f.isDetached() }));
        res.json({ frames, count: frames.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== CLIPBOARD ========================
app.post('/clipboard', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { action, text } = req.body;
        if (action === 'copy') { await page.keyboard.press('Control+c'); const content = await page.evaluate(() => navigator.clipboard.readText()).catch(() => null); return res.json({ status: 'success', text: content }); }
        if (action === 'paste') { if (text) await page.evaluate(t => navigator.clipboard.writeText(t), text); await page.keyboard.press('Control+v'); return res.json({ status: 'success' }); }
        if (action === 'select_all') { await page.keyboard.press('Control+a'); return res.json({ status: 'success' }); }
        if (action === 'cut') { await page.keyboard.press('Control+x'); return res.json({ status: 'success' }); }
        if (action === 'read') { return res.json({ text: await page.evaluate(() => navigator.clipboard.readText()).catch(() => null) }); }
        res.status(400).json({ error: `Action clipboard inconnue: ${action}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== MUTATION OBSERVER ========================
app.post('/watch_changes', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector = 'body', timeout = 10000, attribute_filter } = req.body;
        const changes = await page.evaluate(({ selector, timeout, attribute_filter }) => {
            return new Promise((resolve) => {
                const target = document.querySelector(selector);
                if (!target) { resolve({ error: 'Element not found' }); return; }
                const mutations = [];
                const config = { childList: true, subtree: true, attributes: true, characterData: true };
                if (attribute_filter) config.attributeFilter = attribute_filter;
                const observer = new MutationObserver(list => {
                    for (const m of list) {
                        if (m.type === 'childList') {
                            m.addedNodes.forEach(n => { if (n.nodeType === Node.ELEMENT_NODE) mutations.push({ type: 'added', tag: n.tagName, text: n.textContent?.trim().substring(0, 100) }); });
                            m.removedNodes.forEach(n => { if (n.nodeType === Node.ELEMENT_NODE) mutations.push({ type: 'removed', tag: n.tagName, text: n.textContent?.trim().substring(0, 100) }); });
                        } else if (m.type === 'attributes') {
                            mutations.push({ type: 'attr_changed', attr: m.attributeName, tag: m.target.tagName, newValue: m.target.getAttribute(m.attributeName)?.substring(0, 100) });
                        } else if (m.type === 'characterData') {
                            mutations.push({ type: 'text_changed', text: m.target.textContent?.substring(0, 100) });
                        }
                    }
                });
                observer.observe(target, config);
                setTimeout(() => { observer.disconnect(); resolve(mutations); }, timeout);
            });
        }, { selector, timeout, attribute_filter });
        res.json({ changes, count: changes.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== PDF / PRINT ========================
app.post('/print_pdf', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const filename = `page_${req.body.session_id}_${Date.now()}.pdf`;
        const dossier = path.join(DOWNLOAD_DIR, req.session.owner);
        fs.mkdirSync(dossier, { recursive: true });
        const filepath = path.join(dossier, filename);
        await page.pdf({ path: filepath, format: 'A4', printBackground: true, margin: { top: '1cm', bottom: '1cm', left: '1cm', right: '1cm' } });
        res.json({ status: 'success', file: filename, path: filepath });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== EVALUATE JS ========================
app.post('/evaluate', getSession, autoSnapshot, async (req, res) => {
    try {
        const { script, in_all_frames = false } = req.body;
        const { page } = req.session;
        if (!script || typeof script !== 'string') {
            return res.status(400).json({ error: 'script (string) required' });
        }
        // Wrap script as an async function body. Supports both expression-style
        // ("document.title") and statement-style ("return document.title").
        // Auto-`return` the expression if no `return` keyword is present.
        const hasReturn = /\breturn\b/.test(script);
        const fnBody = hasReturn ? script : `return (${script});`;
        if (in_all_frames) {
            const results = [];
            for (const frame of page.frames()) {
                if (frame.isDetached()) continue;
                try {
                    const r = await frame.evaluate(async (body) => {
                        const fn = new Function(`return (async () => { ${body} })();`);
                        return await fn();
                    }, fnBody);
                    results.push({ frame: frame.url(), result: r });
                } catch (e) { results.push({ frame: frame.url(), error: e.message }); }
            }
            return res.json({ results });
        }
        const result = await page.evaluate(async (body) => {
            const fn = new Function(`return (async () => { ${body} })();`);
            return await fn();
        }, fnBody);
        res.json({ result });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== SAVE STATE ========================
app.post('/save_state', getSession, autoSnapshot, async (req, res) => {
    try {
        const nom = stateFileName(req.session.owner, req.body.session_id);
        if (!nom) return res.status(400).json({ error: 'Identifiant de session invalide.' });
        await req.session.context.storageState({ path: path.join(COOKIES_DIR, nom) });
        res.json({ status: 'saved', state_id: req.body.session_id });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== STOP ========================
app.post('/stop', getSession, async (req, res) => {
    // Capture les objets vidéo AVANT close (le chemin n'est résolu qu'après).
    const vids = [];
    try { for (const pg of (req.session.tabs || [req.session.page])) { const v = pg.video && pg.video(); if (v) vids.push(v); } } catch {}
    try { if (req.session.traceActive) await req.session.context.tracing.stop().catch(() => {}); } catch {}
    // Même fermeture que le reaper (captures nettoyées, session retirée) ; le
    // verrou de la session est déjà tenu par cette requête.
    await closeSession(req.sessionId, 'stop', { lockHeld: true });
    const video_urls = [];
    for (const v of vids) { try { const p = await v.path(); if (p) video_urls.push(`/videos/${path.basename(p)}`); } catch {} }
    res.json({ status: 'closed', ...(video_urls.length ? { video_urls } : {}) });
});

// ======================== TRACE EXPORT (Phase 5) ========================
// Arrête le tracing et écrit un .zip ouvrable avec `npx playwright show-trace`.
app.post('/trace_export', getSession, async (req, res) => {
    try {
        if (!req.session.traceActive) return res.json({ ok: false, error: 'tracing non actif (démarre la session avec trace=true)' });
        const file = `trace_${req.body.session_id}_${Date.now()}.zip`;
        await req.session.context.tracing.stop({ path: path.join(TRACE_DIR, file) });
        req.session.traceActive = false;
        res.json({ ok: true, trace_url: `/traces/${file}`, hint: 'Ouvre avec: npx playwright show-trace <fichier>' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== HEALTH ========================
// Seul /health du service : état global (sans URL ni identifiant de
// session), plus la liste des sessions du propriétaire s'il est indiqué.
const _DEMARRAGE = Date.now();
app.get('/health', (req, res) => {
    const now = Date.now();
    const owner = ownerFromRequest(req);
    const sessionList = [];
    for (const [sid, s] of sessions) {
        if (!owner || s.owner !== owner) continue;
        sessionList.push({
            id: sid.substring(0, 8) + '…',
            idle_sec: Math.round((now - (s.lastActivity || now)) / 1000),
            age_sec: Math.round((now - (s.createdAt || now)) / 1000),
            url: s.page?.url?.()?.substring(0, 80) || '?',
            tabs: s.tabs?.length || 1,
        });
    }
    res.json({
        ok: true,
        service: 'browser',
        status: 'running',
        engine: BROWSER_ENGINE,
        uptime_sec: Math.round((now - _DEMARRAGE) / 1000),
        sessions: sessions.size,
        max_sessions: MAX_SESSIONS,
        session_ttl_min: SESSION_TTL_MS / 60000,
        browser_connected: globalBrowser?.isConnected() || false,
        url_allowlist: !listeBlancheCourante().vide,
        ...(owner ? { session_list: sessionList } : {}),
    });
});


// ======================== WAIT FOR DYNAMIC ELEMENT ========================
// Attend qu'un élément apparaisse / disparaisse / change, par polling.
//
// Audit tools web 2026-09-05 (P0) — les conditions texte/compte/attribut
// passaient par `document.querySelector(sel)` : toute syntaxe Playwright
// (`text=`, `label=`, `xpath=`, `css=#x`, ref) LEVAIT dans le evaluate, et
// l'exception était avalée par la boucle → attente expirée alors que
// `pw_expect text-contains` sur la MÊME cible passait en 8 ms. On résout
// maintenant EXACTEMENT comme /expect : locatorFromParams (by_*/ref) puis
// smartResolveLocator sur la chaîne. Chaque réponse — 200 comme 408 — porte
// `polled_value` (ce que l'élément montrait en dernier) et `via`.
// `baseline` : état initial repassé par le client entre deux tranches de
// polling, pour que text_changes/count_* ne repartent pas de zéro.
app.post('/wait_for_dynamic', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const {
            selector,
            condition = 'visible',   // visible | hidden | attached | detached | text_contains | text_changes | attribute_changes | count_increases | count_decreases
            expected_text = '',
            attribute = '',
            expected_value = '',
            timeout = 15000,
            poll_interval = 200,
            baseline = null,
            ref, by_role, by_name, by_text, by_label, by_placeholder,
            by_test_id, by_alt, by_title, by_css, by_xpath, nth,
        } = req.body;

        const start = Date.now();
        const params = { ref, by_role, by_name, by_text, by_label, by_placeholder, by_test_id, by_alt, by_title, by_css, by_xpath, nth };
        let loc = locatorFromParams(page, params, req.sessionId, { first: false });
        let via = loc ? 'official' : null;
        if (!loc && selector) {
            const r = await smartResolveLocator(page, selector).catch(() => null);
            if (r && r.locator) { loc = r.locator; via = `smart:${r.strategy || 'selector'}`; }
        }
        if (!loc && selector) { loc = page.locator(selector); via = 'raw'; }
        if (!loc) return res.status(400).json({ error: 'selector or by_* params required', condition });
        const first = loc.first();
        const label = selector || describeLocator(params, { first: false }) || '?';

        let polled = null;
        const probe = async () => {
            const count = await loc.count().catch(() => 0);
            if (!count) return { count: 0, text: null, attr: null, visible: false };
            const text = ((await first.textContent({ timeout: 800 }).catch(() => null)) || '').replace(/\s+/g, ' ').trim().substring(0, 500);
            const attr = attribute ? await first.getAttribute(attribute, { timeout: 800 }).catch(() => null) : null;
            const visible = await first.isVisible().catch(() => false);
            return { count, text, attr, visible };
        };
        const done = (status, extra = {}) => res.json({
            status, condition, selector: label, via, elapsed_ms: Date.now() - start, polled_value: polled, ...extra,
        });
        const notYet = (msg, extra = {}) => res.status(408).json({
            error: msg, condition, selector: label, via, elapsed_ms: Date.now() - start, polled_value: polled, ...extra,
        });

        // Cas Playwright natif : états du locator
        if (['visible', 'hidden', 'attached', 'detached'].includes(condition)) {
            try {
                await first.waitFor({ state: condition, timeout });
                polled = await probe();
                const box = condition === 'visible' ? await first.boundingBox().catch(() => null) : null;
                return done(condition === 'visible' ? 'found' : condition, box ? { box } : {});
            } catch (e) {
                polled = await probe();
                return notYet(`Timeout: '${label}' not ${condition} within ${timeout}ms`);
            }
        }
        const KNOWN = ['text_contains', 'text_changes', 'count_increases', 'count_decreases', 'attribute_changes'];
        if (!KNOWN.includes(condition)) return res.status(400).json({ error: `unknown condition '${condition}'`, hint: 'visible|hidden|attached|detached|' + KNOWN.join('|') });

        // Ligne de base : celle du client (tranche précédente) sinon l'état courant
        const initial = (baseline && typeof baseline === 'object') ? baseline : await probe();
        polled = initial;
        while (Date.now() - start < timeout) {
            const cur = await probe();
            polled = cur;
            if (condition === 'text_contains' && cur.count && cur.text.includes(expected_text))
                return done('matched', { text: cur.text });
            if (condition === 'text_changes' && cur.count && initial.text !== null && cur.text !== initial.text)
                return done('changed', { from: initial.text, to: cur.text });
            if (condition === 'count_increases' && cur.count > (initial.count || 0))
                return done('changed', { from: initial.count || 0, to: cur.count });
            if (condition === 'count_decreases' && cur.count < (initial.count || 0))
                return done('changed', { from: initial.count || 0, to: cur.count });
            if (condition === 'attribute_changes' && attribute && cur.count) {
                if (expected_value && cur.attr === expected_value) return done('matched', { attribute, value: cur.attr });
                if (!expected_value && initial.attr !== null && cur.attr !== initial.attr) return done('changed', { attribute, from: initial.attr, to: cur.attr });
            }
            await page.waitForTimeout(poll_interval);
        }
        return notYet(`Timeout after ${timeout}ms — condition '${condition}' on '${label}' not met`, { baseline: initial });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== DISPATCH EVENT ========================
// Déclenche n'importe quel événement DOM sur un élément
app.post('/dispatch_event', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const {
            selector,
            event,          // 'click' | 'input' | 'change' | 'focus' | 'blur' | 'keydown' | ...
            event_type = 'Event',  // 'Event' | 'MouseEvent' | 'KeyboardEvent' | 'InputEvent' | 'CustomEvent'
            event_init = {},       // propriétés de l'événement
            use_native = true,     // true = déclenche aussi l'event natif Playwright si possible
        } = req.body;

        if (!selector || !event) return res.status(400).json({ error: 'selector et event requis' });

        const { locator, strategy } = await smartResolveLocator(page, selector);

        // Déclencher via Playwright natif si possible
        if (use_native) {
            if (event === 'click') { await locator.click({ timeout: 5000 }).catch(() => {}); }
            else if (event === 'focus') { await locator.focus({ timeout: 3000 }).catch(() => {}); }
            else if (event === 'blur') { await locator.blur({ timeout: 3000 }).catch(() => {}); }
        }

        // Dispatch JS complet pour les événements custom ou non-natifs
        const result = await locator.evaluate((el, { event, event_type, event_init }) => {
            let evt;
            switch (event_type) {
                case 'MouseEvent':
                    evt = new MouseEvent(event, { bubbles: true, cancelable: true, ...event_init });
                    break;
                case 'KeyboardEvent':
                    evt = new KeyboardEvent(event, { bubbles: true, cancelable: true, ...event_init });
                    break;
                case 'InputEvent':
                    evt = new InputEvent(event, { bubbles: true, ...event_init });
                    break;
                case 'FocusEvent':
                    evt = new FocusEvent(event, { bubbles: ['focusin','focusout'].includes(event), ...event_init });
                    break;
                case 'CustomEvent':
                    evt = new CustomEvent(event, { bubbles: true, detail: event_init.detail || null });
                    break;
                default:
                    evt = new Event(event, { bubbles: true, cancelable: true, ...event_init });
            }
            el.dispatchEvent(evt);
            return { dispatched: true, event, tag: el.tagName, id: el.id };
        }, { event, event_type, event_init });

        res.json({ status: 'success', ...result, strategy });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== TRIGGER REACT/VUE/ANGULAR ========================
// Force la mise à jour des frameworks JS en simulant une vraie saisie utilisateur
app.post('/trigger_framework_update', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { selector, value, framework = 'auto' } = req.body;

        if (!selector) return res.status(400).json({ error: 'selector requis' });

        const { locator } = await smartResolveLocator(page, selector);
        const tag = await locator.evaluate(el => el.tagName.toLowerCase()).catch(() => 'input');

        const detected = await locator.evaluate((el, { value, framework }) => {
            const tag = el.tagName.toLowerCase();
            const results = [];

            // ─── Détection framework ───
            let fw = framework;
            if (fw === 'auto') {
                if (el._reactFiber || el.__reactFiber || el.__reactProps || document.querySelector('[data-reactroot]')) fw = 'react';
                else if (el.__vue__ || el.__vue3 || document.querySelector('[data-v-app]')) fw = 'vue';
                else if (window.ng || document.querySelector('[ng-version]')) fw = 'angular';
                else fw = 'vanilla';
            }

            // ─── React : passer par le synthetic event system ───
            if (fw === 'react') {
                try {
                    // React 16+
                    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
                        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
                    if (nativeInputValueSetter && value !== undefined) {
                        nativeInputValueSetter.call(el, value);
                        results.push('react:native-setter');
                    }
                    // Déclencher les events dans l'ordre exact React
                    ['focus', 'keydown', 'keypress', 'input', 'keyup', 'change', 'blur'].forEach(evName => {
                        const evCls = ['keydown','keypress','keyup'].includes(evName) ? KeyboardEvent
                            : ['focus','blur'].includes(evName) ? FocusEvent : Event;
                        el.dispatchEvent(new evCls(evName, { bubbles: true, cancelable: true }));
                    });
                    results.push('react:events-dispatched');
                } catch (e) { results.push('react:error:' + e.message); }
            }

            // ─── Vue 3 : proxy reactif ───
            if (fw === 'vue') {
                try {
                    if (value !== undefined) el.value = value;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    results.push('vue:events');
                    // Vue 3 internal update
                    const __vue = el.__vueParentComponent;
                    if (__vue?.emit) { __vue.emit('update:modelValue', value); results.push('vue:emit'); }
                } catch (e) { results.push('vue:error:' + e.message); }
            }

            // ─── Angular : NgModel zone trigger ───
            if (fw === 'angular') {
                try {
                    if (value !== undefined) el.value = value;
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    // Angular Zone.js
                    if (window.getAllAngularRootElements) {
                        const ngZone = window.ng?.getComponent?.(el)?.ngZone;
                        if (ngZone) { ngZone.run(() => {}); results.push('angular:zone'); }
                    }
                    results.push('angular:events');
                } catch (e) { results.push('angular:error:' + e.message); }
            }

            // ─── Vanilla / fallback ───
            if (fw === 'vanilla' || results.length === 0) {
                try {
                    if (value !== undefined) el.value = value;
                    ['input', 'change', 'blur'].forEach(evName => {
                        el.dispatchEvent(new Event(evName, { bubbles: true }));
                    });
                    results.push('vanilla:events');
                } catch (e) { results.push('vanilla:error:' + e.message); }
            }

            return { fw, results, tag: el.tagName, currentValue: el.value };
        }, { value, framework });

        res.json({ status: 'success', ...detected });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== POLL UNTIL ========================
// Exécute un script JS en boucle jusqu'à ce qu'il retourne true
app.post('/poll_until', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const {
            script,           // JS retournant true/false : "return document.querySelector('#result') !== null"
            timeout = 15000,
            poll_interval = 300,
        } = req.body;

        if (!script) return res.status(400).json({ error: 'script requis' });

        try {
            await page.waitForFunction(
                new Function(script),
                {},
                { timeout, polling: poll_interval }
            );
            // Capturer le résultat final
            const finalValue = await page.evaluate(new Function(script)).catch(() => null);
            return res.json({ status: 'success', result: finalValue, elapsed_ms: timeout });
        } catch (e) {
            return res.status(408).json({ error: `Timeout après ${timeout}ms — condition non atteinte`, script });
        }
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== INTERCEPT NEXT DIALOG ========================
// Configure la gestion du prochain dialog avant de déclencher l'action qui l'ouvre
// ======================== DIALOGUE : POLITIQUE ARMABLE ====================
// Contrairement à /handle_next_dialog (qui retient la réponse HTTP jusqu'à ce
// qu'un dialogue apparaisse — inutilisable pour un agent, qui doit rendre la
// main pour déclencher l'action qui l'ouvre), on arme et on rend la main tout
// de suite. Le handler global consulte la politique au moment voulu.
app.post('/dialog', getSession, async (req, res) => {
    try {
        const s = req.session;
        s.dialogState = s.dialogState || makeDialogState();
        const st = s.dialogState;
        st.history = st.history || [];
        const { action = 'status', input_text = '', times = 1, sticky = false } = req.body;
        // Audit tools web 2026-09-05 — status disait {armed, last, seen} : ni ce
        // qui s'applique quand rien n'est armé, ni l'historique, ni si le
        // dernier dialogue a suivi la politique armée ou le défaut.
        const view = () => ({
            armed: st.pending, last: st.last, seen: st.count,
            history: st.history.slice(-10),
            last_policy: st.last ? st.last.policy : null,
            default_when_unarmed: DIALOG_DEFAULT_WHEN_UNARMED,
            sticky: !!(st.pending && st.pending.sticky),
        });

        if (action === 'status') return res.json({ status: 'success', ...view() });
        if (action === 'reset') { st.pending = null; return res.json({ status: 'success', ...view() }); }
        if (action !== 'accept' && action !== 'dismiss') {
            return res.status(400).json({ error: `unknown dialog action "${action}"`, hint: 'accept|dismiss|status|reset' });
        }
        st.pending = {
            action,
            input_text: String(input_text || ''),
            remaining: Math.max(1, Math.min(parseInt(times, 10) || 1, 20)),
            sticky: sticky === true || sticky === 'true',
        };
        res.json({ status: 'armed', ...view() });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


app.post('/handle_next_dialog', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const {
            action = 'accept',   // accept | dismiss
            input_text = '',     // Pour les prompt() dialogs
            timeout = 10000,
        } = req.body;

        // Remplacer le handler dialog par défaut pour la prochaine occurrence seulement
        let resolved = false;
        const handler = async (dialog) => {
            if (resolved) return;
            resolved = true;
            page.off('dialog', handler);
            const type = dialog.type();
            const message = dialog.message();
            try {
                if (action === 'dismiss') await dialog.dismiss();
                else if (input_text && type === 'prompt') await dialog.accept(input_text);
                else await dialog.accept();
                res.json({ status: 'handled', dialog_type: type, message, action });
            } catch (e) {
                res.json({ status: 'handled_error', error: e.message, dialog_type: type });
            }
        };

        page.on('dialog', handler);

        // Timeout si aucun dialog n'apparaît
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                page.off('dialog', handler);
                res.json({ status: 'no_dialog', timeout_ms: timeout });
            }
        }, timeout);

    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ==========================================
// SCREENSHOT ON FAILURE (Feature 4)
// ==========================================
async function screenshotOnFailure(page, sid, context = '') {
    try {
        const fname = `fail_${(sid || 'unknown').substring(0, 8)}_${Date.now()}.png`;
        const fpath = path.join(SCREENSHOT_DIR, fname);
        await page.screenshot({ path: fpath, fullPage: false });
        return { screenshot_path: fpath, screenshot_file: fname };
    } catch (e) { return {}; }
}

// ==========================================
// SMART RETRY CONTEXT (Feature 3)
// ==========================================
async function findAlternatives(page, failedSelector, maxSuggestions = 5) {
    try {
        return await page.evaluate(({ selector, max }) => {
            const results = [];
            // Gather all interactive elements
            const interactives = document.querySelectorAll(
                'button, a, input, select, textarea, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [onclick], [tabindex]'
            );
            const needle = (selector || '').toLowerCase().trim();

            for (const el of interactives) {
                if (results.length >= max) break;
                const text = (el.textContent || '').trim().substring(0, 80);
                const ariaLabel = el.getAttribute('aria-label') || '';
                const placeholder = el.getAttribute('placeholder') || '';
                const title = el.getAttribute('title') || '';
                const rect = el.getBoundingClientRect();

                if (rect.width === 0 || rect.height === 0) continue;
                if (!el.offsetParent && el.tagName !== 'BODY') continue; // hidden

                // Score similarity
                const haystack = `${text} ${ariaLabel} ${placeholder} ${title}`.toLowerCase();
                if (!needle || haystack.includes(needle) || needle.split(' ').some(w => w.length > 2 && haystack.includes(w))) {
                    const tag = el.tagName.toLowerCase();
                    const id = el.id ? `#${el.id}` : '';
                    const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(' ')[0]}` : '';
                    results.push({
                        selector: id || `${tag}${cls}`,
                        tag,
                        text: text.substring(0, 60),
                        aria_label: ariaLabel.substring(0, 40),
                        rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
                        center: { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
                    });
                }
            }
            return results;
        }, { selector: failedSelector, max: maxSuggestions });
    } catch (e) { return []; }
}

// ==========================================
// ACTION CHAINING (Feature 2) — v2: prefers by_* params over selector strings
// ==========================================
app.post('/chain', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const { actions = [], stop_on_error = true, screenshot_on_fail = true } = req.body;

        if (!Array.isArray(actions) || actions.length === 0)
            return res.status(400).json({ error: 'actions[] required (array of action objects)' });
        if (actions.length > 30)
            return res.status(400).json({ error: 'Max 30 actions per chain' });

        // Resolve a chain step's target. Prefers `ref` and explicit `by_*`
        // params (Playwright official API — robust). Falls back to a
        // `selector` string parsed by smartResolveLocator (text/CSS/XPath).
        async function resolveChainTarget(act) {
            const params = {
                ref: act.ref,
                by_role: act.by_role, by_name: act.by_name, by_text: act.by_text,
                by_label: act.by_label, by_placeholder: act.by_placeholder,
                by_test_id: act.by_test_id, by_alt: act.by_alt, by_title: act.by_title,
                by_css: act.by_css, by_xpath: act.by_xpath, nth: act.nth,
            };
            const hasOfficial = Object.values(params).some(v => v !== undefined && v !== null && v !== '');
            if (hasOfficial) {
                const loc = locatorFromParams(page, params, req.sessionId);
                if (loc) return { locator: loc, source: 'official' };
            }
            if (act.selector) {
                const r = await smartResolveLocator(page, act.selector);
                if (r && r.locator) return { locator: r.locator, source: r.strategy || 'selector' };
            }
            throw new Error('No target: provide by_*/ref or selector');
        }

        const results = [];
        let failed = false;

        for (let i = 0; i < actions.length; i++) {
            const act = actions[i];
            const actType = act.type || act.action || '';
            const startMs = Date.now();

            try {
                let result;

                switch (actType) {
                    case 'click':
                    case 'smart_click': {
                        // For click we still prefer smartClick when only a selector is given
                        // (it has the 7-strategy cascade for tricky pages). But when by_* is
                        // present we use the official locator path for max robustness.
                        const hasOfficial = act.ref || act.by_role || act.by_text || act.by_label
                            || act.by_placeholder || act.by_test_id || act.by_css || act.by_xpath;
                        if (hasOfficial) {
                            const { locator } = await resolveChainTarget(act);
                            await locator.click({ timeout: act.timeout || 8000, button: act.button || 'left' });
                            result = { success: true, action: 'click', strategy: 'official' };
                        } else {
                            result = await smartClick(page, act.selector, {
                                human: act.human, button: act.button || 'left', timeout: act.timeout || 8000
                            });
                        }
                        break;
                    }

                    case 'fill': {
                        const { locator } = await resolveChainTarget(act);
                        try { await locator.fill(act.text || act.value || '', { timeout: 5000 }); }
                        catch {
                            await locator.evaluate((el, val) => {
                                el.focus(); el.value = val;
                                el.dispatchEvent(new Event('input', { bubbles: true }));
                                el.dispatchEvent(new Event('change', { bubbles: true }));
                            }, act.text || act.value || '');
                        }
                        result = { success: true, action: 'fill' };
                        break;
                    }

                    case 'type': {
                        const { locator } = await resolveChainTarget(act);
                        await locator.click({ timeout: 3000 }).catch(() => {});
                        await locator.pressSequentially(act.text || act.value || '', { delay: act.delay || 50 });
                        result = { success: true, action: 'type' };
                        break;
                    }

                    case 'press': {
                        const hasTarget = act.ref || act.by_role || act.by_text || act.by_label
                            || act.by_placeholder || act.by_test_id || act.by_css || act.by_xpath || act.selector;
                        if (hasTarget) {
                            const { locator } = await resolveChainTarget(act);
                            await locator.press(act.key);
                        } else {
                            await page.keyboard.press(act.key);
                        }
                        result = { success: true, action: 'press', key: act.key };
                        break;
                    }

                    case 'select':
                    case 'select_option': {
                        const { locator } = await resolveChainTarget(act);
                        // Même résolution sans essai-erreur que /action : on lit les
                        // <option> puis on choisit UNE fois. L'échelle value→label
                        // consommait deux timeouts pleins, et le recorder ne savait
                        // pas ce qui avait été choisi (audit tools web 2026-09-05).
                        const picked = await selectOptionSmart(locator, {
                            option_value: act.option_value, option_label: act.option_label || act.label,
                            value: act.value, text: act.text, timeout: act.timeout || 8000 });
                        result = { success: true, action: 'select', selected: picked };
                        break;
                    }

                    case 'check': {
                        const { locator } = await resolveChainTarget(act);
                        if (act.checked !== false) await locator.check();
                        else await locator.uncheck();
                        result = { success: true, action: 'check' };
                        break;
                    }
                    case 'uncheck': {
                        const { locator } = await resolveChainTarget(act);
                        await locator.uncheck();
                        result = { success: true, action: 'uncheck' };
                        break;
                    }

                    case 'wait':
                        if (act.selector) await page.waitForSelector(act.selector, { state: 'visible', timeout: act.timeout || 10000 });
                        else if (act.wait_for === 'network') await Promise.race([page.waitForLoadState('networkidle'), page.waitForTimeout(6000)]);
                        else if (act.ms) await page.waitForTimeout(act.ms);
                        else await page.waitForTimeout(1000);
                        result = { success: true, action: 'wait' };
                        break;

                    case 'scroll':
                        await page.mouse.wheel(0, act.amount || 500);
                        result = { success: true, action: 'scroll' };
                        break;

                    case 'goto': {
                        const _motif = await refusUrl(act.url);
                        if (_motif) throw new Error(messageRefus(act.url, _motif));
                        await page.goto(act.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        await Promise.race([page.waitForLoadState('networkidle').catch(() => {}), page.waitForTimeout(2000)]);
                        result = { success: true, action: 'goto', url: page.url() };
                        break;
                    }

                    case 'hover': {
                        const { locator } = await resolveChainTarget(act);
                        await locator.hover({ timeout: 5000 });
                        result = { success: true, action: 'hover' };
                        break;
                    }

                    case 'focus': {
                        const { locator } = await resolveChainTarget(act);
                        await locator.focus({ timeout: 5000 });
                        result = { success: true, action: 'focus' };
                        break;
                    }

                    default:
                        result = { success: false, error: `Unknown chain action: ${actType}` };
                }

                // Post-action wait
                if (act.wait_after) await postActionWait(page, act.wait_after);

                // Recorder hook (no-op when not recording)
                if (result && result.success !== false) {
                    recordEvent(req.session, {
                        action: actType === 'select_option' ? 'select' : actType,
                        locator: {
                            role: act.by_role, name: act.by_name, text: act.by_text,
                            label: act.by_label, placeholder: act.by_placeholder,
                            test_id: act.by_test_id, css: act.by_css, xpath: act.by_xpath,
                        },
                        selector: act.selector,
                        ref: act.ref,
                        value: act.text || act.value,
                        ...(result && result.selected ? { value: result.selected.value, option_label: result.selected.label, selected: result.selected } : {}),
                        key: act.key,
                        url: page.url(),
                    });
                }

                results.push({ step: i, action: actType, duration_ms: Date.now() - startMs, ...result });

            } catch (e) {
                const failResult = {
                    step: i, action: actType, success: false, error: (e.message || String(e)).substring(0, 200),
                    duration_ms: Date.now() - startMs,
                };

                // Feature 3: Smart retry context — try selector or any text-bearing param
                const probe = act.selector || act.by_name || act.by_text || act.by_label || '';
                if (probe) {
                    failResult.alternatives = await findAlternatives(page, probe).catch(() => []);
                }

                // Feature 4: Screenshot on failure
                if (screenshot_on_fail) {
                    const ss = await screenshotOnFailure(page, req.sessionId, actType);
                    Object.assign(failResult, ss);
                }

                results.push(failResult);
                failed = true;

                if (stop_on_error) break;
            }
        }

        res.json({
            ok: !failed,
            total: actions.length,
            executed: results.length,
            failed: failed ? results.filter(r => !r.success).length : 0,
            results,
        });

    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ======================== SESSION LIST (admin) ========================
app.get('/sessions', (req, res) => {
    const now = Date.now();
    const owner = ownerFromRequest(req);
    const list = [];
    for (const [sid, s] of sessions) {
        // Seulement les sessions du propriétaire (aucune sans propriétaire).
        if (!owner || s.owner !== owner) continue;
        list.push({
            session_id: sid,
            owner: s.owner || null,
            idle_sec: Math.round((now - (s.lastActivity || now)) / 1000),
            age_sec: Math.round((now - (s.createdAt || now)) / 1000),
            url: s.page?.url?.()?.substring(0, 120) || '?',
            tabs: s.tabs?.length || 1,
            ttl_remaining_sec: Math.max(0, Math.round((SESSION_TTL_MS - (now - (s.lastActivity || now))) / 1000)),
        });
    }
    res.json({ count: list.length, max: MAX_SESSIONS, ttl_min: SESSION_TTL_MS / 60000, sessions: list });
});

// ======================== FORCE CLEANUP ========================
app.post('/cleanup', async (req, res) => {
    // Ferme les sessions du SEUL propriétaire appelant.
    const owner = ownerFromRequest(req);
    if (!owner) return res.status(400).json({ error: 'owner requis.' });
    const siennes = [...sessions].filter(([, s]) => s.owner === owner).map(([sid]) => sid);
    for (const sid of siennes) await closeSession(sid, 'force_cleanup');
    killZombieProcesses();
    res.json({ cleaned: siennes.length });
});

// Cleanup les screenshots de session(s) sans fermer les sessions Playwright.
// Usage : appelé par le frontend quand il n'a plus besoin des images affichées
// (nouveau message, navigation, fermeture d'onglet via beacon).
// Body : { session_ids: ["sid1", "sid2", ...] }
app.post('/cleanup_screenshots', async (req, res) => {
    const sids = (req.body && req.body.session_ids) || [];
    if (!Array.isArray(sids)) return res.status(400).json({ error: 'session_ids must be an array' });
    let cleaned = 0;
    for (const sid of sids) {
        if (typeof sid === 'string' && sid.length >= 8 && sid.length <= 64 && /^[A-Za-z0-9\-]+$/.test(sid)) {
            cleanupSessionScreenshots(sid);
            cleaned++;
        }
    }
    res.json({ cleaned });
});


// ════════════════════════════════════════════════════════════════════
// MISSING ENDPOINTS — added v5.1 (matching firefox_tools.py contract)
// ════════════════════════════════════════════════════════════════════
// These endpoints back pw_expect, pw_observe, pw_mock, pw_recorder, and
// pw_page("screenshot", target=...). They were callable from the Python
// side but the server returned 404 on every call. Now implemented.

// ── Unified locator resolver ────────────────────────────────────────
// Accepts the same shape used by /action: { ref, by_role, by_name, by_text,
// by_label, by_placeholder, by_test_id, by_alt, by_title, by_css, by_xpath, nth }.
// Returns a Playwright Locator or null. Used by /expect and /element_screenshot.
// `first` = restreindre au premier match (défaut : oui — une action ne vise
// qu'un élément). Les assertions de COMPTAGE doivent au contraire garder le
// locator ENTIER : avec .first(), count() ne peut jamais rendre plus de 1, et
// `count-gte` répondait pass=false sur une page qui contenait bien N éléments
// (mesuré : 2 tables, count-gte 2 → false, après 5 s de polling inutile).
function locatorFromParams(page, params, sid = null, { first = true } = {}) {
    if (!params) return null;
    const { ref, ...byParams } = params;
    if (ref) {
        const [baseRef, idxStr] = String(ref).split('#');
        let loc = resolveRef(baseRef, page, sid);
        if (loc && idxStr !== undefined) loc = loc.nth(parseInt(idxStr, 10));
        return loc || null;
    }
    if (Object.values(byParams).some(v => v !== undefined && v !== null && v !== '')) {
        const loc = resolveOfficialLocator(page, byParams);
        if (!loc) return null;
        return first ? loc.first() : loc;
    }
    return null;
}


// ── /expect : assertion primitive for IHM testing ────────────────────
app.post('/expect', getSession, autoSnapshot, async (req, res) => {
    const startMs = Date.now();
    try {
        const { page } = req.session;
        const {
            assertion, value = '', timeout_ms = 5000,
            ref, by_role, by_name, by_text, by_label, by_placeholder,
            by_test_id, by_alt, by_title, by_css, by_xpath, nth,
        } = req.body;

        if (!assertion) return res.status(400).json({ error: 'assertion= required' });

        const params = { ref, by_role, by_name, by_text, by_label, by_placeholder, by_test_id, by_alt, by_title, by_css, by_xpath, nth };
        const hasTarget = Object.values(params).some(v => v !== undefined && v !== null && v !== '');

        // ── Page-level assertions (no target needed) ──
        const pageAssertions = ['url-equals', 'url-contains', 'url-matches', 'title-contains', 'title-equals'];
        if (pageAssertions.includes(assertion)) {
            // Brief poll loop for url/title — they may settle after a navigation.
            const deadline = Date.now() + timeout_ms;
            let actual = '', pass = false;
            while (Date.now() < deadline) {
                if (assertion === 'url-equals')      { actual = page.url(); pass = actual === value; }
                else if (assertion === 'url-contains') { actual = page.url(); pass = actual.includes(value); }
                else if (assertion === 'url-matches')  { actual = page.url(); try { pass = new RegExp(value).test(actual); } catch (e) { return res.status(400).json({ error: `Invalid regex: ${e.message}` }); } }
                else if (assertion === 'title-equals') { actual = await page.title().catch(() => ''); pass = actual === value; }
                else if (assertion === 'title-contains') { actual = await page.title().catch(() => ''); pass = actual.includes(value); }
                if (pass) break;
                await new Promise(r => setTimeout(r, 200));
            }
            return res.json({ pass, assertion, expected: value, actual, duration_ms: Date.now() - startMs });
        }

        // ── Element assertions (need a target) ──
        if (!hasTarget) return res.status(400).json({ error: `Assertion '${assertion}' requires a target (ref/by_*)` });

        // Les assertions de comptage veulent TOUS les matchs, pas le premier.
        const COUNTING = ['count-eq', 'count-gte', 'count-lte', 'count-gt', 'count-lt'];
        const loc = locatorFromParams(page, params, req.sessionId,
                                      { first: !COUNTING.includes(assertion) });
        if (!loc) return res.status(400).json({ error: 'Could not resolve target. Check params.' });

        let pass = false, actual = null, expected = value;
        try {
            // Most assertions tolerate a brief wait. We use a manual loop because
            // Playwright's `expect` API isn't loaded server-side.
            const deadline = Date.now() + timeout_ms;
            const POLL = 150;
            const probe = async () => {
                switch (assertion) {
                    case 'visible': {
                        actual = await loc.isVisible({ timeout: POLL }).catch(() => false);
                        return actual === true;
                    }
                    case 'hidden': {
                        const c = await loc.count().catch(() => 0);
                        if (c === 0) { actual = 'not-present'; return true; }
                        actual = await loc.isVisible({ timeout: POLL }).catch(() => false);
                        return actual === false;
                    }
                    case 'enabled': {
                        actual = await loc.isEnabled({ timeout: POLL }).catch(() => false);
                        return actual === true;
                    }
                    case 'disabled': {
                        actual = await loc.isDisabled({ timeout: POLL }).catch(() => false);
                        return actual === true;
                    }
                    case 'checked': {
                        actual = await loc.isChecked({ timeout: POLL }).catch(() => false);
                        return actual === true;
                    }
                    case 'unchecked': {
                        actual = await loc.isChecked({ timeout: POLL }).catch(() => false);
                        return actual === false;
                    }
                    case 'text-equals': {
                        actual = (await loc.textContent({ timeout: POLL }).catch(() => '') || '').replace(/\s+/g, ' ').trim();
                        return actual === value.replace(/\s+/g, ' ').trim();
                    }
                    case 'text-contains': {
                        actual = (await loc.textContent({ timeout: POLL }).catch(() => '') || '').replace(/\s+/g, ' ').trim();
                        return actual.includes(value);
                    }
                    case 'value-equals': {
                        actual = await loc.inputValue({ timeout: POLL }).catch(() => '');
                        return actual === value;
                    }
                    case 'count-eq': {
                        actual = await loc.count().catch(() => 0);
                        return actual === parseInt(value, 10);
                    }
                    case 'count-gte': {
                        actual = await loc.count().catch(() => 0);
                        return actual >= parseInt(value, 10);
                    }
                    case 'attr-equals': {
                        // value format: "attr=NAME|val=VAL"  (parsed in Python before send)
                        // Server-side we accept the parsed form already in `value`,
                        // OR a structured alt form in body.attr / body.attr_value.
                        let attrName = req.body.attr;
                        let attrVal  = req.body.attr_value;
                        if (!attrName) {
                            const m = String(value || '').match(/attr=([^|]+)\|val=(.*)$/);
                            if (m) { attrName = m[1]; attrVal = m[2]; }
                        }
                        if (!attrName) return false;
                        const got = await loc.getAttribute(attrName, { timeout: POLL }).catch(() => null);
                        actual = got;
                        return got === attrVal;
                    }
                    default:
                        throw new Error(`Unknown assertion: ${assertion}`);
                }
            };
            while (Date.now() < deadline) {
                pass = await probe();
                if (pass) break;
                await new Promise(r => setTimeout(r, POLL));
            }
        } catch (e) {
            return res.status(400).json({ error: e.message, assertion, duration_ms: Date.now() - startMs });
        }

        const out = { pass, assertion, expected, actual, duration_ms: Date.now() - startMs };
        if (!pass) {
            // Always attach a screenshot on failed assertion — invaluable for debugging.
            const ss = await screenshotOnFailure(page, req.sessionId, `expect_${assertion}`).catch(() => ({}));
            Object.assign(out, ss);
            out.hint = `Expected ${assertion} ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
        }
        res.json(out);
    } catch (e) { res.status(500).json({ error: e.message, duration_ms: Date.now() - startMs }); }
});


// ── /element_screenshot : crop a single element ─────────────────────
app.post('/element_screenshot', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const sid = req.body.session_id;
        const params = req.body;
        const loc = locatorFromParams(page, params, req.sessionId);
        if (!loc) return res.status(400).json({ error: 'Provide ref/by_* params to identify the element' });
        const fname = `shot_${sid}_${Date.now()}.png`;
        const fpath = path.join(SCREENSHOT_DIR, fname);
        try {
            await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
            await loc.screenshot({ path: fpath, timeout: 8000 });
        } catch (e) {
            return res.status(500).json({ error: `element_screenshot failed: ${e.message}` });
        }
        res.json({ status: 'success', screenshot: fname });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ── /observe : multi-mode page perception (indexed | ax | som) ──────
// Uses the same heavy DOM walk as smart_inspect but emits a leaner shape
// optimized for token cost. Three modes:
//   - indexed: "[0] button \"Login\"" — cheapest. LLM responds with the index.
//   - ax: same as smart_inspect(level=lite) but always with selectors.
//   - som: Set-of-Mark — annotated screenshot with numbered boxes overlaid.
app.get('/observe', getSession, autoSnapshot, async (req, res) => {
    try {
        const { page } = req.session;
        const sid = req.query.session_id;
        const mode = ['indexed', 'ax', 'som'].includes(req.query.mode) ? req.query.mode : 'indexed';
        const viewportOnly = req.query.viewport_only !== 'false';
        const maxItems = Math.max(1, Math.min(parseInt(req.query.max_items) || 30, 200));
        const sinceStep = parseInt(req.query.since_step) || 0;
        const pierceShadow = req.query.pierce_shadow !== 'false';

        // For som mode we annotate first, screenshot, then strip annotations.
        const wantAnnotation = mode === 'som';

        const data = await page.evaluate(({ mode, viewportOnly, maxItems, wantAnnotation, pierceShadow }) => {
            // Mirror buildBestSelector from smart_inspect (kept inline for self-containment).
            function buildSel(el) {
                const tag = el.tagName.toLowerCase();
                if (el.id && !/^\d/.test(el.id) && !/^:r/.test(el.id) && el.id.length < 60) return `#${el.id}`;
                for (const a of ['data-testid','data-cy','data-qa','data-test']) {
                    const v = el.getAttribute(a);
                    if (v && v.length < 100) return `[${a}="${v.replace(/"/g,'\\"')}"]`;
                }
                if (['input','select','textarea'].includes(tag)) {
                    const n = el.getAttribute('name');
                    if (n) return `${tag}[name="${n.replace(/"/g,'\\"')}"]`;
                }
                const al = el.getAttribute('aria-label');
                if (al && al.length < 80) return `[aria-label="${al.replace(/"/g,'\\"')}"]`;
                if (['button','a'].includes(tag)) {
                    const t = (el.textContent || '').trim().replace(/\s+/g,' ');
                    if (t && t.length <= 30) return `${tag}:has-text("${t.replace(/"/g,'\\"').substring(0,30)}")`;
                }
                return tag;
            }
            const interactiveQuery = [
                'a[href]', 'a[onclick]', 'button', 'input:not([type="hidden"])', 'select', 'textarea',
                '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
                '[role="tab"]', '[role="menuitem"]', '[role="option"]', '[role="combobox"]',
                '[role="treeitem"]', '[role="gridcell"]', '[role="listbox"]',
                '[role="switch"]', '[onclick]', '[tabindex]:not([tabindex="-1"])',
                '[draggable="true"]',
            ].join(', ');
            // Même passe heuristique que smart_inspect : sans elle, pw_observe
            // — l'outil de secours « je suis perdu » — était aussi aveugle que
            // l'inspection sur une appli GWT/GXT (mesuré : 4 sur 7, dans les
            // trois modes indexed/ax/som).
            const WIDGET_CLASS = /(^|\s)(gwt-|x-btn|x-grid|x-tool|x-tab|v-button|v-select|dijit|z-button|ui-button|ui-menu-item|mdc-button|mat-button|ant-btn|el-button|btn|button|clickable|link|menu-item|list-item|option|tab)/i;
            const _semantic = Array.from(document.querySelectorAll(interactiveQuery));
            // Shadow DOM ouvert — même passe que smart_inspect.
            const _shadowHosts = [];
            const _inShadow = new WeakMap();
            if (pierceShadow) {
                const walkShadow = (root, depth) => {
                    if (depth > 4) return;
                    for (const host of root.querySelectorAll('*')) {
                        const sr = host.shadowRoot;
                        if (!sr) continue;
                        _shadowHosts.push(host);
                        const hostSel = buildSel(host);
                        for (const el of sr.querySelectorAll(interactiveQuery)) {
                            if (!_inShadow.has(el)) { _inShadow.set(el, hostSel); _semantic.push(el); }
                        }
                        walkShadow(sr, depth + 1);
                    }
                };
                try { walkShadow(document, 0); } catch (e) {}
            }
            const _semSet = new WeakSet(_semantic);
            const _pool = [];
            for (const el of document.querySelectorAll('div, span, td, li, i, img, p, label, section, a')) {
                if (_semSet.has(el)) continue;
                let cs2; try { cs2 = window.getComputedStyle(el); } catch (e) { continue; }
                const why = cs2.cursor === 'pointer' ? 'cursor'
                    : (typeof el.onclick === 'function') ? 'onclick-prop'
                    : (typeof el.className === 'string' && WIDGET_CLASS.test(el.className)) ? 'widget-class'
                    : null;
                if (!why) continue;
                if (el.querySelector(interactiveQuery)) continue;
                _pool.push({ el, why });
            }
            const _pSet = new WeakSet(_pool.map(p => p.el));
            const _why = new WeakMap(_pool.map(p => [p.el, p.why]));
            const _heur = _pool.filter(p => {
                let a = p.el.parentElement, h = 0;
                while (a && h < 8) { if (_pSet.has(a)) return false; a = a.parentElement; h++; }
                return true;
            }).map(p => p.el);

            const seen = new WeakSet();
            const items = [];
            let i = 0;
            const _all = _semantic.concat(_heur);
            const omitted = { offscreen: 0, hidden: 0, too_small: 0, over_max: 0 };
            let _consumed = 0;
            for (const el of _all) {
                if (items.length >= maxItems) { omitted.over_max = _all.length - _consumed; break; }
                _consumed++;
                if (seen.has(el)) continue;
                seen.add(el);
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) { omitted.too_small++; continue; }
                const cs = window.getComputedStyle(el);
                if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') { omitted.hidden++; continue; }
                if (viewportOnly && (r.bottom < -50 || r.top > window.innerHeight + 50)) { omitted.offscreen++; continue; }
                const tag = el.tagName.toLowerCase();
                let type = tag;
                if (tag === 'input') type = `input:${el.getAttribute('type') || 'text'}`;
                else if (el.getAttribute('role')) type = `role:${el.getAttribute('role')}`;
                const text = (el.textContent || el.value || el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').trim().replace(/\s+/g,' ').substring(0, 80);
                const sel = buildSel(el);
                const it = {
                    i: i++, type, text, selector: sel,
                    target_dsl: sel.startsWith('#') || sel.startsWith('[') ? `css=${sel}` : sel,
                    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
                    in_viewport: r.top >= 0 && r.top < window.innerHeight,
                };
                if (_why.has(el)) it.detected_by = _why.get(el);
                if (_inShadow.has(el)) { it.in_shadow = true; it.shadow_host = _inShadow.get(el); }
                if (el.getAttribute('draggable') === 'true') it.draggable = true;
                const _e = el.getAttribute('aria-expanded');
                if (_e !== null) it.expanded = _e === 'true';
                if (tag === 'select') {
                    it.options = Array.from(el.options || []).slice(0, 25)
                        .map(o => ({ value: o.value, label: (o.text || '').trim(), selected: o.selected }));
                }
                items.push(it);
                if (wantAnnotation) {
                    const lbl = document.createElement('div');
                    lbl.textContent = i - 1;
                    lbl.style.cssText = `position:fixed;z-index:99999;background:#FF0000;color:#FFF;font-size:11px;font-weight:bold;padding:1px 4px;border-radius:3px;pointer-events:none;line-height:1.2;left:${r.left}px;top:${Math.max(0, r.top - 16)}px;`;
                    lbl.className = '__pw_annotation__';
                    document.body.appendChild(lbl);
                    const brd = document.createElement('div');
                    brd.style.cssText = `position:fixed;z-index:99998;border:2px solid #FF0000;pointer-events:none;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
                    brd.className = '__pw_annotation__';
                    document.body.appendChild(brd);
                }
            }
            return { items, url: location.href, candidates_total: _all.length, omitted, shadow_hosts: _shadowHosts.length };
        }, { mode, viewportOnly, maxItems, wantAnnotation, pierceShadow });

        // SoM screenshot pass + strip annotations
        let screenshot = null;
        if (mode === 'som') {
            try {
                const fname = `view_${sid}.png`;
                await page.screenshot({ path: path.join(SCREENSHOT_DIR, fname), fullPage: false });
                screenshot = fname;
            } catch (e) {}
            await page.evaluate(() => document.querySelectorAll('.__pw_annotation__').forEach(el => el.remove())).catch(() => {});
        }

        // since_step diff (uses smart_inspect's snapshot store for cross-tool consistency)
        const s = req.session;
        s._inspectSnapshots = s._inspectSnapshots || {};
        const upcomingStep = (s.screenshotCounter || 0) + 1;
        s._inspectSnapshots[upcomingStep] = new Set(data.items.map(it => `${it.selector}|${it.type}|${it.text}`));
        const snapKeys = Object.keys(s._inspectSnapshots).map(Number).sort((a, b) => a - b);
        while (snapKeys.length > 20) { delete s._inspectSnapshots[snapKeys.shift()]; }

        let items = data.items;
        let diff = null;
        if (sinceStep > 0 && s._inspectSnapshots[sinceStep]) {
            const prev = s._inspectSnapshots[sinceStep];
            items = data.items.filter(it => !prev.has(`${it.selector}|${it.type}|${it.text}`));
            diff = { since_step: sinceStep, total_now: data.items.length, added_or_changed: items.length };
        }

        // Render an indexed text view if asked
        const indexedText = items.map(it => {
            const t = it.text ? ` "${it.text.substring(0, 60)}"` : '';
            return `[${it.i}] ${it.type}${t}`;
        }).join('\n');

        res.json({
            mode,
            url: data.url,
            items,
            indexed: mode === 'indexed' ? indexedText : undefined,
            screenshot,
            diff,
            count: items.length,
            candidates_total: data.candidates_total,
            omitted: data.omitted,
            shadow_hosts: data.shadow_hosts,
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// ════════════════════════════════════════════════════════════════════
// MOCK — network response stubbing per session
// ════════════════════════════════════════════════════════════════════
// Each session keeps its own mock list under session._mocks. The route
// handler is registered ONCE per session lazily; subsequent add/remove
// calls only mutate the list (no double-route registration).
async function ensureMockHandler(session) {
    if (session._mockHandlerRegistered) return;
    const { context } = session;
    session._mocks = session._mocks || [];
    // Use context.route so it covers all pages in the session (incl. new tabs).
    await context.route('**/*', async (route, request) => {
        const url = request.url();
        const method = request.method();
        const mocks = session._mocks || [];
        for (const m of mocks) {
            if (m._exhausted) continue;
            if (m.method && m.method.toUpperCase() !== method) continue;
            let match = false;
            try {
                if (m.is_regex) match = new RegExp(m.url_pattern).test(url);
                else match = url.includes(m.url_pattern);
            } catch (e) { match = url.includes(m.url_pattern); }
            if (!match) continue;
            if (m.delay_ms && m.delay_ms > 0) await new Promise(r => setTimeout(r, m.delay_ms));
            if (m.times !== -1) {
                m._used = (m._used || 0) + 1;
                if (m._used >= m.times) m._exhausted = true;
            }
            try {
                await route.fulfill({
                    status: m.status,
                    contentType: m.content_type,
                    body: m.body || '',
                    headers: m.headers || {},
                });
            } catch (e) { /* route may have been aborted by another handler */ }
            return;
        }
        // Aucun mock : on passe la main (la garde des destinations décide).
        try { await route.fallback(); } catch (e) {}
    });
    session._mockHandlerRegistered = true;
}

app.post('/mock/add', getSession, async (req, res) => {
    try {
        const {
            url_pattern, status = 200, body = '', content_type = 'application/json',
            delay_ms = 0, times = -1, method = '', is_regex = false, headers = {},
        } = req.body;
        if (!url_pattern) return res.status(400).json({ error: 'url_pattern required' });
        await ensureMockHandler(req.session);
        req.session._mocks = req.session._mocks || [];
        const id = `mock_${Math.random().toString(36).substring(2, 10)}`;
        req.session._mocks.push({
            id, url_pattern, status: parseInt(status), body, content_type,
            delay_ms: parseInt(delay_ms), times: parseInt(times),
            method, is_regex: !!is_regex, headers,
            _used: 0, _exhausted: false, created_at: Date.now(),
        });
        res.json({ status: 'added', id, mocks_count: req.session._mocks.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/mock/list', getSession, async (req, res) => {
    const list = (req.session._mocks || []).map(m => ({
        id: m.id, url_pattern: m.url_pattern, status: m.status,
        delay_ms: m.delay_ms, times: m.times, used: m._used || 0,
        exhausted: !!m._exhausted, method: m.method || 'ANY',
        is_regex: !!m.is_regex,
    }));
    res.json({ count: list.length, mocks: list });
});

app.post('/mock/clear', getSession, async (req, res) => {
    const n = (req.session._mocks || []).length;
    req.session._mocks = [];
    res.json({ status: 'cleared', removed: n });
});

app.post('/mock/remove', getSession, async (req, res) => {
    const { url_pattern, id } = req.body;
    const before = (req.session._mocks || []).length;
    req.session._mocks = (req.session._mocks || []).filter(m =>
        (id && m.id === id) ? false :
        (url_pattern && m.url_pattern === url_pattern) ? false :
        true
    );
    res.json({ status: 'removed', removed: before - req.session._mocks.length });
});


// ════════════════════════════════════════════════════════════════════
// RECORDER — capture session actions, replay as Playwright/Cypress/etc.
// ════════════════════════════════════════════════════════════════════
// We hook into the /action and /chain endpoints by intercepting via a
// session-level recorder. Each successful action is appended to
// session._recorder.events when session._recorder.recording is true.
// (The hook lives in the existing endpoints — see `recordEvent` below.)

function recordEvent(session, evt) {
    if (!session || !session._recorder || !session._recorder.recording) return;
    const events = session._recorder.events;
    events.push({ ts: Date.now() - session._recorder.start_ts, ...evt });
    if (events.length > 1000) events.shift(); // safety cap
}

app.post('/recorder/start', getSession, async (req, res) => {
    req.session._recorder = {
        recording: true,
        start_ts: Date.now(),
        events: [],
    };
    res.json({ status: 'recording', start_ts: req.session._recorder.start_ts });
});

app.post('/recorder/stop', getSession, async (req, res) => {
    if (!req.session._recorder) {
        return res.json({ status: 'not_started', count: 0 });
    }
    req.session._recorder.recording = false;
    res.json({
        status: 'stopped',
        count: req.session._recorder.events.length,
        duration_ms: Date.now() - req.session._recorder.start_ts,
    });
});

app.post('/recorder/clear', getSession, async (req, res) => {
    if (req.session._recorder) {
        req.session._recorder.events = [];
        req.session._recorder.start_ts = Date.now();
    }
    res.json({ status: 'cleared' });
});

app.get('/recorder/status', getSession, async (req, res) => {
    const r = req.session._recorder;
    res.json({
        recording: !!(r && r.recording),
        count: r ? r.events.length : 0,
        duration_ms: r ? Date.now() - r.start_ts : 0,
    });
});

app.get('/recorder/dump', getSession, async (req, res) => {
    const format = req.query.format || 'playwright';
    const r = req.session._recorder;
    if (!r || r.events.length === 0) {
        return res.json({ format, count: 0, script: '', warning: 'No events recorded.' });
    }
    const events = r.events;

    function escape(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }
    function targetExpr(evt, fmt) {
        // evt.locator is the resolved kw set (role, name, text, label, css, ...)
        const l = evt.locator || {};
        if (fmt === 'playwright') {
            if (l.role && l.name) return `page.getByRole('${escape(l.role)}', { name: '${escape(l.name)}' })`;
            if (l.role) return `page.getByRole('${escape(l.role)}')`;
            if (l.label) return `page.getByLabel('${escape(l.label)}')`;
            if (l.placeholder) return `page.getByPlaceholder('${escape(l.placeholder)}')`;
            if (l.test_id) return `page.getByTestId('${escape(l.test_id)}')`;
            if (l.text) return `page.getByText('${escape(l.text)}')`;
            if (l.css) return `page.locator('${escape(l.css)}')`;
            if (l.xpath) return `page.locator('xpath=${escape(l.xpath)}')`;
            return `page.locator('${escape(evt.selector || '')}')`;
        }
        if (fmt === 'cypress') {
            if (l.test_id) return `cy.get('[data-testid="${escape(l.test_id)}"]')`;
            if (l.role && l.name) return `cy.findByRole('${escape(l.role)}', { name: '${escape(l.name)}' })`;
            if (l.label) return `cy.findByLabelText('${escape(l.label)}')`;
            if (l.text) return `cy.contains('${escape(l.text)}')`;
            if (l.css) return `cy.get('${escape(l.css)}')`;
            return `cy.get('${escape(evt.selector || '')}')`;
        }
        if (fmt === 'robot') {
            // Robot Framework with Browser library
            if (l.role && l.name) return `role=${l.role}[name="${l.name}"]`;
            if (l.test_id) return `[data-testid="${l.test_id}"]`;
            if (l.label) return `label=${l.label}`;
            if (l.text) return `text=${l.text}`;
            if (l.css) return l.css;
            return evt.selector || '';
        }
        return evt.selector || '';
    }

    let script = '';
    if (format === 'json') {
        script = JSON.stringify(events, null, 2);
    } else if (format === 'playwright') {
        const lines = [
            "import { test, expect } from '@playwright/test';",
            '',
            'test(\'recorded session\', async ({ page }) => {',
        ];
        for (const e of events) {
            const t = targetExpr(e, 'playwright');
            switch (e.action) {
                case 'goto': lines.push(`  await page.goto('${escape(e.url)}');`); break;
                case 'click': lines.push(`  await ${t}.click();`); break;
                case 'fill':  lines.push(`  await ${t}.fill('${escape(e.value)}');`); break;
                case 'type':  lines.push(`  await ${t}.type('${escape(e.value)}');`); break;
                case 'press': lines.push(`  await page.keyboard.press('${escape(e.key || e.value)}');`); break;
                case 'select': lines.push(`  await ${t}.selectOption(${selectOptionArg(e, 'playwright')});`); break;
                case 'check': lines.push(`  await ${t}.check();`); break;
                case 'uncheck': lines.push(`  await ${t}.uncheck();`); break;
                case 'hover': lines.push(`  await ${t}.hover();`); break;
                default: lines.push(`  // ${e.action}: ${escape(JSON.stringify(e))}`);
            }
        }
        lines.push('});');
        script = lines.join('\n');
    } else if (format === 'cypress') {
        const lines = ["describe('recorded session', () => {", "  it('replays', () => {"];
        for (const e of events) {
            const t = targetExpr(e, 'cypress');
            switch (e.action) {
                case 'goto':  lines.push(`    cy.visit('${escape(e.url)}');`); break;
                case 'click': lines.push(`    ${t}.click();`); break;
                case 'fill':
                case 'type':  lines.push(`    ${t}.type('${escape(e.value)}');`); break;
                case 'select': lines.push(`    ${t}.select(${selectOptionArg(e, 'cypress')});`); break;
                case 'check': lines.push(`    ${t}.check();`); break;
                case 'uncheck': lines.push(`    ${t}.uncheck();`); break;
                default: lines.push(`    // ${e.action}`);
            }
        }
        lines.push('  });', '});');
        script = lines.join('\n');
    } else if (format === 'robot') {
        const lines = [
            '*** Settings ***',
            'Library    Browser',
            '',
            '*** Test Cases ***',
            'Recorded Session',
        ];
        for (const e of events) {
            const t = targetExpr(e, 'robot');
            switch (e.action) {
                case 'goto':  lines.push(`    New Page    ${e.url}`); break;
                case 'click': lines.push(`    Click    ${t}`); break;
                case 'fill':  lines.push(`    Fill Text    ${t}    ${e.value}`); break;
                case 'type':  lines.push(`    Type Text    ${t}    ${e.value}`); break;
                case 'press': lines.push(`    Keyboard Key    press    ${e.key || e.value}`); break;
                case 'select': lines.push(`    Select Options By    ${t}    ${selectOptionArg(e, 'robot')}`); break;
                default: lines.push(`    # ${e.action}`);
            }
        }
        script = lines.join('\n');
    } else {
        return res.status(400).json({ error: `Unknown format: ${format}. Use: playwright|cypress|robot|json` });
    }

    res.json({ format, count: events.length, script });
});


// SECURITY FIX (critique) : on bind explicitement à 127.0.0.1 par défaut
// pour empêcher l'exposition externe. L'opérateur peut exposer le service
// sur d'autres interfaces via FIREFOX_SERVICE_HOST=0.0.0.0, en sachant que
// le service n'a alors AUCUNE barrière. Le port reste configurable via
// FIREFOX_SERVICE_PORT.
const LISTEN_HOST = process.env.FIREFOX_SERVICE_HOST || '127.0.0.1';
const LISTEN_PORT = parseInt(process.env.FIREFOX_SERVICE_PORT || '3000', 10);
app.listen(LISTEN_PORT, LISTEN_HOST, () => {
    console.log(`🌐 Browser AGENT Server (Playwright, multi-engine) running on ${LISTEN_HOST}:${LISTEN_PORT} (TTL: 15min, max: 10 sessions)`);
});
