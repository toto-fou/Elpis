// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/browser/creds.ts — secrets `⟦creds:JETON⟧` des outils pw_* : résolution par le core (conversation et compte de l'appel), origine attendue, nettoyage des résultats. */
import type { Dict } from "@elpis/commun";
import { getUsername, readMetaField, tokenIdentity } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { errPw } from "@elpis/navigateur";
import { lireSousAgent } from "@elpis/securite";

import type { ServicesBrowser } from "./appel";

export interface SecretResolu {
  readonly ref: string;
  readonly jeton: string;
  readonly valeur: string;
  readonly origine: string;
}

const FORME_REF = /^([A-Za-z0-9_-]{20,64})\.(password|username)$/u;
const LONGUEUR_MIN_NETTOYEE = 3;

/** Référence débarrassée de l'enveloppe `⟦creds:…⟧` que le modèle recopie parfois, et des blancs. */
export function normaliserReference(ref: unknown): string {
  const brut = typeof ref === "string" ? ref.trim() : "";
  return /^⟦creds:/u.test(brut) ? brut.replace(/^⟦creds:/u, "").replace("⟧", "") : brut;
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
  if (tokenIdentity() !== null)
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
    secrets.push({ ref, jeton, valeur: v.value, origine: v.origin });
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
  try {
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
      uri,
      echapperHtml(v),
      JSON.stringify(v).slice(1, -1),
      b64,
      b64.replace(/=+$/u, ""),
      Buffer.from(v, "utf8").toString("base64url"),
    ]),
  ];
}

/** Remplace dans tout texte du résultat chaque forme d'une valeur résolue par `⟦creds:JETON⟧` (valeurs de moins de 3 caractères exceptées : elles détruiraient la page). */
export function nettoyerResultat<T>(valeur: T, secrets: readonly SecretResolu[]): T {
  const paires: [string, string][] = [];
  for (const s of secrets) for (const x of variantes(s.valeur)) paires.push([x, `⟦creds:${s.jeton}⟧`]);
  if (paires.length === 0) return valeur;
  paires.sort((a, b) => b[0].length - a[0].length);
  const texte = (t: string): string => {
    let sortie = t;
    for (const [forme, etiquette] of paires)
      if (sortie.includes(forme)) sortie = sortie.split(forme).join(etiquette);
    return sortie;
  };
  const marche = (v: unknown): unknown => {
    if (typeof v === "string") return texte(v);
    if (Array.isArray(v)) return v.map(marche);
    if (v !== null && typeof v === "object")
      return Object.fromEntries(Object.entries(v as Dict).map(([k, x]) => [k, marche(x)]));
    return v;
  };
  return marche(valeur) as T;
}
