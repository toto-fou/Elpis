// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/rendu/flux-blocs.ts — découpe du texte d'un flux en blocs figés par le lexer de marked : mêmes blocs que le rendu complet, liens de référence partagés, reprise d'un texte final qui diffère du texte diffusé. */

export type Liens = Record<string, { href: string; title?: string | undefined }>;

export interface JetonMarked {
  type: string;
  raw: string;
}

/** Sous-ensemble du `Lexer` de marked utilisé : la table des liens est posée avant l'analyse et partagée entre les appels. */
export interface LexeurMarked {
  tokens: { links: Liens };
  lex(src: string): JetonMarked[];
}

export interface BlocFlux {
  i: number;
  html: string;
  /** Texte source du bloc, jusqu'au début du bloc suivant ; copie autonome, qui ne retient pas le texte du battement. */
  src: string;
  /** Décalage du premier caractère du bloc suivant. */
  fin: number;
  /** Décalage jusqu'où le texte décide du bloc : les deux premières lignes du bloc suivant ; infini pour le dernier bloc d'un texte terminé. */
  lim: number;
}

/** État de découpe d'un texte : blocs figés, décalage du premier caractère non figé, liens de référence vus, taille de la région analysée, textes (préparé, puis tel que reçu) sur lesquels il repose. */
export interface EtatFlux {
  blocs: readonly BlocFlux[];
  pos: number;
  liens: Liens;
  lexe: number;
  /** Fin des lignes complètes déjà analysées depuis `pos` sans qu'un bloc se fige : sans ligne de plus, l'analyse ne change pas. */
  horizon: number;
  /** Début de la première ligne pas encore lue de la fence ouverte en `pos` (0 : depuis son ouverture). */
  fenceVue: number;
  /** Texte terminé : son dernier bloc a été figé sans savoir ce qui suit, un texte plus long le redécoupe. */
  fini: boolean;
  texte: string;
  source: string;
}

export interface DependancesFlux {
  nouveauLexeur(): LexeurMarked;
  /** Rendu complet d'une suite de jetons : parseur, purification et habillage du code. */
  rendre(jetons: readonly JetonMarked[]): string;
  lireCache(cle: string): string | undefined;
  ecrireCache(cle: string, html: string): void;
}

export interface Avancee {
  etat: EtatFlux;
  /** Texte du bloc actif : du dernier jeton non figé à la fin du texte, ligne inachevée comprise. */
  actif: string;
}

const TOURS_MAX = 500;
const ANALYSE_MAX = 36000;
const CROISSANCE_ANALYSE = 1.2;
const GROUPE_HTML_MAX = 8000;
const OUVRANT_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const BALISE_HTML = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w:-]*)(?:"[^"]*"|'[^']*'|[^'">])*?(\/?)>/g;
const BALISES_VIDES = new Set(
  "area base br col embed hr img input link meta param source track wbr".split(" "),
);
const FIN_OPTIONNELLE = new Set(
  "p li dt dd tr td th thead tbody tfoot option optgroup colgroup caption rt rp".split(" "),
);
const DEF_LIGNE = /^ {0,3}\[((?!\s*\])(?:\\.|[^[\]\\])+)\]:/;
const DEF_SANS_ADRESSE = /^ {0,3}\[((?!\s*\])(?:\\.|[^[\]\\])+)\]:[ \t]*\n?$/;
// Lignes qui arrêtent le contenu d'un titre souligné (`lheading` de marked, version GFM).
const COUPE_TITRE =
  /^(?:[ \t]*$|(?:[*+-]|\d{1,9}[.)]) | {4}| {0,3}\t| {0,3}(?:`{3,}|~{3,})| {0,3}>| {0,3}#{1,6}| {0,3}<[^\n>]+>$| {0,3}\|?(?:[:\- ]*\|)+[:\- ]*$)/;
const AUCUN: ReadonlySet<string> = new Set();

/** Texte tel que le rendu complet le lit : sauts de ligne normalisés, blancs de tête retirés (stable d'un appel à l'autre pendant le flux). */
export function preparerTexte(texte: string): string {
  const s = texte.indexOf("\r") === -1 ? texte : texte.replace(/\r\n?/g, "\n");
  return s.replace(/^\s+/, "");
}

/** Copie autonome d'une chaîne : une sous-chaîne garde en vie le texte entier dont elle est tirée. */
export function copie(s: string): string {
  return (" " + s).slice(1);
}

export function etatVide(): EtatFlux {
  return {
    blocs: [],
    pos: 0,
    liens: Object.create(null) as Liens,
    lexe: 0,
    horizon: 0,
    fenceVue: 0,
    fini: false,
    texte: "",
    source: "",
  };
}

function nbLiens(liens: Liens): number {
  let n = 0;
  for (const _ in liens) n++;
  return n;
}

function copieLiens(liens: Liens): Liens {
  return Object.assign(Object.create(null) as Liens, liens);
}

/** Étiquette d'un lien de référence telle que marked la range dans sa table. */
function etiquette(brute: string): string {
  return brute.toLowerCase().replace(/\s+/g, " ");
}

/** Étiquettes dont la définition diffère d'une table à l'autre (ajoutée, retirée ou changée). */
function etiquettesChangees(a: Liens, b: Liens): string[] {
  const changees: string[] = [];
  for (const k in a) if (b[k]?.href !== a[k]?.href || b[k]?.title !== a[k]?.title) changees.push(k);
  for (const k in b) if (!(k in a)) changees.push(k);
  return changees;
}

/** Vrai si la source peut citer l'une des étiquettes (`[etiquette]`, casse et blancs normalisés comme marked). */
function cite(src: string, etiquettes: readonly string[]): boolean {
  if (!etiquettes.length || !src.includes("[")) return false;
  const s = src.toLowerCase().replace(/\s+/g, " ");
  return etiquettes.some((e) => s.includes("[" + e + "]"));
}

function blanche(t: string, a: number, b: number): boolean {
  for (let i = a; i < b; i++) {
    const c = t.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Premier décalage après `p` qui n'est pas au début d'une ligne blanche complète. */
function sauterBlanches(t: string, p: number): number {
  while (p < t.length) {
    const nl = t.indexOf("\n", p);
    if (nl === -1 || !blanche(t, p, nl)) return p;
    p = nl + 1;
  }
  return p;
}

function estFermeture(t: string, a: number, b: number, car: string, n: number): boolean {
  let i = a;
  while (i < b && i - a < 3 && t.charCodeAt(i) === 32) i++;
  const debut = i;
  while (i < b && t[i] === car) i++;
  return i - debut >= n && blanche(t, i, b);
}

interface Fence {
  fermee: boolean;
  /** Décalage du saut de ligne qui termine la ligne de fermeture. */
  fin: number;
  /** Début de la première ligne pas encore lue jusqu'au bout. */
  vu: number;
}

/** Fence qui ouvre le texte restant (lignes blanches mises à part) : fermée par une ligne complète, ou encore ouverte ; `null` sinon. La fermeture est cherchée à partir de `depuis`. */
export function lireFence(t: string, pos: number, depuis = 0): Fence | null {
  let i = pos;
  while (i < t.length) {
    const nl = t.indexOf("\n", i);
    if (!blanche(t, i, nl === -1 ? t.length : nl)) break;
    if (nl === -1) return null;
    i = nl + 1;
  }
  if (i >= t.length) return null;
  const nl1 = t.indexOf("\n", i);
  const ouvrante = t.slice(i, nl1 === -1 ? t.length : nl1);
  const m = OUVRANT_FENCE.exec(ouvrante);
  if (!m) return null;
  const marque = m[1] ?? "";
  const car = marque.charAt(0);
  if (car === "`" && ouvrante.indexOf("`", m[0].length) !== -1) return null;
  let j = nl1 === -1 ? -1 : Math.max(nl1 + 1, depuis);
  while (j !== -1 && j < t.length) {
    const nl = t.indexOf("\n", j);
    if (nl === -1) break;
    if (estFermeture(t, j, nl, car, marque.length)) return { fermee: true, fin: nl, vu: j };
    j = nl + 1;
  }
  return { fermee: false, fin: -1, vu: j === -1 ? 0 : j };
}

/** Met à jour la pile des éléments HTML restés ouverts après un bloc HTML de premier niveau (balises vides, à fin facultative et commentaires exclus ; une fermeture sans ouverture est ignorée). */
function empilerHtml(raw: string, pile: string[]): void {
  BALISE_HTML.lastIndex = 0;
  for (let m = BALISE_HTML.exec(raw); m; m = BALISE_HTML.exec(raw)) {
    const nom = (m[2] ?? "").toLowerCase();
    if (!nom || BALISES_VIDES.has(nom) || FIN_OPTIONNELLE.has(nom) || m[3] === "/") continue;
    if (!m[1]) pile.push(nom);
    else {
      const k = pile.lastIndexOf(nom);
      if (k !== -1) pile.length = k;
    }
  }
}

interface Groupe {
  debut: number;
  /** Fin du dernier jeton non blanc du groupe. */
  fin: number;
  jetons: JetonMarked[];
  longueur: number;
}

/** Jetons regroupés en blocs : un bloc HTML qui laisse un élément ouvert garde avec lui les jetons jusqu'à sa fermeture, comme le rendu complet. */
function grouper(jetons: readonly JetonMarked[], departs: readonly number[]): Groupe[] {
  const groupes: Groupe[] = [];
  let ouvert: Groupe | null = null;
  let pile: string[] = [];
  for (let k = 0; k < jetons.length; k++) {
    const j = jetons[k];
    if (!j) continue;
    if (j.type === "space") {
      ouvert?.jetons.push(j);
      continue;
    }
    if (!ouvert) {
      ouvert = { debut: departs[k] ?? 0, fin: 0, jetons: [], longueur: 0 };
      groupes.push(ouvert);
      pile = [];
    }
    ouvert.jetons.push(j);
    ouvert.longueur += j.raw.length;
    ouvert.fin = (departs[k] ?? 0) + j.raw.length;
    if (j.type === "html") empilerHtml(j.raw, pile);
    if (pile.length === 0 || ouvert.longueur > GROUPE_HTML_MAX) ouvert = null;
  }
  return groupes;
}

/** Vrai si le jeton commence en `k` : texte brut identique, ou première ligne identique (marked réécrit parfois le reste du texte brut d'une citation, sans en changer la longueur). */
function commence(t: string, raw: string, k: number): boolean {
  if (t.startsWith(raw, k)) return true;
  const nl = raw.indexOf("\n");
  return nl > 0 && t.startsWith(raw.slice(0, nl + 1), k);
}

/** Décalage de début de chaque jeton dans `t` ; les définitions de liens, avalées par le lexer, laissent des trous que l'on saute ligne à ligne. */
function departsDesJetons(
  t: string,
  pos: number,
  fin: number,
  jetons: readonly JetonMarked[],
): number[] | null {
  const departs: number[] = [];
  let c = pos;
  for (const j of jetons) {
    let d = commence(t, j.raw, c) ? c : -1;
    for (let k = c; d === -1;) {
      const nl = t.indexOf("\n", k);
      if (nl === -1 || nl >= fin) break;
      k = nl + 1;
      if (commence(t, j.raw, k)) d = k;
    }
    if (d === -1) d = t.indexOf(j.raw, c);
    if (d === -1 || d >= fin) return null;
    departs.push(d);
    c = d + j.raw.length;
  }
  return departs;
}

/** Fin de la deuxième ligne qui commence en `debut`, bornée par `fin`. */
function deuxLignes(t: string, debut: number, fin: number): number {
  const l1 = t.indexOf("\n", debut);
  if (l1 === -1 || l1 + 1 >= fin) return fin;
  const l2 = t.indexOf("\n", l1 + 1);
  return l2 === -1 || l2 + 1 >= fin ? fin : l2 + 1;
}

/** Fin de la première ligne qui empêche un soulignement à venir de faire d'un paragraphe, avec les lignes qui le suivent, un titre (marked) ; -1 si aucune avant `fin`. */
function finCoupeTitre(t: string, finPara: number, fin: number): number {
  let nl = t.indexOf("\n", Math.max(0, finPara - 1));
  while (nl !== -1 && nl + 1 < fin) {
    const debut = nl + 1;
    nl = t.indexOf("\n", debut);
    if (nl === -1 || nl >= fin) return -1;
    if (COUPE_TITRE.test(t.slice(debut, nl))) return nl + 1;
  }
  return -1;
}

/** Étiquette de la définition que la suite peut encore compléter d'un titre : sur la dernière ligne complète de `[debut, fin)`, ou sur l'avant-dernière quand son adresse est sur la dernière. */
function provisoires(t: string, debut: number, fin: number): ReadonlySet<string> {
  const dl = Math.max(debut, t.lastIndexOf("\n", fin - 2) + 1);
  const m = DEF_LIGNE.exec(t.slice(dl, fin));
  if (m?.[1]) return new Set([etiquette(m[1])]);
  if (dl <= debut || !t.slice(dl, fin).trim()) return AUCUN;
  const m2 = DEF_SANS_ADRESSE.exec(t.slice(Math.max(debut, t.lastIndexOf("\n", dl - 2) + 1), dl));
  return m2?.[1] ? new Set([etiquette(m2[1])]) : AUCUN;
}

/** Inscrit dans la table partagée, en copies autonomes, les définitions nouvelles de `tmp` sauf les provisoires ; rend leurs étiquettes. */
function engager(tmp: Liens, liens: Liens, retenues: ReadonlySet<string>): string[] {
  const ajoutees: string[] = [];
  for (const k in tmp) {
    const v = tmp[k];
    if (!v || k in liens || retenues.has(k)) continue;
    liens[k] = { href: copie(v.href), title: v.title === undefined ? undefined : copie(v.title) };
    ajoutees.push(k);
  }
  return ajoutees;
}

interface Region {
  suite: number;
  /** Étiquettes inscrites dans la table partagée par cette région. */
  ajoutees: string[];
}

export function creerFlux(dep: DependancesFlux) {
  function lexer(src: string, liens: Liens): JetonMarked[] {
    const lx = dep.nouveauLexeur();
    lx.tokens.links = liens;
    return lx.lex(src);
  }

  // Le cache par source ne vaut que si le rendu ne dépend pas des liens de référence.
  function htmlDe(src: string, jetons: readonly JetonMarked[], liens: Liens): string {
    const cachable = !src.includes("[") || nbLiens(liens) === 0;
    if (cachable) {
      const deja = dep.lireCache(src);
      if (deja !== undefined) return deja;
    }
    const html = dep.rendre(jetons);
    if (cachable) dep.ecrireCache(src, html);
    return html;
  }

  function bloc(
    t: string,
    i: number,
    debut: number,
    fin: number,
    lim: number,
    jetons: readonly JetonMarked[],
    liens: Liens,
  ): BlocFlux {
    const src = copie(t.slice(debut, fin));
    return { i, html: htmlDe(src, jetons, liens), src, fin, lim };
  }

  /** Fige les groupes de `pos` à `fin` (tous, ou tous sauf le dernier et un paragraphe qu'un soulignement peut encore changer ; sans groupe, seules les lignes blanches sont passées) ; `null` si les décalages des jetons sont illisibles. */
  function figerRegion(
    t: string,
    pos: number,
    fin: number,
    liens: Liens,
    nouveaux: BlocFlux[],
    base: number,
    garderDernier: boolean,
  ): Region | null {
    const tmp = copieLiens(liens);
    const jetons = lexer(t.slice(pos, fin), tmp);
    const departs = departsDesJetons(t, pos, fin, jetons);
    if (!departs) return null;
    const groupes = grouper(jetons, departs);
    let nb = garderDernier ? groupes.length - 1 : groupes.length;
    for (let g = 0; g < nb; g++) {
      const gr = groupes[g];
      if (!gr) continue;
      const suivant = groupes[g + 1]?.debut;
      let lim = suivant === undefined ? Infinity : deuxLignes(t, suivant, fin);
      if (gr.jetons.length === 1 && gr.jetons[0]?.type === "paragraph") {
        const coupe = finCoupeTitre(t, gr.fin, fin);
        if (coupe === -1 && garderDernier) {
          nb = g;
          break;
        }
        lim = coupe === -1 ? Infinity : Math.max(lim, coupe);
      }
      nouveaux.push(bloc(t, base + nouveaux.length, gr.debut, suivant ?? fin, lim, gr.jetons, tmp));
    }
    const reste = groupes[Math.max(nb, 0)];
    const suite =
      nb < groupes.length && reste
        ? reste.debut
        : groupes.length || !garderDernier
          ? fin
          : Math.min(fin, sauterBlanches(t, pos));
    const retenues = garderDernier ? provisoires(t, Math.max(suite, pos), fin) : AUCUN;
    return { suite, ajoutees: engager(tmp, liens, retenues) };
  }

  /** Re-rend, avec les liens connus à présent, les blocs de rang inférieur à `jusqua` qui citent l'une des étiquettes. */
  function relire(
    blocs: readonly BlocFlux[],
    jusqua: number,
    liens: Liens,
    etiquettes: readonly string[],
  ): readonly BlocFlux[] {
    let sortie: BlocFlux[] | null = null;
    for (let k = 0; k < jusqua; k++) {
      const b = blocs[k];
      if (!b || !cite(b.src, etiquettes)) continue;
      const html = dep.rendre(lexer(b.src, copieLiens(liens)));
      if (html !== b.html) (sortie ??= blocs.slice())[k] = { ...b, html };
    }
    return sortie ?? blocs;
  }

  function avancer(t: string, etat: EtatFlux): Avancee {
    const liens = etat.liens;
    const nouveaux: BlocFlux[] = [];
    const aRelire: { jusqua: number; etiquettes: string[] }[] = [];
    let pos = etat.pos;
    let lexe = etat.lexe;
    let horizon = etat.horizon;
    let fenceVue = etat.fenceVue;
    for (let tours = 0; pos < t.length && tours < TOURS_MAX; tours++) {
      const fence = lireFence(t, pos, fenceVue);
      if (fence) {
        if (!fence.fermee) {
          fenceVue = fence.vu;
          break;
        }
        const fin = sauterBlanches(t, fence.fin + 1);
        const jetons = lexer(t.slice(pos, fence.fin), copieLiens(liens));
        nouveaux.push(bloc(t, etat.blocs.length + nouveaux.length, pos, fin, fin, jetons, liens));
        pos = fin;
        fenceVue = 0;
        horizon = 0;
        lexe = 0;
        continue;
      }
      fenceVue = 0;
      const nl = t.lastIndexOf("\n");
      if (nl < pos || nl + 1 === horizon) break;
      const taille = nl + 1 - pos;
      if (taille > ANALYSE_MAX && taille < lexe * CROISSANCE_ANALYSE) break;
      const avant = etat.blocs.length + nouveaux.length;
      const r = figerRegion(t, pos, nl + 1, liens, nouveaux, etat.blocs.length, true);
      if (!r) break;
      if (r.ajoutees.length) aRelire.push({ jusqua: avant, etiquettes: r.ajoutees });
      horizon = nl + 1;
      lexe = nl + 1 - r.suite;
      pos = r.suite;
    }
    let blocs: readonly BlocFlux[] = nouveaux.length ? [...etat.blocs, ...nouveaux] : etat.blocs;
    for (const r of aRelire) blocs = relire(blocs, r.jusqua, liens, r.etiquettes);
    return {
      etat: { blocs, pos, liens, lexe, horizon, fenceVue, fini: false, texte: t, source: etat.source },
      actif: t.slice(pos),
    };
  }

  /** Fin du texte : le bloc actif est figé avec les autres, le texte est entièrement consommé. */
  function terminer(t: string, etat: EtatFlux): Avancee {
    const courant = avancer(t, etat).etat;
    const liens = courant.liens;
    const nouveaux: BlocFlux[] = [];
    const base = courant.blocs.length;
    let ajoutees: string[] = [];
    if (t.slice(courant.pos).trim() !== "") {
      const r = figerRegion(t, courant.pos, t.length, liens, nouveaux, base, false);
      if (r) ajoutees = r.ajoutees;
      else {
        nouveaux.length = 0;
        const tmp = copieLiens(liens);
        const jetons = lexer(t.slice(courant.pos), tmp);
        nouveaux.push(bloc(t, base, courant.pos, t.length, Infinity, jetons, tmp));
        ajoutees = engager(tmp, liens, AUCUN);
      }
    }
    let blocs: readonly BlocFlux[] = nouveaux.length ? [...courant.blocs, ...nouveaux] : courant.blocs;
    if (ajoutees.length) blocs = relire(blocs, base, liens, ajoutees);
    return {
      etat: {
        blocs,
        pos: t.length,
        liens,
        lexe: 0,
        horizon: 0,
        fenceVue: 0,
        fini: true,
        texte: t,
        source: etat.source,
      },
      actif: "",
    };
  }

  /** Reprise sur un texte qui ne prolonge pas celui de l'état (ou prolonge un texte terminé) : les blocs de tête que le texte commun décide sont gardés, le reste est redécoupé. */
  function reprendre(t: string, etat: EtatFlux): EtatFlux {
    const ancien = etat.texte;
    const prolonge = t.startsWith(ancien);
    if (prolonge && !etat.fini) return etat;
    let commun = ancien.length;
    if (!prolonge) {
      commun = 0;
      const max = Math.min(ancien.length, t.length);
      while (commun < max && ancien.charCodeAt(commun) === t.charCodeAt(commun)) commun++;
    }
    let n = 0;
    while (n < etat.blocs.length && (etat.blocs[n]?.lim ?? Infinity) <= commun) n++;
    const gardes = etat.blocs.slice(0, n);
    // Table refaite sur tout le texte gardé : sources des blocs et définitions logées entre deux blocs.
    const lus = Object.create(null) as Liens;
    let prec = 0;
    for (const b of gardes) {
      const debut = b.fin - b.src.length;
      if (debut > prec && t.slice(prec, debut).includes("[")) lexer(t.slice(prec, debut), lus);
      if (b.src.includes("[")) lexer(b.src, lus);
      prec = b.fin;
    }
    const liens = Object.create(null) as Liens;
    engager(lus, liens, AUCUN);
    const changees = etiquettesChangees(etat.liens, liens);
    return {
      blocs: changees.length ? relire(gardes, gardes.length, liens, changees) : gardes,
      pos: n ? (gardes[n - 1]?.fin ?? 0) : 0,
      liens,
      lexe: 0,
      horizon: 0,
      fenceVue: 0,
      fini: false,
      texte: t,
      source: etat.source,
    };
  }

  return { avancer, terminer, reprendre };
}

/** Blocs affichés : les blocs figés puis, s'il existe, le bloc actif sous la clé du prochain bloc figé (son nœud devient celui du bloc figé). */
export function listerBlocs<T extends { i: number; html: string }>(
  blocs: readonly T[],
  actif: string,
): readonly { i: number; html: string }[] {
  return actif ? [...blocs, { i: blocs.length, html: actif }] : blocs;
}
