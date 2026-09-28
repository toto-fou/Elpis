// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER l'onglet Agents de la modal Paramètres
// (toggle sous-agents + CRUD des agents custom), sans backend.
// Lancement : PERF_PORT=8917 node tests/frontend/agents-server.mjs
//
// - GET /api/settings sert l'état mocké (agents_enabled/custom_agents pilotables
//   via /__cfg) ; PUT /api/settings capture chaque body (inspection /__puts) et
//   MERGE dans l'état comme le backend réel (persistance mono-clé + globale).
// - GET /api/mcp/categories : fixture des catégories visibles (le picker du
//   formulaire d'agent doit toutes les rendre).
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8917);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

const DEFAULT_SETTINGS = () => ({
    agents_enabled: false,
    custom_agents: [],
    memory_enabled: false,
    hide_thinking: false,
    enable_mcp: true,
    enable_editor: false,
    enable_rag: false,
    assistant_name: 'Elpis',
    skin: '',
    // Serveurs MCP EXTERNES de l'utilisateur : le formulaire d'agent custom
    // doit les proposer (picker « Serveurs MCP », idiome rangée+switch).
    mcp_servers: [
        { id: 'srv_a', type: 'sse', name: 'Confluence', url: 'http://a', visible: true },
        { id: 'srv_b', type: 'sse', name: 'Jira', url: 'http://b', visible: true },
    ],
});
let SETTINGS = DEFAULT_SETTINGS();

const _persona = (who) => `# Role\n\nYou are a ${who}.\n\n# Objective\n\nDo the ${who} job.\n`;
const TEMPLATES = [
    { name: 'explore',   summary: 'read-only codebase exploration', prompt: _persona('code explorer'), tool_categories: ['fs', 'git'],          max_iters: 60 },
    { name: 'implement', summary: 'writes the code change',         prompt: _persona('implementer'),   tool_categories: ['fs', 'shell', 'git'], max_iters: 100 },
    { name: 'verify',    summary: 'runs tests and commands',        prompt: _persona('verifier'),      tool_categories: ['shell', 'fs', 'git'], max_iters: 60 },
    { name: 'web',       summary: 'web research specialist',        prompt: _persona('web researcher'),tool_categories: ['browser', 'fs'],      max_iters: 60 },
    { name: 'pr',        summary: 'opens the pull request',         prompt: _persona('release engineer'), tool_categories: ['git', 'fs'],      max_iters: 40 },
];
let PUTS = [];

// Fixture = catégories VISIBLES du registre live (memory/task/help cachées).
const CATEGORIES = [
    { name: 'fs',      label: 'Fichiers',          icon: 'ph-folder',          color: 'orange', hidden: false },
    { name: 'shell',   label: 'Terminal',          icon: 'ph-terminal-window', color: 'slate',  hidden: false },
    { name: 'git',     label: 'Git',               icon: 'ph-git-branch',      color: 'slate',  hidden: false },
    { name: 'chart',   label: 'Graphiques',        icon: 'ph-chart-bar',       color: 'emerald', hidden: false },
    { name: 'browser', label: 'Navigateur',        icon: 'ph-globe',           color: 'sky',    hidden: false },
    { name: 'desktop', label: "Contrôle d'écran",  icon: 'ph-desktop',         color: 'teal',   hidden: false },
    { name: 'skill',   label: 'Skills',            icon: 'ph-graduation-cap',  color: 'violet', hidden: false },
];

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

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/__cfg') {
            const q = new URLSearchParams(req.url.split('?')[1] || '');
            SETTINGS = DEFAULT_SETTINGS();
            if (q.get('agents_enabled') === '1') SETTINGS.agents_enabled = true;
            if (q.get('customs') === '1') {
                SETTINGS.custom_agents = [{ name: 'seed-agent', description: 'agent pré-existant',
                                            prompt: 'You are seed.', tool_categories: ['fs'] }];
            }
            PUTS = [];
            return json(res, { ok: true, settings: SETTINGS });
        }
        if (url === '/__puts') return json(res, { items: PUTS });
        if (url === '/api/settings' && req.method === 'GET') return json(res, SETTINGS);
        if (url === '/api/settings' && req.method === 'PUT') {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                let body = {};
                try { body = JSON.parse(raw); } catch (_) {}
                PUTS.push(body);
                SETTINGS = { ...SETTINGS, ...body };   // merge non destructif (comme le backend)
                json(res, { ok: true });
            });
            return;
        }
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: CATEGORIES });
        // Les intégrés tels que livrés : ce que le formulaire PRÉ-REMPLIT quand
        // on ouvre un modèle (persona entière, catégories, budget).
        if (url === '/api/settings/agent-templates') return json(res, { templates: TEMPLATES });
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/saved/chats') return json(res, { items: [] });
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
}).listen(PORT, '127.0.0.1', () => console.log(`agents-server sur http://127.0.0.1:${PORT}`));
