// SPDX-License-Identifier: MIT
// Harnais route-mock servant l'application en DEUX variantes, pour prouver que
// la feuille Tailwind précompilée couvre ce que le compilateur produisait :
//
//   /        → variante CDN      (compilateur JIT dans le navigateur)
//   /statique → variante figée   (frontend/css/style.tailwind.css)
//
// Lancement : PERF_PORT=8940 node tests/frontend/tailwind-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8940);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json' };

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

const CDN_TAG = '<script src="static/vendor/tailwind.js"></script>';

// L'application sert désormais la feuille PRÉCOMPILÉE. C'est donc la variante
// CDN qui est dérivée : on retire le <link> et on remet le compilateur.
//
// L'ordre de cascade est le piège de cette bascule et la raison pour laquelle
// le <link> vit en FIN de <head> : le compilateur ajoutait sa <style> là,
// c'est-à-dire APRÈS Phosphor et style.css. Plus haut, « .ph {line-height: 1} »
// l'emporterait sur « text-lg ». Le retirer sans y penser réintroduirait
// exactement l'écart que ce harnais a servi à détecter.
// Le <link> porte un ?v= réécrit au BUILD_ID par le serveur applicatif : la
// correspondance doit rester insensible à cette version.
const STATIC_RE = /<link rel="stylesheet" href="static\/css\/style\.tailwind\.css[^"]*">/;

function page(file, variante) {
    let html = applyIncludes(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    if (variante === 'cdn') {
        if (!STATIC_RE.test(html)) {
            throw new Error('feuille précompilée introuvable dans ' + file);
        }
        html = html.replace(STATIC_RE, '')
                   .replace('</head>', '    ' + CDN_TAG + '\n</head>');
    }
    return html;
}

const CHAT = {
    id: 'c1', title: 'Démo',
    messages: [
        { role: 'user', content: 'Bonjour' },
        { role: 'assistant', content: 'Salut !\n\n```js\nconst x = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n' },
    ],
};

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/api/saved/chats') return json(res, { items: [{ id: 'c1', title: 'Démo', updated_at: 0 }] });
        if (url === '/api/saved/chats/c1') return json(res, CHAT);
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 1, role: 'admin' });
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
        // Page d'arrivée de la console (Vue d'ensemble) : alertes, services,
        // chiffres, installation — de quoi comparer du contenu réel.
        if (url.startsWith('/api/admin/overview')) return json(res, {
            generated_at: Date.now() / 1000 - 8, role: 'admin',
            alerts: [
                { id: 'restart', level: 'warn', title: 'Redémarrage nécessaire', detail: '', paths: ['llama.ip'], action: 'restart' },
                { id: 'svc-rag', level: 'danger', title: 'RAG injoignable', detail: '127.0.0.1:8000', page: 'rag', action: 'page' },
            ],
            services: [
                { id: 'llm', label: 'Moteur local', target: '127.0.0.1:8080', state: 'ok', detail: '1 modèle chargé', page: 'inference' },
                { id: 'rag', label: 'RAG', target: '127.0.0.1:8000', state: 'down', detail: '', page: 'rag' },
                { id: 'vision', label: 'Vision', target: '', state: 'off', detail: 'Non configurée', page: 'vision' },
                { id: 'database', label: 'Base', target: 'SQLite', state: 'ok', detail: '12,0 Mo', page: 'data' },
            ],
            kpis: { users: 2, turns: 14, tokens: 8200, failures: 0, tool_calls: 9, tool_failures: 1 },
            backup: { at: Date.now() / 1000 - 3 * 86400 },
            setup: [{ id: 'https', label: 'Accès HTTPS', done: false, page: 'https' },
                    { id: 'name', label: 'Nommer l’instance', done: true, page: 'instance' }],
            restart: { pending: ['llama.ip'] },
        });
        // Supervision › Métriques : quelques
        // indicateurs et un tableau, pour que la parité porte sur du contenu
        // réel et pas sur une page vide.
        if (url.startsWith('/api/admin/stats-dynamic')) return json(res, {
            layout: [
                { id: 'k1', title: 'Utilisateurs actifs', type: 'value', width: '1/4', category: 'activity', default: true },
                { id: 'k2', title: 'Conversations', type: 'value', width: '1/4', category: 'activity', default: true },
                { id: 'k3', title: 'Tokens consommés', type: 'value', width: '1/4', category: 'volume', default: true },
                { id: 'k4', title: 'RAM', type: 'value', width: '1/4', category: 'system', default: true },
                { id: 't1', title: 'Pics par utilisateur', type: 'table', width: 'full', category: 'activity', default: true },
            ],
            data: {
                k1: { value: 5, unit: 'actifs / 24 h', icon: 'ph-user-circle' },
                k2: { value: 42, unit: 'actives', icon: 'ph-chat-dots', detail: '3 nouvelles' },
                k3: { value: '43.4 k', unit: 'tokens', icon: 'ph-lightning' },
                k4: { value: '4 Go', unit: '/ 16 Go', icon: 'ph-memory', state: 'warn' },
                t1: { columns: [{ key: 'u', label: 'Utilisateur' }, { key: 'n', label: 'Tokens', align: 'right' }],
                      rows: [{ u: 'alice', n: '12 k' }, { u: 'bob', n: '37.8 k' }] },
            },
        });
        if (url.startsWith('/api/')) return json(res, {});

        if (url === '/' || url === '/index.html') {
            res.setHeader('content-type', 'text/html'); res.end(page('index.html', 'cdn')); return;
        }
        if (url === '/statique') {
            res.setHeader('content-type', 'text/html'); res.end(page('index.html', 'statique')); return;
        }
        if (url === '/admin') {
            res.setHeader('content-type', 'text/html'); res.end(page('admin.html', 'cdn')); return;
        }
        if (url === '/admin-statique') {
            res.setHeader('content-type', 'text/html'); res.end(page('admin.html', 'statique')); return;
        }

        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const p = path.join(ROOT, rel);
        if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
        res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
        res.end(fs.readFileSync(p));
    } catch (e) { res.statusCode = 404; res.end('nf'); }
}).listen(PORT, '127.0.0.1', () => console.log(`tailwind-server sur http://127.0.0.1:${PORT}`));
