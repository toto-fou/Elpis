// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le panneau « Réglages de génération » en
// mode DÉGRADÉ (2026-07-27) : modèle local NON chargé et modèle de CONNECTEUR
// (cloud, ex. Kimi) — le panneau reste ÉDITABLE (les overrides par chat
// s'appliquent sans /props), bandeau explicatif, toggle Réflexion affiché
// pour les connecteurs. Lancement :
//   PERF_PORT=8917 node tests/frontend/sampling-server.mjs
//
// - /api/llm/models : 1 modèle local 'local-a' PRÉSENT mais PAS chargé
//   (status 'available' → activeModelIds vide côté front).
// - /api/llm/connectors + /k1/models : connecteur Kimi avec 1 modèle cloud.
// - effective-params : payload DÉGRADÉ (degraded=1 ou modèle non local) —
//   mêmes clés que le backend réel.
// - POST /api/chat-saved-stream3 : enregistre le body (assertions sur
//   sampling_override/connector_id via GET /__test/last-body) et rejoue un
//   mini flux NDJSON.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8917);
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

// Payload dégradé — même forme que describe_effective_params_degraded.
function degradedParams(modelId) {
    return {
        model_id: modelId, task: 'chat', degraded: true, supports_thinking: null,
        sources: { props: {}, task_profile: {}, user_override: {} },
        effective: {}, param_sources: {},
        agent_defaults: { max_tool_iterations: 50, thinking_budget_tokens: 8192 },
    };
}

let LAST_BODY = null;

const STREAM = [
    { type: 'content_token', text: 'ok.' },
    { type: 'final', cancelled: false, persisted: true, title: 'Sampling démo' },
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
        // enable_model_selector: sans lui (défaut front = false), la roue ⚙ et
        // le fetch /api/llm/models n'existent même pas.
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
            models: ['local-a'],
            models_with_status: [{ id: 'local-a', status: 'available' }],   // PAS chargé
            server_reachable: true, status: 'ok',
        });
        const mEff = url.match(/^\/api\/llm\/models\/(.+)\/effective-params$/);
        if (mEff) {
            const modelId = decodeURIComponent(mEff[1]);
            // Comme le vrai backend : dégradé si demandé OU modèle non local.
            if (q.get('degraded') === '1' || modelId !== 'local-a') {
                return json(res, degradedParams(modelId));
            }
            return json(res, { model_id: modelId, task: 'chat', supports_thinking: false,
                               sources: { props: { temperature: 0.7 }, task_profile: {}, user_override: {} },
                               effective: { temperature: 0.7 }, param_sources: { temperature: 'props' },
                               agent_defaults: { max_tool_iterations: 50, thinking_budget_tokens: 8192 } });
        }
        if (url === '/api/llm/connectors') return json(res, {
            connectors: [{ id: 'k1', label: 'Kimi (Moonshot)', provider_type: 'moonshot',
                           wire: 'openai', enabled: true }],
            shared: [],
        });
        if (url === '/api/llm/connectors/k1/models') return json(res, { models: ['kimi-k2-instruct'] });

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
}).listen(PORT, '127.0.0.1', () => console.log(`sampling-server sur http://127.0.0.1:${PORT}`));
