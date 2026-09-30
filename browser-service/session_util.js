// SPDX-License-Identifier: MIT
// session_util.js — helpers de cycle de vie des sessions (extraits de
// server.js pour être testables sans Playwright — cf. nav_util.js).
//
// AUDIT 2026-06 :
//   - pingPage : borne les ``page.evaluate(() => true)`` de sondage. Avant,
//     une page GELÉE (script lourd, protocole CDP muet) bloquait
//     indéfiniment le reaper — qui ne tournait alors PLUS pour toutes les
//     autres sessions — ou une requête entrante dans getSession.
//   - planScreenshotQuota : quota par session pour les fichiers qui
//     s'accumulent (step_/shot_/fail_). Le reaper existant ne couvrait que
//     l'âge (orphan 5 min / stale 4 h) : une session active de longue durée
//     pouvait accumuler des milliers de PNG sans limite.

/**
 * Sonde une page Playwright avec un timeout dur.
 * @returns {'ok'|'crashed'|'frozen'}
 *   - ok      : la page répond.
 *   - crashed : evaluate a rejeté (page/context fermé ou crashé).
 *   - frozen  : pas de réponse sous `ms` — la page est peut-être juste
 *               occupée (script long) : à traiter en fail-open côté requête,
 *               et en « N strikes » côté reaper.
 */
export async function pingPage(page, ms = 5000) {
    let timer;
    try {
        // NB : pas de timer.unref() — si l'evaluate ne répond jamais, le
        // timer DOIT pouvoir tirer même s'il est le dernier handle vivant
        // (sinon la race reste pendante à jamais). Il est de toute façon
        // clearTimeout-é dès que l'evaluate répond (finally).
        return await Promise.race([
            page.evaluate(() => true).then(() => 'ok', () => 'crashed'),
            new Promise(resolve => { timer = setTimeout(() => resolve('frozen'), ms); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Calcule les fichiers screenshots à supprimer pour respecter le quota
 * par session. Fonction PURE (pas d'I/O) — l'appelant fournit les entrées
 * et exécute les unlink.
 *
 * Seuls les genres qui s'ACCUMULENT sont éligibles (step_/shot_/fail_) ;
 * live_/smart_/view_ sont un fichier unique par session, écrasé en place
 * (et live_ est l'image courante affichée — ne jamais y toucher).
 *
 * @param {Array<{name: string, sid: string, mtimeMs: number, size: number}>} entries
 * @param {{maxPerSession?: number, maxBytesPerSession?: number}} caps
 * @returns {string[]} noms de fichiers à supprimer (les plus anciens d'abord)
 */
export function planScreenshotQuota(entries, caps = {}) {
    const maxCount = caps.maxPerSession ?? 300;
    const maxBytes = caps.maxBytesPerSession ?? 200 * 1024 * 1024;

    const evictable = entries.filter(e =>
        /^(?:step|shot|fail)_/.test(e.name));

    const bySid = new Map();
    for (const e of evictable) {
        if (!bySid.has(e.sid)) bySid.set(e.sid, []);
        bySid.get(e.sid).push(e);
    }

    const toDelete = [];
    for (const list of bySid.values()) {
        // Plus récents d'abord : on garde la tête jusqu'aux caps.
        list.sort((a, b) => b.mtimeMs - a.mtimeMs);
        let kept = 0, keptBytes = 0;
        for (const e of list) {
            keptBytes += e.size || 0;
            kept += 1;
            if (kept > maxCount || keptBytes > maxBytes) toDelete.push(e.name);
        }
    }
    // Les plus anciens d'abord (ordre de suppression naturel).
    return toDelete.reverse();
}

// ── Propriété des sessions (2026-09-30) ─────────────────────────────────────
// Le service ne sait pas qui l'appelle : c'est l'appelant (les outils pw_*,
// côté Python) qui transmet le propriétaire (``owner``, dérivé du compte
// Elpis) à CHAQUE requête. Une session n'est servie qu'à son propriétaire ;
// une session d'un autre compte répond comme une session inconnue.

/** Propriétaire normalisé (``[A-Za-z0-9_-]``, 64 max), ou ``''``. */
export function safeOwner(owner) {
    const s = String(owner ?? '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    return s;
}

/** Propriétaire transmis par une requête (corps JSON puis paramètres). */
export function ownerFromRequest(req) {
    const b = req && req.body && typeof req.body === 'object' ? req.body.owner : undefined;
    const q = req && req.query ? req.query.owner : undefined;
    return safeOwner(b ?? q ?? '');
}

/** La session appartient-elle à ce propriétaire ? (jamais pour un vide) */
export function ownerMatches(session, owner) {
    const o = safeOwner(owner);
    return !!o && !!session && session.owner === o;
}

// Identifiant d'état sauvegardé : celui de la session (uuid).
const _STATE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Nom du fichier d'un état sauvegardé (cookies, stockage local) : lié au
 * propriétaire, pour qu'un compte ne recharge jamais l'état d'un autre.
 * → ``null`` si l'identifiant ou le propriétaire est invalide.
 */
export function stateFileName(owner, stateId) {
    const o = safeOwner(owner);
    const id = String(stateId ?? '');
    if (!o || !_STATE_ID_RE.test(id)) return null;
    return `state_${o}__${id}.json`;
}

/** Nom de fichier sûr pour un téléchargement (jamais de chemin). */
export function safeDownloadName(name) {
    const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '').trim();
    if (!base || base === '.' || base === '..') return 'telechargement';
    return base.slice(0, 200);
}

/**
 * Fichiers d'artefacts à purger : plus vieux que ``maxAgeMs``.
 * ``entries`` : ``[{ name, mtimeMs }]`` → noms à supprimer.
 */
export function planArtifactPurge(entries, { now = Date.now(), maxAgeMs } = {}) {
    if (!maxAgeMs || maxAgeMs <= 0) return [];
    return (entries || []).filter(e => e && now - (e.mtimeMs || 0) > maxAgeMs).map(e => e.name);
}
