// SPDX-License-Identifier: MIT
// Harnais route-mock du CORRECTIF SKINS (sans backend) : sert index.html ET
// admin.html (@include + /static comme uxfixes-server), avec un réglage
// {skin, dark_mode} MUTABLE via POST /__config — le verify itère les
// 6 skins × 2 modes en rechargeant la page.
// L'utilisateur mocké est ADMIN (le bouton Admin du rail — vert sémantique
// restauré — fait partie des assertions).
// Lancement : PERF_PORT=8911 node tests/frontend/skins-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8911);
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
function readBody(req) {
    return new Promise((r) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => r(Buffer.concat(chunks)));
    });
}

// ── Réglage skin/mode piloté par le verify ─────────────────────────────
const STATE = { skin: '', dark_mode: false };

// ── Registre des skins (2026-09-28) : GET /api/skins sert les intégrés du
// manifeste frontend/css/skins/skins.json (TOUS activés ici, Kiki compris :
// le verify parcourt la matrice complète) + un skin IMPORTÉ simulé, dont la
// feuille est générée comme le ferait le serveur.
const BUILTINS = JSON.parse(fs.readFileSync(path.join(ROOT, 'css/skins/skins.json'), 'utf8')).skins
    .map(({ enabled_by_default, ...s }) => s);
const PLUGIN = {
    id: 'test-plugin', label: 'Plugin test', desc: 'Skin importé simulé', darkBase: false,
    sw: ['#3b0764', '#fdf4ff', '#a21caf'], builtin: false,
    css_url: '/api/skins/test-plugin/skin.css?v=1', brand: { name: 'Plugin' },
};
const PLUGIN_CSS = `body.elpis-skin-test-plugin {
    --accent: #a21caf; --accent-strong: #86198f; --accent-fg: #ffffff;
    --rail-bg: #3b0764; --rail-bg-2: #2e0550; --radius: 0.9rem;
    --radius-sm: calc(var(--radius) - 4px); --radius-md: calc(var(--radius) - 2px);
    --radius-lg: var(--radius); --radius-xl: calc(var(--radius) + 4px);
}
body.elpis-skin-test-plugin.elpis-app-dark { --accent: #e879f9; --accent-fg: #1a0020; }
`;

// Catégories MCP COLORÉES (cat.color de nouveau respecté — correctif skins).
const CATS = [
    { name: 'fs',    label: 'Fichiers', icon: 'ph-folder',   color: 'amber',   visible: true },
    { name: 'shell', label: 'Shell',    icon: 'ph-terminal', color: 'slate',   visible: true },
    { name: 'rag',   label: 'RAG',      icon: 'ph-books',    color: 'emerald', visible: true },
];

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const m = req.method;
    try {
        // ── Pilotage harnais ────────────────────────────────────────────
        if (url === '/__config' && m === 'POST') {
            const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
            if ('skin' in body) STATE.skin = body.skin || '';
            if ('dark_mode' in body) STATE.dark_mode = !!body.dark_mode;
            return json(res, { ok: true, state: STATE });
        }
        if (url === '/__config') return json(res, STATE);

        // ── Boot (utilisateur ADMIN — bouton Admin du rail visible) ─────
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'admin', is_admin: 1, role: 'admin' });
        if (url === '/api/settings') return json(res, {
            enable_mcp: true, enable_editor: false, enable_rag: false,
            assistant_name: 'Elpis', assistant_icon: 'ph-robot',
            mcp_servers: [], active_mcp_ids: [],
            skin: STATE.skin, dark_mode: STATE.dark_mode,
        });
        if (url === '/api/skins') return json(res, { skins: [...BUILTINS, PLUGIN], default: 'elpis',
            mascottes: JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/mascotte/mascottes.json'), 'utf8')).mascottes });
        if (url === '/api/skins/test-plugin/skin.css') {
            res.setHeader('content-type', 'text/css'); res.end(PLUGIN_CSS); return;
        }
        if (url === '/api/admin/skins') return json(res, { default: 'elpis', skins: [...BUILTINS, PLUGIN].map((s) => ({
            ...s, enabled: true, source: s.builtin ? 'builtin' : 'plugin', is_default: s.id === 'elpis',
            locked: s.id === '' || s.id === 'elpis', version: s.builtin ? '' : '1.0.0', author: '', license: '' })) });
        if (url === '/api/admin/skins/test-plugin') return json(res, { id: 'test-plugin', label: 'Plugin test',
            description: '', version: '1.0.0', author: '', license: '', darkBase: false, swatch: PLUGIN.sw,
            tokens: { light: { '--accent': '#a21caf' }, dark: {} }, brand: PLUGIN.brand, css: '', assets: [] });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok', props: { n_ctx: 8192 } });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: CATS });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/saved/chats') return json(res, { items: [] });

        // ── Console admin (smoke : onglets par défaut) ──────────────────
        // Forme attendue par renderDynamicDashboard : { layout: [], data: {} }.
        if (url === '/api/admin/stats-dynamic') return json(res, { layout: [], data: {} });
        if (url === '/api/admin/report/daily') return json(res, { report: null });
        if (url === '/api/admin/report/daily/list') return json(res, { reports: [] });
        if (url === '/api/admin/report/daily/auto') return json(res, { enabled: false });
        if (url === '/api/admin/users-with-groups') return json(res, { users: [] });
        if (url === '/api/admin/groups') return json(res, { groups: [] });

        // ── SSE système ─────────────────────────────────────────────────
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.setHeader('cache-control', 'no-cache');
            res.write(': ping\n\n');
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => clearInterval(t));
            return;
        }
        if (url.startsWith('/api/')) return json(res, {});

        // ── Pages + statique ────────────────────────────────────────────
        if (url === '/' || url === '/index.html') {
            res.setHeader('content-type', 'text/html');
            res.end(applyIncludes(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'))); return;
        }
        if (url === '/admin' || url === '/admin.html') {
            res.setHeader('content-type', 'text/html');
            res.end(applyIncludes(fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8'))); return;
        }
        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const p = path.join(ROOT, rel);
        if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
        res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
        res.end(fs.readFileSync(p));
    } catch (e) { res.statusCode = 404; res.end('nf'); }
}).listen(PORT, '127.0.0.1', () => console.log(`skins-server sur http://127.0.0.1:${PORT}`));
