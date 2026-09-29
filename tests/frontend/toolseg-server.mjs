// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER l'affichage ENTRELACÉ texte/outils
// (UX 2026-07-20 : compteur par segment, narration dans le flux, thinking en
// tête, reconstruction au reload depuis tool_history), sans backend.
// Lancement : PERF_PORT=8915 node tests/frontend/toolseg-server.mjs
//
// - POST /api/chat-saved-stream3 rejoue un flux NDJSON canonique :
//   thinking ×2 → round A (2 tools SANS narration → segment '' en tête) →
//   narration → round B (1 tool) → content → final.
// - GET /api/saved/chats/c1 : chat PERSISTÉ avec DEUX messages assistant
//   tooled dont le 2e porte une tool_history CUMULATIVE (préfixe = celle du
//   1er) → teste la reconstruction sans duplication (_tool_segments.js).
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8915);
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

// Séquence NDJSON du tour live. Fidèle à la boucle réelle : au sein d'un
// round les tool_call partent d'abord (ordre LLM) puis les tool_result ;
// tout le contenu d'itération part en content_token, narration du round
// suivant comme réponse finale (cf. pretool-server.mjs).
const STREAM = [
    { type: 'iteration', n: 1 },
    { type: 'thinking_token', text: 'Je réfléchis au plan ' },
    { type: 'thinking_token', text: "avant d'agir." },
    // Round A — AUCUNE narration : outils avant tout texte (segment '' en tête)
    { type: 'tool_call', name: 'read_file', args: { path: 'src/app.py' } },
    { type: 'tool_call', name: 'execute_shell', args: { cmd: 'ls src' } },
    { type: 'tool_result', name: 'read_file', result: 'def main(): ...' },
    { type: 'tool_result', name: 'execute_shell', result: 'app.py\nutil.py' },
    // Narration inter-rounds → doit apparaître DANS LE FLUX, entre les groupes
    { type: 'content_token', text: 'Je vais maintenant ' },
    { type: 'content_token', text: 'corriger le bug.' },
    // Round B
    { type: 'tool_call', name: 'write_file', args: { path: 'src/app.py', content: 'fix' } },
    { type: 'tool_result', name: 'write_file', result: '{"ok": true}' },
    // Réponse finale
    { type: 'content_token', text: 'Voilà, le correctif ' },
    { type: 'content_token', text: 'est appliqué.' },
    { type: 'final', cancelled: false, persisted: true, title: 'Demo segments' },
];

// Chat PERSISTÉ : tool_history CUMULATIVE — TH2 embarque TH1 en préfixe
// (comportement réel de _capture_cumulative_tool_history). La reconstruction
// doit afficher UN round par message, sans dupliquer le tour 1 sur le msg 2.
const TH1 = [
    { role: 'assistant', content: 'Narration tour 1.', tool_calls: [
        { id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/app.py"}' } },
    ] },
    { role: 'tool', tool_call_id: 'a1', content: 'def main(): ...' },
];
const TH2 = [
    ...TH1,
    { role: 'assistant', content: 'Réponse 1 finale.' },
    { role: 'user', content: 'Fais B' },
    { role: 'assistant', content: 'Narration tour 2.', tool_calls: [
        { id: 'b1', type: 'function', function: { name: 'execute_shell', arguments: '{"cmd":"pytest"}' } },
    ] },
    { role: 'tool', tool_call_id: 'b1', content: '1 passed' },
];
// Tour 3 : format DELTA (2026-07-27) — uniquement le travail de SON run,
// marqué tool_history_delta. L'id 'a1' RÉUTILISE volontairement celui du
// tour 1 (les ids fallback call_{iter}_{idx} se répètent d'un run à l'autre) :
// le marqueur doit court-circuiter les heuristiques de frontière, sinon la
// recherche de signature couperait ce round réel.
const TH3 = [
    { role: 'assistant', content: 'Narration tour 3.', tool_calls: [
        { id: 'a1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/util.py"}' } },
    ] },
    { role: 'tool', tool_call_id: 'a1', content: 'def helper(): ...' },
];
const SAVED_CHAT = {
    id: 'c1', title: 'Demo segments persisté',
    messages: [
        { role: 'user', content: 'Fais A' },
        { role: 'assistant', content: 'Réponse 1 finale.', tool_history: TH1 },
        { role: 'user', content: 'Fais B' },
        { role: 'assistant', content: 'Réponse 2 finale.', tool_history: TH2 },
        { role: 'user', content: 'Fais C' },
        // thinking : seul le DERNIER assistant le garde au reload (_history.js)
        // → valide « thinking EN TÊTE » sur un message tooled reconstruit.
        { role: 'assistant', content: 'Réponse 3 finale.', tool_history: TH3,
          tool_history_delta: true,
          thinking: 'Réflexion persistée du tour 3.' },
    ],
};

function streamTurn(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    let i = 0;
    const tick = () => {
        if (i >= STREAM.length) { try { res.end(); } catch (_) {} return; }
        try { res.write(JSON.stringify(STREAM[i++]) + '\n'); } catch (_) { return; }
        setTimeout(tick, 60);
    };
    tick();
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/api/settings') return json(res, { hide_thinking: false });
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            req.on('data', () => {}); req.on('end', () => streamTurn(res));
            return;
        }
        if (url === '/api/saved/chats') return json(res, { items: [{ id: 'c1', title: 'Demo segments persisté', updated_at: 0 }] });
        if (url === '/api/saved/chats/c1') return json(res, SAVED_CHAT);
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
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
}).listen(PORT, '127.0.0.1', () => console.log(`toolseg-server sur http://127.0.0.1:${PORT}`));
