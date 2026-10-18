// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/balises-flux.ts — découpeur en flux des balises de raisonnement (`<think>`, `<|thinking|>`) coupées entre deux morceaux SSE. */
import { ErreurPython, veritePy } from "@elpis/commun";

import { nomTypePy } from "../llm/dict-py";
import type { DecoupeurPensee } from "../llm/fournisseurs/llamacpp";
import { lowerPy } from "../python";

export type GenreSegment = "content" | "thinking";
export type Segment = [GenreSegment, string];

export const OPEN_TAGS: readonly string[] = ["<think>", "<|thinking|>"];
export const CLOSE_TAGS: readonly string[] = ["</think>", "<|/thinking|>"];
export const MAX_TAG_LEN = Math.max(...[...OPEN_TAGS, ...CLOSE_TAGS].map((b) => b.length));

/** Ce que `re.IGNORECASE` de Python accepte pour chaque lettre des balises (İ et ı pour i, K de Kelvin pour k). */
const EQUIVALENTS_RE: Readonly<Record<string, string>> = {
  t: "tT",
  h: "hH",
  i: "iI\u0130\u0131",
  n: "nN",
  k: "kK\u212a",
  g: "gG",
};

/** Motif d'une balise insensible à la casse comme Python, sans le drapeau `i` de JS (qui ignore İ et ı). */
export function motifBalise(balise: string): string {
  return Array.from(balise, (c) => {
    const equivalents = EQUIVALENTS_RE[c];
    return equivalents ? `[${equivalents}]` : c.replace(/[\\^$.*+?()[\]{}|]/u, "\\$&");
  }).join("");
}

const RE_OPEN = new RegExp(OPEN_TAGS.map(motifBalise).join("|"), "gu");
const RE_CLOSE = new RegExp(CLOSE_TAGS.map(motifBalise).join("|"), "gu");

/** Les `n` derniers points de code de `s` (moins si `s` est plus court). */
function derniersPoints(s: string, n: number): string[] {
  const sortie: string[] = [];
  let i = s.length;
  while (i > 0 && sortie.length < n) {
    const pas =
      i >= 2 && (s.charCodeAt(i - 1) & 0xfc00) === 0xdc00 && (s.charCodeAt(i - 2) & 0xfc00) === 0xd800
        ? 2
        : 1;
    sortie.unshift(s.slice(i - pas, i));
    i -= pas;
  }
  return sortie;
}

/** Plus long suffixe non vide de `tail` égal à un préfixe de `tag`, comparé point de code par point de code avec `lower()`. */
export function sharedPrefixWithTag(tail: string, tag: string): number {
  if (!tail || !tag) return 0;
  const balise = Array.from(tag);
  const queue = derniersPoints(tail, balise.length);
  for (let k = queue.length; k > 0; k--) {
    let egal = true;
    for (let x = 0; x < k && egal; x++)
      egal = lowerPy(queue[queue.length - k + x] ?? "") === lowerPy(balise[x] ?? "");
    if (egal) return k;
  }
  return 0;
}

/** Découpeur à états, un par flux : le texte part au plus tôt, seul un début possible de balise attend le morceau suivant. */
export class ThinkTagSplitter implements DecoupeurPensee {
  private enPensee = false;
  private retenu = "";

  get inThink(): boolean {
    return this.enPensee;
  }

  feed(morceau: unknown): Segment[] {
    if (!veritePy(morceau)) return [];
    if (typeof morceau !== "string")
      throw new ErreurPython("TypeError", `can only concatenate str (not "${nomTypePy(morceau)}") to str`);
    const sortie: Segment[] = [];
    const data = this.retenu + morceau;
    this.retenu = "";
    let i = 0;
    while (i < data.length) {
      const genre: GenreSegment = this.enPensee ? "thinking" : "content";
      const rx = this.enPensee ? RE_CLOSE : RE_OPEN;
      rx.lastIndex = i;
      const m = rx.exec(data);
      if (m) {
        if (m.index > i) sortie.push([genre, data.slice(i, m.index)]);
        i = m.index + m[0].length;
        this.enPensee = !this.enPensee;
        continue;
      }
      const queue = data.slice(i);
      const cibles = this.enPensee ? CLOSE_TAGS : OPEN_TAGS;
      const garde = Math.max(...cibles.map((b) => sharedPrefixWithTag(queue, b)));
      const coupe = queue.length - derniersPoints(queue, garde).join("").length;
      this.retenu = queue.slice(coupe);
      if (coupe > 0) sortie.push([genre, queue.slice(0, coupe)]);
      break;
    }
    return sortie;
  }

  /** Fin de flux : le début de balise retenu n'en était pas une, il part en texte sur le canal courant. */
  flush(): Segment[] {
    if (!this.retenu) return [];
    const sortie: Segment[] = [[this.enPensee ? "thinking" : "content", this.retenu]];
    this.retenu = "";
    return sortie;
  }
}
