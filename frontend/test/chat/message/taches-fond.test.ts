// SPDX-License-Identifier: MIT
/** frontend/test/chat/message/taches-fond.test.ts — tâches de fond dans le fil  : ligne vivante de la tâche (états, horloge du serveur, clic, réveils en infobulle), bulle qui attend son réveil (« En attente de … », « Reprise… ») puis UNE réponse continue avec un seul pied à la fin, même rendu après rechargement, déroulé Classique intacte. */
import { createApp, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResumeJob } from "@elpis/contracts";

import type { ResumeReveil } from "@elpis/contracts";

import CorpsMessage from "../../../src/components/chat/message/CorpsMessage.vue";
import MessageChat from "../../../src/components/chat/message/MessageChat.vue";
import { chronologieTour } from "../../../src/features/chat/message/chronologie";
import {
  appelDeLancement,
  attenteDeBulle,
  etatJobFil,
  horlogeJob,
  jobsAttendus,
  reveilDuJob,
} from "../../../src/features/chat/message/taches-fond";
import type {
  ContexteMessage,
  EntreeMessage,
  MessageAffiche,
} from "../../../src/features/chat/message/types";
import type { EtapeOutil } from "../../../src/features/chat/outils/types";
import { CLE_CONVERSATION, CLE_FIL, CLE_PAGE } from "../../../src/features/chat/page/domaines";
import type { DomaineConversation } from "../../../src/features/chat/page/types";
import type { DomainePage } from "../../../src/features/chat/page/types";
import { CLE_PREFERENCES_CHAT } from "../../../src/features/reglages/affichage-chat";
import { prefsDeroule } from "../preferences";
import { noterHeureServeur, oublierHeureServeur } from "../../../src/platform/horloge";
import { job } from "../jobs/outils-jobs";

let app: App | null = null;
const appels: unknown[][] = [];

afterEach(() => {
  app?.unmount();
  app = null;
  appels.length = 0;
  document.body.innerHTML = "";
  oublierHeureServeur();
  vi.useRealTimers();
});

const ID = "j-3f2a1c9e";
const lancement = (extra: Partial<EtapeOutil> = {}): EtapeOutil => ({
  name: "shell_job",
  status: "done",
  args: { action: "start", label: "serveur", command: "npm run dev", wake_on: ["exit"] },
  result: JSON.stringify({ success: true, job_id: ID, pid: 4242, state: "running" }),
  durationMs: 40,
  seg: 0,
  callId: "call-j",
  ...extra,
});
const serveur = (surcharges: Partial<ResumeJob> = {}): ResumeJob =>
  job({ label: "serveur", command: "npm run dev", wake_on: ["exit"], ...surcharges });

function contexte(reglages: Record<string, unknown> = {}): ContexteMessage {
  const etat = reactive({
    settings: { hide_thinking: false, enable_editor: true, ...reglages },
    lastAssistantIdx: 1,
    isStreaming: false,
    logoApp: "x.png",
    compressionStatus: null,
    messageSearchQ: "",
    messageSearchActive: false,
  });
  const neutres: Record<string, unknown> = {
    pipelineFor: () => ({ show: true, nTools: 1, nComp: 0, running: false, label: "", summary: "" }),
    segGroupsFor: () => [],
    effectLinesFor: () => [],
    diffFilesFor: () => [],
    hasDiffFiles: () => false,
    isDiffEditorEnabled: () => false,
    isImageMessage: () => false,
    statusPhase: () => null,
    fmtThinkingMeta: () => "",
    fmtElapsed: (s: number) => s + " s",
    thinkingTokensOf: () => 0,
    cachePctOf: () => 0,
    metricsTooltip: () => "",
    toolLimitLabel: () => "",
  };
  return new Proxy(etat, {
    get(cible, cle: string) {
      if (cle in cible) return (cible as Record<string, unknown>)[cle];
      if (cle in neutres) return neutres[cle];
      return (...args: unknown[]) => void appels.push([cle, ...args]);
    },
  }) as unknown as ContexteMessage;
}

type PageJobs = Pick<
  DomainePage,
  | "currentChatId"
  | "jobsChat"
  | "jobsReveilDesactive"
  | "jobsFileReveil"
  | "jobsReveilEnCours"
  | "jobsReveilsPrevus"
  | "messages"
  | "jobsOuvrirJournal"
  | "jobsBasculer"
>;

function pageJobs(
  jobs: ResumeJob[],
  messages: unknown[] = [],
  desactive = false,
  reveils: Partial<Pick<PageJobs, "jobsFileReveil" | "jobsReveilEnCours" | "jobsReveilsPrevus">> = {},
): PageJobs {
  return reactive({
    currentChatId: "c1",
    jobsChat: jobs,
    jobsReveilDesactive: desactive,
    jobsFileReveil: [],
    jobsReveilEnCours: [],
    jobsReveilsPrevus: [],
    ...reveils,
    messages,
    jobsOuvrirJournal: (j: ResumeJob) => void appels.push(["jobsOuvrirJournal", j.id]),
    jobsBasculer: (v?: boolean) => void appels.push(["jobsBasculer", v]),
  }) as unknown as PageJobs;
}

interface Montage {
  classique?: boolean;
  page?: PageJobs | null;
  reglages?: Record<string, unknown>;
  idx?: number;
}

const conv = reactive({ isUserScrolling: false });

function monterRendu(rendu: () => ReturnType<typeof h>, o: Montage): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: rendu });
  app.provide(CLE_PREFERENCES_CHAT, prefsDeroule(o.classique ? "classic" : "timeline"));
  app.provide(CLE_FIL, contexte(o.reglages));
  app.provide(CLE_CONVERSATION, conv as unknown as DomaineConversation);
  if (o.page) app.provide(CLE_PAGE, o.page as DomainePage);
  app.mount(hote);
  return hote;
}

function monter(msg: MessageAffiche, o: Montage = {}): HTMLElement {
  return monterRendu(() => h(CorpsMessage, { entry: { idx: o.idx ?? 1, msg } }), o);
}

function monterBulle(entry: EntreeMessage, o: Montage = {}): HTMLElement {
  return monterRendu(() => h(MessageChat, { entry }), o);
}

const reponse = (steps: EtapeOutil[], extra: Partial<MessageAffiche> = {}): MessageAffiche => ({
  role: "assistant",
  content: "Le serveur tourne ; je vous préviens s'il s'arrête.",
  segTexts: ["Je lance le serveur."],
  toolSteps: steps,
  metrics: { model: "qwen3-coder" },
  ...extra,
});

const texte = (e: Element | null | undefined): string => (e?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("chronologie : l'appel qui lance une tâche de fond", () => {
  it("devient un bloc à part, hors des étapes numérotées ; les autres actions de shell_job restent des étapes", () => {
    const blocs = chronologieTour({
      segTexts: [""],
      toolSteps: [
        { name: "read_file", status: "done", args: { path: "a" }, seg: 0, callId: "a" },
        lancement(),
        { name: "shell_job", status: "done", args: { action: "status", job_id: ID }, seg: 0, callId: "s" },
      ],
    });
    expect(blocs.map((b) => [b.k, b.cle])).toEqual([
      ["etapes", "e:0"],
      ["job", "j:1"],
      ["etapes", "e:2"],
    ]);
    const derniere = blocs[2];
    expect(derniere?.k === "etapes" && derniere.etapes[0]?.numero).toBe(2);
  });

  it("appel de lancement retrouvé par l'id du job dans son résultat, pas par un appel « status »", () => {
    const messages = [
      { role: "assistant", toolSteps: [lancement()] },
      {
        role: "assistant",
        toolSteps: [
          {
            name: "shell_job",
            args: { action: "status" },
            result: `{"jobs":[{"job_id":"${ID}"}]}`,
            callId: "s",
          },
        ],
      },
    ];
    expect(appelDeLancement(messages, ID)).toBe("call-j");
    expect(appelDeLancement(messages, "j-00000000")).toBeNull();
  });
});

describe("état d'une tâche de fond", () => {
  it("en cours, terminée, échec, arrêtée, perdue ; sans job connu : lancement, échec du lancement, lancée", () => {
    const e = lancement();
    expect(etatJobFil(e, serveur({ started_at: 1000 }), 1038).texte).toBe("en cours · 0 min 38 s");
    expect(etatJobFil(e, serveur({ state: "exited", exit_code: 0, ended_at: 1042 }), 2000)).toEqual({
      signe: "ok",
      texte: "terminée · 42 s",
      duree: "42 s",
    });
    expect(etatJobFil(e, serveur({ state: "exited", exit_code: 1, ended_at: 1042 }), 2000).texte).toBe(
      "échec · code 1",
    );
    expect(
      etatJobFil(e, serveur({ state: "exited", exit_code: null, signal: "SIGSEGV", ended_at: 1001 }), 0)
        .texte,
    ).toBe("échec · SIGSEGV");
    expect(etatJobFil(e, serveur({ state: "killed", ended_at: 1065 }), 2000)).toMatchObject({
      signe: "arret",
      texte: "arrêtée",
      duree: "1 min 05 s",
    });
    expect(etatJobFil(e, serveur({ state: "lost" }), 2000).texte).toBe("perdue");
    expect(etatJobFil(e, serveur({ state: "failed", started_at: null }), 2000).texte).toBe(
      "échec du lancement",
    );
    expect(etatJobFil({ ...e, status: "running", result: null }, null, 0).texte).toBe("lancement");
    expect(etatJobFil({ ...e, _is_error: true }, null, 0)).toMatchObject({ signe: "echec" });
    expect(etatJobFil(e, null, 0)).toMatchObject({ signe: "inconnu", texte: "lancée" });
    expect(horlogeJob(3725)).toBe("1 h 02 min");
  });
});

describe("ligne de tâche dans le fil ", () => {
  it("remplace l'étape « ✓ » : nom, commande, « en cours » à l'heure du serveur, data-etape de l'appel", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    // L'horloge du serveur avance de trois minutes sur celle du poste.
    noterHeureServeur(new Date(1_700_000_180_000).toUTCString(), 1_700_000_000_000);
    const depart = 1_700_000_180 - 38;
    const hote = monter(reponse([lancement()]), { page: pageJobs([serveur({ started_at: depart })]) });
    const ligne = hote.querySelector("[data-ligne-job]");
    expect(ligne?.getAttribute("data-etape")).toBe("call-j");
    expect(ligne?.getAttribute("data-job")).toBe(ID);
    expect(texte(ligne)).toContain("serveur · npm run dev");
    expect(texte(ligne?.querySelector("[data-etat-job]"))).toBe("en cours · 0 min 38 s");
    expect(ligne?.querySelector(".ph-spinner-gap")).not.toBeNull();
    expect(hote.querySelector("[data-ligne-etapes]")).toBeNull();
    expect(hote.querySelector(".ph-check")).toBeNull();
    vi.advanceTimersByTime(2000);
    await nextTick();
    expect(texte(hote.querySelector("[data-etat-job]"))).toBe("en cours · 0 min 40 s");
  });

  it("échec : signe rouge, texte neutre « échec · code 1 » ; arrêtée : signe neutre", () => {
    const echec = monter(reponse([lancement()]), {
      page: pageJobs([serveur({ state: "exited", exit_code: 1, ended_at: 1042 })]),
    });
    const etat = echec.querySelector("[data-etat-job]");
    expect(texte(etat)).toBe("échec · code 1");
    expect(etat?.className).not.toContain("red");
    expect(echec.querySelector("[data-ligne-job] .ph-x-circle")?.className).toContain("text-red-500");
    app?.unmount();
    const arretee = monter(reponse([lancement()]), {
      page: pageJobs([serveur({ state: "killed", ended_at: 1065 })]),
    });
    expect(texte(arretee.querySelector("[data-etat-job]"))).toBe("arrêtée");
    expect(arretee.querySelector("[data-ligne-job] .ph-stop-circle")).not.toBeNull();
  });

  it("clic : journal de la tâche ; éditeur désactivé : volet des tâches de fond ; job inconnu : détail de l'appel", () => {
    const j = serveur();
    const hote = monter(reponse([lancement()]), { page: pageJobs([j]) });
    hote.querySelector<HTMLButtonElement>("[data-ligne-job]")?.click();
    expect(appels).toContainEqual(["jobsOuvrirJournal", ID]);
    app?.unmount();
    appels.length = 0;
    const sansEditeur = monter(reponse([lancement()]), {
      page: pageJobs([j]),
      reglages: { enable_editor: false },
    });
    sansEditeur.querySelector<HTMLButtonElement>("[data-ligne-job]")?.click();
    expect(appels).toEqual([["jobsBasculer", true]]);
    app?.unmount();
    appels.length = 0;
    const inconnu = monter(reponse([lancement()]), { page: pageJobs([]) });
    expect(texte(inconnu.querySelector("[data-etat-job]"))).toBe("lancée");
    inconnu.querySelector<HTMLButtonElement>("[data-ligne-job]")?.click();
    expect(appels).toContainEqual(["setMsgUi", { idx: 1, msg: expect.anything() }, { _activeToolStep: 0 }]);
  });

  it("label absent : la commande sert de nom ; monté sans page du chat : la ligne reste, état d'après l'appel", () => {
    const sansLabel = lancement({ args: { action: "start", command: "pytest -q" } });
    const hote = monter(reponse([sansLabel]), { page: null });
    const ligne = hote.querySelector("[data-ligne-job]");
    expect(texte(ligne?.querySelector("b"))).toBe("pytest -q");
    expect(ligne?.querySelector(".font-mono")).toBeNull();
    expect(texte(ligne?.querySelector("[data-etat-job]"))).toBe("lancée");
  });

  it("déroulé Classique : aucune ligne de tâche, l'ancien rendu des outils", () => {
    const hote = monter(reponse([lancement()]), { classique: true, page: pageJobs([serveur()]) });
    expect(hote.querySelector("[data-ligne-job]")).toBeNull();
    expect(hote.querySelector("[data-fil-tour]")).toBeNull();
    expect(hote.querySelector("[data-pipeline]")).not.toBeNull();
  });
});

const REVEIL: ResumeReveil = {
  summary: "serveur terminé, code 1, 42 s",
  events: [
    {
      job_id: ID,
      label: "serveur",
      trigger: "exit",
      state: "exited",
      exit_code: 1,
      signal: null,
      duration_s: 42,
    },
  ],
  depth: 1,
};
const copier = "button[title='Copier la réponse']";

describe("réponse qui attend son réveil", () => {
  const enFile = { chat_id: "c1", chat_title: "", since: 1, events: 1 };
  const enCours = { chat_id: "c1", chat_title: "", run_id: "r1", started_at: 1 };

  it("attend ses tâches actives, ou finies au réveil en route, sans réveil arrivé ni message de l'utilisateur depuis", () => {
    const msg = reponse([lancement()]);
    const entree = { idx: 1, msg };
    const actif = serveur();
    const p = (jobs: ResumeJob[], reveils = {}): PageJobs => pageJobs(jobs, [], false, reveils);
    expect(jobsAttendus(entree, p([actif]), [])).toEqual([actif]);
    expect(jobsAttendus(entree, pageJobs([actif], [], true), [])).toEqual([]);
    expect(jobsAttendus(entree, p([serveur({ wake: false })]), [])).toEqual([]);
    expect(jobsAttendus(entree, p([serveur({ state: "killed" })]), [])).toEqual([]);
    expect(jobsAttendus({ idx: 1, msg: { ...msg, isStreaming: true } }, p([actif]), [])).toEqual([]);
    const apres = [{}, msg, { role: "user", origin: "job_wake", wake: REVEIL }];
    expect(jobsAttendus(entree, p([actif]), apres)).toEqual([]);
    expect(jobsAttendus({ idx: 3, msg }, p([actif]), apres)).toEqual([actif]);
    expect(jobsAttendus(entree, p([actif]), [{}, msg, { role: "user", content: "Autre chose" }])).toEqual([]);
    const fini = serveur({ state: "exited", exit_code: 1, ended_at: 1042, pending_events: 1 });
    expect(jobsAttendus(entree, p([fini]), [])).toEqual([]);
    expect(jobsAttendus(entree, p([fini], { jobsReveilsPrevus: [ID] }), [])).toEqual([fini]);
    expect(jobsAttendus(entree, p([fini], { jobsFileReveil: [enFile] }), [])).toEqual([fini]);
    expect(jobsAttendus(entree, p([fini], { jobsReveilEnCours: [enCours] }), [])).toEqual([fini]);
    expect(jobsAttendus(entree, p([fini], { jobsFileReveil: [{ ...enFile, chat_id: "c2" }] }), [])).toEqual(
      [],
    );
    expect(
      jobsAttendus(entree, p([{ ...fini, pending_events: 0 }], { jobsFileReveil: [enFile] }), []),
    ).toEqual([]);
  });

  it("fin de bulle : tâches de toutes ses réponses ; rien si la dernière s'écrit, a échoué ou a été interrompue", () => {
    const page = pageJobs([serveur()]);
    const membres = (extra: Partial<MessageAffiche>) => [
      { idx: 1, msg: reponse([lancement()]) },
      { idx: 2, msg: { role: "user", origin: "job_wake", wake: { ...REVEIL, events: [] } } },
      { idx: 3, msg: { role: "assistant", content: "Suite.", ...extra } },
    ];
    expect(attenteDeBulle(membres({}), page, []).map((j) => j.id)).toEqual([ID]);
    for (const extra of [{ isStreaming: true }, { isError: true }, { isTruncated: true }])
      expect(attenteDeBulle(membres(extra), page, [])).toEqual([]);
    expect(attenteDeBulle(membres({}).slice(0, 2), page, [])).toEqual([]);
  });

  it("pied masqué : « En attente de « serveur » » et l'horloge ; la tâche finie, « Reprise… » jusqu'à la reprise", async () => {
    vi.useFakeTimers({ now: 1_700_000_000_000 });
    noterHeureServeur(new Date(1_700_000_120_000).toUTCString(), 1_700_000_000_000);
    const page = pageJobs([serveur({ started_at: 1_700_000_120 - 38 })]);
    const hote = monterBulle({ idx: 1, msg: reponse([lancement()]) }, { page });
    const attente = (): Element | null => hote.querySelector("[data-attente-job]");
    expect(texte(attente())).toBe("En attente de « serveur » · 0 min 38 s");
    expect(attente()?.getAttribute("title")).toBe("Réveil : fin du programme");
    expect(attente()?.querySelector("button")).toBeNull();
    expect(hote.querySelector(copier)).toBeNull();
    expect(hote.textContent).not.toContain("qwen3-coder");
    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(texte(attente())).toBe("En attente de « serveur » · 0 min 39 s");
    // Fin vue en direct (même tick que la liste des tâches), puis réveil en file, puis en cours.
    page.jobsChat = [serveur({ state: "exited", exit_code: 1, ended_at: 1_700_000_130, pending_events: 1 })];
    page.jobsReveilsPrevus = [ID];
    await nextTick();
    expect(texte(attente())).toBe("Reprise…");
    expect(attente()?.hasAttribute("data-reprise")).toBe(true);
    expect(attente()?.getAttribute("title")).toBe("Réveil par « serveur »");
    expect(hote.querySelector(copier)).toBeNull();
    page.jobsReveilsPrevus = [];
    page.jobsFileReveil = [enFile];
    await nextTick();
    expect(texte(attente())).toBe("Reprise…");
    page.jobsFileReveil = [];
    page.jobsReveilEnCours = [enCours];
    await nextTick();
    expect(texte(attente())).toBe("Reprise…");
    expect(hote.querySelector(copier)).toBeNull();
    // Réveil écarté (quota, profondeur) : plus rien en route, le pied revient.
    page.jobsReveilEnCours = [];
    await nextTick();
    expect(attente()).toBeNull();
    expect(hote.querySelector(copier)).not.toBeNull();
    expect(hote.textContent).toContain("qwen3-coder");
  });

  it("aucun réveil à venir : pied normal (fin sans réveil en route, désactivé, sans réveil, arrêtée, réponse interrompue)", () => {
    const cas: [PageJobs, Partial<MessageAffiche>][] = [
      [pageJobs([serveur({ state: "exited", exit_code: 1, ended_at: 1042, pending_events: 1 })]), {}],
      [pageJobs([serveur()], [], true), {}],
      [pageJobs([serveur({ wake: false })]), {}],
      [pageJobs([serveur({ state: "killed", ended_at: 1065, pending_events: 1 })]), {}],
      [pageJobs([serveur()]), { isTruncated: true }],
    ];
    for (const [page, extra] of cas) {
      const hote = monterBulle({ idx: 1, msg: reponse([lancement()], extra) }, { page });
      expect(hote.querySelector("[data-attente-job]")).toBeNull();
      expect(hote.querySelector(copier)).not.toBeNull();
      app?.unmount();
      app = null;
    }
  });
});

describe("réveil : une seule réponse continue ", () => {
  const ID2 = "j-0000aaaa";
  const W: MessageAffiche = {
    role: "user",
    origin: "job_wake",
    wake: REVEIL,
    content: "[Automatic wake-up] 1",
  };
  const bulle = (extra: Partial<MessageAffiche> = {}, etapes = [lancement()]): EntreeMessage => ({
    idx: 1,
    msg: reponse(etapes, { run_ids: ["r0"] }),
    suite: [
      { idx: 2, msg: { ...W } },
      {
        idx: 3,
        msg: {
          role: "assistant",
          content: "Le port 3000 est déjà pris.",
          metrics: { model: "m-reveil" },
          run_ids: ["r1"],
          ...extra,
        },
      },
    ],
  });
  const messages = (e: EntreeMessage): unknown[] => [
    { role: "user", content: "Lance le serveur." },
    e.msg,
    ...(e.suite ?? []).map((s) => s.msg),
  ];
  const fini = (pending = 0): ResumeJob =>
    serveur({ state: "exited", exit_code: 1, ended_at: 1042, pending_events: pending });

  it("texte d'avant, ligne de la tâche avec son issue, reprise : ni ligne de réveil ni pied intermédiaire", () => {
    const e = bulle();
    const hote = monterBulle(e, { page: pageJobs([fini()], messages(e)) });
    expect(hote.querySelectorAll(".elpis-msg-assistant").length).toBe(1);
    expect(hote.querySelector("[data-wake-line]")).toBeNull();
    expect(hote.textContent).not.toContain("Automatic wake-up");
    expect(hote.textContent).not.toContain("Réveil");
    const ligneJob = hote.querySelector("[data-ligne-job]");
    expect(texte(ligneJob?.querySelector("[data-etat-job]"))).toBe("échec · code 1");
    const t = hote.textContent ?? "";
    const ordre = [
      "Je lance le serveur.",
      "npm run dev",
      "Le serveur tourne",
      "Le port 3000 est déjà pris.",
    ].map((x) => t.indexOf(x));
    expect(ordre.every((p) => p >= 0)).toBe(true);
    expect([...ordre].sort((a, b) => a - b)).toEqual(ordre);
    expect(hote.querySelectorAll(copier).length).toBe(1);
    expect(hote.querySelector("[data-vs-part='3'] " + copier)).not.toBeNull();
    expect(hote.querySelector("[data-attente-job]")).toBeNull();
    expect(t).toContain("m-reveil");
    expect(t).not.toContain("qwen3-coder");
    expect(ligneJob?.getAttribute("title")).toContain("Réveil · « serveur » terminé (code 1)");
  });

  it("pied final : Copier prend les deux parties dans l'ordre ; Régénérer et Détails visent la dernière réponse", () => {
    const e = bulle();
    const hote = monterBulle(e, { page: pageJobs([fini()], messages(e)) });
    hote.querySelector<HTMLButtonElement>(copier)?.click();
    expect(appels).toContainEqual([
      "copyAssistantMessage",
      "Je lance le serveur.\n\nLe serveur tourne ; je vous préviens s'il s'arrête.\n\nLe port 3000 est déjà pris.",
    ]);
    const regenerer = hote.querySelectorAll<HTMLButtonElement>("button[title='Régénérer la réponse']");
    expect(regenerer.length).toBe(1);
    regenerer[0]?.click();
    expect(appels).toContainEqual(["retryGeneration", 3]);
    hote.querySelector<HTMLButtonElement>('button[aria-label="Détails de l\'exécution"]')?.click();
    expect(appels.find((a) => a[0] === "openRunDetails")?.[1]).toMatchObject({ run_ids: ["r1"] });
  });

  it("réponse du réveil qui s'écrit : ni pied ni attente dans la bulle", () => {
    const e = bulle({ isStreaming: true, content: "Le port" });
    const page = pageJobs([fini(1)], messages(e), false, { jobsReveilsPrevus: [ID] });
    const hote = monterBulle(e, { page });
    expect(hote.querySelector(copier)).toBeNull();
    expect(hote.querySelector("[data-attente-job]")).toBeNull();
  });

  it("une autre tâche de la bulle tourne encore : l'attente est à la fin de la bulle, jamais entre les parties", () => {
    const tests = lancement({
      callId: "call-t",
      args: { action: "start", label: "tests", command: "npm test", wake_on: ["exit"] },
      result: JSON.stringify({ success: true, job_id: ID2, state: "running" }),
    });
    const e = bulle({}, [lancement(), tests]);
    const jobs = [fini(), job({ id: ID2, label: "tests", command: "npm test", wake_on: ["exit"] })];
    const hote = monterBulle(e, { page: pageJobs(jobs, messages(e)) });
    const attente = hote.querySelectorAll("[data-attente-job]");
    expect(attente.length).toBe(1);
    expect(hote.querySelector("[data-vs-part='3'] [data-attente-job]")).toBe(attente[0]);
    expect(texte(attente[0])).toMatch(/^En attente de « tests »/);
    expect(hote.querySelector(copier)).toBeNull();
  });

  it("rechargement : même rendu à partir de l'historique (messages de réveil relus, liste des tâches relue)", () => {
    const direct = bulle();
    const enDirect = monterBulle(direct, {
      page: pageJobs([fini(1)], messages(direct), false, { jobsReveilsPrevus: [ID] }),
    }).innerHTML;
    app?.unmount();
    app = null;
    document.body.innerHTML = "";
    const relu = bulle();
    const apres = monterBulle(relu, { page: pageJobs([fini(0)], messages(relu)) }).innerHTML;
    expect(apres).toBe(enDirect);
    expect(apres).not.toContain("data-wake-line");
  });

  it("message de réveil seul (pas de réponse de l'agent avant lui) : rien d'affiché", () => {
    const seul = monterBulle({ idx: 2, msg: { ...W } }, { page: pageJobs([]) });
    const ligne = seul.querySelector<HTMLElement>(".elpis-msg-wake[data-vs-idx='2']");
    expect(ligne?.hidden).toBe(true);
    expect(texte(ligne)).toBe("");
  });

  it("trace : réveils d'une tâche pour l'infobulle de sa ligne, plusieurs déclencheurs, aucun", () => {
    const port = {
      ...REVEIL.events[0]!,
      trigger: "port" as const,
      state: "running" as const,
      exit_code: null,
    };
    const autre = { ...REVEIL.events[0]!, job_id: ID2, label: "tests" };
    const msgs = [
      { role: "user", origin: "job_wake", wake: { ...REVEIL, events: [port, autre] } },
      { role: "assistant", content: "x" },
      { role: "user", origin: "job_wake", wake: REVEIL },
    ];
    expect(reveilDuJob(msgs, ID)).toBe(
      "Réveil · « serveur » : port en écoute ; « serveur » terminé (code 1)",
    );
    expect(reveilDuJob(msgs, ID2)).toBe("Réveil · « tests » terminé (code 1)");
    expect(reveilDuJob(msgs, "j-ffffffff")).toBe("");
  });
});
