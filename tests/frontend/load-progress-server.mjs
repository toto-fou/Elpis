// SPDX-License-Identifier: MIT
// Harnais route-mock : CHARGEMENT D'UN MODÈLE, progression RÉELLE.
//   PERF_PORT=8931 node tests/frontend/load-progress-server.mjs
//
// Ce qu'on rejoue : le widget de file pendant qu'un modèle monte en VRAM.
// Avant, il animait une barre sur une durée ESTIMÉE — elle finissait figée à
// 100 % pendant que le modèle chargeait encore. Le moteur (llama.cpp ≥ b10545)
// pousse désormais le vrai pourcentage ; un moteur plus ancien n'en pousse
// aucun, et la barre doit alors retomber sur l'animation d'avant. Les deux
// cas sont rejoués ICI, dans cet ordre.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8931);
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

const M = 'Qwen3.8-27B-long';
const base = { type: 'queue_status', kind: 'loading', model: M, position: 1, active: 1, est_ms: 15000 };
const SCRIPT = [
    [200,  { type: 'chat_id', chat_id: 'c-ld' }],
    // 1. Moteur ANCIEN : aucun pourcentage → barre animée + estimation.
    [300,  { ...base }],
    // 2. Téléchargement du GGUF (premier usage) — libellé distinct.
    [1600, { ...base, progress_pct: 35, stage: 'download', stages: ['download'] }],
    // 3. Chargement, modèle multimodal : deux étapes, chacune de 0 à 100 %.
    [900,  { ...base, progress_pct: 12, stage: 'text_model', stages: ['text_model', 'mmproj_model'] }],
    [900,  { ...base, progress_pct: 62, stage: 'mmproj_model', stages: ['text_model', 'mmproj_model'] }],
    [900,  { ...base, progress_pct: 100, stage: 'mmproj_model', stages: ['text_model', 'mmproj_model'] }],
    [700,  { type: 'queue_cleared' }],
    [500,  { type: 'content_token', text: 'Modèle prêt, voici la réponse.' }],
    [200,  { type: 'final', content: 'Modèle prêt, voici la réponse.' }],
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
            return json(res, { items: [{ id: 'c-ld', title: 'Chargement', updated_at: 0 }] });
        }
        if (url === '/api/saved/chats/new' && req.method === 'POST') {
            return json(res, { id: 'c-ld', title: 'Chargement' });
        }
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/llm/models') return json(res, { models: [M], models_with_status: [{ id: M, status: 'unloaded' }], server_reachable: true, status: 'ok' });
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
}).listen(PORT, () => console.log('load-progress-server on ' + PORT));
