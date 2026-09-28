// SPDX-License-Identifier: MIT
// Harnais route-mock pour vérifier le SUIVI D'UN RUN DÉTACHÉ (audit
// 2026-08-22, B3/B4), sans backend.
// Lancement : PERF_PORT=8926 node tests/frontend/detached-run-server.mjs
//
// Ce que le scénario rejoue — la panne réelle d'une mission longue :
//   1. le tour démarre, un OUTIL s'exécute (event tool_call), du texte arrive ;
//   2. le flux est COUPÉ NET côté serveur (socket détruite) — veille du
//      portable, changement de réseau, worker recyclé, onglet rechargé ;
//   3. le serveur, lui, ne tue plus le run : il le DÉTACHE et le mène à son
//      terme. ``/generation-status`` répond donc ``true`` un moment, puis
//      ``false`` une fois le tour persisté.
//
// AVANT : le client affichait « Connexion interrompue — tour non rejoué » et
// s'arrêtait là. L'utilisateur n'avait aucun moyen de savoir que sa mission
// tournait toujours, ni de récupérer le résultat autrement qu'en rechargeant
// la page à l'aveugle.
// APRÈS : il doit annoncer que la génération se poursuit, garder le bouton
// Arrêter, sonder l'état, puis RECHARGER la conversation à la fin.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8926);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

// Nombre de sondes ``generation-status`` renvoyant « en cours » avant la fin.
const RUNNING_PROBES = Number(process.env.RUNNING_PROBES || 2);

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

let statusCalls = 0;
let chatLoads = 0;

// Le tour tel qu'il aura été persisté par le worker détaché : c'est ce que le
// rechargement doit afficher.
const FINAL_MESSAGES = [
    { role: 'user', content: 'Lance la mission' },
    { role: 'assistant',
      content: 'Mission terminée : trois fichiers écrits et vérifiés.' },
];

function streamTurnThenCut(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    const head = [
        { type: 'chat_id', chat_id: 'c-run' },
        { type: 'tool_call', name: 'write_file', args: { path: '/work/a.txt' } },
        { type: 'content_token', text: 'Je commence le travail' },
    ];
    let i = 0;
    const tick = () => {
        if (i >= head.length) {
            // COUPURE BRUTALE : pas de ``final``, pas de fin propre — la
            // socket meurt, exactement comme une perte de réseau.
            try { res.destroy(); } catch (_) {}
            return;
        }
        try { res.write(JSON.stringify(head[i++]) + '\n'); } catch (_) { return; }
        setTimeout(tick, 40);
    };
    tick();
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/api/settings') return json(res, { hide_thinking: false });
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            req.on('data', () => {});
            req.on('end', () => streamTurnThenCut(res));
            return;
        }
        // Le cœur du scénario : la génération continue côté serveur, puis
        // se termine.
        if (url === '/api/chat/c-run/generation-status') {
            statusCalls += 1;
            return json(res, { generation_running: statusCalls <= RUNNING_PROBES });
        }
        // Rechargement de la conversation après la fin du run détaché.
        if (url === '/api/saved/chats/c-run') {
            chatLoads += 1;
            return json(res, { id: 'c-run', title: 'Mission', messages: FINAL_MESSAGES,
                               meta_json: {} });
        }
        // Sonde du test : combien de fois la conversation a-t-elle été
        // rechargée, et combien de sondes d'état ont été faites ?
        if (url === '/__probe') return json(res, { statusCalls, chatLoads });

        if (url === '/api/saved/chats') {
            return json(res, { items: [{ id: 'c-run', title: 'Mission', updated_at: 0 }] });
        }
        if (url === '/api/saved/chats/new' && req.method === 'POST') {
            return json(res, { id: 'c-run', title: 'Mission' });
        }
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.write(': ping\n\n');
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => clearInterval(t));
            return;
        }
        if (url.startsWith('/api/')) return json(res, {});

        if (url === '/' || url === '/index.html') {
            res.setHeader('content-type', 'text/html');
            res.end(applyIncludes(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
            return;
        }
        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const p = path.join(ROOT, rel);
        if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
        res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
        res.end(fs.readFileSync(p));
    } catch (e) { res.statusCode = 404; res.end('nf'); }
}).listen(PORT, () => console.log('detached-run-server on ' + PORT));
