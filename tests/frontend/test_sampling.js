// SPDX-License-Identifier: MIT
// ============================================================
//  tests/frontend/test_sampling.js
//  Lancer : node tests/frontend/test_sampling.js
//
//  Cible : frontend/js/chat/_sampling.js — le panneau « Paramètres
//  avancés », c'est-à-dire ce qui finit DANS LE PAYLOAD D'INFÉRENCE.
//
//  POURQUOI CE TEST
//  ================
//  C'est le module du front dont une régression coûte le plus cher,
//  parce qu'elle est INVISIBLE : le modèle répond, simplement pas avec
//  les réglages demandés. Rien ne rougit, rien n'alerte, et l'écart ne
//  se voit qu'en comparant deux générations.
//
//  Quatre règles y sont enchevêtrées, toutes muettes en cas de casse :
//
//   1. COMPACTAGE (``:118``) — une clé à null/undefined/'' n'est PAS
//      envoyée, pour que le backend retombe sur /props. Mais ``0`` EST
//      envoyé : ``thinking_budget_tokens: 0`` veut dire « réflexion
//      désactivée », pas « pas d'avis ». Et ``false`` aussi, pour
//      ``preserve_reasoning``. Un test ``if (!v)`` à la place de la
//      comparaison stricte avalerait les deux.
//
//   2. RESTAURATION WHITELISTÉE (``:84``) — trois branches distinctes,
//      parce que trois types cohabitent : une chaîne bornée par une
//      liste close, un booléen dont ``false`` est signifiant, et des
//      nombres finis. Un localStorage corrompu ne doit pas pouvoir
//      injecter une clé arbitraire dans le payload.
//
//   3. CLAMP MIROIR (``:330``) — copie exacte du clamp serveur
//      (``_chat_classic._apply_thinking_budget``) : 0 = off,
//      1..511 → 512, > 131072 → 131072. Avant ce clamp, le serveur
//      JETAIT en silence tout override hors bornes et la valeur
//      affichée MENTAIT sur le comportement réel. Si les deux
//      divergent à nouveau, on retombe exactement dans ce cas.
//
//   4. PURGE DU 8192 AUTO (``:288``) — au changement de modèle, un
//      budget thinking auto-injecté est effacé, un budget SAISI est
//      conservé. La distinction repose uniquement sur « la valeur
//      est-elle égale à la constante ». C'est fragile et implicite :
//      d'où un cas dédié dans les deux sens.
// ============================================================

'use strict';

const { t, fin, assert } = require('./lib/harnais.js');
const { charger, depuisBac } = require('./lib/charger.js');
const { vueMini, refsDeclares, ctxMuet, stockageLocal, reponseJson } = require('./lib/stubs.js');

const CLE_LS = 'sampling_override';
const DEFAUT_THINKING = 8192;

/**
 * Instancie le module avec un localStorage et des refs contrôlés.
 * Rend l'API plus les poignées nécessaires aux assertions.
 */
function monter(options) {
    const o = options || {};
    const stockage = stockageLocal(o.stockage || {});
    const c = charger('chat/_sampling.js', { bac: { localStorage: stockage } });
    const vue = vueMini();
    const refs = refsDeclares({
        selectedModel: o.modele !== undefined ? o.modele : 'm1',
        activeModelIds: o.charges || ['m1'],
        selectedConnector: o.connecteur || '',
        selectedEngineMeta: o.moteur || { key: 'builtin', llamacpp: true, loaded: ['m1'] },
    });
    const ctx = ctxMuet({
        // Une réponse réelle : sans elle, loadEffectiveParams (déclenché par
        // le watch immediate) produirait un rejet non géré qui tuerait node.
        fetchAuth: async () => reponseJson(o.effectifs || { model_id: 'm1', degraded: false }),
    });
    const api = c.fabrique('setupChatSampling', [vue, refs, ctx]);
    return { api, vue, refs, ctx, stockage, bac: c.bac };
}

/** Override compacté, recopié dans le royaume de l'hôte. */
const propre = (api) => depuisBac(api._cleanSamplingOverride());

/** Pose des valeurs dans l'override sans passer par l'UI. */
function poser(api, valeurs) {
    Object.assign(api.samplingOverride.value, valeurs);
}

// ── 1. Compactage : ce qui part, ce qui ne part pas ──────────

t('un override intégralement vide ne part PAS (null, pas {})', () => {
    const { api } = monter();
    poser(api, { thinking_budget_tokens: null });
    assert.equal(propre(api), null);
});

t('null, undefined et chaîne vide sont ÉCARTÉS du payload', () => {
    const { api } = monter();
    poser(api, { temperature: null, top_p: undefined, top_k: '', max_tokens: 500 });
    assert.deepStrictEqual(propre(api), { max_tokens: 500 });
});

t('ZÉRO EST ENVOYÉ — thinking_budget_tokens: 0 veut dire « désactivé »', () => {
    const { api } = monter();
    poser(api, { thinking_budget_tokens: 0 });
    assert.deepStrictEqual(propre(api), { thinking_budget_tokens: 0 });
});

t('zéro est envoyé pour tous les paramètres numériques, pas seulement le thinking', () => {
    const { api } = monter();
    poser(api, { temperature: 0, top_k: 0, min_p: 0, thinking_budget_tokens: null });
    assert.deepStrictEqual(propre(api), { temperature: 0, top_k: 0, min_p: 0 });
});

t('FALSE EST ENVOYÉ — preserve_reasoning: false est une purge explicite', () => {
    const { api } = monter();
    poser(api, { preserve_reasoning: false, thinking_budget_tokens: null });
    assert.deepStrictEqual(propre(api), { preserve_reasoning: false });
});

t('une valeur négative n\'est pas filtrée ici (le clamp est ailleurs)', () => {
    const { api } = monter();
    poser(api, { temperature: -1, thinking_budget_tokens: null });
    assert.deepStrictEqual(propre(api), { temperature: -1 });
});

t('le compactage ne garde que les clés connues de l\'override', () => {
    const { api } = monter();
    poser(api, { max_tokens: 100, thinking_budget_tokens: null });
    const clean = propre(api);
    assert.deepStrictEqual(Object.keys(clean), ['max_tokens']);
});

// ── 2. Restauration whitelistée depuis localStorage ──────────

t('les nombres finis sont restaurés', () => {
    const { api } = monter({ stockage: { [CLE_LS]: JSON.stringify({ temperature: 0.7, top_k: 40 }) } });
    assert.equal(api.samplingOverride.value.temperature, 0.7);
    assert.equal(api.samplingOverride.value.top_k, 40);
});

t('les nombres NON finis sont rejetés (Infinity et NaN passent par JSON en null)', () => {
    const { api } = monter({ stockage: { [CLE_LS]: '{"temperature": null, "top_k": "40"}' } });
    assert.equal(api.samplingOverride.value.temperature, null);
    assert.equal(api.samplingOverride.value.top_k, null, 'une chaîne numérique ne doit pas passer');
});

t('reasoning_effort : seules les valeurs de la liste close sont acceptées', () => {
    for (const v of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']) {
        const { api } = monter({ stockage: { [CLE_LS]: JSON.stringify({ reasoning_effort: v }) } });
        assert.equal(api.samplingOverride.value.reasoning_effort, v);
    }
});

t('reasoning_effort : une valeur hors liste est REJETÉE (pas de chaîne arbitraire dans le payload)', () => {
    for (const v of ['ultra', '', 'HIGH', 'medium ', 42, true, null]) {
        const { api } = monter({ stockage: { [CLE_LS]: JSON.stringify({ reasoning_effort: v }) } });
        assert.equal(api.samplingOverride.value.reasoning_effort, null,
            'valeur acceptée à tort : ' + JSON.stringify(v));
    }
});

t('preserve_reasoning : false est restauré (il est SIGNIFIANT)', () => {
    const { api } = monter({ stockage: { [CLE_LS]: '{"preserve_reasoning": false}' } });
    assert.equal(api.samplingOverride.value.preserve_reasoning, false);
});

t('preserve_reasoning : true est restauré, un non-booléen est rejeté', () => {
    const vrai = monter({ stockage: { [CLE_LS]: '{"preserve_reasoning": true}' } });
    assert.equal(vrai.api.samplingOverride.value.preserve_reasoning, true);
    for (const v of [1, 0, 'true', 'false']) {
        const { api } = monter({ stockage: { [CLE_LS]: JSON.stringify({ preserve_reasoning: v }) } });
        assert.equal(api.samplingOverride.value.preserve_reasoning, null,
            'valeur acceptée à tort : ' + JSON.stringify(v));
    }
});

t('une clé INCONNUE du localStorage n\'entre jamais dans l\'override', () => {
    const { api } = monter({ stockage: { [CLE_LS]: '{"temperature":0.5,"injecte":"oui","__proto__x":1}' } });
    const cles = Object.keys(depuisBac(api.samplingOverride.value));
    assert.ok(!cles.includes('injecte'), 'clé injectée : ' + cles.join(', '));
    assert.ok(!cles.includes('__proto__x'));
    assert.equal(api.samplingOverride.value.temperature, 0.5);
});

t('un localStorage corrompu ou absent ne fait pas tomber le setup', () => {
    for (const brut of ['pas du json', '[]', '"chaine"', '42', 'null', '']) {
        const { api } = monter({ stockage: { [CLE_LS]: brut } });
        assert.equal(api.samplingOverride.value.temperature, null, 'brut : ' + brut);
    }
    const vide = monter();
    assert.equal(vide.api.samplingOverride.value.temperature, null);
});

// ── 3. Clamp miroir du serveur ───────────────────────────────

t('CLAMP : zéro et négatif deviennent 0 (désactivation)', () => {
    const { api } = monter();
    for (const v of [0, -1, -9999]) {
        poser(api, { thinking_budget_tokens: v });
        api.clampThinkingBudget();
        assert.equal(api.samplingOverride.value.thinking_budget_tokens, 0, 'entrée ' + v);
    }
});

t('CLAMP : 1..511 remontent à 512 (plancher serveur)', () => {
    const { api } = monter();
    for (const [entree, attendu] of [[1, 512], [100, 512], [300, 512], [511, 512], [512, 512]]) {
        poser(api, { thinking_budget_tokens: entree });
        api.clampThinkingBudget();
        assert.equal(api.samplingOverride.value.thinking_budget_tokens, attendu, 'entrée ' + entree);
    }
});

t('CLAMP : au-delà de 131072, on plafonne', () => {
    const { api } = monter();
    for (const [entree, attendu] of [[131072, 131072], [131073, 131072], [999999, 131072]]) {
        poser(api, { thinking_budget_tokens: entree });
        api.clampThinkingBudget();
        assert.equal(api.samplingOverride.value.thinking_budget_tokens, attendu, 'entrée ' + entree);
    }
});

t('CLAMP : une valeur dans les bornes est laissée intacte', () => {
    const { api } = monter();
    for (const v of [512, 4096, 8192, 65536, 131072]) {
        poser(api, { thinking_budget_tokens: v });
        api.clampThinkingBudget();
        assert.equal(api.samplingOverride.value.thinking_budget_tokens, v);
    }
});

t('CLAMP : les décimales sont arrondies avant bornage', () => {
    const { api } = monter();
    poser(api, { thinking_budget_tokens: 1024.7 });
    api.clampThinkingBudget();
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, 1025);
});

t('CLAMP : une valeur non numérique est laissée telle quelle (no-op)', () => {
    const { api } = monter();
    for (const v of [null, undefined, 'abc', NaN, Infinity]) {
        poser(api, { thinking_budget_tokens: v });
        api.clampThinkingBudget();
        const apres = api.samplingOverride.value.thinking_budget_tokens;
        if (typeof v === 'number' && Number.isNaN(v)) assert.ok(Number.isNaN(apres));
        else assert.equal(apres, v, 'entrée ' + String(v));
    }
});

// ── 4. Le toggle Réflexion, tri-état ─────────────────────────

t('thinkingEnabled lit « budget > 0 »', () => {
    const { api } = monter();
    poser(api, { thinking_budget_tokens: 0 });
    assert.equal(api.thinkingEnabled.value, false);
    poser(api, { thinking_budget_tokens: 4096 });
    assert.equal(api.thinkingEnabled.value, true);
    poser(api, { thinking_budget_tokens: null });
    assert.equal(api.thinkingEnabled.value, false, 'null doit se lire comme désactivé');
});

t('couper la réflexion pose 0, pas null (0 = choix explicite, null = pas d\'avis)', () => {
    const { api } = monter();
    poser(api, { thinking_budget_tokens: 4096 });
    api.thinkingEnabled.value = false;
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, 0);
});

t('MÉMOIRE : couper puis rallumer restaure le budget SAISI, pas le défaut', () => {
    const { api } = monter();
    poser(api, { thinking_budget_tokens: 4096 });
    api.thinkingEnabled.value = false;
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, 0);
    api.thinkingEnabled.value = true;
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, 4096,
        'un budget saisi par l\'utilisateur ne doit pas être remplacé par 8192');
});

t('rallumer sans budget mémorisé retombe sur le défaut 8192', () => {
    const { api } = monter();
    poser(api, { thinking_budget_tokens: null });
    api.thinkingEnabled.value = true;
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, DEFAUT_THINKING);
});

t('couper deux fois de suite ne détruit pas la mémoire', () => {
    const { api } = monter();
    poser(api, { thinking_budget_tokens: 2048 });
    api.thinkingEnabled.value = false;
    api.thinkingEnabled.value = false;   // le 0 courant ne doit pas écraser la mémoire
    api.thinkingEnabled.value = true;
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, 2048);
});

t('éditer le budget « Avancé » met à jour la mémoire du toggle', () => {
    const { api, vue } = monter();
    poser(api, { thinking_budget_tokens: 16384 });
    vue.declencherWatchers();
    api.thinkingEnabled.value = false;
    api.thinkingEnabled.value = true;
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, 16384);
});

// ── preserve_reasoning, tri-état ─────────────────────────────

t('preserveReasoningEnabled : null se lit ON (défaut du template)', () => {
    const { api } = monter();
    assert.equal(api.samplingOverride.value.preserve_reasoning, null);
    assert.equal(api.preserveReasoningEnabled.value, true);
});

t('preserveReasoningEnabled : seul false se lit OFF', () => {
    const { api } = monter();
    poser(api, { preserve_reasoning: false });
    assert.equal(api.preserveReasoningEnabled.value, false);
    poser(api, { preserve_reasoning: true });
    assert.equal(api.preserveReasoningEnabled.value, true);
});

t('écrire le toggle pose un booléen EXPLICITE, jamais null', () => {
    // L'UI ne doit pas mentir sur ce qui part dans le payload.
    const { api } = monter();
    api.preserveReasoningEnabled.value = false;
    assert.strictEqual(api.samplingOverride.value.preserve_reasoning, false);
    api.preserveReasoningEnabled.value = true;
    assert.strictEqual(api.samplingOverride.value.preserve_reasoning, true);
});

// ── pickReasoningEffort ──────────────────────────────────────

t('pickReasoningEffort(null) = « Auto » → clé absente du payload', () => {
    const { api } = monter();
    api.pickReasoningEffort('high');
    assert.equal(api.samplingOverride.value.reasoning_effort, 'high');
    api.pickReasoningEffort(null);
    assert.equal(api.samplingOverride.value.reasoning_effort, null);
    api.pickReasoningEffort('');
    assert.equal(api.samplingOverride.value.reasoning_effort, null);
});

t('choisir un effort referme le menu', () => {
    const { api } = monter();
    api.showReasoningEffortMenu.value = true;
    api.pickReasoningEffort('low');
    assert.equal(api.showReasoningEffortMenu.value, false);
});

// ── 5. Purge du 8192 auto au changement de modèle ────────────

t('PURGE : un 8192 AUTO-injecté disparaît au changement de modèle', () => {
    const { api, refs, vue } = monter();
    poser(api, { thinking_budget_tokens: DEFAUT_THINKING });
    refs.selectedModel.value = 'm2';
    vue.declencherWatchers();
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, null,
        'un défaut auto ne doit pas rester collé sur le nouveau modèle');
});

t('PURGE : un budget SAISI par l\'utilisateur SURVIT au changement de modèle', () => {
    const { api, refs, vue } = monter();
    poser(api, { thinking_budget_tokens: 4096 });
    refs.selectedModel.value = 'm2';
    vue.declencherWatchers();
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, 4096);
});

t('PURGE : un 0 explicite (réflexion coupée) survit aussi', () => {
    const { api, refs, vue } = monter();
    poser(api, { thinking_budget_tokens: 0 });
    refs.selectedModel.value = 'm2';
    vue.declencherWatchers();
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, 0);
});

// ── 6. Réglages sans effet selon le moteur ───────────────────

t('sur l\'intégré, aucun réglage n\'est marqué sans effet', () => {
    const { api } = monter();
    assert.deepStrictEqual(depuisBac(api.ignoredByEngine.value), []);
    assert.equal(api.isIgnoredByEngine('top_k'), false);
});

t('sur un connecteur NON llama.cpp, quatre samplers sont sans effet', () => {
    const { api } = monter({
        connecteur: 'c1',
        moteur: { key: 'openai', llamacpp: false, loaded: [] },
    });
    assert.deepStrictEqual(depuisBac(api.ignoredByEngine.value),
        ['top_k', 'min_p', 'repeat_penalty', 'thinking_budget_tokens']);
});

t('max_tool_iterations n\'est JAMAIS sans effet — il pilote la boucle serveur', () => {
    const { api } = monter({
        connecteur: 'c1',
        moteur: { key: 'openai', llamacpp: false, loaded: [] },
    });
    assert.equal(api.isIgnoredByEngine('max_tool_iterations'), false);
    assert.equal(api.isIgnoredByEngine('temperature'), false);
    assert.equal(api.isIgnoredByEngine('max_tokens'), false);
});

t('un connecteur llama.cpp garde tous ses samplers', () => {
    const { api } = monter({
        connecteur: 'c1',
        moteur: { key: 'llama-distant', llamacpp: true, loaded: ['m1'] },
    });
    assert.deepStrictEqual(depuisBac(api.ignoredByEngine.value), []);
});

// ── 7. Réinitialisation ──────────────────────────────────────

t('resetSamplingOverride remet toutes les clés à null', () => {
    const { api } = monter();
    poser(api, { temperature: 0.9, top_k: 40, max_tokens: 500, reasoning_effort: 'high' });
    api.resetSamplingOverride();
    const v = depuisBac(api.samplingOverride.value);
    for (const k of Object.keys(v)) assert.equal(v[k], null, 'clé ' + k + ' non remise à null');
    assert.equal(propre(api), null);
});

t('après reset, un modèle qui supporte le thinking retrouve son défaut 8192', () => {
    const { api } = monter();
    api.effectiveParamsData.value = { supports_thinking: true };
    api.resetSamplingOverride();
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, DEFAUT_THINKING);
});

t('après reset, un modèle SANS thinking reste à null', () => {
    const { api } = monter();
    api.effectiveParamsData.value = { supports_thinking: false };
    api.resetSamplingOverride();
    assert.equal(api.samplingOverride.value.thinking_budget_tokens, null);
});

// ── 8. Persistance ───────────────────────────────────────────

t('un override non vide est écrit en localStorage sous forme COMPACTÉE', () => {
    const { api, vue, stockage } = monter();
    poser(api, { temperature: 0.7, top_p: null, thinking_budget_tokens: null });
    vue.declencherWatchers();
    assert.deepStrictEqual(JSON.parse(stockage.contenu()[CLE_LS]), { temperature: 0.7 });
});

t('un override entièrement vide EFFACE l\'entrée plutôt que d\'écrire « null »', () => {
    const { api, vue, stockage } = monter({ stockage: { [CLE_LS]: '{"temperature":0.7}' } });
    api.resetSamplingOverride();
    vue.declencherWatchers();
    assert.equal(stockage.contenu()[CLE_LS], undefined);
});

t('ALLER-RETOUR : ce qui est persisté est exactement ce qui est relu', () => {
    const depart = { temperature: 0.7, top_k: 40, thinking_budget_tokens: 4096,
        reasoning_effort: 'high', preserve_reasoning: false };
    const a = monter();
    poser(a.api, depart);
    a.vue.declencherWatchers();
    const ecrit = a.stockage.contenu()[CLE_LS];

    const b = monter({ stockage: { [CLE_LS]: ecrit } });
    assert.deepStrictEqual(propre(b.api), depart);
});

fin();
