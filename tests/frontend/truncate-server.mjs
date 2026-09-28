// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER l'encart « réponse interrompue → Continuer »
// (skin-aware, deux variantes : boucle d'outils / texte coupé), sans backend.
// Lancement : PERF_PORT=8906 node tests/frontend/truncate-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8906);
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

// Chat « Demo reprise » : 1er tour = boucle d'outils stoppée (variante 1), 2e
// tour = texte coupé par plafond de tokens (variante 2). Les marqueurs de
// troncature sont persistés SUR le message (comme le fait la route) →
// _history.js les réhydrate au chargement. Le 1er tour, suivi d'un autre, n'est
// PLUS reprenable : son bandeau ne doit pas s'afficher (2026-09-24 — il restait
// affiché et son bouton ne faisait rien). « Demo outils » porte la variante 1
// sur sa DERNIÈRE bulle.
const CHAT = {
    id: 'c1', title: 'Demo reprise',
    messages: [
        { role: 'user', content: 'Lance une longue tâche avec des outils.' },
        { role: 'assistant', content: 'J\'ai commencé à exécuter les outils pour avancer sur la tâche.',
          isTruncated: true, toolLoopTruncated: true,
          toolLoopStats: { iterations: 80, max_iterations: 80, tool_calls_done: 12 } },
        { role: 'user', content: 'Écris-moi un très long texte.' },
        { role: 'assistant', content: 'Voici le début de la réponse, qui a été coupée net par le plafond de tokens et',
          isTruncated: true },
    ],
};
const CHAT_OUTILS = {
    id: 'c2', title: 'Demo outils',
    messages: [
        { role: 'user', content: 'Lance une longue tâche avec des outils.' },
        { role: 'assistant', content: 'J\'ai commencé à exécuter les outils pour avancer sur la tâche.',
          isTruncated: true, toolLoopTruncated: true,
          toolLoopStats: { iterations: 80, max_iterations: 80, tool_calls_done: 12 } },
    ],
};

// Flux du tour de reprise : quelques tokens puis un ``final`` NON tronqué.
function streamReprise(req, res) {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', async () => {
        let b = {};
        try { b = JSON.parse(body); } catch (_) {}
        res.statusCode = 200; res.setHeader('content-type', 'application/x-ndjson');
        const w = (o) => res.write(JSON.stringify(o) + '\n');
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        await wait(600);
        for (const t of [' la', ' suite.']) { w({ type: 'content_token', text: t }); await wait(150); }
        const prev = (b.messages || []).filter((m) => m.role === 'assistant').pop();
        w({ type: 'final', assistant: ((prev && prev.content) || '') + ' la suite.',
            chat_id: b.chat_id, metrics: {}, persisted: true });
        res.end();
    });
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/api/saved/chats') return json(res, { items: [
            { id: 'c1', title: 'Demo reprise', updated_at: 0 },
            { id: 'c2', title: 'Demo outils', updated_at: 0 }] });
        if (url === '/api/saved/chats/c1') return json(res, CHAT);
        if (url === '/api/saved/chats/c2') return json(res, CHAT_OUTILS);
        if (url === '/api/chat-saved-stream3') return streamReprise(req, res);

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
}).listen(PORT, '127.0.0.1', () => console.log(`truncate-server sur http://127.0.0.1:${PORT}`));
