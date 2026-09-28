// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER trois onglets de la modal Paramètres, sans
// backend : « Utilisation » (le bloc Outils a été retiré), « Mémoire » (mode
// édition : PUT /api/memory/state/{user|memory}) et « Fonctionnalités »
// (hiérarchie modules / réglages de l'éditeur).
// Lancement : PERF_PORT=8942 node tests/frontend/settings-tabs-server.mjs
//
// - GET /api/usage/me sert le payload du VRAI backend depuis 2026-08-16, c.-à-d.
//   SANS clé « tools » : si la page y touchait encore, elle planterait ici — ce
//   qu'aucun mock portant l'ancien champ n'aurait montré.
// - GET /api/memory/state sert l'état mémoire ; PUT /api/memory/state/{kind}
//   capture chaque corps (inspection /__puts) et applique comme le backend
//   (liste vide ⇒ fichier supprimé). /__cfg?reject=limit force un 400 pour
//   vérifier le chemin de refus.
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8942);
const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2',
               '.ttf': 'font/ttf', '.json': 'application/json' };

const USER_LIMIT = 1375;
const MEM_LIMIT = 2200;

const DEFAULT_MEM = () => ({
    user: ['Prénom : Alice', 'Travaille en français'],
    memory: ['Le dépôt vit dans /srv/projet', 'Les tests passent par pytest'],
});
let MEM = DEFAULT_MEM();
let PUTS = [];
let REJECT = '';           // '' | 'limit'

// Réplique de _serialize côté store : entrées jointes par une ligne « § ».
const serialize = (list) => list.join('\n§\n');

function fileStat(kind) {
    const list = MEM[kind];
    const limit = kind === 'user' ? USER_LIMIT : MEM_LIMIT;
    const chars = list.length ? serialize(list).length : 0;
    return {
        exists: list.length > 0, path: `/tmp/${kind}.md`, limit, chars,
        usage_pct: limit ? Math.round(1000 * chars / limit) / 10 : 0,
        n_entries: list.length, entries: list.slice(),
        entry_ids: list.map((_, i) => 'id' + i), last_modified: 1755300000,
    };
}
const memState = () => ({
    username: 'alice', user_md: fileStat('user'), memory_md: fileStat('memory'), scopes: [],
});

// Payload d'usage — miroir exact de shared_infra/routes/usage.py (plus de clé « tools »).
const USAGE = (days) => ({
    days, since: 1755000000,
    chats: { active: 12, archived: 3, total: 15 },
    messages: { sent: 148, received: 151 },
    // La SORTIE est découpée : thinking + response == output (le raisonnement
    // n'est pas un troisième poste, il ne s'ajoute pas au total).
    tokens: { input: 820000, output: 96000, total: 916000, estimated: false,
              thinking: 72000, response: 24000,
              split_available: true,
              by_source: [{ source: 'chat', tokens: 700000, turns: 120 },
                          { source: 'routine', tokens: 216000, turns: 30 }] },
    routines: { runs: 9, ok: 8, error: 1, input_tokens: 1000, output_tokens: 200,
                avg_duration_ms: 4200 },
});

// Onglet Fonctionnalités : l'éditeur part COUPÉ (ses réglages ne doivent pas
// être rendus) et porte des valeurs non-défaut, pour prouver que chaque contrôle
// est bien lié à sa clé et pas à un défaut qui masquerait l'erreur.
const SETTINGS = {
    memory_enabled: true, agents_enabled: false, hide_thinking: false,
    enable_mcp: true, enable_editor: false, enable_rag: false, enable_preview: false,
    editor_dark_mode: true, auto_open_editor_on_write: true,
    editor_font_size: 17, editor_font_family: 'Fira Code',
    editor_tab_size: 8, editor_insert_spaces: false,
    editor_word_wrap: 'bounded', editor_minimap: false, editor_line_numbers: true,
    editor_edit_highlight: true, editor_auto_save: '1min', editor_persist_tabs: false,
    assistant_name: 'Elpis', skin: '', custom_agents: [], mcp_servers: [],
    // Compaction automatique : ON avec seuil AUTO (0). L'onglet « Chat »
    // n'affiche le curseur de seuil que dans cet état.
    compression_enabled: true, compression_threshold_pct: 0,
    compression_threshold_tokens: 0,
    // Compactions max par conversation : 0 = plafond de l'instance.
    compression_max_rounds: 0,
};
// Corps des PUT /api/settings — liste SÉPARÉE de PUTS (celle-ci ne porte que
// les magasins mémoire, et son test assert « un SEUL magasin envoyé »).
let SETTINGS_PUTS = [];

// Prompts sauvegardés — trois dates ESPACÉES (années distinctes) et un contenu
// accentué : le tri et la recherche insensible aux accents doivent se prouver.
// Le premier porte du Markdown ET des chevrons littéraux : un prompt est un
// TEXTE SOURCE, il doit ressortir intact de l'affichage comme de la copie.
const DEFAULT_PROMPTS = () => ([
    { id: 3, title: 'Bug report', created_at: 1755300000,
      content: '# Bug report\n\n**Contexte** : `git bisect` sur `main`.\n\n- [ ] étapes\n- [x] attendu\n\n```bash\nnpm test -- --grep "auth"\n```\n\n<résumé> & <details> à conserver.' },
    { id: 2, title: 'Analyse de logs', created_at: 1750000000,
      content: 'Cherche les erreurs récurrentes dans ces journaux applicatifs et classe-les par fréquence.' },
    { id: 1, title: 'Résumé de réunion', created_at: 1723000000,
      content: 'Fais un résumé structuré de la réunion : décisions, points ouverts, prochaines actions.' },
]);
let PROMPTS = DEFAULT_PROMPTS();

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

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        if (url === '/__cfg') {
            const q = new URLSearchParams(req.url.split('?')[1] || '');
            MEM = DEFAULT_MEM();
            PROMPTS = DEFAULT_PROMPTS();
            PUTS = [];
            SETTINGS_PUTS = [];
            // Seuil de compaction servi au GET (défaut 0 = auto).
            SETTINGS.compression_threshold_pct = Number(q.get('seuil') || 0);
            SETTINGS.compression_threshold_tokens = Number(q.get('seuil_tk') || 0);
            SETTINGS.compression_enabled = q.get('compaction') !== '0';
            SETTINGS.compression_max_rounds = Number(q.get('rounds') || 0);
            REJECT = q.get('reject') || '';
            return json(res, { ok: true, memory: MEM });
        }
        if (url === '/__puts') return json(res, { items: PUTS });
        if (url === '/__settings_puts') return json(res, { items: SETTINGS_PUTS });
        if (url === '/api/usage/me') {
            const q = new URLSearchParams(req.url.split('?')[1] || '');
            return json(res, USAGE(Number(q.get('days') || 30)));
        }
        if (url === '/api/memory/state' && req.method === 'GET') return json(res, memState());
        if (url.startsWith('/api/memory/state/') && req.method === 'PUT') {
            const kind = url.slice('/api/memory/state/'.length);
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                let body = {};
                try { body = JSON.parse(raw); } catch (_) {}
                PUTS.push({ kind, entries: body.entries });
                if (kind !== 'user' && kind !== 'memory') return json(res, { detail: 'magasin inconnu' }, 404);
                if (REJECT === 'limit') {
                    return json(res, { detail: 'exceeds the limit (9999/1375 chars); rewrite shorter' }, 400);
                }
                MEM[kind] = (body.entries || []).map(e => String(e || '').trim()).filter(Boolean);
                json(res, { ok: true, state: fileStat(kind) });
            });
            return;
        }
        if (url === '/api/memory/audit') return json(res, { count: 0, summary: {}, entries: [] });
        // Le backend rend les prompts déjà triés par date DESC ; le tri de la
        // page doit donc pouvoir INVERSER cet ordre, pas seulement le refléter.
        if (url === '/api/prompts' && req.method === 'GET') return json(res, { items: PROMPTS });
        if (url === '/api/prompts/shared') return json(res, { items: [] });
        if (url.startsWith('/api/prompts/') && req.method === 'DELETE') {
            const id = Number(url.split('/').pop());
            PROMPTS = PROMPTS.filter(p => p.id !== id);
            return json(res, { ok: true });
        }
        if (url === '/api/settings' && req.method === 'GET') return json(res, SETTINGS);
        if (url === '/api/settings' && req.method === 'PUT') {
            let raw = '';
            req.on('data', (c) => { raw += c; });
            req.on('end', () => {
                try { SETTINGS_PUTS.push(JSON.parse(raw)); } catch (_) {}
                json(res, { ok: true });
            });
            return;
        }
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'alice', is_admin: 0, role: 'user' });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/skills') return json(res, { skills: [], count: 0 });
        if (url === '/api/saved/chats') return json(res, { items: [] });
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
}).listen(PORT, '127.0.0.1', () => console.log(`settings-tabs-server sur http://127.0.0.1:${PORT}`));
