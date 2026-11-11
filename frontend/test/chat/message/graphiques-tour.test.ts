// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/graphiques-tour.test.ts — graphique tracé par un outil que la réponse finale ne cite pas : tracé à sa suite une fois le tour fini ; libellé « Trace » des outils chart_*. */
import { describe, expect, it } from "vitest";

import { graphiquesNonCites, refGraphique } from "../../../src/features/chat/message/graphiques-tour";
import type { EtapeOutil } from "../../../src/features/chat/outils/types";
import { texteEtape } from "../../../src/features/chat/outils/verbes";

const REF = "!9dba45deb90f";
const graphique = (extra: Partial<EtapeOutil> = {}): EtapeOutil => ({
  name: "chart_bar",
  status: "done",
  seg: 0,
  args: { title: "Budget du week-end" },
  result: JSON.stringify({ ok: true, ref: REF, chart_id: REF.slice(1) }),
  ...extra,
});

describe("graphiques non cités", () => {
  it("référence lue dans le résultat (texte ou objet) d'un outil chart_* seulement", () => {
    expect(refGraphique(graphique())).toBe(REF);
    expect(refGraphique(graphique({ result: { ref: REF } }))).toBe(REF);
    expect(refGraphique(graphique({ result: "pas du json" }))).toBe("");
    expect(refGraphique(graphique({ name: "read_file" }))).toBe("");
  });

  it("tour fini : références que la réponse finale ne cite pas, une fois chacune ; citée par la réponse ou tour en cours : rien", () => {
    const m = { segTexts: ["Je trace le budget."], content: "Le budget est prêt.", toolSteps: [graphique()] };
    expect(graphiquesNonCites(m)).toEqual([REF]);
    expect(graphiquesNonCites({ ...m, segTexts: [`Je trace ${REF}.`] })).toEqual([REF]);
    expect(graphiquesNonCites({ ...m, toolSteps: [graphique(), graphique()] })).toEqual([REF]);
    expect(graphiquesNonCites({ ...m, content: `Voici le budget :\n\n${REF}` })).toEqual([]);
    expect(graphiquesNonCites({ ...m, isStreaming: true })).toEqual([]);
  });

  it("libellé de l'étape : « Trace » et le titre du graphique", () => {
    expect(texteEtape(graphique())).toBe("Trace Budget du week-end");
    expect(texteEtape(graphique({ args: {} }))).toBe("Trace un graphique");
  });
});
