// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER les correctifs UX sans backend :
// (1) persistance des toggles d'outils PAR CHAT (restauration au loadChat +
// PUT débouncé), (2) page Skills — header h-8, menu Importer 3 sources
// (.zip / dossier / SKILL.md seul), import-folder multipart, conflit 409 →
// confirm Remplacer → retry overwrite=1, sélection auto, corps markdown
// rendu, filtre (clear + no-results), overlay DnD, sanity mode sombre,
// (3) message de compaction rendu comme un message assistant (avatar + nom).
// Réplique @include + /static comme studio-server. Endpoints
// d'introspection : /__toolputs, /__imports, /__mdposts.
// Lancement : PERF_PORT=8907 node tests/frontend/uxfixes-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8907);
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
const TOOLPUTS = [];   // {chatId, tools} de chaque PUT /api/saved/chats/:id/tools
const IMPORTS = [];    // {paths, overwrite} de chaque POST /api/skills/import-folder
const MDPOSTS = [];    // {raw_md, filename, scope} de chaque POST /api/skills (raw_md)
const INSTALLED = new Set();   // skills importés pendant le run → conflits 409

const CATS = [
    { name: 'fs',    label: 'Fichiers', icon: 'ph-folder',   color: 'amber', visible: true },
    { name: 'shell', label: 'Shell',    icon: 'ph-terminal', color: 'slate', visible: true },
    { name: 'web',   label: 'Web',      icon: 'ph-globe',    color: 'sky',   visible: true },
];
const CHATS = {
    A: { id: 'A', title: 'Chat A', tools: ['fs', 'shell'], todos: [],
         messages: [{ role: 'user', content: 'salut' }, { role: 'assistant', content: 'bonjour !' }] },
    B: { id: 'B', title: 'Chat B', tools: [], todos: [],
         messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi.' }] },
};
const USER_SKILLS = [
    { id: 'jenkins', name: 'jenkins', description: 'Package Jenkins (déploiements)', domain: 'jenkins',
      tags: ['ci'], source: 'user', is_folder: true, files: ['scripts/deploy.sh'], parent_id: null, depth: 0,
      body_preview: '# Jenkins', body_length: 9 },
    { id: 'jenkins/deploy', name: 'deploy', description: 'Déployer sur staging', domain: 'jenkins',
      tags: [], source: 'user', is_folder: false, files: [], parent_id: 'jenkins', depth: 1,
      body_preview: '# Deploy', body_length: 8 },
];
const BASE_SKILLS = USER_SKILLS.map(s => ({ ...s }));   // snapshot pour /__reset
let lastSettingsPut = null;
let netProfileLocked = false;   // profil réseau imposé par l'admin (bascule /mock/lock-profile)
let sandboxRunning  = false;    // container actif (bascule /mock/sandbox-running) — l'état
                                // le plus vu et, jusqu'ici, le SEUL sans couverture front :
                                // c'est lui qui porte les stats live et les deux actions.

// Ajoute un skill importé à l'inventaire mock (la sélection auto du front le
// retrouve au loadAllSkills post-import).
function installMockSkill(name, isFolder) {
    INSTALLED.add(name);
    if (!USER_SKILLS.some(s => s.id === name)) {
        USER_SKILLS.push({ id: name, name, description: 'Skill importé (mock)', domain: '',
                           tags: [], source: 'user', is_folder: !!isFolder, files: [],
                           parent_id: null, depth: 0, body_preview: '# ' + name, body_length: 8 });
    }
}

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const m = req.method;
    try {
        // ── Introspection harnais ───────────────────────────────────────
        if (url === '/__toolputs') return json(res, { items: TOOLPUTS });
        if (url === '/__imports') return json(res, { items: IMPORTS });
        if (url === '/__mdposts') return json(res, { items: MDPOSTS });
        if (url === '/__reset') {
            TOOLPUTS.length = 0; IMPORTS.length = 0; MDPOSTS.length = 0; INSTALLED.clear();
            USER_SKILLS.length = 0; for (const s of BASE_SKILLS) USER_SKILLS.push({ ...s });
            return json(res, { ok: true });
        }

        // ── Chats sauvegardés ───────────────────────────────────────────
        if (url === '/api/saved/chats' && m === 'GET')
            return json(res, { items: [{ id: 'A', title: 'Chat A' }, { id: 'B', title: 'Chat B' }] });
        {
            const mm = url.match(/^\/api\/saved\/chats\/([AB])$/);
            if (mm && m === 'GET') return json(res, CHATS[mm[1]]);
        }
        {
            const mm = url.match(/^\/api\/saved\/chats\/([AB])\/tools$/);
            if (mm && m === 'PUT') {
                const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
                TOOLPUTS.push({ chatId: mm[1], tools: body.tools });
                return json(res, { ok: true });
            }
        }

        // ── Compression (/compact) ──────────────────────────────────────
        if (url.match(/^\/api\/chat\/[AB]\/compression-state$/))
            return json(res, { round: 0, max: 3, can_compress: true, reason: '', turns: 2, tokens_estimate: 1200 });
        if (url.match(/^\/api\/chat\/[AB]\/compress$/) && m === 'POST') {
            await readBody(req);
            // Réponse RETARDÉE : laisse le temps d'observer la ligne « en cours »
            setTimeout(() => json(res, { compressed: true,
                stats: { tokens_before: 1200, tokens_after: 300, tokens_saved: 900,
                         path: 'self', duration_ms: 700,
                         // Résumé produit → accordéon « Vérifier le compact »
                         summary_xml: '<context>Conversation de test compactée.</context>\n<facts>\n- clef: valeur importante\n</facts>' } }), 1200);
            return;
        }

        // ── Skills ──────────────────────────────────────────────────────
        if (url === '/api/skills' && m === 'GET') {
            const scope = (req.url.split('?')[1] || '').match(/scope=(\w+)/);
            const sc = scope ? scope[1] : 'user';
            return json(res, { skills: sc === 'user' ? USER_SKILLS : [], count: sc === 'user' ? USER_SKILLS.length : 0 });
        }
        if (url === '/api/skills/file' && m === 'GET')
            return json(res, { content: '---\nname: jenkins\n---\n\n# Jenkins\n' });
        // Import DOSSIER — contrat réel : 409 {detail, name} si le skill existe
        // déjà et que ``overwrite=1`` n'est pas passé (flux confirm → retry).
        if (url === '/api/skills/import-folder' && m === 'POST') {
            const raw = (await readBody(req)).toString('latin1');
            const paths = [];
            const re = /name="paths"\r\n\r\n([^\r]*)\r\n/g;
            let g; while ((g = re.exec(raw))) paths.push(g[1]);
            const overwrite = /[?&]overwrite=1/.test(req.url);
            const name = ((paths[0] || '').split('/')[0]) || 'skill-importe';
            if (INSTALLED.has(name) && !overwrite)
                return json(res, { detail: 'skill existe déjà : ' + name, name, names: [name], scope: 'user' }, 409);
            installMockSkill(name, true);
            IMPORTS.push({ paths, overwrite });
            return json(res, { ok: true, imported: [name], count: 1, name, scope: 'user' });
        }
        // Import d'un SKILL.md seul — le front réutilise POST /api/skills
        // {raw_md, filename} (pas de route dédiée). 409 = message du backend réel.
        if (url === '/api/skills' && m === 'POST') {
            const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
            const fm = /^---[\s\S]*?\bname:\s*([^\n]+)/.exec(body.raw_md || '');
            const stem = String(body.filename || 'skill.md').replace(/\.(md|markdown)$/i, '');
            const name = ((fm && fm[1]) || stem).trim().toLowerCase().replace(/ /g, '-');
            if (INSTALLED.has(name))
                return json(res, { detail: "un skill '" + name + "' existe déjà (user) — utilise PUT pour le mettre à jour" }, 409);
            installMockSkill(name, false);
            MDPOSTS.push({ raw_md: body.raw_md || '', filename: body.filename || '', scope: body.scope || 'user' });
            return json(res, { ok: true, name, path: '/mock/' + name, source: body.scope || 'user' });
        }

        // ── Stream de génération (stats live du composeur) ─────────────
        // ~2 s de tokens + un event kv_cache réel (la partie ctx de liveGen
        // ne s'affiche QUE sur mesure serveur) puis final.
        if (url === '/api/chat-saved-stream3' && m === 'POST') {
            const _body = await readBody(req);
            res.statusCode = 200;
            res.setHeader('content-type', 'application/x-ndjson');
            const send = (o) => { try { res.write(JSON.stringify(o) + '\n'); } catch (_) {} };
            let closed = false; req.on('close', () => { closed = true; });
            const steps = [];
            // ⚠ Le body porte TOUT l'historique : tester le DERNIER message
            // user seulement, sinon le tour de RÉPONSE au questionnaire
            // rejouerait le scénario (l'ancien 'askuser-demo' est dans l'histo).
            let _lastUserTxt = '';
            try {
                const _msgs = (JSON.parse(String(_body || '{}')).messages) || [];
                const _lu = [..._msgs].reverse().find((x) => x && x.role === 'user');
                _lastUserTxt = String((_lu && _lu.content) || '');
            } catch (_) { /* body non-JSON : scénario gen */ }
            if (/askuser-demo/.test(_lastUserTxt)) {
                // Scénario ask_user (outil restauré 2026-07-19) : le panneau
                // questionnaire ne doit s'ouvrir qu'au 'final' (fin du tour).
                steps.push({ ms: 80, ev: { type: 'content_token', text: 'Deux questions pour cadrer. ' } });
                steps.push({ ms: 80, ev: { type: 'tool_call', name: 'ask_user', args: { questions: [
                    { q: 'Dans quelle situation ?', options: ['Déploiement', 'Diagnostic'], multi: false },
                    { q: 'Commande exacte ?', options: [] },
                ] } } });
                steps.push({ ms: 60, ev: { type: 'tool_result', name: 'ask_user', result: '{"ok":true,"displayed":true,"count":2}' } });
                steps.push({ ms: 60, ev: { type: 'final', assistant: 'Réponds au questionnaire ci-dessous 👇', metrics: { model: 'm1' } } });
            } else {
            for (let i = 0; i < 6; i++) steps.push({ ms: 150, ev: { type: 'content_token', text: 'mot' + i + ' ' } });
            steps.push({ ms: 100, ev: { type: 'kv_cache', used: 1800, total: 8192 } });
            for (let i = 6; i < 12; i++) steps.push({ ms: 150, ev: { type: 'content_token', text: 'mot' + i + ' ' } });
            steps.push({ ms: 60, ev: { type: 'final', assistant: 'mot0 mot1 mot2 mot3 mot4 mot5 mot6 mot7 mot8 mot9 mot10 mot11', metrics: { model: 'm1' } } });
            }
            let i = 0;
            (function tick() {
                if (closed) return;
                if (i >= steps.length) { res.end(); return; }
                const s = steps[i++];
                setTimeout(() => { if (closed) return; send(s.ev); tick(); }, s.ms);
            })();
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

        // ── Boot (logged-in, MCP activé) ────────────────────────────────
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        // opencode : familles d'outils publiées (une entrée MCP chacune) et
        // capture du PUT de préférences (bascule « Outils » de la modale).
        if (url === '/api/cli/opencode/families') return json(res, { families: [
            { name: 'git', label: 'Git', server: 'elpis-git', enabled: true },
            { name: 'browser', label: 'Navigateur', server: 'elpis-browser', enabled: true },
            { name: 'desktop', label: "Contrôle d'écran", server: 'elpis-desktop', enabled: true },
        ] });
        if (url === '/mock/last-settings-put') return json(res, lastSettingsPut || {});
        if (url === '/api/settings' && req.method === 'PUT') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                try { lastSettingsPut = JSON.parse(body || '{}'); } catch (_) { lastSettingsPut = {}; }
                json(res, { ok: true });
            });
            return;
        }
        if (url === '/api/settings') return json(res, {
            enable_mcp: true, enable_editor: false, enable_rag: false,
            assistant_name: 'Elpis', assistant_icon: 'ph-robot',
            mcp_servers: [], active_mcp_ids: [],
            sandbox_path_display: '/home/alice/sandbox → /work',
        });
        // ── Sandbox (onglet Paramètres) : container existant ARRÊTÉ →
        //    la régression « double bouton Démarrer » est observable. ──────
        // /mock/lock-profile bascule l'imposition admin du profil réseau :
        // la vérif rejoue le même écran dans les deux états.
        if (url === '/mock/lock-profile') { netProfileLocked = !netProfileLocked; return json(res, { locked: netProfileLocked }); }
        if (url === '/mock/sandbox-running') { sandboxRunning = !sandboxRunning; return json(res, { running: sandboxRunning }); }
        if (url === '/api/sandbox/me') return json(res, {
            user_mode: 'docker', effective_mode: 'docker', force_admin: false,
            daemon_ok: true, image: 'elpis/sandbox:1.5.0',
            limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 },
            container: { exists: true, running: sandboxRunning, container_name: 'elpis-sb-alice' },
            stats: sandboxRunning ? { cpu: '2,4 %', mem: '186 Mo', pids: '12' } : null,
            image_status: { status: 'loaded' },
            network_profile_id: 'isolated',
            network_profiles: [
                { id: 'isolated', name: 'Isolé', mode: 'none', ips: [], description: 'Aucun accès réseau sortant.' },
                { id: 'open', name: 'Ouvert', mode: 'bridge', ips: [], description: '' },
                { id: 'lan', name: 'LAN', mode: 'allowlist_ip', ips: ['10.20.0.0/24'], description: '' },
            ],
            network_profile_locked: netProfileLocked,
        });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok', props: { n_ctx: 8192 } });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: CATS });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url.startsWith('/api/')) return json(res, {});

        // ── Statique ────────────────────────────────────────────────────
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
}).listen(PORT, '127.0.0.1', () => console.log(`uxfixes-server sur http://127.0.0.1:${PORT}`));
