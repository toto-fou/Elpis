// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER la puce « réflexion » de la ligne
// métriques d'un message assistant (2026-08-17). Le raisonnement était compté
// avec la réponse et les appels d'outils dans « Tokens générés » : sur un
// modèle thinking, l'essentiel du coût de sortie n'avait aucun nom à l'écran.
// Lancement :
//   PERF_PORT=8921 node tests/frontend/thinkmetrics-server.mjs
//
// Trois tours rejouables, sélectionnés par le TEXTE du message envoyé :
//   « exact »  → mesure exacte (tokenizer local)   → « 640 tk »
//   « estime » → mesure estimée (cible distante)   → « ≈ 640 tk »
//   « aucune » → métriques d'AVANT la mesure       → aucune puce (surtout
//                pas « 0 tk », qui nierait un raisonnement non mesuré)
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

// Base commune : ce que calculate_metrics renvoie vraiment (mêmes clés).
const BASE = {
    model: 'qwen38-27b', duration: 12.5, read_tps: 980.4, write_tps: 41.2,
    input_tokens: 5200, last_prompt_tokens: 5200, output_tokens: 1000,
};
const METRICS = {
    exact:  { ...BASE, thinking_tokens: 640, response_tokens: 360,
              thinking_tokens_estimated: false },
    estime: { ...BASE, thinking_tokens: 640, response_tokens: 360,
              thinking_tokens_estimated: true },
    // Tour d'avant la mesure : les champs n'existent pas du tout.
    aucune: { ...BASE },
};

function variantOf(body) {
    const msgs = (body && body.messages) || [];
    const last = [...msgs].reverse().find((m) => m && m.role === 'user');
    const txt = ((last && last.content) || '').toString();
    if (txt.includes('estime')) return 'estime';
    if (txt.includes('aucune')) return 'aucune';
    return 'exact';
}

function streamTurn(res, variant) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    const steps = [
        { type: 'thinking_content', text: 'Je pèse les options…' },
        { type: 'content_token', text: 'Voici la réponse.' },
        { type: 'final', cancelled: false, persisted: true, chat_id: 'c1',
          title: 'Métriques de réflexion', assistant: 'Voici la réponse.',
          thinking: 'Je pèse les options…', metrics: METRICS[variant] },
    ];
    let i = 0;
    const tick = () => {
        if (i >= steps.length) { try { res.end(); } catch (_) {} return; }
        try { res.write(JSON.stringify(steps[i++]) + '\n'); } catch (_) { return; }
        setTimeout(tick, 40);
    };
    tick();
}

http.createServer((req, res) => {
    const [url] = req.url.split('?');
    try {
        if (url === '/api/settings') return json(res, { hide_thinking: false });
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                let body = {};
                try { body = JSON.parse(raw); } catch (_) { /* variante par défaut */ }
                streamTurn(res, variantOf(body));
            });
            return;
        }
        if (url === '/api/llm/models') return json(res, {
            models: ['qwen38-27b'],
            models_with_status: [{ id: 'qwen38-27b', status: 'loaded' }],
            server_reachable: true, status: 'ok',
        });
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
}).listen(PORT, '127.0.0.1', () => console.log(`thinkmetrics-server sur http://127.0.0.1:${PORT}`));
