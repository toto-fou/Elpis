// SPDX-License-Identifier: MIT
// Harnais route-mock du ROUTAGE DU CONTENU STREAMÉ dans un tour à outils
// (correctif 2026-09-02 : « les phrases sont interprétées avant l'appel »).
// Depuis l'émission directe (passe 1), le backend n'émet plus tool_thinking :
// TOUT le contenu d'itération part en content_token, sans savoir s'il s'agit
// de la narration du prochain appel ou de la réponse finale.
//
//   PERF_PORT=8921 node tests/frontend/pretool-server.mjs &
//   PERF_PORT=8921 node tests/frontend/pretool-verify.mjs
//
// Le flux est FIDÈLE à la boucle réelle : round 1 = content_token (narration,
// destination inconnue → corps) → tool_call_delta (le modèle génère l'appel)
// → tool_call → tool_result ; round 2 = content_token (narration, phase
// outils) → tool_call SANS delta (provider sans streaming d'args) →
// tool_result ; réponse finale en content_token → final(assistant).
//
// BARRIÈRES : le flux s'arrête sur les entrées ``{ gate: 'x' }`` jusqu'à ce
// que la vérif ait constaté l'état intermédiaire et appelé POST /__gate/x.
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

const NARR1  = 'Je vais lire le fichier de configuration.';
const NARR2  = 'Le fichier est lu, je corrige maintenant.';
const FINAL  = 'Voilà, la configuration est corrigée.';

// Scénario « reset » (passe 8, F3/F5) : PRETOOL_SCENARIO=reset — l'itération
// est rejouée après un delta (coupure en pleine génération des args) : le
// backend émet ``tool_call_delta {reset:true}`` puis RE-STREAME la même prose.
// La narration ne doit apparaître qu'UNE fois dans le worklog.
const STREAM_RESET = [
    { type: 'iteration', n: 1 },
    { type: 'content_token', text: 'Je vais lire le fichier ' },
    { type: 'content_token', text: 'de configuration.' },
    { type: 'tool_call_delta', index: 0, iter: 0, name_delta: 'read_file', args_delta: '{"pa' },
    { gate: 'r1_delta' },
    { type: 'tool_call_delta', reset: true, index: -1, iter: 0 },
    { type: 'iteration', n: 1 },
    { type: 'content_token', text: 'Je vais lire le fichier ' },
    { type: 'content_token', text: 'de configuration.' },
    { type: 'tool_call_delta', index: 0, iter: 0, name_delta: 'read_file', args_delta: '{"path":"config.py"}' },
    { type: 'tool_call', name: 'read_file', args: { path: 'config.py' }, call_id: 'c1' },
    { type: 'tool_result', name: 'read_file', result: 'DEBUG = True', call_id: 'c1' },
    { type: 'content_token', text: 'Voilà, la configuration ' },
    { type: 'content_token', text: 'est corrigée.' },
    { type: 'final', assistant: FINAL, cancelled: false, persisted: true, title: 'Demo reset' },
];

const STREAM = [
    { type: 'iteration', n: 1 },
    { type: 'content_token', text: 'Je vais lire le fichier ' },
    { type: 'content_token', text: 'de configuration.' },
    { gate: 'r1_narr' },                    // narration round 1 streamée (corps)
    { type: 'tool_call_delta', index: 0, iter: 0, name_delta: 'read_file', args_delta: '{"path":' },
    { gate: 'r1_delta' },                   // 1er delta reçu → bascule anticipée
    { type: 'tool_call_delta', index: 0, iter: 0, args_delta: '"config.py"}' },
    { type: 'tool_call', name: 'read_file', args: { path: 'config.py' }, call_id: 'c1' },
    { type: 'tool_result', name: 'read_file', result: 'DEBUG = True', call_id: 'c1' },
    { type: 'content_token', text: 'Le fichier est lu, ' },
    { type: 'content_token', text: 'je corrige maintenant.' },
    { gate: 'r2_narr' },                    // narration round 2 (phase outils)
    { type: 'tool_call', name: 'write_file', args: { path: 'config.py', content: 'DEBUG = False' }, call_id: 'c2' },
    { type: 'tool_result', name: 'write_file', result: '{"ok": true}', call_id: 'c2' },
    { type: 'content_token', text: 'Voilà, la configuration ' },
    { type: 'content_token', text: 'est corrigée.' },
    { gate: 'final_narr' },                 // réponse finale en cours (phase outils)
    { type: 'final', assistant: FINAL, cancelled: false, persisted: true, title: 'Demo pré-outil' },
];

const gates = new Map();   // name → resolve()
function waitGate(name) {
    return new Promise((resolve) => { gates.set(name, resolve); });
}

function streamTurn(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    let i = 0;
    const tick = async () => {
        const _S = process.env.PRETOOL_SCENARIO === 'reset' ? STREAM_RESET : STREAM;
        if (i >= _S.length) { try { res.end(); } catch (_) {} return; }
        const ev = _S[i++];
        if (ev.gate) { await waitGate(ev.gate); tick(); return; }
        try { res.write(JSON.stringify(ev) + '\n'); } catch (_) { return; }
        setTimeout(tick, 40);
    };
    tick();
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url.startsWith('/__gate/') && req.method === 'POST') {
            const name = url.slice('/__gate/'.length);
            const r = gates.get(name);
            if (r) { gates.delete(name); r(); }
            return json(res, { released: !!r });
        }
        if (url === '/api/settings') return json(res, { hide_thinking: false });
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            req.on('data', () => {}); req.on('end', () => streamTurn(res));
            return;
        }
        if (url === '/api/saved/chats') return json(res, { items: [] });
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
}).listen(PORT, '127.0.0.1', () => console.log(`pretool-server sur http://127.0.0.1:${PORT}`));
