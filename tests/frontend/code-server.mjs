// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER la page « Code » (transcript riche : markdown,
// thinking replié/animé, tool calls, diffs, busy ; composer slash + écho optimiste)
// sans backend ni CLI opencode. Réplique @include + /static, mocke /api/code/* et
// le SSE /api/code/stream avec INJECTION à la demande : POST /__inject (body =
// event brut {type, properties}). GET /__sent liste les POST pilotage reçus ;
// GET /__fail arme un échec 500 sur le prochain POST prompt (test écho optimiste).
// Lancement : PERF_PORT=8906 node tests/frontend/code-server.mjs
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
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
}
function readBody(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
    });
}

const NOW = Date.now();
// Diff unifié > 12 lignes → teste le repli « Afficher les N lignes restantes ».
const DIFF = [
    '--- a/app/login.py', '+++ b/app/login.py', '@@ -1,10 +1,12 @@',
    ' import os', '-import sys', '+import sys, json', ' ', ' def login(user):',
    '-    if user.pw == input:', '+    if check_hash(user.pw, input):',
    '+        audit(user)', '         return True', '     return False',
    ' ', ' def logout(user):', '     session.drop(user)', ' # fin',
].join('\n');

// Transcript fixture : user → note (/commande tracée) → assistant (thinking +
// outil edit avec diff + texte md + step-finish + ```diff markdown + bash dont
// la SORTIE est un diff + part patch). L'assistant porte tokens+model (jauge
// ctx : 40000+8000+1500+2000+500 = 52k / 200k = 26 %).
const MESSAGES = [
    { info: { id: 'm1', role: 'user', sessionID: 's1', time: { created: NOW - 60000 } },
      parts: [{ id: 'm1p1', type: 'text', text: 'Corrige le bug de login', time: { start: NOW - 60000 } }] },
    { info: { id: 'note-n1', role: 'note', sessionID: 's1', time: { created: NOW - 55000 },
              note: { kind: 'command', label: '/review', detail: 'HEAD~1' } }, parts: [] },
    { info: { id: 'm2', role: 'assistant', sessionID: 's1',
              providerID: 'elpis', modelID: 'qwen3-32b',
              tokens: { input: 40000, output: 2000, reasoning: 500, cache: { read: 8000, write: 1500 } },
              time: { created: NOW - 50000, completed: NOW - 10000 } },
      parts: [
          { id: 'm2p1', type: 'step-start', messageID: 'm2', sessionID: 's1' },
          { id: 'm2p2', type: 'reasoning', messageID: 'm2', sessionID: 's1',
            text: 'Le hash n\'est jamais vérifié : comparaison en clair.\nJe dois passer par check_hash().',
            time: { start: NOW - 49000, end: NOW - 44000 } },
          { id: 'm2p3', type: 'tool', tool: 'edit', callID: 'c1', messageID: 'm2', sessionID: 's1',
            state: { status: 'completed', title: 'app/login.py',
                     input: { filePath: 'app/login.py', oldString: 'user.pw == input' },
                     output: 'Edited app/login.py', metadata: { diff: DIFF },
                     time: { start: NOW - 43000, end: NOW - 41000 } },
            time: { start: NOW - 43000 } },
          { id: 'm2p4', type: 'text', messageID: 'm2', sessionID: 's1',
            text: 'Voici **le correctif** :\n\n```python\nif check_hash(user.pw, input):\n```\n\nLe mot de passe est maintenant vérifié par hash.',
            time: { start: NOW - 40000 } },
          // tokens par étape : NE DOIT PLUS s'afficher (remplacé par la jauge ctx)
          { id: 'm2p5', type: 'step-finish', tokens: { input: 300, output: 40 },
            messageID: 'm2', sessionID: 's1' },
          // bloc ```diff markdown → carte diff native (pas un bloc code)
          { id: 'm2p6', type: 'text', messageID: 'm2', sessionID: 's1',
            text: 'Et la doc :\n\n```diff\n--- a/docs/notes.md\n+++ b/docs/notes.md\n@@ -1,2 +1,2 @@\n-ancien\n+nouveau\n```\n\nVoilà.',
            time: { start: NOW - 39000 } },
          // sortie d'outil qui EST un diff (git diff) → cartes dans le panneau
          { id: 'm2p7', type: 'tool', tool: 'bash', callID: 'c2', messageID: 'm2', sessionID: 's1',
            state: { status: 'completed', title: 'git diff', input: { command: 'git diff' },
                     output: DIFF, time: { start: NOW - 38000, end: NOW - 37000 } },
            time: { start: NOW - 38000 } },
          // part patch ({hash, files}) → pill dépliable (cartes via le diff du edit)
          { id: 'm2p8', type: 'patch', hash: 'abc123', files: ['app/login.py'],
            messageID: 'm2', sessionID: 's1' },
      ] },
    // Message « opencode 1.18 » : les métadonnées d'outils réellement émises
    // (filediff, command+exitCode, pattern+matches, todos) et les types de
    // parts que la page rendait en pastille grise (subtask, compaction, retry)
    // ou qu'elle ne doit PAS rendre du tout (snapshot, agent).
    { info: { id: 'm9', role: 'assistant', sessionID: 's1',
              time: { created: NOW - 9000, completed: NOW - 2000 } },
      parts: [
          // filediff = les compteurs calculés par opencode → métrique de la ligne
          { id: 'm9p1', type: 'tool', tool: 'edit', callID: 'c9', messageID: 'm9', sessionID: 's1',
            state: { status: 'completed', title: 'app/api.py',
                     input: { filePath: 'app/api.py' },
                     output: 'Edited app/api.py',
                     metadata: { filepath: 'app/api.py', diff: DIFF,
                                 filediff: { file: 'app/api.py', additions: 7, deletions: 2 } },
                     time: { start: NOW - 9000, end: NOW - 8000 } } },
          // write : opencode ne fournit AUCUN diff (il n'y a pas d'avant) —
          // la carte « tout en ajouts » est fabriquée côté page
          { id: 'm9p2', type: 'tool', tool: 'write', callID: 'c10', messageID: 'm9', sessionID: 's1',
            state: { status: 'completed', title: 'app/new.py',
                     input: { filePath: 'app/new.py', content: 'import os\nDEBUG = False\n' },
                     output: 'Created app/new.py', metadata: { filepath: 'app/new.py' },
                     time: { start: NOW - 8000, end: NOW - 7900 } } },
          // commande + code de sortie non nul → métrique d'échec
          { id: 'm9p3', type: 'tool', tool: 'bash', callID: 'c11', messageID: 'm9', sessionID: 's1',
            state: { status: 'completed', title: 'Lance les tests',
                     input: { command: 'npm test' }, output: '2 failing',
                     metadata: { command: 'npm test', exitCode: 1 },
                     time: { start: NOW - 7800, end: NOW - 7000 } } },
          { id: 'm9p4', type: 'tool', tool: 'grep', callID: 'c12', messageID: 'm9', sessionID: 's1',
            state: { status: 'completed', title: 'check_hash',
                     input: { pattern: 'check_hash' }, output: '4 matches',
                     metadata: { pattern: 'check_hash', matches: 4 },
                     time: { start: NOW - 6900, end: NOW - 6800 } } },
          { id: 'm9p5', type: 'tool', tool: 'todowrite', callID: 'c13', messageID: 'm9', sessionID: 's1',
            state: { status: 'completed', title: 'todos', input: {}, output: 'ok',
                     metadata: { todos: [
                         { content: 'Lire le module', status: 'completed' },
                         { content: 'Écrire le test', status: 'in_progress' },
                         { content: 'Corriger le hash', status: 'pending' }] },
                     time: { start: NOW - 6700, end: NOW - 6600 } } },
          { id: 'm9p6', type: 'subtask', messageID: 'm9', sessionID: 's1',
            agent: 'explore', description: 'Cartographier le module auth',
            prompt: 'Liste les points d\'entrée de app/auth.', model: { providerID: 'elpis', modelID: 'qwen3-32b' } },
          { id: 'm9p7', type: 'compaction', messageID: 'm9', sessionID: 's1', auto: true },
          { id: 'm9p8', type: 'retry', messageID: 'm9', sessionID: 's1', attempt: 2,
            error: { name: 'ProviderError', message: 'rate limited' }, time: { created: NOW - 6500 } },
          // internes : point de restauration du /undo et mention « @plan » déjà
          // présente dans le texte — aucun des deux ne doit produire de pastille
          { id: 'm9p9', type: 'snapshot', messageID: 'm9', sessionID: 's1', snapshot: 'deadbeef' },
          { id: 'm9p10', type: 'agent', messageID: 'm9', sessionID: 's1', name: 'plan' },
      ] },
    // Erreur de tour : opencode la met dans info.error — elle n'était qu'une
    // toast fugace, le transcript n'en gardait rien.
    { info: { id: 'm10', role: 'assistant', sessionID: 's1',
              time: { created: NOW - 1900, completed: NOW - 1800 },
              error: { name: 'ProviderAuthError', data: { message: 'quota dépassé' } } },
      parts: [] },
    // Message de compaction (info.summary) : un résumé, pas une réponse.
    { info: { id: 'm11', role: 'assistant', sessionID: 's1', summary: true,
              time: { created: NOW - 1700, completed: NOW - 1600 } },
      parts: [{ id: 'm11p1', type: 'text', messageID: 'm11', sessionID: 's1',
                text: 'Resume du fil precedent.', time: { start: NOW - 1700 } }] },
];

const COMMANDS = [
    { name: 'review', description: 'Revue du diff courant', agent: 'reviewer', model: 'claude-x', has_args: true },
    { name: 'init', description: 'Initialise AGENTS.md' },
    { name: 'test', description: 'Lance la suite de tests', has_args: true },
];

const sseClients = new Set();
const sent = [];          // POST pilotage reçus (prompt/command/abort/rename/permission/question)
let failNextPrompt = false;
let cliDown = false;      // /__cli?down=1 : simule la CLI fermée (bye)
// /__nosession=1 : CLI connectée mais AUCUNE session publiée — opencode ne
// matérialise la session qu'au premier message (cas signalé par les users).
let noSession = false;

function broadcast(ev) {
    const line = 'data: ' + JSON.stringify(ev) + '\n\n';
    for (const res of sseClients) { try { res.write(line); } catch (_) {} }
    return sseClients.size;
}

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const m = req.method;
    try {
        // ── Contrôle du harnais ─────────────────────────────────────────
        if (url === '/__inject' && m === 'POST') {
            const ev = await readBody(req);
            return json(res, { ok: true, sent: broadcast(ev) });
        }
        if (url === '/__sent') return json(res, { sent });
        if (url === '/__fail') { failNextPrompt = true; return json(res, { ok: true }); }
        if (url === '/__cli') { cliDown = /down=1/.test(req.url); return json(res, { ok: true }); }
        if (url === '/__nosession') { noSession = /on=1/.test(req.url); return json(res, { ok: true }); }
        // CLI connectées (ciblage /new + état « connectée sans session »)
        if (url === '/api/code/clients')
            return json(res, cliDown ? [] : [{ id: 'c1', directory: '/home/dev/webapp', plugin_version: 13 }]);

        // ── /api/code/* ─────────────────────────────────────────────────
        if (url === '/api/code/health')
            return json(res, { available: true, connected: !cliDown, sessions: 3,
                               plugin_version: 5, plugin_current: 5 });
        if (url === '/api/code/config')
            return json(res, { app_url: 'http://127.0.0.1:' + PORT, token: 'pcr_test',
                               plugin_url: 'http://127.0.0.1:' + PORT + '/api/code/plugin.js' });
        if (url === '/api/code/sessions')
            return json(res, noSession ? [] : [
                { id: 's1', title: 'Refactor auth', directory: '/home/dev/webapp',
                  time: { updated: NOW }, busy: false, connected: !cliDown, client: 'c1',
                  msg_count: 2, last_model: 'elpis/qwen3-32b',
                  preview: 'Le mot de passe est maintenant vérifié par hash.' },
                { id: 's3', title: 'Autre chantier', directory: '/home/dev/webapp',
                  time: { updated: NOW - 3600000 }, busy: false, connected: !cliDown, client: 'c1',
                  msg_count: 0, last_model: '', preview: '' },
                { id: 's2', title: 'Vieille session', directory: '/home/dev/old',
                  time: { updated: NOW - 3 * 86400000 }, busy: false, connected: false, client: 'c2' },
            ]);
        if (url === '/api/code/sessions/s1/messages') return json(res, MESSAGES);
        if (url === '/api/code/sessions/s2/messages') return json(res, [MESSAGES[0]]);
        if (url === '/api/code/sessions/s3/messages') return json(res, []);
        if (url === '/api/code/commands') return json(res, COMMANDS);
        if (url === '/api/code/models')
            return json(res, {
                providers: [
                    { id: 'elpis', name: 'Elpis (llama.cpp)', models: [
                        { id: 'qwen3-32b', name: 'Qwen3 32B', limit: { context: 200000, output: 8000 } },
                        { id: 'glm-4.7', name: 'GLM 4.7' }] },
                    { id: 'anthropic', name: 'Anthropic', models: [{ id: 'claude-x', name: 'Claude X' }] },
                ],
                default: { elpis: 'qwen3-32b' },
            });
        // agents primaires de la CLI (greffon v12) → bascule plan/build
        if (url === '/api/code/agents')
            return json(res, {
                agents: [{ name: 'build', description: 'Exécute les outils' },
                         { name: 'plan', description: 'Mode plan. Aucune modification.' }],
                default: 'build',
            });
        // renommage (kind rename) + permissions (liste vide au chargement, la
        // vérif injecte permission.updated par SSE puis répond par POST)
        let mm;
        if ((mm = url.match(/^\/api\/code\/sessions\/(s\d)\/rename$/)) && m === 'POST') {
            sent.push({ kind: 'rename', sid: mm[1], ...(await readBody(req)) });
            return json(res, { ok: true, queued: true });
        }
        // Commandes visant la CLI (ciblage strict) : on enregistre la cible
        // pour vérifier qu'elle n'est PAS choisie par le serveur au hasard.
        if (url === '/api/code/new' && m === 'POST') {
            sent.push({ kind: 'new', ...(await readBody(req)) });
            return json(res, { ok: true, queued: true });
        }
        if ((mm = url.match(/^\/api\/code\/clients\/([^/]+)\/exit$/)) && m === 'POST') {
            sent.push({ kind: 'exit', client: mm[1] });
            return json(res, { ok: true, queued: true });
        }
        // Appairage par code (device flow) : la CLI affiche le code, la page le
        // confirme. Seul « ABC123 » est accepté — le reste simule un code périmé.
        if (url === '/api/code/pair/confirm' && m === 'POST') {
            const body = await readBody(req);
            const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
            sent.push({ kind: 'pair', code });
            if (code !== 'ABC123') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}'); }
            return json(res, { ok: true });
        }
        if ((mm = url.match(/^\/api\/code\/sessions\/(s\d)\/permissions$/)) && m === 'GET')
            return json(res, []);
        if ((mm = url.match(/^\/api\/code\/sessions\/(s\d)\/permissions\/([^/]+)$/)) && m === 'POST') {
            sent.push({ kind: 'permission', sid: mm[1], pid: mm[2], ...(await readBody(req)) });
            return json(res, { ok: true, queued: true });
        }
        // questions de l'outil `question` (greffon v14) : liste vide au chargement,
        // la vérif injecte question.asked par SSE puis répond/refuse par POST
        if ((mm = url.match(/^\/api\/code\/sessions\/(s\d)\/questions$/)) && m === 'GET')
            return json(res, []);
        if ((mm = url.match(/^\/api\/code\/sessions\/(s\d)\/questions\/([^/]+)$/)) && m === 'POST') {
            sent.push({ kind: 'question', sid: mm[1], qid: mm[2], ...(await readBody(req)) });
            return json(res, { ok: true, queued: true });
        }
        if (url === '/api/code/sessions/s1/action' && m === 'POST') {
            sent.push({ kind: 'action', ...(await readBody(req)) });
            return json(res, { ok: true, queued: true });
        }
        if (url === '/api/code/sessions/s1/prompt' && m === 'POST') {
            const body = await readBody(req);
            if (failNextPrompt) { failNextPrompt = false; return json(res, { detail: 'boom' }, 500); }
            sent.push({ kind: 'prompt', ...body });
            return json(res, { ok: true, queued: true });
        }
        if (url === '/api/code/sessions/s1/command' && m === 'POST') {
            sent.push({ kind: 'command', ...(await readBody(req)) });
            return json(res, { ok: true, queued: true });
        }
        if (url === '/api/code/sessions/s1/abort' && m === 'POST') {
            sent.push({ kind: 'abort' });
            return json(res, { ok: true, queued: true });
        }
        if (url === '/api/code/stream') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.setHeader('cache-control', 'no-cache'); res.setHeader('connection', 'keep-alive');
            res.write(': ping\n\n');
            sseClients.add(res);
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => { clearInterval(t); sseClients.delete(res); });
            return;
        }

        // ── Boot (logged-in) ───────────────────────────────────────────
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: { opencode: true } });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user',
                                                       features: { opencode: true } });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/saved/chats') return json(res, { items: [] });
        if (url.startsWith('/api/')) return json(res, {});

        // ── Statique ───────────────────────────────────────────────────
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
}).listen(PORT, '127.0.0.1', () => console.log(`code-server sur http://127.0.0.1:${PORT}`));
