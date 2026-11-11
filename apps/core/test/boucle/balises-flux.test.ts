// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/balises-flux.test.ts — découpeur des balises de raisonnement : textes Python coupés à toutes les positions, suites de morceaux, flux SSE consommés. */
import "../moteur-environnement";

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { pyJsonDumps } from "@elpis/commun";

import {
  MAX_TAG_LEN,
  motifBalise,
  sharedPrefixWithTag,
  ThinkTagSplitter,
} from "../../src/boucle/balises-flux";
import type { DecoupeurPensee, FluxSse } from "../../src/llm/fournisseurs/llamacpp";
import { consumeLlamaSse, SseStreamResult } from "../../src/llm/fournisseurs/llamacpp";
import { lowerPy } from "../../src/python";
import { lireVecteurs } from "../vecteurs-moteur";

type Etape = [[string, string][], boolean];
type Global = { n: number; empreinte: string };

interface Vecteurs {
  max_tag_len: number;
  equivalences: Record<string, { lower: number[]; regex: number[] }>;
  prefixes: { queue: string; balise: string; k: number }[];
  decoupes: {
    texte: string;
    entier: Etape[];
    unitaire: Global;
    coupes1: string;
    coupes2?: string;
    coupes3?: Global;
    partitions?: Global;
  }[];
  sequences: { morceaux: (string | null)[]; etapes: Etape[] }[];
  flux: {
    nom: string;
    lignes: string[];
    erreur: { type: string; message: string } | null;
    evenements: [string, string][];
    resultat: Record<string, unknown>;
    decoupeur_in_think: boolean;
  }[];
}

const V = lireVecteurs<Vecteurs>("boucle-balises");

/** Même suite d'étapes que le générateur Python : chaque `feed` (ou flush pour `null`), puis le flush final, avec l'état après chacun. */
function jouer(morceaux: readonly (string | null)[]): Etape[] {
  const sp = new ThinkTagSplitter();
  const etapes: Etape[] = [];
  for (const m of morceaux) {
    const segs = m === null ? sp.flush() : sp.feed(m);
    etapes.push([segs.map(([g, t]) => [g.charAt(0), t]), sp.inThink]);
  }
  etapes.push([sp.flush().map(([g, t]) => [g.charAt(0), t]), sp.inThink]);
  return etapes;
}

function forme(etapes: Etape[]): string {
  return pyJsonDumps(etapes, { ensureAscii: true, separators: [",", ":"] });
}

function h8(etapes: Etape[]): string {
  return createHash("sha256").update(forme(etapes), "ascii").digest("hex").slice(0, 8);
}

function globale(variantes: Iterable<string[]>): Global {
  const h = createHash("sha256");
  let n = 0;
  for (const morceaux of variantes) {
    h.update(forme(jouer(morceaux)) + "\n", "ascii");
    n += 1;
  }
  return { n, empreinte: h.digest("hex").slice(0, 16) };
}

function morceaux(points: readonly string[], coupes: readonly number[]): string[] {
  const bornes = [0, ...coupes, points.length];
  return bornes.slice(1).map((b, i) => points.slice(bornes[i], b).join(""));
}

function* combinaisons(n: number, k: number, debut = 1, prefixe: number[] = []): Generator<number[]> {
  if (prefixe.length === k) {
    yield prefixe;
    return;
  }
  for (let i = debut; i < n; i++) yield* combinaisons(n, k, i + 1, [...prefixe, i]);
}

function* partitions(points: readonly string[]): Generator<string[]> {
  const n = points.length;
  for (let masque = 0; masque < 2 ** Math.max(0, n - 1); masque++) {
    const coupes: number[] = [];
    for (let b = 0; b < n - 1; b++) if ((masque >> b) & 1) coupes.push(b + 1);
    yield morceaux(points, coupes);
  }
}

/** Compare deux suites d'empreintes de 8 caractères ; nomme la première variante qui diffère. */
function comparerSuites(attendu: string, variantes: number[][], points: string[], texte: string): void {
  const obtenu = variantes.map((c) => h8(jouer(morceaux(points, c)))).join("");
  if (obtenu === attendu) return;
  const i = variantes.findIndex((_, j) => obtenu.slice(8 * j, 8 * j + 8) !== attendu.slice(8 * j, 8 * j + 8));
  const coupes = variantes[i] ?? [];
  expect
    .soft(jouer(morceaux(points, coupes)), `${JSON.stringify(texte)} coupé en ${coupes.join(",")}`)
    .toBe("empreinte Python différente");
  expect(obtenu.length).toBe(attendu.length);
}

describe("équivalences de casse de Python sur les lettres des balises", () => {
  it("`lower()` (préfixe retenu) et `re.IGNORECASE` (recherche) : mêmes caractères sur les 1 114 112 points de code", () => {
    expect(MAX_TAG_LEN).toBe(V.max_tag_len);
    const cles = Object.keys(V.equivalences);
    const lower: Record<string, number[]> = Object.fromEntries(cles.map((b) => [b, []]));
    const regex: Record<string, number[]> = Object.fromEntries(cles.map((b) => [b, []]));
    const motifs = cles.map((b) => [b, new RegExp(`^(?:${motifBalise(b)})$`, "u")] as const);
    const cibles = cles.map((b) => [b, lowerPy(b)] as const);
    for (let cp = 0; cp < 0x110000; cp++) {
      const c = String.fromCodePoint(cp);
      const l = lowerPy(c);
      for (const [b, lb] of cibles) if (l === lb) lower[b]?.push(cp);
      for (const [b, rx] of motifs) if (rx.test(c)) regex[b]?.push(cp);
    }
    for (const b of cles) {
      expect(lower[b], `lower ${b}`).toEqual(V.equivalences[b]?.lower);
      expect(regex[b], `regex ${b}`).toEqual(V.equivalences[b]?.regex);
    }
  });

  it("préfixe partagé avec une balise : mêmes longueurs que `_shared_prefix_with_tag`", () => {
    expect(V.prefixes.length).toBeGreaterThan(150);
    for (const p of V.prefixes)
      expect(sharedPrefixWithTag(p.queue, p.balise), `${JSON.stringify(p.queue)} / ${p.balise}`).toBe(p.k);
  });
});

describe("textes Python rejoués coupés à toutes les positions", () => {
  it("le corpus couvre balises partielles, imbrications, code, appels d'outil et Unicode", () => {
    expect(V.decoupes.length).toBeGreaterThanOrEqual(75);
    expect(V.decoupes.filter((d) => d.partitions).length).toBeGreaterThanOrEqual(20);
    expect(V.decoupes.filter((d) => d.coupes3).length).toBeGreaterThanOrEqual(55);
    expect(V.decoupes.filter((d) => d.coupes2 !== undefined).length).toBeGreaterThanOrEqual(70);
  });

  for (const d of V.decoupes) {
    it(`${JSON.stringify(d.texte).slice(0, 60)}`, () => {
      const points = Array.from(d.texte);
      const n = points.length;
      expect(jouer(d.texte ? [d.texte] : [])).toEqual(d.entier);
      expect(globale([points])).toEqual(d.unitaire);
      const simples = [...combinaisons(n, 1)];
      comparerSuites(d.coupes1, simples, points, d.texte);
      if (d.coupes2 !== undefined) comparerSuites(d.coupes2, [...combinaisons(n, 2)], points, d.texte);
      if (d.coupes3)
        expect(
          globale(
            (function* () {
              for (const c of combinaisons(n, 3)) yield morceaux(points, c);
            })(),
          ),
        ).toEqual(d.coupes3);
      if (d.partitions) expect(globale(partitions(points))).toEqual(d.partitions);
    });
  }
});

describe("suites de morceaux explicites (morceaux vides, flush au milieu)", () => {
  it("mêmes segments et même état après chaque morceau que Python", () => {
    expect(V.sequences.length).toBeGreaterThanOrEqual(20);
    for (const s of V.sequences) expect(jouer(s.morceaux), JSON.stringify(s.morceaux)).toEqual(s.etapes);
  });
});

class FauxFlux implements FluxSse {
  private readonly lignes: readonly string[];

  constructor(lignes: readonly string[]) {
    this.lignes = lignes;
  }

  async *aiterLines(): AsyncGenerator<string> {
    for (const l of this.lignes) yield l;
    await Promise.resolve();
  }

  aclose(): Promise<void> {
    return Promise.resolve();
  }
}

describe("flux SSE consommés avec le vrai découpeur (branché sur `consumeLlamaSse`)", () => {
  for (const f of V.flux) {
    it(f.nom, async () => {
      const evenements: [string, string][] = [];
      const puits = new SseStreamResult();
      const decoupeur: DecoupeurPensee = new ThinkTagSplitter();
      let erreur: { type: string; message: string } | null = null;
      try {
        await consumeLlamaSse(new FauxFlux(f.lignes), {
          tagSplitter: decoupeur,
          reqId: "r1",
          userId: "u",
          onThinkingToken: (t) => void evenements.push(["pense", t]),
          onContentToken: (t) => void evenements.push(["contenu", t]),
          sink: puits,
        });
      } catch (e) {
        erreur = { type: (e as Error).name, message: (e as Error).message };
      }
      expect(erreur).toEqual(f.erreur);
      expect(evenements).toEqual(f.evenements);
      expect({
        content: puits.content(),
        thinking: puits.thinking(),
        in_think: puits.inThink,
        pre_emis: puits.streamPreEmittedThinking,
        reroute: puits.reroutedThinkChars,
        finish_reason: puits.finishReason,
        usage: puits.usage,
      }).toEqual(f.resultat);
      expect(decoupeur.inThink).toBe(f.decoupeur_in_think);
    });
  }
});

describe("comportements des tests pytest (sans fuite de balise)", () => {
  it("un caractère dont la minuscule change de longueur ne décale plus la découpe (İ)", () => {
    expect(new ThinkTagSplitter().feed("İ<think>abc</think>fin")).toEqual([
      ["content", "İ"],
      ["thinking", "abc"],
      ["content", "fin"],
    ]);
    expect(new ThinkTagSplitter().feed("a<THINK>b</Think>c")).toEqual([
      ["content", "a"],
      ["thinking", "b"],
      ["content", "c"],
    ]);
  });

  it("une balise coupée entre deux morceaux est recollée, dans les deux dialectes", () => {
    const sp = new ThinkTagSplitter();
    expect(sp.feed("avant <thi")).toEqual([["content", "avant "]]);
    expect(sp.feed("nk>dedans</think>après")).toEqual([
      ["thinking", "dedans"],
      ["content", "après"],
    ]);
    const alt = new ThinkTagSplitter();
    expect(alt.feed("avant <|thin")).toEqual([["content", "avant "]]);
    expect(alt.feed("king|>dedans<|/thinking|>après")).toEqual([
      ["thinking", "dedans"],
      ["content", "après"],
    ]);
  });

  it("`</think>` coupé en fin de morceau ferme bien le raisonnement ; un `<think>` sans fin laisse inThink", () => {
    const sp = new ThinkTagSplitter();
    const segs = [...sp.feed("<think>raisonnement</thi"), ...sp.feed("nk>la réponse visible"), ...sp.flush()];
    expect(segs).toEqual([
      ["thinking", "raisonnement"],
      ["content", "la réponse visible"],
    ]);
    expect(sp.inThink).toBe(false);
    const ouvert = new ThinkTagSplitter();
    expect([
      ...ouvert.feed("<think>tout est "),
      ...ouvert.feed("du raisonnement"),
      ...ouvert.flush(),
    ]).toEqual([
      ["thinking", "tout est "],
      ["thinking", "du raisonnement"],
    ]);
    expect(ouvert.inThink).toBe(true);
  });

  it("un marqueur d'appel d'outil n'est ni retenu ni avalé : il passe sur le canal courant", () => {
    const sp = new ThinkTagSplitter();
    const segs = [...sp.feed("<t"), ...sp.feed('ool_call>{"name": "f"}</tool_call>'), ...sp.flush()];
    expect(segs.map((s) => s[1]).join("")).toBe('<tool_call>{"name": "f"}</tool_call>');
    expect(segs.every((s) => s[0] === "content")).toBe(true);
  });

  it("texte sans balise : aucune partie retenue au-delà d'un début possible de balise", () => {
    const sp = new ThinkTagSplitter();
    expect(sp.feed("hello world")).toEqual([["content", "hello world"]]);
    expect(sp.flush()).toEqual([]);
    expect(sp.feed("x <|thinking|")).toEqual([["content", "x "]]);
    expect(sp.flush()).toEqual([["content", "<|thinking|"]]);
  });

  it("un morceau qui n'est pas du texte lève comme la concaténation de Python ; un morceau vide ne fait rien", () => {
    const sp = new ThinkTagSplitter();
    expect(sp.feed("")).toEqual([]);
    expect(sp.feed(null)).toEqual([]);
    expect(() => sp.feed(5)).toThrow('can only concatenate str (not "int") to str');
    expect(() => sp.feed({ a: 1 })).toThrow('can only concatenate str (not "dict") to str');
  });
});

describe("propriété : sans les équivalents İ et ı, la découpe ne change rien au texte classé", () => {
  it("contenu et raisonnement concaténés identiques quelle que soit la découpe (aucune fuite ni perte)", () => {
    const sansIdot = V.decoupes.filter((d) => !/[\u0130\u0131]/u.test(d.texte));
    for (const d of sansIdot) {
      const points = Array.from(d.texte);
      const reference = classes(jouer(d.texte ? [d.texte] : []));
      for (const c of combinaisons(points.length, 2))
        expect(classes(jouer(morceaux(points, c))), `${JSON.stringify(d.texte)} / ${c.join(",")}`).toEqual(
          reference,
        );
    }
  });
});

function classes(etapes: Etape[]): { c: string; t: string; fin: boolean } {
  const tout = etapes.flatMap((e) => e[0]);
  return {
    c: tout
      .filter((s) => s[0] === "c")
      .map((s) => s[1])
      .join(""),
    t: tout
      .filter((s) => s[0] === "t")
      .map((s) => s[1])
      .join(""),
    fin: etapes[etapes.length - 1]?.[1] ?? false,
  };
}
