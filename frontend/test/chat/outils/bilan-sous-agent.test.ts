// SPDX-License-Identifier: MIT
/** frontend/test/chat/outils/bilan-sous-agent.test.ts — bloc du harnais d'un sous-agent : lecture validée, libellés français, carte du chat (badge, appels, durée, arrêt sur budget, lecture seule, détails dépliables : fichiers et autre agent en même temps, avertissements, reste à faire) ; rien pour un ancien run. */
import type { BilanTache } from "@elpis/contracts";
import { createApp, h, nextTick } from "vue";
import type { App, Component } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import SousAgents from "../../../src/components/chat/outils/SousAgents.vue";
import {
  classeStatutTache,
  libelleArretTache,
  libelleStatutTache,
  lireBilanTache,
} from "../../../src/features/chat/outils/bilan-tache";
import type { ExecutionSousAgent } from "../../../src/features/chat/outils/types";

const BILAN: BilanTache = {
  status: "budget_exhausted",
  tool_calls: 95,
  tool_calls_total: 95,
  iterations: 95,
  resumed: false,
  duration_s: 72,
  files_changed: [
    { path: "src/a.ts", change: "modified", added: 4, removed: 1 },
    { path: "src/b.ts", change: "created", added: 10 },
  ],
  concurrent: true,
  git: { branch: "feat/x", commits: ["abc1234 Ajout"] },
  errors: 2,
  read_only: true,
  remaining_work: "Brancher la route et écrire les tests.",
  report_chars: 1200,
};

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(composant: Component, props: Record<string, unknown>) {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(composant, props) });
  app.mount(hote);
  return hote;
}

describe("bloc du harnais : lecture et libellés", () => {
  it("valide le bloc, ignore une clé inconnue, rend null s'il est absent ou illisible", () => {
    expect(lireBilanTache(BILAN)).toEqual(BILAN);
    expect(lireBilanTache({ ...BILAN, plus_tard: 1 })).toEqual(BILAN);
    expect(lireBilanTache({ ...BILAN, git: { ...BILAN.git, pr_url: "http://forge/o/r/pulls/4" } })).toEqual(
      BILAN,
    );
    expect(lireBilanTache(undefined)).toBeNull();
    expect(lireBilanTache({ status: "done" })).toBeNull();
    expect(lireBilanTache({ ...BILAN, status: "inconnu" })).toBeNull();
  });

  it("statuts en français et tons du badge", () => {
    const statuts = [
      "done",
      "partial",
      "blocked",
      "budget_exhausted",
      "timeout",
      "unavailable",
      "error",
      "cancelled",
    ] as const;
    expect(statuts.map(libelleStatutTache)).toEqual([
      "terminé",
      "partiel",
      "bloqué",
      "budget épuisé",
      "délai dépassé",
      "indisponible",
      "erreur",
      "annulé",
    ]);
    expect(statuts.map(classeStatutTache)).toEqual([
      "is-ok",
      "is-warn",
      "is-warn",
      "is-warn",
      "is-warn",
      "is-error",
      "is-error",
      "is-neutral",
    ]);
  });
});

describe("carte du sous-agent", () => {
  it("budget épuisé : badge, 95 appels, durée, lecture seule, reste ; détails dépliables au clavier", async () => {
    const runs: ExecutionSousAgent[] = [
      { id: "r1", agent: "implement", label: "brancher", state: "incomplete", tokens: 900, harness: BILAN },
    ];
    const hote = monter(SousAgents, { runs, logoApp: "/logo" });
    const badge = hote.querySelector("[data-task-status]");
    expect(badge?.textContent).toBe("budget épuisé");
    expect(badge?.classList.contains("is-warn")).toBe(true);
    expect(hote.querySelector("[data-task-calls]")?.textContent).toBe("95 appels");
    expect(hote.querySelector("[data-task-duration]")?.textContent).toContain("1 min 12 s");
    expect(hote.querySelector("[data-task-ro]")?.getAttribute("title")).toBe("Lecture seule");
    expect(hote.querySelector("[data-task-reste]")?.textContent).toContain("Brancher la route");
    expect(hote.querySelector("[data-task-arret]")).toBeNull();
    expect(hote.textContent).not.toContain("incomplete");
    const bouton = hote.querySelector<HTMLButtonElement>("[data-task-more]");
    expect(bouton?.textContent).toContain("2 fichiers · 1 commit");
    expect(bouton?.getAttribute("aria-expanded")).toBe("false");
    const panneau = hote.querySelector<HTMLElement>("#" + (bouton?.getAttribute("aria-controls") ?? "x"));
    expect(panneau?.style.display).toBe("none");
    bouton?.click();
    await nextTick();
    expect(bouton?.getAttribute("aria-expanded")).toBe("true");
    expect(panneau?.style.display).toBe("");
    const fichiers = [...hote.querySelectorAll("[data-task-bilan-file]")].map((l) =>
      [...l.children].map((c) => c.textContent?.trim()),
    );
    expect(fichiers).toEqual([
      ["src/a.ts", "modifié", "+4", "−1"],
      ["src/b.ts", "créé", "+10"],
    ]);
    expect([...hote.querySelectorAll("dt")].map((d) => d.textContent?.trim()).slice(0, 2)).toEqual([
      "Fichiers modifiés (2)",
      "Git",
    ]);
    expect(hote.querySelector("[data-task-bilan-concurrent]")?.textContent).toContain(
      "Un autre agent du compte tournait en même temps",
    );
    expect(hote.querySelector("[data-task-bilan-commit]")?.textContent?.trim()).toBe("abc1234 Ajout");
    expect(hote.querySelector("[data-task-bilan-ro]")?.textContent).toContain("Lecture seule");
    expect(hote.querySelector("[data-task-bilan-reste]")).toBeNull();
  });

  it("N6/N7 : arrêt sur budget dans la ligne, cause en français et avertissements dans les détails", async () => {
    const arret: BilanTache = {
      ...BILAN,
      status: "partial",
      stop_reason: "budget_wrap_up",
      tool_calls: 8,
      budget_warnings: [
        { at: 5, text: "Tool-iteration budget: 5/10 used, 5 left. Plan the remaining work to fit." },
        { at: 8, text: "Tool-iteration budget: 8/10 used — only 2 left. Wrap up." },
      ],
    };
    expect(lireBilanTache(arret)).toEqual(arret);
    const hote = monter(SousAgents, {
      runs: [{ id: "r4", agent: "explore", state: "completed", harness: arret }],
      logoApp: "/logo",
    });
    expect(hote.querySelector("[data-task-status]")?.textContent).toBe("partiel");
    expect(hote.querySelector("[data-task-arret]")?.textContent).toBe("· arrêt sur budget");
    hote.querySelector<HTMLButtonElement>("[data-task-more]")?.click();
    await nextTick();
    expect(hote.querySelector("[data-task-bilan-cause]")?.textContent?.trim()).toBe(
      "arrêt sur budget : conclu après l'avertissement de fin de budget",
    );
    const avertissements = [...hote.querySelectorAll("[data-task-bilan-avertissement]")].map((l) =>
      l.textContent?.replace(/\s+/gu, " ").trim(),
    );
    expect(avertissements).toEqual([
      "après 5 appels Tool-iteration budget: 5/10 used, 5 left. Plan the remaining work to fit.",
      "après 8 appels Tool-iteration budget: 8/10 used — only 2 left. Wrap up.",
    ]);
    expect(libelleArretTache("steps")).toBe("budget d'appels atteint");
    expect(libelleArretTache("autre_cause")).toBe("autre_cause");
  });

  it("ancien run sans bloc, ou run en cours : aucune trace du bilan", () => {
    const hote = monter(SousAgents, {
      runs: [
        { agent: "explore", state: "completed", steps_total: 3 },
        { id: "r2", agent: "verify", state: "running", progress: { step: 2, max_steps: 9 }, harness: BILAN },
      ],
      logoApp: "/logo",
    });
    expect(hote.querySelector("[data-task-status]")).toBeNull();
    expect(hote.querySelector("[data-task-more]")).toBeNull();
    expect(hote.querySelector("[data-task-reste]")).toBeNull();
    expect(hote.textContent).toContain("3 appels");
    expect(hote.textContent).toContain("étape 2/9");
  });

  it("terminé sans fichier ni commit ni droit particulier : badge seul, pas de bouton de détails", () => {
    const fini: BilanTache = {
      ...BILAN,
      status: "done",
      tool_calls: 4,
      files_changed: [],
      concurrent: undefined,
      git: { commits: [] },
      errors: 0,
      read_only: false,
      remaining_work: undefined,
    };
    const hote = monter(SousAgents, {
      runs: [{ id: "r3", agent: "explore", state: "completed", harness: fini }],
      logoApp: "/logo",
    });
    expect(hote.querySelector("[data-task-status]")?.textContent).toBe("terminé");
    expect(hote.querySelector("[data-task-calls]")?.textContent).toBe("4 appels");
    expect(hote.querySelector("[data-task-ro]")).toBeNull();
    expect(hote.querySelector("[data-task-more]")).toBeNull();
  });

  it("index git modifié sans fichier ni commit : détails proposés, chemins indexés (`.` : toutes les modifications)", async () => {
    const indexe: BilanTache = {
      ...BILAN,
      status: "done",
      files_changed: [],
      concurrent: undefined,
      git: { commits: [], index_changed: true, staged: ["app.py", "."] },
      read_only: false,
      remaining_work: undefined,
    };
    const hote = monter(SousAgents, {
      runs: [{ id: "r4", agent: "implement", state: "completed", harness: indexe }],
      logoApp: "/logo",
    });
    const bouton = hote.querySelector<HTMLButtonElement>("[data-task-more]");
    expect(bouton?.textContent).toContain("index git modifié");
    bouton?.click();
    await nextTick();
    expect(hote.querySelector("[data-task-bilan-index]")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Index modifié : app.py, toutes les modifications",
    );
  });
});
