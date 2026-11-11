// SPDX-License-Identifier: MIT
/** frontend/test/chat/page/activite.test.ts — tâches de fond : rien au-dessus du composeur, échec signalé par un toast « Aller au message » (étape du fil ou volet), puce des tâches de fond dans la rangée du composeur. */
import { effectScope, nextTick } from "vue";
import type { InjectionKey } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import BarreComposeur from "../../../src/components/chat/page/BarreComposeur.vue";
import { allerALEtape, appelDuJob } from "../../../src/features/chat/page/activite";
import {
  CLE_COMPOSEUR,
  CLE_ENTETE,
  CLE_IMAGE,
  CLE_MODELES,
  CLE_PAGE,
} from "../../../src/features/chat/page/domaines";
import { utiliserEchecsJobs } from "../../../src/features/chat/page/echecs-jobs";
import { job } from "../jobs/outils-jobs";
import { appelsDe, demonter, etat, monter } from "./montage";

vi.mock("../../../src/components/voix/BoutonMicro.vue", async () => {
  const { defineComponent, h } = await import("vue");
  return { default: defineComponent({ render: () => h("button", { "data-stub": "micro" }) }) };
});

afterEach(() => {
  demonter();
  vi.useRealTimers();
});

const cle = (k: InjectionKey<unknown>): InjectionKey<object> => k as InjectionKey<object>;

const MESSAGES = [
  { role: "user", content: "Lance le serveur" },
  {
    role: "assistant",
    isStreaming: true,
    toolSteps: [
      {
        name: "shell_job",
        status: "done",
        callId: "call-1",
        result: '{"id":"j-00000001","state":"running"}',
      },
      { name: "read_file", status: "running", callId: "call-2" },
    ],
  },
];

describe("retour au fil", () => {
  it("appel shell_job d'un job", () => {
    expect(appelDuJob(MESSAGES, "j-00000001")).toBe("call-1");
    expect(appelDuJob(MESSAGES, "j-99999999")).toBeNull();
  });

  it("aller à une étape : défile jusqu'à [data-etape] et surligne ; faux si la ligne manque", () => {
    const ligne = document.createElement("div");
    ligne.dataset.etape = "call-1";
    document.body.appendChild(ligne);
    const defiler = vi.fn();
    ligne.scrollIntoView = defiler;
    expect(allerALEtape("call-1")).toBe(true);
    expect(defiler).toHaveBeenCalledTimes(1);
    expect(allerALEtape("call-x")).toBe(false);
    expect(allerALEtape(null)).toBe(false);
  });

  it("aller à une étape d'un groupe replié : la ligne du groupe, pas l'entrée masquée", () => {
    const groupe = document.createElement("div");
    groupe.dataset.etape = "call-3";
    groupe.dataset.etapes = "call-2 call-3";
    const liste = document.createElement("ol");
    liste.hidden = true;
    const masquee = document.createElement("li");
    masquee.dataset.etape = "call-2";
    liste.appendChild(masquee);
    groupe.appendChild(liste);
    document.body.appendChild(groupe);
    const defiler = vi.fn();
    groupe.scrollIntoView = defiler;
    masquee.scrollIntoView = vi.fn();
    expect(allerALEtape("call-2")).toBe(true);
    expect(defiler).toHaveBeenCalledTimes(1);
    expect(masquee.scrollIntoView).not.toHaveBeenCalled();
  });
});

function page(extra: Record<string, unknown> = {}) {
  return etat<Record<string, unknown>>({
    currentChatId: "c1",
    messages: [],
    jobsChat: [],
    jobsTous: [],
    jobsPortee: "chat",
    jobsOuvert: false,
    jobsFileReveil: [],
    jobsReveilEnCours: [],
    jobsReveilDesactive: false,
    jobsLimites: { chat: 3, compte: 5 },
    jobsActifsChat: 0,
    jobsActifsTotal: 0,
    voiceCanDictate: false,
    composerPlusRef: null,
    planMode: false,
    todoList: [],
    todoPanelOpen: false,
    imageMode: false,
    ...extra,
  });
}

/** Suivi des échecs dans une portée d'effets, comme dans la page. */
function suivre(p: Record<string, unknown>) {
  const conv = etat<Record<string, unknown>>({ isUserScrolling: false });
  const portee = effectScope();
  portee.run(() => utiliserEchecsJobs(p as never, conv as never));
  return { conv, portee };
}

const toasts = () =>
  appelsDe("showToast") as [string, string, { actionLabel: string; onAction: () => void }][];

describe("échec d'une tâche de fond", () => {
  it("actif puis code 1 : toast « Aller au message » qui ramène à l'étape du fil", async () => {
    const j = job({ id: "j-00000001", label: "serveur" });
    const p = page({ messages: MESSAGES, jobsChat: [j] });
    const { conv, portee } = suivre(p);
    const ligne = document.createElement("div");
    ligne.dataset.etape = "call-1";
    ligne.scrollIntoView = vi.fn();
    document.body.appendChild(ligne);
    p["jobsChat"] = [{ ...j, state: "exited", exit_code: 1, ended_at: j.created_at + 42 }];
    await nextTick();
    const [message, genre, opts] = toasts()[0] ?? [];
    expect([message, genre, opts?.actionLabel]).toEqual([
      "« serveur » s'est arrêté : code 1",
      "error",
      "Aller au message",
    ]);
    opts?.onAction();
    expect(ligne.scrollIntoView).toHaveBeenCalled();
    expect(conv["isUserScrolling"]).toBe(true);
    expect(appelsDe("jobsBasculer")).toEqual([]);
    portee.stop();
  });

  it("étape absente du fil : « Aller au message » ouvre le volet des tâches de fond", async () => {
    const j = job({ id: "j-00000003", label: "build" });
    const p = page({ jobsChat: [j] });
    const { portee } = suivre(p);
    p["jobsChat"] = [{ ...j, state: "exited", exit_code: 2 }];
    await nextTick();
    toasts()[0]?.[2].onAction();
    expect(appelsDe("jobsBasculer")).toEqual([]);
    await new Promise((fin) => setTimeout(fin, 0));
    expect(appelsDe("jobsBasculer")).toEqual([[true]]);
    portee.stop();
  });

  it("« Aller au message » vise l'appel qui a lancé la tâche, pas un appel `status` plus récent", async () => {
    const j = job({ id: "j-00000004", label: "serveur" });
    const messages = [
      {
        role: "assistant",
        toolSteps: [
          {
            name: "shell_job",
            args: { action: "start" },
            status: "done",
            callId: "lance",
            result: '{"id":"j-00000004"}',
          },
          {
            name: "shell_job",
            args: { action: "status" },
            status: "done",
            callId: "etat",
            result: '{"id":"j-00000004"}',
          },
        ],
      },
    ];
    const p = page({ messages, jobsChat: [j] });
    const { portee } = suivre(p);
    const lancement = document.createElement("div");
    lancement.dataset.etape = "lance";
    lancement.scrollIntoView = vi.fn();
    const etat = document.createElement("div");
    etat.dataset.etape = "etat";
    etat.scrollIntoView = vi.fn();
    document.body.append(lancement, etat);
    p["jobsChat"] = [{ ...j, state: "exited", exit_code: 1 }];
    await nextTick();
    toasts()[0]?.[2].onAction();
    expect(lancement.scrollIntoView).toHaveBeenCalled();
    expect(etat.scrollIntoView).not.toHaveBeenCalled();
    portee.stop();
  });

  it("fin en code 0, job déjà fini au chargement, autre conversation : aucun toast", async () => {
    const k = job({ id: "j-00000002", label: "tests" });
    const p = page({ jobsChat: [k] });
    const a = suivre(p);
    p["jobsChat"] = [{ ...k, state: "exited", exit_code: 0 }];
    await nextTick();
    a.portee.stop();
    const fini = page({ jobsChat: [{ ...k, state: "exited", exit_code: 1 }] });
    const b = suivre(fini);
    await nextTick();
    b.portee.stop();
    const ailleurs = page({ jobsChat: [k] });
    const c = suivre(ailleurs);
    ailleurs["currentChatId"] = "c2";
    ailleurs["jobsChat"] = [{ ...k, state: "exited", exit_code: 1 }];
    await nextTick();
    c.portee.stop();
    expect(toasts()).toEqual([]);
  });
});

describe("rangée du composeur", () => {
  function monterRangee(p: object) {
    return monter(BarreComposeur, [
      [cle(CLE_PAGE), p],
      [
        cle(CLE_MODELES),
        etat({
          imageMode: false,
          showModelManager: false,
          selectedModel: "m",
          selectedModelLabel: "m",
          selectedConnector: null,
          availableModels: ["m"],
          pickerConnectors: [],
          modelesVision: [],
          samplingOverride: {},
          reasoningEffortValues: [],
          liveGen: null,
          ctxUsage: null,
        }),
      ],
      [cle(CLE_ENTETE), etat({ showSamplingPanel: false })],
      [cle(CLE_IMAGE), etat({ imageMode: false })],
      [
        cle(CLE_COMPOSEUR),
        etat({
          showComposerPlus: false,
          showSharedPrompts: false,
          inboxCount: 0,
          isStreaming: false,
          imageMode: false,
          inputMessage: "",
          attachedFiles: [],
          noEngineAllowed: false,
          sharedPromptsList: [],
        }),
      ],
    ]);
  }

  it("tâches de fond : puce « N ici » à côté du modèle, volet ouvert vers la gauche ; sans tâche, pas de puce", async () => {
    const j = job({ id: "j-00000001", label: "serveur" });
    const p = page({ jobsChat: [j], jobsActifsChat: 1, jobsActifsTotal: 1, jobsOuvert: true });
    const hote = monterRangee(p);
    const rangee = hote.querySelector("[data-barre-composeur]") as HTMLElement;
    const puce = rangee.querySelector("[data-jobs-flyout]") as HTMLElement;
    expect(puce.querySelector("[data-jobs-count]")?.textContent).toBe("1 ici");
    expect(puce.nextElementSibling?.matches("[data-menu-modele]")).toBe(true);
    expect(puce.querySelector("[data-jobs-popover]")?.classList.contains("right-0")).toBe(true);
    expect(document.querySelector("[data-barre-activite]")).toBeNull();
    demonter();
    const vide = monterRangee(page());
    expect(vide.querySelector("[data-jobs-flyout]")).toBeNull();
    await nextTick();
  });
});
