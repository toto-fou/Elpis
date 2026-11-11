// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/capacites-agent.test.ts — `capacitesAgent` (panneau Agents) rend ce que `outilPermisSousAgent` autorise réellement, pour chaque type réglable et chaque lecture seule. */
import { capacitesAgent } from "@elpis/contracts";
import type { CleCapaciteAgent } from "@elpis/contracts";
import { outilPermisSousAgent, TYPES_AGENTS_REGLABLES } from "@elpis/securite";
import type { SousAgent } from "@elpis/securite";
import { describe, expect, it } from "vitest";

const TOUTES = ["fs", "shell", "git", "browser"];

/** Un outil représentatif par capacité : son annotation lecture seule et le serveur intégré (`pw_*`). */
const OUTILS: Readonly<
  Record<CleCapaciteAgent, { nom: string; annotationLecture: boolean; integre?: boolean }>
> = {
  lire: { nom: "read_file", annotationLecture: true },
  modifier: { nom: "write_file", annotationLecture: false },
  terminal: { nom: "execute_shell", annotationLecture: false },
  git: { nom: "git_status", annotationLecture: true },
  web: { nom: "pw_act", annotationLecture: false, integre: true },
};

describe("capacitesAgent et outilPermisSousAgent", () => {
  for (const type of TYPES_AGENTS_REGLABLES)
    for (const lectureSeule of [false, true])
      it(`${type}, lecture seule ${lectureSeule ? "vraie" : "fausse"} : « oui » ⇔ l'outil représentatif passe`, () => {
        const sa: SousAgent = { type, read_only: lectureSeule };
        for (const { cle, etat } of capacitesAgent({ type, categories: TOUTES, lectureSeule })) {
          const o = OUTILS[cle];
          const permis = outilPermisSousAgent(sa, o.nom, o.annotationLecture, o.integre ?? false);
          expect(permis, `${cle} (${o.nom})`).toBe(etat === "oui");
          if (etat === "lecture_seule") expect(lectureSeule, cle).toBe(true);
        }
      });

  it("sans la catégorie, la capacité est « non » quel que soit le type", () => {
    for (const type of TYPES_AGENTS_REGLABLES)
      expect(
        capacitesAgent({ type, categories: [], lectureSeule: false }).map((c) => c.etat),
        type,
      ).toEqual(["non", "non", "non", "non", "non"]);
  });
});
