// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/mcp.ts — serveurs MCP du compte : gestionnaire (ajout, édition, test, visibilité), bibliothèque partagée, recettes, dossiers déposés. */
import { schemaReponseServeursPartages, schemaReponseTestMcp } from "@elpis/contracts";
import type { ServeurPartage } from "@elpis/contracts";
import type { Ref } from "vue";

import { corpsJson, detailErreur, listeObjets, objet, texte } from "../../utils/lecture-json";
import type { Persistance } from "./persistance";
import { clonerValeur } from "./types";
import type { ConfigChat, CtxReglages, PaireMcp, ReglagesApp, ServeurMcp, VueReglages } from "./types";

const ENTETES_JSON = { "Content-Type": "application/json" };
const MAX_PAIRES = 20;

export interface FormulaireMcp {
  id?: string;
  name: string;
  type: string;
  url: string;
  command: string;
  auth_mode: string;
  auth_user: string;
  auth_secret: string;
  has_auth: boolean;
  headers: PaireMcp[];
  env: PaireMcp[];
  enabled?: boolean;
  _idx: number | null;
}

/** Serveur affichable dans le panneau MCP : perso (visible) ou publié par la bibliothèque partagée. */
export interface ServeurEpingle {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  shared?: boolean;
  [cle: string]: unknown;
}

export interface EtatTestMcp {
  busy: boolean;
  ok: boolean | null;
  msg: string;
  scope: string;
}

export interface DossierMcp {
  name: string;
  suggested_cmd?: string;
  [cle: string]: unknown;
}

type Recette = Pick<FormulaireMcp, "name" | "type" | "auth_mode" | "auth_user" | "headers" | "env"> &
  Partial<Pick<FormulaireMcp, "url" | "command">>;

const MCP_PRESETS: Readonly<Record<string, Recette>> = {
  jenkins: {
    name: "Jenkins",
    type: "sse",
    url: "https://VOTRE-JENKINS/mcp-server/sse",
    auth_mode: "basic",
    auth_user: "",
    headers: [],
    env: [],
  },
  wikijs: {
    name: "Wiki.js",
    type: "http",
    url: "http://VOTRE-HOTE:4445/mcp",
    auth_mode: "bearer",
    auth_user: "",
    headers: [{ name: "X-API-Key", value: "", has_value: false }],
    env: [],
  },
  wikijs_local: {
    name: "Wiki.js (local)",
    type: "stdio",
    command: "npx -y wikijs-mcp",
    auth_mode: "",
    auth_user: "",
    headers: [],
    env: [
      { name: "WIKIJS_URL", value: "", has_value: false },
      { name: "WIKIJS_TOKEN", value: "", has_value: false },
    ],
  },
};

const formulaireVide = (): FormulaireMcp => ({
  name: "",
  type: "sse",
  url: "",
  command: "",
  auth_mode: "",
  auth_user: "",
  auth_secret: "",
  has_auth: false,
  headers: [],
  env: [],
  _idx: null,
});

/** Paires relues du serveur : la valeur n'est jamais rendue, un champ laissé vide la laisse inchangée. */
const pairesVides = (src: readonly PaireMcp[] | undefined): PaireMcp[] =>
  (src ?? []).map((p) => ({ name: p.name || "", value: "", has_value: !!p.has_value }));

/** Entrées nommées d'une liste de paires, prêtes à partir ; les lignes sans nom sont abandonnées. */
function payloadPaires(paires: readonly PaireMcp[] | undefined): { name: string; value: string }[] {
  return (paires ?? [])
    .filter((p) => (p.name || "").trim())
    .map((p) => ({ name: p.name.trim(), value: p.value || "" }));
}

/** Liste perso telle que le core la sert : jamais de secret, `has_auth` / `has_value` pour l'indice « inchangé ». */
export function normaliserServeursMcp(brut: unknown): ServeurMcp[] {
  return listeObjets(brut).map((s, idx) => ({
    ...s,
    visible: s["visible"] !== undefined ? Boolean(s["visible"]) : true,
    type: typeof s["type"] === "string" && s["type"] ? s["type"] : "sse",
    command: typeof s["command"] === "string" ? s["command"] : "",
    id: typeof s["id"] === "string" && s["id"] ? s["id"] : `server_${idx}_${Date.now()}`,
    name: typeof s["name"] === "string" ? s["name"] : "",
    url: typeof s["url"] === "string" ? s["url"] : "",
  }));
}

/** Serveur sans valeur secrète, drapeaux `has_auth` / `has_value` posés comme le core les rendrait. */
function sansSecrets(srv: ServeurMcp): ServeurMcp {
  const { auth_secret, ...reste } = srv;
  const masquer = (l: readonly PaireMcp[] | undefined): PaireMcp[] | undefined =>
    l?.map((p) => ({ name: p.name, value: "", has_value: !!p.value || !!p.has_value }));
  return {
    ...reste,
    has_auth: !!auth_secret || !!srv.has_auth,
    headers: masquer(srv.headers),
    env: masquer(srv.env),
  };
}

/** Vrai si le serveur porte des identifiants (créneau principal, en-têtes ou variables). */
export function mcpHasCreds(srv: Partial<ServeurMcp> | null | undefined): boolean {
  if (!srv) return false;
  const any = (l: readonly PaireMcp[] | undefined): boolean => (l ?? []).some((p) => p && p.has_value);
  return !!srv.has_auth || any(srv.headers) || any(srv.env);
}

export function mcpAddPair(form: FormulaireMcp | null, kind: "headers" | "env"): void {
  if (!form) return;
  if (!Array.isArray(form[kind])) form[kind] = [];
  if (form[kind].length >= MAX_PAIRES) return;
  form[kind].push({ name: "", value: "", has_value: false });
}

export function mcpRemovePair(form: FormulaireMcp | null, kind: "headers" | "env", idx: number): void {
  if (form && Array.isArray(form[kind])) form[kind].splice(idx, 1);
}

export function creerMcp(
  vue: VueReglages,
  settings: Ref<ReglagesApp>,
  config: Ref<ConfigChat>,
  ctx: CtxReglages,
  persistance: Persistance,
) {
  const { computed, ref } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const showMcpManagerModal = ref(false);
  const newMcp: Ref<FormulaireMcp> = ref(formulaireVide());
  const customMcpList: Ref<DossierMcp[]> = ref([]);
  const mcpFileInput: Ref<HTMLInputElement | null> = ref(null);
  const mcpSearch = ref("");
  const sharedMcpServers: Ref<ServeurPartage[]> = ref([]);
  const sharedMcpForm: Ref<FormulaireMcp | null> = ref(null);
  const sharedMcpError = ref("");
  const sharedMcpSaving = ref(false);
  const mcpTest: Ref<EtatTestMcp> = ref({ busy: false, ok: null, msg: "", scope: "" });

  async function loadSharedMcpServers(): Promise<void> {
    try {
      const r = await fetchAuth("/api/mcp/shared-servers", {}, true);
      if (!r || !r.ok) return;
      const lu = schemaReponseServeursPartages.safeParse(await corpsJson(r));
      sharedMcpServers.value = lu.success ? lu.data.servers : [];
    } catch {
      /* réseau : la bibliothèque reste vide, le reste marche */
    }
  }

  const isSharedVisible = (id: string): boolean => (settings.value.shared_mcp_visible ?? []).includes(id);

  async function toggleSharedVisibility(id: string): Promise<void> {
    const visibles = settings.value.shared_mcp_visible ?? (settings.value.shared_mcp_visible = []);
    const i = visibles.indexOf(id);
    if (i >= 0) {
      visibles.splice(i, 1);
      config.value.active_mcp_ids = (config.value.active_mcp_ids ?? []).filter((x) => x !== id);
    } else {
      visibles.push(id);
    }
    await persistance.saveSettings(false);
  }

  /** Projection unique de la bibliothèque partagée vers la forme « serveur » du panneau MCP. */
  const visibleSharedServers = computed(() =>
    sharedMcpServers.value
      .filter((s) => s.enabled && isSharedVisible(s.id))
      .map((s) => ({ id: s.id, name: s.name, type: s.type, visible: true, shared: true })),
  );
  const pinnedServers = computed<ServeurEpingle[]>(() => [
    ...(settings.value.mcp_servers ?? []).filter((s) => s.visible),
    ...visibleSharedServers.value,
  ]);
  const agentMcpChoices = computed<ServeurEpingle[]>(() => [
    ...(settings.value.mcp_servers ?? []),
    ...visibleSharedServers.value,
  ]);

  /** Serveurs enregistrés filtrés par la recherche ; `_idx` garde l'index d'origine. */
  const filteredMcpServers = computed(() => {
    const items = (settings.value.mcp_servers ?? []).map((s, i) => ({ ...s, _idx: i }));
    const q = (mcpSearch.value || "").trim().toLowerCase();
    if (!q) return items;
    return items.filter((s) =>
      [s.name, s.url, s.command, s.type].filter(Boolean).join(" ").toLowerCase().includes(q),
    );
  });

  const clearMcpTest = (): void => {
    mcpTest.value = { busy: false, ok: null, msg: "", scope: "" };
  };

  async function addMcpServer(): Promise<void> {
    const f = newMcp.value;
    if (!f.name) return;
    if (f.type !== "stdio" && !f.url) {
      showToast("URL requise pour un serveur SSE/HTTP", "error");
      return;
    }
    if (f.type === "stdio" && !f.command) {
      showToast("Commande requise pour un serveur stdio", "error");
      return;
    }
    if (!settings.value.mcp_servers) settings.value.mcp_servers = [];
    const liste = settings.value.mcp_servers;
    const editing = f._idx != null;
    const prev: Partial<ServeurMcp> = editing ? (liste[f._idx as number] ?? {}) : {};
    const srv: ServeurMcp = {
      name: f.name,
      type: f.type,
      url: f.url || "",
      command: f.command || "",
      visible: editing ? prev.visible !== false : true,
      id: editing ? (prev.id ?? "") : `server_${Date.now()}`,
    };
    if (f.type !== "stdio") {
      const mode = (f.auth_mode || "").trim();
      srv.auth_mode = mode;
      if (mode === "basic" || mode === "header") srv.auth_user = f.auth_user || "";
      if (mode && f.auth_secret) srv.auth_secret = f.auth_secret;
      srv.headers = payloadPaires(f.headers) as PaireMcp[];
    } else {
      srv.env = payloadPaires(f.env) as PaireMcp[];
    }
    const avant = clonerValeur(liste);
    if (editing) liste[f._idx as number] = srv;
    else liste.push(srv);
    const ok = await persistance.persistKeys(["mcp_servers"], {
      rollback: () => {
        settings.value.mcp_servers = avant;
      },
    });
    if (!ok) return;
    newMcp.value = formulaireVide();
    await relireServeursPerso();
  }

  // Après un enregistrement : la copie locale portait les secrets saisis, la vue du core (ou à défaut la copie expurgée) la remplace.
  async function relireServeursPerso(): Promise<void> {
    let lus: ServeurMcp[] | null = null;
    try {
      const r = await fetchAuth("/api/settings", {}, true);
      if (r && r.ok) lus = normaliserServeursMcp(objet(await corpsJson(r))["mcp_servers"]);
    } catch {
      /* réseau : repli sur la copie locale expurgée */
    }
    const propres = lus ?? (settings.value.mcp_servers ?? []).map(sansSecrets);
    settings.value.mcp_servers = propres;
    persistance.majInstantane((s) => {
      s["mcp_servers"] = clonerValeur(propres);
    });
  }

  function editMcpServer(idx: number): void {
    const srv = settings.value.mcp_servers?.[idx];
    if (!srv) return;
    newMcp.value = {
      name: srv.name || "",
      type: srv.type || "sse",
      url: srv.url || "",
      command: srv.command || "",
      auth_mode: srv.auth_mode || "",
      auth_user: srv.auth_user || "",
      auth_secret: "",
      has_auth: !!srv.has_auth,
      headers: pairesVides(srv.headers),
      env: pairesVides(srv.env),
      _idx: idx,
    };
    clearMcpTest();
  }

  function cancelMcpEdit(): void {
    newMcp.value = formulaireVide();
    clearMcpTest();
  }

  /** Éprouve la configuration telle que saisie, sans l'enregistrer ; secret vide = celui déjà stocké. */
  async function testMcpServer(scope: string): Promise<void> {
    const f = scope === "shared" ? sharedMcpForm.value : newMcp.value;
    if (!f) return;
    const corps: Record<string, unknown> = {
      name: f.name || "",
      type: f.type || "sse",
      url: f.url || "",
      command: f.command || "",
      auth_mode: f.auth_mode || "",
      auth_user: f.auth_user || "",
      auth_secret: f.auth_secret || "",
      headers: payloadPaires(f.headers),
      env: payloadPaires(f.env),
    };
    if (scope === "shared") {
      corps["shared"] = true;
      if (f.id) corps["id"] = f.id;
    } else if (f._idx != null) {
      const cur = (settings.value.mcp_servers ?? [])[f._idx];
      if (cur?.id) corps["id"] = cur.id;
    }
    mcpTest.value = { busy: true, ok: null, msg: "", scope };
    try {
      const r = await fetchAuth("/api/mcp/test", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify(corps),
      });
      if (!r) throw new Error("pas de réponse");
      const d = await corpsJson(r);
      if (!r.ok) {
        mcpTest.value = { busy: false, ok: false, scope, msg: detailErreur(d) || `Erreur ${r.status}` };
        return;
      }
      const lu = schemaReponseTestMcp.safeParse(d);
      if (lu.success && lu.data.ok) {
        mcpTest.value = {
          busy: false,
          ok: true,
          scope,
          msg: `${lu.data.tools.length} outil(s) — ${lu.data.ms} ms`,
        };
      } else {
        mcpTest.value = { busy: false, ok: false, scope, msg: texte(objet(d)["error"]) || "Échec" };
      }
    } catch {
      mcpTest.value = { busy: false, ok: false, scope, msg: "Requête impossible" };
    }
  }

  /** Fermeture du gestionnaire : n'enregistre la liste que si elle diffère de l'état connu du serveur. */
  async function closeMcpManager(): Promise<void> {
    showMcpManagerModal.value = false;
    try {
      const snap = objet(JSON.parse(persistance.snapshot.value || "{}"));
      if (JSON.stringify(settings.value.mcp_servers ?? []) !== JSON.stringify(snap["mcp_servers"] ?? [])) {
        await persistance.persistKeys(["mcp_servers"]);
      }
    } catch {
      /* instantané illisible : rien à comparer */
    }
    newMcp.value = formulaireVide();
  }

  async function removeMcpServer(idx: number): Promise<void> {
    const srv = settings.value.mcp_servers?.[idx];
    if (!srv) return;
    const srvId = srv.id;
    const ok = await openConfirm("Supprimer ce serveur MCP ?", srv.name || "", true);
    if (!ok) return;
    const avant = clonerValeur(settings.value.mcp_servers);
    const actifsAvant = clonerValeur(config.value.active_mcp_ids ?? []);
    settings.value.mcp_servers?.splice(idx, 1);
    config.value.active_mcp_ids = (config.value.active_mcp_ids ?? []).filter((id) => id !== srvId);
    await persistance.persistKeys(["mcp_servers"], {
      rollback: () => {
        settings.value.mcp_servers = avant;
        config.value.active_mcp_ids = actifsAvant;
      },
    });
  }

  async function toggleServerVisibility(idx: number): Promise<void> {
    const srv = settings.value.mcp_servers?.[idx];
    if (!srv) return;
    const actifsAvant = clonerValeur(config.value.active_mcp_ids ?? []);
    srv.visible = !srv.visible;
    if (!config.value.active_mcp_ids) config.value.active_mcp_ids = [];
    if (!srv.visible) config.value.active_mcp_ids = config.value.active_mcp_ids.filter((id) => id !== srv.id);
    await persistance.persistKeys(["mcp_servers"], {
      rollback: () => {
        srv.visible = !srv.visible;
        config.value.active_mcp_ids = actifsAvant;
      },
    });
  }

  /** Bascule l'id dans la liste active ; l'état par chat est poussé par le watcher du panneau MCP. */
  function activateExternalServer(id: string): void {
    if (!config.value.active_mcp_ids) config.value.active_mcp_ids = [];
    const i = config.value.active_mcp_ids.indexOf(id);
    if (i > -1) config.value.active_mcp_ids.splice(i, 1);
    else config.value.active_mcp_ids.push(id);
  }

  function newSharedMcp(): void {
    sharedMcpError.value = "";
    clearMcpTest();
    sharedMcpForm.value = { ...formulaireVide(), id: "", enabled: true };
  }

  function editSharedMcp(srv: ServeurPartage): void {
    sharedMcpError.value = "";
    clearMcpTest();
    sharedMcpForm.value = {
      id: srv.id,
      name: srv.name || "",
      type: srv.type || "sse",
      url: srv.url || "",
      command: srv.command || "",
      auth_mode: srv.auth_mode || "",
      auth_user: srv.auth_user || "",
      auth_secret: "",
      enabled: srv.enabled !== false,
      headers: pairesVides(srv.headers),
      env: pairesVides(srv.env),
      has_auth: !!srv.has_auth,
      _idx: null,
    };
  }

  function cancelSharedMcp(): void {
    sharedMcpForm.value = null;
    sharedMcpError.value = "";
    clearMcpTest();
  }

  /** Remplit un formulaire (perso ou partagé) avec une recette connue. */
  function applyMcpPreset(scope: string, key: string): void {
    const p = MCP_PRESETS[key];
    if (!p) return;
    const copie = clonerValeur(p);
    if (scope === "shared") {
      if (!sharedMcpForm.value) newSharedMcp();
      if (sharedMcpForm.value) Object.assign(sharedMcpForm.value, copie);
    } else {
      newMcp.value = Object.assign(formulaireVide(), copie, { _idx: newMcp.value._idx });
    }
    clearMcpTest();
  }

  async function saveSharedMcp(): Promise<void> {
    const f = sharedMcpForm.value;
    if (!f || sharedMcpSaving.value) return;
    if (!(f.name || "").trim()) {
      sharedMcpError.value = "Nom requis.";
      return;
    }
    if (f.type !== "stdio" && !(f.url || "").trim()) {
      sharedMcpError.value = "URL requise pour un serveur HTTP/SSE.";
      return;
    }
    if (f.type === "stdio" && !(f.command || "").trim()) {
      sharedMcpError.value = "Commande requise pour un serveur local.";
      return;
    }
    const corps = {
      name: f.name.trim(),
      type: f.type,
      url: f.url || "",
      command: f.command || "",
      auth_mode: f.auth_mode || "",
      auth_user: f.auth_user || "",
      auth_secret: f.auth_secret || "",
      headers: payloadPaires(f.headers),
      env: payloadPaires(f.env),
      enabled: f.enabled !== false,
    };
    const url = f.id ? "/api/mcp/shared-servers/" + encodeURIComponent(f.id) : "/api/mcp/shared-servers";
    sharedMcpSaving.value = true;
    try {
      const r = await fetchAuth(url, {
        method: f.id ? "PUT" : "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify(corps),
      });
      if (!r || !r.ok) {
        const detail = r ? detailErreur(await corpsJson(r)) : "";
        sharedMcpError.value = detail || "Publication refusée.";
        return;
      }
      sharedMcpForm.value = null;
      await loadSharedMcpServers();
      showToast("Serveur publié pour tous les utilisateurs.", "success");
    } catch {
      sharedMcpError.value = "Erreur réseau.";
    } finally {
      sharedMcpSaving.value = false;
    }
  }

  async function deleteSharedMcp(srv: Pick<ServeurPartage, "id" | "name">): Promise<void> {
    const ok = await openConfirm(
      "Dépublier ce serveur ?",
      (srv.name || "") + " — il disparaîtra de tous les comptes.",
      true,
      "Dépublier",
    );
    if (!ok) return;
    try {
      const r = await fetchAuth("/api/mcp/shared-servers/" + encodeURIComponent(srv.id), {
        method: "DELETE",
      });
      if (r?.ok) {
        await loadSharedMcpServers();
        if (sharedMcpForm.value?.id === srv.id) cancelSharedMcp();
      }
    } catch {
      /* au mieux */
    }
  }

  async function loadCustomMcpServers(): Promise<void> {
    try {
      const res = await fetchAuth("/api/mcp/custom-servers", {}, true);
      if (res?.ok) customMcpList.value = listeObjets(objet(await corpsJson(res))["servers"]) as DossierMcp[];
    } catch {
      /* liste inchangée */
    }
  }

  const triggerMcpUpload = (): void => mcpFileInput.value?.click();

  async function handleMcpUpload(event: Event): Promise<void> {
    const cible = event.target instanceof HTMLInputElement ? event.target : null;
    const files = cible?.files;
    if (!files || files.length === 0) return;
    const formData = new FormData();
    for (const f of Array.from(files)) {
      formData.append("files", f);
      formData.append("paths", f.webkitRelativePath || f.name);
    }
    try {
      const res = await fetchAuth("/api/mcp/upload", { method: "POST", body: formData });
      if (res?.ok) void loadCustomMcpServers();
    } catch {
      /* envoi échoué : liste inchangée */
    }
    if (mcpFileInput.value) mcpFileInput.value.value = "";
  }

  async function deleteCustomServer(name: string): Promise<void> {
    const confirme = await openConfirm("Supprimer ce serveur MCP ?", name || "", true, "Supprimer");
    if (!confirme) return;
    try {
      await fetchAuth(`/api/mcp/custom-servers/${name}`, { method: "DELETE" });
      void loadCustomMcpServers();
    } catch {
      /* au mieux */
    }
  }

  function useCustomServer(srv: DossierMcp): void {
    newMcp.value.name = srv.name;
    newMcp.value.type = "stdio";
    newMcp.value.command = srv.suggested_cmd || `python ${srv.name}/main.py`;
    newMcp.value.url = "";
  }

  return {
    showMcpManagerModal,
    newMcp,
    customMcpList,
    mcpFileInput,
    mcpSearch,
    filteredMcpServers,
    pinnedServers,
    agentMcpChoices,
    sharedMcpServers,
    sharedMcpForm,
    sharedMcpError,
    sharedMcpSaving,
    loadSharedMcpServers,
    isSharedVisible,
    toggleSharedVisibility,
    newSharedMcp,
    editSharedMcp,
    cancelSharedMcp,
    applyMcpPreset,
    mcpAddPair,
    mcpRemovePair,
    mcpHasCreds,
    saveSharedMcp,
    deleteSharedMcp,
    addMcpServer,
    editMcpServer,
    cancelMcpEdit,
    closeMcpManager,
    removeMcpServer,
    toggleServerVisibility,
    activateExternalServer,
    mcpTest,
    testMcpServer,
    loadCustomMcpServers,
    triggerMcpUpload,
    handleMcpUpload,
    deleteCustomServer,
    useCustomServer,
  };
}
