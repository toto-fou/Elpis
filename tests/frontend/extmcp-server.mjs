// SPDX-License-Identifier: MIT
// tests/frontend/extmcp-server.mjs — mock d'API pour « serveur MCP externe
// coché → part-il dans ``active_mcp_servers`` ? » (diagnostic 2026-09-04).
//
// Le backend, alimenté de la même liste de serveurs, ramène bien les outils
// (vérifié en direct : 53 outils docx). Ce mock capture donc le corps EXACT
// que le navigateur envoie à ``/api/chat-saved-stream3`` pour départager
// « le front n'envoie pas le serveur » de « le backend le laisse tomber ».
//
//   PERF_PORT=8931 node tests/frontend/extmcp-server.mjs &
//   PERF_PORT=8931 node tests/frontend/extmcp-verify.mjs
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
function readBody(req) {
    return new Promise((r) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => r(Buffer.concat(chunks)));
    });
}

// ── État & introspection ────────────────────────────────────────────────
const BODIES = [];     // extrait de chaque POST /api/chat-saved-stream3
const TOOLPUTS = [];   // {chatId, tools} de chaque PUT /api/saved/chats/:id/tools

const DOCX = { id: 'server_docx', name: 'docx', type: 'sse', url: 'http://localhost:8766/sse',
               command: '', visible: true, auth_mode: '', auth_user: '', has_auth: false,
               headers: [], env: [], extra_scheme: 'plain', key_scheme: 'plain' };
const CATS = [
    { name: 'fs',    label: 'Fichiers', icon: 'ph-folder',   color: 'amber', visible: true },
    { name: 'shell', label: 'Shell',    icon: 'ph-terminal', color: 'slate', visible: true },
];
const CHATS = {
    A: { id: 'A', title: 'Chat A', tools: ['ext:server_docx'], todos: [],
         messages: [{ role: 'user', content: 'salut' }, { role: 'assistant', content: 'bonjour !' }] },
    B: { id: 'B', title: 'Chat B', tools: [], todos: [],
         messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi.' }] },
    N: { id: 'N', title: 'Nouveau', tools: [], todos: [], messages: [] },
};

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const m = req.method;
    try {
        if (url === '/__bodies') return json(res, { items: BODIES });
        if (url === '/__toolputs') return json(res, { items: TOOLPUTS });
        if (url === '/__reset') { BODIES.length = 0; TOOLPUTS.length = 0; return json(res, { ok: true }); }

        // ── Chats sauvegardés ───────────────────────────────────────────
        if (url === '/api/saved/chats' && m === 'GET')
            return json(res, { items: [{ id: 'A', title: 'Chat A' }, { id: 'B', title: 'Chat B' }] });
        if (url === '/api/saved/chats/new' && m === 'POST') { await readBody(req); return json(res, { id: 'N' }); }
        {
            const mm = url.match(/^\/api\/saved\/chats\/([ABN])$/);
            if (mm && m === 'GET') return json(res, CHATS[mm[1]]);
        }
        {
            const mm = url.match(/^\/api\/saved\/chats\/([ABN])\/tools$/);
            if (mm && m === 'PUT') {
                const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
                TOOLPUTS.push({ chatId: mm[1], tools: body.tools });
                return json(res, { ok: true });
            }
        }
        if (url.match(/^\/api\/chat\/[ABN]\/compression-state$/))
            return json(res, { round: 0, max: 3, can_compress: true, reason: '', turns: 2, tokens_estimate: 1200 });

        // ── Stream de génération : on capture le corps ─────────────────
        if (url === '/api/chat-saved-stream3' && m === 'POST') {
            const raw = (await readBody(req)).toString('utf8');
            let body = {};
            try { body = JSON.parse(raw || '{}'); } catch (_) {}
            const lu = [...(body.messages || [])].reverse().find((x) => x && x.role === 'user');
            BODIES.push({
                chat_id: body.chat_id,
                last_user: String((lu && lu.content) || '').slice(0, 80),
                active_mcp_servers: body.active_mcp_servers,
                keys: Object.keys(body).sort(),
            });
            res.statusCode = 200;
            res.setHeader('content-type', 'application/x-ndjson');
            const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch (_) {} };
            const srvs = (body.active_mcp_servers || []).map((s) => s && s.name).filter(Boolean);
            send({ type: 'mode', text: srvs.length ? 'MCP: ' + srvs.join(', ') : 'Génération en cours…' });
            let i = 0;
            const tick = () => {
                if (i < 4) { send({ type: 'content_token', text: 'mot' + (i++) + ' ' }); setTimeout(tick, 80); return; }
                send({ type: 'final', assistant: 'mot0 mot1 mot2 mot3', metrics: { model: 'm1' } });
                res.end();
            };
            setTimeout(tick, 80);
            return;
        }

        // ── SSE système ─────────────────────────────────────────────────
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.setHeader('cache-control', 'no-cache');
            res.write(': ping\n\n');
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => clearInterval(t));
            return;
        }

        // ── Boot (logged-in, MCP activé, UN serveur perso visible) ─────
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'admin', is_admin: 1, role: 'admin' });
        if (url === '/api/settings' && m === 'PUT') { await readBody(req); return json(res, { ok: true }); }
        if (url === '/api/settings') return json(res, {
            enable_mcp: true, enable_editor: false, enable_rag: false,
            assistant_name: 'Elpis', assistant_icon: 'ph-robot',
            mcp_servers: [DOCX], active_mcp_ids: [], shared_mcp_visible: [],
            sandbox_path_display: '/home/admin/sandbox → /work',
        });
        if (url === '/api/mcp/shared-servers') return json(res, { ok: true, servers: [], can_publish: true });
        if (url === '/api/mcp/custom-servers') return json(res, { servers: [], root_path: '/tmp' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: CATS });
        if (url === '/api/cli/opencode/families') return json(res, { families: [] });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok', props: { n_ctx: 8192 } });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url === '/api/inbox/count') return json(res, { count: 0 });
        if (url.startsWith('/api/')) return json(res, {});

        // ── Statique ────────────────────────────────────────────────────
        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const file = path.join(ROOT, rel === '' ? 'index.html' : rel);
        if (!file.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
        if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.statusCode = 404; return res.end('not found'); }
        const ext = path.extname(file);
        res.setHeader('content-type', MIME[ext] || 'application/octet-stream');
        if (ext === '.html') return res.end(applyIncludes(fs.readFileSync(file, 'utf8')));
        return res.end(fs.readFileSync(file));
    } catch (e) {
        res.statusCode = 500; res.end(String(e && e.stack || e));
    }
}).listen(PORT, '127.0.0.1', () => console.log('extmcp mock sur http://127.0.0.1:' + PORT));
