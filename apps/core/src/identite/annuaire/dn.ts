// SPDX-License-Identifier: MIT
/** apps/core/src/identite/annuaire/dn.ts — forme normalisée d'un DN (RFC 4514 strict : échappements équivalents, blancs de bord retirés, casse ignorée, RDN multivalués triés) pour comparer deux DN ; un DN hors grammaire n'est égal qu'à son texte. */

interface Jeton {
  readonly c: string;
  readonly echappe: boolean;
}

interface Ava {
  readonly type: string;
  readonly valeur: string;
  readonly hex: boolean;
}

const SPECIAUX = new Set([",", "+", '"', "\\", "<", ">", ";"]);
const ECHAPPABLES = new Set([...SPECIAUX, " ", "#", "="]);
const NON_ECHAPPES = new Set(['"', ";", "<", ">", "\0"]);
const HEX = /^[0-9A-Fa-f]{2}$/u;
const TYPE_DN = /^(?:[A-Za-z][A-Za-z0-9-]*|(?:0|[1-9][0-9]*)(?:\.(?:0|[1-9][0-9]*))+)$/u;
const FORME_HEX = /^#(?:[0-9A-Fa-f]{2})+$/u;
const TYPE_NUMERIQUE = /^\d/u;

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

/** Valeur lue (RFC 4514 §3) : paires et formes hexadécimales remplacées par leurs caractères ; `null` hors grammaire. */
function jetons(brut: string): Jeton[] | null {
  const sortie: Jeton[] = [];
  const octets: number[] = [];
  for (let i = 0; i < brut.length; i++) {
    const c = brut[i] as string;
    if (c !== "\\") {
      if (NON_ECHAPPES.has(c)) return null;
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
    const x = brut[i + 1];
    if (x === undefined || !ECHAPPABLES.has(x)) return null;
    vider(octets, sortie);
    sortie.push({ c: x, echappe: true });
    i++;
  }
  vider(octets, sortie);
  return sortie;
}

function valeur(brut: string): Pick<Ava, "valeur" | "hex"> | null {
  const t = jetons(brut);
  if (t === null) return null;
  while (t.length > 0 && !t[0]?.echappe && t[0]?.c === " ") t.shift();
  while (t.length > 0 && !t[t.length - 1]?.echappe && t[t.length - 1]?.c === " ") t.pop();
  if (t[0]?.c === "#" && !t[0].echappe) {
    const brutHex = t.map((x) => x.c).join("");
    if (t.some((x) => x.echappe) || !FORME_HEX.test(brutHex)) return null;
    return { valeur: brutHex.toLowerCase(), hex: true };
  }
  const v = t
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
  return { valeur: v, hex: false };
}

function ava(brut: string): Ava | null {
  const i = brut.indexOf("=");
  if (i < 0) return null;
  const type = brut.slice(0, i).replace(/^ +| +$/gu, "");
  if (!TYPE_DN.test(type)) return null;
  const v = valeur(brut.slice(i + 1));
  return v === null ? null : { type: type.toLowerCase(), ...v };
}

/** RDN d'un DN lu strictement (RFC 4514) ; `null` hors grammaire. */
function analyse(dn: string): Ava[][] | null {
  if (dn === "") return [];
  const rdns: Ava[][] = [];
  for (const rdn of couper(dn, ",")) {
    const avas: Ava[] = [];
    for (const brut of couper(rdn, "+")) {
      const a = ava(brut);
      if (a === null) return null;
      avas.push(a);
    }
    rdns.push(avas);
  }
  return rdns;
}

/** Vrai si le DN respecte la grammaire de RFC 4514. */
export function dnValide(dn: string): boolean {
  return analyse(dn) !== null;
}

/** Vrai si le DN est valide et écrit avec des noms d'attribut usuels (ni OID numérique, ni valeur en forme `#` hexadécimale). */
export function dnUsuel(dn: string): boolean {
  const rdns = analyse(dn);
  return rdns !== null && rdns.every((r) => r.every((a) => !a.hex && !TYPE_NUMERIQUE.test(a.type)));
}

/** DN en minuscules, sans blanc autour des virgules ni des signes égal, échappements ramenés à une forme unique (`\2C` = `\,`), RDN multivalués triés ; un DN hors grammaire garde son texte, préfixé d'un NUL. */
export function dnNormalise(dn: string): string {
  const rdns = analyse(dn);
  if (rdns === null) return `\0${dn}`;
  return rdns
    .map((r) =>
      r
        .map((a) => `${a.type}=${a.valeur}`)
        .sort()
        .join("+"),
    )
    .join(",");
}

/** Vrai si les deux DN sont les mêmes une fois normalisés. */
export function memeDn(a: string, b: string): boolean {
  return dnNormalise(a) === dnNormalise(b);
}
