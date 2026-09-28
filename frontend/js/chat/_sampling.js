// SPDX-License-Identifier: MIT
// ============================================================
//  chat/_sampling.js -- Sampling override (UI "Paramètres avancés" par chat)
//
//  Extrait de app-chat.js (lignes 213-284). Comportement identique :
//  les valeurs sont envoyées au backend dans chaque requête. Si une
//  clé est à null/undefined, elle n'est pas envoyée → le backend
//  retombe sur /props du modèle. C'est exactement le comportement
//  voulu : l'user ne force que ce qu'il choisit explicitement de
//  changer.
//
//  Dépendances injectées :
//    * sharedRefs.selectedModel  -- ref(string) du modèle courant
//    * ctx.fetchAuth             -- helper HTTP authentifié
//
//  Exporte :
//    * showSamplingPanel       (ref bool)
//    * samplingOverride        (ref object) -- valeurs choisies par l'user
//    * effectiveParamsData     (ref object|null)
//    * effectiveParamsLoading  (ref bool)
//    * _cleanSamplingOverride  () => object|null  -- compacté pour le backend
//    * loadEffectiveParams     (modelId)
//    * resetSamplingOverride   ()
//    * openSamplingPanel       (modelId)
//    * closeSamplingPanel      ()
// ============================================================

function setupChatSampling(vue, sharedRefs, ctx) {
    const { ref, watch, computed } = vue;
    const { selectedModel, activeModelIds, selectedConnector, selectedEngineMeta } = sharedRefs;
    // Serveur sélectionné (tenu par _models.js) : un connecteur llama.cpp a les
    // mêmes mécanismes que l'intégré depuis le 2026-09-16 — ses valeurs de
    // modèle sont lisibles dès qu'il est chargé, ses samplers s'appliquent.
    const _engMeta = () => (selectedEngineMeta && selectedEngineMeta.value) || null;
    const _viaConnector = () => !!(selectedConnector && selectedConnector.value);
    const _connectorNotLlama = () => _viaConnector() && !(_engMeta() && _engMeta().llamacpp);
    const { fetchAuth }     = ctx;

    // Budget reasoning par défaut pour les modèles qui SUPPORTENT le thinking.
    // Choix produit : sur un modèle reasoning, le thinking est ACTIF par
    // défaut (8192 tokens). Le désactiver (mettre 0) doit être un choix
    // explicite de l'utilisateur, pas l'état initial.
    const THINKING_DEFAULT_BUDGET = 8192;

    // Dernier budget POSITIF connu, pour que basculer le toggle Réflexion
    // off→on restaure la valeur avancée choisie par l'user plutôt que de
    // toujours retomber sur 8192.
    const _lastThinkingBudget = ref(THINKING_DEFAULT_BUDGET);

    // Valeurs reasoning_effort connues côté client (miroir de la liste
    // serveur) : borne la restauration localStorage — jamais de chaîne
    // arbitraire dans le payload. La liste PAR MODÈLE vient du serveur
    // (effective-params.reasoning_effort_values, détection chat_template).
    const REASONING_EFFORT_VALUES = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

    const showSamplingPanel    = ref(false);
    const samplingOverride     = ref({
        temperature: null,
        top_p:       null,
        top_k:       null,
        min_p:       null,
        repeat_penalty: null,
        max_tokens:  null,
        max_tool_iterations:    null,
        thinking_budget_tokens: null,
        reasoning_effort:       null,  // string (niveau) — modèles type Qwen3.8
        preserve_reasoning:     null,  // bool tri-état — null = défaut du template
    });
    // Params effectifs visualisés dans le panneau (fetch depuis
    // /api/llm/models/{id}/effective-params quand on ouvre l'UI).
    const effectiveParamsData    = ref(null);
    const effectiveParamsLoading = ref(false);

    // ── Persistance des overrides ────────────────────────────────────────
    // Avant, RIEN n'était persisté (malgré la doc du panneau) : tout réglage
    // — au curseur comme au clavier — était perdu au moindre rechargement et
    // le backend repartait sur ses défauts. Un utilisateur qui montait
    // max_tool_iterations devait le re-saisir à chaque session, ce qui donnait
    // l'impression que seule la saisie manuelle « comptait ».
    // On ne relit que les CLÉS CONNUES et uniquement des nombres finis : un
    // localStorage corrompu ne peut pas injecter de champ arbitraire dans le
    // payload d'inférence.
    const _LS_KEY = 'sampling_override';

    function _restoreOverride() {
        try {
            const saved = JSON.parse(localStorage.getItem(_LS_KEY) || 'null');
            if (!saved || typeof saved !== 'object') return;
            for (const k of Object.keys(samplingOverride.value)) {
                const v = saved[k];
                if (k === 'reasoning_effort') {
                    // Seule clé texte : whitelist stricte (même garde anti-
                    // corruption que les nombres finis pour les autres clés).
                    if (typeof v === 'string' && REASONING_EFFORT_VALUES.includes(v)) {
                        samplingOverride.value[k] = v;
                    }
                } else if (k === 'preserve_reasoning') {
                    // Seule clé booléenne : `false` est une valeur SIGNIFIANTE
                    // (désactivation explicite) — le test `typeof number`
                    // l'aurait jetée en silence.
                    if (typeof v === 'boolean') samplingOverride.value[k] = v;
                } else if (typeof v === 'number' && Number.isFinite(v)) {
                    samplingOverride.value[k] = v;
                }
            }
        } catch (_) {}
    }
    _restoreOverride();

    function _persistOverride() {
        try {
            const clean = _cleanSamplingOverride();
            if (clean) localStorage.setItem(_LS_KEY, JSON.stringify(clean));
            else localStorage.removeItem(_LS_KEY);
        } catch (_) {}
    }
    watch(samplingOverride, _persistOverride, { deep: true });

    function _cleanSamplingOverride() {
        // Ne garder que les clés non-null -- évite d'envoyer du bruit au backend
        // et permet au /props de piloter les clés non overridées.
        const out = {};
        const src = samplingOverride.value || {};
        for (const k of Object.keys(src)) {
            if (src[k] !== null && src[k] !== undefined && src[k] !== '') {
                out[k] = src[k];
            }
        }
        return Object.keys(out).length > 0 ? out : null;
    }

    // ── Réglages SANS EFFET sur le moteur courant ────────────────────────
    // Un moteur distant ne parle qu'OpenAI-standard : le transport filtre le
    // payload (``_REMOTE_SAMPLING_KEYS`` puis ``OPENAI_STD_FIELDS`` dans
    // providers/openai_compat.py) et jette les samplers propres à llama.cpp.
    // Ils étaient pourtant présentés comme actifs — le panneau affirmait même
    // « vos réglages s'appliquent quand même ». Un utilisateur qui montait
    // repeat_penalty contre un modèle cloud répétitif ne pouvait pas
    // comprendre pourquoi rien ne bougeait. On les marque donc explicitement.
    // (max_tool_iterations n'est PAS concerné : il pilote la boucle d'outils
    // côté serveur, jamais le payload — il vaut pour tous les moteurs.)
    const ENGINE_ONLY_LLAMACPP = ['top_k', 'min_p', 'repeat_penalty', 'thinking_budget_tokens'];
    const ignoredByEngine = computed(() => (
        _connectorNotLlama() ? ENGINE_ONLY_LLAMACPP : []
    ));
    const isIgnoredByEngine = (key) => ignoredByEngine.value.indexOf(key) !== -1;

    // Vrai si les valeurs du modèle sont INDISPONIBLES pour ``id`` : modèle
    // d'un connecteur (cloud — /props locaux sans objet), ou modèle local non
    // chargé (lire /props le CHARGERAIT — invariant model-select-no-autoload).
    function _isDegradedFor(id) {
        if (_viaConnector()) {
            const meta = _engMeta();
            if (!meta || !meta.llamacpp) return true;
            return !Array.isArray(meta.loaded) || !meta.loaded.includes(id);
        }
        const _loaded = activeModelIds && activeModelIds.value;
        return !Array.isArray(_loaded) || !_loaded.includes(id);
    }

    // Référence dégradée CLIENT (repli si le fetch échoue) : le panneau reste
    // éditable — les overrides par chat s'appliquent sans /props, seule la
    // colonne « modèle » est vide. Le template a des repli ?? pour les défauts.
    function _degradedFallback(id) {
        return {
            model_id: id, degraded: true, supports_thinking: null,
            supports_reasoning_effort: null, reasoning_effort_values: [],
            supports_preserve_reasoning: null,
            sources: { props: {} }, agent_defaults: null,
        };
    }

    async function loadEffectiveParams(modelId) {
        const id = modelId || selectedModel.value;
        if (!id) { effectiveParamsData.value = null; return; }
        // INVARIANT PRODUIT — sélectionner un modèle ne doit JAMAIS le
        // charger. Le backend effective-params fait GET /props?model=X qui,
        // sur un llama-server router, CHARGE le modèle (swap VRAM, dizaines
        // de secondes). Pour un modèle non chargé (ou un connecteur), on
        // demande donc la vue DÉGRADÉE (?degraded=1 — config seule, AUCUN
        // accès /props côté serveur) au lieu de tuer le panneau : les
        // overrides par chat (max_tool_iterations, temperature…) restent
        // éditables, ils s'appliquent sans /props. Garde au point de passage
        // UNIQUE : couvre la roue ⚙ du header et tout futur appelant.
        const _degraded = _isDegradedFor(id);
        effectiveParamsLoading.value = true;
        try {
            const _ek = _viaConnector() && _engMeta() ? _engMeta().key : '';
            const res = await fetchAuth(
                `/api/llm/models/${encodeURIComponent(id)}/effective-params?task=chat`
                    + (_degraded ? '&degraded=1' : '')
                    + (_ek ? '&engine=' + encodeURIComponent(_ek) : ''),
                {}, true
            );
            // fetchAuth peut retourner null (erreur réseau, abort)
            // → res.ok jette TypeError. On checke d'abord la présence.
            if (res && res.ok) {
                effectiveParamsData.value = await res.json();
                // Modèle reasoning → le budget thinking par défaut est 8192,
                // pas 0 : on pré-remplit l'override SEULEMENT si l'user n'a
                // encore rien forcé. Le désactiver reste possible (mettre 0).
                // En dégradé, supports_thinking est null (inconnu) → pas de
                // pré-remplissage : pour un connecteur, le toggle Réflexion
                // est AFFICHÉ mais éteint par défaut.
                const d = effectiveParamsData.value;
                const cur = samplingOverride.value.thinking_budget_tokens;
                if (d && d.supports_thinking && (cur === null || cur === undefined)) {
                    samplingOverride.value.thinking_budget_tokens = THINKING_DEFAULT_BUDGET;
                }
                // reasoning_effort mémorisé (localStorage GLOBAL au navigateur)
                // ↔ modèle courant : purge si le modèle ne le supporte pas
                // (false ferme) ou si la valeur n'est pas dans SA liste. En
                // dégradé (null = inconnu) on ne touche à rien — le serveur
                // garde de toute façon l'injection par détection.
                const eff = samplingOverride.value.reasoning_effort;
                if (d && eff != null) {
                    if (d.supports_reasoning_effort === false
                        || (d.supports_reasoning_effort
                            && Array.isArray(d.reasoning_effort_values)
                            && !d.reasoning_effort_values.includes(eff))) {
                        samplingOverride.value.reasoning_effort = null;
                    }
                }
                // preserve_reasoning mémorisé (localStorage GLOBAL au
                // navigateur) ↔ modèle courant : purge si le modèle ne honore
                // PAS le kwarg (false ferme). En dégradé (null = inconnu) on
                // ne touche à rien — le serveur n'injecte de toute façon que
                // sur capacité confirmée.
                if (d && d.supports_preserve_reasoning === false
                    && samplingOverride.value.preserve_reasoning !== null) {
                    samplingOverride.value.preserve_reasoning = null;
                }
            } else {
                effectiveParamsData.value = _degradedFallback(id);
            }
        } catch (e) {
            console.warn('[sampling] Impossible de charger effective-params', e);
            effectiveParamsData.value = _degradedFallback(id);
        } finally {
            effectiveParamsLoading.value = false;
        }
    }

    function resetSamplingOverride() {
        samplingOverride.value = {
            temperature: null, top_p: null, top_k: null,
            min_p: null, repeat_penalty: null, max_tokens: null,
            max_tool_iterations: null, thinking_budget_tokens: null,
            reasoning_effort: null, preserve_reasoning: null,
        };
        // Après reset, on ré-applique le défaut reasoning : sur un modèle qui
        // supporte le thinking, l'état « neutre » reste 8192, pas 0.
        if (effectiveParamsData.value && effectiveParamsData.value.supports_thinking) {
            samplingOverride.value.thinking_budget_tokens = THINKING_DEFAULT_BUDGET;
        }
    }

    // le défaut thinking (THINKING_DEFAULT_BUDGET) n'était appliqué
    // que par loadEffectiveParams, lui-même appelé UNIQUEMENT à l'ouverture du
    // panneau sampling. Un utilisateur qui n'ouvre jamais ce panneau gardait
    // thinking_budget_tokens=null → app-chat envoyait thinking_mode=false →
    // un modèle reasoning ne pensait PAS par défaut, alors même que le front
    // « voulait » 8192. On charge donc les effective-params (ce qui applique
    // le défaut thinking) dès qu'un modèle est sélectionné, pas seulement à
    // l'ouverture de la modal. immediate:true couvre le modèle initial.
    // FIX (UX) — NE PAS charger un modèle juste en le SÉLECTIONNANT.
    // ``loadEffectiveParams`` lit ``/props`` du modèle, ce qui, sur un
    // llama-server multi-modèles, CHARGE le modèle s'il ne l'est pas déjà.
    // Modèle non chargé / connecteur → fetch DÉGRADÉ (config seule, aucun
    // /props) pour que le panneau reste éditable. La clé de dédup inclut le
    // mode : quand le modèle FINIT de charger (▶ → activeModelIds change),
    // deg → full force un re-fetch des vraies valeurs modèle.
    let _fxFetchedFor = '';
    function _maybeLoadEffectiveParams() {
        const m = selectedModel.value;
        if (!m) return;
        const _ek = _viaConnector() && _engMeta() ? _engMeta().key : 'builtin';
        const key = _ek + '|' + m + '|' + (_isDegradedFor(m) ? 'deg' : 'full');
        if (_fxFetchedFor === key) return;
        _fxFetchedFor = key;
        loadEffectiveParams(m);
    }
    watch([selectedModel, () => (selectedConnector ? selectedConnector.value : '')], () => {
        const m = selectedModel.value;
        // Reset du défaut thinking auto-injecté quand on change de modèle ou
        // de moteur (un 8192 auto ne doit pas rester collé sur un modèle
        // non-reasoning ni partir vers un connecteur ; un budget saisi
        // explicitement par l'user est préservé).
        if (samplingOverride.value.thinking_budget_tokens === THINKING_DEFAULT_BUDGET) {
            samplingOverride.value.thinking_budget_tokens = null;
        }
        if (!m) return;
        _maybeLoadEffectiveParams();
    }, { immediate: true });
    // Quand un modèle FINIT de charger (clic ▶ → activeModelIds change), si
    // c'est le modèle sélectionné, on récupère alors ses params + défaut thinking.
    watch(activeModelIds, () => { _maybeLoadEffectiveParams(); });
    // Même relais pour un modèle de connecteur llama.cpp qui finit de charger.
    if (selectedEngineMeta) watch(selectedEngineMeta, () => { _maybeLoadEffectiveParams(); });

    // Toggle Réflexion (on/off) — vue booléenne du tri-état
    // `thinking_budget_tokens` (SOURCE DE VÉRITÉ unique ; _doGenerate en dérive
    // thinking_mode = budget > 0). En mode agent (outils), seul cet état
    // activé/désactivé compte ; la valeur du budget n'est honorée qu'en chat
    // simple (champ « Avancé »). On/off restaure/mémorise le dernier budget
    // positif pour ne pas perdre un budget saisi explicitement.
    const thinkingEnabled = computed({
        get: () => (samplingOverride.value.thinking_budget_tokens ?? 0) > 0,
        set: (on) => {
            if (on) {
                samplingOverride.value.thinking_budget_tokens =
                    _lastThinkingBudget.value || THINKING_DEFAULT_BUDGET;
            } else {
                const cur = samplingOverride.value.thinking_budget_tokens;
                if (cur && cur > 0) _lastThinkingBudget.value = cur;
                samplingOverride.value.thinking_budget_tokens = 0;
            }
        },
    });
    // Éditer le budget « Avancé » à une valeur > 0 met à jour la mémoire, pour
    // que le toggle la restaure ensuite (et garde le toggle en cohérence).
    watch(() => samplingOverride.value.thinking_budget_tokens, (v) => {
        if (typeof v === 'number' && v > 0) _lastThinkingBudget.value = v;
    });

    // Clamp à la SAISIE (@change du champ « Budget de réflexion ») — miroir
    // exact du clamp serveur (_chat_classic._apply_thinking_budget) : 0 = off,
    // 1..511 → 512, > 131072 → 131072. Avant, le serveur JETAIT en silence
    // tout override hors [512..131072] (retour au défaut 8192) : la valeur
    // affichée mentait sur le comportement réel.
    function clampThinkingBudget() {
        const v = samplingOverride.value.thinking_budget_tokens;
        if (typeof v !== 'number' || !Number.isFinite(v)) return;
        if (v <= 0) { samplingOverride.value.thinking_budget_tokens = 0; return; }
        samplingOverride.value.thinking_budget_tokens =
            Math.min(Math.max(Math.round(v), 512), 131072);
    }

    // ── Toggle « Raisonnement conservé » (preserve_reasoning) ───────────
    // Affiché UNIQUEMENT quand le serveur confirme la capacité sur le modèle
    // COURANT (/props.chat_template_caps.supports_preserve_reasoning). Mêmes
    // gardes que le sélecteur d'effort : pas de connecteur (kwarg llama.cpp
    // sans objet côté cloud), pas de vue dégradée (modèle non chargé →
    // inconnu), et model_id ↔ selectedModel (data périmée pendant un switch).
    const preserveReasoningSupported = computed(() => {
        if (_connectorNotLlama()) return false;
        const d = effectiveParamsData.value;
        if (!d || d.degraded || !d.supports_preserve_reasoning) return false;
        return d.model_id === selectedModel.value;
    });

    // Vue booléenne du tri-état `preserve_reasoning` :
    //   null  → défaut du template (Qwen3.8 : preserve) → affiché ON
    //   true  → conservation EXPLICITE
    //   false → purge EXPLICITE du <think> des tours passés
    // Passer OFF pose `false` ; repasser ON pose `true` (explicite plutôt que
    // null : l'UI ne ment jamais sur ce qui part dans le payload — et sur
    // Qwen3.8 le rendu `true` est byte-identique au rendu sans kwarg).
    const preserveReasoningEnabled = computed({
        get: () => samplingOverride.value.preserve_reasoning !== false,
        set: (on) => { samplingOverride.value.preserve_reasoning = !!on; },
    });

    // ── Sélecteur « Effort de réflexion » (chip de la barre de prompt) ───
    // Affiché UNIQUEMENT quand le serveur a détecté la capacité sur le modèle
    // COURANT (chat_template citant reasoning_effort — Qwen3.8…). Trois gardes
    // au-delà de supports_reasoning_effort : pas de connecteur (détection
    // locale sans objet), pas de vue dégradée (modèle non chargé → inconnu),
    // et model_id ↔ selectedModel (data périmée pendant un switch de modèle).
    const reasoningEffortValues = computed(() => {
        if (_connectorNotLlama()) return [];
        const d = effectiveParamsData.value;
        if (!d || d.degraded || !d.supports_reasoning_effort) return [];
        if (d.model_id !== selectedModel.value) return [];
        return Array.isArray(d.reasoning_effort_values) ? d.reasoning_effort_values : [];
    });
    const showReasoningEffortMenu = ref(false);
    function toggleReasoningEffortMenu() {
        showReasoningEffortMenu.value = !showReasoningEffortMenu.value;
    }
    function pickReasoningEffort(v) {
        // null = « Auto » → clé absente du payload, le template garde son défaut.
        samplingOverride.value.reasoning_effort = v || null;
        showReasoningEffortMenu.value = false;
    }

    async function openSamplingPanel(modelId) {
        // Ouvre la modal sampling pour un modèle donné.
        // On charge les params effectifs pour que l'UI montre à l'user ce qui
        // sera appliqué s'il ne touche à rien -- c'est la référence visuelle.
        showSamplingPanel.value = true;
        await loadEffectiveParams(modelId);
    }

    function closeSamplingPanel() {
        showSamplingPanel.value = false;
    }

    return {
        showSamplingPanel,
        samplingOverride,
        thinkingEnabled,
        effectiveParamsData,
        effectiveParamsLoading,
        ignoredByEngine,
        isIgnoredByEngine,
        _cleanSamplingOverride,
        clampThinkingBudget,
        loadEffectiveParams,
        resetSamplingOverride,
        openSamplingPanel,
        closeSamplingPanel,
        // Raisonnement conservé (toggle panneau sampling)
        preserveReasoningSupported,
        preserveReasoningEnabled,
        // Effort de réflexion (chip barre de prompt)
        reasoningEffortValues,
        showReasoningEffortMenu,
        toggleReasoningEffortMenu,
        pickReasoningEffort,
    };
}

window.setupChatSampling = setupChatSampling;
