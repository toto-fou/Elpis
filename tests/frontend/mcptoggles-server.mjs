// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER la logique PER-CHAT des toggles MCP du
// panneau Outils — bug 2026-08-02 : les serveurs EXTERNES suivaient un état
// GLOBAL (settings.active_mcp_ids) au lieu du per-chat des catégories locales :
// jamais mémorisés par chat, et « collants » sur un nouveau chat.
// Mocke : 2 chats (c1 avec tools ["fs","ext:srv1"], c2 tout décoché), settings
// avec un active_mcp_ids LEGACY (doit être ignoré), capture des PUT /tools
// (GET /__puts). Lancement : PERF_PORT=8922 node tests/frontend/mcptoggles-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8922);
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

const CHATS = {
    c1: { id: 'c1', title: 'Chat outillé', tools: ['fs', 'ext:srv1'],
          messages: [{ role: 'user', content: 'salut' }, { role: 'assistant', content: 'bonjour' }] },
    c2: { id: 'c2', title: 'Chat nu', tools: [],
          messages: [{ role: 'user', content: 'hey' }, { role: 'assistant', content: 'yo' }] },
    // (2026-09-12) Catégorie cochée AVEC un outil décoché : la liste porte les
    // EXCLUSIONS (``-edit_file``), jamais les inclusions.
    c3: { id: 'c3', title: 'Chat filtré', tools: ['fs', '-edit_file'],
          messages: [{ role: 'user', content: 'ho' }, { role: 'assistant', content: 'hi' }] },
};

const puts = [];        // bodies des PUT /api/saved/chats/:id/tools
const settingsPuts = [];

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const m = req.method;
    try {
        if (url === '/__puts') return json(res, { puts, settingsPuts });

        const mTools = url.match(/^\/api\/saved\/chats\/(c\d)\/tools$/);
        if (mTools && m === 'PUT') {
            let body = '';
            req.on('data', (c) => body += c);
            req.on('end', () => {
                try { puts.push({ chatId: mTools[1], ...(JSON.parse(body) || {}) }); } catch (_) {}
                json(res, { ok: true });
            });
            return;
        }
        if (url === '/api/settings' && m === 'PUT') {
            let body = '';
            req.on('data', (c) => body += c);
            req.on('end', () => { settingsPuts.push(1); json(res, { ok: true }); });
            return;
        }

        if (url === '/api/saved/chats' && m === 'GET')
            return json(res, { items: [{ id: 'c1', title: 'Chat outillé', updated_at: 3 },
                                       { id: 'c2', title: 'Chat nu', updated_at: 2 },
                                       { id: 'c3', title: 'Chat filtré', updated_at: 1 }] });
        if (url === '/api/saved/chats/c1') return json(res, CHATS.c1);
        if (url === '/api/saved/chats/c2') return json(res, CHATS.c2);
        if (url === '/api/saved/chats/c3') return json(res, CHATS.c3);

        // Chaque catégorie porte désormais SES outils (nom + titre lisible) :
        // c'est ce que le panneau coche un par un.
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [
            { name: 'fs',    label: 'Fichiers', icon: 'ph-folder',   color: 'blue',  visible: true,
              tools: [{ name: 'read_file', title: 'Lire un fichier', read_only: true,
                        description: 'Lecteur de fichiers, unitaire ou par lot.' },
                      { name: 'edit_file', title: 'Modifier un fichier',
                        description: 'Remplace un passage exact dans un fichier.' }] },
            { name: 'shell', label: 'Terminal', icon: 'ph-terminal', color: 'slate', visible: true,
              tools: [{ name: 'execute_shell', title: 'Exécuter' }] },
        ] });
        // active_mcp_ids LEGACY dans les settings : ne doit PLUS être hydraté.
        if (url === '/api/settings') return json(res, {
            enable_mcp: true,
            mcp_servers: [
                { id: 'srv1', name: 'Qdrant distant', type: 'sse', url: 'http://x', visible: true },
                { id: 'srv2', name: 'Caché',          type: 'sse', url: 'http://y', visible: false },
            ],
            active_mcp_ids: ['srv1'],
        });

        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
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
}).listen(PORT, '127.0.0.1', () => console.log(`mcptoggles-server sur http://127.0.0.1:${PORT}`));
