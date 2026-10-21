// SPDX-License-Identifier: MIT
/** apps/core/src/comptes/aides.ts — aides des routes de comptes : politique de mot de passe, garde cross-site, images, cookie effacé, URL de base. */
import { enteteEffacement, netlocUrl } from "@elpis/auth";
import { getPy, HttpError, intPy, stripPy, veritePy } from "@elpis/commun";
import type { AttributsCookie } from "@elpis/config";
import type { FastifyRequest } from "fastify";
import { entete } from "@elpis/http";

export { getPy };

const SPECIAL = /[!@#$%^&*(),.?":{}|<>\-_[\]+=\\/~`]/u;
const BASE_SURE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?$/u;
const REFUS_INTER_SITE = "Requête cross-site refusée.";

/** `(v or "")` attendu texte : une valeur vraie d'un autre type lève (500) comme `.strip()` ou `.encode()` en Python. */
export function textePy(v: unknown): string {
  if (!veritePy(v)) return "";
  if (typeof v !== "string") throw new TypeError(`'${typeof v}' object is not a str`);
  return v;
}

/** `validate_password` : politique `security.password_policy` relue à chaque appel (longueur en points de code, `\d` Unicode). */
export function validerMotDePasse(motDePasse: string, config: unknown): void {
  const politique = getPy(getPy(config, "security", {}), "password_policy", {});
  const longueur = intPy(getPy(politique, "min_length", 0));
  const exige = (cle: string): boolean => veritePy(getPy(politique, cle, false));
  if (longueur > 0 && Array.from(motDePasse).length < longueur)
    throw new HttpError(400, `Le mot de passe doit faire au moins ${longueur} caractères.`);
  if (exige("require_uppercase") && !/[A-Z]/u.test(motDePasse))
    throw new HttpError(400, "Le mot de passe doit contenir au moins une majuscule (A-Z).");
  if (exige("require_lowercase") && !/[a-z]/u.test(motDePasse))
    throw new HttpError(400, "Le mot de passe doit contenir au moins une minuscule (a-z).");
  if (exige("require_numbers") && !/\p{Nd}/u.test(motDePasse))
    throw new HttpError(400, "Le mot de passe doit contenir au moins un chiffre (0-9).");
  if (exige("require_special") && !SPECIAL.test(motDePasse))
    throw new HttpError(400, "Le mot de passe doit contenir au moins un caractère spécial.");
}

/** `_reject_cross_site` du changement de mot de passe : Sec-Fetch-Site, sinon hôte d'Origin = Host (Origin `null` toléré). */
export function rejeterInterSite(entetes: (nom: string) => string | undefined, netlocServeur: string): void {
  const site = stripPy(entetes("sec-fetch-site") ?? "").toLowerCase();
  if (site) {
    if (site !== "same-origin" && site !== "none") throw new HttpError(403, REFUS_INTER_SITE);
    return;
  }
  const origine = stripPy(entetes("origin") ?? "");
  if (!origine || origine.toLowerCase() === "null") return;
  let hoteOrigine: string;
  try {
    hoteOrigine = netlocUrl(origine).toLowerCase();
  } catch {
    hoteOrigine = "";
  }
  const hote = stripPy(entetes("host") || netlocServeur || "").toLowerCase();
  if (!hoteOrigine || hoteOrigine !== hote) throw new HttpError(403, REFUS_INTER_SITE);
}

/** `_detect_image_type` puis `_IMAGE_TYPE_TO_EXT` : extension tirée des premiers octets, jamais du client. */
export function extensionImage(tete: Buffer): string | null {
  if (tete.length < 4) return null;
  if (tete[0] === 0xff && tete[1] === 0xd8 && tete[2] === 0xff) return ".jpg";
  if (tete.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return ".png";
  const debut = tete.subarray(0, 6).toString("latin1");
  if (debut === "GIF87a" || debut === "GIF89a") return ".gif";
  if (
    tete.length >= 12 &&
    tete.subarray(0, 4).toString("latin1") === "RIFF" &&
    tete.subarray(8, 12).toString("latin1") === "WEBP"
  )
    return ".webp";
  return null;
}

/** En-tête d'effacement du cookie de session (source unique : `@elpis/auth`). */
export function enteteSuppressionCookie(a: AttributsCookie, maintenant: number): string {
  return enteteEffacement(a, maintenant);
}

/** `_base_url` : schéma (X-Forwarded-Proto des mandataires de confiance) et Host contactés, validés contre une forme stricte. */
export function urlDeBase(requete: FastifyRequest): string {
  const hote =
    entete(requete, "host") ?? `${requete.socket.localAddress ?? ""}:${requete.socket.localPort ?? ""}`;
  const brut = `${requete.protocol}://${hote}`.replace(/\/+$/u, "");
  if (!BASE_SURE.test(brut)) throw new HttpError(400, "Hôte invalide.");
  return brut;
}

/** Hôte du serveur quand la requête n'a pas d'en-tête Host (`request.url.netloc` de Starlette). */
export function netlocServeur(requete: FastifyRequest): string {
  return `${requete.socket.localAddress ?? ""}:${requete.socket.localPort ?? ""}`;
}
