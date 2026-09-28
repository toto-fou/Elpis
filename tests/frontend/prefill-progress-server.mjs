// SPDX-License-Identifier: MIT
// Harnais route-mock : PROGRESSION DU PRÉ-REMPLISSAGE (capacités llama.cpp
// b10545, 2026-08-22). Lancement :
//   PERF_PORT=8927 node tests/frontend/prefill-progress-server.mjs
//
// Ce qu'on rejoue : la phase MUETTE d'un tour. Sur la machine de l'utilisateur,
// 5 631 tokens de prompt = 26,4 s pendant lesquelles rien n'arrivait — aucun
// moyen de distinguer « ça calcule » de « c'est planté ». Le moteur sait
// désormais l'annoncer (``prompt_progress``), le client doit le montrer, puis
// s'effacer dès le PREMIER token — fût-il un token de réflexion.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8927);
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

const TOTAL = 5631;   // le prompt réellement mesuré en production
const SCRIPT = [
    [200,  { type: 'chat_id', chat_id: 'c-pf' }],
    [300,  { type: 'prompt_progress', total: TOTAL, processed: 1100, cache: 0, time_ms: 5000 }],
    [700,  { type: 'prompt_progress', total: TOTAL, processed: 3400, cache: 0, time_ms: 16000 }],
    [700,  { type: 'prompt_progress', total: TOTAL, processed: TOTAL, cache: 0, time_ms: 26400 }],
    [900,  { type: 'thinking_token', text: 'Je réfléchis…', n: 3 }],
    [400,  { type: 'content_token', text: 'Voici la réponse.' }],
    [200,  { type: 'final', content: 'Voici la réponse.' }],
];

function streamScript(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    let i = 0;
    const tick = () => {
        if (i >= SCRIPT.length) { try { res.end(); } catch (_) {} return; }
        const [delay, evt] = SCRIPT[i++];
        setTimeout(() => {
            try { res.write(JSON.stringify(evt) + '\n'); } catch (_) { return; }
            tick();
        }, delay);
    };
    tick();
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/api/settings') return json(res, { hide_thinking: false });
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            req.on('data', () => {});
            req.on('end', () => streamScript(res));
            return;
        }
        if (url === '/api/saved/chats') {
            return json(res, { items: [{ id: 'c-pf', title: 'Prompt', updated_at: 0 }] });
        }
        if (url === '/api/saved/chats/new' && req.method === 'POST') {
            return json(res, { id: 'c-pf', title: 'Prompt' });
        }
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.write(': ping\n\n');
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => clearInterval(t));
            return;
        }
        if (url.startsWith('/api/')) return json(res, {});

        if (url === '/' || url === '/index.html') {
            res.setHeader('content-type', 'text/html');
            res.end(applyIncludes(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
            return;
        }
        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const p = path.join(ROOT, rel);
        if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
        res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
        res.end(fs.readFileSync(p));
    } catch (e) { res.statusCode = 404; res.end('nf'); }
}).listen(PORT, () => console.log('prefill-progress-server on ' + PORT));
