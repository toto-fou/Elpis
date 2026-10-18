// SPDX-License-Identifier: MIT
/** apps/toolhost/src/office/xml.ts — analyseur XML en flux, sûr (aucune DTD), arbre comme `xml.etree.ElementTree` (expat) : `{uri}nom`, `text`/`tail`, fins de ligne et attributs normalisés. */

/** `ET.ParseError`. */
export class ErreurXml extends Error {
  override name = "ParseError";
}

/** `Element` d'ElementTree (attributs dans l'ordre du document). */
export interface ElementXml {
  tag: string;
  attrib: Map<string, string>;
  text: string | null;
  tail: string | null;
  children: ElementXml[];
}

const XML_NS = "http://www.w3.org/XML/1998/namespace";
const DEBUT_NOM =
  ":A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF\\u200C-\\u200D" +
  "\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const SUITE_NOM = `\\u0300-\\u036F${DEBUT_NOM}\\-.0-9\\u00B7\\u203F-\\u2040`;
const NOM = new RegExp(`[${DEBUT_NOM}][${SUITE_NOM}]*`, "uy");
const BLANCS = /[ \t\n]*/y;
const INVALIDES = /[^\P{Cc}\t\n\r\x7F-\x9F]|[\uFFFE\uFFFF]/u;
const REF = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([^;&<\s]*));/gu;
const PREDEFINIES: Readonly<Record<string, string>> = { lt: "<", gt: ">", amp: "&", apos: "'", quot: '"' };

/** `Element.iter()` : l'élément puis ses descendants, dans l'ordre du document (`tag` : ceux-là seulement). */
export function* parcourir(el: ElementXml, tag?: string): Generator<ElementXml> {
  const pile: ElementXml[] = [el];
  for (let e = pile.pop(); e !== undefined; e = pile.pop()) {
    if (tag === undefined || e.tag === tag) yield e;
    for (let i = e.children.length - 1; i >= 0; i--) pile.push(e.children[i] as ElementXml);
  }
}

/** Nom local d'une balise (`_nom` : `{uri}` retiré). */
export function nomLocal(tag: string): string {
  const i = tag.lastIndexOf("}");
  return i < 0 ? tag : tag.slice(i + 1);
}

function codeValide(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

/** Références de caractères et entités prédéfinies résolues ; toute autre entité est refusée (pas de DTD). */
function resoudre(brut: string): string {
  if (!brut.includes("&")) return brut;
  let fin = 0;
  let sortie = "";
  REF.lastIndex = 0;
  for (let m = REF.exec(brut); m !== null; m = REF.exec(brut)) {
    if (m.index !== fin && brut.slice(fin, m.index).includes("&"))
      throw new ErreurXml("not well-formed (invalid token)");
    sortie += brut.slice(fin, m.index);
    if (m[3] !== undefined) {
      const v = PREDEFINIES[m[3]];
      if (v === undefined) throw new ErreurXml("undefined entity");
      sortie += v;
    } else {
      const cp = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2] ?? "", 10);
      if (!Number.isFinite(cp) || !codeValide(cp))
        throw new ErreurXml("reference to invalid character number");
      sortie += String.fromCodePoint(cp);
    }
    fin = REF.lastIndex;
  }
  if (brut.slice(fin).includes("&")) throw new ErreurXml("not well-formed (invalid token)");
  return sortie + brut.slice(fin);
}

type Encodage = "utf-8" | "utf-16le" | "utf-16be" | "latin1" | "ascii" | string;

const UN_OCTET = new Set([
  "ibm866",
  "iso-8859-2",
  "iso-8859-3",
  "iso-8859-4",
  "iso-8859-5",
  "iso-8859-6",
  "iso-8859-7",
  "iso-8859-8",
  "iso-8859-10",
  "iso-8859-13",
  "iso-8859-14",
  "iso-8859-15",
  "iso-8859-16",
  "koi8-r",
  "koi8-u",
  "macintosh",
  "windows-874",
  "windows-1250",
  "windows-1251",
  "windows-1252",
  "windows-1253",
  "windows-1254",
  "windows-1255",
  "windows-1256",
  "windows-1257",
  "windows-1258",
  "x-mac-cyrillic",
]);

function encodageDeclare(etiquette: string): Encodage {
  const e = etiquette.toLowerCase();
  if (e === "utf-8" || e === "utf8") return "utf-8";
  if (e === "iso-8859-1" || e === "latin1" || e === "latin-1" || e === "iso8859-1") return "latin1";
  if (e === "us-ascii" || e === "ascii") return "ascii";
  if (e === "utf-16") return "utf-16le";
  try {
    const d = new TextDecoder(e);
    if (UN_OCTET.has(d.encoding)) return d.encoding;
  } catch {
    // étiquette inconnue
  }
  throw new ErreurXml(`unknown encoding: ${etiquette}`);
}

/** Longueur du plus long préfixe d'UTF-8 valide dont la fin peut être une séquence incomplète (`complet` : jamais). */
function prefixeUtf8(b: Uint8Array, complet: boolean): { valide: number; incomplet: number } {
  let i = 0;
  while (i < b.length) {
    const o = b[i] as number;
    if (o < 0x80) {
      i++;
      continue;
    }
    let n: number;
    let min: number;
    if (o >= 0xc2 && o <= 0xdf) [n, min] = [1, 0x80];
    else if (o >= 0xe0 && o <= 0xef) [n, min] = [2, 0x800];
    else if (o >= 0xf0 && o <= 0xf4) [n, min] = [3, 0x10000];
    else return { valide: i, incomplet: 0 };
    let cp = o & (0x3f >> n);
    let j = 1;
    for (; j <= n && i + j < b.length; j++) {
      const s = b[i + j] as number;
      if ((s & 0xc0) !== 0x80) return { valide: i, incomplet: 0 };
      cp = (cp << 6) | (s & 0x3f);
      if (
        j === 1 &&
        ((o === 0xe0 && s < 0xa0) ||
          (o === 0xed && s > 0x9f) ||
          (o === 0xf0 && s < 0x90) ||
          (o === 0xf4 && s > 0x8f))
      )
        return { valide: i, incomplet: 0 };
    }
    if (j <= n) return complet ? { valide: i, incomplet: 0 } : { valide: i, incomplet: b.length - i };
    if (cp < min) return { valide: i, incomplet: 0 };
    i += n + 1;
  }
  return { valide: i, incomplet: 0 };
}

/** Décodage en flux des octets du document (BOM, déclaration, ou UTF-8) ; un octet invalide : texte valide d'abord, puis erreur. */
class Decodeur {
  private encodage: Encodage | null = null;
  private attente: Buffer = Buffer.alloc(0);
  private utf16: Decodage | null = null;
  private simple: Decodage | null = null;
  private bomVu = false;

  /** `[texte, erreur]` : le texte décodable, puis l'erreur à lever une fois ce texte analysé. */
  decoder(octets: Buffer, final: boolean): [string, ErreurXml | null] {
    this.attente = this.attente.length ? Buffer.concat([this.attente, octets]) : octets;
    if (this.encodage === null) {
      const choix = this.choisir(final);
      if (choix === null) return ["", null];
      this.encodage = choix;
    }
    const b = this.attente;
    this.attente = Buffer.alloc(0);
    switch (this.encodage) {
      case "utf-8": {
        let debut = 0;
        if (!this.bomVu) {
          this.bomVu = true;
          if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) debut = 3;
        }
        const corps = b.subarray(debut);
        const { valide, incomplet } = prefixeUtf8(corps, final);
        const texte = corps.subarray(0, valide).toString("utf8");
        if (valide + incomplet < corps.length)
          return [texte, new ErreurXml("not well-formed (invalid token)")];
        this.attente = Buffer.from(corps.subarray(valide));
        return [texte, null];
      }
      case "latin1":
        return [b.toString("latin1"), null];
      case "ascii": {
        const i = b.findIndex((o) => o > 0x7f);
        if (i >= 0)
          return [b.subarray(0, i).toString("latin1"), new ErreurXml("not well-formed (invalid token)")];
        return [b.toString("latin1"), null];
      }
      case "utf-16le":
      case "utf-16be": {
        this.utf16 ??= new TextDecoder(this.encodage, { fatal: true });
        try {
          return [this.utf16.decode(b, { stream: !final }), null];
        } catch {
          return ["", new ErreurXml("not well-formed (invalid token)")];
        }
      }
      default: {
        this.simple ??= new TextDecoder(this.encodage, { fatal: true });
        try {
          return [this.simple.decode(b, { stream: !final }), null];
        } catch {
          return ["", new ErreurXml("not well-formed (invalid token)")];
        }
      }
    }
  }

  /** Encodage d'après le début du document ; `null` : attendre davantage d'octets. */
  private choisir(final: boolean): Encodage | null {
    const b = this.attente;
    if (b.length < 4 && !final) return null;
    if (b[0] === 0xff && b[1] === 0xfe) {
      this.attente = b.subarray(2);
      return "utf-16le";
    }
    if (b[0] === 0xfe && b[1] === 0xff) {
      this.attente = b.subarray(2);
      return "utf-16be";
    }
    if (b[0] === 0x3c && b[1] === 0x00 && b[2] === 0x3f && b[3] === 0x00) return "utf-16le";
    if (b[0] === 0x00 && b[1] === 0x3c && b[2] === 0x00 && b[3] === 0x3f) return "utf-16be";
    if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return "utf-8";
    if (b.subarray(0, 5).toString("latin1") !== "<?xml") return "utf-8";
    const fin = b.indexOf("?>");
    if (fin < 0) return final || b.length > 1024 ? "utf-8" : null;
    const decl = b.subarray(0, fin).toString("latin1");
    const m = /\sencoding\s*=\s*(?:"([^"]*)"|'([^']*)')/u.exec(decl);
    return m ? encodageDeclare(m[1] ?? m[2] ?? "") : "utf-8";
  }
}

interface Decodage {
  decode(b: Uint8Array, o?: { stream?: boolean }): string;
}

interface Portee {
  readonly prefixes: Map<string, string>;
}

/** Jeton inachevé en fin de tampon : vrai si le morceau suivant peut le terminer (chaque caractère n'est lu qu'une fois). */
type Veille = (morceau: string) => boolean;

const TOUJOURS: Veille = () => true;

/** Veille d'une séquence de fin (`?>`, `--`, `]]>`), à cheval sur deux morceaux comprise. */
function veilleSequence(seq: string, tampon: string): Veille {
  let queue = tampon.slice(-(seq.length - 1));
  return (m) => {
    const t = queue + m;
    queue = t.slice(-(seq.length - 1));
    return t.includes(seq);
  };
}

/** Analyseur poussé : `nourrir(octets)` puis `terminer()` ; `surFin(el)` à chaque fin d'élément (vrai : l'élément est retiré de son parent, comme après `clear()`). */
export class AnalyseurXml {
  private readonly decodeur = new Decodeur();
  private tampon = "";
  private pos = 0;
  private cr = false;
  private recherche = 0;
  private pile: ElementXml[] = [];
  private noms: string[] = [];
  private portees: Portee[] = [{ prefixes: new Map([["xml", XML_NS]]) }];
  private donnees: string[] = [];
  private dernier: ElementXml | null = null;
  private racine: ElementXml | null = null;
  private fini = false;
  private debut = true;
  private erreur: ErreurXml | null = null;
  private veille: Veille | null = null;
  private morceaux: string[] = [];
  private guillemetFin = 0;
  private readonly surFin: ((el: ElementXml) => boolean | void) | undefined;

  constructor(surFin?: (el: ElementXml) => boolean | void) {
    this.surFin = surFin;
  }

  nourrir(octets: Buffer): void {
    if (this.erreur) throw this.erreur;
    this.analyserOctets(octets, false);
  }

  /** Fin du document : racine rendue (`no element found` sans racine fermée). */
  terminer(): ElementXml {
    if (this.erreur) throw this.erreur;
    this.analyserOctets(Buffer.alloc(0), true);
    if (this.racine === null || !this.fini) throw this.echec("no element found");
    return this.racine;
  }

  private echec(message: string): ErreurXml {
    this.erreur = new ErreurXml(message);
    return this.erreur;
  }

  private analyserOctets(octets: Buffer, final: boolean): void {
    let texte: string;
    let erreur: ErreurXml | null;
    try {
      [texte, erreur] = this.decodeur.decoder(octets, final);
    } catch (e) {
      throw this.echec(e instanceof Error ? e.message : String(e));
    }
    if (this.cr) texte = "\r" + texte;
    this.cr = !final && !erreur && texte.endsWith("\r");
    if (this.cr) texte = texte.slice(0, -1);
    const morceau = texte.replace(/\r\n?/gu, "\n");
    if (this.veille !== null) {
      this.morceaux.push(morceau);
      if (!final && erreur === null && !this.veille(morceau)) return;
      this.veille = null;
      this.tampon += this.morceaux.join("");
      this.morceaux = [];
    } else this.tampon += morceau;
    try {
      this.analyser(final && erreur === null);
    } catch (e) {
      if (e instanceof ErreurXml) this.erreur = e;
      throw e;
    }
    if (erreur) throw this.echec(erreur.message);
    if (this.pos > 65536) {
      this.tampon = this.tampon.slice(this.pos);
      this.recherche = Math.max(0, this.recherche - this.pos);
      this.pos = 0;
    }
  }

  private vider(): void {
    if (!this.donnees.length) return;
    const t = this.donnees.join("");
    this.donnees = [];
    if (this.dernier === null) return;
    if (this.pile.length && this.pile[this.pile.length - 1] === this.dernier) this.dernier.text = t;
    else this.dernier.tail = t;
  }

  private texte(brut: string): void {
    if (!brut) return;
    if (this.pile.length === 0) {
      if (/[^ \t\n]/u.test(brut))
        throw new ErreurXml(this.fini ? "junk after document element" : "syntax error");
      return;
    }
    if (INVALIDES.test(brut) || brut.includes("]]>")) throw new ErreurXml("not well-formed (invalid token)");
    this.donnees.push(resoudre(brut));
  }

  private analyser(final: boolean): void {
    const s = this.tampon;
    for (;;) {
      if (this.pos >= s.length) return;
      const lt = s.indexOf("<", Math.max(this.pos, this.recherche));
      if (lt < 0) {
        if (!final) {
          this.recherche = s.length;
          this.veille = (m) => m.includes("<");
          return;
        }
        this.texte(s.slice(this.pos));
        this.pos = s.length;
        if (this.pile.length) throw new ErreurXml("no element found");
        return;
      }
      if (lt > this.pos) {
        this.texte(s.slice(this.pos, lt));
        this.debut = false;
        this.pos = lt;
      }
      this.recherche = this.pos;
      const avance = this.balise(s, final);
      if (!avance) return;
    }
  }

  /** Une balise à `pos` ; faux s'il faut plus de données. */
  private balise(s: string, final: boolean): boolean {
    const p = this.pos;
    const incomplet = (veille: Veille): boolean => {
      if (final) throw new ErreurXml("unclosed token");
      this.veille = veille;
      return false;
    };
    if (s.length < p + 2) return incomplet(TOUJOURS);
    const c = s.charAt(p + 1);
    if (c === "?") {
      const fin = s.indexOf("?>", p + 2);
      if (fin < 0) return incomplet(veilleSequence("?>", s));
      const contenu = s.slice(p + 2, fin);
      const cible = /^[^ \t\n]*/u.exec(contenu)?.[0] ?? "";
      if (cible.toLowerCase() === "xml") {
        if (cible !== "xml" || p !== 0 || !this.debut)
          throw new ErreurXml("XML or text declaration not at start of entity");
      } else if (!new RegExp(`^${NOM.source}$`, "u").test(cible))
        throw new ErreurXml("not well-formed (invalid token)");
      this.pos = fin + 2;
      this.debut = false;
      return true;
    }
    if (c === "!") {
      if (
        s.length < p + 9 &&
        !final &&
        ("<!--".startsWith(s.slice(p, p + 4)) || "<![CDATA[".startsWith(s.slice(p, p + 9)))
      )
        return incomplet(TOUJOURS);
      if (s.startsWith("<!--", p)) {
        const fin = s.indexOf("--", p + 4);
        if (fin < 0) return incomplet(veilleSequence("--", s));
        if (s.charAt(fin + 2) === "") return incomplet(TOUJOURS);
        if (s.charAt(fin + 2) !== ">") throw new ErreurXml("not well-formed (invalid token)");
        if (INVALIDES.test(s.slice(p + 4, fin))) throw new ErreurXml("not well-formed (invalid token)");
        this.pos = fin + 3;
        this.debut = false;
        return true;
      }
      if (s.startsWith("<![CDATA[", p)) {
        if (!this.pile.length) throw new ErreurXml("not well-formed (invalid token)");
        const fin = s.indexOf("]]>", p + 9);
        if (fin < 0) return incomplet(veilleSequence("]]>", s));
        const contenu = s.slice(p + 9, fin);
        if (INVALIDES.test(contenu)) throw new ErreurXml("not well-formed (invalid token)");
        if (contenu) this.donnees.push(contenu);
        this.pos = fin + 3;
        return true;
      }
      if (s.startsWith("<!DOCTYPE", p) || (!final && "<!DOCTYPE".startsWith(s.slice(p))))
        throw new ErreurXml("DOCTYPE refusé (aucune DTD n'est lue)");
      throw new ErreurXml("not well-formed (invalid token)");
    }
    const fin = this.finDeBalise(s, p + 1);
    if (fin < 0) return incomplet(this.veilleBalise());
    if (c === "/") this.fermer(s.slice(p + 2, fin));
    else this.ouvrir(s.slice(p + 1, fin));
    this.pos = fin + 1;
    this.debut = false;
    return true;
  }

  /** Position du `>` qui ferme la balise (guillemets respectés), -1 s'il manque (guillemet ouvert gardé pour la veille). */
  private finDeBalise(s: string, depuis: number): number {
    let guillemet = 0;
    for (let i = depuis; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (guillemet) {
        if (c === guillemet) guillemet = 0;
        else if (c === 0x3c) throw new ErreurXml("not well-formed (invalid token)");
      } else if (c === 0x22 || c === 0x27) guillemet = c;
      else if (c === 0x3e) return i;
      else if (c === 0x3c) throw new ErreurXml("not well-formed (invalid token)");
    }
    this.guillemetFin = guillemet;
    return -1;
  }

  /** Veille d'une balise ouverte : un `>` hors guillemets (ou un `<`, que l'analyse refusera). */
  private veilleBalise(): Veille {
    let guillemet = this.guillemetFin;
    return (m) => {
      for (let i = 0; i < m.length; i++) {
        const c = m.charCodeAt(i);
        if (c === 0x3c) return true;
        if (guillemet) {
          if (c === guillemet) guillemet = 0;
        } else if (c === 0x22 || c === 0x27) guillemet = c;
        else if (c === 0x3e) return true;
      }
      return false;
    };
  }

  private nom(s: string, i: number): string {
    NOM.lastIndex = i;
    const m = NOM.exec(s);
    if (!m) throw new ErreurXml("not well-formed (invalid token)");
    return m[0];
  }

  private resoudreNom(qnom: string, portee: Map<string, string>, element: boolean): string {
    const deux = qnom.indexOf(":");
    if (deux < 0) {
      if (!element) return qnom;
      const defaut = portee.get("");
      return defaut ? `{${defaut}}${qnom}` : qnom;
    }
    const prefixe = qnom.slice(0, deux);
    const local = qnom.slice(deux + 1);
    if (!local || local.includes(":") || !prefixe) throw new ErreurXml("not well-formed (invalid token)");
    const uri = portee.get(prefixe);
    if (uri === undefined) throw new ErreurXml("unbound prefix");
    return `{${uri}}${local}`;
  }

  private ouvrir(contenu: string): void {
    if (this.fini) throw new ErreurXml("junk after document element");
    let vide = false;
    let corps = contenu;
    if (corps.endsWith("/")) {
      vide = true;
      corps = corps.slice(0, -1);
    }
    const qnom = this.nom(corps, 0);
    let i = qnom.length;
    const bruts: [string, string][] = [];
    for (;;) {
      BLANCS.lastIndex = i;
      BLANCS.exec(corps);
      const avant = i;
      i = BLANCS.lastIndex;
      if (i >= corps.length) break;
      if (i === avant) throw new ErreurXml("not well-formed (invalid token)");
      const nomAttr = this.nom(corps, i);
      i += nomAttr.length;
      BLANCS.lastIndex = i;
      BLANCS.exec(corps);
      i = BLANCS.lastIndex;
      if (corps.charAt(i) !== "=") throw new ErreurXml("not well-formed (invalid token)");
      BLANCS.lastIndex = i + 1;
      BLANCS.exec(corps);
      i = BLANCS.lastIndex;
      const q = corps.charAt(i);
      if (q !== '"' && q !== "'") throw new ErreurXml("not well-formed (invalid token)");
      const fin = corps.indexOf(q, i + 1);
      if (fin < 0) throw new ErreurXml("not well-formed (invalid token)");
      const valeur = corps.slice(i + 1, fin);
      if (INVALIDES.test(valeur)) throw new ErreurXml("not well-formed (invalid token)");
      if (bruts.some(([n]) => n === nomAttr)) throw new ErreurXml("duplicate attribute");
      bruts.push([nomAttr, resoudre(valeur.replace(/[\t\n]/gu, " "))]);
      i = fin + 1;
    }
    const parent = this.portees[this.portees.length - 1] as Portee;
    let prefixes = parent.prefixes;
    for (const [n, v] of bruts) {
      if (n === "xmlns") {
        if (prefixes === parent.prefixes) prefixes = new Map(parent.prefixes);
        if (v) prefixes.set("", v);
        else prefixes.delete("");
      } else if (n.startsWith("xmlns:")) {
        const pre = n.slice(6);
        if (pre === "xmlns" || !v) throw new ErreurXml("unbound prefix");
        if (prefixes === parent.prefixes) prefixes = new Map(parent.prefixes);
        prefixes.set(pre, v);
      }
    }
    const attrib = new Map<string, string>();
    for (const [n, v] of bruts) {
      if (n === "xmlns" || n.startsWith("xmlns:")) continue;
      const cle = this.resoudreNom(n, prefixes, false);
      if (attrib.has(cle)) throw new ErreurXml("duplicate attribute");
      attrib.set(cle, v);
    }
    const el: ElementXml = {
      tag: this.resoudreNom(qnom, prefixes, true),
      attrib,
      text: null,
      tail: null,
      children: [],
    };
    this.vider();
    const pere = this.pile[this.pile.length - 1];
    if (pere) pere.children.push(el);
    else this.racine = el;
    this.pile.push(el);
    this.noms.push(qnom);
    this.portees.push({ prefixes });
    this.dernier = el;
    if (vide) this.clore(el);
  }

  private fermer(contenu: string): void {
    const qnom = this.nom(contenu, 0);
    if (contenu.slice(qnom.length).replace(/[ \t\n]+$/u, "") !== "")
      throw new ErreurXml("not well-formed (invalid token)");
    const el = this.pile[this.pile.length - 1];
    if (!el || this.noms[this.noms.length - 1] !== qnom) throw new ErreurXml("mismatched tag");
    this.clore(el);
  }

  private clore(el: ElementXml): void {
    this.vider();
    this.pile.pop();
    this.noms.pop();
    this.portees.pop();
    this.dernier = el;
    if (this.pile.length === 0) this.fini = true;
    if (this.surFin?.(el) === true) {
      const pere = this.pile[this.pile.length - 1];
      if (pere && pere.children[pere.children.length - 1] === el) pere.children.pop();
    }
  }
}

/** `ET.parse(octets).getroot()`. */
export function analyserTout(octets: Buffer): ElementXml {
  const a = new AnalyseurXml();
  a.nourrir(octets);
  return a.terminer();
}
