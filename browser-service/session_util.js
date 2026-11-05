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

/** Identifiants HTTP d'un contexte, liés à l'origine exacte de l'adresse de départ ; sans origine http(s), aucun : jamais d'identifiants sans origine. */
export function identifiantsPourOrigine(url, username, password) {
    if (!username || !password) return undefined;
    let u;
    try { u = new URL(url); } catch (_) { return undefined; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
    return { username, password, origin: u.origin, send: 'unauthorized' };
}

/** Avis au modèle d'un démarrage avec identifiants : non posés sur ce contexte, ou 401 d'une autre origine que la leur (redirection). */
export function avisIdentifiants(fournis, demandes, lies, statut, arrivee) {
    if (!fournis) return {};
    if (!demandes) return {
        credentials_applied: false,
        credentials_warning: 'Credentials were NOT applied: they need an http(s) start URL, whose exact origin is the only one that receives them.',
    };
    if (!lies || lies.origin !== demandes.origin || lies.username !== demandes.username) return {
        credentials_applied: false,
        credentials_warning: `Credentials were NOT applied: this reused session's browser context does not carry them for ${demandes.origin}, and credentials can only be set when a context is created. To use them, call pw_session(action='start') with the url and credentials and isolated=true for a fresh context, or close this session with action='stop' and start again.`,
    };
    if (statut !== 401) return {};
    let ailleurs;
    try { ailleurs = new URL(arrivee).origin; } catch (_) { return {}; }
    if (ailleurs === demandes.origin) return {};
    return {
        credentials_warning: `The start URL led to ${ailleurs}, which answered 401. Credentials are bound to ${demandes.origin} and are never sent to another origin. If they belong to ${ailleurs}, start on a URL of ${ailleurs} directly.`,
    };
}

/** Sessions que ferme le nettoyage de ``owner`` : les siennes et celles des sous-agents de son groupe. */
export function sessionsANettoyer(sessions, owner) {
    const o = safeOwner(owner);
    const sids = [];
    if (!o) return sids;
    for (const [sid, s] of sessions) if (s && (s.owner === o || (s.group || s.owner) === o)) sids.push(sid);
    return sids;
}

/** Sessions de sous-agents de tous les comptes (propriétaire dérivé ``s_…`` hors de son groupe) ouvertes depuis ``ageMinMs`` au moins ; jamais celle d'un compte. */
export function sessionsEnfantsAnciennes(sessions, { ageMinMs, now = Date.now() }) {
    const sids = [];
    for (const [sid, s] of sessions) {
        const enfant = !!s && !!s.group && s.owner !== s.group && String(s.owner || '').startsWith('s_');
        if (enfant && now - (s.createdAt || 0) >= ageMinMs) sids.push(sid);
    }
    return sids;
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
// la session connectée d'un autre) et ne les purge pas : un administrateur
// les supprime à la main.
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
 * sous l'ancien nom, jamais rechargé) ou ``state_not_found``. L'état d'un autre
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
                 + 'compte et ne se recharge jamais.',
            fix: 'Démarrez sans load_state_id (isolated=true si une session est déjà ouverte), '
               + 'reconnectez-vous au site puis save_state pour un nouvel état. Un administrateur '
               + `peut supprimer cookies/${ancien}.`,
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


// Quotas de sessions, lus de l'environnement : `BROWSER_MAX_SESSIONS` (comptes) et `BROWSER_MAX_CHILD_SESSIONS` (sous-agents) pour tout le service,
// `BROWSER_MAX_SESSIONS_PER_OWNER` (un propriétaire) et `BROWSER_MAX_SESSIONS_PER_GROUP` (le compte et ses sous-agents, jamais sous le quota d'un propriétaire).
export function quotasSessions(env = process.env) {
    const lire = (nom, defaut) => Math.max(1, parseInt(env[nom] || String(defaut), 10) || defaut);
    const maxPerOwner = lire('BROWSER_MAX_SESSIONS_PER_OWNER', 3);
    return {
        maxTotal: lire('BROWSER_MAX_SESSIONS', 10),
        maxChildren: lire('BROWSER_MAX_CHILD_SESSIONS', 6),
        maxPerOwner,
        maxPerGroup: Math.max(maxPerOwner, lire('BROWSER_MAX_SESSIONS_PER_GROUP', 4)),
    };
}

// Sessions d'un groupe : celles du compte (propriétaire = groupe) et celles de ses sous-agents à session isolée.
export function occupationGroupe(sessions, group) {
    let compte = 0;
    let enfants = 0;
    for (const s of sessions.values()) {
        if (!s || (s.group || s.owner) !== group) continue;
        if (s.owner === group) compte += 1;
        else enfants += 1;
    }
    return { compte, enfants };
}

// Places que les sous-agents se partagent : le groupe moins la session du compte, ou la place qui lui reste réservée
// tant qu'il n'en a pas (le chat n'est jamais refusé parce que ses enfants occupent tout).
export function placesEnfants(occupation, maxPerGroup) {
    return Math.max(0, maxPerGroup - Math.max(1, occupation.compte));
}

// Place pour une nouvelle session (audit 2026-09-30). Une session n'évince
// JAMAIS celle d'un autre propriétaire : au quota du propriétaire, ou du
// GROUPE (le compte et ses sous-agents, chacun a son propriétaire dérivé),
// sa plus ancienne session cède la place ; sans session à céder, le plafond
// du groupe ou le plafond global refuse. Un sous-agent n'évince donc ni la
// session du compte ni celle d'un frère ; une place du groupe reste au compte, et les enfants ont leur plafond global (`maxChildren`).
// → { evict: sid|null, refuse: bool, cause?: 'groupe'|'global' }
export function planSessionSlot(sessions, owner, { maxTotal, maxPerOwner, group = owner, maxPerGroup = maxPerOwner, maxChildren = maxTotal, now = Date.now() } = {}) {
    const age = (s) => (s && (s.lastActivity || s.createdAt)) || now;
    const enfant = owner !== group;
    const own = [];
    let total = 0;
    for (const [sid, s] of sessions) {
        if ((!!s && (s.group || s.owner) !== s.owner) === enfant) total += 1;
        if (s && s.owner === owner) own.push([sid, age(s)]);
    }
    own.sort((a, b) => a[1] - b[1]);
    const occupation = occupationGroupe(sessions, group);
    const groupePlein = owner === group
        ? occupation.compte + occupation.enfants >= maxPerGroup
        : occupation.enfants >= placesEnfants(occupation, maxPerGroup);
    const plafond = enfant ? maxChildren : maxTotal;
    if (own.length >= maxPerOwner || ((total >= plafond || groupePlein) && own.length)) {
        return { evict: own[0][0], refuse: false };
    }
    if (groupePlein) return { evict: null, refuse: true, cause: 'groupe' };
    if (total >= plafond) return { evict: null, refuse: true, cause: 'global' };
    return { evict: null, refuse: false };
}
