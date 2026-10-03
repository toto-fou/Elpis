// SPDX-License-Identifier: MIT
// Harnais route-mock de la GÉNÉRATION D'IMAGES (chat/_image.js) : mode
// Images du composeur, tuile de progression, grille de résultats,
// visionneuse, suppression annulable, préférences du compte, commande
// /image, galerie, Paramètres › Images.
// Lancement : PERF_PORT=8934 node tests/frontend/image-server.mjs
//
// Les routes suivent le contrat back/front du plan
// (docs/generation-images-design-2026-10-02.md § 11).
//
// - POST /__test/image {...} : scénario du prochain tour, statut, réglages.
// - GET  /__test/calls       : corps reçus (tours, réglages, suppressions…).
import http from 'http';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8934);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

// ── PNG uni, de la taille demandée (encodeur minimal) ───────────────────
const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        t[n] = c >>> 0;
    }
    return t;
})();
function crc32(buf) {
    let c = 0xffffffff;
    for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
}
function png(w, h, rgb) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const ligne = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) { ligne[1 + x * 3] = rgb[0]; ligne[2 + x * 3] = rgb[1]; ligne[3 + x * 3] = rgb[2]; }
    const brut = Buffer.concat(Array.from({ length: h }, () => ligne));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(brut)), chunk('IEND', Buffer.alloc(0))]);
}
const COULEURS = [[59, 130, 246], [16, 185, 129], [245, 158, 11], [239, 68, 68]];

// ── État ────────────────────────────────────────────────────────────────
const DEFAUTS = {
    ready: true,
    image_enabled: true,
    image_tool_enabled: true,
    prefs: { ratio: '16:9', side: 1024, n: 1, enhance: false },
    size_policy: 'free',
    sizes: [],
    features: { seed: true, negative: true, steps: true, strength: true, edit: true },
    max_n: 4,
    scenario: 'ok',          // ok | error | slow | preflight403 | tool
    delay: 120,
};
let etat = JSON.parse(JSON.stringify(DEFAUTS));
const appels = () => ({ turns: [], settingsPut: [], deletes: [], cancels: [], status: 0, gallery: [] });
let journal = appels();
let compteur = 0;
const GONE = new Set(['gone01']);   // expirée : 404

function ref(id, w, h, seed) {
    return { id, url: '/api/images/' + id, thumb_url: '/api/images/' + id + '?thumb=1',
             width: w, height: h, seed, mime: 'image/png' };
}

// Conversation persistée : un tour image réussi (dont une image expirée),
// un tour en échec, une réponse de l'outil du modèle.
const CHAT_IMG = {
    id: 'img1', title: 'Phares',
    messages: [
        { role: 'user', content: 'Un phare sous l’orage',
          image_request: { size: '1024x576', n: 2, ratio: '16:9', side: 1024 } },
        { role: 'assistant', content: '[2 images générées : « Un phare sous l’orage »]',
          generated_images: [ref('keep01', 1024, 576, 4812), ref('gone01', 1024, 576, 4813)],
          image_meta: { model: 'Qwen-Image', duration_s: 14 },
          revised_prompt: 'A lighthouse in a storm, engraving style' },
        { role: 'user', content: 'Un chat sur un toit', image_request: { size: '1024x1024', n: 1 } },
        { role: 'assistant', content: '[Échec de la génération d’image : délai dépassé]',
          image_error: { code: 'timeout', message: 'Délai dépassé', retryable: true } },
        { role: 'user', content: 'Dessine-moi un mouton' },
        { role: 'assistant', content: 'Voici le mouton demandé.',
          tool_images: [ref('tool01', 1024, 1024, 77)] },
    ],
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
function corps(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (_) { resolve({}); } });
    });
}

function statut() {
    if (!etat.ready) return { ready: false, available: false };
    return {
        ready: true, available: etat.image_enabled, provider: 'sdcpp', model: 'Qwen-Image',
        ratios: ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16', '21:9', '9:21'],
        sides: [512, 768, 1024, 1280, 1536, 2048], default_side: 1024, max_side: 2048, step: 64,
        max_n: etat.max_n, size_policy: etat.size_policy, sizes: etat.sizes,
        features: etat.features, prefs: etat.prefs, enhance_enabled: true,
        keep_per_user: 50, stored: 37,
    };
}

function ecrire(res, ev) { try { res.write(JSON.stringify(ev) + '\n'); return true; } catch (_) { return false; } }

function tourImage(req, res, body) {
    const g = body.image_gen || {};
    const m = /^(\d+)x(\d+)$/.exec(g.size || '1024x1024') || [0, 1024, 1024];
    const w = +m[1], h = +m[2], n = g.n || 1;
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    const suite = [
        { type: 'mode', kind: 'image', text: 'Génération d’image…' },
        { type: 'image_progress', state: 'queued', queue_position: 2, elapsed_s: 0, width: w, height: h, n },
        { type: 'image_progress', state: 'generating', queue_position: null, elapsed_s: 1, eta_s: 30, width: w, height: h, n },
    ];
    let annule = false;
    req.on('close', () => { annule = true; });
    if (etat.scenario === 'error') {
        suite.push({ type: 'image_error', code: 'timeout', message: 'Délai dépassé', retryable: true });
        suite.push({ type: 'final', image: true, chat_id: 'cnew', persisted: true,
                     assistant: '[Échec de la génération d’image : délai dépassé]',
                     generated_images: [], image_error: { code: 'timeout', message: 'Délai dépassé', retryable: true } });
    } else if (etat.scenario !== 'slow') {
        const items = Array.from({ length: n }, (_, i) => ref('gen' + (++compteur), w, h, 1000 + compteur));
        suite.push({ type: 'image', items, prompt: 'x' });
        suite.push({ type: 'final', image: true, chat_id: 'cnew', persisted: true,
                     assistant: '[Image générée : « x »]', generated_images: items,
                     image_meta: { model: 'Qwen-Image', duration_s: 12 },
                     metrics: { model: 'Qwen-Image', duration_s: 12 } });
    }
    let i = 0;
    const tick = () => {
        if (annule) return;
        if (i >= suite.length) {
            if (etat.scenario === 'slow') return setTimeout(tick, 200);   // jusqu'au Stop
            try { res.end(); } catch (_) {}
            return;
        }
        if (!ecrire(res, suite[i++])) return;
        setTimeout(tick, etat.delay);
    };
    tick();
}

function tourTexte(req, res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    const suite = etat.scenario === 'tool' ? [
        { type: 'content_token', text: 'Je dessine. ' },
        { type: 'image_progress', source: 'tool', state: 'queued', queue_position: 1, elapsed_s: 0, width: 1024, height: 1024, n: 1 },
        { type: 'image_progress', source: 'tool', state: 'generating', elapsed_s: 0, eta_s: 20, width: 1024, height: 1024, n: 1 },
        { type: 'image_progress', source: 'tool', state: 'generating', elapsed_s: 1, eta_s: 20, width: 1024, height: 1024, n: 1 },
        { type: 'image', source: 'tool', items: [ref('tool' + (++compteur), 1024, 1024, 5)] },
        { type: 'content_token', text: 'Voilà.' },
        { type: 'final', chat_id: 'cnew', persisted: true, assistant: 'Je dessine. Voilà.' },
    ] : [
        { type: 'content_token', text: 'Réponse du modèle.' },
        { type: 'final', chat_id: 'cnew', persisted: true, assistant: 'Réponse du modèle.' },
    ];
    let i = 0;
    const tick = () => {
        if (i >= suite.length) { try { res.end(); } catch (_) {} return; }
        if (!ecrire(res, suite[i++])) return;
        setTimeout(tick, etat.delay);
    };
    tick();
}

http.createServer(async (req, res) => {
    const [url, qs] = req.url.split('?');
    try {
        if (url === '/__test/image' && req.method === 'POST') {
            const b = await corps(req);
            etat = Object.assign(JSON.parse(JSON.stringify(DEFAUTS)), b);
            journal = appels();
            // Les suppressions d'une passe précédente ne survivent pas.
            GONE.clear(); GONE.add('gone01');
            return json(res, { ok: true, etat });
        }
        if (url === '/__test/calls') return json(res, journal);

        if (url === '/api/image/status') { journal.status++; return json(res, statut()); }
        let m = /^\/api\/images\/([A-Za-z0-9]+)$/.exec(url);
        if (m) {
            const id = m[1];
            if (req.method === 'DELETE') { journal.deletes.push(id); GONE.add(id); return json(res, { ok: true }); }
            if (GONE.has(id)) return json(res, { detail: 'Image introuvable ou expirée.' }, 404);
            const k = id.split('').reduce((a, c) => a + c.charCodeAt(0), 0);
            res.setHeader('content-type', 'image/png');
            res.setHeader('cache-control', 'no-store');
            res.end(png(qs && qs.indexOf('thumb=1') >= 0 ? 32 : 64, 36, COULEURS[k % COULEURS.length]));
            return;
        }
        if (url === '/api/images' && req.method === 'GET') {
            const p = new URLSearchParams(qs || '');
            journal.gallery.push(Object.fromEntries(p.entries()));
            const tous = Array.from({ length: 30 }, (_, i) => Object.assign(ref('gal' + i, 1024, i % 3 ? 576 : 1024, 300 + i), {
                chat_id: i % 2 ? 'img1' : 'other', prompt: 'Image ' + i, model: 'Qwen-Image', created_at: 1000 - i,
            }));
            const filtre = p.get('chat_id') ? tous.filter((x) => x.chat_id === p.get('chat_id')) : tous;
            const avant = p.get('before') ? Number(p.get('before')) : Infinity;
            const lim = Math.max(1, Math.min(Number(p.get('limit') || 24), 100));
            const page = filtre.filter((x) => x.created_at < avant).slice(0, lim);
            const fin = page.length < lim || filtre.filter((x) => x.created_at < avant).length <= lim;
            return json(res, { items: page, next_before: fin ? null : page[page.length - 1].created_at,
                               total: filtre.length, keep: 50 });
        }

        if (url === '/api/settings') {
            if (req.method === 'PUT') {
                const b = await corps(req);
                journal.settingsPut.push(b);
                if (b.image_prefs) etat.prefs = b.image_prefs;
                if (b.image_enabled !== undefined) etat.image_enabled = b.image_enabled !== false;
                return json(res, { ok: true });
            }
            return json(res, {
                hide_thinking: false, live_shell_enabled: true,
                image_ready: etat.ready, image_enabled: etat.image_enabled,
                image_available: etat.ready && etat.image_enabled,
                image_tool_enabled: etat.image_tool_enabled, image_prefs: etat.prefs,
            });
        }
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            const b = await corps(req);
            journal.turns.push(b);
            if (b.image_gen && etat.scenario === 'preflight403') {
                return json(res, { detail: { code: 'forbidden', message: 'Images non autorisées pour ce compte.' } }, 403);
            }
            return b.image_gen ? tourImage(req, res, b) : tourTexte(req, res);
        }
        if (url === '/api/chat/cancel' && req.method === 'POST') {
            journal.cancels.push(await corps(req));
            return json(res, { ok: true });
        }
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/saved/chats') return json(res, { items: [{ id: 'img1', title: 'Phares', updated_at: 1 }] });
        if (url === '/api/saved/chats/img1') return json(res, CHAT_IMG);
        if (url === '/api/saved/chats/new' && req.method === 'POST') {
            req.on('data', () => {});
            return json(res, { id: 'cnew', title: 'Essai' });
        }
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
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
}).listen(PORT, '127.0.0.1', () => console.log(`image-server sur http://127.0.0.1:${PORT}`));
