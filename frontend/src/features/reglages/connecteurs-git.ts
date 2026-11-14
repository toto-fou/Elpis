// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/connecteurs-git.ts — Paramètres › Secrets › Comptes Git : comptes du compte (`/api/git/connectors*`), chacun pour un hôte, une organisation ou un dépôt, jeton en écriture seule. */
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
import { cibleCompte, lirePortee, niveauxPortee } from "../../utils/portee-git";

export type { ConnecteurGit };

export interface FormulaireGit {
  id?: ConnecteurGit["id"];
  provider_type: string;
  repo_url: string;
  /** « S'applique à » : `hôte`, `hôte/organisation` ou `hôte/organisation/dépôt` ; vide pour un compte sans portée. */
  portee: string;
  /** Portée à l'ouverture d'une modification : inchangée, ni l'hôte ni le chemin ne partent ; `null` : création. */
  depart: string | null;
  /** Hôte du compte modifié (indice de saisie d'un compte sans portée). */
  hote: string;
  /** Portées proposées d'après l'URL collée, de tout l'hôte au dépôt. */
  niveaux: string[];
  api_base: string;
  label: string;
  username: string;
  token: string;
}

export interface CtxConnecteursGit {
  showToast?(message: string, type?: string): void;
  openConfirm?(titre: string, message: string, danger: boolean): Promise<boolean>;
}

/** `apresChangement` : avis qu'un compte (et son secret du coffre) a été créé, modifié ou supprimé. */
export function setupGitConnecteurs(
  ctx: CtxConnecteursGit | null | undefined,
  http: ClientHttp,
  apresChangement: () => void = () => undefined,
) {
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
      portee: "",
      depart: null,
      hote: "",
      niveaux: [],
      api_base: "",
      label: "",
      username: "",
      token: "",
    };
    gitConnAdvanced.value = false;
  }

  function editGitConnector(c: ConnecteurGit): void {
    const portee = c.path === null ? "" : cibleCompte(c);
    gitConnForm.value = {
      id: c.id,
      provider_type: c.provider_type,
      repo_url: "",
      portee,
      depart: portee,
      hote: c.host,
      niveaux: [],
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
    if (d.host) {
      const garde = lirePortee(f.portee);
      f.niveaux = niveauxPortee(d.path || null).map((n) => cibleCompte({ host: d.host, path: n }));
      if (garde?.host !== d.host || !f.niveaux.includes(f.portee)) f.portee = d.host;
    }
    if (d.api_base) f.api_base = d.api_base;
  }

  async function saveGitConnector(): Promise<void> {
    const f = gitConnForm.value;
    if (!f) return;
    const edition = !!f.id;
    // Portée laissée telle quelle : rien n'en part (un compte sans portée le reste, un autre garde la sienne).
    const inchangee = edition && (f.portee || "").trim() === (f.depart ?? "");
    let portee: { host: string; path: string } | null = null;
    if (!inchangee) {
      const saisie = (f.portee || "").trim() || (f.repo_url || "").trim();
      if (!saisie) {
        toast("URL du dépôt ou hôte requis", "error");
        return;
      }
      portee = (f.portee || "").trim() ? lirePortee(f.portee) : { host: saisie, path: "" };
      if (portee === null) {
        toast("Portée invalide : hôte, hôte/organisation ou hôte/organisation/dépôt", "error");
        return;
      }
    }
    if (!f.id && !(f.token || "").trim()) {
      toast("Jeton ou mot de passe requis", "error");
      return;
    }
    gitConnBusy.value = true;
    try {
      const corps: Record<string, string> = {
        provider_type: f.provider_type,
        ...(portee === null ? {} : { host: portee.host, path: portee.path }),
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
        apresChangement();
        toast(edition ? "Compte mis à jour" : "Compte ajouté", "success");
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
      "Supprimer le compte ?",
      c.provider_type + " · " + cibleCompte(c) + (c.label ? " · " + c.label : ""),
      true,
    );
    if (!ok) return;
    const r = await http.requete(`/api/git/connectors/${c.id}`, { method: "DELETE" });
    if (r.type === "ok") {
      await loadGitConnectors();
      apresChangement();
      toast("Compte supprimé", "success");
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
