// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le centre de notifications (panneau, toast à
// l'arrivée, deep-link, réglage OS) sans backend. Réplique @include + /static
// comme studio-server, mocke le boot logged-in + /api/notifications/* + un flux
// SSE /api/system-events avec INJECTION à la demande via /__inject.
// Lancement : PERF_PORT=8904 node tests/frontend/notif-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8904);
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
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
}

const NOW = Math.floor(Date.now() / 1000);
// 2 notifs au boot : une non-lue (erreur scénario, icône rouge) et une lue
// (routine OK, icône verte) — variété de kinds + état lu/non-lu.
const ITEMS = [
    { id: 6, kind: 'scenario_failed', title: 'Scénario « Login » : 1/3 en échec',
      body: '1 réussi(s), 1 en échec sur 3.', ref_type: 'scenario', ref_id: 6, read_at: null, created_at: NOW - 30 },
    { id: 5, kind: 'routine_ok', title: 'Routine « Backup » terminée',
      body: 'ok', ref_type: 'routine', ref_id: 7, read_at: NOW - 3600, created_at: NOW - 4000 },
];

const sseClients = new Set();
function injectNotif() {
    const payload = { type: 'notification', data: {
        user_id: 1, id: 999, kind: 'routine_error',
        title: 'Routine « Nightly » en échec', body: 'RuntimeError: boom',
        ref_type: 'routine', ref_id: 7, unread: 2,
    } };
    const line = 'data: ' + JSON.stringify(payload) + '\n\n';
    for (const res of sseClients) { try { res.write(line); } catch (_) {} }
    return sseClients.size;
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const m = req.method;
    try {
        // ── Contrôle du harnais : injecte une notif live ───────────────
        if (url === '/__inject') return json(res, { ok: true, sent: injectNotif() });

        // ── Centre de notifications ────────────────────────────────────
        if (url === '/api/notifications' && m === 'GET') {
            // Pagination : ?before=<id> → page suivante (vide ici).
            const before = (req.url.split('?')[1] || '').match(/before=(\d+)/);
            if (before) return json(res, { items: [], unread: 1 });
            return json(res, { items: ITEMS, unread: 1 });
        }
        if (url === '/api/notifications/unread-count') return json(res, { count: 1 });
        if (url.match(/^\/api\/notifications\/\d+\/(read|unread)$/) && m === 'PATCH')
            return json(res, { ok: true, unread: 0 });
        if (url === '/api/notifications/read-all' && m === 'POST') return json(res, { ok: true, marked: 1, unread: 0 });
        if (url === '/api/notifications/clear' && m === 'POST') return json(res, { ok: true, cleared: 2, unread: 0 });
        if (url.match(/^\/api\/notifications\/\d+$/) && m === 'DELETE') return json(res, { ok: true, unread: 0 });

        // ── Routines (pour le deep-link au clic) ───────────────────────
        if (url === '/api/routines' && m === 'GET')
            return json(res, { items: [{ id: 7, name: 'Backup', cron_expr: '0 3 * * *', enabled: 1,
                                         model: 'm1', task_prompt: 'x', mcp_servers: [], skills: [] }] });
        if (url.match(/^\/api\/routines\/\d+\/runs$/)) return json(res, { items: [] });

        // ── SSE système (injection via /__inject) ──────────────────────
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.setHeader('cache-control', 'no-cache'); res.setHeader('connection', 'keep-alive');
            res.write(': ping\n\n');
            sseClients.add(res);
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => { clearInterval(t); sseClients.delete(res); });
            return;
        }

        // ── Boot (logged-in) ───────────────────────────────────────────
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/saved/chats') return json(res, { items: [] });
        if (url.startsWith('/api/')) return json(res, {});

        // ── Statique ───────────────────────────────────────────────────
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
}).listen(PORT, '127.0.0.1', () => console.log(`notif-server sur http://127.0.0.1:${PORT}`));
