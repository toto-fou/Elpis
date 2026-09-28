// SPDX-License-Identifier: MIT
// Test unitaire hors-navigateur (node tests/frontend/models-connector-unit.mjs)
// du module frontend/js/chat/_models.js : cohérence de la paire
// (connecteur, modèle) — bug « routage externe avec modèle local » 2026-07-29.
// Pas de Playwright : stubs ref/watch/localStorage, module chargé via vm.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const MODELS_JS = new URL('../../frontend/js/chat/_models.js', import.meta.url);

// ── Stubs environnement ──────────────────────────────────────────────────────
function makeLocalStorage(init = {}) {
    const store = { ...init };
    return {
        getItem: k => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: k => { delete store[k]; },
        _dump: () => ({ ...store }),
    };
}

function ref(v) { return { value: v }; }
// computed minimal : recalcul à chaque lecture (aucune réactivité nécessaire).
function computed(fn) { return { get value() { return fn(); } }; }
// watch minimal : pas de réactivité — les chemins critiques persistent
// désormais en direct, le watch ne sert qu'aux flux secondaires.
function watch() {}
function nextTick(fn) { if (fn) fn(); }

function makeEnv({ storage, connectorsPayload, connModelsPayload }) {
    const window = { __ADMIN_ONLY_MODE__: false };
    const sandbox = {
        window,
        localStorage: storage,
        document: { querySelector: () => null },
        console,
        Date, JSON, Object, Array, String, Promise, Math,
        setTimeout, clearTimeout,
    };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    const src = readFileSync(MODELS_JS, 'utf8');
    vm.runInContext(src, sandbox);

    const sharedRefs = {
        availableModels: ref([]), selectedModel: ref(''), activeModelIds: ref([]),
        llmHealth: ref(null), isLoadingModel: ref(false),
        showModelProps: ref(false), modelPropsData: ref(null), modelPropsLoading: ref(false),
        showModelManager: ref(false), selectedConnector: ref(''),
        selectedEngineMeta: ref({ key: 'builtin', llamacpp: true, loaded: [] }),
    };
    let releaseConnectorsFetch = null;
    const fetchAuth = async (url) => {
        if (url === '/api/llm/connectors') {
            if (connectorsPayload === 'HANG_UNTIL_RELEASED') {
                await new Promise(r => { releaseConnectorsFetch = r; });
                return { ok: true, json: async () => makeEnv._lateConnectors };
            }
            return { ok: true, json: async () => connectorsPayload };
        }
        if (/\/api\/llm\/connectors\/\d+\/models(\?fresh=1)?$/.test(url)) {
            const pl = (typeof connModelsPayload === 'function') ? connModelsPayload(url) : connModelsPayload;
            return { ok: true, json: async () => (pl || { models: [] }) };
        }
        if (url === '/api/llm/models')
            return { ok: true, json: async () => ({ models: ['ornith-1.0-9b-Q8_0'], models_with_status: [{ id: 'ornith-1.0-9b-Q8_0', status: 'loaded' }] }) };
        return { ok: false, status: 404 };
    };
    const ctx = { showToast: () => {}, fetchAuth, openConfirm: async () => true, announce: () => {} };
    const mod = window.setupChatModels({ watch, ref, nextTick, computed }, sharedRefs, ctx);
    return { mod, sharedRefs, storage, getRelease: () => releaseConnectorsFetch };
}

let failures = 0;
function check(label, cond, detail) {
    if (cond) { console.log('  ok  —', label); }
    else { failures++; console.error('  FAIL —', label, detail !== undefined ? JSON.stringify(detail) : ''); }
}

const MOONSHOT = { id: 5, enabled: true, label: 'Moonshot', provider_type: 'moonshot', default_model: 'kimi-k2' };

// ── Cas 1 : état legacy « empoisonné » (pas de clé scellée, selected_model
//    local) → restauration = connecteur + SON default_model, pas le modèle local.
{
    console.log('Cas 1 : legacy empoisonné → default_model du connecteur');
    const storage = makeLocalStorage({ selected_connector: '5', selected_model: 'ornith-1.0-9b-Q8_0' });
    const { mod, sharedRefs } = makeEnv({ storage, connectorsPayload: { connectors: [MOONSHOT], shared: [] } });
    await mod.loadLlmConnectors();
    check('connecteur restauré (id typé catalogue)', sharedRefs.selectedConnector.value === 5, sharedRefs.selectedConnector.value);
    check('modèle = default_model, PAS le local', sharedRefs.selectedModel.value === 'kimi-k2', sharedRefs.selectedModel.value);
}

// ── Cas 2 : clé scellée présente → paire exacte restaurée.
{
    console.log('Cas 2 : clé scellée → paire exacte');
    const storage = makeLocalStorage({ selected_connector: '5', selected_model: 'ornith-1.0-9b-Q8_0', selected_conn_model: 'kimi-latest' });
    const { mod, sharedRefs } = makeEnv({ storage, connectorsPayload: { connectors: [MOONSHOT], shared: [] } });
    await mod.loadLlmConnectors();
    check('connecteur restauré', sharedRefs.selectedConnector.value === 5);
    check('modèle scellé restauré', sharedRefs.selectedModel.value === 'kimi-latest', sharedRefs.selectedModel.value);
}

// ── Cas 3 : pickLocalModel persiste la paire directement (retour local durable).
{
    console.log('Cas 3 : pickLocalModel → persistance directe');
    const storage = makeLocalStorage({ selected_connector: '5', selected_conn_model: 'kimi-k2' });
    const { mod, sharedRefs } = makeEnv({ storage, connectorsPayload: { connectors: [MOONSHOT], shared: [] } });
    sharedRefs.selectedConnector.value = 5;
    mod.pickLocalModel('ornith-1.0-9b-Q8_0');
    check('selectedConnector vidé', sharedRefs.selectedConnector.value === '');
    check('storage selected_connector vidé', storage.getItem('selected_connector') === '');
    check('storage selected_model = local', storage.getItem('selected_model') === 'ornith-1.0-9b-Q8_0');
}

// ── Cas 4 : course restauration vs choix local — le fetch connecteurs résout
//    APRÈS que l'utilisateur a cliqué un modèle local : pas de résurrection.
{
    console.log('Cas 4 : restauration tardive ne stompe pas un choix local');
    const storage = makeLocalStorage({ selected_connector: '5', selected_conn_model: 'kimi-k2' });
    const env = makeEnv({ storage, connectorsPayload: 'HANG_UNTIL_RELEASED' });
    makeEnv._lateConnectors = { connectors: [MOONSHOT], shared: [] };
    const p = env.mod.loadLlmConnectors();          // fetch suspendu
    await new Promise(r => setTimeout(r, 10));
    env.mod.pickLocalModel('ornith-1.0-9b-Q8_0');   // choix local pendant le vol
    env.getRelease()();                              // le fetch résout maintenant
    await p;
    check('connecteur PAS ressuscité', env.sharedRefs.selectedConnector.value === '', env.sharedRefs.selectedConnector.value);
    check('modèle local conservé', env.sharedRefs.selectedModel.value === 'ornith-1.0-9b-Q8_0');
}

// ── Cas 5 : connecteur disparu → purge du localStorage.
{
    console.log('Cas 5 : connecteur supprimé → purge');
    const storage = makeLocalStorage({ selected_connector: '99', selected_conn_model: 'kimi-k2' });
    const { mod, sharedRefs } = makeEnv({ storage, connectorsPayload: { connectors: [MOONSHOT], shared: [] } });
    await mod.loadLlmConnectors();
    check('pas de restauration', sharedRefs.selectedConnector.value === '');
    check('storage purgé', storage.getItem('selected_connector') === '');
}

// ── Cas 6 : pickConnectorModel écrit la clé scellée.
{
    console.log('Cas 6 : pickConnectorModel → clé scellée');
    const storage = makeLocalStorage({});
    const { mod, sharedRefs } = makeEnv({ storage, connectorsPayload: { connectors: [MOONSHOT], shared: [] } });
    mod.pickConnectorModel(MOONSHOT, 'kimi-k2');
    check('selectedConnector = id', sharedRefs.selectedConnector.value === 5);
    check('clé scellée écrite', storage.getItem('selected_conn_model') === 'kimi-k2');
    check('selected_connector persisté', storage.getItem('selected_connector') === '5');
}

// ── Cas 7 (2026-09-16) : coupure brève du serveur 2 — l'échec n'est PAS mis
//    en cache : la liste revient à la lecture suivante, sans recharger la page.
{
    console.log('Cas 7 : coupure brève → la liste revient seule');
    const S2 = { id: 7, enabled: true, label: 'Serveur 2', provider_type: 'llamacpp', default_model: '' };
    let enPanne = true;
    const payload = () => enPanne
        ? { ok: false, models: [], error: 'HTTP 0' }
        : { ok: true, models: ['qwen-x'], router: true, statuses: { 'qwen-x': 'loaded' }, can_manage: true };
    const storage = makeLocalStorage({});
    const { mod } = makeEnv({ storage, connectorsPayload: { connectors: [], shared: [S2] },
                              connModelsPayload: payload });
    await mod.loadLlmConnectors();
    await new Promise(r => setTimeout(r, 5));
    check('échec signalé', !!(mod.pickerConnState.value[7] && mod.pickerConnState.value[7].error));
    enPanne = false;
    mod.retryConnModels(7);                         // « Réessayer » / rafraîchissement
    await new Promise(r => setTimeout(r, 5));
    check('liste revenue', JSON.stringify(mod.pickerConnModels.value[7]) === '["qwen-x"]', mod.pickerConnModels.value[7]);
    check('état chargé lu', mod.isConnModelLoaded(7, 'qwen-x') === true);
    check('erreur effacée', !mod.pickerConnState.value[7].error);
}

// ── Cas 8 (lot B4) : serveur intégré fermé → aucune élection locale, premier
//    serveur autorisé retenu.
{
    console.log('Cas 8 : intégré interdit → premier connecteur autorisé');
    const S2 = { id: 7, enabled: true, label: 'Serveur 2', provider_type: 'llamacpp', default_model: 'qwen-x' };
    const storage = makeLocalStorage({ selected_model: 'ornith-1.0-9b-Q8_0' });
    const { mod, sharedRefs } = makeEnv({ storage,
        connectorsPayload: { connectors: [], shared: [S2], builtin_allowed: false, can_manage_models: false } });
    mod._applyModelData({ allowed: false, models: [] });
    await mod.loadLlmConnectors();
    check('pas de modèle local élu', sharedRefs.selectedModel.value === 'qwen-x', sharedRefs.selectedModel.value);
    check('connecteur retenu', sharedRefs.selectedConnector.value === 7, sharedRefs.selectedConnector.value);
    check('gestion masquée', mod.canManageModels.value === false);
}

// ── Cas 9 (M3) : le libellé dit le SERVEUR, pas seulement le modèle.
{
    console.log('Cas 9 : libellé modèle · serveur');
    const S2 = { id: 7, enabled: true, label: 'Serveur 2', provider_type: 'llamacpp', default_model: '' };
    const storage = makeLocalStorage({});
    const { mod } = makeEnv({ storage, connectorsPayload: { connectors: [], shared: [S2] } });
    await mod.loadLlmConnectors();
    mod.pickConnectorModel(S2, 'qwen-x');
    check('libellé', mod.selectedModelLabel.value === 'qwen-x · Serveur 2', mod.selectedModelLabel.value);
    mod.pickLocalModel('qwen-x');
    check('libellé local', mod.selectedModelLabel.value === 'qwen-x', mod.selectedModelLabel.value);
}

console.log(failures === 0 ? '\nTOUS LES CAS PASSENT' : `\n${failures} ÉCHEC(S)`);
process.exit(failures === 0 ? 0 : 1);
