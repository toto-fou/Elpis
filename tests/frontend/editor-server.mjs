// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER les améliorations UX de l'ÉDITEUR
// (2026-07-13) sans backend : « Copier le chemin » au clic droit de l'arbre,
// persistance des onglets opt-in (editor_persist_tabs, défaut OFF), point
// « non sauvegardé » par onglet, badge « +X » au débordement de la barre.
// Monaco est servi en statique depuis frontend/vendor/monaco (offline).
// Contrôle : GET /__persist?v=1|0 bascule editor_persist_tabs du mock.
// Lancement : PERF_PORT=8908 node tests/frontend/editor-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8908);
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

let PERSIST_TABS = false;   // basculé par /__persist

// ── Import sandbox (2026-09-16) : annulation + pré-contrôle ─────────────────
// ``/__upload?precheck=fits|limit|remaining&precheckDelay=ms&batchDelay=ms
//   &chunkDelay=ms&quota=0|1`` configure le mock ET vide le journal ;
// ``/__uploadlog`` rend les requêtes d'import reçues.
// Les délais s'appliquent APRÈS réception du corps : l'XHR reste en vol,
// donc interruptible par la croix.
let UP = { precheck: 'fits', precheckDelay: 0, batchDelay: 0, chunkDelay: 0, quota: false };
let UPLOG = [];
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// Arbre : 1 dossier + 8 fichiers racine (assez pour déborder la barre).
const FILES = Array.from({ length: 8 }, (_, i) => ({
    name: `fichier${i + 1}.js`, path: `fichier${i + 1}.js`, type: 'file',
}));
const TREE = [
    { name: 'src', path: 'src', type: 'folder', children: [
        { name: 'util.py', path: 'src/util.py', type: 'file' },
    ] },
    ...FILES,
];

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
        if (url === '/__persist') {
            PERSIST_TABS = /v=1/.test(req.url);
            return json(res, { ok: true, persist: PERSIST_TABS });
        }
        if (url === '/__upload') {
            const q = new URL(req.url, 'http://x').searchParams;
            UP = {
                precheck: q.get('precheck') || 'fits',
                precheckDelay: Number(q.get('precheckDelay') || 0),
                batchDelay: Number(q.get('batchDelay') || 0),
                chunkDelay: Number(q.get('chunkDelay') || 0),
                quota: q.get('quota') === '1',
            };
            UPLOG = [];
            return json(res, { ok: true, up: UP });
        }
        if (url === '/__uploadlog') return json(res, { log: UPLOG });

        // ── Import sandbox ──────────────────────────────────────────────
        if (url === '/api/sandbox/upload-precheck' && m === 'POST') {
            const body = JSON.parse((await readBody(req)).toString() || '{}');
            UPLOG.push({ m, url, files: (body.files || []).length, total: body.total_bytes });
            if (UP.precheckDelay) await sleepMs(UP.precheckDelay);
            const needed = body.total_bytes || 0;
            if (UP.precheck === 'limit') return json(res, { fits: false, reason: 'import_limit', needed_bytes: needed, allowed_bytes: 3 * 1024 ** 3, max_pct: 60 });
            if (UP.precheck === 'remaining') return json(res, { fits: false, reason: 'remaining', needed_bytes: needed, allowed_bytes: 512 * 1024 ** 2, max_pct: 60 });
            return json(res, { fits: true, reason: '', needed_bytes: needed, allowed_bytes: 10 * 1024 ** 3, max_pct: 60 });
        }
        if (url === '/api/sandbox/upload' && m === 'POST') {
            const raw = (await readBody(req)).toString('latin1');
            const n = (raw.match(/name="paths"/g) || []).length;
            const entry = { m, url, n, closedEarly: false };
            UPLOG.push(entry);
            // ``res`` et non ``req`` : le 'close' de la requête part dès la fin
            // de lecture du corps ; celui de la réponse, à la coupure du socket.
            res.on('close', () => { if (!res.writableEnded) entry.closedEarly = true; });
            if (UP.batchDelay) await sleepMs(UP.batchDelay);
            if (res.destroyed) return;
            if (UP.quota) return json(res, { ok: true, saved: 0, skipped: Array.from({ length: n }, (_, i) => ({ path: 'f' + i, reason: 'quota_exceeded' })), mtimes: {} });
            return json(res, { ok: true, saved: n, skipped: [], mtimes: {} });
        }
        if (url === '/api/sandbox/upload-chunk') {
            const q = new URL(req.url, 'http://x').searchParams;
            if (m === 'DELETE') {
                UPLOG.push({ m, url, path: q.get('path'), upload_id: q.get('upload_id') });
                return json(res, { ok: true, removed: true });
            }
            await readBody(req);
            const idx = Number(q.get('index')), tot = Number(q.get('total'));
            UPLOG.push({ m, url, index: idx, total: tot, upload_id: q.get('upload_id') });
            if (UP.chunkDelay) await sleepMs(UP.chunkDelay);
            if (res.destroyed) return;
            return json(res, { ok: true, done: idx >= tot - 1 });
        }

        // ── Sandbox / éditeur ───────────────────────────────────────────
        if (url === '/api/sandbox/tree') return json(res, { items: TREE });
        if (url === '/api/sandbox/download') {
            const p = decodeURIComponent((req.url.split('path=')[1] || ''));
            res.setHeader('content-type', 'text/plain');
            res.end(`// contenu de ${p}\nconsole.log(${JSON.stringify(p)});\n`);
            return;
        }
        if (url === '/api/sandbox/save' && m === 'POST') { await readBody(req); return json(res, { ok: true }); }
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

        // ── Boot (logged-in, éditeur activé) ────────────────────────────
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/settings') return json(res, {
            enable_editor: true, enable_preview: true, enable_mcp: false, enable_rag: false,
            assistant_name: 'Elpis', assistant_icon: 'ph-robot',
            editor_dark_mode: true, editor_auto_save: 'off',
            editor_persist_tabs: PERSIST_TABS,
            mcp_servers: [], active_mcp_ids: [],
        });
        // Aperçu localhost (proxy vers un serveur du conteneur) — mock du
        // vrai backend /api/sandbox/preview/{port}/{path} (user_sandbox.py).
        if (url.startsWith('/api/sandbox/preview/8080/')) {
            res.setHeader('content-type', 'text/html');
            res.setHeader('content-security-policy', 'sandbox allow-scripts allow-forms');
            res.end('<h1 id="srv">serveur sandbox OK</h1>'); return;
        }
        if (url.startsWith('/api/sandbox/preview/')) {
            res.statusCode = 502; res.setHeader('content-type', 'text/html');
            res.end('<div>Aucun serveur sur ce port</div>'); return;
        }
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
        res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
        res.end(fs.readFileSync(p));
    } catch (e) { res.statusCode = 404; res.end('nf'); }
}).listen(PORT, '127.0.0.1', () => console.log(`editor-server sur http://127.0.0.1:${PORT}`));
