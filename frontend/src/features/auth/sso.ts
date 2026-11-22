// SPDX-License-Identifier: MIT
/** frontend/src/features/auth/sso.ts — connexion par SSO : méthodes proposées, départ du flux, retour en erreur et preuve du titulaire. */
import {
  CODES_ERREUR_CONNEXION,
  schemaHoteNonCanonique,
  schemaMethodeConnexionSso,
  schemaReponseDepartOidc,
  schemaReponsePreuveLien,
  schemaReponsePreuveLienReussie,
} from "@elpis/contracts";
import type { CodeErreurConnexion, CorpsDepartOidc, MethodeConnexionSso } from "@elpis/contracts";
import { ref } from "vue";
import { z } from "zod";

import type { ClientHttp } from "../../platform/http/client";
import type { ApiResult } from "../../platform/http/resultat";

/** Accès à l'adresse courante et à la navigation, remplaçable dans les tests. */
export interface EnvSso {
  origine(): string;
  chemin(): string;
  recherche(): string;
  naviguer(url: string): void;
  remplacerUrl(url: string): void;
}

export const envNavigateur: EnvSso = {
  origine: () => window.location.origin,
  chemin: () => window.location.pathname,
  recherche: () => window.location.search,
  naviguer: (url) => window.location.assign(url),
  remplacerUrl: (url) => window.history.replaceState(window.history.state, "", url),
};

const MESSAGE_AUTORISATION =
  "Votre compte n'est pas autorisé à utiliser Elpis. Demandez à votre administrateur.";
const MESSAGE_ECHEC = "La connexion n'a pas abouti. Réessayez ou demandez à votre administrateur.";
const MESSAGE_PREUVE_EXPIREE =
  "Cette demande a expiré. Reconnectez-vous par le service de votre organisation.";
const MESSAGE_PREUVE_CADUQUE =
  "Cette demande n'est plus valable. Reconnectez-vous par le service de votre organisation ou demandez à votre administrateur.";
const MESSAGE_DEBIT = "Trop de tentatives, réessayez dans un instant.";
const MESSAGE_INDISPONIBLE =
  "Le service de connexion de votre organisation ne répond pas. Réessayez plus tard ou demandez à votre administrateur.";

/** Message affiché pour chaque code de la liste fermée. */
const MESSAGES_ERREUR_CONNEXION: Record<CodeErreurConnexion, string> = {
  denied: "Connexion refusée par le service de votre organisation.",
  expired: "La connexion a pris trop de temps. Réessayez.",
  not_in_group: MESSAGE_AUTORISATION,
  groups_unknown: MESSAGE_AUTORISATION,
  conflict: MESSAGE_AUTORISATION,
  suspended: MESSAGE_AUTORISATION,
  mfa_required: "Une vérification en deux étapes est exigée. Reconnectez-vous en la validant.",
  unavailable: "Le service de connexion de votre organisation ne répond pas. Réessayez plus tard.",
  failed: MESSAGE_ECHEC,
};

/** Adresse sûre pour une navigation : https seulement. */
export function adresseHttps(valeur: unknown): string | null {
  if (typeof valeur !== "string" || !valeur.startsWith("https://")) return null;
  try {
    return new URL(valeur).protocol === "https:" ? valeur : null;
  } catch {
    return null;
  }
}

/** Suite d'une connexion rendue par le serveur : chemin local (jamais `//` ni `\`) ou adresse https, sinon l'accueil. */
function suiteSure(valeur: unknown): string {
  if (typeof valeur !== "string") return "/";
  if (valeur.startsWith("/") && !valeur.startsWith("//") && !valeur.includes("\\")) return valeur;
  return adresseHttps(valeur) ?? "/";
}

/** Origine https nue (sans chemin) venue du serveur, sinon `null`. */
function origineHttps(valeur: unknown): string | null {
  const adresse = adresseHttps(valeur);
  if (adresse === null) return null;
  const u = new URL(adresse);
  return u.origin === "null" ? null : u.origin;
}

/** Suite d'un flux d'autorisation OAuth lue dans la recherche, ou chaîne vide (jamais une redirection ouverte). */
export function suiteOAuthValide(recherche: string): string {
  let suite: string;
  try {
    suite = new URLSearchParams(recherche).get("oauth_next") || "";
  } catch {
    return "";
  }
  return suite.startsWith("/oauth/authorize?") && !suite.startsWith("//") ? suite : "";
}

const schemaMethodes = z.array(schemaMethodeConnexionSso);
const REFERENCE = /^[A-Za-z0-9_-]{8}$/u;
const PARAMETRES_RETOUR = ["auth_error", "ref", "auth_link"];

/** Code de la liste fermée, sinon `failed`. */
function codeErreur(brut: string): CodeErreurConnexion {
  return (CODES_ERREUR_CONNEXION as readonly string[]).includes(brut)
    ? (brut as CodeErreurConnexion)
    : "failed";
}

export interface ErreurRetour {
  readonly message: string;
  readonly reference: string | null;
}

interface CrochetsSso {
  /** Relit la configuration publique (méthode éteinte entre-temps). */
  rechargerConfig(): Promise<unknown>;
  /** Vrai dans la console d'administration (départ du flux avec `target: "console"`). */
  depuisConsole?(): boolean;
}

export function setupSso(http: ClientHttp, crochets: CrochetsSso, env: EnvSso) {
  const loginMethods = ref<MethodeConnexionSso[]>([]);
  const authOrigin = ref("");
  const ssoBusy = ref(false);
  const ssoError = ref("");
  const authRetour = ref<ErreurRetour | null>(null);
  const preuveUsername = ref<string | null>(null);
  const preuveMotDePasse = ref("");
  const preuveBusy = ref(false);
  const preuveError = ref("");

  /** Mémorise méthodes et origine canonique rendues par la configuration publique (valeurs invalides ignorées). */
  function appliquerConfig(data: { login_methods?: unknown; auth_origin?: unknown }): void {
    const m = schemaMethodes.safeParse(data.login_methods);
    loginMethods.value = m.success ? m.data : [];
    authOrigin.value = loginMethods.value.length > 0 ? (origineHttps(data.auth_origin) ?? "") : "";
  }

  async function demarrer(id: string): Promise<void> {
    const enConsole = crochets.depuisConsole?.() === true;
    const corps: CorpsDepartOidc = { target: enConsole ? "console" : "app" };
    const suite = enConsole ? "" : suiteOAuthValide(env.recherche());
    if (suite !== "") corps.oauth_next = suite;
    const r: ApiResult<{ url: string }> = await http.requete(
      `/api/auth/oidc/${encodeURIComponent(id)}/start`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corps) },
      { schema: schemaReponseDepartOidc, sans401: true },
    );
    if (r.type === "ok") {
      const url = adresseHttps(r.valeur.url);
      if (url === null) ssoError.value = MESSAGE_ECHEC;
      else {
        env.naviguer(url);
        return;
      }
    } else if (r.type === "conflit") {
      const h = schemaHoteNonCanonique.safeParse(r.erreur.brut);
      const cible = h.success ? origineHttps(h.data.canonical) : null;
      if (cible === null) ssoError.value = MESSAGE_ECHEC;
      else {
        env.naviguer(cible + env.chemin() + env.recherche());
        return;
      }
    } else if (r.type === "requete" && r.statut === 429) ssoError.value = MESSAGE_DEBIT;
    else if (r.type === "requete" && r.statut === 404) {
      ssoError.value = MESSAGE_ECHEC;
      await crochets.rechargerConfig();
    } else if (r.type === "serveur" && r.statut === 503) ssoError.value = MESSAGE_INDISPONIBLE;
    else if (r.type === "reseau") ssoError.value = "Serveur injoignable — vérifiez votre connexion réseau.";
    else if (r.type !== "annulation" && r.type !== "perime") ssoError.value = MESSAGE_ECHEC;
    ssoBusy.value = false;
  }

  /** Adresse courante (port, chemin, paramètres gardés) portée sur le nom d'hôte canonique. */
  function urlSurHote(hote: string): string {
    const u = new URL(env.origine() + env.chemin() + env.recherche());
    u.hostname = hote;
    return u.toString();
  }

  /** Clic sur une méthode : hôte canonique d'abord, puis départ du flux ; un seul flux à la fois. */
  async function startSso(id: string): Promise<void> {
    if (ssoBusy.value) return;
    ssoBusy.value = true;
    ssoError.value = "";
    try {
      const hoteCanonique = authOrigin.value === "" ? "" : new URL(authOrigin.value).hostname;
      if (hoteCanonique !== "" && new URL(env.origine()).hostname !== hoteCanonique) {
        const cible = adresseHttps(urlSurHote(hoteCanonique));
        if (cible === null) {
          ssoError.value = MESSAGE_ECHEC;
          ssoBusy.value = false;
          return;
        }
        env.naviguer(cible);
        return;
      }
      await demarrer(id);
    } catch {
      ssoError.value = MESSAGE_ECHEC;
      ssoBusy.value = false;
    }
  }

  function nettoyerUrl(): void {
    const p = new URLSearchParams(env.recherche());
    if (!PARAMETRES_RETOUR.some((c) => p.has(c))) return;
    for (const c of PARAMETRES_RETOUR) p.delete(c);
    const reste = p.toString();
    try {
      env.remplacerUrl(env.chemin() + (reste === "" ? "" : "?" + reste));
    } catch {
      /* historique indisponible */
    }
  }

  async function lireRetour(): Promise<void> {
    const p = new URLSearchParams(env.recherche());
    const brut = p.get("auth_error");
    const lien = p.get("auth_link") === "1";
    if (brut !== null) {
      const reference = p.get("ref");
      authRetour.value = {
        message: MESSAGES_ERREUR_CONNEXION[codeErreur(brut)],
        reference: reference !== null && REFERENCE.test(reference) ? reference : null,
      };
    }
    nettoyerUrl();
    if (!lien) return;
    const r = await http.requete(
      "/api/auth/oidc/link-proof",
      {},
      { schema: schemaReponsePreuveLien, sans401: true },
    );
    if (r.type === "ok" && r.valeur.pending && r.valeur.username !== null)
      preuveUsername.value = r.valeur.username;
    else if (r.type === "ok") {
      authRetour.value = { message: MESSAGE_PREUVE_EXPIREE, reference: null };
    }
  }

  /** Une fois la configuration publique connue : sans méthode externe, les paramètres de retour sont ignorés et retirés de l'URL. */
  async function traiterRetour(): Promise<void> {
    if (loginMethods.value.length === 0) nettoyerUrl();
    else await lireRetour();
  }

  function annulerPreuve(): void {
    preuveUsername.value = null;
    preuveMotDePasse.value = "";
    preuveError.value = "";
  }

  /** Envoie le mot de passe à la seule route de preuve, puis l'efface du champ quelle que soit la réponse. */
  async function envoyerPreuve(): Promise<void> {
    if (preuveBusy.value || preuveMotDePasse.value === "") return;
    preuveBusy.value = true;
    preuveError.value = "";
    let r: ApiResult<{ ok: true; next: string }>;
    try {
      r = await http.requete(
        "/api/auth/oidc/link-proof",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: preuveMotDePasse.value }),
        },
        { schema: schemaReponsePreuveLienReussie, sans401: true },
      );
    } finally {
      preuveMotDePasse.value = "";
    }
    try {
      if (r.type === "ok") {
        annulerPreuve();
        env.naviguer(suiteSure(r.valeur.next));
        return;
      } else if (r.type === "requete" && r.statut === 401) preuveError.value = "Mot de passe incorrect.";
      else if (r.type === "conflit") {
        annulerPreuve();
        authRetour.value = { message: MESSAGE_PREUVE_CADUQUE, reference: null };
      } else if (r.type === "requete" && r.statut === 429) preuveError.value = MESSAGE_DEBIT;
      else if (r.type === "reseau")
        preuveError.value = "Serveur injoignable — vérifiez votre connexion réseau.";
      else if (r.type !== "annulation" && r.type !== "perime") preuveError.value = MESSAGE_ECHEC;
    } finally {
      preuveBusy.value = false;
    }
  }

  return {
    loginMethods,
    authOrigin,
    ssoBusy,
    ssoError,
    authRetour,
    preuveUsername,
    preuveMotDePasse,
    preuveBusy,
    preuveError,
    appliquerConfig,
    startSso,
    lireRetour,
    traiterRetour,
    annulerPreuve,
    envoyerPreuve,
  };
}
