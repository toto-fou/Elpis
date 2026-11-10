// SPDX-License-Identifier: MIT
// browser-service/service_auth.js — jeton d'appel du service : Bearer exigé dès qu'un jeton est configuré, appel local direct seul sinon.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RELECTURE_MS = 5000;
const BOUCLES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const EN_TETES_RELAIS = ['x-forwarded-for', 'x-real-ip', 'forwarded', 'via'];
let cache = { lu: 0, jeton: '' };

/** Fichier du jeton : BROWSER_SERVICE_TOKEN_FILE, sinon user_db/.browser_service_token à côté du dossier du service. */
export function fichierJeton(env = process.env, cwd = process.cwd()) {
    const brut = (env.BROWSER_SERVICE_TOKEN_FILE || '').trim();
    return brut || path.join(cwd, '..', 'user_db', '.browser_service_token');
}

/** Jeton attendu : BROWSER_SERVICE_TOKEN, sinon la première ligne du fichier, relu au plus toutes les 5 s ; '' sans fichier, null s'il est illisible. */
export function jetonAttendu(env = process.env, maintenant = Date.now()) {
    const direct = (env.BROWSER_SERVICE_TOKEN || '').trim();
    if (direct) return direct;
    if (maintenant - cache.lu < RELECTURE_MS) return cache.jeton;
    let jeton;
    try { jeton = fs.readFileSync(fichierJeton(env), 'utf8').split('\n')[0].trim(); }
    catch (e) { jeton = e?.code === 'ENOENT' ? '' : null; }
    cache = { lu: maintenant, jeton };
    return jeton;
}

/** Appel local sans relais : un proxy local ferait passer tout le réseau pour 127.0.0.1. */
export function appelLocalDirect(req) {
    const ip = req.socket?.remoteAddress || '';
    return BOUCLES.has(ip) && !EN_TETES_RELAIS.some((h) => h in (req.headers || {}));
}

function egal(a, b) {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
}

/** null si l'appel est admis, sinon le refus à rendre (401, ou 503 quand le fichier du jeton est illisible : jamais d'ouverture par défaut). */
export function refusAppel(req, attendu) {
    if (attendu === null) {
        return { statut: 503, error: 'Browser service token file unreadable: every call is refused until it is readable by the service account', code: 'token_unreadable' };
    }
    if (!attendu) {
        if (appelLocalDirect(req)) return null;
        return { statut: 401, error: 'Unauthorized: the browser service has no token and only accepts direct local calls', code: 'unauthorized' };
    }
    const auth = String(req.headers?.authorization || '');
    const presente = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    if (presente && egal(presente, attendu)) return null;
    return { statut: 401, error: 'Unauthorized: missing or invalid browser service token', code: 'unauthorized' };
}

let modeJournalise = undefined;

/** Mode d'accès courant, journalisé à chaque changement (jeton, boucle locale seule, fichier illisible). */
export function journaliserMode(attendu) {
    const mode = attendu === null ? 'unreadable' : attendu ? 'token' : 'loopback-only';
    if (mode === modeJournalise) return;
    modeJournalise = mode;
    const textes = {
        token: '[auth] service token in force: Bearer required on every call',
        'loopback-only': '[auth] no service token (BROWSER_SERVICE_TOKEN or user_db/.browser_service_token): only direct local calls are accepted',
        unreadable: `[auth] service token file unreadable (${fichierJeton()}): every call is refused`,
    };
    console.warn(textes[mode]);
}

/** Middleware Express : à poser avant toute route, statiques comprises. */
export function gardeJeton(req, res, next) {
    const attendu = jetonAttendu();
    journaliserMode(attendu);
    const refus = refusAppel(req, attendu);
    if (refus) {
        const { statut, ...corps } = refus;
        return res.status(statut).json(corps);
    }
    next();
}

/** Remet le cache à zéro (tests). */
export function oublierJeton() { cache = { lu: 0, jeton: '' }; modeJournalise = undefined; }
