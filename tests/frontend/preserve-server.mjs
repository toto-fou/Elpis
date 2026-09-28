// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le toggle « Raisonnement conservé » du
// panneau sampling (2026-08-18) : visible SEULEMENT quand le serveur confirme
// la capacité (effective-params.supports_preserve_reasoning — llama.cpp
// /props.chat_template_caps, ex. Qwen3.8-27B), et l'état part dans
// sampling_override.preserve_reasoning du POST chat. Lancement :
//   PERF_PORT=8921 node tests/frontend/preserve-server.mjs
//
// - /api/llm/models : DEUX modèles locaux CHARGÉS — 'qwen38-27b' (capacité
//   présente) et 'llama3-8b' (absente) → bascule testable.
// - effective-params : payloads PLEINS (modèles chargés) + variante DÉGRADÉE
//   (?degraded=1) où la capacité est INCONNUE (null) → toggle masqué.
// - POST /api/chat-saved-stream3 : enregistre le body (assertions via
//   GET /__test/last-body) et rejoue un mini flux NDJSON.
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

// Capacités par modèle — même forme que describe_effective_params.
const MODELS = {
    'qwen38-27b': {
        supports_thinking: true,
        supports_reasoning_effort: false,
        reasoning_effort_values: [],
        supports_preserve_reasoning: true,      // caps llama.cpp confirmées
    },
    'llama3-8b': {
        supports_thinking: false,
        supports_reasoning_effort: false,
        reasoning_effort_values: [],
        supports_preserve_reasoning: false,     // template sans la variable
    },
};

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
        supports_preserve_reasoning: null,      // inconnu sans /props
        sources: { props: {}, task_profile: {}, user_override: {} },
        effective: {}, param_sources: {},
        agent_defaults: { max_tool_iterations: 50, thinking_budget_tokens: 8192 },
    };
}

let LAST_BODY = null;

const STREAM = [
    { type: 'content_token', text: 'ok.' },
    { type: 'final', cancelled: false, persisted: true, title: 'Preserve démo' },
];

function streamTurn(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    let i = 0;
    const tick = () => {
        if (i >= STREAM.length) { try { res.end(); } catch (_) {} return; }
        try { res.write(JSON.stringify(STREAM[i++]) + '\n'); } catch (_) { return; }
        setTimeout(tick, 40);
    };
    tick();
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
