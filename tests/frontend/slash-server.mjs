// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le menu « / » du composeur, sans backend.
// Lancement : PERF_PORT=8944 node tests/frontend/slash-server.mjs
//
// Le témoin CENTRAL de ce harnais est /api/chat-saved-stream3 : une commande
// CONNUE ne doit jamais l'atteindre. C'est tout l'objet du second point
// d'entrée (résolution à l'envoi) — sans lui, « /plan on » part au modèle
// comme un message ordinaire. Chaque appel est donc enregistré et inspectable
// via /__calls, au même titre que les PUT via /__puts.
//
// Le chat « c1 » existe côté serveur : /compact exige une conversation en
// cours, un mock sans chat chargeable l'afficherait indisponible et ne
// prouverait rien. « c9 » est l'id rendu par POST /new — le scénario « chat
// vierge » (/plan armé puis scellé à la création) vit dessus.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8944);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

let PUTS = [];      // { url, body }
let CALLS = [];     // { url }
let NEWS = [];      // corps des POST /api/saved/chats/new (scellement /plan)
// État plan PAR CHAT — comme la vraie base. Le stream le consulte pour jouer
// la sortie ONE-SHOT : tour abouti en mode plan → plan_mode_done dans le
// 'final' + mode coupé côté « base ».
let PLANS = { c1: false, c9: false };

// Un skill nommé « creation » : la frappe « /crea » ne matche aucune commande
// et doit basculer sur les skills (rétrocompat « muscle memory » du menu
// historique). Sans ce nom précis, le test ne prouverait rien.
const SKILLS = [
    { name: 'creation-de-skill', description: 'Créer un skill pas à pas', domain: 'meta', tags: [] },
    { name: 'revue-de-code', description: 'Relire un diff', domain: 'dev', tags: ['git'] },
    { name: 'redaction', description: 'Rédiger une note', domain: 'doc', tags: [] },
];

// Prompts : un personnel accentué, un second personnel, un REÇU en partage.
// Le partagé prouve la fusion des deux routes ; l'accent, que la recherche
// n'est pas naïvement sensible à la casse.
const PROMPTS = [
    { id: 1, title: 'Résumé de réunion', created_at: 1755300000,
      content: 'Fais un résumé structuré de la réunion : décisions, points ouverts, prochaines actions.' },
    { id: 2, title: 'Analyse de logs', created_at: 1750000000,
      content: 'Cherche les erreurs récurrentes dans ces journaux et classe-les par fréquence.' },
];
const SHARED = [
    { id: 7, title: 'Checklist de mise en production', created_at: 1755000000,
      content: 'Vérifie la sauvegarde, les migrations, le rollback et la fenêtre de maintenance.',
      from_username: 'bob' },
];

const CHAT = {
    id: 'c1', title: 'Conversation de test', updated_at: 1755300000, archived: false,
    messages: [{ role: 'user', content: 'bonjour' },
               { role: 'assistant', content: 'Bonjour, que puis-je faire ?' }],
    tools: [], todos: [], plan_mode: false,
};

const SETTINGS = {
    memory_enabled: true, agents_enabled: false, hide_thinking: false,
    enable_mcp: true, enable_editor: false, enable_rag: false, enable_preview: false,
    enable_model_selector: true, compression_enabled: false,
    assistant_name: 'Elpis', skin: '', custom_agents: [], mcp_servers: [],
};

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
function readBody(req, cb) {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { cb(JSON.parse(raw)); } catch (_) { cb({}); } });
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/__cfg') { PUTS = []; CALLS = []; NEWS = []; PLANS = { c1: false, c9: false }; return json(res, { ok: true }); }
        if (url === '/__puts') return json(res, { items: PUTS });
        if (url === '/__calls') return json(res, { items: CALLS });
        if (url === '/__news') return json(res, { items: NEWS });

        // ── Le témoin : aucune commande connue ne doit arriver ici ──
        // Le chat_id du corps est ÉCHOYÉ dans l'événement final : le front
        // s'aligne dessus (ligne « if (data.chat_id) currentChatId… ») — un
        // id en dur re-clobberait le chat créé du scénario « chat vierge ».
        if (url === '/api/chat-saved-stream3') {
            return readBody(req, (body) => {
                CALLS.push({ url });
                const cid = (body && body.chat_id) || 'c1';
                // Sortie ONE-SHOT du mode plan, comme le vrai serveur : tour
                // abouti → mode coupé en « base » + plan_mode_done au front.
                const done = !!PLANS[cid];
                if (done) PLANS[cid] = false;
                res.statusCode = 200;
                res.setHeader('content-type', 'application/x-ndjson');
                res.write(JSON.stringify({ type: 'content_token', token: 'ok' }) + '\n');
                res.end(JSON.stringify({ type: 'final', content: 'ok', chat_id: cid,
                                         ...(done ? { plan_mode_done: true } : {}) }) + '\n');
            });
        }

        // Généralisé à TOUT id (c1 chargé, c9 créé par le scénario vierge).
        if (url.endsWith('/plan-mode') && req.method === 'PUT') {
            return readBody(req, (body) => {
                PUTS.push({ url, body });
                if (typeof body.plan_mode !== 'boolean') return json(res, { detail: 'bool attendu' }, 422);
                const cid = (url.match(/chats\/([^/]+)\/plan-mode$/) || [])[1] || 'c1';
                PLANS[cid] = body.plan_mode;
                json(res, { ok: true, plan_mode: PLANS[cid] });
            });
        }
        if (url.endsWith('/tools') && req.method === 'PUT') {
            return readBody(req, (body) => { PUTS.push({ url, body }); json(res, { ok: true }); });
        }
        if (url === '/api/chat/c1/compress' && req.method === 'POST') {
            CALLS.push({ url });
            return json(res, { ok: true, compressed: true, summary: 'résumé', tokens_after: 100, round: 1 });
        }

        if (url === '/api/skills') return json(res, { skills: SKILLS, count: SKILLS.length });
        if (url === '/api/prompts' && req.method === 'GET') return json(res, { items: PROMPTS });
        if (url === '/api/prompts/shared') return json(res, { items: SHARED });
        if (url === '/api/saved/chats') return json(res, { items: [{ id: 'c1', title: CHAT.title, updated_at: CHAT.updated_at }] });
        if (url === '/api/saved/chats/c1') return json(res, { ...CHAT, plan_mode: PLANS.c1 });
        // Création : id NEUF (jamais c1) + capture du corps — c'est lui qui
        // porte le scellement atomique de la lecture seule armée.
        if (url === '/api/saved/chats/new' && req.method === 'POST') {
            return readBody(req, (body) => {
                NEWS.push(body || {});
                PLANS.c9 = !!(body && body.plan_mode);   // scellement à la création
                json(res, { id: 'c9' });
            });
        }
        if (url === '/api/chat/c1/compression-state') return json(res, { rounds: 0, max: 2 });

        if (url === '/api/settings' && req.method === 'GET') return json(res, SETTINGS);
        if (url === '/api/settings' && req.method === 'PUT') return json(res, { ok: true });
        if (url === '/api/memory/state') return json(res, {
            username: 'alice',
            user_md: { exists: false, limit: 1375, chars: 0, n_entries: 0, entries: [], entry_ids: [] },
            memory_md: { exists: false, limit: 2200, chars: 0, n_entries: 0, entries: [], entry_ids: [] },
            scopes: [],
        });
        if (url === '/api/usage/me') return json(res, {
            days: 30, since: 1755000000,
            chats: { active: 1, archived: 0, total: 1 },
            messages: { sent: 2, received: 2 },
            tokens: { input: 10, output: 5, total: 15, estimated: false, split_available: false, by_source: [] },
            routines: { runs: 0, ok: 0, error: 0, input_tokens: 0, output_tokens: 0, avg_duration_ms: 0 },
        });
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { categories: [] });
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
}).listen(PORT, '127.0.0.1', () => console.log(`slash-server sur http://127.0.0.1:${PORT}`));
