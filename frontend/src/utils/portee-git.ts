// SPDX-License-Identifier: MIT
/** frontend/src/utils/portee-git.ts — portée d'un compte git côté interface, avec les règles du serveur : chemin d'organisation ou de dépôt, casse selon le type de forge, saisie « hôte/chemin », niveaux proposés pour un dépôt, compte qui sert une URL de clonage. */

/** Ce que la portée lit d'un compte git : son hôte, son chemin (`""` tout l'hôte, `null` sans portée) et son type de forge. */
export interface PorteeCompte {
  readonly host: string;
  readonly path: string | null;
  readonly provider_type?: string | undefined;
}

const SEGMENT = /^[A-Za-z0-9._~-]+$/u;
const CHEMIN_MAX = 200;
const SEGMENTS_MAX = 8;
const HOTE = /^[^\s/?#@\\]+$/u;

/** Chemin déjà en forme : segments simples, sans barre aux bords ni `.git` final, casse gardée ; `null` sinon. */
export function cheminExact(brut: string): string | null {
  if (brut === "" || brut.length > CHEMIN_MAX || brut.toLowerCase().endsWith(".git")) return null;
  const segments = brut.split("/");
  if (segments.length > SEGMENTS_MAX) return null;
  return segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..") ? brut : null;
}

/** Chemin d'une organisation ou d'un dépôt saisi (`acme`, `acme/api`) : espaces et barres des bords et un `.git` final retirés ; `""` : tout l'hôte ; `null` s'il ne se lit pas. */
export function cheminDepot(brut: string): string | null {
  let debut = 0;
  let fin = brut.length;
  while (debut < fin && (brut[debut] === "/" || brut[debut] === " ")) debut++;
  while (fin > debut && (brut[fin - 1] === "/" || brut[fin - 1] === " ")) fin--;
  let t = brut.slice(debut, fin);
  if (t.endsWith(".git")) t = t.slice(0, -4);
  return t === "" ? "" : cheminExact(t);
}

/** Le chemin d'une portée couvre celui d'un dépôt : tout l'hôte, le chemin même ou un de ses parents ; un dépôt illisible (`null`) n'est couvert que par tout l'hôte. */
export function cheminCouvre(portee: string, chemin: string | null): boolean {
  if (portee === "") return true;
  return chemin !== null && (chemin === portee || chemin.startsWith(`${portee}/`));
}

/** Chemin tel que le compare un compte de ce type : sans la casse pour les forges qui l'ignorent, exact pour un service générique. */
export function cheminPourType(chemin: string, type: string | undefined): string {
  return type === "generic" ? chemin : chemin.toLowerCase();
}

/** Ce à quoi un compte s'applique, tel qu'affiché et saisi : `hôte` ou `hôte/chemin`. */
export function cibleCompte(c: PorteeCompte): string {
  return c.path ? `${c.host}/${c.path}` : c.host;
}

/** Portées possibles pour un dépôt, de la plus large à la plus précise : `""`, `acme`, `acme/api`. */
export function niveauxPortee(chemin: string | null): string[] {
  if (!chemin) return [""];
  const segments = chemin.split("/");
  return ["", ...segments.map((_, i) => segments.slice(0, i + 1).join("/"))];
}

/** Hôte et chemin d'une saisie « S'applique à » (`hôte[:port][/chemin]`, une URL collée est acceptée) ; `null` si elle ne se lit pas. */
export function lirePortee(brut: string): { host: string; path: string } | null {
  let t = brut.trim();
  const schema = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(t);
  if (schema) t = t.slice(schema[0].length);
  const barre = t.indexOf("/");
  let hote = (barre < 0 ? t : t.slice(0, barre)).toLowerCase();
  const arobase = hote.lastIndexOf("@");
  if (schema && arobase >= 0) hote = hote.slice(arobase + 1);
  const chemin = cheminDepot(barre < 0 ? "" : t.slice(barre + 1));
  return hote && HOTE.test(hote) && chemin !== null ? { host: hote, path: chemin } : null;
}

/** Dépôt d'une URL de clonage, lu comme le serveur : schéma, hôte tel qu'écrit (port compris, en minuscules), chemin (`null` s'il n'est pas fait de segments simples ou n'en a qu'un) ; `servi` : le serveur cherche un compte pour cette adresse (au moins un propriétaire et un dépôt). */
export interface DepotUrl {
  readonly schema: "http" | "https";
  readonly host: string;
  readonly chemin: string | null;
  readonly servi: boolean;
}

/** Dépôt d'une URL de clonage `http(s)://` (schéma en minuscules) ; chemin sans barres finales ni un `.git`, rien d'autre ; `null` si ce n'est pas une telle URL. */
export function depotDeLUrl(url: string): DepotUrl | null {
  const t = url.trim();
  if (!/^https?:\/\//u.test(t) || !URL.canParse(t)) return null;
  const schema = t.startsWith("https://") ? "https" : "http";
  const apresSchema = t.slice(t.indexOf("://") + 3);
  const barre = apresSchema.search(/[/?#]/u);
  const autorite = barre < 0 ? apresSchema : apresSchema.slice(0, barre);
  const host = autorite.slice(autorite.lastIndexOf("@") + 1).toLowerCase();
  if (!host || !HOTE.test(host)) return null;
  let brut = barre < 0 || apresSchema[barre] !== "/" ? "" : apresSchema.slice(barre + 1);
  let fin = brut.length;
  while (fin > 0 && brut[fin - 1] === "/") fin--;
  brut = brut.slice(0, fin);
  if (brut.endsWith(".git")) brut = brut.slice(0, -4);
  // Le serveur ne cherche un compte que pour `propriétaire/dépôt` : un dépôt à la racine de l'hôte n'en reçoit aucun.
  const servi = brut.split("/").filter(Boolean).length >= 2;
  if (barre >= 0 && apresSchema[barre] !== "/") return { schema, host, chemin: null, servi: false };
  if (brut.includes("?") || brut.includes("#")) return { schema, host, chemin: null, servi };
  const chemin = cheminExact(brut);
  return { schema, host, chemin: chemin !== null && chemin.includes("/") ? chemin : null, servi };
}

/** Compte le plus précis qui couvre le dépôt sur son hôte : le plus long chemin, comparé selon le type de chaque compte ; un compte sans portée ne sert pas ; un dépôt illisible n'a de compte que si aucun compte de l'hôte n'est borné à un chemin ; `null` si aucun. */
export function compteCouvrant<C extends PorteeCompte>(
  comptes: readonly C[],
  hote: string,
  chemin: string | null,
): C | null {
  const deLHote = comptes.filter((c) => c.host === hote && c.path !== null);
  if (chemin === null && deLHote.some((c) => c.path !== "")) return null;
  let retenu: C | null = null;
  for (const c of deLHote) {
    const voulu = chemin === null ? null : cheminPourType(chemin, c.provider_type);
    if (!cheminCouvre(c.path ?? "", voulu)) continue;
    if (retenu === null || (c.path ?? "").length > (retenu.path ?? "").length) retenu = c;
  }
  return retenu;
}

/** Portée proposée pour des identifiants saisis au clone, comme le serveur et dans la casse de l'URL : celle du compte à chemin qui couvre le dépôt, tout l'hôte si aucun compte ne l'a, sinon le parent du dépôt ; `null` quand le serveur n'enregistrerait rien d'office (dépôt illisible, tout l'hôte déjà pris). */
export function porteeDesSaisis(
  comptes: readonly PorteeCompte[],
  hote: string,
  chemin: string | null,
): string | null {
  const deLHote = comptes.filter((c) => c.host === hote && c.path !== null);
  if (chemin === null) return deLHote.some((c) => c.path === "") ? null : "";
  const couvrant = compteCouvrant(deLHote, hote, chemin);
  if (couvrant === null) return "";
  const segments = chemin.split("/");
  return segments.slice(0, couvrant.path ? couvrant.path.split("/").length : segments.length - 1).join("/");
}
