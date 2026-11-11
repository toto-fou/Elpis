// SPDX-License-Identifier: MIT
/** frontend/test/skills/skills.test.ts — module des skills : inventaire, enregistrement d'une modification, import avec conflit, suppression. */
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { creerApiSkills } from "../../src/features/skills/api";
import { creerSkills } from "../../src/features/skills/skills";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const BASE = {
  description: "d",
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
  parent_id: null,
  depth: 0,
};
const A = { ...BASE, name: "alpha", id: "alpha" };

function monter(routeur: (u: string, i?: RequestInit) => Response, admin = false) {
  const appels: Array<[string, string, string]> = [];
  const http = new ClientHttp(new GestionnaireSession(), (u, i) => {
    appels.push([i?.method ?? "GET", u, typeof i?.body === "string" ? i.body : ""]);
    return Promise.resolve(routeur(u, i));
  });
  const toasts: string[] = [];
  const confirmations: string[] = [];
  const s = creerSkills(
    creerApiSkills(http),
    { user: ref({ role: admin ? "admin" : "user" }) },
    {
      showToast: (m) => void toasts.push(m),
      openConfirm: (t) => {
        confirmations.push(t);
        return Promise.resolve(true);
      },
      announce: () => undefined,
      nextTick: (fn) => fn(),
    },
  );
  return { s, appels, toasts, confirmations };
}

describe("module des skills", () => {
  it("charge l'inventaire par portée et replie l'arbre à l'ouverture", async () => {
    const { s } = monter((u) => {
      if (u.startsWith("/api/skills?scope=user"))
        return json({ skills: [A, { ...BASE, name: "b", id: "p/b", parent_id: "p" }], count: 2 });
      if (u.startsWith("/api/skills?scope=")) return json({ skills: [], count: 0 });
      return json({}, 404);
    });
    await s.loadAllSkills(true);
    expect(s.totalSkillsCount.value).toBe(2);
    expect(s.filteredTotalCount.value).toBe(2);
    await s.loadAllSkills({} as never);
    expect(s.skillsError.value).toBe("");
  });

  it("modifie un skill : PUT sur la feuille avec l'id qualifié en requête", async () => {
    const { s, appels, toasts } = monter((u, i) => {
      if (i?.method === "PUT") return json({ ok: true, name: "child", path: "/p", source: "user" });
      if (u.startsWith("/api/skills?scope=")) return json({ skills: [], count: 0 });
      return json({}, 404);
    });
    s.skillEditMode.value = "edit";
    s.skillForm.value = {
      scope: "user",
      name: "child",
      description: "",
      domain: "",
      tags: "a, b",
      body: "corps",
      _original: "pkg/child",
      _depth: 1,
    };
    await s.saveSkill();
    const put = appels.find(([m]) => m === "PUT");
    expect(put?.[1]).toBe("/api/skills/child?id=pkg%2Fchild");
    expect(JSON.parse(put?.[2] ?? "{}")).toMatchObject({
      scope: "user",
      name: "child",
      tags: ["a", "b"],
      body: "corps",
    });
    expect(toasts).toContain("Skill mis à jour");
    expect(s.porteeMontree.value?.portee).toBe("user");
  });

  it("signale la portée d'un skill ouvert à chaque fois, même inchangée", async () => {
    const { s } = monter((u) =>
      u.startsWith("/api/skills/file") ? json({ id: "d", path: "SKILL.md", content: "# d" }) : json({}),
    );
    await s.viewSkill({ ...BASE, name: "doc", id: "doc", source: "global" });
    const premier = s.porteeMontree.value;
    expect(premier?.portee).toBe("global");
    await s.viewSkill({ ...BASE, name: "doc", id: "doc", source: "global" });
    expect(s.porteeMontree.value).not.toBe(premier);
  });

  it("refuse un formulaire sans nom ni corps, et la portée globale sans droits", async () => {
    const { s, toasts, appels } = monter(() => json({}));
    await s.saveSkill();
    s.skillForm.value = {
      scope: "global",
      name: "n",
      description: "",
      domain: "",
      tags: "",
      body: "b",
      _original: "",
      _depth: 0,
    };
    await s.saveSkill();
    expect(toasts).toEqual(["Nom et corps requis", "Réservé aux administrateurs"]);
    expect(appels).toHaveLength(0);
  });

  it("import zip en conflit : confirme puis relance avec overwrite", async () => {
    let n = 0;
    const { s, appels, confirmations } = monter((u, i) => {
      if (u.startsWith("/api/skills/import?")) {
        n++;
        if (n === 1) return json({ detail: "existe", name: "alpha", names: ["alpha"], scope: "user" }, 409);
        return json({ ok: true, imported: ["alpha"], count: 1, name: "alpha", scope: "user" });
      }
      if (u.startsWith("/api/skills?scope=")) return json({ skills: [A], count: 1 });
      if (u.startsWith("/api/skills/file")) return json({ id: "alpha", path: "SKILL.md", content: "# a" });
      return json({}, i ? 404 : 404);
    });
    await s.importSkillZip(new File(["x"], "alpha.zip"), "user");
    expect(confirmations[0]).toContain("alpha");
    const imports = appels.filter(([, u]) => u.startsWith("/api/skills/import?"));
    expect(imports.map(([, u]) => u)).toEqual([
      "/api/skills/import?scope=user",
      "/api/skills/import?scope=user&overwrite=1",
    ]);
    expect(s.skillEditMode.value).toBe("view");
    expect(s.porteeMontree.value?.portee).toBe("user");
  });

  it("supprime un skill et recharge l'inventaire", async () => {
    const { s, appels, toasts } = monter((u, i) => {
      if (i?.method === "DELETE") return json({ ok: true, name: "alpha", scope: "user", deleted: true });
      if (u.startsWith("/api/skills?scope=")) return json({ skills: [], count: 0 });
      return json({}, 404);
    });
    await s.deleteSkill(A);
    expect(appels.some(([m, u]) => m === "DELETE" && u === "/api/skills/alpha?scope=user&id=alpha")).toBe(
      true,
    );
    expect(toasts).toContain("Skill supprimé");
  });
});
