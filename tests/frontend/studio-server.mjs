// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le rendu du Studio (sous-onglets, mini-chat,
// vagues, Studio d'automatisation) sans backend. Réplique @include + /static (comme
// tests/perf/perf-server.mjs) et mocke l'API : boot logged-in + routes
// /api/desktop/* + /api/sandbox/* (scripts d'automatisation) + un stream NDJSON avec une phase "thinking"
// (content vide → l'indicateur de vagues .elpis-typing doit s'afficher).
// Lancement : node tests/frontend/studio-server.mjs   (port 8902, env STUDIO_PORT)
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.STUDIO_PORT || 8902);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

// 1×1 PNG transparent (suffit à createImageBitmap + <image> ; le viewBox SVG
// prend img_w/img_h de la réponse, pas la taille intrinsèque).
const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
    'base64');

const BOXES = [
    { id: 'el_1', label: 'Fichier',     role: 'button', auto_id: 'fileBtn',   depth: 0, box: [20, 20, 140, 56], center: [80, 38],  source: 'a11y',   confidence: 0.92 },
    { id: 'el_2', label: 'Enregistrer', role: 'button', auto_id: 'saveBtn',   depth: 1, box: [160, 20, 300, 56], center: [230, 38], source: 'vision', confidence: 0.81 },
    { id: 'el_3', label: 'Quitter',     role: 'button', auto_id: 'quitBtn',   depth: 0, box: [320, 20, 430, 56], center: [375, 38], source: 'merged', confidence: 0.74 },
    // Une fenêtre « winapptest » avec un groupe SANS NOM et un bouton SANS NOM
    // dedans (le cas « group group ») : l'inspecteur doit viser le bouton (le
    // plus profond) et le script l'écrire par CHEMIN, jamais name="group".
    { id: 'el_w', label: 'winapptest', role: 'window', auto_id: '', depth: 0, box: [20, 90, 620, 470], center: [320, 280], source: 'a11y', confidence: 1 },
    { id: 'el_g', label: 'group',  role: 'group',  auto_id: '', unnamed: true, depth: 1, box: [40, 110, 300, 310], center: [170, 210], source: 'a11y', confidence: 1 },
    { id: 'el_b', label: 'button', role: 'button', auto_id: '', unnamed: true, depth: 2, box: [60, 130, 180, 170], center: [120, 150], source: 'a11y', confidence: 1 },
];

function applyIncludes(html) {
    for (let i = 0; i < 6; i++) {
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
    return new Promise((r) => { let b = ''; req.on('data', (c) => b += c); req.on('end', () => r(b)); });
}

// ── État en mémoire ────────────────────────────────────────────
let _seq = 0;
const _calls = [];   // requêtes notables (bundle…) relues par les harnais via /__calls
let _runPolls = 0;   // exécution sur la VM (mock) : 1er sondage « en cours », 2e « fini »
const _files = {};   // sandbox factice : chemin → contenu (automations/*.auto.json, *.py)

function frame(token, extra = {}) {
    const seq = ++_seq;
    // sig dHash 16-hex pseudo-aléatoire (hash multiplicatif) → frames consécutifs
    // diffèrent nettement (effet 'changed'), comme un vrai écran qui change.
    const sig = (BigInt(seq) * 2654435769n & 0xffffffffffffffffn).toString(16).padStart(16, '0');
    return {
        ok: true, image_url: `/api/desktop/frame/${token}?t=${seq}`,
        img_w: 640, img_h: 360, boxes: BOXES, target: 'vm1', sig: sig, ts: seq, ...extra,
    };
}

// Stream NDJSON : phase "thinking" (≥700ms, content vide → vagues), un tool_call
// desktop_act + annotation_frame + tool_result, puis un content_token + final.
function streamChat(req, res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    const send = (o) => res.write(JSON.stringify(o) + '\n');
    let closed = false;
    req.on('close', () => { closed = true; });
    const steps = [
        { ms: 50,  ev: { type: 'thinking_token', text: 'je réfléchis ' } },
        { ms: 900, ev: { type: 'tool_call', name: 'desktop_act', args: { op: 'click', element_id: 'el_2' } } },
        { ms: 60,  ev: { type: 'annotation_frame', ...frame('tokChat') } },
        { ms: 250, ev: { type: 'tool_result', name: 'desktop_act', result: JSON.stringify({ ok: true, op: 'click', point: [230, 38], frame_token: 'tokChat' }) } },
        { ms: 250, ev: { type: 'content_token', text: 'Fait.' } },
        { ms: 30,  ev: { type: 'final', assistant: 'Fait.', metrics: { model: 'm1' } } },
    ];
    let i = 0;
    (function tick() {
        if (closed) return;
        if (i >= steps.length) { res.end(); return; }
        const s = steps[i++];
        setTimeout(() => { if (closed) return; send(s.ev); tick(); }, s.ms);
    })();
}

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    const m = req.method;
    try {
        // ── Studio : desktop ───────────────────────────────────────────
        if (url === '/api/desktop/targets')
            return json(res, { targets: [{ name: 'vm1', os: 'linux', default: true }, { name: 'vm2', os: 'windows' }], count: 2 });
        if (url === '/api/desktop/active-target')
            return json(res, m === 'POST' ? { ok: true, target: 'vm1' } : { target: 'vm1' });
        if (url === '/api/desktop/capture') {
            const cb = JSON.parse(await readBody(req) || '{}');
            // Sémantique route réelle : ``raw`` ne coupe QUE la vision ; l'arbre
            // a11y (local, rapide) est TOUJOURS renvoyé → boxes a11y conservées.
            // On glisse une box HORS-IMAGE (2e écran, x≥640) : le FRONT doit la
            // filtrer (boxOnScreen) → le compteur reste au nb d'éléments VISIBLES.
            const _offImg = { id: 'el_off', label: 'HorsÉcran', role: 'button', auto_id: 'offBtn',
                              box: [900, 40, 1000, 76], center: [950, 58], source: 'a11y', confidence: 0.8 };
            let boxes = cb.raw ? BOXES.filter(b => b.source === 'a11y').concat([_offImg])
                               : BOXES.concat([_offImg]);
            // ``settle`` (ré-observe d'après-action) : un NOUVEL élément apparaît
            // (fenêtre « Dialogue ») → le diff propose un candidat de vérification.
            if (cb.settle) boxes = BOXES.concat([
                { id: 'el_dlg', label: 'Dialogue', role: 'window', auto_id: 'dlgWindow', box: [100, 100, 400, 300], center: [250, 200], source: 'a11y', confidence: 0.9 },
            ]);
            return json(res, frame('tokCap', { note: null, boxes }));
        }
        if (url === '/api/desktop/run-automation') {
            const b = JSON.parse(await readBody(req) || '{}');
            _calls.push({ url, name: b.name, target: b.target, dry_run: !!b.dry_run, trace: !!b.trace, hasCode: !!b.code });
            _runPolls = 0;
            return json(res, { ok: true, run_id: 'run-1', target: b.target, name: 'x' });
        }
        if (url.startsWith('/api/desktop/run-automation/status')) {
            _runPolls++;
            if (_runPolls < 2) return json(res, { ok: true, run_id: 'run-1', running: true, code: null, log: ['✓ 1. clic « Fichier »'], report_dir: '' });
            return json(res, { ok: true, run_id: 'run-1', running: false, code: 2, report_dir: 'rapports/x-1', summary: 'ÉCHEC — 1 étape(s) sur 2', log: [],
                report: { summary: 'ÉCHEC — 1 étape(s) sur 2 (code 2), 1 réparée(s)', exit_code: 2, ok: 1, failed: 1,
                          steps: [{ index: 1, label: 'clic « Fichier » (button)', ok: true, ms: 120, method: 'coords', resolved_by: 'name', line: 10,
                                    healed: { by: 'name', suggest: 'auto_id="fileBtn"' } },
                                  { index: 2, label: 'clic « Quitter » (button)', ok: false, ms: 15200, error: 'StepError: cible introuvable', line: 11,
                                    screenshot: 'rapports\\x-1\\echec-01.png' }],
                          healed: [{ index: 1, by: 'name', suggest: 'auto_id="fileBtn"' }] } });
        }
        if (url === '/api/desktop/run-automation/stop') return json(res, { ok: true, running: false });
        if (url === '/api/desktop/run-automation-matrix') {
            const b = JSON.parse(await readBody(req) || '{}');
            _calls.push({ url, targets: b.targets });
            return json(res, { ok: true, targets: (b.targets || []).length, ok_count: 1, summary: '1/' + (b.targets || []).length + ' cible(s) réussie(s)',
                               results: (b.targets || []).map((t, i) => ({ target: t, ok: i === 0, summary: i === 0 ? 'OK — 2 étape(s)' : 'agent injoignable', duration_s: 3 })) });
        }
        if (url === '/api/desktop/automation-bundle') {
            const b = JSON.parse(await readBody(req) || '{}');
            _calls.push({ url, name: b.name, os: b.os, hasCode: !!b.code });
            res.statusCode = 200;
            res.setHeader('content-type', 'application/zip');
            res.setHeader('content-disposition', 'attachment; filename="bundle.zip"');
            return res.end(Buffer.from('PK\x05\x06' + '\0'.repeat(18), 'binary'));   // zip vide valide
        }
        if (url === '/__calls') return json(res, _calls);
        if (url === '/api/desktop/act') {
            const b = JSON.parse(await readBody(req) || '{}');
            return json(res, frame('tokAct', { op: b.op || 'click', point: [80, 38],
                                               method: b.op === 'invoke' ? 'invoke' : undefined }));
        }
        if (url === '/api/desktop/launch') {
            const b = JSON.parse(await readBody(req) || '{}');
            return json(res, frame('tokLaunch', { launched: b.app || '', found: true,
                                                  title: 'Bloc-notes', interaction_state: 'ready' }));
        }
        if (url === '/api/desktop/wait-window')
            return json(res, { ok: true, found: true, interaction_state: 'ready', title: 'Bloc-notes', auto_id: '' });
        if (url.startsWith('/api/desktop/frame/')) {
            res.setHeader('content-type', 'image/png');
            res.end(PNG_1x1); return;
        }
        // ── Studio d'automatisation : la sandbox (fichiers automations/) ──
        if (url === '/api/sandbox/tree') {
            const kids = Object.keys(_files).filter(k => k.startsWith('automations/')).sort()
                .map(k => ({ name: k.slice('automations/'.length), path: k, type: 'file', size: _files[k].length }));
            return json(res, { root: 'work', items: kids.length ? [{ name: 'automations', path: 'automations', type: 'folder', children: kids }] : [] });
        }
        if (url === '/api/sandbox/mkdir' && m === 'POST') { await readBody(req); return json(res, { ok: true }); }
        if (url === '/api/sandbox/save' && m === 'POST') {
            const b = JSON.parse(await readBody(req) || '{}');
            _files[b.path] = String(b.content || ''); return json(res, { ok: true });
        }
        if (url.startsWith('/api/sandbox/serve/')) {
            const k = decodeURIComponent(url.slice('/api/sandbox/serve/'.length));
            if (!(k in _files)) return json(res, { error: 'nf' }, 404);
            res.statusCode = 200; res.setHeader('content-type', k.endsWith('.json') ? 'application/json' : 'text/plain');
            res.end(_files[k]); return;
        }
        if (url.startsWith('/api/sandbox/delete') && m === 'DELETE') {
            const k = decodeURIComponent((req.url.split('?')[1] || '').replace(/^path=/, ''));
            delete _files[k]; return json(res, { ok: true });
        }
        // ── Boot (logged-in) ───────────────────────────────────────────
        if (url === '/api/chat-saved-stream3') return streamChat(req, res);
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'admin', is_admin: 1, role: 'admin' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded', vision: true }], server_reachable: true, status: 'ok' });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/saved/chats') return json(res, { items: [], id: 'c1' });
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.write(': ping\n\n'); const t = setInterval(() => res.write(': ping\n\n'), 15000);
            req.on('close', () => clearInterval(t)); return;
        }
        if (url.startsWith('/api/')) return json(res, {});
        // ── Statique ───────────────────────────────────────────────────
        if (url === '/' || url === '/index.html') {
            res.setHeader('content-type', 'text/html');
            res.end(applyIncludes(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'))); return;
        }
        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const p = path.join(ROOT, rel);
        if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
        const body = fs.readFileSync(p);
        res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
        res.end(body);
    } catch (e) {
        res.statusCode = 404; res.end('nf');
    }
}).listen(PORT, '127.0.0.1', () => console.log(`studio-server sur http://127.0.0.1:${PORT}`));
