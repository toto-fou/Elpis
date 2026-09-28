// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER la mascotte du bloc « nouveau chat »
// (frontend/js/chat/_mascotte.js + assets/mascotte), sans backend.
// Lancement : PERF_PORT=8931 node tests/frontend/mascotte-server.mjs
//
// - GET /api/settings sert l'état mocké ; `welcome_mascot` est pilotable via
//   /__cfg?mascotte=<id> (dont la chaîne vide, qui doit rendre le LOGO).
// - PUT /api/settings capture chaque body (/__puts) et merge, comme le backend :
//   c'est ce qui prouve que le sélecteur d'Apparence persiste bien la clé.
// - /api/public-config sert un welcome de type image, pour que la carte
//   « Logo » du sélecteur ait quelque chose de vrai à montrer.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8931);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

const DEFAULT_SETTINGS = () => ({
    welcome_mascot: 'boite_or',      // le coffre, défaut serveur
    assistant_name: 'Elpis',
    skin: '',
    enable_mcp: true,
    enable_editor: false,
    enable_rag: false,
    memory_enabled: false,
    hide_thinking: false,
    custom_agents: [],
    mcp_servers: [],
});
let SETTINGS = DEFAULT_SETTINGS();
let PUTS = [];

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

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/__cfg') {
            const q = new URLSearchParams(req.url.split('?')[1] || '');
            SETTINGS = DEFAULT_SETTINGS();
            // `has` et pas `get` : "" est une valeur légitime (« garder le logo »),
            // et c'est justement le cas qu'il faut pouvoir tester.
            if (q.has('mascotte')) SETTINGS.welcome_mascot = q.get('mascotte');
            if (q.get('absent') === '1') delete SETTINGS.welcome_mascot;
            // skin kiki : il impose le trio et le mot KIKI (kiki-verify.mjs)
            if (q.has('skin')) SETTINGS.skin = q.get('skin');
            if (q.get('dark') === '1') SETTINGS.dark_mode = true;
            PUTS = [];
            return json(res, { ok: true, settings: SETTINGS });
        }
        if (url === '/__puts') return json(res, { items: PUTS });
        // Registre des skins (2026-09-28) : la mascotte d'un skin (kiki) vient
        // du champ ``mascot`` de /api/skins — tous les intégrés activés ici.
        if (url === '/api/skins') return json(res, {
            skins: JSON.parse(fs.readFileSync(path.join(ROOT, 'css/skins/skins.json'), 'utf8')).skins,
            default: 'elpis',
            mascottes: JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/mascotte/mascottes.json'), 'utf8')).mascottes });
        if (url === '/api/settings' && req.method === 'GET') return json(res, SETTINGS);
        if (url === '/api/settings' && req.method === 'PUT') {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                let body = {};
                try { body = JSON.parse(raw); } catch (_) {}
                PUTS.push(body);
                SETTINGS = { ...SETTINGS, ...body };
                json(res, { ok: true });
            });
            return;
        }
        if (url === '/api/public-config') {
            return json(res, {
                app_info: { name: 'Elpis' },
                // Type image + une donnée non vide : la carte « Logo » du
                // sélecteur doit montrer CE logo, pas une icône de repli.
                welcome: { type: 'image', width: 96, height: 96,
                           image_b64: '/static/assets/mascotte/elpis/avatar-96.png' },
                features: {},
            });
        }
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        // Une conversation existante : c'est en la QUITTANT pour un nouveau chat
        // que le bloc d'accueil réapparaît, et donc que le salut se joue. Sans
        // elle, on ne peut observer que le salut du chargement initial.
        if (url === '/api/saved/chats') return json(res, { items: [{ id: 'c1', title: 'Conversation existante', updated_at: 0 }] });
        if (url === '/api/saved/chats/c1') {
            return json(res, { id: 'c1', title: 'Conversation existante', messages: [
                { role: 'user', content: 'Bonjour' },
                { role: 'assistant', content: 'Bonjour, que puis-je faire ?' },
            ] });
        }
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
}).listen(PORT, '127.0.0.1', () => console.log(`mascotte-server sur http://127.0.0.1:${PORT}`));
