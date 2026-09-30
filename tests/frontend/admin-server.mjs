// SPDX-License-Identifier: MIT
// Harnais route-mock pour VÉRIFIER le rendu de la console admin refondue
// (2 zones : Métriques + Configuration) sans backend. Réplique @include +
// /static et mocke le boot (admin loggé) + les endpoints admin clés.
// Lancement : PERF_PORT=8903 node tests/frontend/admin-server.mjs
import http from 'http';
import fs from 'fs';
import path from 'path';

const ROOT = decodeURIComponent(new URL('../../frontend', import.meta.url).pathname);
const PORT = Number(process.env.PERF_PORT || 8903);
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

const REPORT = {
    date: '2026-06-21', generated_at: 0, scope_hours: 24,
    sections: [
        { id: 'adoption', label: 'Adoption', widgets: ['kpi_dau', 'kpi_chats', 'kpi_new_chats', 'kpi_logins'] },
        { id: 'volume', label: 'Volume', widgets: ['kpi_messages', 'kpi_tokens_24h'] },
        { id: 'charts', label: 'Graphiques', widgets: ['tokens_history'] },
    ],
    titles: { kpi_dau: 'Actifs (24h)', kpi_chats: 'Conversations actives',
              kpi_new_chats: 'Nouveaux chats', kpi_logins: 'Connexions',
              kpi_messages: 'Messages (24h)', kpi_tokens_24h: 'Tokens (24h)' },
    widgets: { kpi_dau: { value: 5, unit: '' }, kpi_chats: { value: 23, unit: '' },
               kpi_new_chats: { value: 8, unit: '' }, kpi_logins: { value: 12, unit: '' },
               kpi_messages: { value: 127, unit: '' }, kpi_tokens_24h: { value: '1.2M', unit: '' },
               tokens_history: {} },
};

// Groupes + journal des PUT d'accès aux serveurs (lot B4, 2026-09-16).
const GROUPS = [
    { id: 5, name: 'Équipe data', description: '', member_count: 0,
      llm_engine_keys: ['conn:7'], llm_can_manage_models: null },
];
const LLM_ACCESS_LOG = [];

// Sauvegarde distante : config servie + journal des POST (harnais rsync).
const REMOTE = {
    cfg: { enabled: false, connector: 'sftp', scope: 'full', host: '', port: 22,
           user: '', remote_path: '', dest_path: '', strict_host_key_checking: true,
           key_present: false, last_send: null, password_present: false,
           schedule_enabled: false, schedule_every: 1, schedule_unit: 'days', next_run_at: null },
    log: [],
};

// Journal des PATCH /api/admin/config (enregistrement champ par champ).
const CONFIG_PATCH = { log: [], conflictNext: false };

// Vue d'ensemble (lot 6) : une tournée figée, avec de quoi exercer chaque
// geste (redémarrage en attente, service injoignable, sauvegarde absente).
// ``OVERVIEW.hits`` compte les appels ; ``refresh`` celles forcées.
const OVERVIEW = { hits: 0, refresh: 0, pending: ['llama.ip', 'maintenance.hour', 'llm.task.enabled'] };
function overviewPayload() {
    const now = Date.now() / 1000;
    return {
        generated_at: now - 12, role: 'admin',
        alerts: [
            ...(OVERVIEW.pending.length ? [{ id: 'restart', level: 'warn', title: 'Redémarrage nécessaire',
              detail: OVERVIEW.pending.length + ' réglages en attente', paths: OVERVIEW.pending, action: 'restart' }] : []),
            { id: 'svc-rag', level: 'danger', title: 'RAG injoignable', detail: '127.0.0.1:8000', page: 'rag', action: 'page' },
            { id: 'backup', level: 'warn', title: 'Aucune sauvegarde enregistrée', detail: '', page: 'data', action: 'backup' },
        ],
        services: [
            { id: 'llm', label: 'Moteur local', target: '127.0.0.1:8080', state: 'ok', detail: '2 modèles chargés', page: 'inference' },
            { id: 'conn-1', label: 'vLLM interne', target: '10.0.0.5:8000', state: 'ok', detail: '3 modèles', page: 'inference' },
            { id: 'compression', label: 'Compression', target: '', state: 'ok', detail: 'Via le moteur local', page: 'compression', inherited: true },
            { id: 'rag', label: 'RAG', target: '127.0.0.1:8000', state: 'down', detail: 'Injoignable', hint: 'Network error: connection refused', page: 'rag' },
            { id: 'vision', label: 'Vision', target: '', state: 'off', detail: 'Non configurée', page: 'vision' },
            { id: 'voice', label: 'Voix', target: '10.0.0.9:9000', state: 'ok', detail: 'Transcription joignable', page: 'voice' },
            { id: 'mcp', label: 'Outils MCP', target: '', state: 'ok', detail: '57 outils', page: 'mcp' },
            { id: 'sandbox', label: 'Sandbox', target: 'Docker 27.1.1', state: 'ok', detail: '2 containers actifs', page: 'sandbox-containers' },
            { id: 'database', label: 'Base', target: 'SQLite', state: 'ok', detail: '58,0 Mo', page: 'data' },
        ],
        kpis: { users: 5, turns: 127, tokens: 1234000, failures: 1, tool_calls: 88, tool_failures: 0 },
        backup: { at: null, remote_enabled: false },
        setup: [
            { id: 'name', label: 'Nommer l’instance', done: true, page: 'instance' },
            { id: 'engine', label: 'Un moteur joignable', done: true, page: 'inference' },
            { id: 'admin-pwd', label: 'Mot de passe administrateur définitif', done: true, page: 'accounts' },
            { id: 'https', label: 'Accès HTTPS', done: false, page: 'https' },
            { id: 'backup', label: 'Sauvegarde distante', done: false, page: 'data' },
        ],
        restart: { pending: OVERVIEW.pending },
    };
}

// État de scénario du panneau « Accès HTTPS » (voir /__caddy_up plus bas).
let CADDY_UP = false;
let HTTPS_ON = false;

http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    try {
        // ── Admin endpoints ───────────────────────────────────────────
        if (url === '/api/admin/overview') {
            OVERVIEW.hits++;
            if (/[?&]refresh=1/.test(req.url)) OVERVIEW.refresh++;
            return json(res, overviewPayload());
        }
        if (url === '/api/admin/restart-status') return json(res, {
            paths: ['llama.ip', 'llama.port', 'llama.max_models', 'maintenance.hour', 'maintenance.metrics_retention_days',
                    'app_info.name_boot_demo', 'llm.task.enabled'],
            pending: OVERVIEW.pending,
        });
        if (url === '/__overview_stats') return json(res, { hits: OVERVIEW.hits, refresh: OVERVIEW.refresh });
        if (url === '/__overview_clear_restart') { OVERVIEW.pending = []; return json(res, { ok: true }); }
        if (url === '/api/admin/report/daily') return json(res, REPORT);
        if (url === '/api/admin/report/daily/list') return json(res, { reports: [{ date: '2026-06-20', created_at: 0 }] });
        if (url === '/api/admin/report/daily/auto') return json(res, { enabled: false });
        if (url === '/api/admin/report/daily/generate') return json(res, { ok: true, date: '2026-06-21' });
        // Contrat du tableau de bord : ``default`` (set curé) et ``purge``
        // (périmètre de réinitialisation) font partie du layout ; les séries
        // temporelles portent un ``meta`` (granularité + fuseau) et des
        // libellés ISO datés — plus de cadran d'horloge.
        if (url === '/api/admin/stats-dynamic') return json(res, {
            layout: [
                { id: 'kpi_dau', title: 'Utilisateurs actifs', type: 'value', width: '1/4', category: 'activity', default: true, purge: { target: 'metric_events', event_types: ['message_sent'] } },
                { id: 'usage_offhours', title: 'Hors plage', type: 'value', width: '1/4', category: 'activity', default: true, purge: { target: 'usage_events' } },
                { id: 'usage_tokens', title: 'Tokens consommés', type: 'value', width: '1/4', category: 'volume', default: true, purge: { target: 'usage_events' } },
                { id: 'kpi_avg_tps', title: 'Vitesse', type: 'value', width: '1/4', category: 'performance', default: true },
                { id: 'kpi_ram', title: 'RAM', type: 'value', width: '1/4', category: 'system', default: true },
                { id: 'usage_timeline', title: 'Consommation par source', type: 'bar_stacked', width: 'full', category: 'volume', default: true, purge: { target: 'usage_events' } },
                { id: 'usage_user_peaks', title: 'Pics par utilisateur', type: 'table', width: 'full', category: 'activity', default: true, purge: { target: 'usage_events' } },
                { id: 'legacy_hidden', title: 'Widget hors set curé', type: 'bar', width: '1/2', category: 'volume', default: false },
            ],
            data: {
                kpi_dau: { value: 5, unit: 'actifs / 30 j', icon: 'ph-user-circle', color: 'emerald' },
                usage_offhours: { value: '38.2 %', unit: 'des tokens', icon: 'ph-moon', color: 'violet', detail: '12.4 k hors 8h–19h (5 j/sem.)' },
                usage_tokens: { value: '43.4 k', unit: 'tokens/24h', icon: 'ph-lightning', color: 'emerald', detail: '41.0 k entrée · 2.4 k sortie' },
                kpi_avg_tps: { value: 52, unit: 't/s', icon: 'ph-speedometer', color: 'orange' },
                kpi_ram: { value: '4 Go', icon: 'ph-memory', color: 'purple', state: 'warn' },
                usage_timeline: {
                    labels: ['2026-06-20T22:00', '2026-06-20T23:00', '2026-06-21T00:00', '2026-06-21T01:00'],
                    datasets: [
                        { label: 'Chat', data: [1200, 0, 0, 0], backgroundColor: 'rgba(59,130,246,0.75)', stack: 'all' },
                        { label: 'Routine', data: [0, 0, 8400, 3100], backgroundColor: 'rgba(16,185,129,0.75)', stack: 'all' },
                    ],
                    meta: { granularity: 'hour', timezone: 'CEST', stacked: true },
                },
                usage_user_peaks: {
                    columns: [
                        { key: 'utilisateur', label: 'Utilisateur' },
                        { key: 'tokens', label: 'Tokens', align: 'right' },
                        { key: 'tours', label: 'Tours', align: 'right' },
                        { key: 'pic', label: 'Pic' },
                        { key: 'hors_plage', label: 'Hors plage', align: 'right' },
                    ],
                    rows: [
                        { utilisateur: 'bob', tokens: '37.8 k', tours: 12, pic: '2026-06-21T00:00', hors_plage: '100 %' },
                        { utilisateur: 'alice', tokens: '5.5 k', tours: 6, pic: '2026-06-20T22:00', hors_plage: '18.2 %' },
                    ],
                    meta: { granularity: 'hour', timezone: 'CEST' },
                },
                legacy_hidden: { labels: ['a'], datasets: [{ label: 'x', data: [1] }] },
            },
        });
        if (url === '/api/admin/metrics/scrape-token') return json(res, { configured: true, token: 'scrape-demo-token' });
        if (url === '/api/admin/metrics/purge') return json(res, { dry_run: true, counted: { usage_events: 128 }, deleted: {} });
        if (url === '/api/admin/system-prompts') return json(res, { items: [
            { category: 'CHATBOT_SYSTEM', size_chars: 5836, mtime: 0 },
            { category: 'COMPRESSOR_SYSTEM', size_chars: 2031, mtime: 0 },
            { category: 'VISION_READ', size_chars: 224, mtime: 0 },
        ] });
        if (url.startsWith('/api/admin/system-prompts/')) return json(res, { content: '# IDENTITY\nTu es un assistant.', category: 'CHATBOT_SYSTEM' });
        if (url === '/api/ax/sites') return json(res, { sites: [] });
        // Sauvegarde distante (2026-09-21 : connecteur rsync) — les POST sont
        // journalisés pour le harnais (/__remote_log).
        if (url === '/api/admin/backup/remote' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                try { REMOTE.cfg = Object.assign({}, REMOTE.cfg, JSON.parse(body || '{}')); } catch (_) {}
                // Comme le serveur : prochain envoi calculé si planifié.
                const c = REMOTE.cfg;
                c.next_run_at = (c.enabled && c.schedule_enabled)
                    ? Date.now() / 1000 + (Number(c.schedule_every) || 1) * (c.schedule_unit === 'hours' ? 3600 : 86400)
                    : null;
                REMOTE.log.push({ kind: 'config', body: JSON.parse(body || '{}') });
                json(res, { ok: true, config: REMOTE.cfg });
            });
            return;
        }
        if (url === '/api/admin/backup/remote/password' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                const pwd = (JSON.parse(body || '{}').password) || '';
                REMOTE.cfg.password_present = !!pwd;
                REMOTE.log.push({ kind: 'password', present: !!pwd, length: pwd.length });
                json(res, { ok: true, password_present: !!pwd });
            });
            return;
        }
        if (url === '/api/admin/backup/remote') return json(res, REMOTE.cfg);
        if (url === '/__remote_log') return json(res, REMOTE.log);
        // ── config.json (pages Général / Connexions / LLM / Sécurité) ──
        //  GET explicite : le POST du même chemin est traité plus bas et ne
        //  doit pas être avalé par ce handler.
        if (url === '/api/admin/config-file' && req.method === 'GET') return json(res, { content: JSON.stringify({
            llama: { ip: '127.0.0.1', port: 8080, url: '', model: 'local-model',
                     timeout_sec: 120, retries: 1, retry_backoff_sec: 0.6,
                     max_msgs: 30, max_models: 1, max_concurrency: 3 },
            app: { db_path: 'user_db/app.db', max_recent_chats: 50,
                   upload_dir: 'user_db/uploads', sandbox_dir: '../user_sandboxes',
                   enable_model_selector: true },
            app_info: { name: 'Elpis' },
            // Blocs regroupés par la page « Connexions » — présents ici pour
            // que la vérification porte sur des valeurs réelles, pas sur les
            // défauts injectés côté client.
            mcp: { server_cmd: 'python mcp_server.py', servers_dir: '../mcp_custom_servers', tools_cache_ttl_sec: 300 },
            rag: { service_url: 'http://127.0.0.1:8000', service_token: '', service_timeout: 60 },
            vision: { endpoint_url: 'http://127.0.0.1:9100/parse', format: 'omniparser', prompt: '', model: '', passes: 2 },
            desktop: { targets: [{ name: 'win-vm-01', os: 'win', agent_url: 'http://10.0.0.5:8765', default: true }],
                       screenshot_format: 'png', screenshot_quality: 85 },
            // Voix : voix VIDE côté formulaire — la liste lue sur le serveur
            // doit la pré-remplir avec la voix chargée (demande user 2026-09-23).
            voice: { enabled: true,
                     stt: { endpoint_url: 'http://10.0.0.9:8090', format: 'whisper.cpp' },
                     tts: { endpoint_url: 'http://10.0.0.9:5000', format: 'piper-http', voice: '' } },
            // Écrit par la bascule HTTPS, comme le vrai serveur : une page
            // rechargée après la bascule doit lire le nouvel état.
            security: { https: { enabled: HTTPS_ON }, session: { https_only: HTTPS_ON } },
        }) });
        // Modèles / voix CHARGÉS par les serveurs vocaux.
        if (url === '/api/admin/voice/models' && req.method === 'POST') {
            let corps = '';
            req.on('data', (c) => { corps += c; });
            req.on('end', () => {
                const b = JSON.parse(corps || '{}');
                if (b.section === 'stt') return json(res, { ok: true, source: '/health', current: '',
                    models: [{ id: '', label: 'Modèle chargé par le serveur' }],
                    detail: 'whisper.cpp ignore le champ Modèle.' });
                return json(res, { ok: true, source: '/voices', current: 'fr_FR-upmc-medium',
                    models: [{ id: 'fr_FR-siwis-medium', label: 'fr_FR-siwis-medium' },
                             { id: 'fr_FR-upmc-medium', label: 'fr_FR-upmc-medium' }] });
            });
            return;
        }
        if (url === '/api/admin/llm/connectors') return json(res, {
            connectors: [{ id: 1, provider_type: 'vllm', label: 'vLLM interne',
                           base_url: 'http://10.0.0.5:8000/v1', default_model: 'qwen3-coder-30b',
                           has_key: true, enabled: true }],
            presets: { vllm: { label: 'vLLM' }, openai: { label: 'OpenAI' } },
            all_provider_types: ['vllm', 'openai', 'anthropic', 'generic'] });
        if (url === '/api/admin/llm/allowed-providers') return json(res, {
            allowed: ['openai'], cloud_provider_types: ['openai', 'anthropic', 'mistral'] });
        if (url === '/api/admin/llm-capabilities') return json(res, {
            configured_mode: 'auto', effective_mode: 'classic', capabilities: {} });
        // Sauvegarde unifiée : le POST doit renvoyer la forme attendue par
        // saveLlmSchedulingMode (sinon configured_mode devient undefined et le
        // bloc reste « sale » après enregistrement).
        if (url === '/api/admin/llm-scheduling-mode' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                let mode = 'auto';
                try { mode = JSON.parse(body).mode || 'auto'; } catch (_) {}
                json(res, { configured_mode: mode, effective_mode: mode === 'auto' ? 'classic' : mode });
            });
            return;
        }
        // POST compression-config : renvoie CE QU'ON LUI ENVOIE, comme le vrai
        // endpoint. Un mock qui renverrait les valeurs par défaut annulerait
        // l'édition et masquerait une régression de la sauvegarde.
        if (url === '/api/admin/compression-config' && req.method === 'POST') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => { try { json(res, JSON.parse(body)); } catch (_) { json(res, {}); } });
            return;
        }
        // PATCH champ par champ (refonte 2026-09-27) : corps journalisés pour
        // le harnais ; /__config_conflict_next fait répondre 409 au suivant,
        // comme si le premier champ avait changé sur le serveur entre-temps.
        if (url === '/api/admin/config' && req.method === 'PATCH') {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch (_) {}
                CONFIG_PATCH.log.push(parsed);
                if (CONFIG_PATCH.conflictNext && parsed && !parsed.force) {
                    CONFIG_PATCH.conflictNext = false;
                    const first = (parsed.changes || [])[0] || {};
                    return json(res, { detail: 'Modifié ailleurs entre-temps.',
                                       conflicts: [{ path: first.path, current: 'valeur-serveur', absent: false }] }, 409);
                }
                json(res, { ok: true, applied: ((parsed && parsed.changes) || []).length });
            });
            return;
        }
        if (url === '/__config_patch_log') return json(res, { items: CONFIG_PATCH.log });
        if (url === '/__config_patch_reset') { CONFIG_PATCH.log.length = 0; CONFIG_PATCH.conflictNext = false; return json(res, { ok: true }); }
        if (url === '/__config_conflict_next') { CONFIG_PATCH.conflictNext = true; return json(res, { ok: true }); }
        if (url === '/api/admin/config-file' && req.method === 'POST') {
            req.on('data', () => {});
            req.on('end', () => json(res, { ok: true }));
            return;
        }
        if (url === '/api/admin/compression-config') return json(res, {
            enabled: true, trigger_after_turns: 60, pct_of_ctx: 0.7,
            endpoint_url: '', endpoint_model: '', endpoint_timeout_sec: 120 });
        // Config tab « Politique de sécurité » : sans ce mock, securityOverview
        // devient {} → le rendu lit session_cfg.global_min_ts sur undefined.
        // Page « Base de données » (lot E, 2026-09-27).
        if (url === '/api/admin/database') return json(res, {
            active: { backend: 'sqlite', version: 'SQLite 3.46.1', location: 'sqlite:/srv/elpis/user_db/app.db',
                      size_bytes: 58 * 1048576, migrations: 21, last_migration: '0021_x', pool: null },
            saved: { backend: 'sqlite', host: '127.0.0.1', port: null, name: 'elpis', user: 'elpis',
                     tls: 'off', password_present: false },
            env: [], job: { state: 'idle' } });
        if (url === '/api/admin/database/test' && req.method === 'POST') return json(res, {
            ok: true, version: 'PostgreSQL 17.11', tables: 0, empty: true, connect_ms: 4.2, query_ms: 0.31, unaccent: true });
        if (url === '/api/admin/database/simulate' && req.method === 'POST') return json(res, {
            ok: true, dry_run: true, tables: { users: { source: 3 }, chats: { source: 40 } }, ignored: { wf_old: 2 } });
        if (url === '/api/admin/database/job') return json(res, { state: 'idle' });
        if (url === '/api/admin/security/sessions') return json(res, {
            session_cfg: { global_min_ts: 0, max_age_sec: 86400, idle_timeout_sec: 0 },
            revoked_users: [], active_sessions: 0 });
        // Bascule de scénario (mock uniquement) : simule un Caddy démarré, ce
        // qui débloque le bouton « Activer le HTTPS ». Le query-string est
        // strippé plus haut, d'où cet endpoint de contrôle plutôt qu'un flag
        // d'URL.
        // RÉARME aussi HTTPS_ON : le serveur de mock survit à plusieurs
        // exécutions de la vérif, et un POST de la passe précédente laisserait
        // le panneau en « Repasser en HTTP direct » — le scénario ne trouverait
        // plus son bouton.
        if (url === '/__caddy_up') {
            CADDY_UP = true; HTTPS_ON = false;
            return json(res, { ok: true });
        }
        // Remise à l'état initial (Caddy absent, HTTP direct) — appelée en
        // TÊTE de la vérif : sans elle, une exécution précédente laissait
        // « Caddy détecté » et les contrôles du panneau désactivé tombaient.
        if (url === '/__caddy_down') {
            CADDY_UP = false; HTTPS_ON = false;
            return json(res, { ok: true });
        }
        // Panneau « Accès HTTPS » (toggle Caddy) : état initial = HTTP direct,
        // Caddy absent → le bouton Activer doit être désactivé avec aide.
        if (url === '/api/admin/security/https') {
            if (req.method === 'POST') {
                HTTPS_ON = true;   // le scénario n'active que dans ce sens
                return json(res, {
                    ok: true, enabled: true, main_restarted: true,
                    urls: { main: 'https://127.0.0.1/',
                            admin: 'https://127.0.0.1:8443/admin' } });
            }
            return json(res, {
                enabled: HTTPS_ON, ports: { main: 443, admin: 8443, rag: 8444 },
                caddy: { main: CADDY_UP, admin: CADDY_UP, rag: CADDY_UP },
                current_scheme: 'http',
                urls: HTTPS_ON
                    ? { main: 'https://127.0.0.1/', admin: 'https://127.0.0.1:8443/admin' }
                    : { main: 'http://127.0.0.1:8001/', admin: 'http://127.0.0.1:8002/admin' } });
        }
        // ── Import/export (modale de transfert) ───────────────────────
        if (url === '/api/admin/backup') {
            // Le vrai serveur construit l'archive ENTIÈRE avant d'envoyer le
            // premier octet : 2 s d'attente → la modale doit montrer la
            // compression en cours (roue + temps écoulé), pas « 0 o ».
            const buf = Buffer.alloc(256 * 1024, 7);      // 256 Ko → la progression tickera
            setTimeout(() => {
                res.statusCode = 200;
                res.setHeader('content-type', 'application/zip');
                res.setHeader('content-length', String(buf.length));
                res.setHeader('content-disposition', 'attachment; filename="backup-test.zip"');
                res.end(buf);
            }, 2000);
            return;
        }
        if (url === '/api/admin/export-metrics') {
            const csv = 'date,tokens\n2026-07-19,1234\n';
            res.statusCode = 200;
            res.setHeader('content-type', 'text/csv');
            res.setHeader('content-length', String(Buffer.byteLength(csv)));
            res.setHeader('content-disposition', 'attachment; filename="metrics.csv"');
            return res.end(csv);
        }
        if (url === '/api/admin/restore' && req.method === 'POST') {
            req.on('data', () => {});                     // draine le multipart
            // Traitement serveur après l'envoi : 1,2 s → « Restauration en cours… ».
            req.on('end', () => setTimeout(() => json(res, { restored: 3, errors: [] }), 1200));
            return;
        }
        // ── Sandbox admin (onglet exec) ───────────────────────────────
        if (url === '/api/admin/executors' && req.method === 'POST') return json(res, { ok: true });
        if (url === '/api/admin/executors') return json(res, {
            config: {
                limits: { memory_mb: 2048, cpu_quota_pct: 100, pids_max: 512, timeout_s: 600 },
                force_user_docker: false, idle_kill_hours: 24,
                exec_user: '10001:10001', runtime: '',
                extra_run_args: ['--shm-size=2g'], 
                network_profiles: [
                    { id: 'isolated', name: 'Isolé', mode: 'none', ips: [], description: 'Aucun accès réseau.' },
                    { id: 'lan', name: 'LAN filtré', mode: 'allowlist_ip', ips: ['10.20.0.0/24'],
                      domains: ['github.com'], ports: [443], dns: [], description: 'Accès au LAN.' },
                ],
            },
            image: 'elpis/sandbox:1.5.0',
        });
        if (url === '/api/admin/executors/healthcheck') return json(res, {
            daemon_ok: true, server_version: '27.1.1', image: 'elpis/sandbox:1.5.0',
            image_loaded: true, archive_available: true, image_load_state: 'loaded' });
        if (url === '/api/admin/sandbox/containers') return json(res, { containers: [
            { id: 'c1', name: 'elpis-sb-alice', image: 'elpis/sandbox:1.5.0', state: 'running', status: 'Up 2 hours', user_id: 2, username: 'alice' },
            { id: 'c2', name: 'elpis-sb-bob', image: 'elpis/sandbox:1.5.0', state: 'exited', status: 'Exited (0) 3 days ago', user_id: 3, username: 'bob' },
        ], count: 2 });
        // Comptes : la colonne « Réseau sandbox » a besoin des profils ET des
        // deux clés par utilisateur (choix effectif + imposition admin).
        // Accès aux serveurs (lot B4) : alice = défaut (tout), bob = liste
        // PROPRE (intégré seul) + gestion interdite, carol = héritée d'un groupe.
        if (url === '/api/admin/users-with-groups') return json(res, {
            users: [
                { id: 2, username: 'alice', is_admin: 0, group_names: '', group_ids: [], avatar: null,
                  sandbox_quota_mb: 5120, sandbox_used_mb: 120,
                  network_profile_id: 'lan', forced_network_profile_id: '',
                  llm_engine_keys: null, llm_can_manage_models: null,
                  llm_effective_engine_keys: null, llm_engine_source: 'default',
                  llm_effective_can_manage_models: true, llm_manage_source: 'default' },
                { id: 3, username: 'bob', is_admin: 0, group_names: '', group_ids: [], avatar: null,
                  sandbox_quota_mb: 5120, sandbox_used_mb: 40,
                  network_profile_id: 'isolated', forced_network_profile_id: 'isolated',
                  llm_engine_keys: ['builtin'], llm_can_manage_models: false,
                  llm_effective_engine_keys: ['builtin'], llm_engine_source: 'user',
                  llm_effective_can_manage_models: false, llm_manage_source: 'user' },
            ],
            network_profiles: [
                { id: 'isolated', name: 'Isolé', mode: 'none' },
                { id: 'lan', name: 'LAN filtré', mode: 'allowlist_ip' },
            ],
            // Machines desktop (accès par machine, 2026-09-23).
            desktop_targets: [
                { name: 'vm-lab', os: 'linux', access: 'all', allowed_users: [] },
                { name: 'vm-prod', os: 'win', access: 'list', allowed_users: ['bob'] },
            ],
        });
        if (url.startsWith('/api/admin/users/') && url.endsWith('/network-profile')) {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                let pid = '';
                try { pid = JSON.parse(body).profile_id || ''; } catch (_) {}
                LLM_ACCESS_LOG.push({ url, body: { profile_id: pid || null } });
                json(res, { ok: true, forced_network_profile_id: pid,
                            network_profile_id: pid || 'isolated', container_destroyed: !!pid });
            });
            return;
        }
        if (url === '/api/admin/groups') return json(res, { groups: GROUPS });
        if (url === '/api/admin/llm/engine-options') return json(res, { engines: [
            { key: 'builtin', label: 'Serveur intégré', kind: 'builtin', provider_type: 'llamacpp', enabled: true },
            { key: 'conn:7', label: 'Serveur 2', kind: 'connector', provider_type: 'llamacpp', base_url: 'http://s2:8080', enabled: true },
            { key: 'conn:8', label: 'Cloud équipe', kind: 'connector', provider_type: 'openai', base_url: '', enabled: false },
        ] });
        // Journal des écritures d'accès, relu par le verify.
        if (url === '/__llm_access_log') return json(res, { items: LLM_ACCESS_LOG });
        if (url === '/__llm_access_reset') { LLM_ACCESS_LOG.length = 0; return json(res, { ok: true }); }
        if ((req.method === 'PUT' || req.method === 'POST')
            && /^\/api\/admin\/(users|groups)\/\d+\/(llm-access|groups|role|sandbox-quota|desktop-targets)$/.test(url)) {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(body); } catch (_) {}
                LLM_ACCESS_LOG.push({ url, body: parsed });
                if (url.endsWith('/desktop-targets')) return json(res, { ok: true, desktop_targets: [
                    { name: 'vm-lab', os: 'linux', access: 'all', allowed_users: [] },
                    { name: 'vm-prod', os: 'win', access: 'list', allowed_users: (parsed.targets || []).includes('vm-prod') ? ['bob', 'alice'] : ['bob'] },
                ] });
                json(res, { ok: true, ...(parsed || {}) });
            });
            return;
        }
        // Supervision › Exécutions (L5.7)
        if (url.startsWith('/api/admin/runs/accounts')) return json(res, { hours: 24, items: [
            { user_id: 3, username: 'alice', runs: 2, failed: 1, subagents: 1, input_tokens: 14000, output_tokens: 1400,
              llm_ms: 6000, wait_ms: 500, tool_calls: 2, tool_errors: 1, files_changed: 1,
              sandbox_cpu_peak: 80, sandbox_mem_peak_mb: 512 }] });
        if (url.startsWith('/api/admin/runs/chat-a1/timeline')) return json(res, {
            run: { id: 'chat-a1', status: 'ok', started_at: 1781000000, ended_at: 1781000060, input_tokens: 1000,
                   output_tokens: 100, tool_calls: 1, tool_errors: 0, files_changed: 1, engine: 'llama' },
            events: [{ type: 'tool', at: 1781000004, tool_name: 'execute_shell', status: 'success',
                       duration_ms: 10, argument: 'command: ls', result: 'ok' }], children: [] });
        if (url === '/api/admin/oauth/clients') return json(res, { items: [
            { client_id: 'elpis-abc', kind: 'dcr', name: 'Éditeur de recette', grants: 1, redirect_uris: ['http://127.0.0.1:1/cb'] }] });
        if (url === '/api/admin/runs') {
            const filtre = /user_id=3/.test(req.url);
            return json(res, { items: [
                { id: 'chat-a1', kind: 'chat', user_id: 3, username: 'alice', status: 'ok', started_at: 1781000000,
                  ended_at: 1781000060, input_tokens: 1000, output_tokens: 100, prefill_ms: 2000, decode_ms: 3000,
                  tool_calls: 2, tool_errors: 1, engine: 'llama' },
                ...(filtre ? [] : [{ id: 'routine-b1', kind: 'routine', user_id: 4, username: 'bob', status: 'error',
                  started_at: 1781000100, ended_at: 1781000110, input_tokens: 0, output_tokens: 0, tool_calls: 0 }]),
            ] });
        }
        if (url === '/api/admin/observability/tool-summary') return json(res, { totals: {}, per_tool: [], recent_failures: [] });
        if (url === '/api/admin/observability/tool-failures') return json(res, { items: [], total: 0 });
        if (url === '/api/admin/observability/audit-recent') return json(res, { items: [] });
        if (url === '/api/admin/logs/recent') return json(res, { items: [
            { ts: 1781000000, level: 'ERROR', service: 'main', category: 'llm', message: 'routine 7 : échec réseau' },
            { ts: 1781000060, level: 'INFO', service: 'admin', category: 'http', message: 'GET /api/admin/stats-dynamic 200' },
        ] });
        // ── Boot (admin loggé) ────────────────────────────────────────
        if (url === '/api/public-config') return json(res, { app_info: { name: 'Elpis' }, features: {} });
        if (url === '/api/me-lite') return json(res, { logged_in: true, id: 1, username: 'admin', is_admin: 1, role: 'admin' });
        // Registre des skins : les intégrés ACTIVÉS par défaut (Kiki ne l'est pas).
        if (url === '/api/skins') return json(res, { default: 'elpis',
            skins: JSON.parse(fs.readFileSync(path.join(ROOT, 'css/skins/skins.json'), 'utf8')).skins
                .filter((s) => s.enabled_by_default !== false) });
        if (url === '/api/llm/models') return json(res, { models: ['m1'], models_with_status: [{ id: 'm1', status: 'loaded' }], server_reachable: true, status: 'ok' });
        if (url === '/api/notifications/unread-count') return json(res, { count: 0 });
        if (url === '/api/system-events') {
            res.statusCode = 200; res.setHeader('content-type', 'text/event-stream');
            res.write(': ping\n\n'); const t = setInterval(() => res.write(': ping\n\n'), 15000);
            req.on('close', () => clearInterval(t)); return;
        }
        if (url.startsWith('/api/')) return json(res, {});
        // ── Statique ──────────────────────────────────────────────────
        if (url === '/' || url === '/admin' || url === '/admin.html') {
            res.setHeader('content-type', 'text/html');
            res.end(applyIncludes(fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8'))); return;
        }
        const rel = url.startsWith('/static/') ? url.slice(8) : url.slice(1);
        const p = path.join(ROOT, rel);
        if (!p.startsWith(ROOT)) { res.statusCode = 403; res.end(); return; }
        res.setHeader('content-type', MIME[path.extname(p)] || 'application/octet-stream');
        res.end(fs.readFileSync(p));
    } catch (e) { res.statusCode = 404; res.end('nf'); }
}).listen(PORT, '127.0.0.1', () => console.log(`admin-server sur http://127.0.0.1:${PORT}`));
