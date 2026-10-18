// SPDX-License-Identifier: MIT
/** packages/http/src/url.ts — chemin et requête lus comme uvicorn (httptools) et Starlette : `unquote`, `parse_qsl`, routage sur le chemin décodé. */
const decodeurRemplacement = new TextDecoder("utf-8", { ignoreBOM: true });
const HEX = /^[0-9A-Fa-f]{2}/;

/** `urllib.parse.unquote_to_bytes` d'un segment ASCII. */
function octetsDesechappes(ascii: string): Uint8Array {
  const morceaux = ascii.split("%");
  const octets: number[] = [];
  const ajouter = (s: string): void => {
    for (let i = 0; i < s.length; i++) octets.push(s.charCodeAt(i));
  };
  ajouter(morceaux[0] ?? "");
  for (const morceau of morceaux.slice(1)) {
    if (HEX.test(morceau)) {
      octets.push(parseInt(morceau.slice(0, 2), 16));
      ajouter(morceau.slice(2));
    } else {
      ajouter("%" + morceau);
    }
  }
  return Uint8Array.from(octets);
}

/** `urllib.parse.unquote(s)` : octets UTF-8 invalides remplacés, `%` sans deux chiffres hexadécimaux gardé tel quel. */
export function desechapper(s: string): string {
  if (!s.includes("%")) return s;
  return s.replace(/[^\u0080-\uffff]+/g, (ascii) => decodeurRemplacement.decode(octetsDesechappes(ascii)));
}

/** `urllib.parse.unquote_plus(s)`. */
function desechapperPlus(s: string): string {
  return desechapper(s.replace(/\+/g, " "));
}

/** `parse_qsl(query_string, keep_blank_values=True)` de Starlette (séparateur `&` seul). */
export function analyserRequete(brute: string): [string, string][] {
  const paires: [string, string][] = [];
  if (!brute) return paires;
  for (const morceau of brute.split("&")) {
    if (!morceau) continue;
    const egal = morceau.indexOf("=");
    const nom = egal < 0 ? morceau : morceau.slice(0, egal);
    const valeur = egal < 0 ? "" : morceau.slice(egal + 1);
    paires.push([desechapperPlus(nom), desechapperPlus(valeur)]);
  }
  return paires;
}

/** Chemin décodé par `unquote` comme uvicorn, puis réencodé pour que le routeur le décode à l'identique : `%2F` y devient un vrai `/`. */
export function urlCommeUvicorn(url: string): string {
  let fin = url.indexOf("?");
  const diese = url.indexOf("#");
  if (diese >= 0 && (fin < 0 || diese < fin)) fin = diese;
  const chemin = fin < 0 ? url : url.slice(0, fin);
  if (!chemin.includes("%")) return url;
  const reencode = encodeURI(desechapper(chemin).toWellFormed()).replace(/[?#]/g, (c) =>
    c === "?" ? "%3F" : "%23",
  );
  return fin < 0 ? reencode : reencode + url.slice(fin);
}

/** Chemin et requête bruts d'une cible HTTP (forme origine ou absolue, fragment retiré), comme `httptools.parse_url`. */
export function decouperCible(cible: string): { chemin: string; requete: string } {
  let reste = cible;
  if (!reste.startsWith("/")) {
    const absolue = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/u.exec(reste);
    reste = absolue ? reste.slice(absolue[0].length) : "";
  }
  const diese = reste.indexOf("#");
  if (diese >= 0) reste = reste.slice(0, diese);
  const question = reste.indexOf("?");
  return question < 0
    ? { chemin: reste, requete: "" }
    : { chemin: reste.slice(0, question), requete: reste.slice(question + 1) };
}
