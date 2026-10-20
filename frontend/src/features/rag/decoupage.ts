// SPDX-License-Identifier: MIT
/** frontend/src/features/rag/decoupage.ts — découpage avancé, logique pure : champs selon la méthode, validation, règles par extension, redécoupes d'un aperçu, antirebond. */
import { DECOUPAGE_RAG_DEFAUT, EXTENSIONS_RAG, VALEUR_DECOUPAGE_RAG_MAX } from "@elpis/contracts";
import type {
  DecoupageDocumentRag,
  DecoupageRag,
  ExtensionRag,
  MethodeDecoupageRag,
  ParamsDecoupageRag,
  PassageListeRag,
  UniteDecoupageRag,
} from "@elpis/contracts";

export type RedecoupeRag = DecoupageDocumentRag["redecoupes"][number];

/** Mêmes bornes que `schemaParamsDecoupageRag`, pour les champs de saisie et leurs messages. */
export const BORNES_DECOUPAGE = {
  taille: { min: 20, max: 20_000 },
  chevauchement: { min: 0, max: 10_000 },
  tailleMax: { min: 20, max: 40_000 },
} as const;

/** Paramètres d'une collection sans ses règles par extension. */
export function paramsDe(d: DecoupageRag): ParamsDecoupageRag {
  const { par_extension: _regles, ...params } = d;
  return params;
}

export const LIBELLES_METHODE: Readonly<Record<MethodeDecoupageRag, string>> = {
  auto: "Automatique",
  taille: "Taille fixe",
  phrase: "Phrases",
  markdown: "Titres Markdown",
  separateur: "Séparateur",
  regex: "Expression régulière",
};

export const AIDES_METHODE: Readonly<Record<MethodeDecoupageRag, string>> = {
  auto: "Suit la structure du document (titres, paragraphes, tableaux) : convient à la plupart des fichiers.",
  taille: "Des passages de taille régulière, quel que soit le contenu.",
  phrase: "Regroupe des phrases entières jusqu’à la taille visée.",
  markdown: "Un passage par section, coupée à chaque titre Markdown.",
  separateur: "Coupe le texte à chaque occurrence d’un séparateur exact.",
  regex: "Coupe le texte à chaque correspondance d’une expression régulière.",
};

export const LIBELLES_UNITE: Readonly<Record<UniteDecoupageRag, string>> = {
  caracteres: "Caractères",
  jetons: "Jetons",
};

export interface ExempleValeur {
  valeur: string;
  libelle: string;
}

export const EXEMPLES_VALEUR: Readonly<Record<"separateur" | "regex", readonly ExempleValeur[]>> = {
  separateur: [{ valeur: "\\n\\n", libelle: "Ligne vide entre paragraphes" }],
  regex: [
    { valeur: "^#{1,3} ", libelle: "Titres Markdown de niveau 1 à 3" },
    { valeur: "(?=Article \\d+)", libelle: "Avant chaque « Article N »" },
  ],
};

export function avecValeur(m: MethodeDecoupageRag): m is "separateur" | "regex" {
  return m === "separateur" || m === "regex";
}

export interface ChampsVisibles {
  valeur: boolean;
  chevauchement: boolean;
}

/** Champs de saisie propres à la méthode ; l'unité, la taille et la taille maximale valent pour toutes. */
export function champsVisibles(m: MethodeDecoupageRag): ChampsVisibles {
  return { valeur: avecValeur(m), chevauchement: m === "auto" || m === "taille" || m === "phrase" };
}

export type ChampParams = "valeur" | "taille" | "chevauchement" | "tailleMax";
export type ErreursParams = Partial<Record<ChampParams, string>>;

const NBSP = "\u00a0";
const nombre = (n: number): string => n.toLocaleString("fr-FR").replace(/\u202f/g, NBSP);

function regexValide(valeur: string): string | null {
  try {
    new RegExp(valeur, "u");
    return null;
  } catch {
    try {
      new RegExp(valeur);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "syntaxe invalide";
    }
  }
}

/** Erreurs de saisie par champ, avec les mêmes règles que le serveur ; un objet vide veut dire « valide ». */
export function erreursParams(p: ParamsDecoupageRag): ErreursParams {
  const e: ErreursParams = {};
  const mot = p.unite === "jetons" ? "jetons" : "caractères";
  const { taille, chevauchement, tailleMax } = BORNES_DECOUPAGE;
  const valeurMax = VALEUR_DECOUPAGE_RAG_MAX;
  if (avecValeur(p.methode)) {
    const v = p.valeur ?? "";
    if (v === "") e.valeur = p.methode === "regex" ? "Indiquez l’expression." : "Indiquez le séparateur.";
    else if (v.length > valeurMax) e.valeur = `${valeurMax} caractères au plus.`;
    else if (p.methode === "regex") {
      const invalide = regexValide(v);
      if (invalide !== null) e.valeur = `Expression invalide : ${invalide}`;
    }
  }
  const tailleOk = Number.isInteger(p.taille) && p.taille >= taille.min && p.taille <= taille.max;
  if (!tailleOk) e.taille = `Entre ${nombre(taille.min)} et ${nombre(taille.max)} ${mot}.`;
  if (champsVisibles(p.methode).chevauchement) {
    if (
      !Number.isInteger(p.chevauchement) ||
      p.chevauchement < chevauchement.min ||
      p.chevauchement > chevauchement.max
    )
      e.chevauchement = `Entre 0 et ${nombre(chevauchement.max)} ${mot}.`;
    else if (tailleOk && p.chevauchement * 2 >= p.taille)
      e.chevauchement = "Moins de la moitié de la taille d’un passage.";
  }
  if (!Number.isInteger(p.taille_max) || p.taille_max < tailleMax.min || p.taille_max > tailleMax.max)
    e.tailleMax = `Entre ${nombre(tailleMax.min)} et ${nombre(tailleMax.max)} ${mot}.`;
  else if (tailleOk && p.taille_max < p.taille) e.tailleMax = "Au moins la taille d’un passage.";
  return e;
}

/** Paramètres prêts à partir : valeur écartée si la méthode n'en prend pas, chevauchement ramené sous la moitié de la taille s'il est caché. */
export function normaliserParams(p: ParamsDecoupageRag): ParamsDecoupageRag {
  const sortie: ParamsDecoupageRag = {
    methode: p.methode,
    unite: p.unite,
    taille: p.taille,
    chevauchement: p.chevauchement,
    taille_max: p.taille_max,
  };
  if (avecValeur(p.methode)) sortie.valeur = p.valeur ?? "";
  if (!champsVisibles(p.methode).chevauchement) {
    const plafond = Math.max(0, Math.ceil(p.taille / 2) - 1);
    sortie.chevauchement = Math.min(Math.max(0, p.chevauchement), plafond);
  }
  return sortie;
}

/** Clé canonique d'un jeu de paramètres, pour comparer sans tenir compte de l'ordre des clés ni d'une valeur inutile. */
export function clePourParams(p: ParamsDecoupageRag): string {
  const n = normaliserParams(p);
  return JSON.stringify([n.methode, n.valeur ?? null, n.unite, n.taille, n.chevauchement, n.taille_max]);
}

export function paramsEgaux(a: ParamsDecoupageRag, b: ParamsDecoupageRag): boolean {
  return clePourParams(a) === clePourParams(b);
}

/** Résumé d'une ligne : « Phrases · 512 jetons · chevauchement 64 ». */
export function resumeParams(p: ParamsDecoupageRag): string {
  const unite = p.unite === "jetons" ? "jetons" : "caractères";
  const morceaux: string[] = [LIBELLES_METHODE[p.methode]];
  if (avecValeur(p.methode) && (p.valeur ?? "") !== "") morceaux.push(`« ${p.valeur} »`);
  morceaux.push(`${nombre(p.taille)} ${unite}`);
  if (champsVisibles(p.methode).chevauchement) morceaux.push(`chevauchement ${nombre(p.chevauchement)}`);
  return morceaux.join(" · ");
}

/* Règles par type de fichier */

export interface RegleExtension {
  /** Identifiant stable de la ligne dans l'interface (l'extension se modifie à la saisie). */
  cle: number;
  ext: string;
  params: ParamsDecoupageRag;
}

/** Extension choisie, ramenée à sa forme de clé : sans point ni espace, en minuscules. */
export function extensionNormalisee(brut: string): string {
  return brut.trim().replace(/^\.+/, "").toLowerCase();
}

const estExtension = (e: string): e is ExtensionRag => (EXTENSIONS_RAG as readonly string[]).includes(e);

/** Erreur de l'extension d'une règle (vide, inconnue, doublon), par clé de ligne ; un objet vide veut dire « valide ». */
export function erreursRegles(regles: readonly RegleExtension[]): Record<number, string> {
  const vues = new Set<string>();
  const erreurs: Record<number, string> = {};
  for (const r of regles) {
    const ext = extensionNormalisee(r.ext);
    if (ext === "") erreurs[r.cle] = "Choisissez un type de fichier.";
    else if (!estExtension(ext)) erreurs[r.cle] = "Ce type de fichier n’est pas pris en charge.";
    else if (vues.has(ext)) erreurs[r.cle] = "Une règle existe déjà pour ce type de fichier.";
    vues.add(ext);
  }
  return erreurs;
}

export function reglesDe(d: DecoupageRag, cle: () => number): RegleExtension[] {
  const regles: RegleExtension[] = [];
  for (const [ext, params] of Object.entries(d.par_extension))
    if (params !== undefined) regles.push({ cle: cle(), ext, params: { ...params } });
  return regles;
}

/** Découpage complet d'une collection depuis le brouillon : paramètres de base et règles dans l'ordre de saisie. */
export function decoupageDeBrouillon(
  base: ParamsDecoupageRag,
  regles: readonly RegleExtension[],
): DecoupageRag {
  const par_extension: DecoupageRag["par_extension"] = {};
  for (const r of regles) {
    const ext = extensionNormalisee(r.ext);
    if (estExtension(ext)) par_extension[ext] = normaliserParams(r.params);
  }
  return { ...normaliserParams(base), par_extension };
}

/** Clé canonique d'un découpage de collection : les règles sont triées par extension. */
export function clePourCollection(d: DecoupageRag): string {
  const regles = Object.entries(d.par_extension)
    .filter((e): e is [string, ParamsDecoupageRag] => e[1] !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, p]) => [k, clePourParams(p)]);
  return JSON.stringify([clePourParams(paramsDe(d)), regles]);
}

/** Paramètres qui s'appliquent à une extension : sa règle si elle existe, sinon la base de la collection. */
export function paramsPourExtension(d: DecoupageRag, ext: string): ParamsDecoupageRag {
  const e = extensionNormalisee(ext);
  return (estExtension(e) ? d.par_extension[e] : undefined) ?? paramsDe(d);
}

/** Paramètres proposés à une nouvelle règle ou à un découpage propre : ceux du défaut du serveur. */
export function paramsParDefaut(): ParamsDecoupageRag {
  return paramsDe(DECOUPAGE_RAG_DEFAUT);
}

/* Découpage d'un document et redécoupes d'un aperçu */

/** Clé canonique d'un découpage de document (`null` : il hérite de la collection). */
export function clePourDocument(d: DecoupageDocumentRag | null): string {
  if (d === null || (d.params === undefined && d.redecoupes.length === 0)) return "heritage";
  const redecoupes = [...d.redecoupes]
    .sort((a, b) => a.index - b.index)
    .map((r) => [r.index, clePourParams(r.params)]);
  return JSON.stringify([d.params === undefined ? null : clePourParams(d.params), redecoupes]);
}

/** Corps de la demande : `null` quand le document hérite sans aucune redécoupe, sinon ses paramètres propres et ses redécoupes. */
export function decoupageDeDocument(
  propre: ParamsDecoupageRag | null,
  redecoupes: readonly RedecoupeRag[],
): DecoupageDocumentRag | null {
  if (propre === null && redecoupes.length === 0) return null;
  const d: DecoupageDocumentRag = {
    redecoupes: redecoupes.map((r) => ({ ...r, params: normaliserParams(r.params) })),
  };
  if (propre !== null) d.params = normaliserParams(propre);
  return d;
}

/** Ajoute une redécoupe ou remplace celle du même passage d'origine. */
export function empilerRedecoupe(
  redecoupes: readonly RedecoupeRag[],
  nouvelle: RedecoupeRag,
): RedecoupeRag[] {
  return [...redecoupes.filter((r) => r.index !== nouvelle.index), nouvelle].sort(
    (a, b) => a.index - b.index,
  );
}

export function retirerRedecoupe(redecoupes: readonly RedecoupeRag[], index: number): RedecoupeRag[] {
  return redecoupes.filter((r) => r.index !== index);
}

/** Rang, dans le découpage de base, du passage affiché à `position` : les passages issus d'une redécoupe portent le rang de leur origine. */
export function indexDeBase(passages: readonly PassageListeRag[], position: number): number {
  let suivant = 0;
  for (let i = 0; i <= position && i < passages.length; i++) {
    const p = passages[i] as PassageListeRag;
    if (p.redecoupe_de !== null) {
      suivant = p.redecoupe_de + 1;
      if (i === position) return p.redecoupe_de;
    } else {
      if (i === position) return suivant;
      suivant++;
    }
  }
  return suivant;
}

/** Début d'un groupe de passages redécoupés : le passage d'origine à défaire. */
export function debutDeRedecoupe(passages: readonly PassageListeRag[], position: number): boolean {
  const p = passages[position];
  if (p === undefined || p.redecoupe_de === null) return false;
  return passages[position - 1]?.redecoupe_de !== p.redecoupe_de;
}

/** Plus grand nombre de jetons d'un passage de la liste. */
export function jetonsMax(passages: readonly PassageListeRag[]): number {
  return passages.reduce((m, p) => Math.max(m, p.jetons), 0);
}

/** Largeur d'un passage dans la liste, de 2 à 100 (le plus long vaut 100) ; 0 sans mesure. */
export function largeurRelative(jetons: number, max: number): number {
  return max <= 0 ? 0 : Math.max(2, Math.round((jetons / max) * 100));
}

/** Message d'un échec des routes de découpage. */
export function messageEchecDecoupage(code: string | null, message: string, parDefaut: string): string {
  switch (code) {
    case "regex_invalide":
      return "L’expression régulière est invalide.";
    case "sources_fermees":
      return "Le propriétaire n’a pas ouvert les documents sources de cette collection.";
    case "extrait_indisponible":
      return "Réindexez le document pour obtenir l’aperçu.";
    case "trop_de_passages":
      return "Ce découpage donne trop de passages : agrandissez la taille.";
    case "decoupage_trop_long":
      return "Le calcul est trop long : simplifiez les redécoupes ou le découpage.";
    default:
      return message !== "" ? message : parDefaut;
  }
}

/** Appel différé : chaque appel annule le précédent ; `annuler` abandonne l'appel en attente. */
export function creerAntirebond(
  rappel: () => void,
  delaiMs: number,
): { planifier: () => void; annuler: () => void } {
  let minuterie: ReturnType<typeof setTimeout> | null = null;
  const annuler = (): void => {
    if (minuterie !== null) clearTimeout(minuterie);
    minuterie = null;
  };
  return {
    planifier(): void {
      annuler();
      minuterie = setTimeout(() => {
        minuterie = null;
        rappel();
      }, delaiMs);
    },
    annuler,
  };
}
