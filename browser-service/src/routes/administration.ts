// SPDX-License-Identifier: MIT
/** browser-service/src/routes/administration.ts — /sessions, /cleanup, /cleanup_children : sessions d'un propriétaire et leur nettoyage. */
import type { Application, Request, Response } from 'express';

import type { ServiceContext } from '../contexte.ts';
import { occupationGroupe, ownerFromRequest, sessionsANettoyer, sessionsEnfantsAnciennes } from '../session_util.ts';
import { MAX_SESSIONS_PER_GROUP, MAX_SESSIONS_PER_OWNER, SESSION_TTL_MS, closeSession, killZombieProcesses } from '../sessions.ts';

/** Requête de /sessions. */
interface QuerySessions {
    owner?: string;
}

/** Corps de /cleanup. */
interface CorpsNettoyage {
    owner?: string;
}

/** Corps de /cleanup_children. */
interface CorpsNettoyageEnfants {
    older_than_ms?: number;
}

export function registerAdminRoutes(app: Application, ctx: ServiceContext) {
const { sessions } = ctx;
// ======================== SESSION LIST (admin) ========================
app.get('/sessions', (req: Request<unknown, QuerySessions>, res: Response) => {
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
            active_tab: s.tabs ? s.tabs.indexOf(s.page) : 0,
            ttl_remaining_sec: Math.max(0, Math.round((SESSION_TTL_MS - (now - (s.lastActivity || now))) / 1000)),
            ...(s.isolated ? { isolated: true } : {}), ...(s.tls ? { secret: true } : {}),
        });
    }
    // Plafonds : par propriétaire, par groupe (le compte et ses sous-agents), et ce que ce propriétaire peut encore ouvrir.
    const groupe = owner ? occupationGroupe(sessions, owner) : { compte: 0, enfants: 0 };
    const effectif = Math.max(0, Math.min(MAX_SESSIONS_PER_OWNER, MAX_SESSIONS_PER_GROUP - groupe.enfants));
    res.json({ count: list.length, max_per_owner: MAX_SESSIONS_PER_OWNER, max_per_group: MAX_SESSIONS_PER_GROUP,
               effective_max: effectif, ttl_min: SESSION_TTL_MS / 60000, sessions: list,
               limits_note: `You can keep ${effectif} session(s) at once (${MAX_SESSIONS_PER_OWNER} per owner, ${MAX_SESSIONS_PER_GROUP} for the account and its sub-agents). At the limit, start closes your oldest idle session (an isolated one first) and says so; a busy session or one opened for a secret is never closed.` });
});

// ======================== FORCE CLEANUP ========================
app.post('/cleanup', async (req: Request<CorpsNettoyage>, res: Response): Promise<Response | void> => {
    // Ferme les sessions du propriétaire appelant et celles des sous-agents de son groupe (jamais celles d'un autre compte).
    const owner = ownerFromRequest(req);
    if (!owner) return res.status(400).json({ error: 'owner requis.' });
    const siennes = sessionsANettoyer(sessions, owner);
    for (const sid of siennes) await closeSession(ctx, sid, 'force_cleanup');
    killZombieProcesses();
    res.json({ cleaned: siennes.length });
});

// Sessions des sous-agents ouvertes depuis `older_than_ms`, jamais celle du compte ; sans propriétaire : le core, à son démarrage (celles des runs du process précédent).
app.post('/cleanup_children', async (req: Request<CorpsNettoyageEnfants>, res: Response): Promise<Response | void> => {
    const ageMinMs = req.body?.older_than_ms;
    if (typeof ageMinMs !== 'number' || !(ageMinMs >= 0)) return res.status(400).json({ error: 'older_than_ms requis (ms, >= 0).' });
    const sids = sessionsEnfantsAnciennes(sessions, { ageMinMs });
    for (const sid of sids) await closeSession(ctx, sid, 'orphan_children');
    res.json({ cleaned: sids.length });
});
}
