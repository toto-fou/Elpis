// SPDX-License-Identifier: MIT
// Harnais route-mock pour le formulaire de CONNECTEUR MCP (modale « Serveurs
// MCP externes ») — créneaux d'identifiants supplémentaires 2026-08-30 :
// en-têtes cumulables avec le mode d'auth (cas wiki.js : un Bearer pour le
// serveur MCP, une clé d'API pour le wiki), et variables d'environnement pour
// un serveur local.
//
// Mocke : un compte ADMIN (les formulaires d'édition et la publication lui sont
// réservés), un serveur perso EXISTANT dont la vue publique porte le NOM d'un
// en-tête sans sa valeur (``has_value``), la bibliothèque partagée, et la
// capture des PUT /api/settings et POST /api/mcp/test (GET /__puts).
// Lancement : PERF_PORT=8923 node tests/frontend/mcpcreds-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8923);
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
function readBody(req, cb) {
    let body = '';
    req.on('data', (c) => body += c);
    req.on('end', () => { try { cb(JSON.parse(body) || {}); } catch (_) { cb({}); } });
}

// Vue PUBLIQUE d'un serveur perso : le nom de l'en-tête circule, jamais sa
// valeur — c'est exactement ce que rend ``personal_public``.
const SETTINGS = {
    enable_mcp: true,
    mcp_servers: [
        { id: 'srv1', name: 'Wiki existant', type: 'http',
          url: 'http://wiki.local:4445/mcp', visible: true,
          auth_mode: 'bearer', auth_user: '', has_auth: true,
          headers: [{ name: 'X-API-Key', value: '', has_value: true }],
          env: [] },
    ],
};

const settingsPuts = [];
const testPosts = [];

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const m = req.method;
    try {
        if (url === '/__puts') return json(res, { settingsPuts, testPosts });

        if (url === '/api/settings' && m === 'PUT') {
            return readBody(req, (b) => { settingsPuts.push(b); json(res, { ok: true }); });
        }
        if (url === '/api/mcp/test' && m === 'POST') {
            return readBody(req, (b) => {
                testPosts.push(b);
                json(res, { ok: true, tools: ['wiki_search'], ms: 12 });
            });
        }
        if (url === '/api/settings') return json(res, SETTINGS);
        if (url === '/api/mcp/shared-servers') return json(res, { ok: true, servers: [], can_publish: true });
        if (url === '/api/mcp/custom-servers') return json(res, { servers: [], root_path: '/tmp' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [
            { name: 'fs', label: 'Fichiers', icon: 'ph-folder', color: 'blue', visible: true },
        ] });

        if (url === '/api/saved/chats' && m === 'GET') return json(res, { items: [] });
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'admin', is_admin: 1, role: 'admin' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
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
}).listen(PORT, '127.0.0.1', () => console.log(`mcpcreds-server sur http://127.0.0.1:${PORT}`));
