// SPDX-License-Identifier: MIT
// Serveur de harnais perf : sert le frontend assemblé (réplique @include du
// backend, cf. mémoire « playwright-frontend-harness ») ET mocke toute l'API
// même-origine — y compris le stream NDJSON token-par-token CADENCÉ.
//
// Pourquoi pas page.route ? Deux raisons :
//   1. route.fulfill() livre le corps en un bloc → le flush 40ms du front ne
//      tirerait qu'une fois, la mesure de streaming serait invalide.
//   2. l'interception Playwright ajoute son propre coût par requête, bruit
//      qu'on ne veut pas dans une mesure de perf.
//
// Config dynamique par scénario : POST /__perf/config {reply, toks, chat}.
// Lancement : node tests/perf/perf-server.mjs   (port 8901, env PERF_PORT)
import http from 'http';
import fs from 'fs';
import path from 'path';
import { buildCodeReply, buildShortReply, buildXlReply, buildXssReply, tokenize } from './fixtures/big_code_reply.mjs';
import { buildLongChat } from './fixtures/long_chat.mjs';
import { buildToolsPhases, buildToolsFinal } from './fixtures/tools_reply.mjs';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8901);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

function applyIncludes(html) {
    for (let i = 0; i < 5; i++) {
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

// ── État de scénario (mutable via /__perf/config) ─────────────────────────
const cfg = {
    reply: 'code200',   // code200 | short | xl | queue | tools | compress
    toks: 60,           // tokens/seconde du stream
    chat: null,         // null | 'long40' | 'long100' | 'long400' → fixtures sidebar + GET chat
    chats: null,        // [ids] → sidebar multi-conversations (scénario de fuites)
    chatDelayMs: null,  // {id: ms} → latence artificielle du GET d'un chat
    rounds: 30,         // reply='tools' : nombre de rounds tool_call/tool_result
};

const CHATS = {
    long40:  buildLongChat('long40', 40),
    long100: buildLongChat('long100', 100),
    // Très long chat : mesure du temps ABSOLU d'ouverture (virtualisation +
    // highlight + settle) — c_open_longchat ne mesurait que la stabilité.
    long400: buildLongChat('long400', 400),
};

function json(res, obj, status = 200) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
}

function buildReply() {
    if (cfg.reply === 'short') return buildShortReply();
    if (cfg.reply === 'xl') return buildXlReply();
    if (cfg.reply === 'xss') return buildXssReply();
    // Contenu ARBITRAIRE fourni par le verify (cfg.custom) — sert aux
    // assertions de rendu de stream qui exigent une forme précise (fence non
    // précédé de ligne vide, bloc > 12 Ko…). Cf. streamrender-verify.mjs.
    if (cfg.reply === 'custom') {
        const full = String(cfg.custom || '');
        return { thinking: [], content: tokenize(full), full };
    }
    return buildCodeReply(200);
}

// Stream NDJSON cadencé. Événements conformes à app-chat.js:1155+ :
// thinking_token / content_token {text}, queue_status {est_ms…},
// queue_cleared, kv_cache {used,total,pct}, final {assistant, metrics}.
function streamChat(req, res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'application/x-ndjson');
    res.setHeader('cache-control', 'no-cache');
    const send = (o) => res.write(JSON.stringify(o) + '\n');
    // tools/compress construisent leurs propres phases — ne pas payer la
    // fixture code200 (gros string + tokenize) avant le 1er write.
    const reply = (cfg.reply === 'tools' || cfg.reply === 'compress') ? null : buildReply();
    const periodMs = Math.max(4, 1000 / cfg.toks);
    const perTick = Math.max(1, Math.round((1000 / cfg.toks) < 4 ? 4 / (1000 / cfg.toks) : 1));
    let timer = null, closed = false;
    req.on('close', () => { closed = true; if (timer) clearInterval(timer); });

    const phases = [];
    if (cfg.reply === 'queue') {
        // Attente longue (6 s) : permet au scénario d d'isoler une fenêtre
        // de mesure SUR la phase d'animation pure, hors coût d'envoi.
        phases.push({ kind: 'event', ev: { type: 'queue_status', kind: 'waiting', model: 'm1', position: 2, active: 1, est_ms: 8000 } });
        phases.push({ kind: 'wait', ms: 6000 });
        phases.push({ kind: 'event', ev: { type: 'queue_cleared' } });
    }
    if (cfg.reply === 'tools') {
        // Boucle agentic : R rounds (tool_thinking → tool_call → tool_result)
        // puis réponse finale streamée. C'est le chemin réel dominant en usage
        // outillé — il n'était couvert par AUCUN scénario.
        const rounds = Math.max(1, Number(cfg.rounds) || 30);
        phases.push(...buildToolsPhases(rounds));
        const fin = buildToolsFinal(rounds);
        phases.push({ kind: 'tokens', type: 'content_token', toks: fin.content });
        phases.push({ kind: 'event', ev: { type: 'kv_cache', used: 5200, total: 8192 } });
        phases.push({ kind: 'event', ev: { type: 'final', assistant: fin.full, metrics: { model: 'm1', duration_s: 2, input_tokens: 9000, output_tokens: 800, last_prompt_tokens: 5200 } } });
    } else if (cfg.reply === 'compress') {
        // Burst de compression en plein stream : content → compression_start
        // → 3 s (tick 250 ms + patchs toolSteps côté front) → compression_done
        // → suite du content. Shapes conformes à conversation_compressor.py.
        const part1 = buildShortReply();
        const part2 = buildCodeReply(60);
        phases.push({ kind: 'tokens', type: 'content_token', toks: part1.content });
        phases.push({ kind: 'event', ev: { type: 'compression_start', external: false, path: 'self', model: 'm1', turns: 24, tokens: 6100, ctx_size: 8192 } });
        phases.push({ kind: 'wait', ms: 3000 });
        phases.push({ kind: 'event', ev: { type: 'compression_done', external: false, path: 'self', stats: {
            compressed: true, turns_compressed: 15, messages_before: 48, messages_after: 12,
            chars_before: 24000, chars_after: 6000, tokens_before: 6100, tokens_after: 1900,
            tokens_saved: 4200, tokens_estimated: false, ratio: 0.25, had_previous_summary: false,
            model_used: 'm1', path: 'self', duration_ms: 3000, round: 1, max_rounds: 2,
        } } });
        phases.push({ kind: 'tokens', type: 'content_token', toks: part2.content });
        phases.push({ kind: 'event', ev: { type: 'kv_cache', used: 2600, total: 8192 } });
        phases.push({ kind: 'event', ev: { type: 'final', assistant: part1.full + part2.full, metrics: { model: 'm1', duration_s: 4 } } });
    } else {
        if (reply.thinking.length) phases.push({ kind: 'tokens', type: 'thinking_token', toks: reply.thinking });
        phases.push({ kind: 'tokens', type: 'content_token', toks: reply.content });
        phases.push({ kind: 'event', ev: { type: 'kv_cache', used: 3500, total: 8192 } });
        phases.push({ kind: 'event', ev: { type: 'final', assistant: reply.full, metrics: { model: 'm1', duration_s: 1 } } });
    }

    let p = 0;
    function next() {
        if (closed) return;
        if (p >= phases.length) { res.end(); return; }
        const ph = phases[p++];
        if (ph.kind === 'event') { send(ph.ev); next(); return; }
        if (ph.kind === 'wait') { setTimeout(next, ph.ms); return; }
        let i = 0;
        timer = setInterval(() => {
            if (closed) { clearInterval(timer); return; }
            for (let k = 0; k < perTick && i < ph.toks.length; k++) {
                send({ type: ph.type, text: ph.toks[i++] });
            }
            if (i >= ph.toks.length) { clearInterval(timer); timer = null; next(); }
        }, periodMs);
    }
    next();
}

// SSE système : connexion TENUE OUVERTE (ping 15 s). Un body qui se termine
// ferait boucler la reconnexion EventSource → bruit dans les mesures idle.
function sseSystemEvents(req, res) {
    res.statusCode = 200;
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache');
    res.write(': ping\n\n');
    const t = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => clearInterval(t));
}

function readBody(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => resolve(b));
    });
}

http.createServer(async (req, res) => {
    const url = req.url.split('?')[0];
    try {
        // ── Contrôle du harnais ───────────────────────────────────────
        if (url === '/__perf/config') {
            if (req.method === 'POST') {
                try { Object.assign(cfg, JSON.parse(await readBody(req) || '{}')); } catch (_) {}
            }
            return json(res, cfg);
        }
        // ── Mocks API (même origine, zéro interception Playwright) ───
        if (url === '/api/chat-saved-stream3') return streamChat(req, res);
        if (url === '/api/system-events') return sseSystemEvents(req, res);
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'admin', is_admin: 1, role: 'admin' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded', vision: false }], server_reachable: true, status: 'ok' });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/mcp/categories') return json(res, { ok: true, categories: [] });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/saved/chats') {
            const ids = Array.isArray(cfg.chats) && cfg.chats.length
                ? cfg.chats : (cfg.chat ? [cfg.chat] : []);
            const items = ids.filter((k) => CHATS[k]).map((k) => (
                { id: k, title: CHATS[k].title, archived: 0, updated_at: '2026-06-12T10:00:00Z' }));
            return json(res, { items, id: 'c1' });
        }
        const mChat = url.match(/^\/api\/saved\/chats\/([\w-]+)$/);
        if (mChat && CHATS[mChat[1]]) {
            // Latence artificielle PAR CHAT (cfg.chatDelayMs = {id: ms}) :
            // sert au verify de la course « deux clics rapides » du switch
            // (chatswitch-verify.mjs) — la réponse LENTE ne doit pas gagner.
            const _d = (cfg.chatDelayMs && cfg.chatDelayMs[mChat[1]]) || 0;
            if (_d) { setTimeout(() => json(res, CHATS[mChat[1]]), _d); return; }
            return json(res, CHATS[mChat[1]]);
        }
        if (url.startsWith('/api/')) return json(res, {});
        // ── Statique (réplique @include + /static → racine frontend) ─
        if (url === '/' || url === '/index.html' || url === '/admin.html') {
            const f = url === '/admin.html' ? 'admin.html' : 'index.html';
            res.setHeader('content-type', 'text/html');
            res.end(applyIncludes(fs.readFileSync(path.join(ROOT, f), 'utf8')));
            return;
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
}).listen(PORT, '127.0.0.1', () => console.log(`perf-server sur http://127.0.0.1:${PORT}`));
