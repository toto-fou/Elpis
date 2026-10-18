// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/modeles/modeles.ts — modèles du sélecteur (porté de `chat/_models.js`) : catalogue intégré et connecteurs, paire (connecteur, modèle) persistée, chargement et déchargement suivis, propriétés, teintes de la jauge. */
import type * as Vue from "vue";
import type { Ref } from "vue";

import type { FetchAuth } from "../flux/aides.ts";

export type VueModeles = Pick<typeof Vue, "watch" | "ref" | "nextTick" | "computed"> &
  Partial<Pick<typeof Vue, "onScopeDispose">>;

type IdConnecteur = string | number;

export interface ConnecteurModele {
  id: IdConnecteur;
  label?: string;
  provider_type?: string;
  default_model?: string;
  enabled?: boolean;
  provider_allowed?: boolean;
  [cle: string]: unknown;
}

export interface EtatConnecteurModele {
  ok: boolean;
  at: number;
  error: string;
  router: boolean;
  statuses: Record<string, string>;
  canManage: boolean;
  providerType?: string;
}

export interface SanteLlm {
  server_reachable?: unknown;
  status?: unknown;
  kv_cache: { used: number; total: number; pct: number };
  props: { n_ctx?: number; [cle: string]: unknown };
}

export interface MetaMoteur {
  key: string;
  llamacpp: boolean;
  label: string;
  loaded: string[];
  n_ctx: number;
}

export interface RefsModeles {
  availableModels: Ref<string[]>;
  selectedModel: Ref<string>;
  activeModelIds: Ref<string[]>;
  llmHealth: Ref<SanteLlm | null>;
  isLoadingModel: Ref<string | boolean>;
  showModelProps: Ref<boolean>;
  modelPropsData: Ref<unknown>;
  modelPropsLoading: Ref<boolean>;
  showModelManager: Ref<boolean>;
  selectedConnector?: Ref<IdConnecteur | null | undefined>;
  selectedEngineMeta?: Ref<MetaMoteur | Record<string, unknown> | null>;
}

export interface CtxModeles {
  showToast(message: string, type?: string): void;
  fetchAuth: FetchAuth;
  openConfirm(titre: string, texte: string, danger?: boolean, ok?: string): Promise<boolean>;
  announce?: (message: string) => void;
}

type Objet = Record<string, unknown>;
const estObjet = (v: unknown): v is Objet => !!v && typeof v === "object" && !Array.isArray(v);
const chaines = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const TTL_OK_MS = 30000;
const TTL_ECHEC_MS = 5000;

function modeConsole(): boolean {
  return !!(globalThis as { window?: { __ADMIN_ONLY_MODE__?: boolean } }).window?.__ADMIN_ONLY_MODE__;
}

function stocker(cle: string, valeur: string): void {
  try {
    localStorage.setItem(cle, valeur);
  } catch {
    /* stockage indisponible */
  }
}

function relire(cle: string): string {
  try {
    return localStorage.getItem(cle) || "";
  } catch {
    return "";
  }
}

/** Teinte de la jauge de contexte ; le palier « blue » suit l'accent du skin (avertissement). */
export function kvColor(pct: number): string {
  if (pct >= 90) return "red";
  if (pct >= 75) return "amber";
  if (pct >= 65) return "blue";
  return "emerald";
}

interface TonsKv {
  text: string;
  dim: string;
  bar: string;
}

// Classes écrites en entier : la feuille Tailwind précompilée ne lit que des littéraux.
const KV_TONES: Readonly<Record<string, TonsKv>> = {
  red: { text: "text-red-600", dim: "text-red-500", bar: "bg-red-500" },
  amber: { text: "text-amber-600", dim: "text-amber-500", bar: "bg-amber-500" },
  blue: { text: "text-blue-600", dim: "text-blue-500", bar: "bg-blue-500" },
  emerald: { text: "text-emerald-600", dim: "text-emerald-500", bar: "bg-emerald-500" },
};
const EMERAUDE: TonsKv = { text: "text-emerald-600", dim: "text-emerald-500", bar: "bg-emerald-500" };
const tonKv = (pct: number): TonsKv => KV_TONES[kvColor(pct)] ?? EMERAUDE;
export const kvTextClass = (pct: number): string => tonKv(pct).text;
export const kvDimClass = (pct: number): string => tonKv(pct).dim;
export const kvBarClass = (pct: number): string => tonKv(pct).bar;

/** Valeur lisible d'une propriété du modèle (nombres arrondis, listes, objets). */
export function fmtPropVal(val: unknown): string {
  if (val === null || val === undefined) return "--";
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") {
    if (Number.isInteger(val)) return String(val);
    return parseFloat(val.toFixed(2)).toString();
  }
  if (Array.isArray(val)) return val.map((v) => fmtPropVal(v)).join(", ");
  if (typeof val === "object")
    return JSON.stringify(
      val,
      (_k, v: unknown) => (typeof v === "number" && !Number.isInteger(v) ? parseFloat(v.toFixed(2)) : v),
      2,
    );
  return String(val as string);
}

const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function setupChatModels(vue: VueModeles, refs: RefsModeles, ctx: CtxModeles) {
  const { watch, ref, nextTick, computed } = vue;
  const onScopeDispose = vue.onScopeDispose ?? ((_fn: () => void): void => undefined);
  const {
    availableModels,
    selectedModel,
    activeModelIds,
    llmHealth,
    isLoadingModel,
    showModelProps,
    modelPropsData,
    modelPropsLoading,
    showModelManager,
    selectedConnector,
    selectedEngineMeta,
  } = refs;
  const { showToast, fetchAuth, openConfirm } = ctx;
  const connecteurChoisi = (): IdConnecteur | null | undefined => selectedConnector?.value;
  const choisirConnecteur = (v: IdConnecteur): void => {
    if (selectedConnector) selectedConnector.value = v;
  };

  const modelLoadPct = ref<number | null>(null);
  const modelLoadStage = ref("");
  const failedModelIds = ref<string[]>([]);
  // Modèle dont le CHARGEMENT est en cours ; la barre de progression n'appartient qu'à lui.
  const modelLoadingId = ref("");
  const pickerConnectors = ref<ConnecteurModele[]>([]);
  const pickerConnModels = ref<Record<string, string[]>>({});
  const pickerConnFree = ref<Record<string, Record<string, boolean>>>({});
  const pickerConnLoading = ref<Record<string, boolean>>({});
  const pickerConnState = ref<Record<string, EtatConnecteurModele>>({});
  const builtinAllowed = ref(true);
  const canManageModels = ref(true);
  const connectorsLoaded = ref(false);
  const modelsLoading = ref(false);
  const modelsError = ref("");
  let connecteursAmorces = false;
  let generationSondage = 0;
  onScopeDispose(() => {
    generationSondage++;
  });
  const ctxModeles: Record<string, number> = {};
  const ctxEnCours = new Set<string>();

  // Paire restaurée depuis la clé scellée au connecteur (jamais un modèle local avec un connecteur distant).
  function restaurerConnecteur(): void {
    const sauve = relire("selected_connector");
    if (!sauve || !selectedConnector || selectedConnector.value) return;
    const conn = pickerConnectors.value.find((c) => String(c.id) === String(sauve));
    if (!conn) {
      stocker("selected_connector", "");
      return;
    }
    const modele = relire("selected_conn_model") || conn.default_model || "";
    if (modele) {
      selectedConnector.value = conn.id;
      selectedModel.value = modele;
    }
  }

  async function loadLlmConnectors(): Promise<void> {
    if (modeConsole()) return;
    try {
      const res = await fetchAuth("/api/llm/connectors", {}, true);
      if (!res || !res.ok) return;
      const d: unknown = await res.json();
      const o = estObjet(d) ? d : {};
      const liste = (v: unknown): ConnecteurModele[] =>
        Array.isArray(v) ? v.filter((c): c is ConnecteurModele => estObjet(c) && "id" in c) : [];
      const propres = liste(o["connectors"]).filter((c) => c.enabled && c.provider_allowed !== false);
      const partages = liste(o["shared"]).filter((c) => c.enabled);
      pickerConnectors.value = partages.concat(propres);
      builtinAllowed.value = o["builtin_allowed"] !== false;
      canManageModels.value = o["can_manage_models"] !== false;
      connectorsLoaded.value = true;
      try {
        restaurerConnecteur();
      } catch {
        /* stockage illisible */
      }
      const choisi = connecteurChoisi();
      if (choisi && !pickerConnectors.value.some((c) => String(c.id) === String(choisi))) {
        choisirConnecteur("");
        stocker("selected_connector", "");
      }
      if (!builtinAllowed.value && !connecteurChoisi()) premierConnecteurAutorise();
      for (const c of pickerConnectors.value) void loadConnModels(c.id);
    } catch {
      /* réseau : le sélecteur réessaiera */
    }
  }

  function premierConnecteurAutorise(): void {
    const c = pickerConnectors.value[0];
    if (!c) {
      if (!builtinAllowed.value) selectedModel.value = "";
      return;
    }
    const m = c.default_model || (pickerConnModels.value[String(c.id)] || [])[0] || "";
    if (m) pickConnectorModel(c, m, { silent: true });
  }

  async function loadConnModels(connId: IdConnecteur, opts?: { force?: boolean }): Promise<void> {
    const cle = String(connId);
    const force = !!opts?.force;
    if (pickerConnLoading.value[cle]) return;
    const st = pickerConnState.value[cle];
    if (!force && st) {
      const age = Date.now() - (st.at || 0);
      if (age < (st.ok ? TTL_OK_MS : TTL_ECHEC_MS)) return;
    }
    pickerConnLoading.value = { ...pickerConnLoading.value, [cle]: true };
    let suite: EtatConnecteurModele = {
      ok: false,
      at: Date.now(),
      error: "",
      router: false,
      statuses: {},
      canManage: false,
    };
    try {
      const res = await fetchAuth(
        "/api/llm/connectors/" + cle + "/models" + (force ? "?fresh=1" : ""),
        {},
        true,
      );
      if (res && res.ok) {
        const brut: unknown = await res.json();
        const d = estObjet(brut) ? brut : {};
        let ids = chaines(d["models"]);
        const joint = d["ok"] !== false;
        if (!ids.length && typeof d["default_model"] === "string" && d["default_model"])
          ids = [d["default_model"]];
        const statuts = d["statuses"];
        suite = {
          ok: joint,
          at: Date.now(),
          error: joint ? "" : String(d["error"] || "injoignable"),
          router: !!d["router"],
          statuses: estObjet(statuts) ? (statuts as Record<string, string>) : {},
          canManage: !!d["can_manage"],
          providerType: typeof d["provider_type"] === "string" ? d["provider_type"] : "",
        };
        // Un échec n'efface pas une liste déjà connue (coupure brève) ; une réussite la remplace.
        const avant = pickerConnModels.value[cle];
        if (joint || !avant || !avant.length)
          pickerConnModels.value = { ...pickerConnModels.value, [cle]: ids };
        const libres: Record<string, boolean> = {};
        for (const m of chaines(d["free"])) libres[m] = true;
        pickerConnFree.value = { ...pickerConnFree.value, [cle]: libres };
      } else {
        suite.error = res ? "HTTP " + res.status : "injoignable";
      }
    } catch {
      suite.error = "injoignable";
    } finally {
      pickerConnState.value = { ...pickerConnState.value, [cle]: suite };
      pickerConnLoading.value = { ...pickerConnLoading.value, [cle]: false };
    }
    if (!builtinAllowed.value && !connecteurChoisi()) premierConnecteurAutorise();
  }

  function retryConnModels(connId: IdConnecteur): void {
    void loadConnModels(connId, { force: true });
  }

  function isConnModelLoaded(connId: IdConnecteur, m: string): boolean {
    return pickerConnState.value[String(connId)]?.statuses[m] === "loaded";
  }

  // Persistance directe : un watch ne tire pas quand la valeur ne change pas ('' → '').
  function pickLocalModel(m: string): void {
    selectedModel.value = m;
    choisirConnecteur("");
    stocker("selected_connector", "");
    stocker("selected_model", m);
    showModelManager.value = false;
    try {
      ctx.announce?.("Modèle sélectionné : " + m);
    } catch {
      /* annonceur absent */
    }
  }

  function pickConnectorModel(conn: ConnecteurModele, model: string, opts?: { silent?: boolean }): void {
    selectedModel.value = model;
    choisirConnecteur(conn.id);
    stocker("selected_connector", String(conn.id));
    stocker("selected_model", model);
    stocker("selected_conn_model", model);
    if (opts?.silent) return;
    showModelManager.value = false;
    try {
      ctx.announce?.("Modèle " + model + " via " + (conn.label || conn.provider_type || ""));
    } catch {
      /* annonceur absent */
    }
  }

  const selectedConnectorObj = computed(() => {
    const id = connecteurChoisi();
    if (!id) return null;
    return pickerConnectors.value.find((c) => String(c.id) === String(id)) || null;
  });
  const noEngineAllowed = computed(
    () => connectorsLoaded.value && !builtinAllowed.value && pickerConnectors.value.length === 0,
  );
  const selectedModelLabel = computed(() => {
    const m = selectedModel.value;
    if (!m) return noEngineAllowed.value ? "Aucun serveur" : "Aucun modèle";
    const c = selectedConnectorObj.value;
    return c ? m + " · " + (c.label || c.provider_type || "") : m;
  });

  // Métadonnées du serveur choisi, lues par le panneau de sampling et la jauge de contexte.
  function rafraichirMetaMoteur(): void {
    if (!selectedEngineMeta) return;
    const c = selectedConnectorObj.value;
    if (!c) {
      selectedEngineMeta.value = {
        key: "builtin",
        llamacpp: true,
        label: "",
        loaded: (activeModelIds.value || []).slice(),
        n_ctx: 0,
      };
      return;
    }
    const st = pickerConnState.value[String(c.id)];
    const llama = (st?.providerType || c.provider_type) === "llamacpp";
    const statuts = st?.statuses || {};
    const charges = Object.keys(statuts).filter((k) => statuts[k] === "loaded");
    if (llama && st?.ok && !st.router)
      for (const m of pickerConnModels.value[String(c.id)] || []) charges.push(m);
    const key = "conn:" + c.id;
    const ck = key + "|" + selectedModel.value;
    selectedEngineMeta.value = {
      key,
      llamacpp: llama,
      label: c.label || c.provider_type || "",
      loaded: charges,
      n_ctx: ctxModeles[ck] || 0,
    };
    if (llama && selectedModel.value && charges.includes(selectedModel.value) && !ctxModeles[ck])
      void lireCtxConnecteur(key, selectedModel.value);
  }

  async function lireCtxConnecteur(cleMoteur: string, modelId: string): Promise<void> {
    const ck = cleMoteur + "|" + modelId;
    if (ctxEnCours.has(ck)) return;
    ctxEnCours.add(ck);
    try {
      const res = await fetchAuth(
        "/api/llm/models/" + encodeURIComponent(modelId) + "/props?engine=" + encodeURIComponent(cleMoteur),
        {},
        true,
      );
      if (res && res.ok) {
        const n = nCtxDe(await res.json());
        if (n > 0) {
          ctxModeles[ck] = n;
          rafraichirMetaMoteur();
        }
      }
    } catch {
      /* propriété indisponible */
    } finally {
      ctxEnCours.delete(ck);
    }
  }

  watch(
    [
      () => connecteurChoisi() ?? "",
      selectedModel,
      pickerConnectors,
      pickerConnState,
      pickerConnModels,
      activeModelIds,
    ],
    rafraichirMetaMoteur,
    { immediate: true },
  );

  function nCtxDe(d: unknown): number {
    const g = estObjet(d) ? d["default_generation_settings"] : null;
    return (estObjet(g) && Number(g["n_ctx"])) || 0;
  }

  // Fenêtre du modèle lue une fois par chargement, pas à chaque sondage.
  async function lireCtxModele(modelId: string): Promise<void> {
    if (!modelId) return;
    if (!modeConsole()) {
      try {
        const res = await fetchAuth("/api/llm/models/" + encodeURIComponent(modelId) + "/props", {}, true);
        if (res && res.ok) {
          const n = nCtxDe(await res.json());
          if (n > 0) {
            ctxModeles[modelId] = n;
            const h = llmHealth.value;
            if (h) llmHealth.value = { ...h, props: { ...h.props, n_ctx: n } };
          }
        }
      } catch {
        /* propriété indisponible */
      }
    }
    ctxEnCours.delete(modelId);
  }

  // Une liste vide pendant un redémarrage du moteur n'efface pas le catalogue connu.
  function _applyModelData(json: unknown): void {
    if (!estObjet(json)) return;
    if (json["allowed"] === false) {
      builtinAllowed.value = false;
      availableModels.value = [];
      activeModelIds.value = [];
      llmHealth.value = null;
      if (!connecteurChoisi()) premierConnecteurAutorise();
      return;
    }
    const entrants = chaines(json["models"]);
    if (entrants.length === 0 && Array.isArray(availableModels.value) && availableModels.value.length > 0)
      return;
    availableModels.value = entrants;
    const charges: string[] = [];
    const avecStatut = json["models_with_status"];
    const anciens = json["models_loaded"];
    if (Array.isArray(avecStatut)) {
      const echecs: string[] = [];
      for (const m of avecStatut as unknown[]) {
        if (!estObjet(m) || typeof m["id"] !== "string" || !m["id"]) continue;
        if (m["status"] === "loaded") charges.push(m["id"]);
        if (m["status"] === "failed") echecs.push(m["id"]);
      }
      failedModelIds.value = echecs;
    } else if (Array.isArray(anciens)) {
      for (const m of anciens as unknown[]) {
        const id = estObjet(m) ? m["id"] || m["model"] || m["name"] : m;
        if (typeof id === "string" && id) charges.push(id);
      }
    }
    activeModelIds.value = [...new Set(charges)];
    const kv = estObjet(json["kv_cache"])
      ? (json["kv_cache"] as SanteLlm["kv_cache"])
      : { used: 0, total: 0, pct: 0 };
    const sante: SanteLlm = {
      server_reachable: json["server_reachable"],
      status: json["status"],
      kv_cache: kv,
      props: estObjet(json["props"]) ? (json["props"] as SanteLlm["props"]) : {},
    };
    if (sante.kv_cache.total > 0)
      sante.kv_cache.pct = Math.round((sante.kv_cache.used / sante.kv_cache.total) * 100) || 0;
    const mid = charges[0];
    if (mid) {
      const nCtx = Number(sante.props.n_ctx) || 0;
      if (ctxModeles[mid]) sante.props.n_ctx = ctxModeles[mid];
      else if (!nCtx && !ctxEnCours.has(mid)) {
        ctxEnCours.add(mid);
        void lireCtxModele(mid);
      } else if (nCtx > 0) ctxModeles[mid] = nCtx;
    }
    llmHealth.value = sante;
    // Connecteur actif : le modèle choisi lui appartient, le sondage local n'y touche pas.
    if (connecteurChoisi()) return;
    const sauve = relire("selected_model");
    if (!selectedModel.value) {
      if (sauve && availableModels.value.includes(sauve)) selectedModel.value = sauve;
      else selectedModel.value = activeModelIds.value[0] || availableModels.value[0] || "";
      if (selectedModel.value) stocker("selected_model", selectedModel.value);
    }
    // Le modèle choisi reste sélectionné même non chargé : il se charge à l'envoi.
    if (selectedModel.value && !availableModels.value.includes(selectedModel.value)) {
      selectedModel.value = activeModelIds.value[0] || availableModels.value[0] || "";
      if (selectedModel.value) stocker("selected_model", selectedModel.value);
    }
  }

  async function loadAvailableModels(): Promise<void> {
    if (modeConsole()) return;
    if (!connecteursAmorces) {
      connecteursAmorces = true;
      void loadLlmConnectors();
    }
    modelsLoading.value = true;
    modelsError.value = "";
    try {
      const res = await fetchAuth("/api/llm/models", {}, true);
      if (res && res.ok) _applyModelData(await res.json());
      else if (res) modelsError.value = "Erreur serveur (HTTP " + res.status + ")";
      else modelsError.value = "Serveur LLM injoignable";
    } catch {
      modelsError.value = "Erreur de chargement des modèles";
    } finally {
      modelsLoading.value = false;
    }
  }

  function optionsMenu(): HTMLElement[] {
    const racine = document.querySelector("[data-model-manager]");
    return racine ? Array.from(racine.querySelectorAll<HTMLElement>('[role="option"]')) : [];
  }

  // Sélecteur ouvert : les états des connecteurs se rafraîchissent (TTL respectés).
  let sondageMenu: ReturnType<typeof setInterval> | null = null;
  watch(showModelManager, (ouvert) => {
    if (sondageMenu) {
      clearInterval(sondageMenu);
      sondageMenu = null;
    }
    if (ouvert) sondageMenu = setInterval(() => void loadLlmConnectors(), 5000);
  });
  onScopeDispose(() => {
    if (sondageMenu) clearInterval(sondageMenu);
  });

  function toggleModelMenu(): void {
    showModelManager.value = !showModelManager.value;
    if (!showModelManager.value) return;
    void loadAvailableModels();
    void loadLlmConnectors();
    void nextTick(() => {
      const opts = optionsMenu();
      const courant = opts.find((el) => el.getAttribute("aria-selected") === "true");
      (courant || opts[0])?.focus();
    });
  }

  function onModelMenuKeydown(e: KeyboardEvent): void {
    const opts = optionsMenu();
    if (e.key === "Escape") {
      e.preventDefault();
      showModelManager.value = false;
      document.querySelector<HTMLElement>("[data-model-manager] > button")?.focus();
      return;
    }
    if (!opts.length) return;
    const cur = opts.indexOf(document.activeElement as HTMLElement);
    const aller = (i: number): void => {
      e.preventDefault();
      opts[i]?.focus();
    };
    if (e.key === "ArrowDown") aller((cur + 1 + opts.length) % opts.length);
    else if (e.key === "ArrowUp") aller((cur - 1 + opts.length) % opts.length);
    else if (e.key === "Home") aller(0);
    else if (e.key === "End") aller(opts.length - 1);
  }

  function isModelFailed(modelId: string): boolean {
    return failedModelIds.value.includes(modelId);
  }

  function isModelLoaded(modelId: string): boolean {
    if (!modelId || !activeModelIds.value) return false;
    return activeModelIds.value.includes(modelId);
  }

  async function toggleLlmModel(modelId: string): Promise<void> {
    if (!modelId || isLoadingModel.value) return;
    if (isModelLoaded(modelId)) await unloadLlmModel(modelId);
    else await loadLlmModel(modelId);
  }

  // Jeton : une réponse périmée ne ferme pas la fenêtre d'un autre modèle.
  let seqProprietes = 0;
  async function fetchModelProps(modelId: string, engineKey?: string): Promise<void> {
    if (!modelId || modeConsole()) return;
    const mien = ++seqProprietes;
    modelPropsLoading.value = true;
    modelPropsData.value = null;
    showModelProps.value = true;
    try {
      const res = await fetchAuth(
        "/api/llm/models/" +
          encodeURIComponent(modelId) +
          "/props" +
          (engineKey && engineKey !== "builtin" ? "?engine=" + encodeURIComponent(engineKey) : ""),
        {},
        true,
      );
      if (mien !== seqProprietes) return;
      if (res && res.ok) {
        const d: unknown = await res.json();
        if (mien !== seqProprietes) return;
        modelPropsData.value = d;
      } else {
        showModelProps.value = false;
        showToast("Impossible de récupérer les infos du modèle", "error");
      }
    } catch {
      if (mien !== seqProprietes) return;
      showModelProps.value = false;
      showToast("Erreur réseau", "error");
    } finally {
      if (mien === seqProprietes) modelPropsLoading.value = false;
    }
  }

  async function sonderStatut(modelId: string, attenduCharge: boolean, maxMs = 120000): Promise<boolean> {
    const limite = Date.now() + maxMs;
    const mienne = generationSondage;
    while (Date.now() < limite) {
      await attendre(2000);
      if (mienne !== generationSondage) return false;
      try {
        const res = await fetchAuth("/api/llm/models", {}, true);
        if (res && res.ok) {
          const json: unknown = await res.json();
          const liste =
            estObjet(json) && Array.isArray(json["models_with_status"]) ? json["models_with_status"] : [];
          const cible = (liste as unknown[]).find((m) => estObjet(m) && m["id"] === modelId);
          if (estObjet(cible) && (cible["status"] === "loaded") === attenduCharge) return true;
        }
      } catch {
        /* réessayé au tour suivant */
      }
    }
    return false;
  }

  // Progression réelle du chargement (décorative : la fin reste établie par le sondage de statut).
  function suivreChargement(modelId: string, engineKey?: string): () => void {
    modelLoadPct.value = null;
    modelLoadStage.value = "";
    let es: EventSource;
    try {
      es = new EventSource(
        "/api/llm/models/load-progress?model_id=" +
          encodeURIComponent(modelId) +
          (engineKey && engineKey !== "builtin" ? "&engine=" + encodeURIComponent(engineKey) : ""),
      );
    } catch {
      return () => undefined;
    }
    const fermer = (): void => {
      try {
        es.close();
      } catch {
        /* déjà fermé */
      }
    };
    es.onmessage = (ev: MessageEvent<string>) => {
      let d: unknown;
      try {
        d = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (!estObjet(d) || d["supported"] === false || d["done"]) {
        if (estObjet(d) && d["done"] && d["loaded"] === true) modelLoadPct.value = 100;
        fermer();
        return;
      }
      if (typeof d["pct"] === "number") modelLoadPct.value = d["pct"];
      if (typeof d["stage"] === "string") modelLoadStage.value = d["stage"];
    };
    es.onerror = fermer;
    return () => {
      fermer();
      modelLoadPct.value = null;
      modelLoadStage.value = "";
    };
  }

  function messageEchec(data: unknown, defaut: string): string {
    const d = estObjet(data) ? data : {};
    return String(d["error"] || d["hint"] || defaut);
  }

  async function loadLlmModel(modelId: string): Promise<void> {
    if (!modelId) return;
    generationSondage++;
    isLoadingModel.value = modelId;
    modelLoadingId.value = modelId;
    const arreterSuivi = suivreChargement(modelId);
    try {
      const res = await fetchAuth("/api/llm/models/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_path: modelId }),
      });
      if (res && res.ok) {
        const data: unknown = await res.json();
        if (estObjet(data) && data["ok"]) {
          showToast("Chargement en cours...", "info");
          if (await sonderStatut(modelId, true)) {
            showToast("Modèle chargé !");
            if (!activeModelIds.value.includes(modelId)) activeModelIds.value.push(modelId);
            // Charger un modèle local le sélectionne et revient au moteur local.
            selectedModel.value = modelId;
            choisirConnecteur("");
            stocker("selected_model", modelId);
            stocker("selected_connector", "");
            void lireCtxModele(modelId);
          } else showToast("Timeout -- vérifiez le serveur", "warning");
        } else showToast(messageEchec(data, "Échec"), "error");
      } else showToast("Erreur serveur", "error");
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      arreterSuivi();
      modelLoadingId.value = "";
      isLoadingModel.value = false;
      void loadAvailableModels();
    }
  }

  async function unloadLlmModel(modelId: string): Promise<void> {
    if (!modelId) return;
    if (
      !(await openConfirm(
        "Décharger « " + modelId + " » ?",
        "Le serveur attendra la fin des requêtes en cours.",
        false,
        "Décharger",
      ))
    )
      return;
    generationSondage++;
    isLoadingModel.value = modelId;
    // La barre appartient au chargement : rien à afficher pendant un déchargement.
    modelLoadPct.value = null;
    modelLoadStage.value = "";
    showToast("Attente fin des requêtes...", "info");
    try {
      const res = await fetchAuth("/api/llm/models/unload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_id: modelId }),
      });
      if (res && res.ok) {
        const data: unknown = await res.json();
        if (estObjet(data) && data["ok"]) {
          showToast("Déchargement en cours...", "info");
          if (await sonderStatut(modelId, false)) {
            showToast("Modèle déchargé");
            activeModelIds.value = activeModelIds.value.filter((id) => id !== modelId);
            delete ctxModeles[modelId];
            ctxEnCours.delete(modelId);
          } else showToast("Timeout -- vérifiez le serveur", "warning");
        } else showToast(messageEchec(data, "Non supporté"), "warning");
      } else showToast("Erreur serveur", "error");
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      isLoadingModel.value = false;
      void loadAvailableModels();
    }
  }

  async function sonderStatutConnecteur(
    connId: IdConnecteur,
    modelId: string,
    attenduCharge: boolean,
    maxMs = 120000,
  ): Promise<boolean> {
    const limite = Date.now() + maxMs;
    const mienne = generationSondage;
    while (Date.now() < limite) {
      await attendre(2000);
      if (mienne !== generationSondage) return false;
      await loadConnModels(connId, { force: true });
      const v = pickerConnState.value[String(connId)]?.statuses[modelId];
      if (v !== undefined && (v === "loaded") === attenduCharge) return true;
    }
    return false;
  }

  async function toggleConnModel(conn: ConnecteurModele | null, modelId: string): Promise<void> {
    if (!conn || !modelId || isLoadingModel.value) return;
    const engine = "conn:" + conn.id;
    const charge = isConnModelLoaded(conn.id, modelId);
    if (
      charge &&
      !(await openConfirm(
        "Décharger « " + modelId + " » ?",
        "Sur " +
          (conn.label || conn.provider_type || "") +
          ". Le serveur attendra la fin des requêtes en cours.",
        false,
        "Décharger",
      ))
    )
      return;
    generationSondage++;
    isLoadingModel.value = engine + "|" + modelId;
    let arreterSuivi: () => void = () => undefined;
    if (!charge) {
      modelLoadingId.value = modelId;
      arreterSuivi = suivreChargement(modelId, engine);
    }
    try {
      const res = await fetchAuth("/api/llm/models/" + (charge ? "unload" : "load"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(charge ? { model_id: modelId, engine } : { model_path: modelId, engine }),
      });
      const data: unknown = res ? await res.json().catch(() => ({})) : {};
      const d = estObjet(data) ? data : {};
      if (res && res.ok && d["ok"]) {
        const pret = await sonderStatutConnecteur(conn.id, modelId, !charge);
        if (!pret) showToast("Timeout -- vérifiez le serveur", "warning");
        else if (!charge) {
          showToast("Modèle chargé !");
          pickConnectorModel(conn, modelId, { silent: true });
        } else showToast("Modèle déchargé");
      } else {
        showToast(
          String(d["error"] || d["detail"] || "Échec"),
          res && res.status === 403 ? "warning" : "error",
        );
      }
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      arreterSuivi();
      modelLoadingId.value = "";
      isLoadingModel.value = false;
      void loadConnModels(conn.id, { force: true });
    }
  }

  // Jamais de chaîne vide persistée : un vidage transitoire garde la préférence.
  watch(selectedModel, (val) => {
    if (!val) return;
    stocker("selected_model", val);
    if (connecteurChoisi()) stocker("selected_conn_model", val);
  });
  if (selectedConnector)
    watch(selectedConnector, (val) => stocker("selected_connector", val ? String(val) : ""));

  return {
    modelLoadPct,
    modelLoadStage,
    modelLoadingId,
    loadAvailableModels,
    isModelLoaded,
    isModelFailed,
    toggleLlmModel,
    loadLlmModel,
    unloadLlmModel,
    fetchModelProps,
    fmtPropVal,
    kvColor,
    kvTextClass,
    kvDimClass,
    kvBarClass,
    _applyModelData,
    modelsLoading,
    modelsError,
    toggleModelMenu,
    onModelMenuKeydown,
    pickerConnectors,
    pickerConnModels,
    pickerConnFree,
    pickerConnLoading,
    pickerConnState,
    loadLlmConnectors,
    pickLocalModel,
    pickConnectorModel,
    retryConnModels,
    isConnModelLoaded,
    toggleConnModel,
    selectedModelLabel,
    builtinAllowed,
    canManageModels,
    noEngineAllowed,
  };
}
