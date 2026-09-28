// SPDX-License-Identifier: MIT
// Harnais route-mock : LE POURCENTAGE À LA PLACE DE LA ROUE (sélecteur de
// modèles). Deux moteurs à rejouer, sélectionnés par l'environnement :
//   PERF_PORT=8933 node tests/frontend/model-load-percent-server.mjs
//   PERF_PORT=8934 LOAD_LEGACY=1 node tests/frontend/model-load-percent-server.mjs
//
// Une roue tourne aussi bien pour trois secondes que pour trois minutes. Le
// moteur (llama.cpp ≥ b10545) connaît le vrai pourcentage ; un moteur plus
// ancien répond ``{"supported": false}`` et la roue doit rester — c'est la
// promesse de rétrocompatibilité, elle se teste comme le reste.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8933);
const LEGACY = process.env.LOAD_LEGACY === '1';
const M = 'Qwen3.8-27B-long';
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

let charge = false;          // devient vrai ~5 s après la demande de chargement

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

// Progression rejouée : cadence resserrée par rapport au réel (200 ms), la
// forme est la même — croissante, puis « done ».
function progressSse(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    if (LEGACY) {
        res.write('data: {"supported": false}\n\n');
        res.end();
        return;
    }
    const pas = [8, 26, 47, 68, 91, 100];
    let i = 0;
    const tick = () => {
        if (i >= pas.length) {
            try { res.write('data: {"done": true, "loaded": true}\n\n'); res.end(); } catch (_) {}
            return;
        }
        const pct = pas[i++];
        try {
            res.write('data: ' + JSON.stringify({ pct, stage: 'text_model', stages: ['text_model'] }) + '\n\n');
        } catch (_) { return; }
        setTimeout(tick, 600);
    };
    setTimeout(tick, 300);
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/api/llm/models/load-progress') return progressSse(res);
        if (url === '/api/llm/models/load' && req.method === 'POST') {
            req.on('data', () => {});
            req.on('end', () => {
                // La vraie route attend les slots libres : elle ne rend pas la
                // main tout de suite. C'est précisément la fenêtre pendant
                // laquelle il faut voir quelque chose.
                setTimeout(() => { charge = true; }, 4200);
                setTimeout(() => json(res, { ok: true }), 1200);
            });
            return;
        }
        if (url === '/api/llm/models/unload' && req.method === 'POST') {
            req.on('data', () => {});
            req.on('end', () => {
                setTimeout(() => { charge = false; }, 1500);
                json(res, { ok: true });
            });
            return;
        }
        if (url === '/api/llm/models') {
            return json(res, {
                models: [M],
                models_with_status: [{ id: M, status: charge ? 'loaded' : 'unloaded' }],
                server_reachable: true, status: 'ok',
            });
        }
        if (url === '/api/settings') return json(res, { hide_thinking: false });
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/saved/chats') return json(res, { items: [] });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url === '/api/llm/connectors') return json(res, { items: [] });
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
}).listen(PORT, () => console.log(`model-load-percent-server on ${PORT}${LEGACY ? ' (moteur ANCIEN)' : ''}`));
