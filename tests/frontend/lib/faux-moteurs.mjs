// SPDX-License-Identifier: MIT
/** tests/frontend/lib/faux-moteurs.mjs — faux vLLM 0.31.0 et SGLang 0.5.21 fidèles à leur code source : santé, version, modèles (`max_model_len`), métriques Prometheus, tokenisation, complétions (jetons en cache), clé d'API. */
import http from 'node:http';

const VERSIONS = { vllm: '0.31.0', sglang: '0.5.21' };

function lireCorps(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => resolve(b));
    });
}

const attendre = (ms) => new Promise((ok) => setTimeout(ok, ms));
// Comptage grossier mais stable : un jeton pour quatre caractères (au moins un).
const compter = (texte) => Math.max(1, Math.ceil(String(texte).length / 4));
const texteMessages = (messages) => (messages || []).map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n');

// Texte d'exposition Prometheus (prometheus_client) : HELP, TYPE, compteurs en `_total` et `_created`.
function exposition(familles) {
    const lignes = [];
    for (const f of familles) {
        lignes.push(`# HELP ${f.nom} ${f.aide}`, `# TYPE ${f.nom} ${f.type}`);
        for (const e of f.echantillons) {
            const etiquettes = Object.entries(e.etiquettes).map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',');
            const suffixe = f.type === 'counter' ? '_total' : '';
            lignes.push(`${f.nom}${suffixe}{${etiquettes}} ${Number(e.valeur).toFixed(1)}`);
            if (f.type === 'counter') lignes.push(`${f.nom}_created{${etiquettes}} 1.7608e+09`);
        }
    }
    return lignes.join('\n') + '\n';
}

// Métriques de `vllm/v1/metrics/loggers.py` (v0.31.0) ; sans statistiques (`--disable-log-stats`), seules celles du serveur HTTP restent.
function metriquesVllm(o, etat) {
    const e = { engine: '0', model_name: o.modele };
    const http = [{ nom: 'http_requests', aide: 'Total number of requests by method, status and handler.', type: 'counter', echantillons: [{ etiquettes: { handler: '/v1/chat/completions', method: 'POST', status: '2xx' }, valeur: etat.completions }] }];
    if (!o.metriques) return exposition(http);
    return exposition([
        { nom: 'vllm:num_requests_running', aide: 'Number of requests in model execution batches.', type: 'gauge', echantillons: [{ etiquettes: e, valeur: etat.enCours }] },
        { nom: 'vllm:num_requests_waiting', aide: 'Number of requests waiting to be processed.', type: 'gauge', echantillons: [{ etiquettes: e, valeur: etat.enAttente }] },
        { nom: 'vllm:kv_cache_usage_perc', aide: 'KV-cache usage. 1 means 100 percent usage.', type: 'gauge', echantillons: [{ etiquettes: e, valeur: etat.kvRatio }] },
        { nom: 'vllm:prefix_cache_queries', aide: 'Prefix cache queries, in terms of number of queried tokens.', type: 'counter', echantillons: [{ etiquettes: e, valeur: etat.prefixRequetes }] },
        { nom: 'vllm:prefix_cache_hits', aide: 'Prefix cache hits, in terms of number of cached tokens.', type: 'counter', echantillons: [{ etiquettes: e, valeur: etat.prefixSucces }] },
        { nom: 'vllm:prompt_tokens', aide: 'Number of prefill tokens processed.', type: 'counter', echantillons: [{ etiquettes: e, valeur: etat.jetonsPrompt }] },
        { nom: 'vllm:generation_tokens', aide: 'Number of generation tokens processed.', type: 'counter', echantillons: [{ etiquettes: e, valeur: etat.jetonsGeneres }] },
        { nom: 'vllm:cache_config_info', aide: 'Information of the LLMEngine CacheConfig', type: 'gauge', echantillons: [{ etiquettes: { block_size: String(o.tailleBloc), cache_dtype: 'auto', enable_prefix_caching: 'True', engine: '0', gpu_memory_utilization: '0.92', kv_cache_size_tokens: String(o.blocsKv * o.tailleBloc), num_cpu_blocks: 'None', num_gpu_blocks: String(o.blocsKv), num_gpu_blocks_override: 'None' }, valeur: 1 }] },
        ...http,
    ]);
}

// Métriques de `sglang/srt/observability/metrics_collector.py` (v0.5.21) ; le total d'une file porte `priority=""`, le détail `priority="<n>"`.
function metriquesSglang(o, etat) {
    const e = { engine_type: 'unified', model_name: o.modele, pp_rank: '0', tp_rank: '0' };
    const file = (valeur, parPriorite) => [
        { etiquettes: o.priorites ? { ...e, priority: '' } : e, valeur },
        ...(o.priorites ? parPriorite.map(([p, v]) => ({ etiquettes: { ...e, priority: String(p) }, valeur: v })) : []),
    ];
    return exposition([
        { nom: 'sglang:num_running_reqs', aide: 'The number of running requests.', type: 'gauge', echantillons: file(etat.enCours, [[0, etat.enCours]]) },
        { nom: 'sglang:num_queue_reqs', aide: 'The number of requests in the waiting queue.', type: 'gauge', echantillons: file(etat.enAttente, [[0, etat.enAttente]]) },
        { nom: 'sglang:gen_throughput', aide: 'The generation throughput (token/s).', type: 'gauge', echantillons: [{ etiquettes: e, valeur: etat.debit }] },
        { nom: 'sglang:cache_hit_rate', aide: 'The prefix cache hit rate.', type: 'gauge', echantillons: [{ etiquettes: e, valeur: etat.tauxCache }] },
        { nom: 'sglang:token_usage', aide: 'The token usage.', type: 'gauge', echantillons: [{ etiquettes: e, valeur: etat.kvRatio }] },
        { nom: 'sglang:num_used_tokens', aide: 'The number of used tokens.', type: 'gauge', echantillons: [{ etiquettes: e, valeur: Math.round(etat.kvRatio * o.jetonsKv) }] },
        { nom: 'sglang:kv_used_tokens', aide: 'Number of actively used token slots in the KV cache pool.', type: 'gauge', echantillons: [{ etiquettes: e, valeur: Math.round(etat.kvRatio * o.jetonsKv) }] },
        { nom: 'sglang:kv_available_tokens', aide: 'Number of free token slots in the KV cache pool.', type: 'gauge', echantillons: [{ etiquettes: e, valeur: o.jetonsKv - Math.round(etat.kvRatio * o.jetonsKv) }] },
        { nom: 'sglang:prompt_tokens', aide: 'Number of prefill tokens processed.', type: 'counter', echantillons: [{ etiquettes: e, valeur: etat.jetonsPrompt }] },
        { nom: 'sglang:generation_tokens', aide: 'Number of generation tokens processed.', type: 'counter', echantillons: [{ etiquettes: e, valeur: etat.jetonsGeneres }] },
    ]);
}

// Démarre un faux moteur `vllm` ou `sglang` ; `script` : réponses consommées dans l'ordre (texte ou { contenu, reflexion, delaiMs }).
export async function demarrerFauxMoteur(options = {}) {
    const o = {
        type: 'vllm',
        port: 0,
        modele: 'Qwen/Qwen3-0.6B',
        contexte: 4096,
        cleApi: '',
        metriques: true,
        detailsJetons: false,
        parseurReflexion: 'qwen3',
        parseurOutils: 'qwen25',
        maxRequetes: 48,
        jetonsKv: 65536,
        blocsKv: 4096,
        tailleBloc: 16,
        priorites: false,
        parDefaut: null,
        ...options,
    };
    const sglang = o.type === 'sglang';
    const etat = {
        requetes: [], script: [], completions: 0, enCours: 0, enAttente: 0, maxEnCours: 0,
        kvRatio: 0.25, prefixRequetes: 0, prefixSucces: 0, jetonsPrompt: 0, jetonsGeneres: 0,
        debit: 0, tauxCache: 0, prefixes: new Set(), autorisations: [],
    };
    const json = (res, corps, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(corps)); };
    const vide = (res, code = 200) => { res.writeHead(code); res.end(); };
    // vLLM ne protège que /v1, /v2, /inference, /cohere ; SGLang tout sauf /health*, /ready, /metrics.
    const protegee = (url) => (sglang ? !(url.startsWith('/health') || url.startsWith('/ready') || url.startsWith('/metrics')) : ['/v1', '/v2', '/inference', '/cohere'].some((p) => url.startsWith(p)));
    const carteModele = () => (sglang
        ? { id: o.modele, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'sglang', root: o.modele, parent: null, max_model_len: o.contexte }
        : { id: o.modele, object: 'model', created: Math.floor(Date.now() / 1000), owned_by: 'vllm', root: `/modeles/${o.modele}`, parent: null, max_model_len: o.contexte, permission: [{ id: 'modelperm-faux', object: 'model_permission', created: Math.floor(Date.now() / 1000), allow_create_engine: false, allow_sampling: true, allow_logprobs: true, allow_search_indices: false, allow_view: true, allow_fine_tuning: false, organization: '*', group: null, is_blocking: false }] });

    const serveur = http.createServer(async (req, res) => {
        const url = (req.url || '/').split('?')[0];
        const corps = req.method === 'POST' ? await lireCorps(req) : '';
        let donnees = null;
        try { donnees = corps ? JSON.parse(corps) : null; } catch { donnees = null; }
        const auth = req.headers.authorization || '';
        etat.requetes.push({ methode: req.method, url, corps: donnees, autorisation: auth });
        if (o.cleApi && protegee(url) && auth !== `Bearer ${o.cleApi}`) {
            return sglang ? json(res, { error: 'Unauthorized' }, 401) : json(res, { error: 'Unauthorized' }, 401);
        }
        if (url === '/health' || (sglang && url === '/health_generate')) return vide(res);
        if (url === '/v1/models') return json(res, { object: 'list', data: [carteModele()] });
        if (url === '/metrics') {
            if (sglang && !o.metriques) return json(res, { detail: 'Not Found' }, 404);
            res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
            return res.end(sglang ? metriquesSglang(o, etat) : metriquesVllm(o, etat));
        }
        if (!sglang && url === '/version') return json(res, { version: VERSIONS.vllm });
        if (sglang && url === '/server_info') {
            return json(res, {
                model_path: o.modele, served_model_name: o.modele, port: 30000, api_key: o.cleApi || null,
                context_length: o.contexte, max_running_requests: o.maxRequetes, enable_metrics: o.metriques,
                enable_cache_report: o.detailsJetons, reasoning_parser: o.parseurReflexion, tool_call_parser: o.parseurOutils,
                launch_command: `python -m sglang.launch_server --model-path ${o.modele}`,
                status: 'ready', max_total_num_tokens: o.jetonsKv, max_req_input_len: o.contexte - 5, startup_time: 1,
                internal_states: [{ last_gen_throughput: etat.debit }], version: VERSIONS.sglang, frontend: 'python', kv_events: null,
            });
        }
        if (sglang && url === '/model_info') {
            return json(res, { model_path: o.modele, served_model_name: o.modele, tokenizer_path: o.modele, is_generation: true, reasoning_parser: o.parseurReflexion, tool_call_parser: o.parseurOutils, has_image_understanding: false, model_type: 'qwen3' });
        }
        if ((!sglang && url === '/tokenize') || (sglang && (url === '/v1/tokenize' || url === '/tokenize'))) {
            const texte = donnees && Array.isArray(donnees.messages) ? texteMessages(donnees.messages) + '\nassistant:' : String((donnees && donnees.prompt) || '');
            const n = compter(texte);
            const tokens = Array.from({ length: n }, (_, i) => 1000 + i);
            return json(res, sglang ? { tokens, count: n, max_model_len: o.contexte } : { count: n, max_model_len: o.contexte, tokens, token_strs: null });
        }
        if (url === '/v1/chat/completions') return completion(res, donnees || {});
        return json(res, sglang ? { detail: 'Not Found' } : { detail: 'Not Found' }, 404);
    });

    function prochaine(donnees) {
        const brute = etat.script.length ? etat.script.shift() : o.parDefaut ?? `Réponse du faux ${sglang ? 'SGLang' : 'vLLM'}.`;
        const r = typeof brute === 'function' ? brute(donnees) : brute;
        return typeof r === 'string' ? { contenu: r } : { contenu: '', ...r };
    }

    // Jetons du prompt repris du cache : ceux d'un préfixe déjà vu (au bloc près), comme le cache de préfixe des deux moteurs.
    function usage(donnees, contenu, reflexion) {
        const prompt = compter(texteMessages(donnees.messages));
        const prefixe = texteMessages((donnees.messages || []).slice(0, -1));
        const deja = prefixe && etat.prefixes.has(prefixe);
        etat.prefixes.add(texteMessages(donnees.messages));
        const caches = deja ? Math.floor(compter(prefixe) / o.tailleBloc) * o.tailleBloc : 0;
        const sortie = compter(contenu + reflexion);
        etat.prefixRequetes += prompt;
        etat.prefixSucces += caches;
        etat.jetonsPrompt += prompt;
        etat.jetonsGeneres += sortie;
        // UsageInfo de vLLM (serve/engine/protocol.py) et de SGLang (entrypoints/openai/protocol.py, usage_processor.py).
        if (sglang) {
            const details = o.detailsJetons && caches > 0 ? { cached_tokens: caches, image_tokens: null, audio_tokens: null, video_tokens: null } : null;
            return { prompt_tokens: prompt, total_tokens: prompt + sortie, completion_tokens: sortie, prompt_tokens_details: details, reasoning_tokens: o.parseurReflexion && reflexion ? compter(reflexion) : 0 };
        }
        const u = { prompt_tokens: prompt, total_tokens: prompt + sortie, completion_tokens: sortie, prompt_tokens_details: null, completion_tokens_details: null };
        if (o.detailsJetons) u.prompt_tokens_details = { cached_tokens: caches, created_cache_tokens: 0, multimodal_tokens: null };
        if (o.parseurReflexion) u.completion_tokens_details = { reasoning_tokens: reflexion ? compter(reflexion) : 0 };
        return u;
    }

    const sansNuls = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).filter(([, x]) => x !== null).map(([k, x]) => [k, sansNuls(x)])) : v);

    async function completion(res, donnees) {
        if (donnees.model && donnees.model !== o.modele && !sglang) {
            return json(res, { error: { message: `The model \`${donnees.model}\` does not exist.`, type: 'NotFoundError', param: 'model', code: 404 } }, 404);
        }
        etat.completions += 1;
        etat.enCours += 1;
        etat.maxEnCours = Math.max(etat.maxEnCours, etat.enCours);
        try {
            const r = prochaine(donnees);
            if (r.delaiMs) await attendre(r.delaiMs);
            const contenu = r.contenu || '';
            const reflexion = r.reflexion || '';
            const champReflexion = sglang ? 'reasoning_content' : 'reasoning';
            const id = `chatcmpl-${Date.now()}`;
            const cree = Math.floor(Date.now() / 1000);
            const u = usage(donnees, contenu, reflexion);
            if (donnees.stream !== true) {
                // vLLM : `tool_calls` vide retiré par le sérialiseur de ChatMessage ; SGLang : son ChatMessage réduit (protocol.py).
                const message = { role: 'assistant', content: contenu, refusal: null, annotations: null, audio: null, function_call: null, [champReflexion]: reflexion || null };
                if (sglang) return json(res, { id, object: 'chat.completion', created: cree, model: o.modele, choices: [{ index: 0, message: { role: 'assistant', content: contenu, reasoning_content: reflexion || null, tool_calls: null }, logprobs: null, finish_reason: 'stop', matched_stop: 151645 }], usage: u, metadata: null });
                return json(res, { id, object: 'chat.completion', created: cree, model: o.modele, choices: [{ index: 0, message, logprobs: null, finish_reason: 'stop', stop_reason: null, token_ids: null, routed_experts: null }], service_tier: null, system_fingerprint: `vllm-${VERSIONS.vllm}-faux`, usage: u, prompt_logprobs: null, prompt_token_ids: null, prompt_text: null, kv_transfer_params: null, ec_transfer_params: null, metrics: null });
            }
            res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
            // vLLM : morceaux en `exclude_unset` (premier avec prompt_token_ids, suivants avec token_ids), usage final sans nuls ; SGLang : `model_dump_json` complet.
            const envoyer = (corps) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: cree, model: o.modele, ...corps })}\n\n`);
            const choixSg = (delta, fin = null) => ({ choices: [{ index: 0, delta: { role: null, content: null, reasoning_content: null, tool_calls: null, ...delta }, logprobs: null, finish_reason: fin, matched_stop: fin ? 151645 : null }], usage: null });
            const choixVl = (delta, fin = null) => ({ choices: [{ index: 0, delta, logprobs: null, finish_reason: fin, ...(fin ? { stop_reason: null } : {}), token_ids: null }] });
            envoyer(sglang ? choixSg({ role: 'assistant', content: '' }) : { choices: [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }], prompt_token_ids: null, prompt_text: null });
            const suite = (delta, fin = null) => envoyer(sglang ? choixSg(delta, fin) : choixVl(delta, fin));
            if (reflexion) suite({ [champReflexion]: reflexion });
            for (const bout of String(contenu).match(/\s+|[^\s]{1,6}/g) || []) suite({ content: bout });
            suite({}, 'stop');
            const avecUsage = donnees.stream_options && donnees.stream_options.include_usage;
            if (avecUsage) envoyer(sglang ? { choices: [], usage: u } : { choices: [], usage: sansNuls(u), system_fingerprint: `vllm-${VERSIONS.vllm}-faux` });
            res.write('data: [DONE]\n\n');
            res.end();
        } finally {
            etat.enCours -= 1;
        }
    }

    await new Promise((ok) => serveur.listen(o.port, '127.0.0.1', ok));
    const port = serveur.address().port;
    return {
        type: o.type,
        options: o,
        etat,
        port,
        url: `http://127.0.0.1:${port}`,
        arreter: () => new Promise((ok) => { serveur.closeAllConnections?.(); serveur.close(() => ok()); }),
    };
}
