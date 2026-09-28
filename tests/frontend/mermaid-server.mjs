// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le rendu des diagrammes Mermaid dans le
// chat, et surtout son CHARGEMENT PARESSEUX : mermaid.min.js pèse 2,9 Mo et
// n'est plus posé en dur dans index.html.
// Lancement : PERF_PORT=8918 node tests/frontend/mermaid-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8918);
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

const DIAGRAM = [
    'graph TD',
    '  A[Requête] --> B{Cache ?}',
    '  B -->|oui| C[Réponse]',
    '  B -->|non| D[Calcul]',
    '  D --> C',
].join('\n');

// Un chat SANS diagramme (mermaid ne doit pas être chargé) et un AVEC.
const CHAT_SANS = {
    id: 'c1', title: 'Sans diagramme',
    messages: [
        { role: 'user', content: 'Bonjour' },
        { role: 'assistant', content: 'Bonjour ! Voici du code :\n\n```js\nconst x = 1;\n```\n' },
    ],
};
const CHAT_AVEC = {
    id: 'c2', title: 'Avec diagramme',
    messages: [
        { role: 'user', content: 'Schématise le flux.' },
        { role: 'assistant', content: 'Voici :\n\n```mermaid\n' + DIAGRAM + '\n```\n' },
    ],
};

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/api/saved/chats') return json(res, { items: [
            { id: 'c1', title: 'Sans diagramme', updated_at: 2 },
            { id: 'c2', title: 'Avec diagramme', updated_at: 1 },
        ] });
        if (url === '/api/saved/chats/c1') return json(res, CHAT_SANS);
        if (url === '/api/saved/chats/c2') return json(res, CHAT_AVEC);

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
}).listen(PORT, '127.0.0.1', () => console.log(`mermaid-server sur http://127.0.0.1:${PORT}`));
