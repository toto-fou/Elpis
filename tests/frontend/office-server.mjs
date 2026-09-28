// SPDX-License-Identifier: MIT
// Harnais route-mock des aperçus Office / PDF de l'éditeur (2026-09-15).
// Reproduit le contrat de shared_infra/sandbox/routes_office.py sans
// LibreOffice : prepare (POST), pdf/<clé>/<nom>, sheet/<clé>/<s>/<c>, plus
// download (Range) et read-docx pour les replis.
//
// Contrôles harnais :
//   GET /__log            requêtes observées (prepare, sheet, save, download)
//   GET /__reset          vide le journal
//   GET /__bump?path=     le fichier « change » (nouvelle clé) et la prochaine
//                         vérification check-mtimes le signale
//
// Lancement : PERF_PORT=8950 node tests/frontend/office-server.mjs
// Cf. docs/editor-office-preview-design-2026-09-15.md
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8950);
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// PDF minimal valide (PDFium le rend).
const PDF = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
    '4 0 obj<</Length 44>>stream\nBT /F1 24 Tf 40 100 Td (Apercu PDF) Tj ET\nendstream endobj\n' +
    '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');

const ZIP_HEAD = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);
const BIN = (n, head) => Buffer.concat([head || Buffer.alloc(0), Buffer.alloc(n, 0x41)]);
const binTxt = Buffer.concat([Buffer.from('entete\n'), Buffer.from([0, 1, 2, 3]), Buffer.alloc(9000, 0x42)]);

// Fichiers : contenu + comportement de prepare.
const FILES = {
    'docs/rapport.docx':  { data: BIN(2000, ZIP_HEAD), kind: 'docx' },
    'docs/slides.pptx':   { data: BIN(2000, ZIP_HEAD), kind: 'pptx' },
    'docs/classeur.xlsx': { data: BIN(2000, ZIP_HEAD), kind: 'xlsx' },
    'docs/doc.pdf':       { data: PDF, kind: 'pdf' },
    'docs/lent.docx':     { data: BIN(2000, ZIP_HEAD), kind: 'docx', delay: 1800 },
    'docs/occupe.docx':   { data: BIN(2000, ZIP_HEAD), kind: 'docx', error: [503, 'busy', 'Conversions occupées, réessayez'] },
    'docs/sans-lo.docx':  { data: BIN(2000, ZIP_HEAD), kind: 'docx', error: [503, 'soffice_missing', 'LibreOffice absent du serveur'] },
    'docs/disparu.docx':  { data: null, kind: 'docx' },
    'docs/binaire.txt':   { data: binTxt },
    'docs/script.py':     { data: Buffer.from('print("bonjour")\n') },
};
const TREE = [{ name: 'docs', path: 'docs', type: 'folder', children:
    Object.keys(FILES).map((p) => ({ name: p.split('/').pop(), path: p, type: 'file', size: 1 })) }];

const GRID = {
    chunk: 200,
    sheets: [
        { name: 'Données', hidden: false, rows: 5000, cols: 30, chunks: 25, truncated: false,
          widths: Array.from({ length: 30 }, (_, i) => (i === 0 ? 12 : 8)) },
        { name: 'Masquée', hidden: true, rows: 3, cols: 2, chunks: 1, truncated: false, widths: [8, 8] },
    ],
    truncated: false,
};

const versions = {};                  // path → n (changé par /__bump)
const staleNext = new Set();          // paths à signaler au prochain check-mtimes
const log = { prepare: [], sheet: [], save: [], download: [], pdf: [], readDocx: [] };
const keyOf = (p) => crypto.createHash('sha1').update(p + '|' + (versions[p] || 0)).digest('hex');
const mtimeOf = (p) => 1789000000 + (versions[p] || 0);
const keys = {};                      // clé → path

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const q = new URL(req.url, 'http://x').searchParams;
    const m = req.method;
    try {
        if (url === '/__log') return json(res, log);
        if (url === '/__reset') { Object.keys(log).forEach((k) => { log[k] = []; }); return json(res, { ok: true }); }
        if (url === '/__bump') {
            const p = q.get('path');
            versions[p] = (versions[p] || 0) + 1;
            staleNext.add(p);
            return json(res, { ok: true, key: keyOf(p) });
        }

        // ── Aperçus Office ─────────────────────────────────────────────
        if (url === '/api/sandbox/office/prepare' && m === 'POST') {
            let body = {};
            try { body = JSON.parse((await readBody(req)).toString('utf8')); } catch (_) {}
            const p = String(body.path || '');
            const f = FILES[p];
            log.prepare.push({ path: p, view: body.view || null, at: Date.now() });
            if (!f || !f.kind) return json(res, { detail: { code: 'unsupported', message: 'Format non pris en charge' } }, 415);
            if (f.delay) await sleep(f.delay);
            if (!f.data) return json(res, { detail: { code: 'not_found', message: 'Fichier introuvable' } }, 404);
            if (f.error) return json(res, { detail: { code: f.error[1], message: f.error[2] } }, f.error[0]);
            const key = keyOf(p);
            keys[key] = p;
            const view = f.kind === 'xlsx' ? (body.view === 'pages' ? 'pages' : 'grid') : 'pages';
            const name = p.split('/').pop().replace(/\.[^.]+$/, '');
            return json(res, {
                kind: f.kind, key, rel: p, size: f.data.length, mtime: mtimeOf(p), view,
                pages: view === 'pages' ? { url: `/api/sandbox/office/pdf/${key}/${encodeURIComponent(name + '.pdf')}`, count: 1, truncated: false } : null,
                grid: view === 'grid' ? GRID : null,
                has: { pages: view === 'pages', grid: view === 'grid' },
            });
        }
        if (url.startsWith('/api/sandbox/office/pdf/')) {
            const key = url.split('/')[5];
            log.pdf.push({ key, at: Date.now() });
            if (!keys[key]) return json(res, { detail: { code: 'expired', message: 'Aperçu expiré' } }, 404);
            res.setHeader('content-type', 'application/pdf');
            res.setHeader('x-content-type-options', 'nosniff');
            res.setHeader('x-frame-options', 'SAMEORIGIN');
            res.setHeader('cache-control', 'private, max-age=86400, immutable');
            res.setHeader('content-disposition', 'inline; filename="doc.pdf"');
            res.end(PDF);
            return;
        }
        if (url.startsWith('/api/sandbox/office/sheet/')) {
            const [, , , , , key, s, c] = url.split('/');
            const sheet = Number(s), chunk = Number(c);
            log.sheet.push({ key, sheet, chunk, at: Date.now() });
            await sleep(30);
            const meta = GRID.sheets[sheet];
            const rows = [];
            const start = chunk * GRID.chunk;
            for (let r = start; r < Math.min(meta.rows, start + GRID.chunk); r++) {
                if (sheet === 1) rows.push(['secret ' + r, String(r)]);
                else rows.push(Array.from({ length: meta.cols }, (_, ci) => (ci === 1 ? String(r * 10) : `R${r}C${ci}`)));
            }
            res.setHeader('content-type', 'application/json');
            res.setHeader('cache-control', 'private, max-age=86400, immutable');
            res.end(JSON.stringify(rows));
            return;
        }
        if (url === '/api/sandbox/read-docx') {
            const p = q.get('path');
            log.readDocx.push({ path: p });
            return json(res, { path: p, text: 'Texte extrait du document\n', size: 10, read_only: true, format: 'docx' });
        }

        // ── Sandbox / éditeur ───────────────────────────────────────────
        if (url === '/api/sandbox/tree') return json(res, { items: TREE });
        if (url === '/api/sandbox/download') {
            const p = q.get('path');
            const f = FILES[p];
            log.download.push({ path: p, range: req.headers.range || null });
            if (!f || !f.data) { res.statusCode = 404; res.end('nf'); return; }
            res.setHeader('x-mtime', String(mtimeOf(p)));
            res.setHeader('access-control-expose-headers', 'X-Mtime');
            const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
            if (range) {
                const a = Number(range[1]), b = Math.min(Number(range[2]), f.data.length - 1);
                res.statusCode = 206;
                res.setHeader('content-range', `bytes ${a}-${b}/${f.data.length}`);
                res.setHeader('content-type', 'application/octet-stream');
                res.end(f.data.subarray(a, b + 1));
                return;
            }
            res.setHeader('content-type', 'application/octet-stream');
            res.end(f.data);
            return;
        }
        if (url === '/api/sandbox/save' && m === 'POST') {
            let parsed = {};
            try { parsed = JSON.parse((await readBody(req)).toString('utf8')); } catch (_) {}
            log.save.push({ path: parsed.path, at: Date.now() });
            return json(res, { ok: true, mtime: 1789000000 });
        }
        if (url === '/api/sandbox/check-mtimes' && m === 'POST') {
            let parsed = {};
            try { parsed = JSON.parse((await readBody(req)).toString('utf8')); } catch (_) {}
            const stale = [];
            for (const item of parsed.files || []) {
                if (staleNext.has(item.path)) {
                    staleNext.delete(item.path);
                    stale.push({ path: item.path, old_mtime: item.mtime, new_mtime: mtimeOf(item.path) });
                }
            }
            return json(res, { stale });
        }
        if (url === '/api/sandbox/quota') return json(res, { quota_mb: 0, used_mb: 0 });
        if (url === '/api/sandbox/me') return json(res, { container: { running: true } });

        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.setHeader('cache-control', 'no-cache');
            res.write(': ping\n\n');
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => clearInterval(t));
            return;
        }

        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: { office_preview: true } });
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
        res.statusCode = 404; res.end('nf');
    } catch (e) {
        res.statusCode = 500; res.end(String(e));
    }
}).listen(PORT, '127.0.0.1', () => console.log(`office-server sur http://127.0.0.1:${PORT}`));
