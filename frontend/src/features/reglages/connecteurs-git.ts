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
import { cheminPourType, cibleCompte, lirePortee, niveauxPortee } from "../../utils/portee-git";

export type { ConnecteurGit };

/** Nom affiché d'un type de serveur Git. */
const NOMS_TYPES: Readonly<Record<string, string>> = {
  github: "GitHub",
  gitlab: "GitLab",
  "bitbucket-cloud": "Bitbucket Cloud",
  "bitbucket-server": "Bitbucket Server",
  gitea: "Gitea / Forgejo",
  generic: "Autre serveur Git",
};

export function nomTypeGit(type: string): string {
  return NOMS_TYPES[type] ?? type;
}

export interface FormulaireGit {
  id?: ConnecteurGit["id"];
  provider_type: string;
  /** Champ « URL » : URL du serveur, d'une organisation ou d'un dépôt (sans schéma pour un compte modifié). */
  repo_url: string;
  /** « Utiliser ce compte pour » : `hôte`, `hôte/organisation` ou `hôte/organisation/dépôt` ; vide pour un compte sans portée. */
  portee: string;
  /** Portée à l'ouverture d'une modification : inchangée, ni l'hôte ni le chemin ne partent ; `null` : création. */
  depart: string | null;
  /** Hôte du compte modifié. */
  hote: string;
  /** Portées proposées d'après l'URL, de tout le serveur au dépôt. */
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

  /** Portées qu'une URL permet, de tout le serveur au dépôt, dans la casse du type de serveur ; aucune si elle ne se lit pas. */
  function niveauxDeLUrl(url: string, type: string): string[] {
    const lu = lirePortee(url);
    if (!lu) return [];
    return niveauxPortee(cheminPourType(lu.path, type) || null).map((n) =>
      cibleCompte({ host: lu.host, path: n }),
    );
  }

  /** URL en cours de saisie : ses niveaux sont proposés ; le choix reste si l'URL le permet encore ; sinon, création : tout le serveur ; modification : la même étendue qu'avant (serveur, organisation, dépôt), et rien tant que rien n'était choisi. */
  function readGitConnUrl(): void {
    const f = gitConnForm.value;
    if (!f) return;
    const rang = f.niveaux.indexOf(f.portee);
    f.niveaux = niveauxDeLUrl(f.repo_url, f.provider_type);
    if (f.niveaux.includes(f.portee)) return;
    if (!f.id) f.portee = f.niveaux[0] ?? "";
    else f.portee = rang < 0 ? "" : (f.niveaux[Math.min(rang, f.niveaux.length - 1)] ?? "");
  }

  /** Type de serveur changé : mêmes niveaux dans la casse du nouveau type, le choix garde son rang ; une portée intacte le reste (le serveur la remet lui-même dans cette casse). */
  function niveauxDuType(f: FormulaireGit): void {
    const rang = f.niveaux.indexOf(f.portee);
    const intacte = f.depart !== null && f.portee === f.depart;
    f.niveaux = niveauxDeLUrl(f.repo_url, f.provider_type);
    f.portee = rang < 0 ? "" : (f.niveaux[rang] ?? "");
    if (intacte) f.depart = f.portee;
  }

  function retypeGitConn(): void {
    const f = gitConnForm.value;
    if (!f) return;
    niveauxDuType(f);
    void parseGitRepoUrl();
  }

  function editGitConnector(c: ConnecteurGit): void {
    const portee = c.path === null ? "" : cibleCompte(c);
    gitConnForm.value = {
      id: c.id,
      provider_type: c.provider_type,
      repo_url: portee || c.host,
      portee,
      depart: portee,
      hote: c.host,
      niveaux: niveauxDeLUrl(portee || c.host, c.provider_type),
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

  /** Le serveur reconnaît le type et l'API d'après l'URL (création seulement : un compte modifié garde les siens) et lit les formes que la saisie ne lit pas (SSH) ; les niveaux d'une URL lisible restent ceux de la saisie. */
  async function parseGitRepoUrl(): Promise<void> {
    const f = gitConnForm.value;
    const url = (f?.repo_url || "").trim();
    if (!f || !url) return;
    const lisible = niveauxDeLUrl(url, f.provider_type).length > 0;
    if (f.id && lisible) return;
    const type = f.provider_type;
    const d = valeurOuNull(
      await http.requete("/api/git/connectors/parse", json("POST", { url, provider_type: type }), {
        schema: schemaReponseAnalyseUrlGit,
      }),
    );
    // Réponse tardive : le formulaire, l'URL ou le type ont changé depuis, elle ne vaut plus.
    if (gitConnForm.value !== f || f.repo_url.trim() !== url || f.provider_type !== type || !d?.ok) return;
    if (!f.id) {
      if (d.api_base) f.api_base = d.api_base;
      if (
        d.detected_provider_type &&
        d.detected_provider_type !== "generic" &&
        d.detected_provider_type !== type
      ) {
        f.provider_type = d.detected_provider_type;
        if (lisible) niveauxDuType(f);
      }
    }
    if (!d.host || lisible) return;
    f.niveaux = niveauxPortee(d.path || null).map((n) => cibleCompte({ host: d.host, path: n }));
    if (!f.niveaux.includes(f.portee)) f.portee = f.id ? "" : d.host;
  }

  async function saveGitConnector(): Promise<void> {
    const f = gitConnForm.value;
    if (!f) return;
    const edition = !!f.id;
    // Portée laissée telle quelle : rien n'en part (un compte sans portée le reste, un autre garde la sienne).
    const inchangee = edition && (f.portee || "").trim() === (f.depart ?? "");
    let portee: { host: string; path: string } | null = null;
    if (!inchangee) {
      // Enregistrement sans que le champ ait été relu (saisie puis clic immédiat) ; URL que seule l'analyse du serveur sait lire (SSH) : elle est attendue.
      if (!(f.portee || "").trim()) readGitConnUrl();
      if (!(f.portee || "").trim()) await parseGitRepoUrl();
      portee = lirePortee(f.portee || "");
      if (portee === null) {
        toast((f.repo_url || "").trim() ? "URL non reconnue" : "URL requise", "error");
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
      nomTypeGit(c.provider_type) + " · " + cibleCompte(c) + (c.label ? " · " + c.label : ""),
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
    readGitConnUrl,
    retypeGitConn,
  };
}
