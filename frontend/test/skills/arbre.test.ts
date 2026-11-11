// SPDX-License-Identifier: MIT
/** frontend/test/skills/arbre.test.ts — arbre des skills : domaines, sous-skills, fichiers, filtre, frontmatter, slug. */
import type { ResumeSkill } from "@elpis/contracts";
import { describe, expect, it } from "vitest";

import {
  clesDepliables,
  construireArbres,
  descendants,
  enfants,
  filDAriane,
  filtrerInventaire,
  inventaireVide,
  libellePortee,
  partieDePortee,
  retirerFrontmatter,
  slugClient,
} from "../../src/features/skills/arbre";

function skill(id: string, extra: Partial<ResumeSkill> = {}): ResumeSkill {
  const nom = id.split("/").pop() ?? id;
  return {
    name: nom,
    description: `d-${nom}`,
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

describe("arbre des skills", () => {
  it("range sous-skills et fichiers, regroupe par domaine, remonte le package homonyme", () => {
    const inv = inventaireVide();
    inv.user = [
      skill("jenkins", { domain: "jenkins", files: ["run.sh"] }),
      skill("jenkins/deploy", { domain: "jenkins" }),
      skill("a", { domain: "ops" }),
      skill("b", { domain: "ops" }),
      skill("libre"),
    ];
    const arbre = construireArbres(inv).user;
    expect(arbre.map((n) => [n.kind, n.label])).toEqual([
      ["skill", "jenkins"],
      ["domain", "ops"],
      ["skill", "libre"],
    ]);
    const jenkins = arbre[0];
    expect(jenkins?.childSkillCount).toBe(1);
    expect(jenkins?.children.map((c) => [c.kind, c.label])).toEqual([
      ["skill", "deploy"],
      ["file", "run.sh"],
    ]);
    expect(arbre[1]?.children).toHaveLength(2);
  });

  it("liste les clés dépliables", () => {
    const inv = inventaireVide();
    inv.global = [skill("p"), skill("p/c")];
    expect([...clesDepliables(construireArbres(inv).global)]).toEqual(["global:p"]);
  });

  it("filtre sur nom, description, domaine et tags", () => {
    const inv = inventaireVide();
    inv.user = [skill("x", { tags: ["deploy"] }), skill("y", { domain: "ops" })];
    expect(filtrerInventaire(inv, "deploy").user.map((s) => s.id)).toEqual(["x"]);
    expect(filtrerInventaire(inv, " OPS ").user.map((s) => s.id)).toEqual(["y"]);
    expect(filtrerInventaire(inv, "").user).toHaveLength(2);
  });

  it("descendants, enfants et fil d'Ariane", () => {
    const inv = inventaireVide();
    inv.user = [skill("p"), skill("p/c"), skill("p/c/d")];
    expect(descendants(inv, "user", "p").map((s) => s.id)).toEqual(["p/c", "p/c/d"]);
    expect(enfants(inv, inv.user[0] ?? null).map((s) => s.id)).toEqual(["p/c"]);
    expect(filDAriane(inv, inv.user[2] ?? null).map((s) => s.id)).toEqual(["p", "p/c"]);
    expect(filDAriane(inv, inv.user[0] ?? null)).toEqual([]);
  });

  it("retire le frontmatter, calcule le slug, libelle la portée", () => {
    expect(retirerFrontmatter("---\nname: x\n---\n\n# Titre")).toBe("# Titre");
    expect(retirerFrontmatter("# Sans")).toBe("# Sans");
    expect(slugClient("  Déploiement Été ! ")).toBe("deploiement-ete");
    expect(libellePortee("user")).toBe("perso");
    expect(libellePortee("global")).toBe("global");
  });
});

describe("parties de l'onglet", () => {
  it("Global porte l'instance et ses brouillons, Perso le compte", () => {
    expect(partieDePortee("global")).toBe("global");
    expect(partieDePortee("learned")).toBe("global");
    expect(partieDePortee("user")).toBe("perso");
    expect(partieDePortee("")).toBe("perso");
  });
});
