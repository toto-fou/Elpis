// SPDX-License-Identifier: MIT
/** frontend/test/chat/outils/agents.test.ts — sous-agents : ligne comme une étape, groupe « 2 agents · 1 fini », volet non modal de l'agent (consigne, rendu, chronologie, Arrêter, fermer). */
import { createApp, h, nextTick, reactive } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import ModaleAgent from "../../../src/components/chat/modales/ModaleAgent.vue";
import LignesAgents from "../../../src/components/chat/outils/LignesAgents.vue";
import { CLE_MODALES } from "../../../src/features/chat/modales/domaine";
import type { DomaineModalesChat } from "../../../src/features/chat/modales/domaine";
import {
  avecJobFond,
  bilanCourtAgent,
  chronologieAgent,
  etapeCouranteAgent,
  jetonsAgent,
  resumeAgents,
} from "../../../src/features/chat/outils/agents";
import { lireBilanTache } from "../../../src/features/chat/outils/bilan-tache";
import type { ExecutionSousAgent } from "../../../src/features/chat/outils/types";
import type { ResumeJob } from "@elpis/contracts";
import type { ContexteMessage } from "../../../src/features/chat/message/types";
import { CLE_FIL } from "../../../src/features/chat/page/domaines";

let app: App | null = null;
const appels: unknown[][] = [];

afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
});

const T0 = Date.now();
const enCours: ExecutionSousAgent = {
  id: "k1",
  agent: "performances",
  label: "Relire le diff",
  state: "running",
  startedAt: T0 - 125_000,
  tokens: 8_200,
  input_tokens: 12_000,
  output_tokens: 300,
  progress: { step: 6, max_steps: 20 },
  transcript: [
    { tool: "read_file", args_preview: '{"path": "src/db/pool.ts"}', status: "done", result_preview: "ok" },
    { text: "Le pool passe de 10 à 4 connexions." },
    { tool: "read_file", args_preview: '{"path": "src/db/query.ts"}', status: "running" },
  ],
} as ExecutionSousAgent;
const fini: ExecutionSousAgent = {
  id: "k2",
  agent: "sécurité",
  state: "completed",
  duration_ms: 108_000,
  steps_total: 14,
  prompt: "Relire le diff : failles et secrets",
  result: "Trois constats : **jeton** en clair.",
  transcript: [{ tool: "grep", args_preview: "password", status: "done" }],
} as ExecutionSousAgent;

function monter(rendu: () => VNode, o: { modales?: object; fil?: object } = {}): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: rendu });
  if (o.modales) app.provide(CLE_MODALES, o.modales as DomaineModalesChat);
  if (o.fil) app.provide(CLE_FIL, o.fil as ContexteMessage);
  app.mount(hote);
  return hote;
}

describe("sous-agent dit comme une étape", () => {
  it("étape courante, bilan court, état traduit, résumé du groupe", () => {
    expect(etapeCouranteAgent(enCours)).toBe("Étape 6 · Lit query.ts");
    expect(bilanCourtAgent(fini)).toBe("14 appels");
    expect(bilanCourtAgent({ ...fini, state: "cancelled" })).toBe("annulé · 14 appels");
    expect(resumeAgents([enCours, fini])).toBe("2 agents · 1 fini");
    const blocs = chronologieAgent(enCours);
    expect(blocs.map((b) => b.k)).toEqual(["etapes", "texte", "etapes"]);
    expect(blocs[2]).toMatchObject({
      etapes: [{ numero: 2, etape: { name: "read_file", status: "running" } }],
    });
  });

  it("lignes : nom, étape courante, contexte de la dernière requête, horloge ; fini : bilan ; cumuls en infobulle ; clic → fenêtre", () => {
    const ouverts: number[] = [];
    const hote = monter(() =>
      h(LignesAgents, {
        agents: [
          { run: enCours, ri: 0, callId: "t1" },
          { run: fini, ri: 1, callId: "t2" },
        ],
        maintenant: T0,
        actif: null,
        onOuvrir: (ri: number) => ouverts.push(ri),
      }),
    );
    expect(hote.querySelector("[data-resume-agents]")?.textContent).toBe("2 agents · 1 fini");
    const lignes = hote.querySelectorAll<HTMLButtonElement>("[data-ligne-agent]");
    expect(lignes[0]?.textContent?.replace(/\s+/g, " ")).toContain("performances · Étape 6 · Lit query.ts");
    expect(lignes[0]?.textContent).toContain("2 min 05 s");
    expect(lignes[0]?.querySelector("[data-jetons-agent]")?.textContent).toBe("8,2 k jetons");
    expect(lignes[0]?.textContent).not.toContain("ctx");
    expect(lignes[0]?.getAttribute("title")).toBe(
      "Relire le diff\nContexte 8,2 k à la dernière requête au moteur\nEntrée 12 k cumulée sur ses appels au moteur\nSortie 300",
    );
    expect(lignes[1]?.querySelector("[data-jetons-agent]")).toBeNull();
    expect(lignes[0]?.getAttribute("data-etape")).toBe("t1");
    expect(lignes[1]?.textContent?.replace(/\s+/g, " ")).toContain("sécurité · 14 appels");
    expect(lignes[1]?.textContent).toContain("1 min 48 s");
    expect(hote.textContent).not.toContain("tokens");
    lignes[1]?.click();
    expect(ouverts).toEqual([1]);
  });
});

function modales(run: ExecutionSousAgent): object {
  return reactive({
    taskModal: { idx: 1, ri: 0, cid: run.id, snap: run },
    taskModalStep: null,
    taskModalRun: () => run,
    closeTaskModal: () => appels.push(["fermer"]),
    renderMarkdown: (t: string) => "<p>" + t + "</p>",
    fmtTokens: (n: number) => String(n),
    fmtToolMs: (n: number) => n + " ms",
    logoApp: "x.png",
  });
}
const fil = {
  cancelTaskRun: (r: ExecutionSousAgent) => appels.push(["arreter", r.id]),
  showToast: () => undefined,
};

describe("jetons d'un sous-agent", () => {
  it("jetons comme le message principal : contexte de la dernière requête rapporté par le moteur, cumuls dans le détail ; rien avant la première requête", () => {
    expect(jetonsAgent({ state: "running", tokens: 0 })).toEqual({ conso: "", detail: "" });
    const j = jetonsAgent({
      state: "completed",
      tokens: 42_956,
      input_tokens: 247_389,
      output_tokens: 2_990,
      cache_tokens: 1_500,
      think_tokens: 500,
    });
    expect(j.conso).toBe("43 k jetons");
    expect(j.detail).toBe(
      "Contexte 43 k à la dernière requête au moteur\n" +
        "Entrée 247 k cumulée sur ses appels au moteur · cache 1,5 k (1 %)\n" +
        "Sortie 3 k · réflexion 500 · réponse 2,5 k",
    );
    expect(jetonsAgent({ state: "completed", input_tokens: 10, output_tokens: 5 })).toEqual({
      conso: "",
      detail: "Entrée 10 cumulée sur ses appels au moteur\nSortie 5",
    });
  });
});

describe("sous-agent en fond vu à travers son job", () => {
  const job = (o: Partial<ResumeJob> = {}, agent: Record<string, unknown> = {}): ResumeJob => ({
    id: "j-00000001",
    chat_id: "c1",
    chat_title: "Projet",
    label: "explore — carte",
    command: "",
    state: "running",
    wake_on: ["exit"],
    wake: true,
    pid: null,
    exit_code: null,
    signal: null,
    created_at: 1_800_000_000,
    started_at: 1_800_000_000,
    ended_at: null,
    last_line: "",
    log: "",
    pending_events: 0,
    kind: "agent",
    agent: { child_id: "t1-aa", agent: "explore", state: "running", ...agent },
    ...o,
  });
  const run: ExecutionSousAgent = {
    id: "t1-aa",
    agent: "explore",
    state: "running",
    background: true,
    job_id: "j-00000001",
    input_tokens: 100,
  };

  it("en cours : progression et jetons du job, sans revenir en arrière ; run ordinaire ou job absent inchangé", () => {
    const vu = avecJobFond(run, [
      job({}, { step: 4, max_steps: 60, input_tokens: 9_000, output_tokens: 200, started_at: 1_800_000_010 }),
    ]);
    expect(vu).toMatchObject({ state: "running", progress: { step: 4, max_steps: 60 }, input_tokens: 9_000 });
    expect(vu.startedAt).toBe(1_800_000_010_000);
    expect(avecJobFond(run, [job({}, { step: 1 })]).startedAt).toBeUndefined();
    expect(
      avecJobFond({ ...run, input_tokens: 20_000 }, [job({}, { input_tokens: 9_000 })]).input_tokens,
    ).toBe(20_000);
    const ordinaire = { ...run, background: false };
    expect(avecJobFond(ordinaire, [job()])).toBe(ordinaire);
    expect(avecJobFond(run, [])).toBe(run);
  });

  it("fini : état, bloc du harnais validé, rapport, durée ; perdu au redémarrage : « interrompu par un redémarrage »", () => {
    const harness = {
      status: "done",
      tool_calls: 3,
      tool_calls_total: 3,
      iterations: 3,
      resumed: false,
      duration_s: 42,
      files_changed: [],
      git: { commits: [] },
      errors: 0,
      read_only: true,
      report_chars: 9,
    };
    const fini = avecJobFond(run, [
      job(
        { state: "exited" },
        { state: "completed", status: "done", harness, result: "Trouvé.", tool_calls: 3, duration_s: 42 },
      ),
    ]);
    expect(fini).toMatchObject({
      state: "completed",
      steps_total: 3,
      duration_ms: 42_000,
      result: "Trouvé.",
    });
    expect(fini.harness?.status).toBe("done");
    expect(bilanCourtAgent(fini)).toBe("3 appels");
    const perdu = avecJobFond(run, [job({ state: "lost" }, { state: "lost" })]);
    expect(perdu.state).toBe("lost");
    expect(bilanCourtAgent(perdu)).toBe("interrompu par un redémarrage");
  });
});

describe("fenêtre de l'agent", () => {
  it("modale large : en-tête (agent, mission), état, horloge, jetons, Arrêter, consigne, déroulé ; Échap et clic à côté ferment", async () => {
    const hote = monter(() => h(ModaleAgent), {
      modales: modales({ ...enCours, prompt: "Relire le diff : performances" }),
      fil,
    });
    await nextTick();
    const fenetre = hote.querySelector("[data-modale-agent]") as HTMLElement;
    expect(fenetre.getAttribute("role")).toBe("dialog");
    expect(fenetre.getAttribute("aria-modal")).toBe("true");
    expect(fenetre.hasAttribute("data-a11y-modal")).toBe(true);
    expect(fenetre.querySelector("h3")?.textContent?.replace(/\s+/g, " ").trim()).toBe(
      "Agent performances — Relire le diff",
    );
    expect(fenetre.querySelector("[data-etat-agent]")?.textContent?.replace(/\s+/g, " ")).toContain(
      "en cours · 2 min 05 s · 8,2 k jetons",
    );
    expect(fenetre.querySelector("[data-etat-agent]")?.textContent).not.toContain("ctx");
    expect(fenetre.querySelector("[data-consigne-agent]")?.textContent).toContain("Consigne reçue");
    expect(fenetre.querySelector("[data-rendu-agent]")).toBeNull();
    expect(fenetre.querySelectorAll("[data-deroule-agent] [data-ligne-etapes]").length).toBe(2);
    (fenetre.querySelector("[data-arreter-agent]") as HTMLButtonElement).click();
    fenetre.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    fenetre.click();
    expect(appels).toEqual([["arreter", "k1"], ["fermer"], ["fermer"]]);
  });

  it("message de l'assistant à l'agent en fond (task_send) : bloc à sa place dans le déroulé, entre les étapes", async () => {
    const run = {
      ...enCours,
      transcript: [
        { tool: "read_file", args_preview: '{"path": "a.ts"}', status: "done" },
        { parent: "Regarde aussi **b.ts**." },
        { tool: "read_file", args_preview: '{"path": "b.ts"}', status: "running" },
      ],
    } as ExecutionSousAgent;
    expect(chronologieAgent(run).map((b) => b.k)).toEqual(["etapes", "parent", "etapes"]);
    const hote = monter(() => h(ModaleAgent), { modales: modales(run), fil });
    await nextTick();
    const message = hote.querySelector("[data-deroule-agent] [data-message-parent]") as HTMLElement;
    expect(message.textContent).toContain("Message de l'assistant");
    expect(message.innerHTML).toContain("<p>Regarde aussi **b.ts**.</p>");
    const etapes = hote.querySelectorAll("[data-deroule-agent] [data-ligne-etapes]");
    expect(etapes.length).toBe(2);
    expect(!!(etapes[0]!.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
    expect(!!(message.compareDocumentPosition(etapes[1]!) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true);
  });

  it("ordre de lecture : consigne, bilan, « Rendu à l'assistant », puis le déroulé", async () => {
    const harness = lireBilanTache({
      status: "done",
      tool_calls: 14,
      tool_calls_total: 14,
      iterations: 14,
      resumed: false,
      duration_s: 108,
      files_changed: [],
      git: { commits: [] },
      errors: 0,
      read_only: true,
      report_chars: 9,
    });
    expect(harness).not.toBeNull();
    const hote = monter(() => h(ModaleAgent), { modales: modales({ ...fini, harness: harness! }), fil });
    await nextTick();
    const consigne = hote.querySelector("[data-consigne-agent]") as HTMLElement;
    const bilan = hote.querySelector("[data-task-harness]") as HTMLElement;
    const rendu = hote.querySelector("[data-rendu-agent]") as HTMLElement;
    const deroule = hote.querySelector("[data-deroule-agent]") as HTMLElement;
    const suit = (a: Node, b: Node): boolean =>
      !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect([suit(consigne, bilan), suit(bilan, rendu), suit(rendu, deroule)]).toEqual([true, true, true]);
    expect(deroule.querySelector("[data-ligne-etapes]")).not.toBeNull();
    expect([...rendu.querySelectorAll("button")].map((b) => b.textContent?.trim())).toEqual(["Copier"]);
  });

  it("agent fini : « Rendu à l'assistant » entier, sans Arrêter", async () => {
    const hote = monter(() => h(ModaleAgent), { modales: modales(fini), fil });
    await nextTick();
    const rendu = hote.querySelector("[data-rendu-agent]");
    expect(rendu?.textContent).toContain("Rendu à l'assistant");
    expect(rendu?.innerHTML).toContain("Trois constats");
    expect(hote.querySelector("[data-arreter-agent]")).toBeNull();
    expect(hote.querySelector("[data-etat-agent]")?.textContent?.replace(/\s+/g, " ")).toContain(
      "fini · 1 min 48 s",
    );
  });
});
