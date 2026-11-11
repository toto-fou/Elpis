// SPDX-License-Identifier: MIT
/** frontend/test/chat/jobs/jobs.test.ts — état des tâches de fond : relecture, chat_job, chat_wake (rattachement, relecture, sans toast, file et réveils prévus suivis en direct), arrêt, interrupteur, ping de saisie. */
import { effectScope, nextTick, ref } from "vue";
import type { EffectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerJobs } from "../../../src/features/chat/jobs/jobs";
import type { CtxJobs } from "../../../src/features/chat/jobs/jobs";
import { job, json, reponse, REVEIL } from "./outils-jobs";

let portee: EffectScope | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  portee?.stop();
  portee = null;
  vi.useRealTimers();
});

interface Banc {
  jobs: ReturnType<typeof creerJobs>;
  refs: {
    currentChatId: ReturnType<typeof ref<unknown>>;
    inputMessage: ReturnType<typeof ref<string>>;
    isStreaming: ReturnType<typeof ref<boolean>>;
    questionnaireActif: ReturnType<typeof ref<boolean>>;
  };
  urls: string[];
  toasts: { message: string; type?: string }[];
  confirmations: string[];
  ouverts: string[];
  charges: string[];
  rattaches: string[];
  reveils: unknown[];
}

function monter(
  routes: (url: string, init?: Record<string, unknown>) => Response | null,
  o: { chat?: string | null; confirmer?: boolean } = {},
): Banc {
  const urls: string[] = [];
  const toasts: Banc["toasts"] = [];
  const confirmations: string[] = [];
  const ouverts: string[] = [];
  const charges: string[] = [];
  const rattaches: string[] = [];
  const reveils: unknown[] = [];
  const refs = {
    currentChatId: ref<unknown>(o.chat === undefined ? "c1" : o.chat),
    inputMessage: ref(""),
    isStreaming: ref(false),
    questionnaireActif: ref(false),
  };
  const ctx: CtxJobs = {
    fetchAuth: (url, init) => {
      urls.push(((init?.method as string) || "GET") + " " + url);
      return Promise.resolve(routes(url, init));
    },
    showToast: (message, type) => toasts.push({ message, type }),
    openConfirm: (titre, texte) => {
      confirmations.push(titre + " | " + (texte ?? ""));
      return Promise.resolve(o.confirmer !== false);
    },
    openInEditor: (chemin) => ouverts.push(chemin),
    loadChat: (id) => {
      charges.push(id);
      return Promise.resolve();
    },
    reattachOrFollow: (id, reveil) => {
      rattaches.push(id);
      reveils.push(reveil);
      return Promise.resolve();
    },
  };
  portee = effectScope();
  const jobs = portee.run(() => creerJobs(refs, ctx))!;
  return { jobs, refs, urls, toasts, confirmations, ouverts, charges, rattaches, reveils };
}

const routesParDefaut = (url: string): Response | null => {
  if (url.startsWith("/api/jobs?chat_id=")) return json(reponse());
  if (url === "/api/jobs?scope=all")
    return json(
      reponse({
        jobs: [job(), job({ id: "j-00000002", chat_id: "c2", chat_title: "Serveur", label: "build" })],
        active_total: 2,
        wake_queue: [{ chat_id: "c3", chat_title: "Docs", since: 1, events: 2 }],
        wake_disabled: undefined,
      }),
    );
  if (url === "/api/jobs/stop") return json({ ok: true, stopped: ["j-3f2a1c9e"], not_found: [] });
  if (url.endsWith("/wake")) return json({ ok: true, wake_disabled: true });
  return json({ ok: true });
};

describe("état des tâches de fond", () => {
  it("relecture à l'ouverture d'une conversation : liste, limites, interrupteur", async () => {
    const b = monter(routesParDefaut);
    await b.jobs.jobsRecharger();
    expect(b.urls).toEqual(["GET /api/jobs?chat_id=c1"]);
    expect(b.jobs.jobsChat.value.map((j) => j.id)).toEqual(["j-3f2a1c9e"]);
    expect(b.jobs.jobsActifsChat.value).toBe(1);
    expect(b.jobs.jobsLimites.value).toEqual({ chat: 3, compte: 5 });
  });

  it("conversation sans job, jobs actifs ailleurs : le total du compte vient de la réponse (puce visible dès le chargement)", async () => {
    const b = monter((url) =>
      url.startsWith("/api/jobs?chat_id=") ? json(reponse({ jobs: [], active_total: 2 })) : null,
    );
    await b.jobs.jobsRecharger();
    expect(b.urls).toEqual(["GET /api/jobs?chat_id=c1"]);
    expect([b.jobs.jobsActifsChat.value, b.jobs.jobsActifsTotal.value]).toEqual([0, 2]);
  });

  it("changement de conversation : la liste précédente disparaît puis la nouvelle est relue", async () => {
    const b = monter(routesParDefaut);
    await b.jobs.jobsRecharger();
    b.refs.currentChatId.value = "c9";
    await nextTick();
    expect(b.jobs.jobsChat.value).toEqual([]);
    await vi.waitFor(() => expect(b.urls).toContain("GET /api/jobs?chat_id=c9"));
  });

  it("conversation non enregistrée : aucune requête", async () => {
    const b = monter(routesParDefaut, { chat: "__nouveau" });
    await b.jobs.jobsRecharger();
    expect(b.urls).toEqual([]);
  });

  it("chat_job de la conversation affichée : job inséré ou remplacé, compteurs mis à jour", () => {
    const b = monter(routesParDefaut);
    b.jobs.jobsSurChatJob({ chat_id: "c1", job: job(), active: 1, active_total: 2 });
    b.jobs.jobsSurChatJob({
      chat_id: "c1",
      job: job({ state: "exited", exit_code: 1 }),
      active: 0,
      active_total: 1,
    });
    expect(b.jobs.jobsChat.value).toHaveLength(1);
    expect(b.jobs.jobsChat.value[0]?.state).toBe("exited");
    expect(b.jobs.jobsActifsChat.value).toBe(0);
    expect(b.jobs.jobsActifsTotal.value).toBe(1);
  });

  it("chat_job d'une autre conversation : seul le total du compte et la vue « toutes » bougent", () => {
    const b = monter(routesParDefaut);
    b.jobs.jobsSurChatJob({
      chat_id: "c2",
      job: job({ id: "j-00000002", chat_id: "c2" }),
      active: 1,
      active_total: 1,
    });
    expect(b.jobs.jobsChat.value).toEqual([]);
    expect(b.jobs.jobsTous.value.map((j) => j.id)).toEqual(["j-00000002"]);
    expect(b.jobs.jobsActifsTotal.value).toBe(1);
  });

  it("vue « toutes les conversations » : scope=all, file de réveil et titres lus", async () => {
    const b = monter(routesParDefaut);
    b.jobs.jobsBasculer(true);
    b.jobs.jobsChoisirPortee("all");
    await vi.waitFor(() => expect(b.jobs.jobsTous.value).toHaveLength(2));
    expect(b.urls).toContain("GET /api/jobs?scope=all");
    expect(b.jobs.jobsFileReveil.value[0]?.chat_title).toBe("Docs");
    expect(b.jobs.jobsActifsTotal.value).toBe(2);
  });

  it("JB-12 : Arrêter envoie l'id, annonce le résultat et relit", async () => {
    const b = monter(routesParDefaut);
    await b.jobs.jobsArreter("j-3f2a1c9e");
    expect(b.urls[0]).toBe("POST /api/jobs/stop");
    expect(b.toasts[0]).toEqual({ message: "1 tâche arrêtée", type: "success" });
    await vi.waitFor(() => expect(b.urls).toContain("GET /api/jobs?chat_id=c1"));
  });

  it("JB-12 : tâche introuvable ou échec réseau annoncés en erreur", async () => {
    const a = monter((u) =>
      u === "/api/jobs/stop" ? json({ ok: true, stopped: [], not_found: ["j-x"] }) : null,
    );
    await a.jobs.jobsArreter("j-x");
    expect(a.toasts[0]?.type).toBe("error");
    const b = monter(() => null);
    await b.jobs.jobsArreter("j-x");
    expect(b.toasts[0]).toEqual({ message: "Arrêt impossible.", type: "error" });
  });

  it("JB-12 : Tout arrêter demande confirmation puis vise la conversation ; refus : rien", async () => {
    const b = monter(routesParDefaut);
    await b.jobs.jobsRecharger();
    await b.jobs.jobsToutArreter();
    expect(b.confirmations[0]).toBe("Tout arrêter ? | 1 tâche de fond sera arrêtée.");
    const post = b.urls.find((u) => u.startsWith("POST"));
    expect(post).toBe("POST /api/jobs/stop");
    const refus = monter(routesParDefaut, { confirmer: false });
    await refus.jobs.jobsRecharger();
    await refus.jobs.jobsToutArreter();
    expect(refus.urls.some((u) => u.startsWith("POST"))).toBe(false);
  });

  it("Tout arrêter dans la vue « toutes » vise le compte entier", async () => {
    const corps: string[] = [];
    const b = monter((url, init) => {
      if (init?.body) corps.push(String(init.body));
      return routesParDefaut(url);
    });
    b.jobs.jobsBasculer(true);
    await b.jobs.jobsAfficher("all");
    await b.jobs.jobsToutArreter();
    expect(corps).toContain('{"all":true}');
    expect(b.confirmations[0]).toContain("2 tâches de fond seront arrêtées (toutes les conversations)");
  });

  it("JB-17 : l'interrupteur envoie la valeur inverse et garde la valeur effective", async () => {
    const b = monter(routesParDefaut);
    await b.jobs.jobsBasculerReveil();
    expect(b.urls[0]).toBe("PUT /api/saved/chats/c1/wake");
    expect(b.jobs.jobsReveilDesactive.value).toBe(true);
    const ko = monter(() => null);
    await ko.jobs.jobsBasculerReveil();
    expect(ko.jobs.jobsReveilDesactive.value).toBe(false);
    expect(ko.toasts[0]?.type).toBe("error");
  });

  it("Journal ouvre le fichier du bac dans l'éditeur, chemin relatif complété", () => {
    const b = monter(routesParDefaut);
    b.jobs.jobsOuvrirJournal(job());
    b.jobs.jobsOuvrirJournal(job({ log: ".bg/job-j-3f2a1c9e.log" }));
    expect(b.ouverts).toEqual(["/work/.bg/job-j-3f2a1c9e.log", "/work/.bg/job-j-3f2a1c9e.log"]);
  });
});

describe("chat_wake", () => {
  const wake = (statut: "started" | "queued" | "done" | "skipped", extra = {}) => ({
    chat_id: "c1",
    chat_title: "Tests",
    status: statut,
    run_id: statut === "started" ? "r1" : null,
    wake: REVEIL,
    queued: 0,
    ...extra,
  });

  it("started sur la conversation affichée : rattachement au tour, la question y est déjà un réveil", () => {
    const b = monter(routesParDefaut);
    b.jobs.jobsSurChatWake(wake("started"));
    expect(b.rattaches).toEqual(["c1"]);
    expect(b.reveils).toEqual([REVEIL]);
  });

  it("started sur une autre conversation : rien (tour détaché, notification du core)", () => {
    const b = monter(routesParDefaut);
    b.jobs.jobsSurChatWake(wake("started", { chat_id: "c2" }));
    expect(b.rattaches).toEqual([]);
  });

  it("done : conversation relue sans rattachement, sinon à la fin du flux en cours", async () => {
    const b = monter(routesParDefaut);
    b.jobs.jobsSurChatWake(wake("done"));
    expect(b.charges).toEqual(["c1"]);
    const c = monter(routesParDefaut);
    c.refs.isStreaming.value = true;
    await nextTick();
    c.jobs.jobsSurChatWake(wake("done"));
    expect(c.charges).toEqual([]);
    c.refs.isStreaming.value = false;
    await nextTick();
    expect(c.charges).toEqual(["c1"]);
  });

  it("done d'une autre conversation : pas de relecture", () => {
    const b = monter(routesParDefaut);
    b.jobs.jobsSurChatWake(wake("done", { chat_id: "c2" }));
    expect(b.charges).toEqual([]);
  });

  it("file de réveil et réveils en cours suivis en direct, volet fermé, sans relire la liste", () => {
    const b = monter(routesParDefaut);
    const avant = b.urls.length;
    b.jobs.jobsSurChatWake(wake("queued", { chat_id: "c2", chat_title: "Docs" }));
    b.jobs.jobsSurChatWake(wake("queued"));
    expect(b.jobs.jobsFileReveil.value.map((q) => [q.chat_id, q.events])).toEqual([
      ["c2", 1],
      ["c1", 1],
    ]);
    b.jobs.jobsSurChatWake(wake("started"));
    expect(b.jobs.jobsFileReveil.value.map((q) => q.chat_id)).toEqual(["c2"]);
    expect(b.jobs.jobsReveilEnCours.value.map((r) => [r.chat_id, r.run_id])).toEqual([["c1", "r1"]]);
    b.jobs.jobsSurChatWake(wake("done"));
    b.jobs.jobsSurChatWake(wake("skipped", { chat_id: "c2", reason: "quota" }));
    expect(b.jobs.jobsFileReveil.value).toEqual([]);
    expect(b.jobs.jobsReveilEnCours.value).toEqual([]);
    expect(b.urls.length).toBe(avant);
  });

  it("réveils prévus : fin réveillante vue en direct, puis file et tour ; écartés à la fin du tour ou du réveil", async () => {
    const b = monter(routesParDefaut);
    const fin = (surcharges = {}) => ({
      chat_id: "c1",
      job: job({ state: "exited", exit_code: 1, ended_at: 1600, pending_events: 1, ...surcharges }),
      active: 0,
      active_total: 0,
    });
    b.jobs.jobsSurChatJob(fin({ state: "running", ended_at: null }));
    expect(b.jobs.jobsReveilsPrevus.value).toEqual([]);
    b.jobs.jobsSurChatJob(fin());
    expect(b.jobs.jobsReveilsPrevus.value).toEqual(["j-3f2a1c9e"]);
    b.jobs.jobsSurChatWake(wake("queued"));
    b.jobs.jobsSurChatWake(wake("started"));
    expect(b.jobs.jobsReveilsPrevus.value).toEqual(["j-3f2a1c9e"]);
    b.jobs.jobsSurChatWake(wake("done"));
    expect(b.jobs.jobsReveilsPrevus.value).toEqual([]);
    b.jobs.jobsSurChatJob(fin());
    b.jobs.jobsSurChatWake(wake("skipped", { reason: "max_depth" }));
    expect(b.jobs.jobsReveilsPrevus.value).toEqual([]);
    // Arrêt par l'utilisateur, tâche sans réveil, événements remis, autre conversation : aucun réveil prévu.
    b.jobs.jobsSurChatJob(fin({ state: "killed", exit_code: null, signal: "SIGTERM" }));
    b.jobs.jobsSurChatJob(fin({ wake: false }));
    b.jobs.jobsSurChatJob({ ...fin(), chat_id: "c2" });
    expect(b.jobs.jobsReveilsPrevus.value).toEqual([]);
    b.jobs.jobsSurChatJob(fin());
    b.jobs.jobsSurChatJob(fin({ pending_events: 0 }));
    expect(b.jobs.jobsReveilsPrevus.value).toEqual([]);
    b.jobs.jobsSurChatJob(fin());
    b.refs.currentChatId.value = "c2";
    await nextTick();
    expect(b.jobs.jobsReveilsPrevus.value).toEqual([]);
  });

  it("queued et skipped : aucun toast, les tâches de fond restent hors du flux des notifications", () => {
    const b = monter(routesParDefaut);
    b.jobs.jobsSurChatWake(wake("queued", { queued: 1 }));
    b.jobs.jobsSurChatWake(wake("queued", { queued: 3 }));
    for (const reason of ["wake_disabled", "max_depth", "quota", "chat_deleted"] as const)
      b.jobs.jobsSurChatWake(wake("skipped", { reason }));
    expect(b.toasts).toEqual([]);
  });
});

describe("JB-08 : ping de saisie", () => {
  const pings = (b: Banc): number => b.urls.filter((u) => u === "POST /api/chat/c1/composing").length;

  it("un ping dès que le brouillon n'est plus vide, puis un toutes les 10 s au plus", async () => {
    const b = monter(routesParDefaut);
    b.refs.inputMessage.value = "bon";
    await nextTick();
    expect(pings(b)).toBe(1);
    b.refs.inputMessage.value = "bonjour";
    await nextTick();
    expect(pings(b)).toBe(1);
    vi.advanceTimersByTime(9_999);
    expect(pings(b)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(pings(b)).toBe(2);
    vi.advanceTimersByTime(10_000);
    expect(pings(b)).toBe(3);
  });

  it("brouillon vidé ou envoyé : plus aucun ping", async () => {
    const b = monter(routesParDefaut);
    b.refs.inputMessage.value = "bon";
    await nextTick();
    b.refs.inputMessage.value = "";
    await nextTick();
    vi.advanceTimersByTime(60_000);
    expect(pings(b)).toBe(1);
  });

  it("questionnaire ouvert ou avec des réponses : saisie en cours, même zone vide", async () => {
    const b = monter(routesParDefaut);
    b.refs.questionnaireActif.value = true;
    await nextTick();
    expect(pings(b)).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(pings(b)).toBe(2);
    b.refs.questionnaireActif.value = false;
    await nextTick();
    vi.advanceTimersByTime(60_000);
    expect(pings(b)).toBe(2);
  });

  it("brouillon d'espaces ou conversation non enregistrée : pas de ping", async () => {
    const a = monter(routesParDefaut);
    a.refs.inputMessage.value = "   ";
    await nextTick();
    expect(pings(a)).toBe(0);
    const b = monter(routesParDefaut, { chat: null });
    b.refs.inputMessage.value = "texte";
    await nextTick();
    vi.advanceTimersByTime(30_000);
    expect(b.urls.some((u) => u.includes("composing"))).toBe(false);
  });
});
