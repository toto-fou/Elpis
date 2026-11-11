// SPDX-License-Identifier: MIT
/** apps/toolhost/test/securite-regex-sans-fil.test.ts — fichier du thread de calcul absent : un motif des outils est refusé, jamais exécuté sur la boucle ; l'éditeur garde son repli sur place. */
import type * as Fs from "node:fs";

import { compilerPy, ErreurPython } from "@elpis/commun";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (original) => {
  const fs = await original<typeof Fs>();
  return {
    ...fs,
    existsSync: (p: Parameters<typeof fs.existsSync>[0]) =>
      !String(p).includes("calcul-fil") && fs.existsSync(p),
  };
});

const { avecFilCalcul, REGEX_SANS_FIL } = await import("../src/fichiers/calcul-execution");

describe("thread de calcul absent", () => {
  it("motif refusé avec une ValueError lue par le modèle, sans recherche sur place", async () => {
    const m = compilerPy("(a|a)*$");
    const espion = vi.spyOn(m.re, "exec");
    const e = await avecFilCalcul((fil) => fil.present(m, "aaa!")).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErreurPython);
    expect((e as ErreurPython).type).toBe("ValueError");
    expect((e as ErreurPython).message).toBe(REGEX_SANS_FIL);
    expect(espion).not.toHaveBeenCalled();
  });

  it("le texte d'un .docx garde son repli sur place (échec du contenu, pas du thread)", async () => {
    await expect(avecFilCalcul((fil) => fil.docx(new Uint8Array([1, 2, 3])))).rejects.not.toThrow(
      REGEX_SANS_FIL,
    );
  });
});
