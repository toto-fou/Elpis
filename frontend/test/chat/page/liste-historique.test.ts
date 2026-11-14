// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/liste-historique.test.ts — historique du volet : une mise à jour du volet (skin, réglages, marque) ne relit la position d'aucune ligne ; un changement de l'historique, si (déplacement animé). */
import { nextTick } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, expect, it, vi } from "vitest";

import BarreLaterale from "../../../src/components/chat/page/BarreLaterale.vue";
import { CLE_BARRE } from "../../../src/features/chat/page/domaines";
import { barre, demonter, monter } from "./montage";

afterEach(() => {
  vi.restoreAllMocks();
  demonter();
});

it("skin, réglages ou marque changés : aucune lecture de position pendant le rendu du volet", async () => {
  const b = barre();
  const hote = monter(BarreLaterale, [[CLE_BARRE as InjectionKey<object>, b]]);
  const positions = vi.spyOn(Element.prototype, "getBoundingClientRect");
  const d = b as Record<string, unknown>;
  for (const [cle, valeur] of [
    ["skinCourant", { mascot: "kiki" }],
    ["settings", { enable_mcp: true, enable_editor: true }],
    ["nomMarque", "Atelier"],
  ] as const) {
    d[cle] = valeur;
    await nextTick();
  }
  expect(hote.textContent).toContain("Atelier");
  expect(positions).not.toHaveBeenCalled();
  d["groupedHistory"] = [{ key: "j", label: "Aujourd'hui", items: [{ id: "c2", title: "Revue PR" }] }];
  await nextTick();
  expect(positions).toHaveBeenCalled();
});
