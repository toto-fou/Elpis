// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/connecteurs-git.ts — Paramètres › Connecteurs Git : accès par hôte du compte (`/api/git/connectors*`), jeton en écriture seule. */
import {
  schemaReponseAnalyseUrlGit,
  schemaReponseConnecteursGit,
  schemaReponseEssaiGit,
} from "@elpis/contracts";
import type { ConnecteurGit } from "@elpis/contracts";
import { ref } from "vue";
import type { Ref } from "vue";

import type { ClientHttp } from "../../platform/http/client";
import { valeurOuNull } from "../../platform/http/resultat";

export type { ConnecteurGit };

export interface FormulaireGit {
  id?: ConnecteurGit["id"];
  provider_type: string;
  repo_url: string;
  host: string;
  api_base: string;
  label: string;
  username: string;
  token: string;
}

export interface CtxConnecteursGit {
  showToast?(message: string, type?: string): void;
  openConfirm?(titre: string, message: string, danger: boolean): Promise<boolean>;
}

export function setupGitConnecteurs(ctx: CtxConnecteursGit | null | undefined, http: ClientHttp) {
  const toast = (m: string, type?: string): void => ctx?.showToast?.(m, type);
  const gitConnectors: Ref<ConnecteurGit[]> = ref([]);
  const gitConnTypes: Ref<string[]> = ref([]);
  const gitConnForm: Ref<FormulaireGit | null> = ref(null);
  const gitConnBusy = ref(false);
  const gitConnTest: Ref<Record<string, Record<string, unknown>>> = ref({});
  const gitConnAdvanced = ref(false);
  const json = (methode: string, corps: unknown): RequestInit => ({
    method: methode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(corps),
  });

  async function loadGitConnectors(): Promise<void> {
    const d = valeurOuNull(
      await http.requete("/api/git/connectors", {}, { schema: schemaReponseConnecteursGit }),
    );
    if (!d) return;
    gitConnectors.value = d.connectors;
    gitConnTypes.value = d.provider_types;
  }

  function newGitConnector(): void {
    gitConnForm.value = {
      provider_type: "github",
      repo_url: "",
      host: "",
      api_base: "",
      label: "",
      username: "",
      token: "",
    };
    gitConnAdvanced.value = false;
  }

  function editGitConnector(c: ConnecteurGit): void {
    gitConnForm.value = {
      id: c.id,
      provider_type: c.provider_type,
      repo_url: "",
      host: c.host,
      api_base: c.api_base || "",
      label: c.label || "",
      username: c.username || "",
      token: "",
    };
    gitConnAdvanced.value = false;
  }

  const cancelGitConnector = (): void => {
    gitConnForm.value = null;
  };

  async function parseGitRepoUrl(): Promise<void> {
    const f = gitConnForm.value;
    const url = (f?.repo_url || "").trim();
    if (!f || !url) return;
    const d = valeurOuNull(
      await http.requete("/api/git/connectors/parse", json("POST", { url, provider_type: f.provider_type }), {
        schema: schemaReponseAnalyseUrlGit,
      }),
    );
    if (!d?.ok) return;
    if (d.detected_provider_type && d.detected_provider_type !== "generic")
      f.provider_type = d.detected_provider_type;
    if (d.host) f.host = d.host;
    if (d.api_base) f.api_base = d.api_base;
  }

  async function saveGitConnector(): Promise<void> {
    const f = gitConnForm.value;
    if (!f) return;
    const host = (f.host || "").trim() || (f.repo_url || "").trim();
    if (!host) {
      toast("URL du dépôt (ou host) requise", "error");
      return;
    }
    if (!f.id && !(f.token || "").trim()) {
      toast("Token / mot de passe requis", "error");
      return;
    }
    gitConnBusy.value = true;
    try {
      const edition = !!f.id;
      const corps: Record<string, string> = {
        provider_type: f.provider_type,
        host,
        api_base: (f.api_base || "").trim(),
        label: (f.label || "").trim(),
        username: (f.username || "").trim(),
      };
      if ((f.token || "").trim()) corps.token = f.token.trim();
      const r = await http.requete(
        edition ? `/api/git/connectors/${f.id}` : "/api/git/connectors",
        json(edition ? "PUT" : "POST", corps),
      );
      if (r.type === "ok") {
        gitConnForm.value = null;
        await loadGitConnectors();
        toast(edition ? "Connecteur mis à jour" : "Connecteur ajouté", "success");
      } else {
        const detail =
          r.type === "requete" || r.type === "refus" || r.type === "serveur" || r.type === "conflit"
            ? r.erreur.detail
            : null;
        toast(detail || "Échec de l'enregistrement", "error");
      }
    } finally {
      gitConnBusy.value = false;
    }
  }

  async function deleteGitConnector(c: ConnecteurGit): Promise<void> {
    const ok = await ctx?.openConfirm?.(
      "Supprimer le connecteur ?",
      c.provider_type + " · " + c.host + (c.label ? " · " + c.label : ""),
      true,
    );
    if (!ok) return;
    const r = await http.requete(`/api/git/connectors/${c.id}`, { method: "DELETE" });
    if (r.type === "ok") {
      await loadGitConnectors();
      toast("Connecteur supprimé", "success");
    }
  }

  async function testGitConnector(c: ConnecteurGit): Promise<void> {
    const poser = (res: Record<string, unknown>): void => {
      gitConnTest.value = { ...gitConnTest.value, [c.id]: res };
    };
    poser({ testing: true });
    const r = await http.requete(
      `/api/git/connectors/${c.id}/test`,
      { method: "POST" },
      { schema: schemaReponseEssaiGit },
    );
    if (r.type === "ok") poser(r.valeur);
    else if (r.type === "invalide") poser({ ok: false, error: "parse" });
    else if (r.type === "requete" || r.type === "refus" || r.type === "serveur" || r.type === "conflit") {
      poser(
        r.erreur.brut && typeof r.erreur.brut === "object"
          ? (r.erreur.brut as Record<string, unknown>)
          : { ok: false, error: "parse" },
      );
    } else poser({ ok: false, error: "network" });
  }

  return {
    gitConnectors,
    gitConnTypes,
    gitConnForm,
    gitConnBusy,
    gitConnTest,
    gitConnAdvanced,
    loadGitConnectors,
    newGitConnector,
    editGitConnector,
    cancelGitConnector,
    saveGitConnector,
    deleteGitConnector,
    testGitConnector,
    parseGitRepoUrl,
  };
}
