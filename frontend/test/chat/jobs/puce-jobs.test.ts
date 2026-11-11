// SPDX-License-Identifier: MIT
/** frontend/test/chat/jobs/puce-jobs.test.ts — puce « Tâches de fond » : compteur, volet des deux vues, Journal, Arrêter, Tout arrêter, interrupteur, file de réveil. */
import { createApp, h, nextTick } from "vue";
import type { App, VNode } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import PuceJobs from "../../../src/components/chat/outils/PuceJobs.vue";
import { job } from "./outils-jobs";

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

type Props = InstanceType<typeof PuceJobs>["$props"];
const BASE: Props = {
  jobs: [job()],
  portee: "chat",
  ouvert: true,
  actifsChat: 1,
  actifsTotal: 2,
  fileReveil: [],
  reveilEnCours: [],
  reveilDesactive: false,
  chatId: "c1",
  limite: 3,
};

function puce(props: Partial<Props> = {}) {
  const emis: [string, unknown?][] = [];
  const hote = monter(() =>
    h(PuceJobs, {
      ...BASE,
      ...props,
      onBasculer: (v: boolean) => emis.push(["basculer", v]),
      onPortee: (v: string) => emis.push(["portee", v]),
      onArreter: (id: string) => emis.push(["arreter", id]),
      onToutArreter: () => emis.push(["toutArreter"]),
      onJournal: (j: { id: string }) => emis.push(["journal", j.id]),
      onInterrupteur: () => emis.push(["interrupteur"]),
      onConversation: (id: string) => emis.push(["conversation", id]),
    }),
  );
  return { hote, emis };
}

const q = (hote: HTMLElement, sel: string): HTMLElement | null => hote.querySelector<HTMLElement>(sel);

describe("PuceJobs", () => {
  it("volet borné à 20 tâches : toutes les actives, puis les terminées les plus récentes, le reste compté", () => {
    const actives = [job({ id: "j-actif-1", created_at: 10 }), job({ id: "j-actif-2", created_at: 5 })];
    const finies = Array.from({ length: 25 }, (_, i) =>
      job({ id: `j-fini-${i}`, state: "exited", exit_code: 0, created_at: 100 - i }),
    );
    const { hote } = puce({ jobs: [...finies.slice(0, 3), actives[0]!, ...finies.slice(3), actives[1]!] });
    const ids = [...hote.querySelectorAll("[data-jobs-row]")].map((e) => e.textContent);
    expect(ids).toHaveLength(20);
    expect(hote.querySelectorAll("[data-jobs-stop]")).toHaveLength(2);
    expect(q(hote, "[data-jobs-masquees]")?.textContent?.trim()).toBe(
      "7 tâches terminées plus anciennes masquées",
    );
    app?.unmount();
    const { hote: peu } = puce({ jobs: finies.slice(0, 4) });
    expect(q(peu, "[data-jobs-masquees]")).toBeNull();
  });

  it("le compteur dit « ici » pour la conversation ouverte, le compte en infobulle ; le clic bascule le volet", async () => {
    const a = puce({ ouvert: false });
    expect(q(a.hote, "[data-jobs-count]")?.textContent).toBe("1 ici");
    expect(q(a.hote, "[data-jobs-chip]")?.title).toBe("Tâches de fond actives : 1 ici, 2 sur le compte");
    expect(q(a.hote, "[data-jobs-popover]")).toBeNull();
    q(a.hote, "[data-jobs-chip]")?.click();
    expect(a.emis).toEqual([["basculer", true]]);
    app?.unmount();
    const b = puce({ ouvert: false, actifsChat: 0, actifsTotal: 4 });
    expect(q(b.hote, "[data-jobs-count]")?.textContent).toBe("0 ici");
    app?.unmount();
    const c = puce({ ouvert: false, actifsChat: 0, actifsTotal: 4, chatId: null });
    expect(q(c.hote, "[data-jobs-count]")?.textContent).toBe("4");
    expect(q(c.hote, "[data-jobs-chip]")?.title).toBe("Tâches de fond actives : 4 sur le compte");
  });

  it("une tâche sortie en code ≠ 0 s'affiche en échec (rouge), code 0 reste « terminé »", () => {
    const { hote } = puce({
      jobs: [
        job({ id: "j-00000010", state: "exited", exit_code: 1 }),
        job({ id: "j-00000011", state: "exited", exit_code: 0 }),
        job({ id: "j-00000012", state: "exited", exit_code: null, signal: "SIGSEGV" }),
      ],
    });
    const issues = [...hote.querySelectorAll<HTMLElement>("[data-jobs-issue]")];
    expect(issues.map((e) => [e.dataset.jobsIssue, e.textContent?.trim()])).toEqual([
      ["echec", "échec, code 1"],
      ["reussi", "terminé"],
      ["echec", "échec (SIGSEGV)"],
    ]);
    expect(issues[0]?.className).toContain("text-red-600");
    expect(hote.querySelectorAll("[data-jobs-row] .ph-x-circle")).toHaveLength(2);
  });

  it("vue « Cette conversation » : libellé, état, dernière ligne, déclencheurs en français", () => {
    const { hote } = puce();
    const ligne = q(hote, "[data-jobs-row]");
    expect(ligne?.textContent).toContain("pytest");
    expect(ligne?.textContent).toContain("en cours");
    expect(q(hote, "[data-jobs-last]")?.textContent?.trim()).toBe("41 passed");
    const armes = [...hote.querySelectorAll("[data-jobs-armed]")].map((e) => e.textContent);
    expect(armes).toEqual(["fin du programme", "texte « FAILED »"]);
    expect(q(hote, "[data-jobs-chat-link]")).toBeNull();
  });

  it("sous-agent en fond : marqué « sous-agent », progression et jetons, ni journal ni déclencheurs, Arrêter", () => {
    const agent = job({
      id: "j-00000009",
      label: "explore — cartographier",
      command: "",
      log: "",
      wake_on: ["exit"],
      last_line: "étape 4 · read_file",
      kind: "agent",
      agent: {
        child_id: "t1-aa",
        agent: "explore",
        state: "running",
        step: 4,
        max_steps: 60,
        input_tokens: 247_389,
        output_tokens: 300,
        context_tokens: 12_300,
      },
    });
    const { hote, emis } = puce({ jobs: [agent] });
    expect(q(hote, "[data-jobs-agent]")?.textContent).toBe("sous-agent");
    expect(q(hote, "[data-jobs-progression]")?.textContent?.trim()).toBe("étape 4/60 · 12,3 k jetons");
    expect(q(hote, "[data-jobs-log]")).toBeNull();
    expect(hote.querySelectorAll("[data-jobs-armed]")).toHaveLength(0);
    q(hote, "[data-jobs-stop]")?.click();
    expect(emis).toContainEqual(["arreter", "j-00000009"]);
  });

  it("l'en-tête compte les commandes actives contre leur limite, sans les sous-agents en fond", () => {
    const agent = (id: string) =>
      job({
        id,
        kind: "agent",
        agent: { child_id: id, agent: "explore", state: "running", step: 1, max_steps: 60 },
      });
    const { hote } = puce({ jobs: [job(), agent("j-a1"), agent("j-a2")], limite: 2 });
    expect(q(hote, "[data-jobs-limite]")?.textContent).toBe("1 / 2");
  });

  it("vue « Toutes les conversations » : titre de la conversation avec lien vers elle", async () => {
    const { hote, emis } = puce({
      portee: "all",
      jobs: [job(), job({ id: "j-00000002", chat_id: "c2", chat_title: "Serveur" })],
    });
    const liens = [...hote.querySelectorAll<HTMLElement>("[data-jobs-chat-link]")];
    expect(liens.map((l) => l.textContent?.trim())).toEqual(["Tests de l'API", "Serveur"]);
    liens[1]?.click();
    expect(emis).toEqual([["conversation", "c2"]]);
  });

  it("la bascule de vue émet la portée choisie", () => {
    const { hote, emis } = puce();
    q(hote, "[data-jobs-scope='all']")?.click();
    expect(emis).toEqual([["portee", "all"]]);
    expect(q(hote, "[data-jobs-scope='chat']")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("JB-12 : Arrêter n'existe que pour un job actif ; Journal pour tous", () => {
    const { hote, emis } = puce({
      jobs: [job(), job({ id: "j-00000002", state: "exited", exit_code: 0 })],
    });
    const boutons = hote.querySelectorAll("[data-jobs-stop]");
    expect(boutons).toHaveLength(1);
    (boutons[0] as HTMLElement).click();
    const journaux = hote.querySelectorAll<HTMLElement>("[data-jobs-log]");
    expect(journaux).toHaveLength(2);
    journaux[1]?.click();
    expect(emis).toEqual([
      ["arreter", "j-3f2a1c9e"],
      ["journal", "j-00000002"],
    ]);
  });

  it("JB-12 : Tout arrêter n'apparaît que s'il y a un job actif", () => {
    const a = puce();
    q(a.hote, "[data-jobs-stop-all]")?.click();
    expect(a.emis).toEqual([["toutArreter"]]);
    app?.unmount();
    const b = puce({ jobs: [job({ state: "exited" })] });
    expect(q(b.hote, "[data-jobs-stop-all]")).toBeNull();
  });

  it("JB-17 : l'interrupteur reflète l'état et émet au changement ; absent sans conversation", () => {
    const a = puce({ reveilDesactive: true });
    const case_ = q(a.hote, "[data-jobs-nowake]") as HTMLInputElement;
    expect(case_.checked).toBe(true);
    case_.dispatchEvent(new Event("change"));
    expect(a.emis).toEqual([["interrupteur"]]);
    app?.unmount();
    const b = puce({ chatId: null });
    expect(q(b.hote, "[data-jobs-nowake]")).toBeNull();
  });

  it("file de réveil du compte : « N réveils en attente », conversations dans l'ordre, tour en cours", () => {
    const { hote } = puce({
      fileReveil: [
        { chat_id: "c3", chat_title: "Docs", since: 1, events: 2 },
        { chat_id: "c4", chat_title: "Build", since: 2, events: 1 },
      ],
      reveilEnCours: [{ chat_id: "c5", chat_title: "Migration", run_id: "r1", started_at: 3 }],
    });
    expect(q(hote, "[data-jobs-queue]")?.textContent?.trim()).toBe("2 réveils en attente");
    expect([...hote.querySelectorAll("[data-jobs-queued]")].map((e) => e.textContent?.trim())).toEqual([
      "Docs2",
      "Build1",
    ]);
    expect(q(hote, "[data-jobs-wakes]")?.textContent).toContain("Réveil en cours : Migration");
  });

  it("aucune tâche : message vide, pas d'erreur", async () => {
    const { hote } = puce({ jobs: [], actifsChat: 0 });
    await nextTick();
    expect(q(hote, "[data-jobs-vide]")?.textContent).toContain("Aucune tâche de fond");
  });

  it("la durée d'un job terminé est celle de sa vie, pas du temps écoulé", () => {
    const { hote } = puce({
      jobs: [job({ state: "exited", started_at: 1000, ended_at: 1603, exit_code: 1 })],
    });
    expect(q(hote, "[data-jobs-row]")?.textContent).toContain("10 min 03 s");
  });
});
