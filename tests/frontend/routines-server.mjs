// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER la page « Routines » (journal des runs :
// rendu Markdown de la réponse, fichiers produits cliquables) sans backend ni
// scheduler. Même recette que code-server.mjs : @include + /static, mocks
// /api/routines*. GET /__opened liste les fichiers ouverts dans l'éditeur.
// Lancement : PERF_PORT=8907 node tests/frontend/routines-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8907);
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

const NOW = Date.now() / 1000;

// Réponse VOLONTAIREMENT en Markdown : c'est le cœur de la vérif (en texte brut
// le journal affichait les dièses, les pipes de tableau et les backticks).
const SUMMARY_MD = [
    '## Rapport de veille',
    '',
    'Trois dépôts ont bougé aujourd’hui :',
    '',
    '- `webapp` — 4 commits',
    '- `api` — 1 commit',
    '',
    '| Dépôt | Commits |',
    '| --- | --- |',
    '| webapp | 4 |',
    '',
    '```python',
    'print("fin")',
    '```',
].join('\n');

const ROUTINES = [
    { id: 1, name: 'Veille quotidienne', cron_expr: '0 9 * * *', enabled: true,
      model: 'qwen3-32b', system_prompt: '', task_prompt: 'Résume les dépôts',
      mcp_snapshot: [], skills: [], thinking_mode: false,
      // Sous-agents : opt-in PAR ROUTINE (onglet Agents), OFF sur la fixture.
      agents_enabled: false,
      // Historique par routine (2026-09-08) : défauts = tout garder, tout notifier.
      runs_keep: 0, notify_on: 'all', notify_keep: 0,
      running_count: 0,
      last_run: { status: 'ok', started_at: NOW - 3600, ended_at: NOW - 3590, duration_ms: 9500 } },
];

// Skills tels que /api/skills les renvoie (vue fusionnée) : un skill perso
// individuel, un paquet global avec 2 sous-skills, un learned (exclu du
// picker). Forme exacte de SkillSpec.to_summary_dict (id/parent_id/depth).
const _sk = (id, over) => ({
    name: id.split('/').pop(), description: 'desc ' + id, tags: [], source: 'global',
    domain: '', path: '/skills/' + id + '/SKILL.md', body_preview: '', body_length: 10,
    is_folder: true, skill_dir: '/skills/' + id, files: [], license: '', compatibility: '',
    metadata: {}, allowed_tools: '', id, parent_id: null, depth: 0, ...over });
const SKILLS = [
    _sk('analyse-fichier', { source: 'user' }),
    _sk('ansible', { domain: 'ansible' }),
    _sk('ansible/ansible-write-playbook', { domain: 'ansible', parent_id: 'ansible', depth: 1 }),
    _sk('ansible/ansible-debug-runs',     { domain: 'ansible', parent_id: 'ansible', depth: 1 }),
    _sk('brouillon-learned', { source: 'learned' }),
];

// Centre de notifications (« récap » des routines) : une notif pointe une
// routine SUPPRIMÉE (ref 999) — le deep-link doit le dire, pas ouvrir la 1re.
const NOTIFICATIONS = [
    { id: 501, kind: 'routine_ok', title: 'Routine « Veille quotidienne » terminée', body: 'ok',
      ref_type: 'routine', ref_id: 1, read_at: null, created_at: NOW - 60 },
    { id: 502, kind: 'routine_error', title: 'Routine « Ancienne » en échec', body: 'boom',
      ref_type: 'routine', ref_id: 999, read_at: null, created_at: NOW - 120 },
];

// Dernier corps reçu en PUT /api/routines/{id} (vérif du payload d'historique).
let lastPut = null;
function readBody(req) {
    return new Promise((resolve) => {
        let raw = '';
        req.on('data', (c) => { raw += c; });
        req.on('end', () => { try { resolve(JSON.parse(raw || 'null')); } catch (e) { resolve(null); } });
    });
}

const RUNS = [
    // run réussi AVEC fichiers produits : le cas que le journal ne savait pas montrer
    { id: 11, routine_id: 1, status: 'ok', trigger: 'schedule',
      started_at: NOW - 3600, ended_at: NOW - 3590, duration_ms: 9500,
      input_tokens: 1200, output_tokens: 340, summary: SUMMARY_MD, error: null,
      tool_limit_reached: 0, files: ['/work/rapports/veille.md', '/work/data/commits.csv'] },
    // run en échec : reste en BRUT (une stack trace ne passe pas par marked)
    { id: 12, routine_id: 1, status: 'error', trigger: 'manual',
      started_at: NOW - 7200, ended_at: NOW - 7190, duration_ms: 1000,
      input_tokens: 0, output_tokens: 0, summary: null,
      error: 'Traceback: ## pas un titre <b>pas du html</b>',
      tool_limit_reached: 0, files: [] },
    // run sans fichier : aucune section « Fichiers produits »
    { id: 13, routine_id: 1, status: 'ok', trigger: 'schedule',
      started_at: NOW - 10800, ended_at: NOW - 10790, duration_ms: 800,
      input_tokens: 10, output_tokens: 5, summary: 'Rien a changé.', error: null,
      tool_limit_reached: 0, files: [] },
];

const opened = [];      // fichiers ouverts dans l'éditeur (via /api/sandbox/file)

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/__opened') return json(res, { opened });
        if (url === '/__last_put') return json(res, { body: lastPut });

        // ── /api/routines* ──────────────────────────────────────────────
        if (url === '/api/routines') return json(res, { items: ROUTINES });
        if (/^\/api\/routines\/\d+\/runs$/.test(url)) return json(res, { items: RUNS });
        if (/^\/api\/routines\/\d+$/.test(url) && req.method === 'PUT') {
            lastPut = await readBody(req);
            // Le serveur refléterait les nouvelles valeurs : on les applique
            // à la fixture pour que la vue lecture (récap) les montre.
            if (lastPut && typeof lastPut === 'object') Object.assign(ROUTINES[0], lastPut);
            return json(res, { ok: true });
        }
        if (/^\/api\/routines\/\d+$/.test(url)) return json(res, ROUTINES[0]);

        // ── Centre de notifications ─────────────────────────────────────
        if (url === '/api/notifications') return json(res, { items: NOTIFICATIONS, unread: 2 });
        if (url === '/api/notifications/unread-count') return json(res, { count: 2 });
        if (url.startsWith('/api/notifications/')) return json(res, { ok: true, unread: 0 });

        // ── Éditeur : on note quel fichier la page a demandé à ouvrir ───
        // openFile() télécharge via /api/sandbox/download?path=…
        if (url === '/api/sandbox/download') {
            const p = new URL(req.url, 'http://x').searchParams.get('path') || '';
            opened.push(p);
            res.setHeader('content-type', 'text/plain');
            return res.end('# ' + p);
        }
        if (url === '/api/sandbox/files') return json(res, { files: [], path: '/' });

        // ── Boot (logged-in) ────────────────────────────────────────────
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user', features: {} });
        if (url === '/api/llm/models') return json(res, { models: ['qwen3-32b'], models_with_status: [{ id: 'qwen3-32b', status: 'loaded' }], server_reachable: true, status: 'ok' });
        // Catégories locales + serveurs externes : nécessaires pour vérifier
        // les TOGGLES MCP du formulaire de configuration.
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [
            { name: 'fs',    label: 'Fichiers',   icon: 'ph-folder',  color: 'blue',   visible: true },
            { name: 'shell', label: 'Terminal',   icon: 'ph-terminal', color: 'slate', visible: true },
            { name: 'git',   label: 'Git',        icon: 'ph-git-branch', color: 'orange', visible: true },
            { name: 'chart', label: 'Graphiques', icon: 'ph-chart-bar', color: 'emerald', visible: true },
        ] });
        if (url === '/api/skills') return json(res, { skills: SKILLS, count: SKILLS.length });
        if (url === '/api/settings') return json(res, {
            mcp_servers: [
                { id: 'srv1', name: 'Qdrant distant', type: 'sse', visible: true },
                { id: 'srv2', name: 'Interne caché',  type: 'stdio', visible: false },
            ],
            // Agents custom du compte : l'onglet Agents doit les annoncer à
            // côté du casting intégré (la routine les voit au run).
            custom_agents: [{ name: 'redacteur', description: 'rédige',
                              prompt: 'P.', tool_categories: ['fs'] }],
        });
        if (url === '/api/saved/chats') return json(res, { items: [] });
        if (url.startsWith('/api/')) return json(res, {});

        // ── Statique ────────────────────────────────────────────────────
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
}).listen(PORT, '127.0.0.1', () => console.log(`routines-server sur http://127.0.0.1:${PORT}`));
