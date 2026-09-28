// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le panneau todo-list du composeur
// (repli automatique en fin de tour, disparition liste soldée/abandonnée,
// spacer + bouton « descendre » calés sur la hauteur réelle du composeur),
// sans backend. Réplique @include + /static comme truncate-server, et mocke
// le stream NDJSON /api/chat-saved-stream3 piloté par le TEXTE du message :
//   « travaille » → todo_updated (2/3, une in_progress) puis final ;
//   « finis »     → todo_updated (3/3 completed) puis final ;
//   sinon         → tokens seuls (liste ignorée tout le tour) puis final.
// Lancement : PERF_PORT=8921 node tests/frontend/todo-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8921);
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

// Chat long (pour un scroll réel + bouton « descendre ») avec une todo-list
// ouverte persistée : seed meta_json["todos"] → le panneau s'affiche au load.
const LONG = 'Ligne de contenu pour donner de la hauteur au fil du chat.\n'.repeat(18);
const CHAT = {
    id: 'c1', title: 'Demo todo',
    todos: [
        { content: 'Analyser le code existant', status: 'completed' },
        { content: 'Écrire le correctif',       status: 'in_progress' },
        { content: 'Lancer les tests',          status: 'pending' },
    ],
    messages: Array.from({ length: 4 }, (_, i) => ([
        { role: 'user', content: `Question ${i + 1} : peux-tu détailler ?` },
        { role: 'assistant', content: `Réponse ${i + 1}.\n${LONG}` },
    ])).flat(),
};

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const m = req.method;
    try {
        if (url === '/api/saved/chats' && m === 'GET') return json(res, { items: [{ id: 'c1', title: 'Demo todo', updated_at: 0 }] });
        if (url === '/api/saved/chats/c1') return json(res, CHAT);

        if (url === '/api/chat-saved-stream3' && m === 'POST') {
            let body = '';
            req.on('data', (c) => body += c);
            req.on('end', async () => {
                let last = '';
                try {
                    const j = JSON.parse(body);
                    const us = (j.messages || []).filter(x => x && x.role === 'user');
                    last = String((us[us.length - 1] || {}).content || '');
                } catch (_) {}
                res.statusCode = 200;
                res.setHeader('content-type', 'application/x-ndjson');
                const send  = (o) => res.write(JSON.stringify(o) + '\n');
                const sleep = (ms) => new Promise(r => setTimeout(r, ms));
                const say   = async (txt) => {
                    for (const w of txt.split(' ')) { send({ type: 'content_token', text: w + ' ' }); await sleep(60); }
                };
                await sleep(150);
                if (/travaille/i.test(last)) {
                    send({ type: 'todo_updated', todos: [
                        { content: 'Analyser le code existant', status: 'completed' },
                        { content: 'Écrire le correctif',       status: 'completed' },
                        { content: 'Lancer les tests',          status: 'in_progress' },
                    ] });
                    await say('Je progresse sur les tâches de la liste, il en reste une.');
                } else if (/finis/i.test(last)) {
                    send({ type: 'todo_updated', todos: [
                        { content: 'Analyser le code existant', status: 'completed' },
                        { content: 'Écrire le correctif',       status: 'completed' },
                        { content: 'Lancer les tests',          status: 'completed' },
                    ] });
                    await say('Toutes les tâches sont maintenant terminées.');
                } else {
                    await say('Je réponds à côté sans toucher à la liste de tâches du tout.');
                }
                send({ type: 'final', chat_id: 'c1', title: 'Demo todo' });
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
}).listen(PORT, '127.0.0.1', () => console.log(`todo-server sur http://127.0.0.1:${PORT}`));
