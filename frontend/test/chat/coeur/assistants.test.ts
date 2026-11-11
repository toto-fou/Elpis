// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/assistants.test.ts — descripteurs des assistants de création (skill, routine, apparence, agent) : champs, lignes du cadrage envoyé, valeurs initiales. */
import { describe, expect, it } from "vitest";

import {
  ASSISTANTS,
  lignesCadrage,
  PREFIXE_FONCTION,
  valeursInitiales,
} from "../../../src/features/chat/coeur/assistants";

describe("assistants", () => {
  it("le cadrage skill garde les libellés historiques et saute les champs vides", () => {
    const d = ASSISTANTS["skill"]!;
    const l = lignesCadrage(d, { sujet: " Déployer ", objectif: "", domaine: "ops", scripts: "oui" });
    expect(l.slice(0, 4)).toEqual([
      "Je veux créer un nouveau skill. Voici le cadrage initial :",
      "**Sujet :** Déployer",
      "**Domaine :** ops",
      "**Scripts à embarquer :** oui",
    ]);
    expect(d.categories).toEqual(["skill", "fs"]);
    expect(d.skill.name).toBe("creer-un-skill");
  });

  it("le cadrage routine exige l'objectif et épingle creer-une-routine", () => {
    const d = ASSISTANTS["routine"]!;
    expect(d.champs.filter((c) => c.requis).map((c) => c.cle)).toEqual(["objectif"]);
    expect(d.categories).toEqual(["skill"]);
    expect(Object.keys(d.manquantes ?? {})).toEqual(["skill", "reglage:routine_tool_enabled"]);
    expect(d.skill.name).toBe("creer-une-routine");
    expect(lignesCadrage(d, { objectif: "Veille", quand: "lundi 8 h" })).toContain("**Quand :** lundi 8 h");
  });

  it("le cadrage apparence n'ouvre que la catégorie skill et épingle le skill apparence", () => {
    const d = ASSISTANTS["apparence"]!;
    expect(d.champs.filter((c) => c.requis).map((c) => c.cle)).toEqual(["ambiance"]);
    expect(d.categories).toEqual(["skill"]);
    expect(Object.keys(d.manquantes ?? {})).toEqual(["skill"]);
    expect(d.skill.name).toBe("apparence");
    const l = lignesCadrage(d, { ambiance: "Carnet", couleurs: "", base: "sombre" });
    expect(l).toContain("**Base :** sombre");
    expect(l.join("\n")).not.toContain("Couleurs");
  });

  it("le cadrage agent exige nom et mission, épingle creer-un-agent et prévient si les sous-agents sont coupés", () => {
    const d = ASSISTANTS["agent"]!;
    expect(d.titre).toBe("Créer un agent avec l'assistant");
    expect(d.champs.map((c) => [c.cle, c.type, !!c.requis])).toEqual([
      ["nom", "input", true],
      ["mission", "textarea", true],
      ["outils", "input", false],
      ["contraintes", "textarea", false],
    ]);
    expect(d.categories).toEqual(["skill"]);
    expect(Object.keys(d.manquantes ?? {})).toEqual(["skill", `${PREFIXE_FONCTION}agents`]);
    expect(d.skill.name).toBe("creer-un-agent");
    expect(d.consigne).toContain("ask_user");
    const l = lignesCadrage(d, { nom: "revue-sql", mission: "Relire les migrations", contraintes: "" });
    expect(l.slice(0, 3)).toEqual([
      "Je veux créer un nouvel agent personnel. Voici le cadrage initial :",
      "**Nom :** revue-sql",
      "**Mission :** Relire les migrations",
    ]);
  });

  it("valeursInitiales prérempli seulement les clés connues", () => {
    expect(valeursInitiales(ASSISTANTS["routine"]!, { objectif: "x", autre: "y" })).toEqual({
      objectif: "x",
      quand: "",
      resultat: "",
    });
  });
});
