// SPDX-License-Identifier: MIT
/** apps/toolhost/src/mcp/fs/yaml-py.ts — `yaml.safe_load(_all)` et `yaml.safe_dump` de PyYAML : analyse par le paquet `yaml` (schéma failsafe), types de YAML 1.1 résolus comme PyYAML, émission en style bloc selon les règles de PyYAML ; plafonds d'alias, de profondeur et de nœuds. */
import { FlottantPy } from "@elpis/commun";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import type { Document, Node as NoeudYaml } from "yaml";

/** `yaml.YAMLError` (ou ValueError d'un constructeur) : message de PyYAML, ligne du problème (1…). */
export class ErreurYaml extends Error {
  readonly ligne: number;
  readonly nature: string;

  constructor(message: string, ligne: number, nature = "YAMLError") {
    super(message);
    this.ligne = ligne;
    this.nature = nature;
  }
}

/** Plafonds contre les entrées hostiles (alias en cascade, imbrication, volume). */
export const LIMITES_YAML = { profondeur: 490, noeuds: 1_000_000, alias: 10_000 };

/** `dict` de Python : clés égales au sens de Python confondues, ordre de première insertion. */
export class DictPy {
  readonly entrees = new Map<string, [unknown, unknown]>();
  ensemble = false;

  poser(cle: unknown, valeur: unknown): void {
    const k = cleHash(cle);
    const deja = this.entrees.get(k);
    this.entrees.set(k, [deja ? deja[0] : cle, valeur]);
  }

  get(cle: unknown): unknown {
    return this.entrees.get(cleHash(cle))?.[1];
  }

  has(cle: unknown): boolean {
    return this.entrees.has(cleHash(cle));
  }

  *[Symbol.iterator](): Generator<[unknown, unknown]> {
    yield* this.entrees.values();
  }

  get taille(): number {
    return this.entrees.size;
  }
}

/** `datetime.date` / `datetime.datetime` construits par PyYAML : forme `isoformat` gardée. */
export class DatePy {
  readonly iso: string;
  readonly jour: boolean;

  constructor(iso: string, jour: boolean) {
    this.iso = iso;
    this.jour = jour;
  }

  toString(): string {
    return this.iso;
  }
}

function cleHash(v: unknown): string {
  if (typeof v === "boolean") return `n:${v ? 1 : 0}`;
  if (typeof v === "bigint") return `n:${v}`;
  if (typeof v === "number") return Number.isInteger(v) ? `n:${BigInt(v)}` : `f:${v}`;
  if (v instanceof FlottantPy) return Number.isInteger(v.valeur) ? `n:${BigInt(v.valeur)}` : `f:${v.valeur}`;
  if (v === null) return "z";
  if (typeof v === "string") return `s:${v}`;
  if (v instanceof DatePy) return `d:${v.iso}`;
  if (v instanceof Uint8Array) return `b:${Buffer.from(v).toString("hex")}`;
  throw new ErreurYaml("found unhashable key", 1, "ConstructorError");
}

const BOOL = /^(?:yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$/u;
const FLOAT =
  /^(?:[-+]?(?:[0-9][0-9_]*)\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\.[0-9_]*|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/u;
const INT =
  /^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+)$/u;
const NULL = /^(?:~|null|Null|NULL|)$/u;
const TIMESTAMP =
  /^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9](?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)$/u;
const T = "tag:yaml.org,2002:";

/** Résolveurs implicites de PyYAML (YAML 1.1), choisis par le premier caractère comme `yaml_implicit_resolvers`. */
export function resoudre(valeur: string): string {
  const c = valeur.charAt(0);
  const essais: [string, RegExp, string][] = [
    ["yYnNtTfFoO", BOOL, "bool"],
    ["-+0123456789.", FLOAT, "float"],
    ["-+0123456789", INT, "int"],
    ["<", /^<<$/u, "merge"],
    ["~nN", NULL, "null"],
    ["0123456789", TIMESTAMP, "timestamp"],
    ["=", /^=$/u, "value"],
  ];
  if (valeur === "") return `${T}null`;
  for (const [premiers, re, tag] of essais) if (premiers.includes(c) && re.test(valeur)) return T + tag;
  return `${T}str`;
}

function sexagesimal(v: string): bigint | number {
  let base = 1n;
  let total = 0n;
  for (const p of v.split(":").reverse()) {
    total += BigInt(p) * base;
    base *= 60n;
  }
  return total;
}

function entier(v0: string): bigint {
  let v = v0.replaceAll("_", "");
  let signe = 1n;
  if (v[0] === "-") signe = -1n;
  if ("+-".includes(v[0] ?? "")) v = v.slice(1);
  if (v === "0") return 0n;
  if (v.startsWith("0b")) return signe * BigInt(`0b${v.slice(2)}`);
  if (v.startsWith("0x")) return signe * BigInt(`0x${v.slice(2)}`);
  if (v[0] === "0") return signe * BigInt(`0o${v}`);
  if (v.includes(":")) return signe * (sexagesimal(v) as bigint);
  if (!/^[0-9]+$/u.test(v))
    throw new ErreurYaml(`invalid literal for int() with base 10: '${v0}'`, 1, "ValueError");
  return signe * BigInt(v);
}

function flottant(v0: string): FlottantPy {
  let v = v0.replaceAll("_", "").toLowerCase();
  let signe = 1;
  if (v[0] === "-") signe = -1;
  if ("+-".includes(v[0] ?? "")) v = v.slice(1);
  if (v === ".inf") return new FlottantPy(signe * Infinity);
  if (v === ".nan") return new FlottantPy(NaN);
  if (v.includes(":")) {
    let base = 1;
    let total = 0;
    for (const p of v.split(":").reverse()) {
      total += Number(p) * base;
      base *= 60;
    }
    return new FlottantPy(signe * total);
  }
  const x = Number(v);
  if (Number.isNaN(x)) throw new ErreurYaml(`could not convert string to float: '${v0}'`, 1, "ValueError");
  return new FlottantPy(signe * x);
}

/** Contrôles de `datetime.date` / `datetime.datetime` (ValueError de Python). */
function validerDate(c: readonly (number | undefined)[]): void {
  const [a, mo, j, h, mi, se] = c as [number, number, number, number?, number?, number?];
  const refus = (m: string): never => {
    throw new ErreurYaml(m, 1, "ValueError");
  };
  if (a < 1) refus(`year ${a} is out of range`);
  if (mo < 1 || mo > 12) refus("month must be in 1..12");
  const bis = (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0;
  if (j < 1 || j > ([31, bis ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1] as number))
    refus("day is out of range for month");
  if (h !== undefined && h > 23) refus("hour must be in 0..23");
  if (mi !== undefined && mi > 59) refus("minute must be in 0..59");
  if (se !== undefined && se > 59) refus("second must be in 0..59");
}

function horodatage(v: string): DatePy {
  const m =
    /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:(?:[Tt]|[ \t]+)([0-9]{1,2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]*))?(?:[ \t]*(Z|([-+])([0-9]{1,2})(?::([0-9]{2}))?))?)?$/u.exec(
      v,
    );
  if (m === null) throw new ErreurYaml(`invalid timestamp: '${v}'`, 1, "ValueError");
  const d2 = (s: string | undefined): string => (s ?? "0").padStart(2, "0");
  validerDate(m.slice(1, 7).map((x) => (x === undefined ? undefined : Number(x))));
  const jour = `${m[1]}-${d2(m[2])}-${d2(m[3])}`;
  if (m[4] === undefined) return new DatePy(jour, true);
  let iso = `${jour} ${d2(m[4])}:${m[5]}:${m[6]}`;
  const frac = (m[7] ?? "").slice(0, 6);
  if (frac && Number(frac) !== 0) iso += `.${frac.padEnd(6, "0")}`;
  if (m[8] === "Z") iso += "+00:00";
  else if (m[9]) iso += `${m[9]}${d2(m[10])}:${m[11] ?? "00"}`;
  return new DatePy(iso, false);
}

function bool(v: string): boolean {
  const b = v.toLowerCase();
  if (["yes", "true", "on"].includes(b)) return true;
  if (["no", "false", "off"].includes(b)) return false;
  throw new ErreurYaml(`'${b}'`, 1, "KeyError");
}

/** `Mark.__str__` de PyYAML : position et extrait de la ligne avec le repère `^`. */
export function marque(texte: string, pos: number): string {
  const points = Array.from(texte);
  const unites = texte.slice(0, pos);
  const p = Array.from(unites).length;
  let ligne = 0;
  let col = 0;
  for (let i = 0; i < p; i++) {
    const c = points[i];
    if (
      c === "\n" ||
      ((c === "\r" || c === "\x85" || c === " " || c === " ") && !(c === "\r" && points[i + 1] === "\n"))
    ) {
      ligne++;
      col = 0;
    } else col++;
  }
  const fins = "\0\r\n\x85  ";
  let tete = "";
  let debut = p;
  while (debut > 0 && !fins.includes(points[debut - 1] as string)) {
    debut--;
    if (p - debut > 75 / 2 - 1) {
      tete = " ... ";
      debut += 5;
      break;
    }
  }
  let queue = "";
  let fin = p;
  while (fin < points.length && !fins.includes(points[fin] as string)) {
    fin++;
    if (fin - p > 75 / 2 - 1) {
      queue = " ... ";
      fin -= 5;
      break;
    }
  }
  const extrait = points.slice(debut, fin).join("");
  return `  in "<unicode string>", line ${ligne + 1}, column ${col + 1}:\n    ${tete}${extrait}${queue}\n${" ".repeat(4 + p - debut + tete.length)}^`;
}

function ligneDe(texte: string, pos: number): number {
  let n = 1;
  for (let i = texte.indexOf("\n"); i >= 0 && i < pos; i = texte.indexOf("\n", i + 1)) n++;
  return n;
}

type Paire = [NoeudYaml | null, NoeudYaml | null];

class Constructeur {
  private noeuds = 0;
  private alias = 0;
  private fusionnees = 0;
  private readonly faits = new Map<NoeudYaml, unknown>();
  private readonly cibles = new Map<unknown, NoeudYaml | undefined>();
  private readonly aplaties = new Map<NoeudYaml, Paire[]>();
  private readonly enCours = new Set<NoeudYaml>();

  private readonly texte: string;
  private readonly doc: Document;

  constructor(texte: string, doc: Document) {
    this.texte = texte;
    this.doc = doc;
    this.indexerAlias();
  }

  /** Ancre de chaque alias (posée avant lui dans l'ordre du document ; une ancre en double est refusée), en un seul parcours comme le composeur de PyYAML. */
  private indexerAlias(): void {
    const ancres = new Map<string, NoeudYaml>();
    const pile: unknown[] = [this.doc.contents];
    while (pile.length) {
      const n = pile.pop();
      if (n === null || n === undefined || typeof n !== "object") continue;
      if (isAlias(n)) {
        this.cibles.set(n, ancres.get(n.source));
        continue;
      }
      const ancre = (n as NoeudYaml).anchor;
      if (ancre) {
        const premiere = ancres.get(ancre);
        if (premiere !== undefined) {
          const pos = this.debut(n as NoeudYaml);
          throw new ErreurYaml(
            `found duplicate anchor '${ancre}'; first occurrence\n${marque(this.texte, this.debut(premiere))}\nsecond occurrence\n${marque(this.texte, pos)}`,
            ligneDe(this.texte, pos),
            "ComposerError",
          );
        }
        ancres.set(ancre, n as NoeudYaml);
      }
      if (isMap(n))
        for (let i = n.items.length - 1; i >= 0; i--) {
          const p = n.items[i] as { key: unknown; value: unknown };
          pile.push(p.value, p.key);
        }
      else if (isSeq(n)) for (let i = n.items.length - 1; i >= 0; i--) pile.push(n.items[i]);
    }
  }

  /** Cible d'un alias, compté dans le plafond d'alias. */
  private cible(n: NoeudYaml): NoeudYaml | undefined {
    if (++this.alias > LIMITES_YAML.alias)
      throw new ErreurYaml("too many aliases", ligneDe(this.texte, n.range?.[0] ?? 0));
    return this.cibles.get(n);
  }

  /** `start_mark` de PyYAML : premier attribut du nœud (ancre ou tag) s'il précède la valeur sur sa ligne. */
  private debut(n: NoeudYaml): number {
    let pos = n.range?.[0] ?? 0;
    const ligne = this.texte.lastIndexOf("\n", pos - 1) + 1;
    const avant = this.texte.slice(ligne, pos);
    const tag = n.tag?.startsWith(T) ? `!!${n.tag.slice(T.length)}` : n.tag;
    for (const attribut of [tag, n.anchor ? `&${n.anchor}` : undefined]) {
      if (!attribut) continue;
      const i = avant.lastIndexOf(attribut);
      if (i >= 0 && ligne + i < pos) pos = ligne + i;
    }
    return pos;
  }

  private refus(probleme: string, n: NoeudYaml, contexte?: [string, NoeudYaml]): never {
    const pos = this.debut(n);
    const posContexte = contexte ? this.debut(contexte[1]) : pos;
    const tete = contexte
      ? `${contexte[0]}\n${posContexte === pos ? "" : `${marque(this.texte, posContexte)}\n`}`
      : "";
    throw new ErreurYaml(
      `${tete}${probleme}\n${marque(this.texte, pos)}`,
      ligneDe(this.texte, pos),
      "ConstructorError",
    );
  }

  construire(n: NoeudYaml | null | undefined, profondeur = 0): unknown {
    if (n === null || n === undefined) return null;
    if (profondeur > LIMITES_YAML.profondeur)
      throw new ErreurYaml(
        "maximum recursion depth exceeded",
        ligneDe(this.texte, n.range?.[0] ?? 0),
        "RecursionError",
      );
    if (isAlias(n)) {
      const cible = this.cible(n);
      if (cible === undefined) this.refus(`found undefined alias '${n.source}'`, n);
      return this.construire(cible, profondeur + 1);
    }
    const deja = this.faits.get(n);
    if (deja !== undefined) return deja;
    if (++this.noeuds > LIMITES_YAML.noeuds)
      throw new ErreurYaml("too many nodes", ligneDe(this.texte, n.range?.[0] ?? 0));
    const tag = n.tag;
    if (isScalar(n)) {
      const brut = String(n.value ?? "");
      const plain = n.type === "PLAIN";
      const t =
        tag === undefined || tag === "!" ? (plain && tag === undefined ? resoudre(brut) : `${T}str`) : tag;
      const v = this.scalaire(t, brut, n);
      this.faits.set(n, v);
      return v;
    }
    if (isSeq(n)) {
      if (tag !== undefined && tag !== `${T}seq` && tag !== `${T}omap` && tag !== `${T}pairs`)
        this.refus(`could not determine a constructor for the tag '${tag}'`, n);
      const liste: unknown[] = [];
      this.faits.set(n, liste);
      const paires = tag === `${T}omap` || tag === `${T}pairs`;
      for (const x of n.items) {
        if (!paires) {
          liste.push(this.construire(x as NoeudYaml, profondeur + 1));
          continue;
        }
        const contexte: [string, NoeudYaml] = [
          `while constructing ${tag === `${T}omap` ? "an ordered map" : "pairs"}`,
          n,
        ];
        if (!isMap(x))
          this.refus(
            `expected a mapping of length 1, but found ${isSeq(x) ? "sequence" : "scalar"}`,
            x as NoeudYaml,
            contexte,
          );
        const items = (x as { items: { key: unknown; value: unknown }[] }).items;
        if (items.length !== 1)
          this.refus(
            `expected a single mapping item, but found ${items.length} items`,
            x as NoeudYaml,
            contexte,
          );
        const it = items[0] as { key: unknown; value: unknown };
        liste.push([
          this.construire(it.key as NoeudYaml, profondeur + 2),
          this.construire(it.value as NoeudYaml, profondeur + 2),
        ]);
      }
      return liste;
    }
    if (isMap(n)) {
      if (tag !== undefined && tag !== `${T}map` && tag !== `${T}set`)
        this.refus(`could not determine a constructor for the tag '${tag}'`, n);
      const d = new DictPy();
      d.ensemble = tag === `${T}set`;
      this.faits.set(n, d);
      for (const [k, v] of this.paires(n, profondeur)) {
        const cle = this.construire(k, profondeur + 1);
        if (cle instanceof DictPy || Array.isArray(cle))
          this.refus("found unhashable key", k as NoeudYaml, ["while constructing a mapping", n]);
        d.poser(cle, this.construire(v, profondeur + 1));
      }
      return d;
    }
    return null;
  }

  /** `flatten_mapping` : clés `<<` fusionnées en tête (les plus proches l'emportent), clés propres ensuite ; aplatie une fois par nœud (fusion d'elle-même : ses clés propres), paires et alias plafonnés. */
  private paires(n: NoeudYaml, profondeur: number): Paire[] {
    if (!isMap(n)) return [];
    const deja = this.aplaties.get(n);
    if (deja !== undefined) return deja;
    if (profondeur > LIMITES_YAML.profondeur)
      throw new ErreurYaml(
        "maximum recursion depth exceeded",
        ligneDe(this.texte, n.range?.[0] ?? 0),
        "RecursionError",
      );
    if (this.enCours.has(n))
      return n.items
        .map((p) => [p.key, p.value] as Paire)
        .filter(
          ([k]) =>
            !(k !== null && isScalar(k) && k.type === "PLAIN" && k.tag === undefined && k.value === "<<"),
        );
    this.enCours.add(n);
    const fusion: Paire[] = [];
    const propres: Paire[] = [];
    const ajouter = (ps: readonly Paire[]): void => {
      this.fusionnees += ps.length;
      if (this.fusionnees > LIMITES_YAML.noeuds)
        throw new ErreurYaml("too many merged keys", ligneDe(this.texte, n.range?.[0] ?? 0));
      for (const x of ps) fusion.push(x);
    };
    for (const p of n.items) {
      const k = p.key as NoeudYaml | null;
      const v = p.value as NoeudYaml | null;
      if (k !== null && isScalar(k) && k.type === "PLAIN" && k.tag === undefined && k.value === "<<") {
        const cible = v !== null && isAlias(v) ? this.cible(v) : v;
        if (cible !== undefined && cible !== null && isMap(cible))
          ajouter(this.paires(cible, profondeur + 1));
        else if (cible !== undefined && cible !== null && isSeq(cible)) {
          const sous: Paire[][] = [];
          for (const x of cible.items) {
            const m = isAlias(x) ? this.cible(x as NoeudYaml) : (x as NoeudYaml);
            if (m === undefined || !isMap(m))
              this.refus(
                `expected a mapping for merging, but found ${m && isSeq(m) ? "sequence" : "scalar"}`,
                x as NoeudYaml,
                ["while constructing a mapping", n],
              );
            sous.push(this.paires(m as NoeudYaml, profondeur + 1));
          }
          for (let q = sous.length - 1; q >= 0; q--) ajouter(sous[q] as Paire[]);
        } else
          this.refus(
            `expected a mapping or list of mappings for merging, but found scalar`,
            (v ?? n) as NoeudYaml,
            ["while constructing a mapping", n],
          );
      } else propres.push([k, v]);
    }
    for (const x of propres) fusion.push(x);
    this.enCours.delete(n);
    this.aplaties.set(n, fusion);
    return fusion;
  }

  private scalaire(tag: string, brut: string, n: NoeudYaml): unknown {
    try {
      switch (tag) {
        case `${T}str`:
          return brut;
        case `${T}null`:
          return null;
        case `${T}bool`:
          return bool(brut);
        case `${T}int`:
          return entier(brut);
        case `${T}float`:
          return flottant(brut);
        case `${T}timestamp`:
          return horodatage(brut);
        case `${T}binary`:
          return Buffer.from(brut.replace(/\s+/gu, ""), "base64");
        default:
          return this.refus(`could not determine a constructor for the tag '${tag}'`, n);
      }
    } catch (e) {
      if (e instanceof ErreurYaml && e.nature !== "ConstructorError")
        throw new ErreurYaml(e.message, ligneDe(this.texte, n.range?.[0] ?? 0), e.nature);
      throw e;
    }
  }
}

/** Première erreur d'analyse du paquet `yaml`, à la façon d'une MarkedYAMLError (problème, position, extrait). */
function erreurAnalyse(texte: string, doc: Document): ErreurYaml | null {
  const e = doc.errors[0];
  if (e === undefined) return null;
  const premiere = (e.message.split("\n")[0] ?? "").replace(/ at line \d+, column \d+:?$/u, "");
  const pos = e.pos[0];
  return new ErreurYaml(`${premiere}\n${marque(texte, pos)}`, ligneDe(texte, pos), e.code);
}

/** Profondeur d'imbrication majorée (crochets et accolades, indentation, tirets en tête de ligne). */
function profondeurMajoree(texte: string): number {
  let flux = 0;
  let fluxMax = 0;
  for (let i = 0; i < texte.length; i++) {
    const c = texte.charCodeAt(i);
    if (c === 0x5b || c === 0x7b) fluxMax = Math.max(fluxMax, ++flux);
    else if ((c === 0x5d || c === 0x7d) && flux > 0) flux--;
  }
  const pile: number[] = [];
  let bloc = 0;
  for (let debut = 0; debut <= texte.length;) {
    let fin = texte.indexOf("\n", debut);
    if (fin < 0) fin = texte.length;
    let r = debut;
    while (r < fin && texte.charCodeAt(r) === 0x20) r++;
    if (r < fin && texte[r] !== "#" && texte[r] !== "\r") {
      while (pile.length && (pile[pile.length - 1] as number) >= r - debut) pile.pop();
      pile.push(r - debut);
      let tirets = 0;
      while (texte[r] === "-" && (r + 1 === fin || texte[r + 1] === " ")) {
        tirets++;
        r += 1;
        while (r < fin && texte.charCodeAt(r) === 0x20) r++;
      }
      bloc = Math.max(bloc, pile.length + tirets);
    }
    debut = fin + 1;
  }
  return fluxMax + bloc;
}

function documents(texte: string): Document[] {
  if (profondeurMajoree(texte) > LIMITES_YAML.profondeur)
    throw new ErreurYaml("maximum recursion depth exceeded", 1, "RecursionError");
  return parseAllDocuments(texte, {
    version: "1.1",
    schema: "failsafe",
    uniqueKeys: false,
    strict: false,
    prettyErrors: true,
  }) as unknown as Document[];
}

/** `yaml.safe_load_all(texte)` (liste des documents). */
export function chargerTout(texte: string): unknown[] {
  const docs = documents(texte);
  for (const d of docs) {
    const e = erreurAnalyse(texte, d);
    if (e !== null) throw e;
  }
  return docs.map((d) => new Constructeur(texte, d).construire(d.contents as NoeudYaml | null));
}

/** `yaml.safe_load(texte)` : un seul document, sinon l'erreur du composeur de PyYAML. */
export function charger(texte: string): unknown {
  const docs = documents(texte);
  for (const d of docs) {
    const e = erreurAnalyse(texte, d);
    if (e !== null) throw e;
  }
  if (docs.length > 1) {
    const a = (docs[0]?.contents as NoeudYaml | null | undefined)?.range?.[0] ?? docs[0]?.range?.[0] ?? 0;
    const b = docs[1]?.range?.[0] ?? 0;
    throw new ErreurYaml(
      `expected a single document in the stream\n${marque(texte, a)}\nbut found another document\n${marque(texte, b)}`,
      ligneDe(texte, b),
      "ComposerError",
    );
  }
  const d = docs[0];
  return d === undefined ? null : new Constructeur(texte, d).construire(d.contents as NoeudYaml | null);
}

export { emettre as dumpPy } from "./yaml-emission";
