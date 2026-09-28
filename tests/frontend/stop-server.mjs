// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER CE QUE LE STOP NETTOIE.
// Lancement : PERF_PORT=8931 node tests/frontend/stop-server.mjs
//
// Le flux ouvre un tour, pose les témoins « travail en cours » (bandeau file
// d'attente, ligne de statut du message, témoin de run dans la liste des
// conversations), puis NE SE FERME JAMAIS. C'est exactement la situation d'un
// Stop : le client abort le fetch, et tous les événements de fin — dont
// ``queue_cleared`` et ``final`` — sont perdus. Ce qui reste à l'écran après
// l'abort est donc ce que ``stopGeneration()`` doit nettoyer lui-même.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8931);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

const appels = { cancel: 0 };

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
const json = (res, obj, status = 200) => {
    res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(obj));
};

// Ni 'final', ni 'queue_cleared' : le tour reste ouvert jusqu'à l'abort.
const STREAM = [
    { type: 'queue_status', kind: 'waiting', position: 2, active: 1, est_ms: 30000 },
    { type: 'mode', text: 'RAG Outils' },
    { type: 'content_token', text: 'Je commence à répondre' },
];

function streamTurn(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    let i = 0;
    const tick = () => {
        if (i < STREAM.length) {
            try { res.write(JSON.stringify(STREAM[i++]) + '\n'); } catch (_) { return; }
        }
        setTimeout(tick, 200);          // et on ne finit jamais
    };
    tick();
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/__test/calls') return json(res, appels);
        if (url === '/api/chat/cancel' && req.method === 'POST') {
            appels.cancel++;
            req.on('data', () => {}); req.on('end', () => json(res, { ok: true }));
            return;
        }
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            req.on('data', () => {}); req.on('end', () => streamTurn(res));
            return;
        }
        // Un run vivant sur la conversation courante : c'est le témoin de la
        // liste des conversations (chantier C).
        if (url === '/api/chat/active-runs') return json(res, { runs: [{ chat_id: 'c1' }] });
        if (url === '/api/settings') return json(res, { hide_thinking: false, live_shell_enabled: true });
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/saved/chats') return json(res, { items: [] });
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
}).listen(PORT, '127.0.0.1', () => console.log(`stop-server sur http://127.0.0.1:${PORT}`));
