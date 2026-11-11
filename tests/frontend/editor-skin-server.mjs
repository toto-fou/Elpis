// SPDX-License-Identifier: MIT
// Harnais route-mock de l'éditeur lié au skin, sans backend :
// fichiers en mémoire, historique de la session avec origines (Elpis, vous, commande), dépôt Git,
// points de restauration, réglages du compte modifiables (PUT /api/settings), skins intégrés du dépôt,
// un skin importé sans editeur.css et un avec.
//
// Contrôle :
//   GET /__reset                          → état initial
//   GET /__reglages?editor_ui=classic&skin=elpis&dark_mode=1&editor_dark_mode=0
//   GET /__ecrire?path=P&source=assistant&content=C   → écriture « externe » versionnée
// Lancement : PORT_LAYOUTS=8952 node tests/frontend/editor-skin-server.mjs
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';

import * as bac from './aides-bac.mjs';
import { appliquerEntrees } from './lib/entrees.mjs';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PORT_LAYOUTS || 8952);
const HOTE = process.env.HOTE_LAYOUTS || '127.0.0.1';
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.json': 'application/json' };

const EXPORT_AVANT = `// src/export.ts — export CSV des lignes de facturation
import { lignesDuCompte } from "./depot";

export function filtrerPeriode(lignes, debut, fin) {
  return lignes.filter((l) =>
    l.date >= debut &&
    l.date < fin
  );
}

export function versCsv(lignes) {
  const tete = "date;client;montant";
  return [tete, ...lignes.map((l) => [l.date.toISOString(), l.client, l.montant].join(";"))].join("\\n");
}
`;
const EXPORT_APRES = `// src/export.ts — export CSV des lignes de facturation
import { lignesDuCompte } from "./depot";

export function filtrerPeriode(lignes, debut, fin) {
  return lignes.filter((l) =>
    l.date >= debut &&
    l.date <= finDeJournee(fin)
  );
}

function finDeJournee(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
}

export function versCsv(lignes) {
  const tete = "date;client;montant";
  return [tete, ...lignes.map((l) => [l.date.toISOString(), l.client, l.montant].join(";"))].join("\\n");
}
`;
const TEST_EXPORT = `import { describe, expect, it } from "vitest";
import { filtrerPeriode } from "./export";

describe("filtrerPeriode", () => {
  it("garde la borne de fin", () => {
    const l = [{ date: new Date(2026, 10, 3, 18, 0), client: "A", montant: 12 }];
    expect(filtrerPeriode(l, new Date(2026, 10, 1), new Date(2026, 10, 3))).toHaveLength(1);
  });
});
`;

let FILES, MTIMES, VERSIONS, ORIGINAUX, BLOBS, SETTINGS, SNAPS, CLOCK, STAGED;
const sha = (t) => crypto.createHash('sha1').update(t).digest('hex');
function blob(t) { const h = sha(t); BLOBS[h] = t; return h; }

function reset() {
    FILES = {
        'src/export.ts': EXPORT_APRES,
        'src/export.test.ts': TEST_EXPORT,
        'src/depot.ts': 'export async function lignesDuCompte(compte) {\n  return compte.lignes ?? [];\n}\n',
        'src/index.html': '<!doctype html>\n<html lang="fr">\n<head><meta charset="utf-8"><title>Export</title></head>\n<body><h1>Export CSV</h1><p>Aperçu de la page.</p></body>\n</html>\n',
        'package.json': '{\n  "name": "export-csv",\n  "type": "module",\n  "scripts": { "test": "vitest run" }\n}\n',
        'README.md': '# Export CSV\n\nExporte les lignes de facturation d\'un compte, bornes de dates incluses.\n',
        'docs/guide.md': '# Guide des exports\n\nLa date de fin s\'entend jusqu\'à 23 h 59 dans le fuseau du compte.\n',
        'scripts/sauvegarde.sh': '#!/bin/sh\nset -eu\ntar czf /work/sauvegardes/export-$(date +%F).tgz src docs\n',
        'vitest.config.ts': 'import { defineConfig } from "vitest/config";\n\nexport default defineConfig({ test: { environment: "node" } });\n',
        'notes.md': 'À vérifier : fuseau horaire des comptes hors Europe.\n',
    };
    CLOCK = Math.floor(Date.now() / 1000) - 3600;
    MTIMES = {};
    for (const p of Object.keys(FILES)) MTIMES[p] = CLOCK;
    BLOBS = {};
    ORIGINAUX = {
        'src/export.ts': { exists: true, sha: blob(EXPORT_AVANT), size: EXPORT_AVANT.length },
        'src/export.test.ts': { exists: false, sha: null, size: 0 },
        'README.md': { exists: true, sha: blob('# Export CSV\n\nExporte les lignes de facturation d\'un compte.\n'), size: 60 },
        'scripts/sauvegarde.sh': { exists: true, sha: blob('#!/bin/sh\ntar czf /work/export.tgz src\n'), size: 40 },
    };
    const maintenant = Math.floor(Date.now() / 1000);
    VERSIONS = {
        'src/export.ts': [
            { source: 'assistant', ts: maintenant - 1500, texte: EXPORT_APRES.replace('finDeJournee(fin)', 'fin') },
            { source: 'assistant', ts: maintenant - 140, texte: EXPORT_APRES },
        ],
        'src/export.test.ts': [{ source: 'assistant', ts: maintenant - 120, texte: TEST_EXPORT }],
        'README.md': [{ source: 'editor', ts: maintenant - 900, texte: FILES['README.md'] }],
        'scripts/sauvegarde.sh': [{ source: 'shell', ts: maintenant - 2400, texte: FILES['scripts/sauvegarde.sh'] }],
    };
    SNAPS = [
        { id: 's2', name: 'Avant la correction des bornes', ts: maintenant - 1800, duration_sec: 1.2, file_count: 10, src_bytes: 4096, archive_bytes: 3100 },
        { id: 's1', name: 'Projet importé', ts: maintenant - 86400, duration_sec: 0.9, file_count: 8, src_bytes: 3500, archive_bytes: 2800 },
    ];
    STAGED = ['src/export.test.ts'];
    SETTINGS = {
        enable_editor: true, enable_preview: true, enable_mcp: false, enable_rag: false,
        assistant_name: 'Elpis', editor_dark_mode: true, editor_auto_save: 'off', editor_persist_tabs: false,
        editor_follow_active: true, skin: 'elpis', dark_mode: false, dark_mode_auto: false,
        mcp_servers: [], active_mcp_ids: [], editor_ratio: 58,
    };
}
reset();

// Skins comme GET /api/skins : editor_css_url seulement si le dossier a un editeur.css.
function skins() {
    const integres = JSON.parse(fs.readFileSync(path.join(ROOT, 'css/skins/skins.json'), 'utf8')).skins.map((s) => {
        const fichier = `css/skins/${s.id || 'ardoise'}/editeur.css`;
        return fs.existsSync(path.join(ROOT, fichier)) ? { ...s, editor_css_url: `/static/${fichier}` } : s;
    });
    const importe = (id, reste = {}) => ({ id, label: id, desc: '', darkBase: false, builtin: false, sw: ['#111', '#eee', '#08f'], css_url: `/api/skins/${id}/skin.css?v=1`, ...reste });
    return [...integres, importe('sans-editeur'), importe('avec-editeur', { editor_css_url: '/api/skins/avec-editeur/editeur.css?v=1' })];
}

function json(res, obj, status = 200) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.setHeader('cache-control', 'no-store');
    res.end(JSON.stringify(obj));
}
function lire(req) {
    return new Promise((r) => { const c = []; req.on('data', (x) => c.push(x)); req.on('end', () => r(Buffer.concat(c))); });
}
async function corps(req) { try { return JSON.parse((await lire(req)).toString() || '{}'); } catch { return {}; } }

function arbre() {
    const racine = [];
    const dossiers = new Map();
    const dossier = (d) => {
        if (!d) return racine;
        if (dossiers.has(d)) return dossiers.get(d).children;
        const parent = dossier(d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '');
        const n = { name: d.split('/').pop(), path: d, type: 'folder', children: [] };
        parent.push(n);
        dossiers.set(d, n);
        return n.children;
    };
    for (const p of Object.keys(FILES).sort()) dossier(p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '').push({ name: p.split('/').pop(), path: p, type: 'file' });
    const trier = (l) => { l.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1)); l.forEach((n) => n.children && trier(n.children)); };
    trier(racine);
    return racine;
}

function ecrire(p, texte, source) {
    if (!ORIGINAUX[p]) ORIGINAUX[p] = FILES[p] !== undefined ? { exists: true, sha: blob(FILES[p]), size: FILES[p].length } : { exists: false, sha: null, size: 0 };
    FILES[p] = texte;
    MTIMES[p] = Date.now() / 1000;
    (VERSIONS[p] = VERSIONS[p] || []).push({ source, ts: Math.floor(Date.now() / 1000), texte });
}

function session() {
    return {
        session: 'demo-' + (CLOCK % 1000),
        started: CLOCK,
        files: Object.keys(VERSIONS).map((p) => {
            const v = VERSIONS[p];
            const d = v[v.length - 1];
            return { path: p, versions: v.length, original_exists: !!ORIGINAUX[p]?.exists, deleted: FILES[p] === undefined, last_ts: d.ts, last_source: d.source };
        }),
    };
}
function entreeFichier(p) {
    if (!VERSIONS[p]) return null;
    return {
        original: ORIGINAUX[p] || { exists: true, sha: blob(FILES[p] ?? ''), size: (FILES[p] ?? '').length },
        versions: VERSIONS[p].map((v) => ({ exists: true, sha: blob(v.texte), size: v.texte.length, ts: v.ts, source: v.source })),
        created: CLOCK,
        path: p,
        current: { exists: FILES[p] !== undefined, sha256: null, size: (FILES[p] ?? '').length, mtime: MTIMES[p] ?? null },
    };
}

const HEAD = { 'src/export.ts': EXPORT_AVANT, 'README.md': '# Export CSV\n\nExporte les lignes de facturation d\'un compte.\n' };
function statutGit() {
    const modified = [];
    const untracked = [];
    for (const p of Object.keys(FILES)) {
        if (STAGED.includes(p)) continue;
        if (HEAD[p] !== undefined && HEAD[p] !== FILES[p]) modified.push({ path: p, status: 'M', add: 3, del: 1 });
        else if (p === 'notes.md') untracked.push({ path: p });
    }
    return {
        is_repo: true, repo: '.', branch: 'fix/bornes-dates', ahead: 1, behind: 0,
        remote_url: 'https://git.equipe.lan/compta/export-csv.git',
        staged: STAGED.map((p) => ({ path: p, status: HEAD[p] === undefined ? 'A' : 'M', add: 9, del: 0 })),
        modified, untracked, conflicted: [], truncated: false,
    };
}
const maintenantS = () => Math.floor(Date.now() / 1000);
const COMMITS = () => [
    { hash: 'a1b2c3d4e5f6', short: 'a1b2c3d', author: 'Alice Martin', email: 'alice@equipe.lan', timestamp: maintenantS() - 5400, message: 'Export : colonnes date, client, montant' },
    { hash: 'b2c3d4e5f6a7', short: 'b2c3d4e', author: 'Elpis', email: 'elpis@equipe.lan', timestamp: maintenantS() - 86400, message: 'Dépôt : lecture des lignes du compte' },
    { hash: 'c3d4e5f6a7b8', short: 'c3d4e5f', author: 'Alice Martin', email: 'alice@equipe.lan', timestamp: maintenantS() - 172800, message: 'Premier jet de l\'export CSV' },
];

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const q = new URL(req.url, 'http://x').searchParams;
    const m = req.method;
    try {
        if (url === '/__reset') { reset(); return json(res, { ok: true }); }
        if (url === '/__reglages') {
            for (const [k, v] of q.entries()) SETTINGS[k] = v === '1' ? true : v === '0' ? false : v;
            return json(res, SETTINGS);
        }
        if (url === '/__ecrire') { ecrire(q.get('path'), q.get('content') || '', q.get('source') || 'assistant'); return json(res, { ok: true }); }

        if (url === '/api/sandbox/tree') return json(res, bac.arbre(arbre()));
        if (url === '/api/sandbox/download') {
            const p = q.get('path');
            if (FILES[p] === undefined) { res.statusCode = 404; return res.end('nf'); }
            res.setHeader('X-Mtime', String(MTIMES[p] || 0));
            res.setHeader('content-type', 'text/plain; charset=utf-8');
            return res.end(FILES[p]);
        }
        if (url === '/api/sandbox/save' && m === 'POST') {
            const b = await corps(req);
            ecrire(b.path, b.content ?? '', b.source || 'editor');
            return json(res, bac.sauvegarde({ mtime: MTIMES[b.path], size: (b.content ?? '').length }));
        }
        if (url === '/api/sandbox/check-mtimes' && m === 'POST') {
            const b = await corps(req);
            const stale = [];
            for (const it of b.files || []) {
                if (FILES[it.path] === undefined) stale.push({ path: it.path, missing: true });
                else if (Math.abs(MTIMES[it.path] - it.mtime) > 1.0) stale.push({ path: it.path, new_mtime: MTIMES[it.path], size: FILES[it.path].length, sha256: null });
            }
            return json(res, bac.etats(stale));
        }
        if (url === '/api/sandbox/delete' && m === 'DELETE') {
            const p = q.get('path');
            for (const k of Object.keys(FILES)) if (k === p || k.startsWith(p + '/')) delete FILES[k];
            return json(res, { ok: true });
        }
        if (url === '/api/sandbox/grep' && m === 'POST') {
            const b = await corps(req);
            const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            let re;
            try { re = new RegExp(b.regex ? b.query : esc(b.query), b.case_sensitive ? 'g' : 'gi'); } catch { return json(res, { detail: 'Expression invalide' }, 400); }
            const matches = [];
            for (const p of Object.keys(FILES).sort()) FILES[p].split('\n').forEach((line, i) => {
                re.lastIndex = 0;
                const r = re.exec(line);
                if (r) matches.push({ path: p, line: i + 1, col: r.index + 1, snippet: line, match_start: r.index, match_end: r.index + r[0].length });
            });
            return json(res, { matches, total_files_scanned: Object.keys(FILES).length, truncated: false, elapsed_ms: 1 });
        }
        if (url === '/api/sandbox/quota') return json(res, bac.quota());
        if (url === '/api/sandbox/me') return json(res, m === 'POST' ? bac.choix() : bac.moi());
        if (url === '/api/sandbox/history') return json(res, session());
        if (url === '/api/sandbox/history/file') {
            const e = entreeFichier(q.get('path'));
            return e ? json(res, e) : json(res, { detail: 'absent' }, 404);
        }
        if (url === '/api/sandbox/history/blob') {
            const t = BLOBS[q.get('sha')];
            if (t === undefined) return json(res, { detail: 'absent' }, 404);
            res.setHeader('content-type', 'application/octet-stream');
            return res.end(t);
        }
        if (url === '/api/sandbox/snapshots') return json(res, { items: SNAPS, max: 10, last_restore_incomplete: null });

        if (url === '/api/sandbox/git/repos') return json(res, { repos: [{ path: '.', name: 'export-csv', branch: 'fix/bornes-dates' }] });
        if (url === '/api/sandbox/git/status') return json(res, statutGit());
        if (url === '/api/sandbox/git/branches') return json(res, { current: 'fix/bornes-dates', local: ['fix/bornes-dates', 'main'], remote: ['origin/main'] });
        if (url === '/api/sandbox/git/log') return json(res, { commits: COMMITS() });
        if (url === '/api/sandbox/git/tree') return json(res, { items: [], truncated: false });
        if (url === '/api/sandbox/git/commit-diff') {
            const c = COMMITS().find((x) => x.hash === q.get('hash')) ?? COMMITS()[0];
            return json(res, { files: [{ status: 'M', path: 'src/export.ts' }, { status: 'A', path: 'src/depot.ts' }], diff: '', message: c.message, author: c.author, timestamp: c.timestamp, truncated: false });
        }
        if (url === '/api/sandbox/git/show-file') {
            const t = HEAD[q.get('path')];
            return t === undefined ? json(res, { detail: 'absent' }, 404) : json(res, { content: t });
        }
        if (url === '/api/sandbox/git/stage' && m === 'POST') {
            const b = await corps(req);
            const tous = Object.keys(FILES).filter((p) => (HEAD[p] !== undefined && HEAD[p] !== FILES[p]) || p === 'notes.md');
            for (const p of b.paths?.length ? b.paths : tous) if (!STAGED.includes(p)) STAGED.push(p);
            return json(res, { ok: true });
        }
        if (url === '/api/sandbox/git/unstage' && m === 'POST') {
            const b = await corps(req);
            STAGED = b.paths?.length ? STAGED.filter((p) => !b.paths.includes(p)) : [];
            return json(res, { ok: true });
        }
        if (url === '/api/sandbox/git/commit' && m === 'POST') { STAGED = []; for (const p of Object.keys(HEAD)) HEAD[p] = FILES[p]; return json(res, { ok: true }); }
        if (url.startsWith('/api/sandbox/git/')) return json(res, { ok: true });

        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream'); res.write(': ping\n\n');
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* fermé */ } }, 15000);
            req.on('close', () => clearInterval(t));
            return;
        }
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: false, role: 'user', avatar: null });
        if (url === '/api/settings') {
            if (m === 'PUT' || m === 'POST') { Object.assign(SETTINGS, await corps(req)); return json(res, { ok: true, settings: SETTINGS }); }
            return json(res, SETTINGS);
        }
        if (url === '/api/llm/models') return json(res, { models: ['qwen3-coder'], models_with_status: [{ id: 'qwen3-coder', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/saved/chats') return json(res, { items: [{ id: 'c1', title: 'Export CSV : borne de fin', updated_at: Date.now() / 1000 }] });
        if (url === '/api/saved/chats/c1') return json(res, {
            id: 'c1', title: 'Export CSV : borne de fin',
            messages: [
                { role: 'user', content: 'Lance les tests de l\'export et corrige ce qui casse.' },
                { role: 'assistant', content: 'Corrigé : le filtre de date excluait la borne de fin (`<` au lieu de `<=`, `src/export.ts:7`). J\'ai ajouté un test pour ce cas ; les tests passent.' },
            ],
        });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url === '/api/skins') return json(res, { skins: skins(), default: 'elpis', mascottes: [] });
        if (url === '/api/skins/avec-editeur/editeur.css') {
            res.setHeader('content-type', 'text/css; charset=utf-8');
            return res.end('body.elpis-skin-avec-editeur .ed2--encre { --ed-code-bg: #102030; --ed-plan: #102030; }');
        }
        if (url.startsWith('/api/skins/') && url.endsWith('/skin.css')) {
            res.setHeader('content-type', 'text/css; charset=utf-8');
            return res.end('');
        }
        if (url.startsWith('/api/')) return json(res, {});

        if (url === '/' || url === '/index.html') {
            res.setHeader('content-type', 'text/html');
            res.setHeader('cache-control', 'no-store');
            return res.end(appliquerEntrees(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
        }
        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const p = path.join(ROOT, rel);
        if (!p.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
        res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
        res.setHeader('cache-control', 'no-store');
        res.end(fs.readFileSync(p));
    } catch { res.statusCode = 404; res.end('nf'); }
}).listen(PORT, HOTE, () => console.log(`editor-skin-server sur http://${HOTE}:${PORT}`));
