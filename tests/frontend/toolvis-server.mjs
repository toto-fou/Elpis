// SPDX-License-Identifier: MIT
// Harnais route-mock : VISIBILITÉ D'UN APPEL D'OUTIL PENDANT SON EXÉCUTION
// (2026-08-18) + compteur de tokens masqué pendant la RÉFLEXION.
// Lancement :
//   TOOL_MS=4000 PROBE_KIND=real PERF_PORT=8931 node tests/frontend/toolvis-server.mjs
//
// Le stream simule un outil LENT (TOOL_MS) : les events tool_call partent
// AVANT l'exécution (comportement backend réel, chronométré : tool_call à
// t=0.1 s, tool_result à t=1.6 s pour un outil de 1,5 s). Le front doit donc
// montrer l'appel « en cours » pendant toute la fenêtre, pas seulement après.
//
// PROBE_KIND : 'plain' (outil quelconque) | 'shell' (console live) |
//              'narr' (narration avant l'appel) | 'real' (réflexion +
//              narration + appel — la séquence d'un vrai modèle).
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

// Capacités par modèle — même forme que describe_effective_params.
const MODELS = {
    'qwen38-27b': { supports_thinking: true, supports_reasoning_effort: false,
                    reasoning_effort_values: [] },
};
// Durée simulée d'exécution de l'outil (ms) — la fenêtre pendant laquelle le
// front DOIT déjà montrer l'appel.
const TOOL_MS = Number(process.env.TOOL_MS || 3000);

function fullParams(modelId) {
    const caps = MODELS[modelId] || MODELS['llama3-8b'];
    return {
        model_id: modelId, task: 'chat', ...caps,
        sources: { props: { temperature: 0.7 }, task_profile: {}, user_override: {} },
        effective: { temperature: 0.7 }, param_sources: { temperature: 'props' },
        agent_defaults: { max_tool_iterations: 50, thinking_budget_tokens: 8192 },
    };
}
function degradedParams(modelId) {
    return {
        model_id: modelId, task: 'chat', degraded: true, supports_thinking: null,
        supports_reasoning_effort: null, reasoning_effort_values: [],
        sources: { props: {}, task_profile: {}, user_override: {} },
        effective: {}, param_sources: {},
        agent_defaults: { max_tool_iterations: 50, thinking_budget_tokens: 8192 },
    };
}

let LAST_BODY = null;

// Scénario : le modèle appelle un outil LENT, puis répond.
//   t=0      iteration / mode / tool_call      ← doit être VISIBLE tout de suite
//   t=TOOL_MS tool_result / content_token / final
const KIND = process.env.PROBE_KIND || 'real';   // cf. en-tête
const THINK_MS = Number(process.env.THINK_MS || 1500);   // durée de la phase réflexion

// Phase 1 — RÉFLEXION seule (aucun content_token) : la ligne live ne doit
// afficher AUCUN compteur de tokens pendant cette fenêtre.
const THINK = (KIND === 'real')
  ? [ { type: 'iteration', n: 1 }, { type: 'mode', mode: 'mcp_native' },
      { type: 'thinking_token', text: 'Je dois lire le fichier pour repondre. ', n: 8 },
      { type: 'thinking_token', text: 'Utilisons read_file sur /work/demo.txt. ', n: 9 } ]
  : [ { type: 'iteration', n: 1 }, { type: 'mode', mode: 'mcp_native' } ];

// Phase 2 — narration puis APPEL de l'outil.
const CALL = KIND === 'shell'
  ? [ { type: 'tool_call', name: 'execute_shell', args: { command: 'ls -la /work' },
        call_id: 'call_1', meta: { live_shell: '1' } } ]
  : KIND === 'plain'
  ? [ { type: 'tool_call', name: 'read_file', args: { path: '/work/demo.txt' }, call_id: 'call_1' } ]
  : [ { type: 'content_token', text: 'Je vais lire le fichier.', n: 5 },
      { type: 'tool_call', name: 'read_file', args: { path: '/work/demo.txt' }, call_id: 'call_1' } ];

// Phase 3 — sortie live de l'outil (shell uniquement).
const DURING = KIND === 'shell'
  ? [ { type: 'shell_output', call_id: 'call_1', name: 'execute_shell', chunk: 'total 12\n' },
      { type: 'shell_output', call_id: 'call_1', name: 'execute_shell', chunk: 'drwxr-xr-x 2 root root 4096 .\n' } ]
  : [];

// Phase 4 — résultat puis réponse finale.
const AFTER = [
    KIND === 'shell'
      ? { type: 'tool_result', name: 'execute_shell', call_id: 'call_1',
          result: JSON.stringify({ ok: true, stdout: 'total 12\n', rc: 0 }) }
      : { type: 'tool_result', name: 'read_file', call_id: 'call_1',
          result: JSON.stringify({ ok: true, content: 'bonjour' }) },
    { type: 'content_token', text: 'Voici le contenu.', n: 4 },
];

// Phase 5 — clôture, DIFFÉRÉE : laisse une fenêtre où le modèle « écrit »
// (content sans final) — c'est là que le débit tok/s doit être visible, alors
// qu'il est masqué pendant la réflexion. Sans ce délai, `final` détruit la
// ligne live et le contrôle négatif ne pourrait pas s'observer.
const END = [{ type: 'final', cancelled: false, persisted: true, title: 'Probe outil' }];
const WRITE_MS = Number(process.env.WRITE_MS || 2000);

function streamTurn(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    const w = (evs) => { for (const e of evs) { try { res.write(JSON.stringify(e) + '\n'); } catch (_) {} } };
    w(THINK);
    setTimeout(() => w(CALL), THINK_MS);
    setTimeout(() => w(DURING), THINK_MS + Math.floor(TOOL_MS / 3));
    setTimeout(() => w(AFTER), THINK_MS + TOOL_MS);
    setTimeout(() => { w(END); try { res.end(); } catch (_) {} },
               THINK_MS + TOOL_MS + WRITE_MS);
}

http.createServer((req, res) => {
    const [url, qs] = req.url.split('?');
    const q = new URLSearchParams(qs || '');
    try {
        if (url === '/api/settings') return json(res, { hide_thinking: false, enable_model_selector: true });
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                try { LAST_BODY = JSON.parse(raw); } catch (_) { LAST_BODY = { parse_error: true }; }
                streamTurn(res);
            });
            return;
        }
        if (url === '/__test/last-body') return json(res, LAST_BODY || {});

        if (url === '/api/llm/models') return json(res, {
            models: Object.keys(MODELS),
            models_with_status: Object.keys(MODELS).map((id) => ({ id, status: 'loaded' })),
            server_reachable: true, status: 'ok',
        });
        const mEff = url.match(/^\/api\/llm\/models\/(.+)\/effective-params$/);
        if (mEff) {
            const modelId = decodeURIComponent(mEff[1]);
            if (q.get('degraded') === '1') return json(res, degradedParams(modelId));
            return json(res, fullParams(modelId));
        }
        if (url === '/api/llm/connectors') return json(res, { connectors: [], shared: [] });

        if (url === '/api/saved/chats') return json(res, { items: [] });
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
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
}).listen(PORT, '127.0.0.1', () => console.log(`effort-server sur http://127.0.0.1:${PORT}`));
