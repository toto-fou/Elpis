// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/creds.ts — secrets `⟦creds:JETON⟧` des outils pw_* : résolution par le core (conversation et compte de l'appel), origine attendue, nettoyage des résultats. */
import type { Dict } from "@elpis/commun";
import { getAccessToken, getUsername, readMetaField } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { errPw } from "@elpis/navigateur";
import { lireSousAgent } from "@elpis/securite";

import type { ServicesBrowser } from "./appel";

export interface SecretResolu {
  readonly ref: string;
  readonly jeton: string;
  readonly valeur: string;
  readonly origine: string;
  /** `password` ou `username`. */
  readonly champ: "password" | "username";
  /** L'entrée du coffre accepte un certificat non vérifié. */
  readonly tlsInsecure: boolean;
}

const FORME_REF = /^([A-Za-z0-9_-]{20,64})\.(password|username)$/u;
const LONGUEUR_MIN_NETTOYEE = 3;

/** Référence débarrassée de l'enveloppe `⟦creds:JETON@ORIGINE⟧` que le modèle recopie parfois (l'origine du marqueur est ignorée : seule celle du jeton compte), et des blancs. */
export function normaliserReference(ref: unknown): string {
  const brut = typeof ref === "string" ? ref.trim() : "";
  const m = /^⟦creds:([^⟧]*)⟧(.*)$/su.exec(brut);
  if (m === null) return brut;
  return (m[1] ?? "").split("@")[0] + (m[2] ?? "");
}

/** Jeton d'une référence `JETON.password` ou `JETON.username` ; `null` si la forme est autre. */
export function jetonDeReference(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  return FORME_REF.exec(ref.trim())?.[1] ?? null;
}

function refus(code: string, message: string, fix: string): { refus: Dict } {
  return { refus: errPw(code, "", { message, fix }) };
}

/** Mots de passe résolus par ce process pour un compte, gardés le temps d'un jeton (un identifiant, lisible partout, n'est nettoyé que dans l'appel qui l'a saisi) : filtre de tout résultat pw_* (une page, un `eval` ou une erreur les recopient). Local au process, jamais partagé ni écrit. */
const RECENTS = new Map<string, { secrets: SecretResolu[]; jusqua: number }>();
const MEMOIRE_MS = 40 * 60_000;
const COMPTES_MAX = 256;

function retenirSecrets(username: string, secrets: readonly SecretResolu[]): void {
  const maintenant = Date.now();
  for (const [k, v] of RECENTS) if (v.jusqua <= maintenant) RECENTS.delete(k);
  const avant = RECENTS.get(username)?.secrets ?? [];
  const garde = [...avant.filter((a) => !secrets.some((n) => n.ref === a.ref)), ...secrets].slice(-16);
  RECENTS.delete(username);
  RECENTS.set(username, { secrets: garde, jusqua: maintenant + MEMOIRE_MS });
  if (RECENTS.size > COMPTES_MAX) RECENTS.delete(RECENTS.keys().next().value as string);
}

/** Secrets résolus récemment pour ce compte (à nettoyer de tout résultat). */
export function secretsRecents(username: string): readonly SecretResolu[] {
  const e = RECENTS.get(username);
  return e !== undefined && e.jusqua > Date.now() ? e.secrets : [];
}

const FIX_CREDS = "ask the user to supply a login with the /creds command; never ask for a password in clear";

/** Valeurs des références pour l'appel courant (une résolution, un usage par jeton) ; refus JSON si le core, le jeton, la conversation ou l'expiration l'interdisent. */
export async function resoudreSecrets(
  s: ServicesBrowser,
  ctx: ContexteAppel,
  refs: readonly string[],
  options: { expectOrigin?: string } = {},
): Promise<{ secrets: SecretResolu[] } | { refus: Dict }> {
  const propres = refs.map(normaliserReference);
  if (propres.some((r) => jetonDeReference(r) === null))
    return refus("creds_invalid", "secret must be 'TOKEN.password' or 'TOKEN.username'", FIX_CREDS);
  if (s.rappel === null || !s.rappel.actif)
    return refus(
      "creds_unavailable",
      "the credentials service is not reachable from the tools host",
      FIX_CREDS,
    );
  // Seul le client de confiance (l'application, jeton de service) fournit un `_meta` crédible : ni client externe, ni stdio.
  if (getAccessToken()?.claims["trusted_meta"] !== true)
    return refus(
      "creds_not_available",
      "credentials are only usable from the user's own conversation",
      FIX_CREDS,
    );
  const username = getUsername(ctx);
  const identite = await s.rappel.identityForUsername(username);
  if (identite === null)
    return refus("creds_unavailable", "account not resolvable for credentials", FIX_CREDS);
  const reponse = await s.rappel.resoudreCreds(
    {
      user_id: identite.user_id,
      username,
      chat_id: readMetaField(ctx, "chat_id") ?? "",
      subagent: lireSousAgent(ctx.meta?.["subagent"]),
    },
    propres,
    options.expectOrigin,
  );
  if (reponse === null)
    return refus("creds_unavailable", "the credentials service did not answer", FIX_CREDS);
  if (!reponse.ok) return refus(reponse.code, reponse.message, FIX_CREDS);
  const secrets: SecretResolu[] = [];
  for (const ref of propres) {
    const v = reponse.values[ref];
    const jeton = jetonDeReference(ref);
    if (v === undefined || jeton === null || v.value === "")
      return refus("creds_invalid", "credentials could not be resolved", FIX_CREDS);
    secrets.push({
      ref,
      jeton,
      valeur: v.value,
      origine: v.origin,
      champ: ref.endsWith(".username") ? "username" : "password",
      tlsInsecure: v.insecure_tls,
    });
  }
  retenirSecrets(
    username,
    secrets.filter((x) => x.ref.endsWith(".password")),
  );
  return { secrets };
}

function echapperHtml(v: string): string {
  return v
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Formes sous lesquelles une valeur peut revenir dans une page ou une erreur : brute, URL, formulaire, HTML, JSON, base64 (standard, sans bourrage, URL). */
export function variantes(v: string): string[] {
  if (v.length < LONGUEUR_MIN_NETTOYEE) return [];
  const b64 = Buffer.from(v, "utf8").toString("base64");
  let url = v;
  let uri = v;
  let formulaire = v;
  try {
    // application/x-www-form-urlencoded : `! ' ( ) ~` encodés, espace en `+` (corps d'un formulaire de connexion).
    formulaire = new URLSearchParams({ x: v }).toString().slice(2);
    url = encodeURIComponent(v);
    uri = encodeURI(v);
  } catch {
    // demi-paire isolée : seules les autres formes sont cherchées
  }
  return [
    ...new Set([
      v,
      url,
      url.replaceAll("%20", "+"),
      formulaire,
      uri,
      echapperHtml(v),
      JSON.stringify(v).slice(1, -1),
      b64,
      b64.replace(/=+$/u, ""),
      Buffer.from(v, "utf8").toString("base64url"),
    ]),
  ];
}

/** Étiquette laissée à la place d'une valeur : le marqueur que l'utilisateur a inséré, origine comprise. */
export function etiquette(s: SecretResolu): string {
  return `⟦creds:${s.jeton}@${s.origine}⟧`;
}

function estObjetSimple(v: unknown): v is Dict {
  if (v === null || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * Remplace dans tout texte du résultat (valeurs et clés) chaque forme d'une valeur résolue par `⟦creds:JETON@ORIGINE⟧`.
 * Ne traverse que les tableaux et objets simples : une instance de classe (flottant Python…) reste intacte.
 * Valeurs de moins de 3 caractères exceptées : elles détruiraient la page.
 */
export function nettoyerResultat<T>(valeur: T, secrets: readonly SecretResolu[]): T {
  const paires: [string, string][] = [];
  for (const s of secrets) for (const x of variantes(s.valeur)) paires.push([x, etiquette(s)]);
  if (paires.length === 0) return valeur;
  paires.sort((a, b) => b[0].length - a[0].length);
  const texte = (t: string): string => {
    let sortie = t;
    for (const [forme, marque] of paires)
      if (sortie.includes(forme)) sortie = sortie.split(forme).join(marque);
    return sortie;
  };
  const marche = (v: unknown): unknown => {
    if (typeof v === "string") return texte(v);
    if (Array.isArray(v)) return v.map(marche);
    if (estObjetSimple(v))
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [texte(k), marche(x)]));
    return v;
  };
  return marche(valeur) as T;
}
