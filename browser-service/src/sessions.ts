// SPDX-License-Identifier: MIT
/* eslint-disable */
// @ts-nocheck
/** browser-service/src/sessions.ts — life of the sessions: activity, closing, one live session per owner, cleanups (idle sessions, orphan processes, screenshots, artifacts), shared Chromium, shutdown. */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import { cleanupSessionScreenshots } from './captures.ts';
import { lirePs, orphelins } from './proc_util.ts';
import { COOKIES_DIR, HAR_DIR, PW_MUTEX, SCREENSHOT_DIR, TRACE_DIR, VIDEO_DIR } from './reglages.ts';
import { acquireLock, lockIdle, makeLock } from './session_lock.ts';
import { pingPage, planArtifactPurge, planScreenshotQuota, quotasSessions } from './session_util.ts';


// ==========================================
// SESSION REAPER — Auto-cleanup (Feature 1)
// ==========================================
export const SESSION_TTL_MS = 15 * 60 * 1000;  // 15 minutes
const REAPER_INTERVAL_MS = 60 * 1000;   // check every 60s
// Plafonds de sessions du compte (`quotasSessions`) : par propriétaire, et par groupe (le compte et les propriétaires dérivés
// de ses enfants). Au plafond, la plus ancienne session du demandeur cède la place (jamais celle d'un autre propriétaire du
// groupe) ; sans session à céder, le démarrage est refusé. Une place du groupe reste au compte : ses enfants n'ont que le reste.
export const { maxPerOwner: MAX_SESSIONS_PER_OWNER, maxPerGroup: MAX_SESSIONS_PER_GROUP } = quotasSessions(process.env);
// Budget accordé à la tentative « locator officiel » QUAND un selector de
// repli est disponible. Court exprès : le repli smartResolveLocator doit
// pouvoir s'exécuter dans le temps que le client accorde à la requête.
export const OFFICIAL_TRY_MS = parseInt(process.env.PW_OFFICIAL_TRY_MS || '2500', 10);

export function touchSession(ctx, sid) {
    const { sessions } = ctx;
    const s = sessions.get(sid);
    if (s) s.lastActivity = Date.now();
}

export async function closeSession(ctx, sid, reason = 'unknown', { lockHeld = false } = {}) {
    const { sessions } = ctx;
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
// que l'appelant puisse en recréer une proprement. Une session ouverte avec
// une politique TLS (pour un secret du coffre) n'est jamais reprise.
export async function findLiveSessionByOwner(ctx, owner) {
    const { sessions } = ctx;
    if (!owner) return null;
    for (const [sid, s] of sessions) {
        if (s.owner !== owner || s.tls) continue;
        // AUDIT 2026-06 — ping borné : une page gelée ne bloque plus la
        // recherche. 'frozen' = fail-open (page sans doute juste occupée,
        // les handlers ont leurs propres timeouts).
        const verdict = await pingPage(s.page, 3000);
        if (verdict === 'crashed') { await closeSession(ctx, sid, 'owner_session_dead'); continue; }
        return [sid, s];
    }
    return null;
}

async function reapStaleSessions(ctx) {
    const { sessions } = ctx;
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
        await closeSession(ctx, sid, reason);
    }
    if (stale.size > 0) console.log(`[REAPER] Cleaned ${stale.size} session(s). Active: ${sessions.size}`);
}

// Processus navigateur ORPHELINS seulement (cf. proc_util.js) : avant, tout
// renderer de plus de 20 min était tué, onglets actifs compris.
export function killZombieProcesses() {
    try {
        const uid = typeof process.getuid === 'function' ? process.getuid() : null;
        const cmd = uid === null ? 'ps -eo pid=,ppid=,etimes=,args='
                                 : `ps -u ${uid} -o pid=,ppid=,etimes=,args=`;
        const texte = execSync(cmd, { timeout: 5000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        // Rattachement par la chaîne des parents (zygote, serveur de fork) : pas
        // besoin du PID du navigateur, que Playwright n'expose pas pour un
        // ``Browser`` lancé (seulement pour un ``BrowserServer``).
        const cibles = orphelins(lirePs(texte), { ageMinS: 1200, epargner: [process.pid] });
        for (const pid of cibles) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
        if (cibles.length) console.log(`[REAPER] ${cibles.length} processus navigateur orphelin(s) arrêté(s).`);
    } catch (e) { /* ps indisponible : rien à faire */ }
}

// Verrous de démarrage par propriétaire : purgés quand ils sont au repos et
// que le propriétaire n'a plus de session (la Map ne grossit plus sans fin).
function purgeOwnerStartLocks(ctx) {
    const { sessions, ownerStartLocks } = ctx;
    const vivants = new Set([...sessions.values()].map(s => s.owner).filter(Boolean));
    for (const [owner, lock] of ownerStartLocks) {
        if (!vivants.has(owner) && lockIdle(lock)) ownerStartLocks.delete(owner);
    }
}


// ==========================================
// SCREENSHOT REAPER — disk-space safety net
// ==========================================
// Even with cleanupSessionScreenshots() being called on session close,
// leaked files accumulate when:
//   - the Node process crashes between screenshot write and session close
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

// Matches step_<sid>_<n>.jpg (.png before 2026-11), vision_<sid>_<n>.jpg, smart_<sid>.png, view_<sid>.png,
// shot_<sid>_<ts>.png, fail_<sid8>_<ts>.png, and live_<sid>.png left by older versions. fail_ uses the
// first 8 chars of the sid so we accept that too.
// Session id is 8-64 chars of [A-Za-z0-9-].
const SCREENSHOT_SID_RE = /^(?:step|vision|live|smart|view|shot|fail)_([A-Za-z0-9-]{8,64})(?:_\d+)?\.(?:png|jpg)$/;

function reapScreenshots(ctx) {
    const { sessions } = ctx;
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

// ── Autres artefacts : purgés par âge (2026-09-30). HAR, vidéos et traces servent le temps d'une session ; les états
// sauvegardés (cookies) se rechargent plus tard, d'où une durée plus longue ; les téléchargements (/work) ne le sont jamais.
const ARTIFACT_MAX_AGE_MS = parseInt(process.env.PW_ARTIFACT_MAX_AGE_H || '24', 10) * 3600 * 1000;
export const STATE_MAX_AGE_D = parseInt(process.env.PW_STATE_MAX_AGE_D || '30', 10);
const STATE_MAX_AGE_MS = STATE_MAX_AGE_D * 86400 * 1000;

function _purgerDossier(dir, maxAgeMs) {
    let noms;
    try { noms = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return 0; }
    const entrees = [];
    for (const d of noms) {
        if (!d.isFile()) continue;
        try { entrees.push({ name: d.name, mtimeMs: fs.statSync(path.join(dir, d.name)).mtimeMs }); } catch (_) {}
    }
    let n = 0;
    for (const nom of planArtifactPurge(entrees, { maxAgeMs })) {
        try { fs.unlinkSync(path.join(dir, nom)); n++; } catch (_) {}
    }
    return n;
}

function reapArtifacts() {
    const n = _purgerDossier(HAR_DIR, ARTIFACT_MAX_AGE_MS)
            + _purgerDossier(VIDEO_DIR, ARTIFACT_MAX_AGE_MS)
            + _purgerDossier(TRACE_DIR, ARTIFACT_MAX_AGE_MS)
            + _purgerDossier(COOKIES_DIR, STATE_MAX_AGE_MS);
    if (n) console.log(`[ARTIFACT-REAPER] ${n} fichier(s) purgé(s).`);
}

/** Cleanups of the service: sessions, orphan processes and start locks every minute; screenshots and artifacts at start, then every 10 min. */
export function demarrerNettoyages(ctx) {
// Start reaper
const _reaperInterval = setInterval(async () => {
    try {
        await reapStaleSessions(ctx);
        killZombieProcesses();
        purgeOwnerStartLocks(ctx);
    } catch (e) { console.error('[REAPER] Error:', e.message); }
}, REAPER_INTERVAL_MS);
// Run once on startup (catches crashes that left files behind across restarts) and then on a timer.
setImmediate(() => {
    try { reapScreenshots(ctx); } catch (e) { console.error('[SCREENSHOT-REAPER] startup:', e.message); }
    try { reapArtifacts(); } catch (e) { console.error('[ARTIFACT-REAPER] startup:', e.message); }
});
const _screenshotReaperInterval = setInterval(() => {
    try { reapScreenshots(ctx); }
    catch (e) { console.error('[SCREENSHOT-REAPER] Error:', e.message); }
    try { reapArtifacts(); }
    catch (e) { console.error('[ARTIFACT-REAPER] Error:', e.message); }
}, SCREENSHOT_REAPER_INTERVAL_MS);
ctx.minuteries.push(_reaperInterval, _screenshotReaperInterval);
}

// Graceful shutdown. ``code`` ≠ 0 après une exception : le gestionnaire de
// services doit voir un échec (et relancer), pas un arrêt voulu.
export async function gracefulShutdown(ctx, signal, code = 0) {
    const { sessions } = ctx;
    console.log(`\n[SHUTDOWN] ${signal} received. Closing ${sessions.size} session(s)…`);
    for (const minuterie of ctx.minuteries) clearInterval(minuterie);
    for (const [sid] of sessions) {
        await closeSession(ctx, sid, 'shutdown');
    }
    if (ctx.navigateur) {
        try { await ctx.navigateur.close(); } catch (e) {}
        ctx.navigateur = null;
    }
    console.log(code ? `[SHUTDOWN] Exit ${code}.` : '[SHUTDOWN] Clean exit.');
    process.exit(code);
}

// ==========================================
// BROWSER LIFECYCLE
// ==========================================
// Chromium headless sans channel (Playwright lance le headless shell) ; langue, téléchargements, HTTPS et CSP : contexte de /start.
function buildLaunchOptions(ctx) {
    return {
        headless: true,
        args: [
            '--no-sandbox', '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',                        // stabilité en conteneur (/dev/shm petit)
            '--disable-blink-features=AutomationControlled',  // anti-détection
            // WebRTC : pas d'UDP hors du relais (il ne passe qu'en TCP proxifié).
            '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
        proxy: ctx.proxy,
    };
}

// Une seule promesse de lancement : deux /start simultanés ne lancent plus
// deux navigateurs (le second écrasait le premier, resté orphelin).
export async function ensureBrowser(ctx) {
    if (ctx.navigateur && ctx.navigateur.isConnected()) return ctx.navigateur;
    if (ctx.lancement) return ctx.lancement;
    ctx.lancement = _lancerNavigateur(ctx).finally(() => { ctx.lancement = null; });
    return ctx.lancement;
}

async function _lancerNavigateur(ctx) {
    if (!ctx.navigateur || !ctx.navigateur.isConnected()) {
        console.log('[GLOBAL] Démarrage de Chromium (headless shell)');
        const navigateur = await chromium.launch(buildLaunchOptions(ctx));
        ctx.navigateur = navigateur;
        navigateur.on('disconnected', () => {
            console.warn('[GLOBAL] Browser déconnecté, reset...');
            ctx.navigateur = null;
            ctx.sessions.clear();
        });
    }
    return ctx.navigateur;
}

// AUDIT 2026-06 — deux /start concurrents du MÊME owner passaient tous deux
// findLiveSessionByOwner(null) → double session (violation de « une instance
// par utilisateur »). Verrou par owner le temps du start. Map bornée par le
// nombre d'utilisateurs distincts (pas de fuite).
export function _ownerStartLock(ctx, owner) {
    const { ownerStartLocks } = ctx;
    if (!ownerStartLocks.has(owner)) ownerStartLocks.set(owner, makeLock());
    return ownerStartLocks.get(owner);
}
