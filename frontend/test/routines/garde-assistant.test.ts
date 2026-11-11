// SPDX-License-Identifier: MIT
/** frontend/test/routines/garde-assistant.test.ts — garde du lien vers l'assistant skill (confirmation si le formulaire est modifié) et condition « aucun skill personnel ». */
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { creerApiRoutines } from "../../src/features/routines/api";
import { creerRoutines } from "../../src/features/routines/routines";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

function skill(name: string, source: string) {
  return {
    name,
    description: "d",
    tags: [],
    source,
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
    id: name,
    parent_id: null,
    depth: 0,
  };
}

function monter(skills: ReturnType<typeof skill>[], confirmer = true) {
  const titres: string[] = [];
  const http = new ClientHttp(new GestionnaireSession(), (u) =>
    Promise.resolve(u === "/api/skills" ? json({ skills, count: skills.length }) : json({ items: [] })),
  );
  const s = creerRoutines(
    creerApiRoutines(http),
    { currentView: ref("chat") },
    {
      showToast: () => undefined,
      openConfirm: (titre) => {
        titres.push(titre);
        return Promise.resolve(confirmer);
      },
    },
  );
  return { s, titres };
}

describe("garde du lien vers l'assistant skill", () => {
  it("formulaire intact : pas de confirmation", async () => {
    const { s, titres } = monter([]);
    s.startCreateRoutine();
    expect(await s.confirmerAbandon()).toBe(true);
    expect(titres).toEqual([]);
    s._liberer();
  });

  it("formulaire modifié : confirmation demandée, refus respecté", async () => {
    const { s, titres } = monter([], false);
    s.startCreateRoutine();
    s.routineForm.value.name = "Brouillon";
    expect(await s.confirmerAbandon()).toBe(false);
    expect(titres).toEqual(["Abandonner les modifications ?"]);
    s._liberer();
  });

  it("formulaire modifié : abandon confirmé", async () => {
    const { s } = monter([], true);
    s.startCreateRoutine();
    s.routineForm.value.name = "Brouillon";
    expect(await s.confirmerAbandon()).toBe(true);
    s._liberer();
  });
});

describe("aucunSkillPersoRoutine", () => {
  it("les skills globaux livrés ne comptent pas, un skill personnel oui", async () => {
    const a = monter([skill("g", "global")]);
    await a.s.reloadRoutineSkills();
    expect(a.s.routineSkills.value).toHaveLength(1);
    expect(a.s.aucunSkillPersoRoutine.value).toBe(true);
    const b = monter([skill("g", "global"), skill("u", "user")]);
    await b.s.reloadRoutineSkills();
    expect(b.s.aucunSkillPersoRoutine.value).toBe(false);
    a.s._liberer();
    b.s._liberer();
  });
});
