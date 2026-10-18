// SPDX-License-Identifier: MIT
/** apps/toolhost/src/apercu-reecriture.ts — références absolues-racine d'une page en aperçu (preview_rewrite.py) : réécrites vers le résolveur `~r/d<dossier>/<chemin>` du jeton. */
import { BLANC_PY, motifPy, pyJsonDumps, quotePy } from "@elpis/commun";
import { desechapper } from "@elpis/http";

export const RESOLVER = "~r";
export const MAX_REWRITE_BYTES = 4 * 1024 * 1024;

const S = BLANC_PY;
const ATTRIBUTS = ["href", "src", "action", "poster", "data", "formaction"].map(motifPy).join("|");
// `\s`, `re.I` et `\b` de `re` (Unicode) : blancs de `str.isspace`, İ/ı/ſ/K, lettres et chiffres de toute écriture.
const ATTR = new RegExp(`(${S}(?:${ATTRIBUTS})${S}*=${S}*)(["']?)/(?![/\\\\])`, "gu");
const CSS_URL = new RegExp(`(${motifPy("url")}\\(${S}*)(["']?)/(?![/\\\\])`, "gu");
const CSS_IMPORT = new RegExp(`(@${motifPy("import")}${S}+)(["'])/(?![/\\\\])`, "gu");
const DEBUT_TETE = new RegExp(`<${motifPy("head")}(?![\\p{L}\\p{N}_])`, "u");

const SHIM =
  "<script>(function(b){function f(u){return(typeof u==='string'&&u.charAt(0)==='/'" +
  "&&u.charAt(1)!=='/')?b+u.slice(1):u}var F=window.fetch;if(F)window.fetch=" +
  "function(u,o){return F.call(this,f(u),o)};var X=window.XMLHttpRequest;if(X){var O=" +
  "X.prototype.open;X.prototype.open=function(m,u){arguments[1]=f(u);return O.apply(" +
  "this,arguments)}}})(%s);</script>";

/** `<prefixe>~r/d<dossier encodé>/` ; `d` seul pour la racine (un segment « . » serait normalisé par le navigateur). */
export function resolverBase(prefixe: string, dossier: string): string {
  return `${prefixe}${RESOLVER}/d${quotePy(dossier.replace(/^\/+|\/+$/gu, ""), "")}/`;
}

/** `d<dossier>/<chemin>` → `[dossier, chemin]`, ou `null`. */
export function splitResolver(reste: string): [string, string] | null {
  const i = reste.indexOf("/");
  const seg = i < 0 ? reste : reste.slice(0, i);
  const voulu = i < 0 ? "" : reste.slice(i + 1);
  if (!seg.startsWith("d") || !voulu) return null;
  return [desechapper(seg.slice(1)), voulu];
}

function prefixer(texte: string, motif: RegExp, base: string): string {
  return texte.replace(motif, (_m, avant: string, guillemet: string) => `${avant}${guillemet}${base}`);
}

export function rewriteCss(texte: string, base: string): string {
  return prefixer(prefixer(texte, CSS_URL, base), CSS_IMPORT, base);
}

/** Fin du premier `<head…>` (`<head\b[^>]*>` de `re`) en temps linéaire : sans `>` après le premier `<head`, aucun plus loin ; -1 sinon. */
function finDeTete(t: string): number {
  const m = DEBUT_TETE.exec(t);
  const chevron = m ? t.indexOf(">", m.index + m[0].length) : -1;
  return chevron < 0 ? -1 : chevron + 1;
}

/** Attributs, CSS, puis le script qui redirige `fetch`/`XMLHttpRequest`, juste après `<head…>` (sinon en tête). */
export function rewriteHtml(texte: string, base: string): string {
  const t = rewriteCss(prefixer(texte, ATTR, base), base);
  const shim = SHIM.replace("%s", () => pyJsonDumps(base));
  const fin = finDeTete(t);
  return fin < 0 ? shim + t : t.slice(0, fin) + shim + t.slice(fin);
}
