// SPDX-License-Identifier: MIT
// Harnais route-mock « raisonnement coupé → reprise » (2026-08-17) :
// vérifie côté front le correctif du bug « le thinking déborde dans le chat »
// (final.truncated_in_think → PAS de promotion en réponse markdown) et la
// reprise manuelle utile (Continue → POST is_continue + resume_thinking).
// Lancement :
//   PERF_PORT=8921 node tests/frontend/thinkresume-server.mjs
//
// - POST /api/chat-saved-stream3 : scripté PAR TOUR (repéré sur le body) :
//     « déclenche coupure »  → thinking_token… puis final think-only
//                              truncated + truncated_in_think (assistant '')
//     is_continue            → final « Conclusion depuis le raisonnement. »
//     « déclenche promotion »→ final think-only SANS truncated_in_think
//                              (régression : le filet de promotion legacy
//                              doit continuer de promouvoir ce cas-là)
// - GET /__test/bodies : tous les bodies capturés (assertions).
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

const REASONING = 'Je dois analyser le problème étape par étape, comparer les options';

const BODIES = [];

function streamEvents(res, events) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    let i = 0;
    const tick = () => {
        if (i >= events.length) { try { res.end(); } catch (_) {} return; }
        try { res.write(JSON.stringify(events[i++]) + '\n'); } catch (_) { return; }
        setTimeout(tick, 30);
    };
    tick();
}

function lastUserText(body) {
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m && m.role === 'user' && typeof m.content === 'string') return m.content;
    }
    return body.message || '';
}

function eventsFor(body) {
    if (body.is_continue) {
        return [
            { type: 'content_token', text: 'Conclusion depuis le raisonnement.' },
            { type: 'final', assistant: 'Conclusion depuis le raisonnement.',
              chat_id: 'c1', metrics: { truncated: false }, thinking: '',
              truncated: false, truncated_in_think: false, persisted: true },
        ];
    }
    if (/promotion/.test(lastUserText(body))) {
        // Régression « réponse piégée » : think-only SANS truncated_in_think →
        // le filet DOIT encore promouvoir (comportement historique conservé).
        return [
            { type: 'thinking_token', text: 'La vraie réponse est 42.' },
            { type: 'final', assistant: '', chat_id: 'c1',
              metrics: {}, thinking: 'La vraie réponse est 42.',
              truncated: false, persisted: true },
        ];
    }
    // Tour coupé par le plafond EN PLEIN raisonnement.
    return [
        { type: 'thinking_token', text: REASONING },
        { type: 'final', assistant: '', chat_id: 'c1',
          metrics: { truncated: true, truncated_in_think: true },
          thinking: REASONING,
          truncated: true, truncated_in_think: true, persisted: true },
    ];
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                let body;
                try { body = JSON.parse(raw); } catch (_) { body = { parse_error: true }; }
                BODIES.push(body);
                streamEvents(res, eventsFor(body));
            });
            return;
        }
        if (url === '/__test/bodies') return json(res, { bodies: BODIES });

        if (url === '/api/settings') return json(res, { hide_thinking: false });
        if (url === '/api/llm/models') return json(res, {
            models: ['qwen38-27b'],
            models_with_status: [{ id: 'qwen38-27b', status: 'loaded' }],
            server_reachable: true, status: 'ok',
        });
        if (/^\/api\/llm\/models\/.+\/effective-params$/.test(url)) {
            return json(res, {
                model_id: 'qwen38-27b', task: 'chat', supports_thinking: true,
                supports_reasoning_effort: false, reasoning_effort_values: [],
                sources: { props: {}, task_profile: {}, user_override: {} },
                effective: {}, param_sources: {},
                agent_defaults: { max_tool_iterations: 50, thinking_budget_tokens: 8192 },
            });
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
}).listen(PORT, '127.0.0.1', () => console.log(`thinkresume-server sur http://127.0.0.1:${PORT}`));
