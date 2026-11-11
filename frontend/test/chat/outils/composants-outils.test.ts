// SPDX-License-Identifier: MIT
/** frontend/test/chat/outils/composants-outils.test.ts — segments d'outils : dropdown, carte détail, console shell échappée et suivie, sous-agents, puce Tâches. */
import { createApp, h, nextTick, shallowRef } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import GroupeOutils from "../../../src/components/chat/outils/GroupeOutils.vue";
import SousAgents from "../../../src/components/chat/outils/SousAgents.vue";
import { htmlConsoleShell } from "../../../src/features/chat/outils/format";
import type {
  EtapeOutil,
  GroupeSegment,
  MessageOutils,
  PatchUiMessage,
} from "../../../src/features/chat/outils/types";

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

function groupe(steps: EtapeOutil[]): GroupeSegment {
  const disp = steps.map((step, flat) => ({ step, flat, shell: step.name === "execute_shell" }));
  const shellRuns = disp.filter((d) => d.shell).map((d) => ({ step: d.step, flat: d.flat }));
  return {
    gi: 0,
    text: "",
    steps,
    disp,
    nTools: steps.length,
    nComp: 0,
    pills: { pills: [{ name: "read_file", count: 2, icon: "ph-eye" }], extraCount: 0 },
    running: steps.some((s) => s.status === "running"),
    shellRuns,
    shellMeta: shellRuns.length
      ? { n: 1, running: false, nFail: 0, title: "ls", chip: "code 0", dot: "is-ok", truncated: false }
      : null,
  };
}

describe("GroupeOutils", () => {
  it("compte les outils, ouvre la carte détail et remonte les actions", async () => {
    const patches: PatchUiMessage[] = [];
    const bascules: [number, number][] = [];
    const msg = shallowRef<MessageOutils>({});
    const grp = groupe([
      { name: "read_file", status: "done", args: { path: "a.txt" }, result: '{"content":"bonjour"}' },
      { name: "read_file", status: "done", args: { path: "b.txt" }, result: '{"error":"absent"}' },
    ]);
    const hote = monter(() =>
      h(GroupeOutils, {
        msg: msg.value,
        idx: 3,
        grp,
        consoleShell: true,
        masquerReflexion: false,
        onUi: (p: PatchUiMessage) => patches.push(p),
        "onBasculer-etape": (f: number, g: number) => bascules.push([f, g]),
      }),
    );
    expect(hote.querySelector("summary")?.textContent).toContain("2 outils");
    expect(hote.querySelector("summary")?.textContent).toContain("×2");
    const pills = hote.querySelectorAll<HTMLButtonElement>("button.group\\/toolbtn");
    expect(pills.length).toBe(2);
    pills[1]?.click();
    expect(bascules).toEqual([[1, 0]]);
    msg.value = { _activeToolStep: 1 };
    await nextTick();
    expect(hote.textContent).toContain("Erreur : absent");
    expect(hote.textContent).not.toContain("appel #");
    expect(hote.textContent).toContain("Résultat");
    const details = hote.querySelector("details") as HTMLDetailsElement;
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    expect(patches).toContainEqual({ _segsOpen: { 0: true } });
  });

  it("console shell : sortie échappée, suivie en bas, fermeture remontée", async () => {
    const patches: PatchUiMessage[] = [];
    const etape: EtapeOutil = {
      name: "execute_shell",
      status: "done",
      args: { command: "<img src=x onerror=alert(1)>" },
      shellOut: "\u001b[31mrouge\u001b[0m <script>alert(1)</script>\n",
      shellDone: true,
      shellRc: 2,
    };
    const hote = monter(() =>
      h(GroupeOutils, {
        msg: { _activeToolStep: 0 },
        idx: 1,
        grp: groupe([etape]),
        consoleShell: true,
        masquerReflexion: false,
        onUi: (p: PatchUiMessage) => patches.push(p),
      }),
    );
    const pre = hote.querySelector("[data-shell-live='1-0']");
    expect(pre).not.toBeNull();
    expect(pre?.querySelector("img, script")).toBeNull();
    expect(pre?.textContent).toContain("<script>alert(1)</script>");
    expect(pre?.innerHTML).toContain("sh-rc");
    hote.querySelector<HTMLButtonElement>("button[aria-label='Fermer le terminal']")?.click();
    expect(patches).toContainEqual({ _activeToolStep: null });
  });

  it("cache de la console : même groupe, même chaîne", () => {
    const grp = groupe([{ name: "execute_shell", status: "running", args: { cmd: "ls" }, shellOut: "a" }]);
    const a = htmlConsoleShell(grp);
    expect(htmlConsoleShell(grp)).toBe(a);
    expect(a).toContain("sh-cursor");
  });
});

describe("SousAgents", () => {
  it("sous-agents : états, déroulé et arrêt", () => {
    const evts: unknown[] = [];
    const hote = monter(() =>
      h(SousAgents, {
        runs: [
          {
            id: "r1",
            agent: "explore",
            label: "lire",
            state: "running",
            tokens: 8_200,
            input_tokens: 40_100,
            output_tokens: 5_100,
            cache_tokens: 32_000,
            think_tokens: 2_000,
          },
          { agent: "plan", state: "completed", steps_total: 3, transcript: [{}] },
          { id: "r3", agent: "verify", state: "running", background: true },
        ],
        logoApp: "/api/app-logo?v=0123456789abcdef",
        onDeroule: (i: number) => evts.push(["deroule", i]),
        onArreter: (r: unknown) => evts.push(["arreter", r]),
      }),
    );
    const logos = [...hote.querySelectorAll("img[data-logo-sous-agent]")].map((i) => i.getAttribute("src"));
    expect(logos).toHaveLength(3);
    expect(hote.querySelector("[data-task-conso]")?.textContent).toBe("8,2 k jetons");
    expect(hote.querySelector("[data-task-contexte]")).toBeNull();
    expect(hote.textContent).not.toContain("ctx");
    expect(hote.querySelector("[data-task-conso]")?.getAttribute("title")).toBe(
      "Contexte 8,2 k à la dernière requête au moteur\nEntrée 40,1 k cumulée sur ses appels au moteur · cache 32 k (80 %)\nSortie 5,1 k · réflexion 2 k · réponse 3,1 k",
    );
    expect(hote.querySelectorAll("[data-task-conso]")).toHaveLength(1);
    expect([...hote.querySelectorAll("[data-task-fond]")].map((e) => e.textContent)).toEqual(["· en fond"]);
    expect(hote.textContent).toContain("3 appels");
    hote.querySelectorAll<HTMLButtonElement>(".task-run-eye")[1]?.click();
    hote.querySelector<HTMLButtonElement>(".task-run-cancel")?.click();
    expect(evts[0]).toEqual(["deroule", 1]);
    expect((evts[1] as [string, { id: string }])[1].id).toBe("r1");
  });
});
