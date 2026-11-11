// SPDX-License-Identifier: MIT
// Faux serveur du widget de file : `queue_status` de chargement (avec et sans pourcentage) puis d'attente de créneau, `queue_cleared`, sources RAG, journal tronqué, réponse.
//   PERF_PORT=8931 node tests/frontend/load-progress-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';
import { appliquerEntrees } from './lib/entrees.mjs';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8931);
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
    return appliquerEntrees(html);
}
function json(res, obj, status = 200) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
}

const M = 'Qwen3.8-27B-long';
const base = { type: 'queue_status', kind: 'loading', model: M, position: 1, active: 1, est_ms: 15000 };
const SCRIPT = [
    [200,  { type: 'chat_id', chat_id: 'c-ld' }],
    // 1. Chargement, moteur ANCIEN (aucun pourcentage) puis RÉCENT (téléchargement, deux étapes).
    [300,  { ...base }],
    [600,  { ...base, progress_pct: 35, stage: 'download', stages: ['download'] }],
    [600,  { ...base, progress_pct: 12, stage: 'text_model', stages: ['text_model', 'mmproj_model'] }],
    [600,  { ...base, progress_pct: 62, stage: 'mmproj_model', stages: ['text_model', 'mmproj_model'] }],
    [600,  { ...base, progress_pct: 100, stage: 'mmproj_model', stages: ['text_model', 'mmproj_model'] }],
    // 2. Attente d'un créneau (slots saturés) : le bandeau, avec l'estimation animée.
    [600,  { type: 'queue_status', kind: 'waiting', model: M, position: 2, active: 3, est_ms: 9000 }],
    [1500, { type: 'queue_cleared' }],
    // 3. Sources RAG du tour : mention sous la réponse.
    [100,  { type: 'mode', text: 'RAG ON (docs)' }],
    [100,  { type: 'rag_sources', sources: [sourceRag(1, 'guide.pdf'), sourceRag(2, 'notes.md')] }],
    // 4. Journal du run plein (vu au rattachement ; même gestionnaire pour le flux d'envoi).
    [100,  { type: 'journal_truncated' }],
    [500,  { type: 'content_token', text: 'Modèle prêt, voici la réponse.' }],
    [200,  { type: 'final', content: 'Modèle prêt, voici la réponse.' }],
];

// Source RAG conforme au contrat (passage numéroté [n] d'un document).
function sourceRag(n, document) {
    const id = '3f9a1c2e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
    return {
        n, cited: false, query: 'guide', rank: n, relevance: 1,
        passage: { collection_id: id, collection_name: 'docs', owner: { id: 1, username: 'u', display_name: 'u' }, document_id: id, document_name: document,
            rel_path: document, chunk_index: n, page: null, heading_path: '', text: 'extrait', score: 0.5, boxes: [] },
    };
}

function streamScript(res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    let i = 0;
    const tick = () => {
        if (i >= SCRIPT.length) { try { res.end(); } catch (_) {} return; }
        const [delay, evt] = SCRIPT[i++];
        setTimeout(() => {
            try { res.write(JSON.stringify(evt) + '\n'); } catch (_) { return; }
            tick();
        }, delay);
    };
    tick();
}

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/api/settings') return json(res, { hide_thinking: false });
        if (url === '/api/chat-saved-stream3' && req.method === 'POST') {
            req.on('data', () => {});
            req.on('end', () => streamScript(res));
            return;
        }
        if (url === '/api/saved/chats') {
            return json(res, { items: [{ id: 'c-ld', title: 'Chargement', updated_at: 0 }] });
        }
        if (url === '/api/saved/chats/new' && req.method === 'POST') {
            return json(res, { id: 'c-ld', title: 'Chargement' });
        }
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: false, role: 'user', avatar: null });
        if (url === '/api/llm/models') return json(res, { models: [M], models_with_status: [{ id: M, status: 'unloaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/notifications') return json(res, { items: [], unread: 0 });
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.write(': ping\n\n');
            const t = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
            req.on('close', () => clearInterval(t));
            return;
        }
        if (url.startsWith('/api/')) return json(res, {});

        if (url === '/' || url === '/index.html') {
            res.setHeader('content-type', 'text/html');
            res.end(applyIncludes(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')));
            return;
        }
        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const p = path.join(ROOT, rel);
        if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
        res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
        res.end(fs.readFileSync(p));
    } catch (e) { res.statusCode = 404; res.end('nf'); }
}).listen(PORT, () => console.log('load-progress-server on ' + PORT));
