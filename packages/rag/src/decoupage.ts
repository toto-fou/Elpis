// SPDX-License-Identifier: MIT
/** packages/rag/src/decoupage.ts — blocs de l'extracteur ou texte brut → passages (titres, page, rectangles, positions, empreinte), six méthodes, redécoupe de passages, déterministe. */
import { createHash } from "node:crypto";

import {
  debutsMarkdown,
  debutsRegex,
  decouperParLignes,
  decouperParPhrases,
  decouperParTaille,
  decouperTableau,
  desechapper,
  parDebuts,
  parSeparateur,
} from "./decoupage-texte";
import type { Morceau } from "./decoupage-texte";
import { ErreurRag } from "./erreurs";
import { CARACTERES_PAR_JETON_DEFAUT, estimerJetons } from "./jetons";

export type Boite = readonly [number, number, number, number];

export type GenreBloc = "heading" | "paragraph" | "list" | "table" | "code";

const GENRES: ReadonlySet<string> = new Set(["heading", "paragraph", "list", "table", "code"]);

/** Bloc de l'extracteur (contrat `/api/extract`) : boîtes en points PDF, origine en haut à gauche, relatives à la page. */
export interface Bloc {
  kind: GenreBloc;
  text: string;
  level?: number;
  page?: number;
  boxes?: readonly Boite[];
  sheet?: string;
  slide?: number;
}

export type MethodeDecoupage = "auto" | "taille" | "phrase" | "markdown" | "separateur" | "regex";

export const METHODES_DECOUPAGE: readonly MethodeDecoupage[] = [
  "auto",
  "taille",
  "phrase",
  "markdown",
  "separateur",
  "regex",
];

export interface ParamsDecoupage {
  methode: MethodeDecoupage;
  valeur?: string | undefined;
  tailleJetons: number;
  chevauchementJetons: number;
  tailleMaxJetons: number;
  caracteresParJeton: number;
  maxPassages: number;
}

export const PARAMS_DECOUPAGE_DEFAUT: Readonly<ParamsDecoupage> = {
  methode: "auto",
  tailleJetons: 512,
  chevauchementJetons: 64,
  tailleMaxJetons: 1200,
  caracteresParJeton: CARACTERES_PAR_JETON_DEFAUT,
  maxPassages: 100_000,
};

export interface BoitesPage {
  page: number;
  rects: Boite[];
}

/** Passage prêt à indexer (les noms sont ceux de la charge utile Qdrant). */
export interface Passage {
  text: string;
  heading_path: string;
  page: number | null;
  boxes: BoitesPage[];
  char_start: number;
  char_end: number;
  chunk_index: number;
  hash: string;
  jetons: number;
}

/** Options d'exécution : `regexStricte` lève `regex_invalide` (motif invalide ou trop lent) au lieu de retomber sur la taille ; `echeance` (ms epoch) borne les redécoupes. */
export interface OptionsDecoupage {
  regexStricte?: boolean | undefined;
  echeance?: number | undefined;
}

/** Redécoupe d'un passage de base (indice du découpage de base) avec ses propres paramètres. */
export interface Redecoupe {
  index: number;
  params: Partial<ParamsDecoupage>;
}

/** Passage après redécoupes : `redecoupe_de` = indice du passage de base redécoupé, sinon `null`. */
export interface PassageRedecoupe extends Passage {
  redecoupe_de: number | null;
}

/** Version de l'algorithme : entre dans l'empreinte des paramètres, pour réindexer si le découpage change. */
export const VERSION_DECOUPAGE = 1;

const SEP = "\n\n";
const SEPARATEUR_TITRES = " › ";
const TITRE_MAX = 200;
const RECTS_MAX = 400;
const NIVEAU_MAX = 6;
const SEUIL_SAUT_MOU = 0.5;

interface Normalises extends ParamsDecoupage {
  cibleCar: number;
  chevCar: number;
  maxCar: number;
}

function entier(v: unknown, defaut: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : defaut;
}

/** Paramètres bornés : taille ≤ 0 → défaut, chevauchement dans [0, taille/2], taille maximum ≥ taille, méthode inconnue → auto. */
export function normaliserParams(p: Partial<ParamsDecoupage> = {}): ParamsDecoupage {
  const d = PARAMS_DECOUPAGE_DEFAUT;
  const methode = METHODES_DECOUPAGE.includes(p.methode as MethodeDecoupage)
    ? (p.methode as MethodeDecoupage)
    : d.methode;
  const demandee = entier(p.tailleJetons, d.tailleJetons);
  const tailleJetons = demandee > 0 ? demandee : d.tailleJetons;
  const chevauchementJetons = Math.max(
    0,
    Math.min(entier(p.chevauchementJetons, d.chevauchementJetons), Math.floor(tailleJetons / 2)),
  );
  const maxDemande = entier(p.tailleMaxJetons, d.tailleMaxJetons);
  const ratio =
    typeof p.caracteresParJeton === "number" &&
    p.caracteresParJeton > 0 &&
    Number.isFinite(p.caracteresParJeton)
      ? p.caracteresParJeton
      : d.caracteresParJeton;
  const maxPassages = Math.max(1, entier(p.maxPassages, d.maxPassages));
  const valeur = typeof p.valeur === "string" && p.valeur !== "" ? p.valeur : undefined;
  return {
    methode,
    valeur,
    tailleJetons,
    chevauchementJetons,
    tailleMaxJetons: Math.max(tailleJetons, maxDemande),
    caracteresParJeton: ratio,
    maxPassages,
  };
}

function enCaracteres(p: ParamsDecoupage): Normalises {
  const cibleCar = Math.max(1, Math.floor(p.tailleJetons * p.caracteresParJeton));
  const maxCar = Math.max(cibleCar, Math.floor(p.tailleMaxJetons * p.caracteresParJeton));
  const chevCar = Math.min(
    Math.floor(p.chevauchementJetons * p.caracteresParJeton),
    Math.floor(cibleCar / 2),
  );
  return { ...p, cibleCar, chevCar, maxCar };
}

/** Empreinte (12 hex) des paramètres effectifs : change si le découpage d'un document doit être refait. */
export function empreinteParams(params: Partial<ParamsDecoupage> = {}): string {
  const p = normaliserParams(params);
  const canon = [
    VERSION_DECOUPAGE,
    p.methode,
    p.valeur ?? null,
    p.tailleJetons,
    p.chevauchementJetons,
    p.tailleMaxJetons,
    p.caracteresParJeton,
  ];
  return createHash("sha1").update(JSON.stringify(canon)).digest("hex").slice(0, 12);
}

/** Empreinte d'un texte de passage (SHA-256 tronqué à 16 hex). */
export function empreinteTexte(texte: string): string {
  return createHash("sha256").update(texte, "utf8").digest("hex").slice(0, 16);
}

interface BlocP {
  genre: GenreBloc;
  texte: string;
  titre: string;
  debut: number;
  fin: number;
  page: number | null;
  boites: readonly Boite[];
  feuille: string | null;
  diapo: number | null;
  chemin: string;
}

interface Brut {
  debut: number;
  fin: number;
  texte: string;
  b0: number;
  b1: number;
}

function niveauTitre(niveau: number | undefined): number {
  return Number.isInteger(niveau) && (niveau as number) >= 1 ? Math.min(NIVEAU_MAX, niveau as number) : 1;
}

function titreNettoye(texte: string): string {
  const t = texte.replace(/\s+/g, " ").trim();
  return t.length > TITRE_MAX ? `${t.slice(0, TITRE_MAX)}…` : t;
}

function numeroPositif(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 1 ? v : null;
}

function boitesValides(boites: readonly Boite[] | undefined): readonly Boite[] {
  if (!Array.isArray(boites)) return [];
  return boites.filter(
    (b) => Array.isArray(b) && b.length === 4 && b.every((x) => typeof x === "number" && Number.isFinite(x)),
  );
}

function cheminDe(feuille: string | null, pile: readonly { titre: string }[]): string {
  const parties = feuille === null ? [] : [feuille];
  for (const t of pile) parties.push(t.titre);
  return parties.join(SEPARATEUR_TITRES);
}

/** Texte assemblé d'un document : blocs non vides rognés, séparés par une ligne vide (les positions des passages s'y rapportent). */
export function assemblerTexte(blocs: readonly Bloc[]): string {
  return preparer(blocs).texte;
}

function preparer(blocs: readonly Bloc[]): { texte: string; blocs: BlocP[] } {
  const sortie: BlocP[] = [];
  const morceaux: string[] = [];
  const pile: { niveau: number; titre: string }[] = [];
  let feuille: string | null = null;
  let position = 0;
  for (const b of blocs) {
    const texte = typeof b?.text === "string" ? b.text.trim() : "";
    if (texte === "") continue;
    const feuilleBloc = typeof b.sheet === "string" && b.sheet.trim() !== "" ? b.sheet.trim() : null;
    if (feuilleBloc !== feuille) {
      pile.length = 0;
      feuille = feuilleBloc;
    }
    let titre = "";
    if (b.kind === "heading") {
      const niveau = niveauTitre(b.level);
      titre = titreNettoye(texte);
      while (pile.length > 0 && (pile[pile.length - 1]?.niveau ?? 0) >= niveau) pile.pop();
      pile.push({ niveau, titre });
    }
    const debut = sortie.length === 0 ? 0 : position + SEP.length;
    position = debut + texte.length;
    morceaux.push(texte);
    sortie.push({
      genre: GENRES.has(b.kind) ? b.kind : "paragraph",
      texte,
      titre,
      debut,
      fin: position,
      page: numeroPositif(b.page) ?? numeroPositif(b.slide),
      boites: boitesValides(b.boxes),
      feuille,
      diapo: numeroPositif(b.slide),
      chemin: cheminDe(feuille, pile),
    });
  }
  return { texte: morceaux.join(SEP), blocs: sortie };
}

/** Blocs d'un texte brut avec leurs positions réelles : paragraphes (lignes vides), titres `#`, blocs de code balisés. */
function blocsDepuisTexte(texte: string): BlocP[] {
  const sortie: BlocP[] = [];
  const pile: { niveau: number; titre: string }[] = [];
  const ajouter = (genre: GenreBloc, debut: number, fin: number, titre: string): void => {
    sortie.push({
      genre,
      texte: texte.slice(debut, fin),
      titre,
      debut,
      fin,
      page: null,
      boites: [],
      feuille: null,
      diapo: null,
      chemin: cheminDe(null, pile),
    });
  };
  let debutParagraphe = -1;
  let finParagraphe = -1;
  let debutCode = -1;
  const vider = (): void => {
    if (debutParagraphe >= 0) ajouter("paragraph", debutParagraphe, finParagraphe, "");
    debutParagraphe = -1;
  };
  let debut = 0;
  while (debut <= texte.length) {
    const nl = texte.indexOf("\n", debut);
    const fin = nl === -1 ? texte.length : nl;
    const ligne = texte.slice(debut, fin);
    const rogne = ligne.trim();
    const decalage = ligne.length - ligne.trimStart().length;
    const balise = /^(```|~~~)/.test(rogne);
    if (debutCode >= 0) {
      if (balise) {
        ajouter("code", debutCode, fin, "");
        debutCode = -1;
      }
    } else if (balise) {
      vider();
      debutCode = debut;
    } else if (rogne === "") {
      vider();
    } else if (/^#{1,6}\s/.test(rogne)) {
      vider();
      const niveau = rogne.match(/^#+/)?.[0].length ?? 1;
      const titre = titreNettoye(rogne.replace(/^#+\s*/, "").replace(/\s*#+\s*$/, ""));
      while (pile.length > 0 && (pile[pile.length - 1]?.niveau ?? 0) >= niveau) pile.pop();
      pile.push({ niveau, titre });
      ajouter("heading", debut + decalage, debut + decalage + rogne.length, titre);
    } else {
      if (debutParagraphe < 0) debutParagraphe = debut + decalage;
      finParagraphe = debut + decalage + rogne.length;
    }
    if (nl === -1) break;
    debut = nl + 1;
  }
  if (debutCode >= 0) ajouter("code", debutCode, texte.length, "");
  vider();
  return sortie;
}

/** Indice du premier bloc dont la fin dépasse `position` (le dernier bloc si aucun). */
function blocApres(blocs: readonly BlocP[], position: number): number {
  let bas = 0;
  let haut = blocs.length - 1;
  while (bas < haut) {
    const milieu = (bas + haut) >> 1;
    if ((blocs[milieu]?.fin ?? 0) > position) haut = milieu;
    else bas = milieu + 1;
  }
  return bas;
}

/** Intervalle `[b0, b1]` des blocs qui recouvrent `[debut, fin)`. */
function blocsRecouverts(blocs: readonly BlocP[], debut: number, fin: number): [number, number] {
  const b0 = blocApres(blocs, debut);
  let b1 = b0;
  while (b1 + 1 < blocs.length && (blocs[b1 + 1]?.debut ?? Infinity) < fin) b1++;
  return [b0, b1];
}

function brutDepuisMorceau(texte: string, m: Morceau, blocs: readonly BlocP[]): Brut {
  const [b0, b1] = blocsRecouverts(blocs, m.debut, m.fin);
  return { debut: m.debut, fin: m.fin, texte: texte.slice(m.debut, m.fin), b0, b1 };
}

interface Unite {
  texte: string;
  debut: number;
  fin: number;
  b0: number;
  b1: number;
  genre: GenreBloc;
  piece: boolean;
  isole: boolean;
}

/** Unités de regroupement d'un bloc : le bloc entier, ou ses morceaux s'il dépasse la cible. */
function unitesDuBloc(bloc: BlocP, indice: number, p: Normalises): Unite[] {
  const base = { b0: indice, b1: indice, genre: bloc.genre };
  const entier: Unite = {
    ...base,
    texte: bloc.texte,
    debut: bloc.debut,
    fin: bloc.fin,
    piece: false,
    isole: false,
  };
  const longueur = bloc.texte.length;
  if (bloc.genre === "table") {
    if (longueur <= p.cibleCar) return [entier];
    if (longueur <= p.maxCar) return [{ ...entier, isole: true }];
    return decouperTableau(bloc.texte, p.cibleCar).map((m) => ({
      ...base,
      texte: m.texte,
      debut: bloc.debut + m.debut,
      fin: bloc.debut + m.fin,
      piece: true,
      isole: true,
    }));
  }
  if (longueur <= p.cibleCar || bloc.genre === "heading") return [entier];
  const morceaux =
    bloc.genre === "paragraph"
      ? decouperParPhrases(bloc.texte, p.cibleCar, p.chevCar, p.maxPassages)
      : decouperParLignes(bloc.texte, p.cibleCar, p.maxPassages);
  const unites: Unite[] = [];
  for (const m of morceaux) {
    const brut = bloc.texte.slice(m.debut, m.fin);
    const texte = brut.trim();
    if (texte === "") continue;
    const decalage = brut.length - brut.trimStart().length;
    const debut = bloc.debut + m.debut + decalage;
    unites.push({ ...base, texte, debut, fin: debut + texte.length, piece: true, isole: false });
  }
  return unites;
}

/** Méthode `auto` : regroupe les blocs par structure (titres, tableaux entiers, chevauchement en paragraphes entiers). */
function decouperAuto(blocs: readonly BlocP[], p: Normalises): Brut[] {
  const sortie: Brut[] = [];
  let courant: Unite[] = [];
  let reportees = 0;
  let aCorps = false;
  let taille = 0;
  const recalculer = (): void => {
    taille = courant.reduce((somme, u, i) => somme + u.texte.length + (i > 0 ? SEP.length : 0), 0);
  };
  const emettre = (unites: readonly Unite[]): void => {
    const premier = unites[0];
    const dernier = unites[unites.length - 1];
    if (!premier || !dernier) return;
    sortie.push({
      debut: premier.debut,
      fin: dernier.fin,
      texte: unites.map((u) => u.texte).join(SEP),
      b0: premier.b0,
      b1: unites.reduce((m, u) => Math.max(m, u.b1), premier.b1),
    });
    if (sortie.length > p.maxPassages) {
      throw new ErreurRag("trop_de_passages", `découpage refusé : plus de ${p.maxPassages} passages`);
    }
  };
  const repartir = (restantes: Unite[], reportees2: number): void => {
    courant = restantes;
    reportees = reportees2;
    aCorps = false;
    recalculer();
  };
  const queueReportable = (): Unite[] => {
    const queue: Unite[] = [];
    let total = 0;
    for (let k = courant.length - 1; k >= 0; k--) {
      const u = courant[k];
      if (!u || u.piece || u.isole || (u.genre !== "paragraph" && u.genre !== "list")) break;
      total += u.texte.length + SEP.length;
      if (total > p.chevCar) break;
      queue.unshift(u);
    }
    return queue;
  };
  /** Émet le passage en cours ; `taille` : les titres de queue passent au passage suivant et un chevauchement est reporté. */
  const vider = (raison: "taille" | "autre"): void => {
    if (courant.length - reportees <= 0) {
      repartir([], 0);
      return;
    }
    let aEmettre = courant;
    let titres: Unite[] = [];
    if (raison === "taille") {
      let k = courant.length;
      while (k > reportees && courant[k - 1]?.genre === "heading") k--;
      if (k > reportees) {
        aEmettre = courant.slice(0, k);
        titres = courant.slice(k);
      }
    }
    emettre(aEmettre);
    if (titres.length > 0) {
      repartir(titres, 0);
      return;
    }
    const queue = raison === "taille" && p.chevCar > 0 ? queueReportable() : [];
    repartir(queue, queue.length);
  };
  let precedent: BlocP | undefined;
  for (const u of blocs.flatMap((b, i) => unitesDuBloc(b, i, p))) {
    const bloc = blocs[u.b0];
    if (!bloc) continue;
    const changeFeuille = precedent !== undefined && precedent.feuille !== bloc.feuille;
    const changeDiapo = precedent !== undefined && precedent.diapo !== bloc.diapo;
    if (changeFeuille) vider("autre");
    const nouveaux = courant.length - reportees;
    const debutDeSection = u.genre === "heading" || u.isole || changeFeuille || changeDiapo;
    if (nouveaux === 0 && reportees > 0 && debutDeSection) repartir([], 0);
    const dernier = courant[courant.length - 1];
    if (aCorps && dernier && u.debut < dernier.fin) vider("autre");
    if ((u.genre === "heading" || changeDiapo) && aCorps && taille >= SEUIL_SAUT_MOU * p.cibleCar)
      vider("autre");
    if (aCorps && taille + SEP.length + u.texte.length > p.cibleCar) vider("taille");
    if (u.isole && aCorps) vider("autre");
    courant.push(u);
    taille += u.texte.length + (courant.length > 1 ? SEP.length : 0);
    if (u.genre !== "heading") aCorps = true;
    if (u.isole) vider("autre");
    precedent = bloc;
  }
  vider("autre");
  return sortie;
}

/** Méthodes sur le texte assemblé : morceaux `[debut, fin)` selon la méthode demandée. */
function morceauxPar(texte: string, blocs: readonly BlocP[], p: Normalises, o: OptionsDecoupage): Morceau[] {
  const taille = (): Morceau[] => decouperParTaille(texte, p.cibleCar, p.chevCar, p.maxPassages);
  switch (p.methode) {
    case "phrase":
      return decouperParPhrases(texte, p.cibleCar, p.chevCar, p.maxPassages);
    case "markdown":
      return parDebuts(
        texte.length,
        debutsMarkdown(
          texte,
          blocs.filter((b) => b.genre === "heading").map((b) => b.debut),
        ),
      );
    case "separateur":
      return p.valeur === undefined ? taille() : parSeparateur(texte, desechapper(p.valeur));
    case "regex": {
      const debuts = p.valeur === undefined ? null : debutsRegex(p.valeur, texte);
      if (debuts === null && p.valeur !== undefined && o.regexStricte)
        throw new ErreurRag("regex_invalide", "expression régulière invalide ou trop lente");
      return debuts === null || debuts.length === 0 ? taille() : parDebuts(texte.length, debuts);
    }
    default:
      return taille();
  }
}

function rognerBrut(b: Brut): Brut | null {
  const rogne = b.texte.trim();
  if (rogne === "") return null;
  if (b.fin - b.debut !== b.texte.length) return { ...b, texte: rogne };
  const decalage = b.texte.length - b.texte.trimStart().length;
  return { ...b, texte: rogne, debut: b.debut + decalage, fin: b.debut + decalage + rogne.length };
}

function sousDecouper(b: Brut, blocs: readonly BlocP[], p: Normalises): Brut[] {
  const litteral = b.fin - b.debut === b.texte.length;
  const morceaux = decouperParTaille(
    b.texte,
    p.maxCar,
    Math.min(p.chevCar, Math.floor(p.maxCar / 4)),
    p.maxPassages,
  );
  return morceaux.map((m) => {
    const debut = b.debut + m.debut;
    const fin = b.debut + m.fin;
    const [b0, b1] = litteral ? blocsRecouverts(blocs, debut, fin) : [b.b0, b.b1];
    return { debut, fin, texte: b.texte.slice(m.debut, m.fin), b0, b1 };
  });
}

function boitesDe(blocs: readonly BlocP[], b0: number, b1: number): BoitesPage[] {
  const parPage = new Map<number, Boite[]>();
  let total = 0;
  for (let i = b0; i <= b1 && total < RECTS_MAX; i++) {
    const b = blocs[i];
    if (!b || b.page === null || b.boites.length === 0) continue;
    const liste = parPage.get(b.page) ?? [];
    for (const r of b.boites) {
      if (total >= RECTS_MAX) break;
      liste.push([r[0], r[1], r[2], r[3]]);
      total++;
    }
    parPage.set(b.page, liste);
  }
  return [...parPage].map(([page, rects]) => ({ page, rects }));
}

function pageDe(blocs: readonly BlocP[], b0: number, b1: number): number | null {
  for (let i = b0; i <= b1; i++) {
    const page = blocs[i]?.page;
    if (page !== null && page !== undefined) return page;
  }
  return null;
}

function finaliser(bruts: readonly Brut[], blocs: readonly BlocP[], p: Normalises): Passage[] {
  const vus = new Set<string>();
  const passages: Passage[] = [];
  for (const brut of bruts) {
    const rogne = rognerBrut(brut);
    if (rogne === null) continue;
    for (const morceau of rogne.texte.length > p.maxCar ? sousDecouper(rogne, blocs, p) : [rogne]) {
      const b = rognerBrut(morceau);
      if (b === null) continue;
      const hash = empreinteTexte(b.texte);
      if (vus.has(hash)) continue;
      vus.add(hash);
      if (passages.length >= p.maxPassages) {
        throw new ErreurRag("trop_de_passages", `découpage refusé : plus de ${p.maxPassages} passages`);
      }
      passages.push({
        text: b.texte,
        heading_path: blocs[b.b0]?.chemin ?? "",
        page: pageDe(blocs, b.b0, b.b1),
        boxes: boitesDe(blocs, b.b0, b.b1),
        char_start: b.debut,
        char_end: b.fin,
        chunk_index: passages.length,
        hash,
        jetons: estimerJetons(b.texte, p.caracteresParJeton),
      });
    }
  }
  return passages;
}

function executer(
  texte: string,
  blocs: readonly BlocP[],
  params: Partial<ParamsDecoupage> | undefined,
  o: OptionsDecoupage = {},
): Passage[] {
  const p = enCaracteres(normaliserParams(params));
  if (blocs.length === 0) return [];
  const bruts =
    p.methode === "auto"
      ? decouperAuto(blocs, p)
      : morceauxPar(texte, blocs, p, o).map((m) => brutDepuisMorceau(texte, m, blocs));
  return finaliser(bruts, blocs, p);
}

/** Découpe les blocs d'un document en passages ; `char_start`/`char_end` se rapportent à `assemblerTexte(blocs)`. */
export function decouper(
  blocs: readonly Bloc[],
  params?: Partial<ParamsDecoupage>,
  o: OptionsDecoupage = {},
): Passage[] {
  const prepare = preparer(blocs);
  return executer(prepare.texte, prepare.blocs, params, o);
}

/** Blocs recoupés à `[debut, fin)` du texte assemblé, positions ramenées au début de la tranche. */
function blocsDeLaTranche(texte: string, blocs: readonly BlocP[], debut: number, fin: number): BlocP[] {
  const sortie: BlocP[] = [];
  for (const b of blocs) {
    if (b.fin <= debut || b.debut >= fin) continue;
    const d = Math.max(b.debut, debut);
    const f = Math.min(b.fin, fin);
    sortie.push({ ...b, debut: d - debut, fin: f - debut, texte: texte.slice(d, f) });
  }
  return sortie;
}

/** Découpe puis remplace chaque passage de base désigné par ses sous-passages (tranche du texte assemblé), indices renumérotés ; les indices hors du découpage sont rendus dans `ignores`. */
export function decouperAvecRedecoupes(
  blocs: readonly Bloc[],
  params: Partial<ParamsDecoupage> | undefined,
  redecoupes: readonly Redecoupe[],
  o: OptionsDecoupage = {},
): { passages: PassageRedecoupe[]; ignores: number[] } {
  const prepare = preparer(blocs);
  const base = executer(prepare.texte, prepare.blocs, params, o);
  const parIndice = new Map(redecoupes.map((r) => [r.index, r.params]));
  const ignores = [...parIndice.keys()].filter((i) => i >= base.length).sort((a, b) => a - b);
  if (parIndice.size === 0 || ignores.length === parIndice.size)
    return { passages: base.map((p) => ({ ...p, redecoupe_de: null })), ignores };
  const max = normaliserParams(params).maxPassages;
  const vus = new Set<string>();
  const sortie: PassageRedecoupe[] = [];
  const ajouter = (p: Passage, de: number | null): void => {
    if (vus.has(p.hash)) return;
    vus.add(p.hash);
    if (sortie.length >= max)
      throw new ErreurRag("trop_de_passages", `découpage refusé : plus de ${max} passages`);
    sortie.push({ ...p, chunk_index: sortie.length, redecoupe_de: de });
  };
  for (const p of base) {
    const sous = parIndice.get(p.chunk_index);
    if (sous === undefined) {
      ajouter(p, null);
      continue;
    }
    if (o.echeance !== undefined && Date.now() > o.echeance)
      throw new ErreurRag("delai", "découpage trop long");
    const tranche = prepare.texte.slice(p.char_start, p.char_end);
    const morceaux = executer(
      tranche,
      blocsDeLaTranche(prepare.texte, prepare.blocs, p.char_start, p.char_end),
      sous,
      o,
    );
    if (morceaux.length === 0) {
      ajouter(p, null);
      continue;
    }
    for (const m of morceaux)
      ajouter(
        { ...m, char_start: m.char_start + p.char_start, char_end: m.char_end + p.char_start },
        p.chunk_index,
      );
  }
  return { passages: sortie, ignores };
}

/** Découpe un texte brut (aperçu, fichiers texte) : positions dans le texte d'origine, titres `#` reconnus. */
export function decouperTexte(texte: string, params?: Partial<ParamsDecoupage>): Passage[] {
  return executer(texte, blocsDepuisTexte(texte), params);
}
