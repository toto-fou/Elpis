// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le TERMINAL EN DIRECT (live shell) :
// console unique par segment streamée dans le fil de conversation pendant
// des execute_shell (events NDJSON ``shell_output``), attribution par
// call_id d'appels PARALLÈLES, reconstruction au reload depuis tool_history,
// et gating par le réglage ``live_shell_enabled``.
// Lancement : PERF_PORT=8916 node tests/frontend/liveshell-server.mjs
//
// - POST /api/chat-saved-stream3 rejoue : 2 tool_call(execute_shell)
//   parallèles → chunks shell_output ENTRELACÉS (dont ANSI vert + \r
//   progress-bar + stderr) → shell_output done ×2 → tool_result ×2 →
//   content → final.
// - GET /api/saved/chats/c1 : chat PERSISTÉ dont la tool_history porte un
//   round à DEUX execute_shell (résultats JSON) → console unique
//   reconstruite au reload.
// - POST /__test/live-shell {"enabled": bool} : bascule le mock settings
//   (le verify recharge l'app pour tester l'état OFF).
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8916);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

let LIVE_SHELL_ENABLED = true;      // bascule via /__test/live-shell

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

// Flux NDJSON du tour live — fidèle au backend : DEUX execute_shell
// PARALLÈLES dans le même round, chunks shell_output ENTRELACÉS entre les
// tool_call et les tool_result. Le 1er chunk arrivé est celui du 2e appel
// (sh2) → prouve l'attribution par call_id (pas « dernier running »).
// La console est UNIQUE (une par segment), commandes à la suite.
const SHELL_RESULT_1 = JSON.stringify({
    ok: true, cmd: ['bash', '-c', 'pytest -q'], cwd: '/work',
    returncode: 0, truncated: false, duration_ms: 1420,
    executor: 'docker.user.alice',
    stdout: 'collecting tests\nprogress 99%\n3 passed\n', stderr: 'warning: slow\n',
});
const SHELL_RESULT_2 = JSON.stringify({
    ok: false, cmd: ['bash', '-c', 'python lint.py'], cwd: '/work',
    returncode: 2, truncated: false, duration_ms: 300,
    executor: 'docker.user.alice',
    stdout: 'lint: bad.py:3 unused import\n', stderr: '',
});
const STREAM = [
    { type: 'iteration', n: 1 },
    { type: 'tool_call', name: 'execute_shell', args: { command: 'pytest -q' }, call_id: 'sh1' },
    { type: 'tool_call', name: 'execute_shell', args: { command: 'python lint.py' }, call_id: 'sh2' },
    // sh2 émet AVANT sh1 : sans call_id, ce chunk irait au mauvais step.
    { type: 'shell_output', name: 'execute_shell', call_id: 'sh2', stream: 'stdout', chunk: 'lint: bad.py:3 unused import\n', seq: 1 },
    { type: 'shell_output', name: 'execute_shell', call_id: 'sh1', stream: 'stdout', chunk: 'collecting tests\n', seq: 1 },
    { type: 'shell_output', name: 'execute_shell', call_id: 'sh1', stream: 'stdout', chunk: 'progress 10%\r', seq: 2 },
    { type: 'shell_output', name: 'execute_shell', call_id: 'sh2', done: true, seq: 2,
      returncode: 2, duration_ms: 300, timed_out: false, live_truncated: false },
    { type: 'shell_output', name: 'execute_shell', call_id: 'sh1', stream: 'stdout', chunk: 'progress 99%\n', seq: 3 },
    { type: 'shell_output', name: 'execute_shell', call_id: 'sh1', stream: 'stdout', chunk: '\u001b[32m3 passed\u001b[0m\n', seq: 4 },
    { type: 'shell_output', name: 'execute_shell', call_id: 'sh1', stream: 'stderr', chunk: 'warning: slow\n', seq: 5 },
    { type: 'shell_output', name: 'execute_shell', call_id: 'sh1', done: true, seq: 6,
      returncode: 0, duration_ms: 1420, timed_out: false, live_truncated: false },
    { type: 'tool_result', name: 'execute_shell', call_id: 'sh1', result: SHELL_RESULT_1 },
    { type: 'tool_result', name: 'execute_shell', call_id: 'sh2', result: SHELL_RESULT_2 },
    { type: 'content_token', text: 'Tests verts, ' },
    { type: 'content_token', text: 'lint à corriger.' },
    { type: 'final', cancelled: false, persisted: true, title: 'Demo live shell' },
];

// Chat PERSISTÉ : un round avec DEUX commandes → console unique reconstruite
// depuis les résultats JSON de la tool_history.
const RELOAD_RESULT_1 = JSON.stringify({
    ok: false, cmd: ['bash', '-c', 'make build'], cwd: '/work',
    returncode: 2, truncated: false, duration_ms: 900,
    executor: 'docker.user.alice',
    stdout: 'reload out\n', stderr: '\u001b[31merreur de build\u001b[0m\n',
});
const RELOAD_RESULT_2 = JSON.stringify({
    ok: true, cmd: ['bash', '-c', 'echo done'], cwd: '/work',
    returncode: 0, truncated: false, duration_ms: 12,
    executor: 'docker.user.alice',
    stdout: 'done\n', stderr: '',
});
const TH1 = [
    { role: 'assistant', content: 'Je lance le build.', tool_calls: [
        { id: 's1', type: 'function', function: { name: 'execute_shell', arguments: '{"command":"make build"}' } },
        { id: 's2', type: 'function', function: { name: 'execute_shell', arguments: '{"command":"echo done"}' } },
    ] },
    { role: 'tool', tool_call_id: 's1', content: RELOAD_RESULT_1 },
    { role: 'tool', tool_call_id: 's2', content: RELOAD_RESULT_2 },
];
const SAVED_CHAT = {
    id: 'c1', title: 'Demo live shell persisté',
    messages: [
        { role: 'user', content: 'Compile le projet' },
        { role: 'assistant', content: 'Le build a échoué (code 2).', tool_history: TH1 },
    ],
};

function streamTurn(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    let i = 0;
    const tick = () => {
        if (i >= STREAM.length) { try { res.end(); } catch (_) {} return; }
        try { res.write(JSON.stringify(STREAM[i++]) + '\n'); } catch (_) { return; }
        // 140 ms/event : laisse à la vérif le temps d'ouvrir conteneur
        // externe + segment + pill AVANT la fin du run (fenêtre « en
        // cours » = tool_call → shell done, ~10 events).
        setTimeout(tick, 140);
    };
    tick();
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/__test/live-shell' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                try { LIVE_SHELL_ENABLED = !!JSON.parse(body || '{}').enabled; } catch (_) {}
                json(res, { ok: true, live_shell_enabled: LIVE_SHELL_ENABLED });
            });
            return;
        }
        if (url === '/api/settings') return json(res, { hide_thinking: false, live_shell_enabled: LIVE_SHELL_ENABLED });
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            req.on('data', () => {}); req.on('end', () => streamTurn(res));
            return;
        }
        if (url === '/api/saved/chats') return json(res, { items: [{ id: 'c1', title: 'Demo live shell persisté', updated_at: 0 }] });
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
}).listen(PORT, '127.0.0.1', () => console.log(`liveshell-server sur http://127.0.0.1:${PORT}`));
