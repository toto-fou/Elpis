// SPDX-License-Identifier: MIT
/** frontend/test/skills/onglet-skills.test.ts — onglet Skills : parties Global et Perso, état vide de Perso, filtre qui signale l'autre partie, retour sur la partie du skill créé. */
import { createApp, h, nextTick, proxyRefs, reactive, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import OngletSkills from "../../src/components/skills/OngletSkills.vue";
import { GestionnaireSession } from "../../src/features/auth/session";
import { CLE_REGLAGES } from "../../src/features/reglages/domaine";
import type { DomaineReglages } from "../../src/features/reglages/domaine";
import { creerApiSkills } from "../../src/features/skills/api";
import { CLE_SKILLS } from "../../src/features/skills/domaine";
import type { DomaineSkills } from "../../src/features/skills/domaine";
import { creerSkills } from "../../src/features/skills/skills";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

const BASE = {
  description: "d",
  tags: [],
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
const skill = (name: string, source: string) => ({ ...BASE, name, id: name, source });

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

async function monter(perso: string[] = ["mon-skill"], admin = false) {
  const inventaire: Record<string, unknown[]> = {
    global: [skill("doc-instance", "global")],
    learned: [skill("brouillon", "learned")],
    user: perso.map((n) => skill(n, "user")),
  };
  const http = new ClientHttp(new GestionnaireSession(), (u, i) => {
    if (i?.method === "POST")
      return Promise.resolve(json({ ok: true, name: "neuf", path: "/p", source: "user" }));
    const portee = /scope=(\w+)/.exec(u)?.[1] ?? "";
    return Promise.resolve(json({ skills: inventaire[portee] ?? [], count: 0 }));
  });
  const s = creerSkills(
    creerApiSkills(http),
    { user: ref({ role: admin ? "admin" : "user" }) },
    {
      showToast: () => undefined,
      openConfirm: () => Promise.resolve(true),
      announce: () => undefined,
      nextTick: (fn) => fn(),
    },
  );
  await s.loadAllSkills();
  const ks = proxyRefs({
    ...s,
    settingsTab: "skills",
    renderMarkdown: (x: string) => x,
    handleMarkdownClick: () => undefined,
    ouvrirAssistant: () => undefined,
  });
  const rg = reactive({
    settingsSections: {} as Record<string, string>,
    settings: {},
    features: {},
    mascottesOffertes: true,
  });
  const racine = document.createElement("div");
  document.body.appendChild(racine);
  app = createApp({ render: () => h(OngletSkills) });
  app.provide(CLE_SKILLS, ks as unknown as DomaineSkills);
  app.provide(CLE_REGLAGES, rg as unknown as DomaineReglages);
  app.mount(racine);
  await nextTick();
  return { s, rg, racine };
}

const bouton = (racine: Element, texte: string): HTMLButtonElement => {
  const b = [...racine.querySelectorAll("button")].find((x) => x.textContent?.includes(texte));
  if (!b) throw new Error(`bouton « ${texte} » absent`);
  return b;
};

describe("onglet Skills", () => {
  it("Global par défaut : l'instance et ses brouillons, groupés, sans les skills du compte", async () => {
    const { racine } = await monter();
    const texte = racine.textContent ?? "";
    expect(texte).toContain("doc-instance");
    expect(texte).toContain("brouillon");
    expect(texte).toContain("Global");
    expect(texte).toContain("Learned");
    expect(texte).not.toContain("mon-skill");
  });

  it("Perso : les skills du compte, sans titre de groupe redondant", async () => {
    const { rg, racine } = await monter();
    rg.settingsSections["skills"] = "perso";
    await nextTick();
    const texte = racine.textContent ?? "";
    expect(texte).toContain("mon-skill");
    expect(texte).not.toContain("doc-instance");
    expect(texte).not.toContain("Perso (1)");
  });

  it("l'état vide qui explique comment commencer n'apparaît que dans Perso", async () => {
    const { rg, racine } = await monter([]);
    expect(racine.textContent).not.toContain("Aucun skill personnel");
    rg.settingsSections["skills"] = "perso";
    await nextTick();
    expect(racine.textContent).toContain("Aucun skill personnel");
  });

  it("le filtre signale les résultats de l'autre partie et y mène", async () => {
    const { s, rg, racine } = await monter();
    s.skillsFilter.value = "mon-skill";
    await nextTick();
    expect(racine.textContent).toContain("Aucun résultat");
    const lien = racine.querySelector<HTMLButtonElement>("[data-skills-autre-partie]");
    expect(lien?.textContent?.replace(/\s+/g, " ").trim()).toBe("1 résultat dans Perso");
    lien?.click();
    await nextTick();
    expect(rg.settingsSections["skills"]).toBe("perso");
    expect(racine.textContent).toContain("mon-skill");
    expect(racine.querySelector("[data-skills-autre-partie]")).toBeNull();
  });

  it("sans résultat nulle part : pas de renvoi", async () => {
    const { s, racine } = await monter();
    s.skillsFilter.value = "introuvable";
    await nextTick();
    expect(racine.textContent).toContain("Aucun résultat");
    expect(racine.querySelector("[data-skills-autre-partie]")).toBeNull();
  });

  it("un skill créé depuis Global fait ouvrir Perso, même si Perso était déjà la dernière portée", async () => {
    const { s, rg, racine } = await monter();
    await s.viewSkill(skill("mon-skill", "user") as never);
    await nextTick();
    expect(rg.settingsSections["skills"]).toBe("perso");
    s.backToSkillsList();
    rg.settingsSections["skills"] = "global";
    await nextTick();
    bouton(racine, "Nouveau").click();
    await nextTick();
    expect(s.skillForm.value.scope).toBe("user");
    s.skillForm.value.name = "neuf";
    s.skillForm.value.body = "corps";
    await s.saveSkill();
    await nextTick();
    expect(rg.settingsSections["skills"]).toBe("perso");
  });

  it("un administrateur qui crée depuis Global part sur la portée de l'instance", async () => {
    const { s, rg, racine } = await monter(["mon-skill"], true);
    bouton(racine, "Nouveau").click();
    expect(s.skillForm.value.scope).toBe("global");
    s.cancelEdit();
    rg.settingsSections["skills"] = "perso";
    await nextTick();
    bouton(racine, "Nouveau").click();
    expect(s.skillForm.value.scope).toBe("user");
  });
});
