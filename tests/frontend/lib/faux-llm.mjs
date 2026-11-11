// SPDX-License-Identifier: MIT
/** tests/frontend/lib/faux-llm.mjs — faux moteur compatible OpenAI/llama-server, ou vLLM 0.31.0 / SGLang 0.5.21 à leur format exact (`dialecte`) : réponses scriptées (texte, raisonnement, appels d'outils, coupure, erreur HTTP) streamées en SSE, cadencées */
import http from 'node:http';

// Découpe un texte en jetons courts (mots et espaces), comme un moteur réel.
export function jetons(texte) {
    return String(texte).match(/\s+|[^\s]{1,6}/g) || [];
}

function lireCorps(req) {
    return new Promise((resolve) => {
        let b = '';
        req.on('data', (c) => { b += c; });
        req.on('end', () => resolve(b));
    });
}

// Jetons d'un modèle Qwen détokenisés : `</think>` reste un jeton entier.
function jetonsModele(texte) {
    return String(texte).match(/<\/think>|\s+|[^\s<]{1,6}|</g) || [];
}

// Démarre le faux moteur (inventaire de routeur : `statut` du modèle, « loaded » par défaut ; `dialecte` : llamacpp, vllm ou sglang) ; `script` : réponses streamées consommées dans l'ordre, `annexes` : réponses sans flux (résumés), puis `parDefaut`.
export async function demarrerFauxLlm({ port = 0, modele = 'faux-modele', tokParS = 120, parDefaut = 'Réponse du faux moteur.', slots = 1, nCtx = 32768, gabarit = '', statut = 'loaded', autres = [], dialecte = 'llamacpp' } = {}) {
    const etat = { file: [], annexes: [], titres: [], requetes: [], tokParS, parDefaut, titreParDefaut: 'Titre du faux moteur', slots, nCtx, gabarit, tokenizeKo: false, statut, autres, controleKo: false, flux: new Map(), controles: [], dialecte };
    let numero = 0;
    // Modèles du routeur : le principal (gabarit et statut de l'état) puis `autres` ({ id, gabarit, statut }).
    const modeles = () => [{ id: modele, gabarit: etat.gabarit, statut: etat.statut }, ...etat.autres];
    const json = (res, o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    const serveur = http.createServer(async (req, res) => {
        const url = (req.url || '/').split('?')[0];
        const demande = new URLSearchParams((req.url || '').split('?')[1] || '').get('model');
        const corps = req.method === 'POST' ? await lireCorps(req) : '';
        let donnees = null;
        try { donnees = corps ? JSON.parse(corps) : null; } catch { donnees = null; }
        etat.requetes.push({ methode: req.method, url, corps: donnees });
        if (etat.dialecte !== 'llamacpp') return routeDialecte(req, res, url, donnees);
        if (url === '/health') return json(res, { status: 'ok' });
        if (url === '/v1/models' || url === '/models') {
            return json(res, { object: 'list', data: modeles().map((m) => ({ id: m.id, object: 'model', owned_by: 'faux', status: { value: m.statut || 'loaded' }, meta: { n_ctx_train: etat.nCtx } })) });
        }
        if (url === '/props') {
            const m = modeles().find((x) => x.id === demande) || modeles()[0];
            return json(res, { default_generation_settings: { n_ctx: etat.nCtx }, total_slots: etat.slots, model_path: m.id, ...(m.gabarit ? { chat_template: m.gabarit } : {}) });
        }
        if (url === '/models/load' && req.method === 'POST') {
            const m = etat.autres.find((x) => x.id === (donnees && donnees.model));
            if (m) m.statut = 'loaded';
            return json(res, { success: true });
        }
        if (url === '/slots') return json(res, Array.from({ length: etat.slots }, (_, id) => ({ id, n_ctx: etat.nCtx, is_processing: false })));
        if (url === '/tokenize') {
            if (etat.tokenizeKo) return json(res, { error: { message: 'tokenize indisponible' } }, 500);
            const texte = donnees && typeof donnees.content === 'string' ? donnees.content : '';
            return json(res, { tokens: Array.from({ length: Math.ceil(texte.length / 4) }, (_, i) => i) });
        }
        if (url === '/apply-template') {
            const msgs = (donnees && donnees.messages) || [];
            return json(res, { prompt: msgs.map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`).join('\n') });
        }
        if (url === '/v1/chat/completions/control') {
            etat.controles.push(donnees);
            const enCours = etat.flux.get(donnees && donnees.id);
            if (etat.controleKo || !enCours || (donnees && donnees.action) !== 'reasoning_end') return json(res, { error: { message: 'contrôle refusé' } }, 404);
            enCours.finRaisonnement = true;
            return json(res, { success: true });
        }
        if (url === '/v1/chat/completions' || url === '/chat/completions') return completion(res, donnees);
        return json(res, { error: { message: `route inconnue du faux moteur : ${url}` } }, 404);
    });

    // Le titre d'un nouveau chat (`user: "title"`) a sa propre file : il ne consomme jamais une réponse scriptée.
    function prochaineReponse(donnees, flux, titre) {
        const file = titre ? etat.titres : flux ? etat.file : etat.annexes;
        const brute = file.length ? file.shift() : titre ? etat.titreParDefaut : etat.parDefaut;
        const r = typeof brute === 'function' ? brute(donnees || {}) : brute;
        return typeof r === 'string' ? { contenu: r } : { contenu: '', ...r };
    }

    // Routes de vLLM et SGLang : santé, inventaire sans statut (rien de llama.cpp), complétions à leur format.
    function routeDialecte(req, res, url, donnees) {
        if (url === '/health') { res.writeHead(200); return res.end(); }
        if (url === '/v1/models') {
            const entree = (m) => etat.dialecte === 'vllm'
                ? { id: m.id, object: 'model', created: 1760880000, owned_by: 'vllm', root: m.id, parent: null, max_model_len: etat.nCtx, permission: [] }
                : { id: m.id, object: 'model', created: 1760880000, owned_by: 'sglang', root: m.id, max_model_len: etat.nCtx };
            return json(res, { object: 'list', data: modeles().map(entree) });
        }
        if (url === '/v1/chat/completions' && req.method === 'POST') return completion(res, donnees);
        return json(res, { detail: 'Not Found' }, 404);
    }

    // Réponse au format exact de vLLM 0.31.0 (`exclude_unset`) ou de SGLang 0.5.21 (msgspec) ; sans `parseur`, la réflexion arrive en balises dans le contenu (`ouvertureParGabarit` : seule la fermante).
    function completionDialecte(res, r, appels, fin, flux, id) {
        const vllm = etat.dialecte === 'vllm';
        const parseur = r.parseur !== false;
        const ouverture = r.ouvertureParGabarit ? '' : '<think>\n';
        const brut = r.raisonnement && !parseur ? `${ouverture}${r.raisonnement}\n</think>\n\n${r.contenu}` : r.contenu;
        const nRais = parseur && r.raisonnement ? jetonsModele(r.raisonnement).length : 0;
        const nSortie = jetonsModele(brut).length + nRais;
        const usage = vllm
            ? { prompt_tokens: 42, total_tokens: 42 + nSortie, completion_tokens: nSortie, ...(parseur ? { completion_tokens_details: { reasoning_tokens: nRais } } : {}) }
            : { prompt_tokens: 42, total_tokens: 42 + nSortie, completion_tokens: nSortie, prompt_tokens_details: null, reasoning_tokens: nRais };
        const tete = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modele };
        const outils = appels.map((a, i) => ({ id: vllm ? `chatcmpl-tool-${i}a7c` : `call_${i}e41`, ...(vllm ? {} : { index: i }), type: 'function', function: { name: a.nom, arguments: a.args } }));
        if (!flux) {
            const raisonnement = parseur && r.raisonnement ? r.raisonnement : null;
            const message = vllm
                ? { role: 'assistant', content: brut, refusal: null, annotations: null, audio: null, function_call: null, ...(outils.length ? { tool_calls: outils } : {}), reasoning: raisonnement }
                : { role: 'assistant', content: brut, reasoning_content: raisonnement, tool_calls: outils.length ? outils : null };
            const choix = vllm ? { index: 0, message, logprobs: null, finish_reason: fin, stop_reason: null, token_ids: null } : { index: 0, message, logprobs: null, finish_reason: fin, matched_stop: 151645 };
            return json(res, { ...tete, object: 'chat.completion', choices: [choix], usage });
        }
        const choix = (delta, finale = null) => (vllm
            ? (finale === null ? { index: 0, delta, logprobs: null, finish_reason: null, token_ids: null } : { index: 0, delta, logprobs: null, finish_reason: finale, stop_reason: null, token_ids: null })
            : { index: 0, delta, logprobs: null, finish_reason: finale, matched_stop: finale === 'stop' ? 151645 : null });
        const texte = (t) => (vllm ? { content: t } : { reasoning_content: null, content: t });
        const pensee = (t) => (vllm ? { reasoning: t } : { reasoning_content: t });
        const morceaux = [vllm ? { ...tete, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, logprobs: null, finish_reason: null }] } : { ...tete, choices: [choix({ reasoning_content: null, role: 'assistant', content: '' })] }];
        if (parseur) {
            for (const t of jetonsModele(r.raisonnement || '')) morceaux.push({ ...tete, choices: [choix(pensee(t))] });
            for (const t of jetonsModele(r.contenu)) morceaux.push({ ...tete, choices: [choix(texte(t))] });
        } else for (const t of jetonsModele(brut)) morceaux.push({ ...tete, choices: [choix(texte(t))] });
        outils.forEach((o, index) => {
            const appel = (fonction, debut) => (vllm ? (debut ? { id: o.id, type: 'function', index, function: fonction } : { index, function: fonction }) : { id: debut ? o.id : null, index, type: 'function', function: fonction });
            const delta = (fonction, debut) => (vllm ? { tool_calls: [appel(fonction, debut)] } : { role: null, content: null, reasoning_content: null, tool_calls: [appel(fonction, debut)] });
            const pousser = (d) => morceaux.push({ ...tete, choices: [choix(d)], ...(vllm ? {} : { usage: null }) });
            pousser(delta({ name: o.function.name, arguments: '' }, true));
            for (const p of o.function.arguments.match(/[\s\S]{1,12}/g) || []) pousser(delta(vllm ? { arguments: p } : { name: null, arguments: p }, false));
        });
        morceaux.push({ ...tete, choices: [choix(vllm ? { content: '' } : { reasoning_content: null }, fin)] });
        morceaux.push({ ...tete, choices: [], usage });
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
        let ferme = false;
        res.on('close', () => { ferme = true; });
        const periode = Math.max(1, 1000 / (r.tokParS || etat.tokParS));
        let i = 0;
        const pas = async () => {
            if (ferme) return;
            for (const b of [r.retenue, ...(r.retenues || [])]) if (b && i === b.apres && !b.passee) { b.passee = true; await b.promesse; }
            if (ferme) return;
            if (i < morceaux.length) {
                res.write(`data: ${JSON.stringify(morceaux[i++])}\n\n`);
                setTimeout(pas, periode);
                return;
            }
            res.write('data: [DONE]\n\n');
            res.end();
        };
        setTimeout(pas, r.attenteMs || 0);
    }

    function completion(res, donnees) {
        const flux = !!donnees && donnees.stream === true;
        const r = prochaineReponse(donnees, flux, !!donnees && donnees.user === 'title');
        if (r.erreur) return json(res, { error: { code: r.erreur.statut || 500, message: r.erreur.message || 'erreur du faux moteur', type: r.erreur.type || 'server_error' } }, r.erreur.statut || 500);
        const id = `chatcmpl-${Date.now()}-${++numero}`;
        const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modele };
        const appels = (r.appels || []).map((a, i) => ({ id: a.id || `appel_${Date.now()}_${i}`, nom: a.nom, args: typeof a.args === 'string' ? a.args : JSON.stringify(a.args || {}) }));
        const fin = r.fin || (appels.length ? 'tool_calls' : 'stop');
        if (etat.dialecte !== 'llamacpp') return completionDialecte(res, r, appels, fin, flux, id);
        const sortie = jetons(r.contenu).length + (r.raisonnement ? jetons(r.raisonnement).length : 0);
        const usage = { prompt_tokens: 42, completion_tokens: sortie, total_tokens: 42 + sortie, ...(r.usage || {}) };
        const timings = { prompt_n: usage.prompt_tokens, predicted_n: usage.completion_tokens, predicted_per_second: r.tokParS || etat.tokParS, ...(r.timings || {}) };
        if (!flux) {
            const message = { role: 'assistant', content: r.contenu };
            if (r.raisonnement) message.reasoning_content = r.raisonnement;
            if (appels.length) message.tool_calls = appels.map((a) => ({ id: a.id, type: 'function', function: { name: a.nom, arguments: a.args } }));
            return json(res, { ...base, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: fin }], usage, timings });
        }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const envoyer = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        const morceaux = [...(r.raisonnement ? jetons(r.raisonnement).map((t) => ({ reasoning_content: t })) : []),
            ...jetons(r.contenu).map((t) => ({ content: t })),
            ...appels.flatMap((a, index) => [
                { tool_calls: [{ index, id: a.id, type: 'function', function: { name: a.nom, arguments: '' } }] },
                ...(a.args.match(/[\s\S]{1,12}/g) || []).map((p) => ({ tool_calls: [{ index, function: { arguments: p } }] })),
            ])];
        let i = 0;
        let ferme = false;
        const suivi = { finRaisonnement: false };
        etat.flux.set(id, suivi);
        res.on('close', () => { ferme = true; etat.flux.delete(id); });
        const progression = [...(r.progression || [])];
        // Progression du pré-remplissage (`prompt_progress` de llama-server), chaque étape après son `attenteMs`.
        const prefill = () => {
            if (ferme) return;
            const etape = progression.shift();
            if (!etape) {
                envoyer({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
                setTimeout(pas, periode);
                return;
            }
            const { attenteMs = 300, ...pp } = etape;
            setTimeout(() => { if (!ferme) { res.write(`data: ${JSON.stringify({ ...base, choices: [], prompt_progress: pp })}\n\n`); prefill(); } }, attenteMs);
        };
        const periode = Math.max(1, 1000 / (r.tokParS || etat.tokParS));
        const pas = async () => {
            if (ferme) return;
            for (const b of [r.retenue, ...(r.retenues || [])]) if (b && i === b.apres && !b.passee) { b.passee = true; await b.promesse; }
            if (ferme) return;
            // `reasoning_end` reçu : le reste du raisonnement est sauté, la réponse suit dans le même flux.
            if (suivi.finRaisonnement) while (i < morceaux.length && 'reasoning_content' in morceaux[i]) i++;
            if (i < morceaux.length) {
                envoyer({ ...base, choices: [{ index: 0, delta: morceaux[i++], finish_reason: null }] });
                setTimeout(pas, periode);
                return;
            }
            envoyer({ ...base, choices: [{ index: 0, delta: {}, finish_reason: fin }], usage, timings });
            res.write('data: [DONE]\n\n');
            res.end();
        };
        setTimeout(prefill, r.attenteMs || 0);
    }

    await new Promise((resolve) => serveur.listen(port, '127.0.0.1', resolve));
    const adresse = serveur.address();
    return {
        port: adresse.port,
        url: `http://127.0.0.1:${adresse.port}`,
        etat,
        // Ajoute des réponses streamées : texte, fonction (corps de la requête → réponse) ou {contenu, raisonnement, appels:[{nom, args}], fin, erreur:{statut, message}, usage, timings, tokParS, attenteMs, progression:[{total, cache, processed, time_ms, attenteMs}], retenue:{apres, promesse}, retenues:[…], parseur, ouvertureParGabarit (vLLM/SGLang)} ; une barrière tient le flux avant le morceau n° `apres`.
        scripter(...reponses) { etat.file.push(...reponses); },
        // Ajoute des réponses aux appels sans flux (résumé de compaction…).
        scripterAnnexe(...reponses) { etat.annexes.push(...reponses); },
        // Ajoute des titres de nouveaux chats.
        scripterTitre(...titres) { etat.titres.push(...titres); },
        // Appels de génération (hors titres de chat).
        completions() { return etat.requetes.filter((r) => r.url.endsWith('/chat/completions') && !(r.corps && r.corps.user === 'title')); },
        arreter() { return new Promise((resolve) => { serveur.closeAllConnections(); serveur.close(() => resolve()); }); },
    };
}
