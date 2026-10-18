// SPDX-License-Identifier: MIT
/** packages/skills/src/frontmatter.ts — frontmatter « YAML léger » (parseur maison) : dicts en Map, flottants en FlottantPy, à lire par strFrontmatter, veriteFrontmatter et frontmatterEnObjet. */
import {
  BLANC_PY,
  ErreurPython,
  floatPy as flottantPy,
  FlottantPy,
  intPy as entierPy,
  lowerPy,
  lstripPy,
  reprPy,
  rstripPy,
  splitlinesPy,
  stripPy,
  veritePy,
} from "@elpis/commun";

export { FlottantPy };

/** `dict` de Python : `Map` pour garder l'ordre d'insertion et n'importe quelle clé. */
export type ValeurFrontmatter =
  string | number | FlottantPy | boolean | null | string[] | Map<string, ValeurFrontmatter>;
export type Frontmatter = Map<string, ValeurFrontmatter>;

/** `re.split(r"^---\s*$", texte, maxsplit=2, flags=re.M)` : `^`/`$` de ligne au sens de `\n` seul, `\s` Unicode de `re`. */
const DELIMITEUR = new RegExp(`(?<=^|\\n)---${BLANC_PY}*(?=\\n|$)`, "g");

function stripCaracteres(s: string, jeu: string, debutSeul = false): string {
  let debut = 0;
  let fin = s.length;
  while (debut < fin && jeu.includes(s.charAt(debut))) debut++;
  while (!debutSeul && fin > debut && jeu.includes(s.charAt(fin - 1))) fin--;
  return s.slice(debut, fin);
}

/** `str(valeur)` de Python : texte tel quel, `repr` sinon (dict compris). */
export function strFrontmatter(v: unknown): string {
  return typeof v === "string" ? v : reprFrontmatter(v);
}

function reprFrontmatter(v: unknown): string {
  if (v instanceof FlottantPy) return v.toString();
  if (v instanceof Map)
    return `{${[...v].map(([k, x]) => `${reprPy(k)}: ${reprFrontmatter(x)}`).join(", ")}}`;
  if (Array.isArray(v)) return `[${v.map(reprFrontmatter).join(", ")}]`;
  return reprPy(v);
}

/** Frontmatter vers JSON (réponse HTTP, stockage) : `Map` en objet, `FlottantPy` en nombre. */
export function frontmatterEnObjet(v: unknown): unknown {
  if (v instanceof FlottantPy) return v.valeur;
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, frontmatterEnObjet(x)]));
  return Array.isArray(v) ? v.map(frontmatterEnObjet) : v;
}

/** Vérité de Python : dict (`Map`) vide et flottant nul faux. */
export function veriteFrontmatter(v: unknown): boolean {
  if (v instanceof FlottantPy) return v.valeur !== 0;
  return v instanceof Map ? v.size > 0 : veritePy(v);
}

/** Valeur simple : texte, entier, flottant, booléen, nul, liste `[a, b]` ou dict `{a: b}` en ligne. */
export function parseValue(raw: string): ValeurFrontmatter {
  const r = stripPy(raw);
  if (!r) return "";
  const bas = lowerPy(r);
  if (bas === "true" || bas === "yes") return true;
  if (bas === "false" || bas === "no") return false;
  if (bas === "null" || bas === "none" || bas === "~") return null;
  if (r.startsWith("[") && r.endsWith("]")) {
    const interieur = stripPy(r.slice(1, -1));
    if (!interieur) return [];
    return interieur
      .split(",")
      .map((s) => stripCaracteres(stripPy(s), "'\""))
      .filter((it) => it !== "");
  }
  if (r.startsWith("{") && r.endsWith("}")) {
    const interieur = stripPy(r.slice(1, -1));
    const out: Frontmatter = new Map();
    for (const partie of interieur ? interieur.split(",") : []) {
      const i = partie.indexOf(":");
      if (i < 0) continue;
      out.set(stripCaracteres(stripPy(partie.slice(0, i)), "'\""), parseValue(partie.slice(i + 1)));
    }
    return out;
  }
  try {
    return r.includes(".") || bas.includes("e") ? new FlottantPy(flottantPy(r)) : entierPy(r);
  } catch (e) {
    if (!(e instanceof ErreurPython && e.type === "ValueError")) throw e;
  }
  if ((r.startsWith('"') && r.endsWith('"')) || (r.startsWith("'") && r.endsWith("'"))) return r.slice(1, -1);
  return r;
}

/** Bloc entre les deux `---` ; une clé à valeur vide suivie de lignes indentées `k: v` devient un dict (un seul niveau). */
export function parseFrontmatterBlock(block: string): Frontmatter {
  const out: Frontmatter = new Map();
  let parentPossible: string | null = null;
  for (const brute of splitlinesPy(block)) {
    const ligne = rstripPy(brute);
    if (!ligne || lstripPy(ligne).startsWith("#")) continue;
    if (ligne.startsWith(" ") || ligne.startsWith("\t")) {
      const s = stripPy(ligne);
      const i = s.indexOf(":");
      const k = i < 0 ? "" : stripPy(s.slice(0, i));
      if (parentPossible !== null && k) {
        let parent = out.get(parentPossible);
        if (!(parent instanceof Map)) {
          parent = new Map();
          out.set(parentPossible, parent);
        }
        parent.set(k, parseValue(s.slice(i + 1)));
      }
      continue;
    }
    const i = ligne.indexOf(":");
    if (i < 0) continue;
    const cle = stripPy(ligne.slice(0, i));
    if (!cle) continue;
    const valeur = parseValue(ligne.slice(i + 1));
    out.set(cle, valeur);
    parentPossible = valeur === "" ? cle : null;
  }
  return out;
}

function decouper(contenu: string): string[] {
  const parties: string[] = [];
  let debut = 0;
  DELIMITEUR.lastIndex = 0;
  for (let n = 0; n < 2; n++) {
    const m = DELIMITEUR.exec(contenu);
    if (m === null) break;
    parties.push(contenu.slice(debut, m.index));
    debut = m.index + m[0].length;
  }
  parties.push(contenu.slice(debut));
  return parties;
}

/** Frontmatter et corps ; `[vide, contenu]` sans bloc `---` ouvert et fermé. */
export function splitFrontmatter(content: string): [Frontmatter, string] {
  if (!lstripPy(content).startsWith("---")) return [new Map(), content];
  const parties = decouper(content);
  if (parties.length < 3) return [new Map(), content];
  return [parseFrontmatterBlock(parties[1] ?? ""), stripCaracteres(parties[2] ?? "", "\n", true)];
}
