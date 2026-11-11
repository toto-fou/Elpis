// SPDX-License-Identifier: MIT
/** frontend/test/chat/jobs/slash-jobs.test.ts — commande /jobs : les quatre formes, cascade des arguments (ids actifs), validation, rendu par toast. */
import * as Vue from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { creerMenuSlash } from "../../../src/features/chat/composeur/slash";
import type { CtxSlash } from "../../../src/features/chat/composeur/slash";
import type { JobsSlash } from "../../../src/features/chat/jobs/jobs";

afterEach(() => {
  document.body.innerHTML = "";
});

function monter() {
  const ta = document.createElement("textarea");
  document.body.appendChild(ta);
  const inputRef = Vue.ref<HTMLTextAreaElement | null>(ta);
  const inputMessage = Vue.ref("");
  const appels: string[] = [];
  const toasts: { m: string; t?: string }[] = [];
  const jobs: JobsSlash = {
    lister: (p) => {
      appels.push("lister " + p);
      return Promise.resolve({
        ok: true,
        info: true,
        msg: p === "all" ? "2 tâches actives" : "1 tâche active",
      });
    },
    arreter: (c) => {
      appels.push("arreter " + c);
      return Promise.resolve({ ok: true, msg: "1 tâche arrêtée." });
    },
    ids: () => [
      { value: "j-3f2a1c9e", label: "pytest" },
      { value: "j-00000002", label: "build" },
    ],
    actualiser: () => appels.push("actualiser"),
  };
  const ctx: CtxSlash = {
    fetchAuth: () => Promise.resolve(null),
    showToast: (m, t) => toasts.push({ m, t }),
    jobs,
  };
  const menu = creerMenuSlash(Vue, { inputRef, inputMessage }, ctx);
  const taper = (texte: string): void => {
    inputMessage.value = texte;
    ta.value = texte;
    ta.setSelectionRange(texte.length, texte.length);
    menu.onInput();
  };
  const lancer = async (texte: string): Promise<boolean> => {
    const hit = menu.slashResolve(texte);
    if (!hit) return false;
    await menu.slashRun(hit);
    return true;
  };
  return { menu, taper, lancer, appels, toasts, inputMessage };
}

const valeurs = (liste: readonly unknown[]): string[] => (liste as { value: string }[]).map((v) => v.value);

describe("/jobs", () => {
  it("la commande est proposée avec son icône de minuteur", () => {
    const b = monter();
    b.taper("/jo");
    expect(b.menu.slashList.value.map((c) => (c as { name: string }).name)).toContain("jobs");
    expect((b.menu.slashList.value[0] as { icon: string }).icon).toBe("ph-timer");
  });

  it("/jobs : jobs de la conversation, résultat en toast d'information", async () => {
    const b = monter();
    expect(await b.lancer("/jobs")).toBe(true);
    expect(b.appels).toEqual(["lister chat"]);
    expect(b.toasts).toEqual([{ m: "1 tâche active", t: "info" }]);
  });

  it("/jobs all : tout le compte", async () => {
    const b = monter();
    await b.lancer("/jobs all");
    expect(b.appels).toEqual(["lister all"]);
    expect(b.toasts[0]?.m).toBe("2 tâches actives");
  });

  it("JB-12 : /jobs stop <id> arrête cette tâche", async () => {
    const b = monter();
    await b.lancer("/jobs stop j-3f2a1c9e");
    expect(b.appels).toEqual(["arreter j-3f2a1c9e"]);
    expect(b.toasts).toEqual([{ m: "1 tâche arrêtée.", t: "success" }]);
  });

  it("JB-12 : /jobs stop all arrête les tâches de la conversation", async () => {
    const b = monter();
    await b.lancer("/jobs stop all");
    expect(b.appels).toEqual(["arreter all"]);
  });

  it("identifiant mal formé ou usage inconnu : erreur, aucun appel", async () => {
    const b = monter();
    await b.lancer("/jobs stop pytest");
    await b.lancer("/jobs stop");
    await b.lancer("/jobs partir");
    expect(b.appels).toEqual([]);
    expect(b.toasts.map((t) => t.t)).toEqual(["error", "error", "error"]);
    expect(b.toasts[0]?.m).toContain("pytest");
  });

  it("cascade : premier argument = list (défaut), all, stop ; ensuite stop propose « all » puis les ids actifs", () => {
    const b = monter();
    b.taper("/jobs ");
    expect(b.menu.slashLevel.value).toBe("values");
    expect(valeurs(b.menu.slashList.value)).toEqual(["list", "all", "stop"]);
    b.taper("/jobs stop ");
    expect(valeurs(b.menu.slashList.value)).toEqual(["all", "j-00000002", "j-3f2a1c9e"]);
    b.taper("/jobs stop j-0");
    expect(valeurs(b.menu.slashList.value)).toEqual(["j-00000002"]);
  });

  it("choisir « all » lance la commande sans second argument ; choisir « stop » attend l'id", async () => {
    const b = monter();
    b.taper("/jobs ");
    await b.menu.selectValue({ value: "all", label: "" });
    expect(b.appels).toContain("lister all");
    b.appels.length = 0;
    b.taper("/jobs ");
    await b.menu.selectValue({ value: "stop", label: "" });
    expect(b.appels.filter((a) => a !== "actualiser")).toEqual([]);
    expect(b.inputMessage.value).toBe("/jobs stop ");
    b.taper("/jobs stop ");
    await b.menu.selectValue({ value: "j-00000002", label: "" });
    expect(b.appels).toContain("arreter j-00000002");
  });

  it("/jobs seul puis Entrée, menu ouvert : liste la conversation, jamais « all »", async () => {
    const b = monter();
    b.taper("/jobs");
    expect(b.menu.showSlash.value).toBe(true);
    b.menu.slashKeydown(new KeyboardEvent("keydown", { key: "Enter" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(b.appels.filter((a) => a.startsWith("lister"))).toEqual(["lister chat"]);
  });

  it("la frappe de la commande déclenche une relecture des ids", () => {
    const b = monter();
    b.taper("/jobs st");
    expect(b.appels).toContain("actualiser");
  });

  it("sans module de jobs : commande indisponible", async () => {
    const ta = document.createElement("textarea");
    const menu = creerMenuSlash(
      Vue,
      { inputRef: Vue.ref(ta), inputMessage: Vue.ref("") },
      { fetchAuth: () => Promise.resolve(null), showToast: () => undefined },
    );
    const hit = menu.slashResolve("/jobs");
    expect(hit && menu.slashCmdOk(hit.cmd)).toBe(false);
  });
});
