// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/dn.ts — forme normalisée d'un DN (RFC 4514 : échappements équivalents, blancs de bord retirés, casse ignorée, RDN multivalués triés) pour comparer deux DN. */

interface Jeton {
  readonly c: string;
  readonly echappe: boolean;
}

const SPECIAUX = new Set([",", "+", '"', "\\", "<", ">", ";"]);
const HEX = /^[0-9A-Fa-f]{2}$/u;

/** Découpe `texte` sur `sep` hors échappement. */
function couper(texte: string, sep: string): string[] {
  const parts: string[] = [];
  let courant = "";
  for (let i = 0; i < texte.length; i++) {
    const c = texte[i] as string;
    if (c === "\\") {
      courant += c + (texte[i + 1] ?? "");
      i++;
    } else if (c === sep) {
      parts.push(courant);
      courant = "";
    } else courant += c;
  }
  parts.push(courant);
  return parts;
}

function vider(octets: number[], jetons: Jeton[]): void {
  if (octets.length === 0) return;
  const tampon = Buffer.from(octets);
  const texte = tampon.toString("utf8");
  if (Buffer.from(texte, "utf8").equals(tampon)) for (const c of texte) jetons.push({ c, echappe: true });
  else for (const o of octets) jetons.push({ c: `\\${o.toString(16).padStart(2, "0")}`, echappe: true });
  octets.length = 0;
}

/** Valeur lue (RFC 4514 §3) : paires et formes hexadécimales remplacées par leurs caractères. */
function jetons(brut: string): Jeton[] {
  const sortie: Jeton[] = [];
  const octets: number[] = [];
  for (let i = 0; i < brut.length; i++) {
    const c = brut[i] as string;
    if (c !== "\\") {
      vider(octets, sortie);
      sortie.push({ c, echappe: false });
      continue;
    }
    const suite = brut.slice(i + 1, i + 3);
    if (HEX.test(suite)) {
      octets.push(Number.parseInt(suite, 16));
      i += 2;
      continue;
    }
    vider(octets, sortie);
    sortie.push({ c: brut[i + 1] ?? "\\", echappe: true });
    i++;
  }
  vider(octets, sortie);
  return sortie;
}

function valeur(brut: string): string {
  const t = jetons(brut);
  while (t.length > 0 && !t[0]?.echappe && t[0]?.c === " ") t.shift();
  while (t.length > 0 && !t[t.length - 1]?.echappe && t[t.length - 1]?.c === " ") t.pop();
  if (t[0]?.c === "#" && !t[0].echappe)
    return t
      .map((x) => x.c)
      .join("")
      .toLowerCase();
  return t
    .map((x, i) => {
      if (x.c.length > 1) return x.c;
      if (x.c === "\0") return "\\00";
      if (SPECIAUX.has(x.c)) return `\\${x.c}`;
      if (x.c === " " && (i === 0 || i === t.length - 1)) return "\\ ";
      if (x.c === "#" && i === 0) return "\\#";
      return x.c;
    })
    .join("")
    .toLowerCase();
}

function ava(brut: string): string {
  const i = brut.indexOf("=");
  if (i < 0) return brut.trim().toLowerCase();
  return `${brut.slice(0, i).trim().toLowerCase()}=${valeur(brut.slice(i + 1))}`;
}

/** DN en minuscules, sans blanc autour des virgules ni des signes égal, échappements ramenés à une forme unique (`\2C` = `\,`), RDN multivalués triés ; les virgules échappées restent dans leur valeur. */
export function dnNormalise(dn: string): string {
  return couper(dn, ",")
    .map((rdn) => couper(rdn, "+").map(ava).sort().join("+"))
    .join(",");
}

/** Vrai si les deux DN sont les mêmes une fois normalisés. */
export function memeDn(a: string, b: string): boolean {
  return dnNormalise(a) === dnNormalise(b);
}
