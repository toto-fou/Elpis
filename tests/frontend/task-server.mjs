// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le rendu des sous-agents (outil `task`)
// et la refonte thinking (plié par défaut + verrou hide_thinking), sans backend.
// Lancement : PERF_PORT=8912 node tests/frontend/task-server.mjs
//
// - POST /api/chat-saved-stream3 rejoue un flux NDJSON canonique :
//   thinking_token ×3 → tool_call(task) → task_step (tick/running/done) →
//   task_step(final) → tool_result(enveloppe) → content → final.
// - GET /api/saved/chats/c1 : chat PERSISTÉ portant task_runs + thinking sur
//   le dernier assistant → teste la réhydratation (carte agent + bloc plié).
// - GET /__cfg?hide_thinking=1 : bascule le réglage servi par /api/settings.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8912);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

let HIDE_THINKING = false;
// Annulations par-enfant reçues (POST /api/chat/task-cancel) — inspectées par
// le verify via GET /__cancels ; purgées par /__cfg.
let CANCELS = [];
// Scénario du stream live : 'single' (1 agent, historique) ou 'queue'
// (2 task d'un batch sérialisé — le 2e n'a pas d'id avant son spawn).
let SCENARIO = 'single';

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

const CHILD = 't1-ab12';
// Séquence NDJSON du tour live (un sous-agent explore à 2 appels d'outils).
// Ticks = relais « réel seul » du backend : chaque tick porte l'occupation de
// contexte RÉELLE de l'enfant (kv_cache.used relayé — même mécanisme que la
// jauge du parent) ; le final porte context_tokens (occupation finale).
const STREAM = [
    { type: 'iteration', n: 1 },
    { type: 'thinking_token', text: 'Je vais déléguer cette recherche ' },
    { type: 'thinking_token', text: 'à un agent explore ' },
    { type: 'thinking_token', text: 'pour garder le contexte mince.' },
    { type: 'tool_call', name: 'task', args: { subagent_type: 'explore', description: 'trouver la définition de parse_date', prompt: 'Find where parse_date is defined and used.' } },
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'spawned', resumed: false, depth: 0 },
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'tick', tokens: 350 },
    { type: 'task_step', child_id: CHILD, agent: 'explore', step: 1, max_steps: 15, tool: 'list_files', args_preview: '{"path":"src"}', tokens: 350, status: 'running' },
    { type: 'task_step', child_id: CHILD, agent: 'explore', step: 1, max_steps: 15, tool: 'list_files', tokens: 350, status: 'done', result_preview: '["dates.py","main.py"]' },
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'tick', tokens: 980 },
    // Narration de l'enfant (flush à la frontière du tool call suivant) →
    // déroulé LIVE de la modale « œil ».
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'text', text: 'Deux fichiers candidats, je lis dates.py.' },
    { type: 'task_step', child_id: CHILD, agent: 'explore', step: 2, max_steps: 15, tool: 'read_file', args_preview: '{"path":"src/dates.py"}', tokens: 980, status: 'running' },
    { type: 'task_step', child_id: CHILD, agent: 'explore', step: 2, max_steps: 15, tool: 'read_file', tokens: 980, status: 'done', result_preview: 'def parse_date(s): …' },
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'tick', tokens: 1240 },
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'final', state: 'completed', steps_total: 2, context_tokens: 1240, input_tokens: 900, output_tokens: 340, duration_ms: 1234,
      transcript: [
          { tool: 'list_files', args_preview: '{"path":"src"}', status: 'done', result_preview: '["dates.py","main.py"]' },
          { text: 'Deux fichiers candidats, je lis dates.py.' },
          { tool: 'read_file', args_preview: '{"path":"src/dates.py"}', status: 'done', result_preview: 'def parse_date(s): …' },
          { text: 'parse_date est défini à src/dates.py:12.' },
      ] },
    { type: 'tool_result', name: 'task', result: `<task id="${CHILD}" state="completed">\n<task_result>\nparse_date is defined at src/dates.py:12\n</task_result>\n</task>` },
    { type: 'content_token', text: 'parse_date' },
    { type: 'content_token', text: ' est défini dans src/dates.py.' },
    { type: 'final', cancelled: false, persisted: true, title: 'Demo task' },
];

// Scénario « queue » : DEUX task dans le même batch (sérialisés). Les deux
// tool_call partent AVANT toute exécution (fidèle à la boucle : émission
// upfront) → deux lignes, la 2e SANS id jusqu'à son spawn. L'enfant B spawn
// après la fin de A puis finit `cancelled` (le verify a armé l'annulation
// différée pendant la file ; le mock, pré-scripté, joue l'état terminal).
const CHILD_B = 't2-cd34';
const STREAM_QUEUE = [
    { type: 'iteration', n: 1 },
    { type: 'tool_call', name: 'task', args: { subagent_type: 'explore', description: 'mission A', prompt: 'A' } },
    { type: 'tool_call', name: 'task', args: { subagent_type: 'explore', description: 'mission B', prompt: 'B' } },
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'spawned', resumed: false, depth: 0 },
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'tick', tokens: 300 },
    { type: 'task_step', child_id: CHILD, agent: 'explore', step: 1, max_steps: 25, tool: 'list_files', args_preview: '{"path":"src"}', tokens: 300, status: 'running' },
    { type: 'task_step', child_id: CHILD, agent: 'explore', step: 1, max_steps: 25, tool: 'list_files', tokens: 300, status: 'done' },
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'tick', tokens: 700 },
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'tick', tokens: 820 },
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'tick', tokens: 900 },
    { type: 'task_step', child_id: CHILD, agent: 'explore', status: 'final', state: 'completed', steps_total: 1, context_tokens: 900, input_tokens: 700, output_tokens: 200, duration_ms: 800 },
    { type: 'tool_result', name: 'task', result: `<task id="${CHILD}" state="completed">\n<task_result>\nmission A ok\n</task_result>\n</task>` },
    { type: 'task_step', child_id: CHILD_B, agent: 'explore', status: 'spawned', resumed: false, depth: 0 },
    { type: 'task_step', child_id: CHILD_B, agent: 'explore', status: 'final', state: 'cancelled', steps_total: 0, context_tokens: 150, input_tokens: 150, output_tokens: 0, duration_ms: 120 },
    { type: 'tool_result', name: 'task', result: '{"ok": false, "error": "task_cancelled", "message": "sub-agent explore was cancelled by the user"}' },
    { type: 'content_token', text: 'Mission A faite, mission B annulée.' },
    { type: 'final', cancelled: false, persisted: true, title: 'Demo queue' },
];

// Chat PERSISTÉ : task_runs + thinking sur le DERNIER assistant (seul le
// dernier garde son thinking à la réhydratation — _history.js).
const SAVED_CHAT = {
    id: 'c1', title: 'Demo task persisté',
    messages: [
        { role: 'user', content: 'Audite les imports du projet.' },
        { role: 'assistant',
          content: 'Audit terminé : 3 imports morts trouvés.',
          thinking: 'Je vais confier cet audit à un agent explore en trois passes.',
          task_runs: [{
              id: 't9-zz01', agent: 'explore', label: 'audit des imports morts du projet',
              prompt: 'Repère tous les imports morts du projet et propose un correctif par fichier.',
              state: 'completed', steps_total: 3,
              context_tokens: 1000, input_tokens: 800, output_tokens: 200, duration_ms: 2100,
              // Forme persistée réelle : `tools` STRIPPÉ par le serveur,
              // `transcript` (déroulé complet borné) CONSERVÉ.
              transcript: [
                  { text: 'Je commence par lister les fichiers du projet.' },
                  { tool: 'list_files', args_preview: '{"path":"."}',            status: 'done',  result_preview: '["a.py","b.py"]' },
                  { tool: 'read_file',  args_preview: '{"path":"a.py"}',         status: 'done',  result_preview: 'import os, sys' },
                  { tool: 'code',       args_preview: '{"action":"references"}', status: 'error', result_preview: '{"ok":false,"error":"index_unavailable"}' },
                  { text: 'Audit terminé : 3 imports morts trouvés.' },
              ],
          }] },
    ],
};

function streamTurn(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    const seq = SCENARIO === 'queue' ? STREAM_QUEUE : STREAM;
    let i = 0;
    const tick = () => {
        if (i >= seq.length) { try { res.end(); } catch (_) {} return; }
        try { res.write(JSON.stringify(seq[i++]) + '\n'); } catch (_) { return; }
        // 200 ms/event : laisse à la vérif le temps de tester spinner + ✕
        // PUIS d'ouvrir la modale « œil » PENDANT le run (fenêtre running
        // = spawned → final, ~3 s).
        setTimeout(tick, 200);
    };
    tick();
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/__cfg') {
            const q = new URLSearchParams(req.url.split('?')[1] || '');
            HIDE_THINKING = q.get('hide_thinking') === '1';
            SCENARIO = q.get('scenario') || 'single';
            CANCELS = [];
            return json(res, { ok: true, hide_thinking: HIDE_THINKING, scenario: SCENARIO });
        }
        if (url === '/__cancels') return json(res, { items: CANCELS });
        if (url === '/api/chat/task-cancel' && req.method === 'POST') {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                try { CANCELS.push(JSON.parse(raw)); } catch (_) { CANCELS.push({ raw }); }
                json(res, { status: 'cancelled', active: true });
            });
            return;
        }
        if (url === '/api/settings') return json(res, { hide_thinking: HIDE_THINKING });
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            req.on('data', () => {}); req.on('end', () => streamTurn(res));
            return;
        }
        if (url === '/api/saved/chats') return json(res, { items: [{ id: 'c1', title: 'Demo task persisté', updated_at: 0 }] });
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
}).listen(PORT, '127.0.0.1', () => console.log(`task-server sur http://127.0.0.1:${PORT}`));
