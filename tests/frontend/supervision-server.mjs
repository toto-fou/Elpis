// SPDX-License-Identifier: MIT
// Harnais route-mock de la supervision d'un tour (L5.3-L5.5), sans backend :
// durée de chaque outil, budget « tour n/max », sous-agent « En attente »,
// compaction (motif, seuil) restaurée au rechargement, sorties élaguées,
// « Détails » d'une réponse.
// Lancement : PERF_PORT=8916 node tests/frontend/supervision-server.mjs
//
// - POST /api/chat-saved-stream3 rejoue le tour ; un élément ``{__pause}``
//   suspend le flux jusqu'à GET /__resume (captures en cours de tour).
// - GET /api/saved/chats/c1 : le même tour PERSISTÉ (jalons de compaction
//   et élagage compris) → reconstruction au rechargement.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8916);
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

const CALL = (id, name, args) => ({ type: 'tool_call', call_id: id, name, args });
const STREAM = [
    { type: 'iteration', n: 1, max: 10 },
    CALL('c1', 'read_file', { path: 'src/dates.py' }),
    { type: 'tool_result', call_id: 'c1', name: 'read_file', result: 'def parse_date(s): ...', duration_ms: 120 },
    ...[2, 3, 4, 5, 6, 7, 8].map((n) => ({ type: 'iteration', n, max: 10 })),
    CALL('t1', 'task', { subagent_type: 'explore', description: 'chercher les appels de parse_date', prompt: 'x' }),
    CALL('t2', 'task', { subagent_type: 'explore', description: 'lister les tests de dates', prompt: 'y' }),
    { type: 'task_step', child_id: 'k-a', agent: 'explore', status: 'spawned', resumed: false, depth: 0 },
    { type: 'task_step', child_id: 'k-a', agent: 'explore', step: 1, max_steps: 15, tool: 'grep', tokens: 420, status: 'running' },
    { __pause: 'live' },
    { type: 'task_step', child_id: 'k-a', agent: 'explore', status: 'final', state: 'completed', steps_total: 1, context_tokens: 900, input_tokens: 700, output_tokens: 200, duration_ms: 900, result: 'ok' },
    { type: 'tool_result', call_id: 't1', name: 'task', result: 'ok', duration_ms: 900 },
    { type: 'task_step', child_id: 'k-b', agent: 'explore', status: 'spawned', resumed: false, depth: 0 },
    { type: 'task_step', child_id: 'k-b', agent: 'explore', status: 'final', state: 'completed', steps_total: 1, context_tokens: 800, input_tokens: 600, output_tokens: 200, duration_ms: 700, result: 'ok' },
    { type: 'tool_result', call_id: 't2', name: 'task', result: 'ok', duration_ms: 700 },
    { type: 'compression_start', path: 'endpoint', turns: 6, tokens: 6400, ctx_size: 8192, threshold: 6000, reason: 'threshold' },
    { type: 'compression_done', path: 'endpoint', stats: { compressed: true, tokens_before: 6400, tokens_after: 1900, tokens_saved: 4500, messages_before: 14, messages_after: 5, ratio: 0.3, turns_compressed: 4, duration_ms: 3100, path: 'endpoint', had_previous_summary: false } },
    { type: 'iteration', n: 9, max: 10 },
    CALL('c4', 'execute_shell', { command: 'pytest tests/test_dates.py' }),
    { type: 'tool_result', call_id: 'c4', name: 'execute_shell', result: '3 passed', duration_ms: 2300 },
    { type: 'content_token', text: 'parse_date accepte maintenant les dates ISO ; ' },
    { type: 'content_token', text: 'les 3 tests passent.' },
    { type: 'final', cancelled: false, persisted: true, chat_id: 'c-live', title: 'Supervision', run_ids: ['chat-demo'], pruned: 3,
      compactions: [{ round: 8, reason: 'threshold', threshold: 6000, ctx_size: 8192, tokens_before: 6400, tokens_after: 1900, tokens_saved: 4500, messages_before: 14, messages_after: 5, turns_compressed: 4, duration_ms: 3100, path: 'endpoint', had_previous_summary: false }] },
];

const TH = [
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"src/dates.py"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'def parse_date(s): ...' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c4', type: 'function', function: { name: 'execute_shell', arguments: '{"command":"pytest tests/test_dates.py"}' } }] },
    { role: 'tool', tool_call_id: 'c4', content: '3 passed' },
];
const SAVED_CHAT = {
    id: 'c1', title: 'Supervision (rechargée)',
    messages: [
        { role: 'user', content: 'Corrige parse_date pour les dates ISO.' },
        { role: 'assistant', content: 'parse_date accepte maintenant les dates ISO ; les 3 tests passent.', tool_history: TH,
          tool_history_delta: true, run_ids: ['chat-demo'], pruned: 3,
          compactions: [{ round: 1, reason: 'threshold', threshold: 6000, ctx_size: 8192, tokens_before: 6400, tokens_after: 1900, tokens_saved: 4500, messages_before: 14, messages_after: 5, turns_compressed: 4, duration_ms: 3100, path: 'endpoint', had_previous_summary: false }] },
    ],
};
const TIMELINE = {
    run: { id: 'chat-demo', status: 'ok', started_at: 1781000000, ended_at: 1781000042, input_tokens: 18400, output_tokens: 1250,
           tool_calls: 4, tool_errors: 0, prefill_ms: 9100, decode_ms: 14200, wait_ms: 800, files_changed: 1, engine: 'llama',
           model: 'qwen3', sandbox_cpu_peak: 64, sandbox_mem_peak_mb: 310 },
    events: [
        { type: 'llm', at: 1781000000.5, model: 'qwen3', input_tokens: 4200, output_tokens: 80, cache_read_tokens: 3900, duration_ms: 2100, status: 'ok', source: 'chat' },
        { type: 'tool', at: 1781000003, tool_name: 'read_file', status: 'success', duration_ms: 120, category: 'fs', argument: 'path: src/dates.py', result: 'def parse_date(s): ...', args_bytes: 26, result_bytes: 23 },
        { type: 'child', at: 1781000006, run_id: 'subagent-a', kind: 'subagent', status: 'ok', duration_ms: 900 },
        { type: 'child', at: 1781000008, run_id: 'subagent-b', kind: 'subagent', status: 'ok', duration_ms: 700 },
        { type: 'child', at: 1781000010, run_id: 'compaction-c', kind: 'compaction', status: 'ok', duration_ms: 3100 },
        { type: 'tool', at: 1781000030, tool_name: 'execute_shell', status: 'success', duration_ms: 2300, category: 'shell', exit_code: 0, argument: 'command: pytest tests/test_dates.py', result: '3 passed' },
    ],
    children: [],
};

let resume = null;
function streamTurn(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    let i = 0;
    const tick = () => {
        if (i >= STREAM.length) { try { res.end(); } catch (_) {} return; }
        const ev = STREAM[i++];
        if (ev.__pause) { resume = tick; return; }
        try { res.write(JSON.stringify(ev) + '\n'); } catch (_) { return; }
        setTimeout(tick, 80);
    };
    tick();
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/__resume') { const r = resume; resume = null; if (r) r(); return json(res, { ok: !!r }); }
        if (url === '/api/settings') return json(res, { hide_thinking: false });
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            req.on('data', () => {}); req.on('end', () => streamTurn(res));
            return;
        }
        if (url === '/api/saved/chats/new') return json(res, { id: 'c-live' });
        if (url === '/api/runs/chat-demo/timeline') return json(res, TIMELINE);
        if (url === '/api/saved/chats') return json(res, { items: [{ id: 'c1', title: 'Supervision (rechargée)', updated_at: 0 }] });
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
}).listen(PORT, '127.0.0.1', () => console.log(`supervision-server sur http://127.0.0.1:${PORT}`));
