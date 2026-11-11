// SPDX-License-Identifier: MIT
/** frontend/test/routines/competences.test.ts — skills attachables : arbre du sélecteur, ids orphelins, élagage du payload. */
import type { ResumeSkill } from "@elpis/contracts";
import { describe, expect, it } from "vitest";

import {
  arbreSkills,
  badgeDomaine,
  elaguerSkills,
  idsConnus,
  infobulleSkill,
  libelleFeuille,
  nombreDescendants,
} from "../../src/features/routines/competences";

function skill(id: string, extra: Partial<ResumeSkill> = {}): ResumeSkill {
  return {
    name: id.split("/").pop() ?? id,
    description: `d-${id}`,
    tags: [],
    source: "user",
    domain: "",
    path: null,
    body_preview: "",
    body_length: 0,
    is_folder: false,
    skill_dir: null,
    files: [],
    license: "",
    compatibility: "",
    metadata: {},
    allowed_tools: "",
    id,
    parent_id: id.includes("/") ? id.split("/").slice(0, -1).join("/") : null,
    depth: 0,
    ...extra,
  };
}

const LISTE = [
  skill("deploy"),
  skill("deploy/x"),
  skill("seul"),
  skill("orphelin/y", { parent_id: "orphelin" }),
];

describe("skills de routine", () => {
  it("range les descendants sous leur racine et garde les orphelins à plat", () => {
    const arbre = arbreSkills(LISTE);
    expect(arbre.map((n) => [n.skill.id, n.children.map((c) => c.id)])).toEqual([
      ["deploy", ["deploy/x"]],
      ["seul", []],
      ["orphelin/y", []],
    ]);
  });

  it("élague les ids inconnus seulement une fois la liste chargée", () => {
    expect(elaguerSkills(["deploy", "fantome", " ", 3], false, [])).toEqual(["deploy", "fantome"]);
    expect(elaguerSkills(["deploy", "fantome"], true, LISTE)).toEqual(["deploy"]);
    expect(idsConnus(LISTE).has("x")).toBe(true);
  });

  it("libellés, descendants, badge et infobulle", () => {
    expect(libelleFeuille(skill("deploy/x"), skill("deploy"))).toBe("x");
    expect(nombreDescendants("deploy", true, LISTE)).toBe(1);
    expect(nombreDescendants("deploy", false, LISTE)).toBe(0);
    expect(badgeDomaine({ domain: "jenkins", id: "jenkins/deploy", name: "deploy" })).toBe("");
    expect(badgeDomaine({ domain: "ops", id: "deploy", name: "deploy" })).toBe("ops");
    expect(infobulleSkill("seul", true, LISTE)).toBe("d-seul");
    expect(infobulleSkill("ghost", true, LISTE)).toContain("introuvable");
    expect(infobulleSkill("ghost", false, LISTE)).toBe("");
  });
});
