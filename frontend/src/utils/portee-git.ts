// SPDX-License-Identifier: MIT
/** frontend/src/utils/portee-git.ts — portée d'un compte git côté interface, avec les règles du serveur : chemin d'organisation ou de dépôt, saisie « hôte/chemin », niveaux proposés pour un dépôt, compte qui sert une URL de clonage. */

/** Ce que la portée lit d'un compte git : son hôte, et son chemin (`""` tout l'hôte, `null` sans portée). */
export interface PorteeCompte {
  readonly host: string;
  readonly path: string | null;
}

const SEGMENT = /^[a-z0-9._~-]+$/u;
const CHEMIN_MAX = 200;
const SEGMENTS_MAX = 8;
const HOTE = /^[^\s/?#@\\]+$/u;

/** Chemin d'une organisation ou d'un dépôt (`acme`, `acme/api`) : segments simples en minuscules, sans barres aux bords ni `.git` final ; `""` : tout l'hôte ; `null` s'il ne se lit pas. */
export function cheminDepot(brut: string): string | null {
  let debut = 0;
  let fin = brut.length;
  while (debut < fin && (brut[debut] === "/" || brut[debut] === " ")) debut++;
  while (fin > debut && (brut[fin - 1] === "/" || brut[fin - 1] === " ")) fin--;
  let t = brut.slice(debut, fin).toLowerCase();
  if (t.endsWith(".git")) t = t.slice(0, -4);
  if (t === "") return "";
  const segments = t.split("/");
  if (t.length > CHEMIN_MAX || segments.length > SEGMENTS_MAX) return null;
  return segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..") ? t : null;
}

/** Le chemin d'une portée couvre celui d'un dépôt : tout l'hôte, le chemin même ou un de ses parents ; un dépôt illisible (`null`) n'est couvert que par tout l'hôte. */
export function cheminCouvre(portee: string, chemin: string | null): boolean {
  if (portee === "") return true;
  return chemin !== null && (chemin === portee || chemin.startsWith(`${portee}/`));
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

/** Hôte (`hôte[:port]`) et chemin du dépôt d'une URL de clonage http(s) ; chemin `null` s'il n'est pas fait de segments simples ; `null` si ce n'est pas une telle URL. */
export function depotDeLUrl(url: string): { host: string; chemin: string | null } | null {
  const t = url.trim();
  if (!/^https?:\/\//iu.test(t) || !URL.canParse(t)) return null;
  const u = new URL(t);
  if (!u.hostname) return null;
  const brut = t.slice(t.indexOf("://") + 3);
  const barre = brut.indexOf("/");
  const chemin = u.search || u.hash || barre < 0 ? null : cheminDepot(brut.slice(barre + 1));
  return { host: u.host, chemin: chemin && chemin.includes("/") ? chemin : null };
}

/** Compte le plus précis qui couvre le dépôt sur son hôte (le plus long chemin ; un compte sans portée ne sert pas) ; `null` si aucun. */
export function compteCouvrant<C extends PorteeCompte>(
  comptes: readonly C[],
  hote: string,
  chemin: string | null,
): C | null {
  let retenu: C | null = null;
  for (const c of comptes) {
    if (c.host !== hote || c.path === null || !cheminCouvre(c.path, chemin)) continue;
    if (retenu === null || c.path.length > (retenu.path ?? "").length) retenu = c;
  }
  return retenu;
}

/** Portée proposée pour des identifiants saisis au clone, comme le serveur : celle du compte à chemin qui couvre le dépôt, tout l'hôte s'il n'a aucun compte, sinon le parent du dépôt. */
export function porteeDesSaisis(
  comptes: readonly PorteeCompte[],
  hote: string,
  chemin: string | null,
): string {
  const couvrant = compteCouvrant(comptes, hote, chemin);
  if (couvrant === null) return "";
  if (couvrant.path) return couvrant.path;
  return chemin === null ? "" : chemin.slice(0, Math.max(0, chemin.lastIndexOf("/")));
}
