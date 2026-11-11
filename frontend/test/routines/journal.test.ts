// SPDX-License-Identifier: MIT
/** frontend/test/routines/journal.test.ts — affichage du journal des runs : durées, texte de la réponse, aperçu, troncature. */
import { describe, expect, it } from "vitest";

import {
  apercuRun,
  classeStatut,
  fichiersRun,
  formaterDuree,
  formaterRelatif,
  libelleStatut,
  nomDeFichier,
  retirerReflexion,
  runEstTronque,
  texteDetailRun,
} from "../../src/features/routines/journal";

describe("journal des runs", () => {
  it("formate les durées par seuils", () => {
    expect(formaterDuree(null)).toBe("—");
    expect(formaterDuree(800)).toBe("800 ms");
    expect(formaterDuree(12_500)).toBe("12.5 s");
    expect(formaterDuree(42 * 60_000)).toBe("42 min");
    expect(formaterDuree(125 * 60_000)).toBe("2 h 05");
  });

  it("formate le temps relatif", () => {
    const maintenant = 1_000_000_000_000;
    expect(formaterRelatif(maintenant / 1000 - 5, maintenant)).toBe("à l'instant");
    expect(formaterRelatif(maintenant / 1000 - 300, maintenant)).toBe("il y a 5 min");
    expect(formaterRelatif(maintenant / 1000 - 7200, maintenant)).toBe("il y a 2 h");
    expect(formaterRelatif(maintenant / 1000 - 172_800, maintenant)).toBe("il y a 2 j");
    expect(formaterRelatif(undefined)).toBe("");
  });

  it("libellés et classes de statut, inconnu compris", () => {
    expect(libelleStatut("orphaned")).toBe("Interrompu");
    expect(libelleStatut("zzz")).toBe("zzz");
    expect(libelleStatut(null)).toBe("—");
    expect(classeStatut("running")).toContain("blue");
    expect(classeStatut("zzz")).toContain("slate");
  });

  it("retire la réflexion persistée, même non fermée", () => {
    expect(retirerReflexion("a<think>x</think>b")).toBe("ab");
    expect(retirerReflexion("a<think>coupé")).toBe("a");
    expect(retirerReflexion("<|thinking|>x<|/thinking|>ok")).toBe("ok");
  });

  it("choisit le texte du détail selon le statut", () => {
    expect(texteDetailRun({ status: "error", error: "boum", summary: "s" })).toBe("boum");
    expect(texteDetailRun({ status: "ok", summary: "<think>x</think>fin" })).toBe("fin");
    expect(texteDetailRun(null)).toBe("");
  });

  it("aplatit le Markdown dans l'aperçu d'une ligne", () => {
    const run = { status: "ok", summary: "## Titre\n\n- point\n| a | b |\n```js\nx\n```\nfin" };
    expect(apercuRun(run)).toBe("Titre point fin");
    expect(apercuRun({ status: "error", error: "## brut" })).toBe("## brut");
  });

  it("détecte la troncature sur le résumé brut", () => {
    expect(runEstTronque({ status: "ok", summary: "x".repeat(4000) })).toBe(true);
    expect(runEstTronque({ status: "ok", summary: "x" })).toBe(false);
    expect(runEstTronque({ status: "error", summary: "x".repeat(4000) })).toBe(false);
  });

  it("liste les fichiers et en donne le nom", () => {
    expect(fichiersRun({ files: ["a/b.txt", "c\\d.md"] })).toEqual(["a/b.txt", "c\\d.md"]);
    expect(fichiersRun({ files: null })).toEqual([]);
    expect(nomDeFichier("a/b/c.txt")).toBe("c.txt");
    expect(nomDeFichier("c\\d.md")).toBe("d.md");
  });
});
