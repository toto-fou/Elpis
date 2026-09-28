// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le rendu des ERREURS et AVERTISSEMENTS,
// sans backend.
// Lancement : PERF_PORT=8917 node tests/frontend/errors-server.mjs
//
// Ce que le flux rejoue (2026-07-25, passe « gestion d'erreurs ») :
//   - un event `warning` (budget de contexte non réductible) — type qui
//     n'était traité par AUCUNE branche de handleStreamEvent : la chaîne de
//     if/else s'arrêtait à 'error', donc le backend croyait prévenir
//     l'utilisateur alors que le message tombait dans le vide ;
//   - un event `error` porteur du triplet {text actionnable, detail
//     technique, kind} — avant, `text` était un `str(e)` Python brut.
//
// Endpoints en panne, pour les échecs autrefois SILENCIEUX :
//   - GET  /api/saved/chats/boom  → 500 (loadChat sans branche else)
//   - POST /api/saved/chats/new   → 500 (conversation jamais persistée)
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

// Tour qui produit du texte, prévient que le contexte ne tient plus, puis
// échoue — exactement la séquence d'un dépassement de fenêtre de contexte.
const STREAM = [
    { type: 'content_token', text: 'Je commence la réponse' },
    { type: 'warning', text: 'Ce tour approche la limite de contexte du modèle '
        + 'et n’a pas pu être réduit davantage (~7900 tokens estimés pour ~7000 '
        + 'disponibles). Si la génération échoue, compactez la conversation ou '
        + 'retirez les pièces jointes volumineuses.' },
    { type: 'error',
      text: 'La conversation dépasse la fenêtre de contexte du modèle. '
          + 'Compactez la conversation, ouvrez un nouveau chat, ou retirez les '
          + 'pièces jointes volumineuses du dernier message. La réponse '
          + 'partielle est conservée.',
      detail: 'HTTPStatusError: Client error \'400 Bad Request\' — réponse '
            + 'serveur : {"error":{"message":"the request exceeds the available '
            + 'context size"}} — 1 tentative(s)',
      kind: 'context_overflow' },
];

let newCalls = 0;

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
        // Création de conversation : EN PANNE au 1er envoi (la réponse ne sera
        // pas persistée), puis OK — pour que le 2e tour ait un chat courant et
        // que l'avertissement de contexte puisse proposer « Compacter ».
        if (url === '/api/saved/chats/new' && req.method === 'POST') {
            newCalls += 1;
            if (newCalls === 1) return json(res, { detail: 'db locked' }, 500);
            return json(res, { id: 'c-ok', title: 'Nouveau chat' });
        }
        if (url === '/api/saved/chats') {
            return json(res, { items: [{ id: 'boom', title: 'Chat qui casse', updated_at: 0 }] });
        }
        // Ouverture de conversation EN PANNE → autrefois : clic sans effet.
        if (url === '/api/saved/chats/boom') return json(res, { detail: 'boom' }, 500);
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
}).listen(PORT, () => console.log('errors-server on ' + PORT));
