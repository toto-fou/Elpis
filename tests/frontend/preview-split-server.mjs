// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER l'aperçu web de l'éditeur (2026-08-01) :
//   1. une page dont le CSS et le JS sont des fichiers EXTERNES référencés en
//      ABSOLU-RACINE (`/style.css`, `/app.js`) doit s'afficher stylée ET
//      interactive dans l'aperçu ;
//   2. la vue scindée « code | rendu » (splitMode='preview') ;
//   3. le mode Live (enregistre le buffer puis recharge l'iframe).
//
// Le mock reproduit le contrat serveur de sandbox_files.py :
//   - GET /api/sandbox/serve/<chemin>  → le fichier, no-cache
//   - repli 404 : toute URL non servie dont le `Referer` pointe sous
//     /api/sandbox/serve/ est résolue depuis le dossier du document puis en
//     remontant vers la racine (try_serve_preview_asset).
//
// Lancement : PERF_PORT=8912 node tests/frontend/preview-split-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8912);
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

// ── Sandbox en mémoire ───────────────────────────────────────────────────
// La page référence son CSS et son JS en ABSOLU-RACINE : c'est le cas qui
// cassait (résolution contre l'origine de l'app, pas contre le préfixe
// /api/sandbox/serve/).
const SANDBOX = {
    'demo/page.html':
        '<!doctype html><html><head><meta charset="utf-8">\n' +
        '<link rel="stylesheet" href="/style.css">\n' +
        '</head><body>\n' +
        '<h1 id="titre">statique</h1>\n' +
        '<button id="btn">cliquer</button>\n' +
        '<script src="/app.js"></script>\n' +
        '</body></html>\n',
    'demo/style.css': 'body{background:rgb(0, 128, 0)}\n',
    'demo/app.js':
        'document.getElementById("titre").textContent = "JS ACTIF";\n' +
        'document.getElementById("btn").addEventListener("click", () => {\n' +
        '  document.getElementById("titre").textContent = "CLIQUE";\n' +
        '});\n',
};
const TREE = [
    { name: 'demo', path: 'demo', type: 'folder', children: [
        { name: 'page.html', path: 'demo/page.html', type: 'file' },
        { name: 'style.css', path: 'demo/style.css', type: 'file' },
        { name: 'app.js',    path: 'demo/app.js',    type: 'file' },
    ] },
];

const saveLog = [];        // POST /api/sandbox/save observés (mode Live)

// Miroir de preview_rewrite.py (audit 2026-09-22, H1) : le document a une
// origine opaque, le navigateur n'envoie plus le chemin du référent ; les refs
// absolues-racine sont réécrites vers le résolveur ~r/d<dossier>/<chemin>.
function resolverBase(docDir) {
    return `/api/sandbox/pv/${PREVIEW_TOK}/~r/d${encodeURIComponent(docDir)}/`;
}
function rewriteCss(t, b) {
    return t.replace(/(url\(\s*)(["']?)\/(?![\/\\])/gi, `$1$2${b}`)
            .replace(/(@import\s+)(["'])\/(?![\/\\])/gi, `$1$2${b}`);
}
function rewriteHtml(t, b) {
    t = t.replace(/(\s(?:href|src|action|poster|data|formaction)\s*=\s*)(["']?)\/(?![\/\\])/gi, `$1$2${b}`);
    t = rewriteCss(t, b);
    const shim = `<script>(function(b){function f(u){return(typeof u==='string'&&u.charAt(0)==='/'&&u.charAt(1)!=='/')?b+u.slice(1):u}var F=window.fetch;if(F)window.fetch=function(u,o){return F.call(this,f(u),o)};})(${JSON.stringify(b)});</script>`;
    const m = /<head\b[^>]*>/i.exec(t);
    return m ? t.slice(0, m.index + m[0].length) + shim + t.slice(m.index + m[0].length) : shim + t;
}

function serveSandboxFile(res, rel) {
    if (!(rel in SANDBOX)) return false;
    const ext = path.extname(rel);
    res.setHeader('content-type', MIME[ext] || 'text/plain');
    res.setHeader('cache-control', 'no-cache, must-revalidate');
    res.setHeader('x-content-type-options', 'nosniff');
    if (/\.(html?|svg)$/.test(rel)) {
        res.setHeader('content-security-policy', 'sandbox allow-scripts allow-forms allow-popups allow-modals');
    }
    const docDir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    let body = SANDBOX[rel];
    if (/\.html?$/.test(ext)) body = rewriteHtml(body, resolverBase(docDir));
    else if (ext === '.css') body = rewriteCss(body, resolverBase(docDir));
    res.end(body);
    return true;
}

// Miroir de _resolve_from : dossier du document d'abord, puis remontée.
function serveResolved(res, rest) {
    const slash = rest.indexOf('/');
    if (!rest.startsWith('d') || slash === -1) return false;
    const docDir = decodeURIComponent(rest.slice(1, slash));
    const wanted = decodeURIComponent(rest.slice(slash + 1));
    const parts = docDir.split('/').filter((p) => p && p !== '.');
    for (let d = parts.length; d >= 0; d--) {
        if (serveSandboxFile(res, [...parts.slice(0, d), wanted].join('/'))) return true;
    }
    return false;
}

const PREVIEW_TOK = '1-9999999999-harnais';
// Aperçu à jeton (audit 2026-09-22, H1) : /api/sandbox/pv/<jeton>/… et
// /api/sandbox/pvs/<jeton>/<port>/… ramenés aux formes historiques du mock.
function normPreviewUrl(u) {
    return u.replace(/^\/api\/sandbox\/pv\/[^/]+\//, '/api/sandbox/serve/')
            .replace(/^\/api\/sandbox\/pvs\/[^/]+\//, '/api/sandbox/preview/');
}

http.createServer(async (req, res) => {
    const url = normPreviewUrl(req.url.split('?')[0]);
    const m = req.method;
    try {
        if (url === '/api/sandbox/preview-token') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ token: PREVIEW_TOK, expires: 9999999999 })); return;
        }
        // ── Contrôle harnais ────────────────────────────────────────────
        if (url === '/__saves') return json(res, { items: saveLog });

        // ── Aperçu : serveur qui tourne DANS la sandbox ─────────────────
        // Miroir du proxy sandbox_preview_proxy : /api/sandbox/preview/<port>/<chemin>.
        // La page renvoyée affiche ce que le proxy a reçu, pour que le verify
        // contrôle le port ET le chemin+query dérivés du champ d'adresse.
        if (url.startsWith('/api/sandbox/preview/')) {
            const rest  = url.slice('/api/sandbox/preview/'.length);
            const slash = rest.indexOf('/');
            const port  = slash === -1 ? rest : rest.slice(0, slash);
            const p     = slash === -1 ? '' : rest.slice(slash);
            const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
            res.setHeader('content-type', 'text/html');
            res.setHeader('cache-control', 'no-store');
            res.end('<!doctype html><meta charset="utf-8">' +
                    `<p id="port">${port}</p>` +
                    `<p id="chemin">${p + query}</p>`);
            return;
        }

        // ── Aperçu : fichier de la sandbox ──────────────────────────────
        const _rv = `/api/sandbox/serve/~r/`;
        if (url.startsWith(_rv)) {
            if (serveResolved(res, url.slice(_rv.length))) return;
            res.statusCode = 404; res.end('nf'); return;
        }
        if (url.startsWith('/api/sandbox/serve/')) {
            const rel = decodeURIComponent(url.slice('/api/sandbox/serve/'.length));
            if (serveSandboxFile(res, rel)) return;
            res.statusCode = 404; res.end('nf'); return;
        }

        // ── Sandbox / éditeur ───────────────────────────────────────────
        if (url === '/api/sandbox/tree') return json(res, { items: TREE });
        if (url === '/api/sandbox/download') {
            const p = decodeURIComponent((req.url.split('path=')[1] || ''));
            res.setHeader('content-type', 'text/plain');
            res.end(SANDBOX[p] !== undefined ? SANDBOX[p] : `// ${p}\n`);
            return;
        }
        if (url === '/api/sandbox/save' && m === 'POST') {
            const body = (await readBody(req)).toString('utf8');
            let parsed = {};
            try { parsed = JSON.parse(body); } catch (_) {}
            if (parsed.path !== undefined && parsed.content !== undefined) {
                SANDBOX[parsed.path] = parsed.content;   // le rendu doit refléter la frappe
            }
            saveLog.push({ path: parsed.path, at: Date.now() });
            return json(res, { ok: true });
        }
        if (url === '/api/sandbox/quota') return json(res, { quota_mb: 0, used_mb: 0 });
        if (url === '/api/sandbox/me') return json(res, { container: { running: true } });
        if (url === '/api/sandbox/check-mtimes' && m === 'POST') { await readBody(req); return json(res, { items: [] }); }

        // ── SSE système ─────────────────────────────────────────────────
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.setHeader('cache-control', 'no-cache');
            res.write(': ping\n\n');
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => clearInterval(t));
            return;
        }

        // ── Boot (logged-in, éditeur + aperçu activés) ──────────────────
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/settings') return json(res, {
            enable_editor: true, enable_preview: true, enable_mcp: false, enable_rag: false,
            assistant_name: 'Elpis', assistant_icon: 'ph-robot',
            editor_dark_mode: true, editor_auto_save: 'off',
            editor_persist_tabs: false,
            mcp_servers: [], active_mcp_ids: [],
        });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/saved/chats') return json(res, { items: [] });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url.startsWith('/api/')) return json(res, {});

        // ── Statique (dont vendor/monaco) ───────────────────────────────
        if (url === '/' || url === '/index.html') {
            res.setHeader('content-type', 'text/html');
            res.end(applyIncludes(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'))); return;
        }
        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const p = path.join(ROOT, rel);
        if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
        if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
            res.end(fs.readFileSync(p));
            return;
        }
        // ── Repli aperçu : refs ABSOLUES-RACINE d'une page en aperçu ─────
        res.statusCode = 404; res.end('nf');
    } catch (e) {
        res.statusCode = 404; res.end('nf');
    }
}).listen(PORT, '127.0.0.1', () => console.log(`preview-split-server sur http://127.0.0.1:${PORT}`));
