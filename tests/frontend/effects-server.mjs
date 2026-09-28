// SPDX-License-Identifier: MIT
// Harnais route-mock : lignes d'EFFETS du message (écritures mémoire +
// liste de tâches, 2026-09-19), sans backend.
// Lancement : PERF_PORT=8952 node tests/frontend/effects-server.mjs
//
// - GET /api/saved/chats/c1 : message assistant PERSISTÉ (tool_history delta)
//   avec read_file, memory add (op aa11bb22), todowrite, memory add refusée
//   (over_limit), memory replace (op cc33dd44) → reconstruction au reload.
// - GET  /api/memory/ops/{op}      : détail (ajouté / retiré, annulable ?)
// - POST /api/memory/ops/{op}/undo : aa11bb22 → OK ; autre → 409
// - GET  /api/memory/state         : notes + origines (chat c1, Réglages)
// - POST /api/chat-saved-stream3   : flux live memory add + todowrite + texte
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8952);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

function applyIncludes(html) {
    for (let i = 0; i < 8; i++) {
        let changed = false;
        html = html.replace(/<!--\s*@include\s+(\S+)\s*-->/g, (m, rel) => {
            changed = true;
            try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
            catch (e) { return `<!-- include manquant: ${rel} -->`; }
        });
        if (!changed) break;
    }
    return html;
}
function json(res, obj, status = 200) {
    res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj));
}

const call = (id, name, args) => ({ role: 'assistant', content: '', tool_calls: [
    { id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
const result = (id, obj) => ({ role: 'tool', tool_call_id: id,
    content: typeof obj === 'string' ? obj : JSON.stringify(obj) });

const TH = [
    call('r1', 'read_file', { path: 'src/app.py' }),
    result('r1', 'def main(): ...'),
    call('m1', 'memory', { action: 'add', store: 'user', content: 'Préfère des réponses concises',
                           title: 'Je retiens que tu préfères des réponses concises' }),
    result('m1', { ok: true, action: 'add', store: 'user', id: 'a1f4', op: 'aa11bb22',
                   usage: '12% · 30/1375 chars · 1 entry', note: 'Saved. Done — do not repeat this call.' }),
    call('t1', 'todowrite', { todos: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] }),
    result('t1', { ok: true, done: 1, total: 2, remaining: 1, in_progress: 'B', completed_now: ['A'],
                   checklist: '1. [completed] A\n2. [in_progress] B', notes: [], persisted: true }),
    call('m2', 'memory', { action: 'add', store: 'memory', content: 'Note trop longue' }),
    result('m2', { ok: false, action: 'add', store: 'memory', error: 'over_limit',
                   message: 'exceeds the limit (2300/2200 chars)', fix: 'Consolidate.', entries: [] }),
    call('m3', 'memory', { action: 'replace', store: 'memory', target: '[b2c7]', content: 'Le service écoute sur 8443' }),
    result('m3', { ok: true, action: 'replace', store: 'memory', id: 'c9d0', op: 'cc33dd44',
                   usage: '20%', note: 'Updated. Done — do not repeat this call.' }),
];

const CHAT = {
    id: 'c1', title: 'Demo effets',
    messages: [
        { role: 'user', content: 'Retiens mes préférences' },
        { role: 'assistant', content: 'Réponse finale après écritures.', tool_history: TH, tool_history_delta: true },
    ],
};

const OPS = {
    aa11bb22: { op: 'aa11bb22', ts: 1758268800, action: 'add', store: 'user', source: 'tool',
                title: 'Je retiens que tu préfères des réponses concises',
                added: ['Préfère des réponses concises'], removed: [], n_before: 0, n_after: 1,
                undone: false, can_undo: true },
    cc33dd44: { op: 'cc33dd44', ts: 1758268800, action: 'replace', store: 'memory', source: 'tool',
                title: null, added: ['Le service écoute sur 8443'], removed: ['Le service écoute sur 8080'],
                n_before: 2, n_after: 2, undone: false, can_undo: false },
};
const counters = { undo: 0 };

const STATE = {
    username: 'alice', scopes: [],
    user_md: { exists: true, limit: 1375, chars: 30, usage_pct: 2.2, n_entries: 1,
               entries: ['Préfère des réponses concises'], entry_ids: ['a1f4'],
               origins: [{ ts: 1758268800, source: 'tool', chat_id: 'c1', op: 'aa11bb22',
                           chat_title: 'Demo effets', chat_exists: true }] },
    memory_md: { exists: true, limit: 2200, chars: 40, usage_pct: 1.8, n_entries: 2,
                 entries: ['Le service écoute sur 8443', 'Ancienne note'], entry_ids: ['c9d0', 'e5f6'],
                 origins: [{ ts: 1758268800, source: 'settings', chat_id: null, op: 'x' }, null] },
};

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const m = req.method;
    try {
        if (url === '/api/saved/chats' && m === 'GET') return json(res, { items: [{ id: 'c1', title: 'Demo effets', updated_at: 0 }] });
        if (url === '/api/saved/chats/c1') return json(res, CHAT);
        if (url === '/__counters') return json(res, counters);

        let mm = url.match(/^\/api\/memory\/ops\/([0-9a-f]+)\/undo$/);
        if (mm && m === 'POST') {
            counters.undo++;
            if (mm[1] === 'aa11bb22') {
                OPS.aa11bb22 = { ...OPS.aa11bb22, undone: true, can_undo: false };
                return json(res, { ok: true, op: OPS.aa11bb22 });
            }
            return json(res, { detail: 'la mémoire a changé depuis cette écriture' }, 409);
        }
        mm = url.match(/^\/api\/memory\/ops\/([0-9a-f]+)$/);
        if (mm) return OPS[mm[1]] ? json(res, OPS[mm[1]]) : json(res, { detail: 'écriture inconnue' }, 404);
        if (url === '/api/memory/state') return json(res, STATE);
        if (url === '/api/settings') return json(res, { memory_enabled: true });

        if (url === '/api/chat-saved-stream3' && m === 'POST') {
            req.on('data', () => {});
            req.on('end', async () => {
                res.statusCode = 200;
                res.setHeader('content-type', 'application/x-ndjson');
                const send  = (o) => res.write(JSON.stringify(o) + '\n');
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                await sleep(150);
                send({ type: 'tool_call', name: 'memory', call_id: 'L1',
                       args: { action: 'add', store: 'memory', content: 'Le build exige --release',
                               title: 'Je retiens le drapeau de build' } });
                await sleep(1200);          // fenêtre pour voir l'état « en cours »
                send({ type: 'tool_result', name: 'memory', call_id: 'L1',
                       result: JSON.stringify({ ok: true, action: 'add', store: 'memory', id: 'f00d',
                                                op: 'ee55ff66', usage: '5%', note: 'Saved.' }) });
                send({ type: 'tool_call', name: 'todowrite', call_id: 'L2',
                       args: { todos: [{ content: 'X', status: 'completed' }, { content: 'Y', status: 'in_progress' },
                                       { content: 'Z', status: 'pending' }] } });
                send({ type: 'todo_updated', todos: [
                    { content: 'X', status: 'completed' }, { content: 'Y', status: 'in_progress' },
                    { content: 'Z', status: 'pending' }], remaining: 2 });
                send({ type: 'tool_result', name: 'todowrite', call_id: 'L2',
                       result: JSON.stringify({ ok: true, done: 1, total: 3, remaining: 2, in_progress: 'Y',
                                                completed_now: ['X'], checklist: '…', notes: [], persisted: true }) });
                for (const w of 'Voilà, c\'est noté pour la suite.'.split(' ')) {
                    send({ type: 'content_token', text: w + ' ' }); await sleep(40);
                }
                send({ type: 'final', chat_id: 'c1', title: 'Demo effets', persisted: true });
                res.end();
            });
            return;
        }

        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.write(': ping\n\n'); const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => clearInterval(t)); return;
        }
        if (url.startsWith('/api/')) return json(res, {});

        if (url === '/' || url === '/index.html') {
            res.setHeader('content-type', 'text/html');
            res.end(applyIncludes(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'))); return;
        }
        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const p = path.join(ROOT, rel);
        if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
        res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
        res.end(fs.readFileSync(p));
    } catch (e) { res.statusCode = 404; res.end('nf'); }
}).listen(PORT, '127.0.0.1', () => console.log(`effects-server sur http://127.0.0.1:${PORT}`));
