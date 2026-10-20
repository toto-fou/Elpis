// SPDX-License-Identifier: MIT
/** packages/rag/src/bm25.ts — BM25 creux côté client : tokenisation FR/EN, hachage 32 bits, composante tf ; l'IDF est calculé par Qdrant (modifier idf). */

export interface VecteurCreux {
  indices: number[];
  values: number[];
}

export interface OptionsBm25 {
  k1?: number;
  b?: number;
  longueurMoyenne?: number;
}

/** Paramètres BM25 usuels ; la longueur moyenne est celle d'un passage de 512 jetons (≈ 1 700 caractères, ≈ 200 mots hors mots vides). */
export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
export const BM25_LONGUEUR_MOYENNE = 200;

const LONGUEUR_MAX_TOKEN = 64;
const MARQUES = /\p{M}+/gu;
const MOTS = /[\p{L}\p{N}]+/gu;
const CHIFFRE = /\p{N}/u;
const ENCODEUR = new TextEncoder();

/** Minuscules, NFKD sans diacritiques, ligatures œ æ et ß dépliées. */
export function normaliserTexte(texte: string): string {
  return texte
    .toLowerCase()
    .normalize("NFKD")
    .replace(MARQUES, "")
    .replace(/œ/g, "oe")
    .replace(/æ/g, "ae")
    .replace(/ß/g, "ss");
}

const MOTS_VIDES_BRUTS = `
le la les l un une des du de au aux et ou en a à y se sa son ses ce cet cette ces mon ma mes ton ta tes
notre nos votre vos leur leurs je tu il elle on nous vous ils elles me te lui eux
par sur sous dans pour avec sans chez vers entre contre dont où que qui quoi quel quelle quels quelles
est sont été être avoir ai as ont avons avez suis es sommes êtes sera seront était étaient fait faire
ne pas plus très bien tout tous toute toutes aussi mais donc car ni si comme alors
the a an and or but of to in on at by for from with without as is are was were be been being
have has had do does did this that these those it its they them their he she his her we our you your
not no can could will would should may might must there here than then so if
`;

const MOTS_VIDES: ReadonlySet<string> = new Set(
  MOTS_VIDES_BRUTS.split(/\s+/)
    .filter((m) => m !== "")
    .map(normaliserTexte),
);

/** Tokens d'un texte : mots alphanumériques normalisés, sans mots vides, au moins 2 caractères (un chiffre seul reste). */
export function tokeniser(texte: string): string[] {
  const sortie: string[] = [];
  for (const m of normaliserTexte(texte).matchAll(MOTS)) {
    const t = m[0].length > LONGUEUR_MAX_TOKEN ? m[0].slice(0, LONGUEUR_MAX_TOKEN) : m[0];
    if (t.length < 2 && !CHIFFRE.test(t)) continue;
    if (MOTS_VIDES.has(t)) continue;
    sortie.push(t);
  }
  return sortie;
}

/** FNV-1a 32 bits de l'UTF-8 du token : stable d'un processus et d'une version à l'autre (indice de vecteur creux). */
export function hacherToken(token: string): number {
  let h = 0x811c9dc5;
  for (const octet of ENCODEUR.encode(token)) {
    h = Math.imul(h ^ octet, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function parIndice(tokens: readonly string[]): Map<number, number> {
  const frequences = new Map<number, number>();
  for (const t of tokens) {
    const i = hacherToken(t);
    frequences.set(i, (frequences.get(i) ?? 0) + 1);
  }
  return frequences;
}

function trie(valeurs: Map<number, number>): VecteurCreux {
  const indices = [...valeurs.keys()].sort((a, b) => a - b);
  return { indices, values: indices.map((i) => valeurs.get(i) ?? 0) };
}

/** Vecteur creux d'un passage : tf·(k1+1) / (tf + k1·(1 − b + b·longueur/moyenne)) par token haché. */
export function vecteurDocument(texte: string, options: OptionsBm25 = {}): VecteurCreux {
  const k1 = options.k1 ?? BM25_K1;
  const b = options.b ?? BM25_B;
  const moyenne = options.longueurMoyenne ?? BM25_LONGUEUR_MOYENNE;
  const tokens = tokeniser(texte);
  const normeLongueur = 1 - b + (b * tokens.length) / Math.max(1, moyenne);
  const poids = new Map<number, number>();
  for (const [i, tf] of parIndice(tokens)) poids.set(i, (tf * (k1 + 1)) / (tf + k1 * normeLongueur));
  return trie(poids);
}

/** Vecteur creux d'une requête : un poids de 1 par token distinct (Qdrant applique l'IDF). */
export function vecteurRequete(texte: string): VecteurCreux {
  const poids = new Map<number, number>();
  for (const i of parIndice(tokeniser(texte)).keys()) poids.set(i, 1);
  return trie(poids);
}

/** Texte indexé en BM25 pour un passage : chemin des titres puis texte (les titres portent des mots-clés). */
export function texteBm25(passage: { heading_path: string; text: string }): string {
  return passage.heading_path === "" ? passage.text : `${passage.heading_path}\n${passage.text}`;
}
