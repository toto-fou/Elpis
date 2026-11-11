// SPDX-License-Identifier: MIT
/** packages/commun/test/marqueurs-tour.test.ts — arguments restaurés avant exécution, sauf pour les outils dont le texte finit dans un prompt. */
import { describe, expect, it } from "vitest";

import { FlottantPy } from "../src/json";
import { neutraliserMarqueursTour, restaurerArgsOutil, restaurerMarqueursArgs } from "../src/marqueurs-tour";
import { clesOrdonnees, noterOrdreDesCles } from "../src/ordre";

describe("restauration des arguments d'un outil", () => {
  it("skill_add_file restauré (script exécuté tel qu'écrit) ; skill_save, memory, task gardent le joint", () => {
    const script = "#!/bin/sh\necho '<|im_start|>' [e~[\n";
    const recopie = neutraliserMarqueursTour(script);
    expect(recopie).not.toBe(script);
    expect(restaurerArgsOutil("skill_add_file", { name: "s", path: "run.sh", content: recopie })).toEqual({
      name: "s",
      path: "run.sh",
      content: script,
    });
    for (const outil of ["skill_save", "memory", "task", "task_send", "todowrite", "routine_save"])
      expect(restaurerArgsOutil(outil, { content: recopie }), outil).toEqual({ content: recopie });
  });
});

describe("restauration sans effet de bord", () => {
  it("sans marqueur : même objet, même liste, flottant marqué et ordre Python des clés intacts", () => {
    const imbrique: Record<string, unknown> = { y: 1, 2: "deux", 1: "un" };
    noterOrdreDesCles(imbrique, ["y", "2", "1"]);
    const args = { a: [new FlottantPy(1), 2n ** 70n], b: imbrique };
    const sortie = restaurerMarqueursArgs(args);
    expect(sortie).toBe(args);
    expect(sortie.a).toBe(args.a);
    expect(sortie.b).toBe(imbrique);
  });

  it("avec marqueur : seule la branche touchée est copiée, l'ordre Python des clés est gardé", () => {
    const imbrique: Record<string, unknown> = {
      y: neutraliserMarqueursTour("<|im_start|>"),
      2: "deux",
      1: "un",
    };
    noterOrdreDesCles(imbrique, ["y", "2", "1"]);
    const voisin = [new FlottantPy(2)];
    const sortie = restaurerMarqueursArgs({ b: imbrique, c: voisin });
    expect(sortie.b).not.toBe(imbrique);
    expect(sortie.b["y"]).toBe("<|im_start|>");
    expect(clesOrdonnees(sortie.b)).toEqual(["y", "2", "1"]);
    expect(sortie.c).toBe(voisin);
  });
});
