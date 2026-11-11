// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/appels.test.ts — regroupement du tour par appel du modèle : ouverture sur la réflexion, sinon sur le texte, actions rattachées à l'appel en cours. */
import { describe, expect, it } from "vitest";

import { appelsDuTour } from "../../../src/features/chat/message/appels";
import type { AppelTour } from "../../../src/features/chat/message/appels";
import { chronologieTour } from "../../../src/features/chat/message/chronologie";
import type { EtapeOutil } from "../../../src/features/chat/outils/types";

const lit = (path: string, seg: number, extra: Partial<EtapeOutil> = {}): EtapeOutil => ({
  name: "read_file",
  status: "done",
  args: { path },
  durationMs: 1,
  seg,
  ...extra,
});
/** Clés de chaque appel : réflexion, texte, actions. */
const forme = (appels: AppelTour[]) =>
  appels.map((a) => [a.reflexion?.cle ?? null, a.texte?.cle ?? null, a.actions.map((b) => b.cle)]);

describe("appelsDuTour", () => {
  it("réflexion, texte et actions d'un même appel ; la réflexion finale ouvre un dernier appel", () => {
    const blocs = chronologieTour({
      segTexts: ["Je lis.", "Je teste."],
      toolSteps: [
        lit("a", 0, { thinking: "d'abord", callId: "a" }),
        { name: "execute_shell", status: "done", seg: 1, args: { command: "npm test" }, callId: "c" },
      ],
      thinking: "je conclus",
    });
    expect(forme(appelsDuTour(blocs))).toEqual([
      ["r:0", "t:0", ["e:0"]],
      [null, "t:1", ["e:1"]],
      ["r:fin", null, []],
    ]);
  });

  it("un texte après des actions ouvre un nouvel appel ; juste après une réflexion, il la rejoint", () => {
    const blocs = chronologieTour({
      segTexts: ["Premier.", "Entre-deux.", "Troisième."],
      toolSteps: [lit("a", 0), lit("b", 2, { thinking: "plus tard" })],
    });
    expect(forme(appelsDuTour(blocs))).toEqual([
      [null, "t:0", ["e:0"]],
      [null, "t:1", []],
      ["r:1", "t:2", ["e:1"]],
    ]);
  });

  it("des actions sans texte ni réflexion avant elles ouvrent leur propre appel ; tour vide : aucun appel", () => {
    const blocs = chronologieTour({ segTexts: [], toolSteps: [lit("a", 0)] });
    expect(forme(appelsDuTour(blocs))).toEqual([[null, null, ["e:0"]]]);
    expect(appelsDuTour([])).toEqual([]);
  });
});
