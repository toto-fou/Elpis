// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/mcp.ts — serveurs MCP du compte : gestionnaire à deux volets (liste, détail éditable, test, épinglage), bibliothèque partagée, modèles. */
import {
  schemaReponseServeurPartage,
  schemaReponseServeursPartages,
  schemaReponseTestMcp,
} from "@elpis/contracts";
import type { ServeurPartage } from "@elpis/contracts";
import type { Ref } from "vue";

import { corpsJson, detailErreur, listeObjets, objet, texte } from "../../utils/lecture-json";
import type { Persistance } from "./persistance";
import { clonerValeur } from "./types";
import type { ConfigChat, CtxReglages, PaireMcp, ReglagesApp, ServeurMcp, VueReglages } from "./types";

const ENTETES_JSON = { "Content-Type": "application/json" };
const MAX_PAIRES = 20;
const DUREE_FLASH_MS = 1600;

export type PorteeMcp = "perso" | "partage";

/** Formulaire unique du détail : un serveur perso ou publié, `id` vide pour un nouveau. */
export interface FormulaireMcp {
  portee: PorteeMcp;
  id: string;
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
  enabled: boolean;
  /** Secret du coffre illisible, retiré ou non repris (lecture seule) : à ressaisir. */
  secret_error?: string;
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
  outils: number;
  ms: number;
}

export type GenreEtatMcp = "ok" | "err" | "none" | "busy";

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

export const MODELES_MCP: readonly { cle: string; libelle: string; type: string }[] = Object.entries(
  MCP_PRESETS,
).map(([cle, r]) => ({ cle, libelle: r.name, type: r.type }));
export const TYPES_MCP: Readonly<Record<string, string>> = { http: "HTTP", sse: "SSE", stdio: "Local" };
export const ICONES_MCP: Readonly<Record<string, string>> = {
  http: "ph-globe",
  sse: "ph-broadcast",
  stdio: "ph-terminal-window",
};

const formulaireVide = (portee: PorteeMcp = "perso"): FormulaireMcp => ({
  portee,
  id: "",
  name: "",
  type: "http",
  url: "",
  command: "",
  auth_mode: "",
  auth_user: "",
  auth_secret: "",
  has_auth: false,
  headers: [],
  env: [],
  enabled: true,
  secret_error: "",
});

/** Paires relues du serveur : la valeur n'est jamais rendue, un champ laissé vide la laisse inchangée. */
const pairesVides = (src: readonly { name?: string; has_value?: boolean }[] | undefined): PaireMcp[] =>
  (src ?? []).map((p) => ({ name: p.name || "", value: "", has_value: !!p.has_value }));

/** Entrées nommées d'une liste de paires, prêtes à partir ; les lignes sans nom sont abandonnées. */
function payloadPaires(paires: readonly PaireMcp[] | undefined): { name: string; value: string }[] {
  return (paires ?? [])
    .filter((p) => (p.name || "").trim())
    .map((p) => ({ name: p.name.trim(), value: p.value || "" }));
}

function formDepuis(srv: Partial<ServeurMcp> | ServeurPartage, portee: PorteeMcp): FormulaireMcp {
  return {
    portee,
    id: String(srv.id ?? ""),
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
    enabled: "enabled" in srv ? srv.enabled !== false : true,
    secret_error: typeof srv.secret_error === "string" ? srv.secret_error : "",
  };
}

const instantane = (f: FormulaireMcp | null): string => (f ? JSON.stringify(f) : "");
/** Ce que « Tester » éprouve, sans aucune valeur secrète : sert à périmer un résultat. */
const empreinte = (f: FormulaireMcp): string =>
  JSON.stringify([
    f.type,
    f.url,
    f.command,
    f.auth_mode,
    f.auth_user,
    f.headers.map((p) => p.name),
    f.env.map((p) => p.name),
  ]);

/** Champs requis manquants, par nom de champ (affichés sous le champ). */
export function erreursFormulaireMcp(f: FormulaireMcp): Record<string, string> {
  const e: Record<string, string> = {};
  if (!f.name.trim()) e["name"] = "Nom requis";
  if (f.type === "stdio") {
    if (!f.command.trim()) e["command"] = "Commande requise";
  } else if (!f.url.trim()) e["url"] = "Adresse requise, ex. http://hote:4445/mcp";
  return e;
}

/** Libellé court ou long du dernier test ; « 0 erreur » reste neutre, seul l'échec est coloré. */
export function resumeTestMcp(
  t: EtatTestMcp | undefined,
  long = false,
): { genre: GenreEtatMcp; texte: string } {
  if (t?.busy) return { genre: "busy", texte: "Test…" };
  if (!t || t.ok === null) return { genre: "none", texte: "Non testé" };
  if (t.ok) {
    const outils = `${t.outils} outil${t.outils > 1 ? "s" : ""}`;
    return { genre: "ok", texte: long ? `${outils} · ${t.ms} ms` : outils };
  }
  return { genre: "err", texte: long ? `Échec · ${t.msg}` : "Échec" };
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

export function mcpAddPair(form: FormulaireMcp | null, kind: "headers" | "env"): void {
  if (!form || form[kind].length >= MAX_PAIRES) return;
  form[kind].push({ name: "", value: "", has_value: false });
}

export function mcpRemovePair(form: FormulaireMcp | null, kind: "headers" | "env", idx: number): void {
  form?.[kind].splice(idx, 1);
}

export function creerMcp(
  vue: VueReglages,
  settings: Ref<ReglagesApp>,
  config: Ref<ConfigChat>,
  ctx: CtxReglages,
  persistance: Persistance,
) {
  const { computed, ref } = vue;
  const { showToast, fetchAuth } = ctx;
  const showMcpManagerModal = ref(false);
  const mcpSel: Ref<string | null> = ref(null);
  const mcpForm: Ref<FormulaireMcp | null> = ref(null);
  const mcpOrig = ref("");
  const mcpGarde: Ref<string | null> = ref(null);
  const mcpConfirmer = ref(false);
  const mcpErreurs: Ref<Record<string, string>> = ref({});
  const mcpErreur = ref("");
  const mcpOccupe = ref(false);
  const mcpFlash = ref("");
  const mcpTests: Ref<Record<string, EtatTestMcp>> = ref({});
  const mcpSearch = ref("");
  const sharedMcpServers: Ref<ServeurPartage[]> = ref([]);
  let minuterieFlash: ReturnType<typeof setTimeout> | null = null;
  const testsEnVol = new Map<number, string | null>();
  const configTestee: Record<string, string> = {};
  let numeroTest = 0;

  /** Redirige les tests en vol (et la config éprouvée) d'une clé vers une autre ; `null` les abandonne. */
  function reorienterTests(de: string, vers: string | null): void {
    for (const [n, cle] of testsEnVol) if (cle === de) testsEnVol.set(n, vers);
    const c = configTestee[de];
    delete configTestee[de];
    if (vers && c !== undefined) configTestee[vers] = c;
  }

  const mcpSale = computed(() => !!mcpForm.value && instantane(mcpForm.value) !== mcpOrig.value);
  const cherche = (s: { name?: string; url?: string; command?: string; type?: string }): boolean => {
    const q = mcpSearch.value.trim().toLowerCase();
    return !q || [s.name, s.url, s.command, s.type].filter(Boolean).join(" ").toLowerCase().includes(q);
  };
  const mcpListePerso = computed(() => (settings.value.mcp_servers ?? []).filter(cherche));
  const mcpListePartages = computed(() => sharedMcpServers.value.filter(cherche));

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

  const retirerActif = (id: string): void => {
    config.value.active_mcp_ids = (config.value.active_mcp_ids ?? []).filter((x) => x !== id);
  };

  async function toggleSharedVisibility(id: string): Promise<void> {
    const visibles = settings.value.shared_mcp_visible ?? (settings.value.shared_mcp_visible = []);
    const i = visibles.indexOf(id);
    if (i >= 0) {
      visibles.splice(i, 1);
      retirerActif(id);
    } else {
      visibles.push(id);
    }
    await persistance.saveSettings(false);
  }

  async function toggleServerVisibility(id: string): Promise<void> {
    const srv = settings.value.mcp_servers?.find((s) => s.id === id);
    if (!srv) return;
    const actifsAvant = clonerValeur(config.value.active_mcp_ids ?? []);
    srv.visible = !srv.visible;
    if (!srv.visible) retirerActif(srv.id);
    await persistance.persistKeys(["mcp_servers"], {
      rollback: () => {
        srv.visible = !srv.visible;
        config.value.active_mcp_ids = actifsAvant;
      },
    });
  }

  const mcpEstEpingle = (portee: PorteeMcp, id: string): boolean =>
    portee === "perso"
      ? !!settings.value.mcp_servers?.find((s) => s.id === id)?.visible
      : isSharedVisible(id);

  async function mcpBasculerPanneau(): Promise<void> {
    const f = mcpForm.value;
    if (!f?.id) return;
    await (f.portee === "perso" ? toggleServerVisibility(f.id) : toggleSharedVisibility(f.id));
  }

  /** Bascule l'id dans la liste active ; l'état par chat est poussé par le watcher du panneau MCP. */
  function activateExternalServer(id: string): void {
    if (!config.value.active_mcp_ids) config.value.active_mcp_ids = [];
    const i = config.value.active_mcp_ids.indexOf(id);
    if (i > -1) config.value.active_mcp_ids.splice(i, 1);
    else config.value.active_mcp_ids.push(id);
  }

  /** Charge la sélection (« p:<id> », « s:<id> » ou « nouveau ») dans le détail. */
  function charger(cle: string | null): void {
    mcpSel.value = cle;
    mcpConfirmer.value = false;
    mcpGarde.value = null;
    mcpErreurs.value = {};
    mcpErreur.value = "";
    mcpFlash.value = "";
    reorienterTests("nouveau", null);
    delete mcpTests.value["nouveau"];
    const id = cle ? cle.slice(2) : "";
    if (cle === "nouveau") mcpForm.value = formulaireVide();
    else if (cle?.startsWith("p:")) {
      const srv = settings.value.mcp_servers?.find((s) => s.id === id);
      mcpForm.value = srv ? formDepuis(srv, "perso") : null;
    } else if (cle?.startsWith("s:")) {
      const srv = sharedMcpServers.value.find((s) => s.id === id);
      mcpForm.value = srv ? formDepuis(srv, "partage") : null;
    } else mcpForm.value = null;
    mcpOrig.value = cle === "nouveau" ? instantane(formulaireVide()) : instantane(mcpForm.value);
  }

  const premiereCle = (): string => {
    const p = settings.value.mcp_servers?.[0];
    return p ? `p:${p.id}` : "nouveau";
  };

  /** Change de sélection ; une saisie en cours passe d'abord par la garde. */
  function mcpChoisir(cle: string): void {
    if (cle === mcpSel.value || mcpOccupe.value) return;
    if (mcpSale.value) {
      mcpGarde.value = cle;
      return;
    }
    charger(cle);
  }

  const mcpNouveau = (): void => mcpChoisir("nouveau");

  function mcpAppliquerModele(cle: string): void {
    const p = MCP_PRESETS[cle];
    const f = mcpForm.value;
    if (!p || !f || f.id || (p.type === "stdio" && f.portee === "partage")) return;
    Object.assign(f, formulaireVide(f.portee), clonerValeur(p));
    mcpErreurs.value = {};
  }

  function mcpSetType(type: string): void {
    const f = mcpForm.value;
    if (!f || (type === "stdio" && f.portee === "partage")) return;
    f.type = type;
    mcpErreurs.value = {};
  }

  /** Portée d'un nouveau serveur ; la bibliothèque refuse les serveurs locaux. */
  function mcpSetPortee(portee: PorteeMcp): void {
    const f = mcpForm.value;
    if (!f || f.id) return;
    f.portee = portee;
    if (portee === "partage" && f.type === "stdio") f.type = "http";
  }

  const mcpEffacerErreur = (champ: string): void => {
    if (mcpErreurs.value[champ]) delete mcpErreurs.value[champ];
  };

  function corpsServeur(f: FormulaireMcp): Record<string, unknown> {
    return {
      name: f.name.trim(),
      type: f.type || "sse",
      url: f.url.trim(),
      command: f.command.trim(),
      auth_mode: f.auth_mode || "",
      auth_user: f.auth_user || "",
      auth_secret: f.auth_secret || "",
      headers: payloadPaires(f.headers),
      env: payloadPaires(f.env),
    };
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

  async function enregistrerPerso(f: FormulaireMcp): Promise<string | null> {
    if (!settings.value.mcp_servers) settings.value.mcp_servers = [];
    const liste = settings.value.mcp_servers;
    const i = f.id ? liste.findIndex((s) => s.id === f.id) : -1;
    const prev = i >= 0 ? liste[i] : undefined;
    const local = f.type === "stdio";
    const srv: ServeurMcp = {
      name: f.name.trim(),
      type: f.type,
      url: local ? "" : f.url.trim(),
      command: local ? f.command.trim() : "",
      visible: prev ? prev.visible !== false : true,
      id: prev?.id ?? `server_${Date.now()}`,
    };
    if (!local) {
      const mode = (f.auth_mode || "").trim();
      srv.auth_mode = mode;
      if (mode === "basic" || mode === "header") srv.auth_user = f.auth_user || "";
      if (mode && f.auth_secret) srv.auth_secret = f.auth_secret;
      srv.headers = payloadPaires(f.headers) as PaireMcp[];
    } else {
      srv.env = payloadPaires(f.env) as PaireMcp[];
    }
    const avant = clonerValeur(liste);
    if (i >= 0) liste[i] = srv;
    else liste.push(srv);
    const ok = await persistance.persistKeys(["mcp_servers"], {
      rollback: () => {
        settings.value.mcp_servers = avant;
      },
    });
    if (!ok) return null;
    await relireServeursPerso();
    return srv.id;
  }

  async function enregistrerPartage(f: FormulaireMcp): Promise<string | null> {
    const url = f.id ? "/api/mcp/shared-servers/" + encodeURIComponent(f.id) : "/api/mcp/shared-servers";
    try {
      const r = await fetchAuth(url, {
        method: f.id ? "PUT" : "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ ...corpsServeur(f), enabled: f.enabled }),
      });
      const d = r ? await corpsJson(r) : null;
      if (!r || !r.ok) {
        mcpErreur.value = (d ? detailErreur(d) : "") || "Publication refusée.";
        return null;
      }
      // La réponse du core fait foi si la relecture de la bibliothèque échoue.
      const lu = schemaReponseServeurPartage.safeParse(d);
      if (lu.success) {
        const srv = lu.data.server;
        const i = sharedMcpServers.value.findIndex((x) => x.id === srv.id);
        if (i >= 0) sharedMcpServers.value[i] = srv;
        else sharedMcpServers.value.push(srv);
      }
      await loadSharedMcpServers();
      return lu.success ? lu.data.server.id : f.id || null;
    } catch {
      mcpErreur.value = "Erreur réseau.";
      return null;
    }
  }

  function flash(texteFlash: string): void {
    mcpFlash.value = texteFlash;
    if (minuterieFlash) clearTimeout(minuterieFlash);
    minuterieFlash = setTimeout(() => {
      mcpFlash.value = "";
    }, DUREE_FLASH_MS);
  }

  /** Enregistre le détail (perso ou publié) puis le recharge depuis la source ; vrai si c'est fait. */
  async function mcpEnregistrer(): Promise<boolean> {
    const f = mcpForm.value;
    if (!f || mcpOccupe.value) return false;
    mcpErreurs.value = erreursFormulaireMcp(f);
    mcpErreur.value = "";
    if (Object.keys(mcpErreurs.value).length) return false;
    const neuf = !f.id;
    mcpOccupe.value = true;
    try {
      const id = f.portee === "perso" ? await enregistrerPerso(f) : await enregistrerPartage(f);
      if (!id) return false;
      const cleAvant = neuf ? "nouveau" : id;
      if (configTestee[cleAvant] === empreinte(f)) {
        reorienterTests(cleAvant, id);
        const essai = mcpTests.value[cleAvant];
        if (essai) mcpTests.value[id] = essai;
      } else {
        reorienterTests(cleAvant, null);
        delete mcpTests.value[id];
      }
      charger(`${f.portee === "perso" ? "p" : "s"}:${id}`);
      flash(neuf ? (f.portee === "partage" ? "Publié" : "Ajouté") : "Enregistré");
      return true;
    } finally {
      mcpOccupe.value = false;
    }
  }

  /** Éprouve la configuration telle que saisie, sans l'enregistrer ; secret vide = celui déjà stocké. */
  async function mcpTester(): Promise<void> {
    const f = mcpForm.value;
    if (!f) return;
    const cle = f.id || "nouveau";
    const corps = corpsServeur(f);
    if (f.portee === "partage") corps["shared"] = true;
    if (f.id) corps["id"] = f.id;
    const n = ++numeroTest;
    testsEnVol.set(n, cle);
    configTestee[cle] = empreinte(f);
    mcpTests.value[cle] = { busy: true, ok: null, msg: "", outils: 0, ms: 0 };
    let etat: EtatTestMcp;
    try {
      const r = await fetchAuth("/api/mcp/test", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify(corps),
      });
      if (!r) throw new Error("pas de réponse");
      const d = await corpsJson(r);
      const lu = schemaReponseTestMcp.safeParse(d);
      if (!r.ok)
        etat = { busy: false, ok: false, msg: detailErreur(d) || `Erreur ${r.status}`, outils: 0, ms: 0 };
      else if (lu.success && lu.data.ok)
        etat = { busy: false, ok: true, msg: "", outils: lu.data.tools.length, ms: lu.data.ms };
      else etat = { busy: false, ok: false, msg: texte(objet(d)["error"]) || "Échec", outils: 0, ms: 0 };
    } catch {
      etat = { busy: false, ok: false, msg: "Requête impossible", outils: 0, ms: 0 };
    }
    const cible = testsEnVol.get(n);
    testsEnVol.delete(n);
    if (cible) mcpTests.value[cible] = etat;
  }

  const mcpDemanderSuppression = (): void => {
    mcpConfirmer.value = true;
  };
  const mcpAnnulerSuppression = (): void => {
    mcpConfirmer.value = false;
  };

  /** Supprime la sélection (serveur perso ou publié), confirmée en ligne. */
  async function mcpSupprimer(): Promise<void> {
    const cle = mcpSel.value;
    if (!cle || mcpOccupe.value) return;
    const id = cle.slice(2);
    mcpOccupe.value = true;
    try {
      if (cle.startsWith("p:")) {
        const avant = clonerValeur(settings.value.mcp_servers ?? []);
        const actifsAvant = clonerValeur(config.value.active_mcp_ids ?? []);
        settings.value.mcp_servers = (settings.value.mcp_servers ?? []).filter((s) => s.id !== id);
        retirerActif(id);
        const ok = await persistance.persistKeys(["mcp_servers"], {
          rollback: () => {
            settings.value.mcp_servers = avant;
            config.value.active_mcp_ids = actifsAvant;
          },
        });
        if (!ok) return;
      } else {
        const r = await fetchAuth("/api/mcp/shared-servers/" + encodeURIComponent(id), { method: "DELETE" });
        if (!r?.ok) {
          showToast((r && detailErreur(await corpsJson(r))) || "Suppression refusée", "error");
          return;
        }
        await loadSharedMcpServers();
      }
      delete mcpTests.value[id];
      charger(premiereCle());
    } catch {
      showToast("Erreur réseau", "error");
    } finally {
      mcpOccupe.value = false;
      mcpConfirmer.value = false;
    }
  }

  function fermer(): void {
    showMcpManagerModal.value = false;
    try {
      const snap = objet(JSON.parse(persistance.snapshot.value || "{}"));
      if (JSON.stringify(settings.value.mcp_servers ?? []) !== JSON.stringify(snap["mcp_servers"] ?? [])) {
        void persistance.persistKeys(["mcp_servers"]);
      }
    } catch {
      /* instantané illisible : rien à comparer */
    }
    mcpForm.value = null;
    mcpSel.value = null;
    mcpOrig.value = "";
    mcpGarde.value = null;
    mcpConfirmer.value = false;
  }

  /** Abandonne la saisie et poursuit le geste retenu par la garde. */
  function mcpAbandonner(): void {
    if (mcpOccupe.value) return;
    const g = mcpGarde.value;
    mcpGarde.value = null;
    if (g === "fermer") fermer();
    else if (g) charger(g);
  }

  async function mcpGardeEnregistrer(): Promise<void> {
    if (mcpOccupe.value) return;
    const g = mcpGarde.value;
    mcpGarde.value = null;
    if (!(await mcpEnregistrer())) return;
    if (g === "fermer") fermer();
    else if (g) charger(g);
  }

  function openMcpManager(): void {
    showMcpManagerModal.value = true;
    if (!mcpSel.value) charger(premiereCle());
    void loadSharedMcpServers();
  }

  /** Échap, croix ou voile : referme d'abord la garde ou la confirmation, garde une saisie en cours. */
  function closeMcpManager(): void {
    if (mcpOccupe.value) return;
    if (mcpGarde.value) mcpGarde.value = null;
    else if (mcpConfirmer.value) mcpConfirmer.value = false;
    else if (mcpSale.value) mcpGarde.value = "fermer";
    else fermer();
  }

  return {
    showMcpManagerModal,
    openMcpManager,
    closeMcpManager,
    mcpSel,
    mcpForm,
    mcpSale,
    mcpGarde,
    mcpConfirmer,
    mcpErreurs,
    mcpErreur,
    mcpOccupe,
    mcpFlash,
    mcpTests,
    mcpSearch,
    mcpListePerso,
    mcpListePartages,
    sharedMcpServers,
    pinnedServers,
    agentMcpChoices,
    loadSharedMcpServers,
    isSharedVisible,
    mcpEstEpingle,
    mcpBasculerPanneau,
    activateExternalServer,
    mcpChoisir,
    mcpNouveau,
    mcpAppliquerModele,
    mcpSetType,
    mcpSetPortee,
    mcpEffacerErreur,
    mcpAddPair,
    mcpRemovePair,
    mcpEnregistrer,
    mcpTester,
    mcpDemanderSuppression,
    mcpAnnulerSuppression,
    mcpSupprimer,
    mcpAbandonner,
    mcpGardeEnregistrer,
  };
}
