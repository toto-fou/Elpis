// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/connexions.ts — Paramètres › Secrets › Jetons MCP et Remote : jetons personnels (`/api/tokens*`, outils d'un côté, postes reliés en Remote de l'autre) et applications OAuth autorisées. */
import {
  schemaReponseAutorisationsOauth,
  schemaReponseJetonCree,
  schemaReponseJetons,
} from "@elpis/contracts";
import type { AutorisationOauth, Jeton, ReponseJetons } from "@elpis/contracts";
import { ref } from "vue";
import type { Ref } from "vue";

import type { ClientHttp } from "../../platform/http/client";
import { valeurOuNull } from "../../platform/http/resultat";
import type { ApiResult } from "../../platform/http/resultat";

const PLACEHOLDER = "<VOTRE_JETON>";

export interface BlocConfig {
  id: string;
  label: string;
  lang: string;
  text: string;
}

export interface FormulaireJeton {
  kind: string;
  name: string;
  families: Record<string, boolean>;
  days: number | string | null;
}

/** Ce qu'une partie (Jetons MCP, Remote) garde pour elle : son formulaire, son jeton montré, l'onglet de ses blocs, son erreur. */
export interface PartieJetons {
  form: FormulaireJeton | null;
  reveal: { token: string; item: Jeton } | null;
  tab: string;
  error: string;
}

export interface EtatConnexions {
  tokens: Jeton[];
  policy: ReponseJetons["policy"] | null;
  bridgeUrl: string;
  toolsUrl: string;
  opencode: boolean;
  /** Liste reçue du serveur : avant, rien n'est dit « désactivé ». */
  charge: boolean;
  parties: Record<GenreJeton, PartieJetons>;
  busy: boolean;
  grants: AutorisationOauth[];
  oauthEnabled: boolean;
}

/** Jetons d'outils (MCP, OpenAPI) ou jetons des postes reliés en Remote : chaque partie des Paramètres n'en montre qu'un genre. */
export type GenreJeton = "tools" | "opencode";

/** Partie où un jeton se range : Remote pour ceux des postes, Jetons MCP pour tout autre genre. */
export function genreDe(item: Pick<Jeton, "kind">): GenreJeton {
  return item.kind === "opencode" ? "opencode" : "tools";
}

export interface CtxConnexions {
  showToast?(message: string, type?: string): void;
  openConfirm?(titre: string, message: string, danger: boolean, libelle: string): Promise<boolean>;
}

/** Blocs de configuration prêts à copier pour un jeton (ou l'espace réservé) ; pur. */
export function buildBlocks(
  token: string | null | undefined,
  families: readonly string[] | null | undefined,
  bridgeUrl: string,
  toolsUrl: string,
  kind?: string,
): BlocConfig[] {
  const tok = token || PLACEHOLDER;
  if (kind === "opencode") return [{ id: "remote", label: "Commande", lang: "text", text: "/remote " + tok }];
  const fams = (families ?? []).filter(Boolean);
  const auth = { Authorization: "Bearer " + tok };
  const mcp: Record<string, unknown> = {};
  const vscode: Record<string, unknown> = {};
  const oc: Record<string, unknown> = {};
  for (const f of fams) {
    const url = bridgeUrl + "/" + f;
    mcp["elpis-" + f] = { type: "http", url, headers: auth };
    vscode["elpis-" + f] = { type: "http", url, headers: auth };
    oc["elpis-" + f] = { type: "remote", url, enabled: true, headers: auth };
  }
  const f0 = fams[0] ?? "fs";
  return [
    { id: "mcp", label: "MCP", lang: "json", text: JSON.stringify({ mcpServers: mcp }, null, 2) },
    { id: "vscode", label: "VS Code", lang: "json", text: JSON.stringify({ servers: vscode }, null, 2) },
    { id: "opencode", label: "opencode", lang: "json", text: JSON.stringify({ mcp: oc }, null, 2) },
    {
      id: "openapi",
      label: "OpenAPI",
      lang: "text",
      text: fams.map((f) => "URL : " + toolsUrl + "/" + f + "\nClé (Bearer) : " + tok).join("\n\n"),
    },
    {
      id: "curl",
      label: "curl",
      lang: "shell",
      text: 'curl -s -H "Authorization: Bearer ' + tok + '" \\\n  ' + toolsUrl + "/" + f0 + "/openapi.json",
    },
  ];
}

function etatVide(): EtatConnexions {
  return {
    tokens: [],
    policy: null,
    bridgeUrl: "",
    toolsUrl: "",
    opencode: false,
    charge: false,
    parties: {
      tools: { form: null, reveal: null, tab: "mcp", error: "" },
      opencode: { form: null, reveal: null, tab: "remote", error: "" },
    },
    busy: false,
    grants: [],
    oauthEnabled: false,
  };
}

function detail<T>(r: ApiResult<T>, repli: string): string {
  if (r.type === "requete" || r.type === "refus" || r.type === "serveur" || r.type === "conflit") {
    return r.erreur.detail || repli;
  }
  return r.type === "invalide" ? repli : "Erreur réseau.";
}

const ongletDe = (item: Jeton): string => (item.kind === "opencode" ? "remote" : "mcp");

export function setupConnexions(ctx: CtxConnexions | null | undefined, http: ClientHttp) {
  const toast = (m: string, type?: string): void => ctx?.showToast?.(m, type);
  const cnxState: Ref<EtatConnexions> = ref(etatVide());
  const set = (patch: Partial<EtatConnexions>): void => {
    cnxState.value = { ...cnxState.value, ...patch };
  };
  /** Change une partie sans toucher à l'autre : chacune garde son formulaire et son jeton montré. */
  const poser = (genre: GenreJeton, patch: Partial<PartieJetons>): void => {
    const parties = cnxState.value.parties;
    set({ parties: { ...parties, [genre]: { ...parties[genre], ...patch } } });
  };
  const cnxReset = (): void => {
    cnxState.value = etatVide();
  };
  const json = (corps: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });

  async function loadGrants(): Promise<void> {
    const d = valeurOuNull(
      await http.requete("/api/oauth/grants", {}, { schema: schemaReponseAutorisationsOauth }),
    );
    if (d) set({ grants: d.items, oauthEnabled: d.enabled });
  }

  async function loadConnexions(): Promise<void> {
    const d = valeurOuNull(await http.requete("/api/tokens", {}, { schema: schemaReponseJetons }));
    if (d) {
      set({
        tokens: d.tokens,
        policy: d.policy,
        bridgeUrl: d.bridge_url,
        toolsUrl: d.tools_url,
        opencode: d.opencode_enabled,
        charge: true,
      });
    }
    await loadGrants();
  }

  async function cnxRevokeGrant(g: AutorisationOauth): Promise<void> {
    const msg = "« " + g.client_name + " » perdra l'accès à vos outils immédiatement.";
    if (ctx?.openConfirm && !(await ctx.openConfirm("Retirer l'accès ?", msg, true, "Retirer"))) return;
    const r = await http.requete("/api/oauth/grants/" + encodeURIComponent(g.grant_id), { method: "DELETE" });
    if (r.type === "ok") await loadGrants();
    else toast("Retrait refusé.", "error");
  }

  function cnxNew(genre: GenreJeton = "tools"): void {
    if (genre === "opencode") {
      poser(genre, { form: { kind: genre, name: "", families: {}, days: null }, reveal: null, error: "" });
      return;
    }
    const pol = cnxState.value.policy ?? { families: [], max_days: 90 };
    const familles: Record<string, boolean> = {};
    for (const f of pol.families) familles[f.name] = f.name !== "desktop" && f.name !== "browser";
    const days = pol.max_days ? Math.min(30, pol.max_days) : 30;
    poser(genre, { form: { kind: genre, name: "", families: familles, days }, reveal: null, error: "" });
  }

  const cnxCancel = (genre: GenreJeton = "tools"): void => poser(genre, { form: null, error: "" });

  async function cnxCreate(genre: GenreJeton = "tools"): Promise<void> {
    const f = cnxState.value.parties[genre].form;
    if (!f || cnxState.value.busy) return;
    const families = Object.keys(f.families).filter((k) => f.families[k]);
    set({ busy: true });
    poser(genre, { error: "" });
    try {
      const r = await http.requete(
        "/api/tokens",
        json({ kind: f.kind, name: f.name, families, days: f.days }),
        { schema: schemaReponseJetonCree },
      );
      if (r.type !== "ok") {
        poser(genre, { error: detail(r, "Création refusée.") });
        return;
      }
      const d = r.valeur;
      poser(genre, { form: null, reveal: { token: d.token, item: d.item }, tab: ongletDe(d.item) });
      await loadConnexions();
    } finally {
      set({ busy: false });
    }
  }

  async function cnxRegenerate(item: Jeton): Promise<void> {
    const msg =
      "Un nouveau jeton remplace « " + item.name + " » ; l'ancien cesse de fonctionner tout de suite.";
    if (ctx?.openConfirm && !(await ctx.openConfirm("Régénérer le jeton ?", msg, false, "Régénérer"))) return;
    set({ busy: true });
    try {
      const r = await http.requete(
        "/api/tokens/" + encodeURIComponent(String(item.id)) + "/regenerate",
        { method: "POST" },
        { schema: schemaReponseJetonCree },
      );
      if (r.type !== "ok") {
        toast(detail(r, "Régénération refusée."), "error");
        return;
      }
      const d = r.valeur;
      poser(genreDe(d.item), { reveal: { token: d.token, item: d.item }, form: null, tab: ongletDe(d.item) });
      await loadConnexions();
    } finally {
      set({ busy: false });
    }
  }

  async function cnxRevoke(item: Jeton): Promise<void> {
    const msg =
      item.kind === "opencode"
        ? "Le poste relié par « " + item.name + " » sera déconnecté immédiatement."
        : "Les clients qui utilisent « " + item.name + " » perdront l'accès immédiatement.";
    if (ctx?.openConfirm && !(await ctx.openConfirm("Révoquer le jeton ?", msg, true, "Révoquer"))) return;
    const r = await http.requete("/api/tokens/" + encodeURIComponent(String(item.id)), { method: "DELETE" });
    if (r.type !== "ok") {
      toast("Révocation refusée.", "error");
      return;
    }
    if (cnxState.value.parties[genreDe(item)].reveal?.item.id === item.id)
      poser(genreDe(item), { reveal: null });
    await loadConnexions();
  }

  /** Révoque tous les jetons d'un genre (Remote : tous les postes reliés d'un coup) ; dit quand certains ont résisté. */
  async function cnxRevokeAll(genre: GenreJeton): Promise<void> {
    const cibles = cnxState.value.tokens.filter((t) => genreDe(t) === genre);
    if (!cibles.length || cnxState.value.busy) return;
    const msg =
      genre === "opencode"
        ? "Les " + cibles.length + " postes reliés seront déconnectés immédiatement."
        : "Les clients de ces " + cibles.length + " jetons perdront l'accès immédiatement.";
    if (
      ctx?.openConfirm &&
      !(await ctx.openConfirm("Révoquer tous les jetons ?", msg, true, "Tout révoquer"))
    )
      return;
    set({ busy: true });
    try {
      let refus = 0;
      for (const t of cibles) {
        const r = await http.requete("/api/tokens/" + encodeURIComponent(String(t.id)), { method: "DELETE" });
        if (r.type !== "ok") refus++;
      }
      poser(genre, { reveal: null });
      if (refus) toast("Révocation incomplète : " + refus + " jeton(s) restent actifs.", "error");
      await loadConnexions();
    } finally {
      set({ busy: false });
    }
  }

  const cnxShowConfig = (item: Jeton): void =>
    poser(genreDe(item), { reveal: { token: "", item }, form: null, tab: ongletDe(item) });
  const cnxCloseReveal = (genre: GenreJeton = "tools"): void => poser(genre, { reveal: null });

  function cnxBlocks(genre: GenreJeton = "tools"): BlocConfig[] {
    const rv = cnxState.value.parties[genre].reveal;
    if (!rv) return [];
    return buildBlocks(
      rv.token,
      rv.item.families,
      cnxState.value.bridgeUrl,
      cnxState.value.toolsUrl,
      rv.item.kind,
    );
  }

  async function cnxCopy(text: string): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      toast("Copié.");
    } catch {
      toast("Copie impossible : sélectionnez le texte.", "error");
    }
  }

  const cnxSchemaHref = (family: string): string => "/api/tokens/schema/" + encodeURIComponent(family);
  function cnxDate(ts: unknown): string {
    if (!ts) return "";
    try {
      return new Date(Number(ts) * 1000).toLocaleDateString("fr-FR");
    } catch {
      return "";
    }
  }

  return {
    cnxState,
    cnxReset,
    loadConnexions,
    loadGrants,
    cnxRevokeGrant,
    cnxNew,
    cnxCancel,
    cnxCreate,
    cnxRegenerate,
    cnxRevoke,
    cnxRevokeAll,
    cnxShowConfig,
    cnxCloseReveal,
    cnxBlocks,
    cnxCopy,
    cnxSchemaHref,
    cnxDate,
  };
}
