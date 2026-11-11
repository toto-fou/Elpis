// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/cloture.test.ts — Stop ou erreur : étapes en cours arrêtées avec leur durée, sous-agents annulés en français et sans rouge, budget de tours retiré, conteneur figé. */
import { createApp, h } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import GroupeOutils from "../../../src/components/chat/outils/GroupeOutils.vue";
import SousAgents from "../../../src/components/chat/outils/SousAgents.vue";
import { cloreTour } from "../../../src/features/chat/coeur/cloture";
import type { MessageChat } from "../../../src/features/chat/coeur/types";
import type { EtapeOutil, GroupeSegment } from "../../../src/features/chat/outils/types";

let app: App | null = null;

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(rendu: () => VNode): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: rendu });
  app.mount(hote);
  return hote;
}

const T0 = 1_000_000;

function enCours(): MessageChat {
  return {
    role: "assistant",
    isStreaming: true,
    iterBudget: { n: 6, max: 25 },
    toolSteps: [
      { name: "read_file", status: "done", durationMs: 100, startedAt: T0 - 5000 },
      {
        name: "execute_shell",
        status: "running",
        startedAt: T0,
        progressInfo: { value: 1, total: 4, pct: 25, message: "", at: T0 },
      },
      { name: "context_compress", _kind: "compression", status: "running" },
    ],
    taskRuns: [
      {
        id: "k",
        state: "running",
        progress: { step: 3, max_steps: 20 },
        tools: [{ tool: "read_file", args_preview: "a", status: "running" }],
        transcript: [{ tool: "read_file", status: "running" }],
      },
      { id: "j", state: "completed" },
    ],
  };
}

describe("cloreTour", () => {
  it("arrête les étapes en cours à la durée atteinte, annule les sous-agents, retire « tour n/max »", () => {
    const p = cloreTour(enCours(), T0 + 18_000);
    expect(p?.iterBudget).toBeNull();
    const [lue, shell, compression] = p?.toolSteps ?? [];
    expect(lue).toMatchObject({ status: "done", durationMs: 100 });
    expect(shell).toMatchObject({ status: "stopped", durationMs: 18_000 });
    expect(shell?.progressInfo).toBeUndefined();
    expect(compression).toMatchObject({ status: "skipped", reasonLabel: "Interrompue" });
    const [agent, fini] = p?.taskRuns ?? [];
    expect(agent).toMatchObject({ state: "cancelled", progress: null });
    expect(agent?.tools?.[0]?.status).toBe("cancelled");
    expect(agent?.transcript?.[0]?.status).toBe("cancelled");
    expect(fini?.state).toBe("completed");
  });

  it("sous-agent en fond : survit au Stop du tour, seul le synchrone est annulé", () => {
    const p = cloreTour({
      role: "assistant",
      taskRuns: [
        { id: "k1", agent: "explore", state: "running", background: true },
        { id: "k2", agent: "verify", state: "running" },
      ],
    });
    expect(p?.taskRuns?.map((r) => r.state)).toEqual(["running", "cancelled"]);
    expect(
      cloreTour({ role: "assistant", taskRuns: [{ id: "k1", state: "running", background: true }] }),
    ).toBeNull();
  });

  it("rien à clore : null", () => {
    expect(cloreTour({ role: "assistant", toolSteps: [{ name: "x", status: "done" }] })).toBeNull();
  });
});

function groupe(steps: EtapeOutil[]): GroupeSegment {
  const disp = steps.map((step, flat) => ({ step, flat, shell: false }));
  return {
    gi: 0,
    text: "",
    steps,
    disp,
    nTools: steps.length,
    nComp: 0,
    pills: { pills: [], extraCount: 0 },
    running: steps.some((s) => s.status === "running"),
    shellRuns: [],
    shellMeta: null,
  };
}

describe("affichage après Stop (déroulé Classique)", () => {
  it("étape arrêtée : signe d'arrêt neutre, « arrêtée à 18 s », plus de roue", () => {
    const hote = monter(() =>
      h(GroupeOutils, {
        msg: { _segsOpen: { 0: true } },
        idx: 1,
        grp: groupe([
          { name: "execute_shell", status: "stopped", durationMs: 18_000, args: { command: "npm test" } },
        ]),
        consoleShell: false,
        masquerReflexion: false,
      }),
    );
    expect(hote.querySelector("[data-arretee]")?.textContent).toContain("arrêtée à 18 s");
    expect(hote.querySelector(".ph-stop-circle")).not.toBeNull();
    expect(hote.querySelector(".animate-spin")).toBeNull();
  });

  it("sous-agent annulé : « annulé » en français, signe neutre, aucun rouge", () => {
    const hote = monter(() =>
      h(SousAgents, {
        runs: [{ id: "k", agent: "revue", state: "cancelled", tokens: 10 }],
        logoApp: "x.png",
      }),
    );
    expect(hote.querySelector("[data-etat-run]")?.textContent).toContain("annulé");
    expect(hote.textContent).not.toContain("cancelled");
    expect(hote.querySelector(".is-error")).toBeNull();
    expect(hote.querySelector(".task-run-ico.is-neutral")).not.toBeNull();
  });
});
