// SPDX-License-Identifier: MIT
// Harnais route-mock du BALAYAGE MODE SOMBRE (sans backend).
//
// Différence avec skins-server.mjs : celui-ci sert une conversation RICHE —
// blocs de code, code inline, tableau, citation, listes, titres, liens, carte
// d'outil, marqueur de compaction, message en erreur, bandeau de limite —
// pour que le balayage DOM voie les composants qui portent réellement des
// couleurs. skins-server sert une liste de chats VIDE : c'est exactement pour
// ça que la couture des blocs de code n'a jamais été détectée.
//
// Réglage {skin, dark_mode} mutable via POST /__config, comme skins-server.
//   PERF_PORT=8912 node tests/frontend/darkmode-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8912);
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

const STATE = { skin: '', dark_mode: false };

const CATS = [
    { name: 'fs',    label: 'Fichiers', icon: 'ph-folder',   color: 'amber',   visible: true },
    { name: 'shell', label: 'Shell',    icon: 'ph-terminal', color: 'slate',   visible: true },
    { name: 'rag',   label: 'RAG',      icon: 'ph-books',    color: 'emerald', visible: true },
];

// ── Conversation témoin : un maximum de surfaces colorées en une page ───────
const MD = [
    '# Titre de niveau 1',
    '',
    'Paragraphe avec du **gras**, de l\'*italique*, un `code inline`, et un',
    '[lien vers la doc](https://example.invalid/doc).',
    '',
    '## Titre de niveau 2',
    '',
    '```js',
    'function saluer(nom) {',
    '    // commentaire de démonstration',
    '    const msg = `bonjour ${nom}`;',
    '    return msg.toUpperCase();',
    '}',
    '```',
    '',
    '```python',
    'def additionner(a, b):',
    '    """Somme de deux entiers."""',
    '    return a + b',
    '```',
    '',
    '> Citation en bloc, pour la bordure gauche et le fond.',
    '',
    '| Colonne A | Colonne B |',
    '| --------- | --------- |',
    '| valeur 1  | valeur 2  |',
    '| valeur 3  | valeur 4  |',
    '',
    '- premier point',
    '- deuxième point',
    '',
    '1. étape une',
    '2. étape deux',
    '',
    '---',
    '',
    'Fin du message.',
].join('\n');

const TOOL_HISTORY = [
    { role: 'assistant', content: 'Je lis le fichier.',
      tool_calls: [{ id: 'c1', type: 'function',
                     function: { name: 'read_file', arguments: '{"path":"/work/app.py"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'print("bonjour")\n' },
    { role: 'assistant', content: '',
      tool_calls: [{ id: 'c2', type: 'function',
                     function: { name: 'execute_shell', arguments: '{"command":"ls -la"}' } }] },
    { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ error: 'commande introuvable' }) },
];

const CHAT = {
    id: 'demo', title: 'Conversation témoin', archived: false, updated_at: 1.0,
    tools: null, plan_mode: false, todos: [], ctx_pruned_keys: [],
    ctx_usage: { used: 18400, total: 65536, pct: 28, model: 'm1', ts: 1 },
    messages: [
        { role: 'user', content: 'Montre-moi un exemple complet.' },
        { role: 'assistant', content: MD,
          metrics: { input_tokens: 900, output_tokens: 320, last_prompt_tokens: 900,
                     thinking_tokens: 40, response_tokens: 280,
                     kv_cache: { used: 18400, total: 65536, pct: 28 } } },
        { role: 'user', content: 'Et avec des outils ?' },
        { role: 'assistant', content: 'Voici le résultat des outils.',
          tool_history: TOOL_HISTORY, tool_history_delta: true,
          metrics: { input_tokens: 1200, output_tokens: 210 } },
        { role: 'notice', kind: 'compaction', ts: 1, tokens_after: 12000,
          summary: '<resume>Points clés de la conversation.</resume>', content: '' },
        { role: 'assistant', content: 'Réponse interrompue par la limite.',
          isTruncated: true, toolLoopTruncated: true,
          toolLoopStats: { iterations: 200, hard_iterations: 241, max_iterations: 200,
                           tool_calls_done: 241, stop_reason: 'steps' },
          metrics: { input_tokens: 4000, output_tokens: 100 } },
        { role: 'assistant', content: '', isError: true,
          errorMessage: 'Le moteur a renvoyé une erreur : modèle non chargé.' },
    ],
};

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const m = req.method;
    try {
        if (url === '/__config' && m === 'POST') {
            const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
            if ('skin' in body) STATE.skin = body.skin || '';
            if ('dark_mode' in body) STATE.dark_mode = !!body.dark_mode;
            return json(res, { ok: true, state: STATE });
        }
        if (url === '/__config') return json(res, STATE);

        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'admin', is_admin: 1, role: 'admin' });
        if (url === '/api/settings') return json(res, {
            enable_mcp: true, enable_editor: false, enable_rag: false,
            assistant_name: 'Elpis', assistant_icon: 'ph-robot',
            mcp_servers: [], active_mcp_ids: [],
            skin: STATE.skin, dark_mode: STATE.dark_mode,
        });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok', props: { n_ctx: 65536 } });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: CATS });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/saved/chats') {
            return json(res, { items: [{ id: CHAT.id, title: CHAT.title, archived: 0, updated_at: '2026-09-07T10:00:00Z' }] });
        }
        if (url === '/api/saved/chats/demo') return json(res, CHAT);
        if (url === '/api/chat/demo/compression-state') return json(res, { round: 0, max: 2 });
        if (url === '/api/chat/demo/generation-status') return json(res, { generation_running: false });

        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.setHeader('cache-control', 'no-cache');
            res.write(': ping\n\n');
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => clearInterval(t));
            return;
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
}).listen(PORT, '127.0.0.1', () => console.log(`darkmode-server sur http://127.0.0.1:${PORT}`));
