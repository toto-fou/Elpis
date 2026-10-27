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

// Rejet d'une page VIVANTE dont le contexte d'exécution change (navigation, page d'erreur après un goto échoué).
const _CONTEXTE_EN_NAVIGATION = /Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation/i;

/**
 * Sonde une page Playwright avec un timeout dur.
 * @returns {'ok'|'crashed'|'frozen'}
 *   - ok      : la page répond.
 *   - crashed : evaluate a rejeté (page/context fermé ou crashé).
 *   - frozen  : pas de réponse sous `ms` — la page est peut-être juste
 *               occupée (script long) : à traiter en fail-open côté requête,
 *               et en « N strikes » côté reaper.
 *   Un contexte détruit par une navigation n'est pas un crash : la page est resondée dans le même délai.
 */
export async function pingPage(page, ms = 5000) {
    const fin = Date.now() + ms;
    let timer;
    try {
        for (;;) {
            const reste = fin - Date.now();
            if (reste <= 0) return 'frozen';
            // NB : pas de timer.unref() — si l'evaluate ne répond jamais, le
            // timer DOIT pouvoir tirer même s'il est le dernier handle vivant
            // (sinon la race reste pendante à jamais). Il est de toute façon
            // clearTimeout-é dès que l'evaluate répond (finally).
            const verdict = await Promise.race([
                page.evaluate(() => true).then(() => 'ok', (e) => {
                    const ferme = typeof page.isClosed === 'function' && page.isClosed();
                    return !ferme && _CONTEXTE_EN_NAVIGATION.test(String(e && e.message)) ? 'navigating' : 'crashed';
                }),
                new Promise(resolve => { timer = setTimeout(() => resolve('frozen'), reste); }),
            ]);
            clearTimeout(timer);
            if (verdict !== 'navigating') return verdict;
            await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, fin - Date.now()))));
        }
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

// États enregistrés avant la 0.0.1 : ``state_<id>.json``, sans propriétaire.
// Le service ne peut pas deviner à quel compte ils appartiennent : il ne les
// charge jamais (n'importe quel compte qui connaît l'identifiant obtiendrait
// la session connectée d'un autre) et ne les purge pas, pour qu'un
// administrateur puisse les rattacher (``./elpis browser migrate-states``).
const _LEGACY_STATE_RE = /^state_[A-Za-z0-9-]{8,64}\.json$/;

/** Nom ancien (sans propriétaire) de l'état ``stateId``, ou ``null``. */
export function legacyStateFileName(stateId) {
    const id = String(stateId ?? '');
    return _STATE_ID_RE.test(id) ? `state_${id}.json` : null;
}

/** ``name`` est-il un état sans propriétaire ? (jamais un nom par compte) */
export function isLegacyStateName(name) {
    return _LEGACY_STATE_RE.test(String(name ?? ''));
}

/**
 * État à charger au démarrage d'une session de ``owner``. ``exists(nom)``
 * dit si ``cookies/<nom>`` existe ; ``maxAgeDays`` (0 : pas de purge) est
 * rappelé dans le ``fix`` d'un état introuvable. → ``{ file }``, ou
 * ``{ code, error, fix }`` à rendre en 404 : ``legacy_state`` (l'état existe
 * sous l'ancien nom, à rattacher) ou ``state_not_found``. L'état d'un autre
 * compte répond comme un état inconnu.
 */
export function resolveStateFile(owner, stateId, exists, { maxAgeDays = 0 } = {}) {
    const nom = stateFileName(owner, stateId);
    if (nom && exists(nom)) return { file: nom };
    const ancien = nom && legacyStateFileName(stateId);
    if (ancien && exists(ancien)) {
        return {
            code: 'legacy_state',
            error: "État sauvegardé avant la version 0.0.1 d'Elpis : il n'appartient à aucun "
                 + "compte et ne se recharge pas tant qu'un administrateur ne l'a pas rattaché.",
            fix: "S'il a été enregistré pour ce compte, un administrateur le lui rattache "
               + '(./elpis browser states montre ses sites) : ./elpis browser migrate-states '
               + `<compte> ${stateId}, qui renomme cookies/${ancien} en ${nom}. Relancez ensuite `
               + 'start avec le même load_state_id (isolated=true si une session est déjà '
               + 'ouverte) ; en attendant, démarrez sans load_state_id.',
        };
    }
    const purge = maxAgeDays > 0
        ? ` Un état est supprimé ${maxAgeDays} jours après son enregistrement, même s'il sert : `
          + "save_state en crée un nouveau, sous l'identifiant de la session." : '';
    return {
        code: 'state_not_found',
        error: 'État sauvegardé introuvable (load_state_id).',
        fix: 'Utilisez le state_id rendu par save_state sur ce compte, ou démarrez sans '
           + `load_state_id.${purge}`,
    };
}

/** Nom de fichier sûr pour un téléchargement (jamais de chemin). */
export function safeDownloadName(name) {
    const base = String(name ?? '').split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '').trim();
    if (!base || base === '.' || base === '..') return 'telechargement';
    return base.slice(0, 200);
}

/**
 * Fichiers d'artefacts à purger : plus vieux que ``maxAgeMs``, sauf ceux que
 * ``keep(nom)`` garde. ``entries`` : ``[{ name, mtimeMs }]`` → noms à supprimer.
 */
export function planArtifactPurge(entries, { now = Date.now(), maxAgeMs, keep } = {}) {
    if (!maxAgeMs || maxAgeMs <= 0) return [];
    return (entries || [])
        .filter(e => e && now - (e.mtimeMs || 0) > maxAgeMs && !(keep && keep(e.name)))
        .map(e => e.name);
}


// Place pour une nouvelle session (audit 2026-09-30). Une session n'évince
// JAMAIS celle d'un autre propriétaire : au quota du propriétaire, ou du
// GROUPE (le compte et ses sous-agents, chacun a son propriétaire dérivé),
// sa plus ancienne session cède la place ; sans session à céder, le plafond
// du groupe ou le plafond global refuse. Un sous-agent n'évince donc ni la
// session du compte ni celle d'un frère.
// → { evict: sid|null, refuse: bool, cause?: 'groupe'|'global' }
export function planSessionSlot(sessions, owner, { maxTotal, maxPerOwner, group = owner, maxPerGroup = maxPerOwner, now = Date.now() } = {}) {
    const age = (s) => (s && (s.lastActivity || s.createdAt)) || now;
    const own = [];
    let total = 0;
    let dansGroupe = 0;
    for (const [sid, s] of sessions) {
        total += 1;
        if (!s) continue;
        if (s.owner === owner) own.push([sid, age(s)]);
        if ((s.group || s.owner) === group) dansGroupe += 1;
    }
    own.sort((a, b) => a[1] - b[1]);
    const groupePlein = dansGroupe >= maxPerGroup;
    if (own.length >= maxPerOwner || ((total >= maxTotal || groupePlein) && own.length)) {
        return { evict: own[0][0], refuse: false };
    }
    if (groupePlein) return { evict: null, refuse: true, cause: 'groupe' };
    if (total >= maxTotal) return { evict: null, refuse: true, cause: 'global' };
    return { evict: null, refuse: false };
}
