// SPDX-License-Identifier: MIT
/** frontend/test/agents/capacites.test.ts — page Agents : bande fixe de cinq cases (ordre, cadenas, absentes, lecteur d'écran), groupes, libellés et rangée du formulaire. */
import { describe, expect, it } from "vitest";

import {
  bandeCapacites,
  etiquetteAgent,
  groupesAgents,
  metaAgent,
  ONGLETS_FICHE,
  rangeeDuFormulaire,
} from "../../src/features/agents/page";
import type { RangeeAgent } from "../../src/features/reglages/agents";

const etats = (b: ReturnType<typeof bandeCapacites>): string[] => b.cases.map((c) => `${c.cle}:${c.etat}`);

describe("bande de capacités", () => {
  it("cinq cases toujours dans l'ordre Lire, Modifier, Terminal, Git, Web", () => {
    const b = bandeCapacites({ nom: "docs", livre: false, categories: ["fs", "git"], lectureSeule: false });
    expect(b.cases.map((c) => c.libelle)).toEqual(["Lire", "Modifier", "Terminal", "Git", "Web"]);
    expect(etats(b)).toEqual(["lire:oui", "modifier:oui", "terminal:non", "git:oui", "web:non"]);
    expect(b.lecteur).toBe("Peut : Lire, Modifier, Git");
  });

  it("lecture seule : un cadenas remplace Modifier, Terminal est retiré, le lecteur le dit", () => {
    const b = bandeCapacites({
      nom: "x",
      livre: false,
      categories: ["fs", "shell", "git"],
      lectureSeule: true,
    });
    expect(etats(b)).toEqual(["lire:oui", "modifier:verrou", "terminal:non", "git:oui", "web:non"]);
    expect(b.cases[1]).toMatchObject({ icone: "ph-lock-simple", titre: "Lecture seule : Modifier retiré" });
    expect(b.cases[2]?.titre).toBe("Terminal : retiré par la lecture seule");
    expect(b.lecteur).toBe("Peut : Lire, Git ; lecture seule");
    expect(b.cases[3]?.titre).toBe("Git : consultation seule, écritures retirées par la lecture seule");
  });

  it("lecture seule avec Git seul : la case Git dit que les écritures sont retirées, le lecteur aussi ; verify inchangé", () => {
    const b = bandeCapacites({ nom: "x", livre: false, categories: ["git"], lectureSeule: true });
    expect(etats(b)).toEqual(["lire:non", "modifier:non", "terminal:non", "git:oui", "web:non"]);
    expect(b.cases[3]?.titre).toBe("Git : consultation seule, écritures retirées par la lecture seule");
    expect(b.lecteur).toBe("Peut : Git ; lecture seule");
    const v = bandeCapacites({ nom: "verify", livre: true, categories: ["git"], lectureSeule: true });
    expect(v.cases[3]?.titre).toBe("Git : oui");
    expect(
      bandeCapacites({ nom: "x", livre: false, categories: ["git"], lectureSeule: false }).cases[3]?.titre,
    ).toBe("Git : oui");
  });

  it("verify ne modifie jamais ; web accordé par la catégorie navigateur ; chaque case a une infobulle", () => {
    const b = bandeCapacites({
      nom: "verify",
      livre: true,
      categories: ["shell", "fs", "browser"],
      lectureSeule: false,
    });
    expect(etats(b)).toEqual(["lire:oui", "modifier:non", "terminal:oui", "git:non", "web:oui"]);
    expect(b.cases.every((c) => c.titre.length > 0)).toBe(true);
  });

  it("catégories d'un livré inconnues : cinq cases absentes", () => {
    const b = bandeCapacites({
      nom: "explore",
      livre: true,
      categories: [],
      lectureSeule: false,
      inconnu: true,
    });
    expect(b.cases.every((c) => c.etat === "non")).toBe(true);
    expect(b.lecteur).toBe("Capacités inconnues");
  });

  it("icônes : graisse regular seulement", () => {
    const b = bandeCapacites({ nom: "x", livre: false, categories: ["fs"], lectureSeule: true });
    expect(b.cases.every((c) => /^ph-[a-z-]+$/u.test(c.icone) && !c.icone.endsWith("-fill"))).toBe(true);
  });
});

const rangee = (o: Partial<RangeeAgent>): RangeeAgent =>
  ({
    name: "a",
    template: false,
    _idx: -1,
    modified: false,
    max_iters: 0,
    thinking: "off",
    ...o,
  }) as RangeeAgent;

describe("libellés et groupes", () => {
  it("genre : Livré, Livré · personnalisé, Personnel", () => {
    expect(etiquetteAgent({ template: true, modified: false })).toBe("Livré");
    expect(etiquetteAgent({ template: true, modified: true })).toBe("Livré · personnalisé");
    expect(etiquetteAgent({ template: false, modified: false })).toBe("Personnel");
  });

  it("budget et réflexion activée seulement", () => {
    expect(metaAgent({ max_iters: 60, thinking: "inherit" })).toBe("60 appels");
    expect(metaAgent({ max_iters: 60, thinking: "on" })).toBe("60 appels · réflexion");
    expect(metaAgent({ max_iters: 0, thinking: "off" })).toBe("Budget par défaut");
  });

  it("groupes Livrés puis « Personnels · n sur MAX »", () => {
    const g = groupesAgents([rangee({ name: "explore", template: true }), rangee({ name: "docs" })], 1, 30);
    expect(g.map((x) => x.titre)).toEqual(["Livrés", "Personnels · 1 sur 30"]);
    expect(g.map((x) => x.agents.map((a) => a.name))).toEqual([["explore"], ["docs"]]);
  });

  it("rangée du formulaire : un livré par son nom, un personnel par sa place, null pour un nouvel agent", () => {
    const banque = [rangee({ name: "explore", template: true, _idx: -1 }), rangee({ name: "docs", _idx: 2 })];
    const f = (o: object) => ({ _idx: -1, _template: false, name: "", ...o }) as never;
    expect(rangeeDuFormulaire(banque, f({ _template: true, name: "explore" }))?.name).toBe("explore");
    expect(rangeeDuFormulaire(banque, f({ _idx: 2, name: "docs" }))?.name).toBe("docs");
    expect(rangeeDuFormulaire(banque, f({ name: "neuf" }))).toBeNull();
    expect(rangeeDuFormulaire(banque, null)).toBeNull();
  });

  it("onglets : quatre mots, détail en infobulle", () => {
    expect(ONGLETS_FICHE.map((o) => o.libelle)).toEqual(["Général", "Outils", "Droits", "Instructions"]);
    expect(ONGLETS_FICHE.every((o) => o.info.length > 0)).toBe(true);
  });
});
