// SPDX-License-Identifier: MIT
/** browser-service/src/routes/simulations.ts — /mock/* : réponses simulées pour les requêtes d'une session. */
import type { Application, Request, Response } from 'express';

import type { ServiceContext, Session, Simulation } from '../contexte.ts';
import { intercepteurs } from '../requete.ts';

/** Corps de /mock/add, chaque champ vérifié par mockValide. */
interface CorpsMockAjout {
    url_pattern?: unknown;
    is_regex?: unknown;
    method?: unknown;
    body?: unknown;
    content_type?: unknown;
    headers?: unknown;
    status?: unknown;
    delay_ms?: unknown;
    times?: unknown;
}

/** Corps de /mock/remove. */
interface CorpsMockRetrait {
    url_pattern?: string;
    id?: string;
}

/** Erreur invalid_mock du premier champ invalide. */
interface RefusMock {
    error: string;
    code: 'invalid_mock';
    field: string;
    fix: string;
}

/** Issue de mockValide : le mock vérifié (et un avertissement), ou l'erreur. */
type MockVerifie =
    | { erreur: RefusMock; mock?: undefined; warning?: undefined }
    | { erreur?: undefined; mock: Omit<Simulation, 'id' | 'created_at'>; warning?: string };

// ════════════════════════════════════════════════════════════════════
// MOCK — network response stubbing per session
// ════════════════════════════════════════════════════════════════════
// Each session keeps its own mock list under session._mocks. The route
// handler is registered ONCE per session lazily; subsequent add/remove
// calls only mutate the list (no double-route registration); none during a vault login.
async function ensureMockHandler(session: Session) {
    if (session._mockHandlerRegistered) return;
    const { context } = session;
    session._mocks = session._mocks || [];
    // Use context.route so it covers all pages in the session (incl. new tabs).
    await context.route('**/*', async (route, request) => {
        if (session._mocksSuspendus) return route.fallback().catch(() => {});
        const url = request.url();
        const method = request.method();
        const mocks = session._mocks || [];
        // Le premier mock ajouté l'emporte quand plusieurs correspondent (le plus précis d'abord, un attrape-tout ensuite).
        for (const m of mocks) {
            if (m._exhausted) continue;
            if (m.method && m.method.toUpperCase() !== method) continue;
            if (!(m._re ? m._re.test(url) : url.includes(m.url_pattern))) continue;
            if (m.delay_ms && m.delay_ms > 0) await new Promise(r => setTimeout(r, m.delay_ms));
            m._used = (m._used || 0) + 1;
            if (m.times !== -1 && m._used >= m.times) m._exhausted = true;
            try {
                await route.fulfill({
                    status: m.status,
                    contentType: m.content_type,
                    body: m.body || '',
                    headers: m.headers || {},
                });
            } catch { m._used -= 1; /* route may have been aborted by another handler */ }
            return;
        }
        // Aucun mock : on passe la main (la garde des destinations décide).
        try { await route.fallback(); } catch { /* route already handled or page gone */ }
    });
    session._mockHandlerRegistered = true;
}

const METHODES_HTTP = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const NOTE_PRIORITE = 'When several mocks match a request, the first added (still active) wins: add the most specific first, a catch-all last.';

// Mock validé : motif (sous-chaîne ; expression régulière avec is_regex, brute ou /…/drapeaux), statut 100-599, délai, fois, méthode, corps et en-têtes textes ; sinon l'erreur invalid_mock du premier champ fautif.
function mockValide(b: CorpsMockAjout): MockVerifie {
    const refus = (champ: string, message: string): MockVerifie => ({ erreur: { error: message, code: 'invalid_mock', field: champ,
        fix: 'Fix that field and call add again: url_pattern (substring, or regular expression with is_regex=true), status 100-599, delay_ms 0-60000, times -1 (unlimited) or 1 and more.' } });
    const entier = (v: unknown, defaut: number): number => (v === undefined || v === null ? defaut : (typeof v === 'number' || (typeof v === 'string' && /^-?\d+$/.test(v.trim()))) && Number.isInteger(Number(v)) ? Number(v) : NaN);
    const { url_pattern: motif, is_regex = false, method = '', body = '', content_type = 'application/json', headers = {} } = b;
    if (typeof motif !== 'string' || !motif) return refus('url_pattern', 'url_pattern is required (a non-empty string).');
    if (typeof is_regex !== 'boolean') return refus('is_regex', 'is_regex must be true or false.');
    let re = null;
    if (is_regex) {
        const delimite = /^\/(.+)\/([a-z]*)$/s.exec(motif);
        try { re = delimite ? new RegExp(delimite[1]!, delimite[2]!.replace(/[gy]/g, '')) : new RegExp(motif); }
        catch (e) { return refus('url_pattern', `url_pattern is not a valid regular expression: ${(e as Error).message}`); }
    }
    const status = entier(b.status, 200), delai = entier(b.delay_ms, 0), fois = entier(b.times, -1);
    if (!(status >= 100 && status <= 599)) return refus('status', `status must be an HTTP status between 100 and 599 (got ${JSON.stringify(b.status)}).`);
    if (!(delai >= 0 && delai <= 60000)) return refus('delay_ms', `delay_ms must be between 0 and 60000 (got ${JSON.stringify(b.delay_ms)}).`);
    if (!(fois === -1 || fois >= 1)) return refus('times', `times must be -1 (unlimited) or at least 1 (got ${JSON.stringify(b.times)}).`);
    if (typeof method !== 'string' || (method && !METHODES_HTTP.has(method.toUpperCase()))) return refus('method', `method must be empty (any) or one of ${[...METHODES_HTTP].join(', ')}.`);
    if (body !== null && typeof body !== 'string') return refus('body', 'body must be a string (serialize JSON yourself).');
    if (typeof content_type !== 'string') return refus('content_type', 'content_type must be a string.');
    if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.values(headers).some(v => typeof v !== 'string'))
        return refus('headers', 'headers must be an object of strings.');
    const airRegex = !is_regex && /\.[*+]|\\[dwsDWS.?/]|^\^|\$$/.test(motif);
    return { mock: { url_pattern: motif, is_regex, _re: re, status, body: body || '', content_type, delay_ms: delai, times: fois,
                     method: method.toUpperCase(), headers: headers as Record<string, string> },
             ...(airRegex ? { warning: 'url_pattern is matched as a plain substring of the URL; it looks like a regular expression: add is_regex=true to match it as one.' } : {}) };
}

export function registerMockRoutes(app: Application, ctx: ServiceContext) {
const { getSession } = intercepteurs(ctx);
app.post('/mock/add', getSession, async (req: Request<CorpsMockAjout>, res: Response): Promise<Response | void> => {
    try {
        const v = mockValide(req.body);
        if (v.erreur) return res.status(400).json(v.erreur);
        await ensureMockHandler(req.session!);
        req.session!._mocks = req.session!._mocks || [];
        const id = `mock_${Math.random().toString(36).substring(2, 10)}`;
        req.session!._mocks.push({ id, ...v.mock, _used: 0, _exhausted: false, created_at: Date.now() });
        const n = req.session!._mocks.length;
        res.json({ status: 'added', id, mocks_count: n, is_regex: v.mock.is_regex,
                   ...(n > 1 ? { note: NOTE_PRIORITE } : {}), ...(v.warning ? { warning: v.warning } : {}) });
    } catch (e) { res.status(500).json({ error: (e as Error).message }); }
});

app.get('/mock/list', getSession, async (req: Request, res: Response) => {
    const list = (req.session!._mocks || []).map(m => ({
        id: m.id, url_pattern: m.url_pattern, status: m.status,
        delay_ms: m.delay_ms, times: m.times, used: m._used || 0,
        exhausted: !!m._exhausted, method: m.method || 'ANY',
        is_regex: !!m.is_regex,
    }));
    res.json({ count: list.length, mocks: list, precedence: NOTE_PRIORITE });
});

app.post('/mock/clear', getSession, async (req: Request, res: Response) => {
    const n = (req.session!._mocks || []).length;
    req.session!._mocks = [];
    res.json({ status: 'cleared', removed: n });
});

app.post('/mock/remove', getSession, async (req: Request<CorpsMockRetrait>, res: Response) => {
    const { url_pattern, id } = req.body;
    const before = (req.session!._mocks || []).length;
    req.session!._mocks = (req.session!._mocks || []).filter(m =>
        (id && m.id === id) ? false :
        (url_pattern && m.url_pattern === url_pattern) ? false :
        true
    );
    res.json({ status: 'removed', removed: before - req.session!._mocks.length });
});
}
