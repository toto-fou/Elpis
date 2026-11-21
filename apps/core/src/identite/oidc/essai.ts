// SPDX-License-Identifier: MIT
/** apps/core/src/identite/oidc/essai.ts — étapes OIDC du bouton « Tester » après la découverte : points d'accès, algorithmes annoncés, clés de signature, authentification du client, secret, avertissements. */
import type { ServerMetadata } from "openid-client";

import { etape, PHRASES_SORTANT } from "../etapes";
import type { EtapeEssai } from "../etapes";
import { hotePortHttps } from "../reglages";
import type { Fournisseur } from "../reglages";
import { classerErreur } from "../sortant";
import { USERINFO_HORS_ORIGINE } from "./metadonnees";

const ALGOS_REFUSES = /^(none|HS(256|384|512))$/u;
const FAMILLE: Readonly<Record<string, string>> = { RS: "RSA", PS: "RSA", ES: "EC", Ed: "OKP" };
const RSA_BITS_MIN = 2048;
const COURBE: Readonly<Record<string, string>> = { ES256: "P-256", ES384: "P-384", ES512: "P-521" };

export interface ContexteEtapesOidc {
  readonly fetch: typeof globalThis.fetch;
  readonly secretEnregistre: (f: Fournisseur) => Promise<string | null>;
}

/** Clé que la bibliothèque acceptera pour cet algorithme : type, courbe, taille RSA d'au moins 2048 bits, usage. */
function cleConvient(k: unknown, alg: string): boolean {
  if (k === null || typeof k !== "object") return false;
  const o = k as Record<string, unknown>;
  if (o["kty"] !== FAMILLE[alg.slice(0, 2)]) return false;
  if (o["use"] !== undefined && o["use"] !== "sig") return false;
  if (Array.isArray(o["key_ops"]) && !o["key_ops"].includes("verify")) return false;
  if (typeof o["alg"] === "string" && o["alg"] !== alg) return false;
  if (o["kty"] === "RSA") return typeof o["n"] === "string" && tailleRsaBits(o["n"]) >= RSA_BITS_MIN;
  return o["crv"] === (COURBE[alg] ?? "Ed25519");
}

/** Taille en bits d'un module RSA donné en base64url (zéros de tête exclus). */
function tailleRsaBits(n: string): number {
  const octets = Buffer.from(n, "base64url");
  let i = 0;
  while (i < octets.length && octets[i] === 0) i++;
  return i >= octets.length ? 0 : (octets.length - i) * 8 - Math.clz32(octets[i] as number) + 24;
}

/** Nombre de clés de signature du jeu de clés que la bibliothèque acceptera pour l'algorithme réglé. */
function clesDeSignature(jeu: unknown, alg: string): number {
  const keys = (jeu as { keys?: unknown } | null)?.keys;
  return Array.isArray(keys) ? keys.filter((k: unknown) => cleConvient(k, alg)).length : 0;
}

async function etapeCles(
  f: Fournisseur,
  m: ServerMetadata,
  c: ContexteEtapesOidc,
  cible: string,
): Promise<EtapeEssai> {
  const echec = (detail: string): EtapeEssai => etape("jwks", "Clés de signature", "fail", detail, cible);
  try {
    const rep = await c.fetch(m.jwks_uri ?? "", { headers: { accept: "application/json" } });
    if (rep.status !== 200) return echec(`Le serveur a répondu avec le statut ${rep.status} au lieu de 200.`);
    let jeu: unknown;
    try {
      jeu = JSON.parse(await rep.text());
    } catch {
      return echec("Le jeu de clés n'est pas un document JSON.");
    }
    const n = clesDeSignature(jeu, f.id_token_alg);
    return n > 0
      ? etape(
          "jwks",
          "Clés de signature",
          "ok",
          `${n} clé(s) de signature ${f.id_token_alg} lisible(s).`,
          cible,
        )
      : echec(`Aucune clé de signature ${f.id_token_alg} dans le jeu de clés du fournisseur.`);
  } catch (e) {
    return echec(PHRASES_SORTANT[classerErreur(e)]);
  }
}

function etapeAlgorithmes(f: Fournisseur, m: ServerMetadata, cible: string): EtapeEssai {
  const annonces = m.id_token_signing_alg_values_supported;
  if (annonces === undefined || !annonces.includes(f.id_token_alg))
    return etape(
      "algorithms",
      "Algorithmes",
      "fail",
      `L'algorithme de signature réglé (${f.id_token_alg}) n'est pas annoncé par le fournisseur.`,
      cible,
    );
  if (annonces.some((a) => ALGOS_REFUSES.test(a)))
    return etape(
      "algorithms",
      "Algorithmes",
      "warn",
      "Le fournisseur annonce aussi des signatures symétriques ou nulles : Elpis ne les accepte jamais, seul l'algorithme réglé l'est.",
      cible,
    );
  return etape(
    "algorithms",
    "Algorithmes",
    "ok",
    `Signature ${f.id_token_alg} annoncée par le fournisseur.`,
    cible,
  );
}

function etapePkce(m: ServerMetadata, cible: string): EtapeEssai | null {
  return m.code_challenge_methods_supported?.includes("S256") === true
    ? null
    : etape(
        "pkce",
        "PKCE",
        "warn",
        "Le fournisseur n'annonce pas PKCE S256 : vérifiez qu'il l'exige.",
        cible,
      );
}

function etapeUserinfo(m: ServerMetadata, cible: string): EtapeEssai | null {
  return m[USERINFO_HORS_ORIGINE] === true
    ? etape(
        "userinfo",
        "Point d'information",
        "warn",
        "Le point d'information du fournisseur est sur une autre origine : il n'est pas utilisé. L'identifiant et les groupes doivent figurer dans le jeton d'identité.",
        cible,
      )
    : null;
}

function etapeAuthentification(f: Fournisseur, m: ServerMetadata, cible: string): EtapeEssai {
  const methode = f.client_auth === "basic" ? "client_secret_basic" : "client_secret_post";
  const annonces = m.token_endpoint_auth_methods_supported;
  if (annonces === undefined)
    return etape(
      "client_auth",
      "Authentification",
      f.client_auth === "basic" ? "ok" : "warn",
      "Le fournisseur n'annonce pas ses méthodes d'authentification du client ; client_secret_basic est la valeur par défaut du protocole.",
      cible,
    );
  return annonces.includes(methode)
    ? etape("client_auth", "Authentification", "ok", `Méthode ${methode} annoncée par le fournisseur.`, cible)
    : etape(
        "client_auth",
        "Authentification",
        "fail",
        `La méthode ${methode} n'est pas annoncée par le fournisseur.`,
        cible,
      );
}

/** Étapes OIDC après une découverte valide ; les clés se lisent par le `fetch` borné du test. */
export async function etapesOidc(
  etapes: EtapeEssai[],
  f: Fournisseur,
  m: ServerMetadata,
  c: ContexteEtapesOidc,
): Promise<void> {
  const cible = hotePortHttps(f.issuer);
  etapes.push(
    etape(
      "endpoints",
      "Points d'accès",
      "ok",
      m.userinfo_endpoint === undefined
        ? "Jetons et clés sur la même origine que l'émetteur ; autorisation en https."
        : "Jetons, clés et informations sur la même origine que l'émetteur ; autorisation en https.",
      cible,
    ),
  );
  etapes.push(etapeAlgorithmes(f, m, cible));
  etapes.push(await etapeCles(f, m, c, cible));
  const pkce = etapePkce(m, cible);
  if (pkce !== null) etapes.push(pkce);
  const info = etapeUserinfo(m, cible);
  if (info !== null) etapes.push(info);
  etapes.push(etapeAuthentification(f, m, cible));
  etapes.push(
    (await c.secretEnregistre(f)) === null
      ? etape("secret", "Secret", "fail", "Aucun secret client n'est enregistré pour ce fournisseur.")
      : etape("secret", "Secret", "ok", "Secret client enregistré."),
  );
  if (f.subject_claim !== "sub")
    etapes.push(
      etape(
        "subject",
        "Sujet",
        "warn",
        `Le sujet est lu dans « ${f.subject_claim} » et non dans « sub » : vérifiez qu'il est propre à la personne et ne change jamais.`,
      ),
    );
  if (f.required_acr.length > 1)
    etapes.push(
      etape(
        "acr",
        "Niveaux exigés",
        "warn",
        "Tous les niveaux exigés sont envoyés ensemble au fournisseur, qui en retient un selon ses propres règles (le plus bas, ou le premier de la liste) pour tout le monde : vérifiez avec « Se connecter pour essayer ».",
      ),
    );
  if (m.pushed_authorization_request_endpoint !== undefined)
    etapes.push(
      etape(
        "par",
        "Requête poussée",
        "warn",
        "Le fournisseur annonce les requêtes d'autorisation poussées (PAR) : elles seront utilisées.",
        cible,
      ),
    );
}
