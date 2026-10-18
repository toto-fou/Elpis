// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/connexions.ts — Paramètres › Connexions : jetons personnels (`/api/tokens*`) et applications OAuth autorisées. */
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

export interface EtatConnexions {
  tokens: Jeton[];
  policy: ReponseJetons["policy"] | null;
  bridgeUrl: string;
  toolsUrl: string;
  opencode: boolean;
  form: FormulaireJeton | null;
  reveal: { token: string; item: Jeton } | null;
  tab: string;
  busy: boolean;
  error: string;
  grants: AutorisationOauth[];
  oauthEnabled: boolean;
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
  if (kind === "opencode") return [{ id: "remote", label: "opencode", lang: "text", text: "/remote " + tok }];
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
    form: null,
    reveal: null,
    tab: "mcp",
    busy: false,
    error: "",
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

  function cnxNew(): void {
    const pol = cnxState.value.policy ?? { families: [], max_days: 90 };
    const familles: Record<string, boolean> = {};
    for (const f of pol.families) familles[f.name] = f.name !== "desktop" && f.name !== "browser";
    const days = pol.max_days ? Math.min(30, pol.max_days) : 30;
    set({ form: { kind: "tools", name: "", families: familles, days }, reveal: null, error: "" });
  }

  const cnxCancel = (): void => set({ form: null, error: "" });

  async function cnxCreate(): Promise<void> {
    const f = cnxState.value.form;
    if (!f || cnxState.value.busy) return;
    const families = Object.keys(f.families).filter((k) => f.families[k]);
    set({ busy: true, error: "" });
    try {
      const r = await http.requete(
        "/api/tokens",
        json({ kind: f.kind, name: f.name, families, days: f.days }),
        { schema: schemaReponseJetonCree },
      );
      if (r.type !== "ok") {
        set({ error: detail(r, "Création refusée.") });
        return;
      }
      const d = r.valeur;
      set({ form: null, reveal: { token: d.token, item: d.item }, tab: ongletDe(d.item) });
      await loadConnexions();
    } finally {
      set({ busy: false });
    }
  }

  async function cnxRegenerate(item: Jeton): Promise<void> {
    const msg =
      "Un nouveau jeton remplace « " + item.name + " » ; l'ancien cesse de fonctionner tout de suite.";
    if (ctx?.openConfirm && !(await ctx.openConfirm("Régénérer le jeton ?", msg, false, "Régénérer"))) return;
    set({ busy: true, error: "" });
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
      set({ reveal: { token: d.token, item: d.item }, form: null, tab: ongletDe(d.item) });
      await loadConnexions();
    } finally {
      set({ busy: false });
    }
  }

  async function cnxRevoke(item: Jeton): Promise<void> {
    const msg = "Les clients qui utilisent « " + item.name + " » perdront l'accès immédiatement.";
    if (ctx?.openConfirm && !(await ctx.openConfirm("Révoquer le jeton ?", msg, true, "Révoquer"))) return;
    const r = await http.requete("/api/tokens/" + encodeURIComponent(String(item.id)), { method: "DELETE" });
    if (r.type !== "ok") {
      toast("Révocation refusée.", "error");
      return;
    }
    if (cnxState.value.reveal?.item.id === item.id) set({ reveal: null });
    await loadConnexions();
  }

  const cnxShowConfig = (item: Jeton): void =>
    set({ reveal: { token: "", item }, form: null, tab: ongletDe(item) });
  const cnxCloseReveal = (): void => set({ reveal: null });

  function cnxBlocks(): BlocConfig[] {
    const rv = cnxState.value.reveal;
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
  const cnxKindLabel = (kind: string): string =>
    ({ tools: "Outils", opencode: "opencode", vision: "Vision" })[kind as "tools"] ?? kind;
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
    cnxShowConfig,
    cnxCloseReveal,
    cnxBlocks,
    cnxCopy,
    cnxSchemaHref,
    cnxKindLabel,
    cnxDate,
  };
}
