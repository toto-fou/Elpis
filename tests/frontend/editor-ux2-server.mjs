// SPDX-License-Identifier: MIT
// Harnais route-mock de la passe UX de l'éditeur (2026-09-19), sans backend.
// Un vrai petit système de fichiers EN MÉMOIRE avec mtimes, pour prouver les
// comportements de protection (précondition de /save, conflit disque,
// rechargement silencieux), plus Git, recherche/remplacement, copie, format.
//
// Contrôle :
//   GET  /__reset                         → état initial
//   GET  /__fs                            → { files: {path: content}, mtimes, log }
//   GET  /__touch?path=P&content=C        → modification « externe » (mtime +)
//   GET  /__persist?v=1|0                 → editor_persist_tabs du mock
// Lancement : PERF_PORT=8951 node tests/frontend/editor-ux2-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8951);
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

// PNG 2×2 rouge (visionneuse d'image, zoom).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==', 'base64');

let FILES, MTIMES, LOG, CLOCK, PERSIST;
function reset() {
    FILES = {
        'src/app.py': 'import os\nx = 1\nprint(x)\n',
        'src/util.py': 'def f():\n    return 42\n',
        'src/deep/inner/b.py': 'b = 2\n',
        'docs/readme.md': '# Titre\n\nTexte **gras**.\n',
        'docs/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="red"/></svg>\n',
        'img/photo.png': '__PNG__',
        'a/index.js': 'export const a = 1;\n',
        'b/index.js': 'export const b = 2;\n',
        'notes.md': 'foo bar\nFoo\n',
        'fichier1.js': '// un\n',
        'fichier2.js': '// deux\n',
        'fichier3.js': '// trois\n',
        // Onglets à la largeur du nom (2026-09-20) : 36 caractères (lisible en
        // entier) et 69 caractères (plafond → coupure au milieu).
        'src/configuration_serveur_principal.yaml': 'port: 8080\n',
        'src/rapport_de_verification_des_onglets_avec_un_nom_vraiment_tres_long.md': '# Rapport\n',
    };
    CLOCK = 1700000000.125;
    MTIMES = {};
    Object.keys(FILES).forEach((p) => { MTIMES[p] = CLOCK; });
    LOG = [];
    PERSIST = false;
}
reset();
function bump(p) { CLOCK += 7.5; MTIMES[p] = CLOCK; return CLOCK; }

function tree() {
    const root = [];
    const dirs = new Map();
    const ensureDir = (dpath) => {
        if (!dpath) return root;
        if (dirs.has(dpath)) return dirs.get(dpath).children;
        const parent = ensureDir(dpath.includes('/') ? dpath.slice(0, dpath.lastIndexOf('/')) : '');
        const node = { name: dpath.split('/').pop(), path: dpath, type: 'folder', children: [] };
        parent.push(node);
        dirs.set(dpath, node);
        return node.children;
    };
    Object.keys(FILES).sort().forEach((p) => {
        const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
        ensureDir(dir).push({ name: p.split('/').pop(), path: p, type: 'file' });
    });
    const sortRec = (nodes) => {
        nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : (a.type === 'folder' ? -1 : 1)));
        nodes.forEach((n) => n.children && sortRec(n.children));
    };
    sortRec(root);
    return root;
}

function grep(body) {
    const flags = body.case_sensitive ? 'g' : 'gi';
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let re;
    try { re = new RegExp(body.regex ? body.query : esc(body.query), flags); }
    catch (e) { return null; }
    const glob = body.glob ? new RegExp('^' + body.glob.split('*').map(esc).join('.*') + '$') : null;
    const out = [];
    for (const p of Object.keys(FILES).sort()) {
        if (FILES[p] === '__PNG__') continue;
        if (glob && !glob.test(p.split('/').pop())) continue;
        FILES[p].split('\n').forEach((line, i) => {
            re.lastIndex = 0;
            const m = re.exec(line);
            if (m) out.push({ path: p, line: i + 1, col: m.index + 1, snippet: line, match_start: m.index, match_end: m.index + m[0].length });
        });
    }
    return out;
}

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const q = new URL(req.url, 'http://x').searchParams;
    const m = req.method;
    try {
        // ── Contrôle ─────────────────────────────────────────────────────
        if (url === '/__reset') { reset(); return json(res, { ok: true }); }
        if (url === '/__fs') return json(res, { files: FILES, mtimes: MTIMES, log: LOG });
        if (url === '/__persist') { PERSIST = q.get('v') === '1'; return json(res, { ok: true }); }
        if (url === '/__touch') {
            const p = q.get('path');
            FILES[p] = q.get('content') || '';
            bump(p);
            return json(res, { ok: true, mtime: MTIMES[p] });
        }

        // ── Fichiers ─────────────────────────────────────────────────────
        if (url === '/api/sandbox/tree') return json(res, { items: tree() });
        if (url === '/api/sandbox/download') {
            const p = q.get('path');
            if (!(p in FILES)) { res.statusCode = 404; return res.end('nf'); }
            res.setHeader('X-Mtime', String(MTIMES[p]));
            if (FILES[p] === '__PNG__') { res.setHeader('content-type', 'image/png'); return res.end(PNG); }
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            return res.end(FILES[p]);
        }
        if (url === '/api/sandbox/save' && m === 'POST') {
            const b = JSON.parse((await readBody(req)).toString() || '{}');
            LOG.push({ op: 'save', path: b.path, expected: b.expected_mtime, if_absent: !!b.if_absent });
            if (b.if_absent && b.path in FILES) return json(res, { detail: { code: 'exists', message: 'Un fichier porte déjà ce nom' } }, 409);
            if (typeof b.expected_mtime === 'number') {
                if (!(b.path in FILES)) return json(res, { detail: { code: 'conflict', missing: true, mtime: null, message: 'supprimé' } }, 412);
                if (Math.abs(MTIMES[b.path] - b.expected_mtime) > 0.0005) {
                    return json(res, { detail: { code: 'conflict', missing: false, mtime: MTIMES[b.path], message: 'changé' } }, 412);
                }
            }
            FILES[b.path] = b.content;
            return json(res, { ok: true, size: b.content.length, mtime: bump(b.path) });
        }
        if (url === '/api/sandbox/check-mtimes' && m === 'POST') {
            const b = JSON.parse((await readBody(req)).toString() || '{}');
            const stale = [];
            for (const it of (b.files || [])) {
                if (!(it.path in FILES)) stale.push({ path: it.path, missing: true });
                else if (Math.abs(MTIMES[it.path] - it.mtime) > 1.0) stale.push({ path: it.path, new_mtime: MTIMES[it.path] });
            }
            return json(res, { stale });
        }
        if (url === '/api/sandbox/copy' && m === 'POST') {
            const b = JSON.parse((await readBody(req)).toString() || '{}');
            LOG.push({ op: 'copy', src: b.src, dst: b.dst });
            if (b.dst in FILES) return json(res, { detail: 'Un élément porte déjà ce nom à cet endroit' }, 409);
            FILES[b.dst] = FILES[b.src];
            bump(b.dst);
            return json(res, { ok: true, path: b.dst });
        }
        if (url === '/api/sandbox/rename' && m === 'POST') {
            const b = JSON.parse((await readBody(req)).toString() || '{}');
            LOG.push({ op: 'rename', old: b.old_path, new: b.new_path });
            const moved = Object.keys(FILES).filter((p) => p === b.old_path || p.startsWith(b.old_path + '/'));
            for (const p of moved) {
                const np = b.new_path + p.slice(b.old_path.length);
                if (np in FILES) return json(res, { detail: 'Un élément porte déjà ce nom à cet endroit' }, 409);
            }
            for (const p of moved) {
                const np = b.new_path + p.slice(b.old_path.length);
                FILES[np] = FILES[p]; MTIMES[np] = MTIMES[p];
                delete FILES[p]; delete MTIMES[p];
            }
            return json(res, { ok: true });
        }
        if (url === '/api/sandbox/delete' && m === 'DELETE') {
            const p = q.get('path');
            LOG.push({ op: 'delete', path: p });
            Object.keys(FILES).filter((k) => k === p || k.startsWith(p + '/')).forEach((k) => { delete FILES[k]; delete MTIMES[k]; });
            return json(res, { ok: true });
        }
        if (url === '/api/sandbox/grep' && m === 'POST') {
            const b = JSON.parse((await readBody(req)).toString() || '{}');
            const matches = grep(b);
            if (!matches) return json(res, { detail: 'Regex invalide' }, 400);
            return json(res, { matches, total_files_scanned: Object.keys(FILES).length, truncated: false, elapsed_ms: 1 });
        }
        if (url === '/api/sandbox/replace' && m === 'POST') {
            const b = JSON.parse((await readBody(req)).toString() || '{}');
            LOG.push({ op: 'replace', dry: !!b.dry_run, paths: b.paths || null });
            const matches = grep(b) || [];
            const byFile = {};
            matches.forEach((mm) => { (byFile[mm.path] = byFile[mm.path] || []).push(mm); });
            const flags = b.case_sensitive ? 'g' : 'gi';
            const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp(b.regex ? b.query : esc(b.query), flags);
            const files = [];
            for (const p of Object.keys(byFile)) {
                if (!b.dry_run && !(b.paths || []).includes(p)) continue;
                const lines = FILES[p].split('\n');
                let count = 0;
                const samples = [];
                const out = lines.map((line, i) => {
                    const n = (line.match(re) || []).length;
                    if (!n) return line;
                    count += n;
                    const after = line.replace(re, b.replacement);
                    if (samples.length < 5) samples.push({ line: i + 1, before: line, after });
                    return after;
                });
                if (!b.dry_run) { FILES[p] = out.join('\n'); bump(p); }
                files.push(b.dry_run ? { path: p, count, samples } : { path: p, count, mtime: MTIMES[p] });
            }
            return json(res, { files, total: files.reduce((n, f) => n + f.count, 0), truncated: false });
        }
        if (url === '/api/sandbox/format' && m === 'POST') {
            const b = JSON.parse((await readBody(req)).toString() || '{}');
            return json(res, { content: b.content.replace(/(\w)=(\w)/g, '$1 = $2') });
        }
        if (url === '/api/sandbox/lint' && m === 'POST') {
            const b = JSON.parse((await readBody(req)).toString() || '{}');
            const diags = [];
            (b.content || '').split('\n').forEach((line, i) => {
                if (/import os/.test(line)) diags.push({ row: i + 1, col: 1, end_row: i + 1, end_col: 9, code: 'F401', message: '`os` imported but unused', severity: 8 });
            });
            return json(res, { diagnostics: diags });
        }
        if (url === '/api/sandbox/download-multi' && m === 'POST') {
            await readBody(req);
            res.setHeader('content-type', 'application/zip');
            return res.end(Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary'));
        }
        if (url === '/api/sandbox/quota') return json(res, { quota_mb: 0, used_mb: 0 });
        if (url === '/api/sandbox/me') return json(res, { container: { running: true } });
        if (url === '/api/sandbox/snapshots') return json(res, { items: [], max: 10 });

        // ── Git : dépôt racine, src/app.py modifié, notes.md non suivi ──
        if (url === '/api/sandbox/git/repos') return json(res, { repos: [{ path: '.', name: 'sandbox', branch: 'main' }] });
        if (url === '/api/sandbox/git/status') return json(res, {
            is_repo: true, repo: '.', branch: 'main', ahead: 0, behind: 0, remote_url: '',
            staged: [], modified: [{ path: 'src/app.py', status: 'M', add: 1, del: 1 }],
            untracked: [{ path: 'notes.md' }], conflicted: [],
        });
        if (url === '/api/sandbox/git/branches') return json(res, { current: 'main', local: ['main'], remote: [] });
        if (url === '/api/sandbox/git/tree') return json(res, { items: [] });
        if (url === '/api/sandbox/git/show-file') {
            if (q.get('path') === 'src/app.py') return json(res, { content: 'import os\nx = 0\nprint(x)\n' });
            return json(res, { detail: 'not found' }, 404);
        }

        // ── LLM (actions IA) ─────────────────────────────────────────────
        if (url === '/api/llm/infill' && m === 'POST') {
            await readBody(req);
            return json(res, { ok: true, content: 'y = 99' });
        }

        // ── SSE système ──────────────────────────────────────────────────
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.write(': ping\n\n');
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => clearInterval(t));
            return;
        }

        // ── Boot (connecté, éditeur activé) ──────────────────────────────
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/settings') return json(res, {
            enable_editor: true, enable_preview: true, enable_mcp: false, enable_rag: false,
            assistant_name: 'Elpis', assistant_icon: 'ph-robot',
            editor_dark_mode: true, editor_auto_save: 'off',
            editor_persist_tabs: PERSIST,
            mcp_servers: [], active_mcp_ids: [],
        });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/saved/chats') return json(res, { items: [{ id: 'c1', title: 'Chemins', updated_at: 0 }] });
        if (url === '/api/saved/chats/c1') return json(res, {
            id: 'c1', title: 'Chemins',
            messages: [
                { role: 'user', content: 'Où est la variable ?' },
                { role: 'assistant', content: 'Elle est dans `src/util.py:2` ; voir aussi `os.path`.' },
            ],
        });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url.startsWith('/api/')) return json(res, {});

        // ── Statique ─────────────────────────────────────────────────────
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
}).listen(PORT, '127.0.0.1', () => console.log(`editor-ux2-server sur http://127.0.0.1:${PORT}`));
