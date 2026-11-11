// SPDX-License-Identifier: MIT
/** apps/core/test/ordonnanceur/file.test.ts — `LLMQueue` : neuf scénarios du v9 §7 bis, comportements des tests pytest. */
import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";

import { LLMCircuitOpen } from "../../src/llm/ordonnanceur/disjoncteur";
import { GRACE_S, LLMQueue, LLMQueueAborted, LOW_WAIT_CAP_S } from "../../src/llm/ordonnanceur/file";
import type { Moteur, Politique, Priorite, Slot } from "../../src/llm/ordonnanceur/file";
import { EchecTransport, fileDeTest, suivre, vider } from "./aides";
import type { HorlogeLogique } from "./aides";

const A: { moteur: Moteur } = { moteur: { id: "A", enFile: true } };
const B: { moteur: Moteur } = { moteur: { id: "B", enFile: true } };
const prendre = (q: LLMQueue, model: string, extra: Partial<Parameters<LLMQueue["acquire"]>[0]> = {}) =>
  q.acquire({ server: "A", model, ...extra });
const optimise = (politique: Politique = { maxModels: 1, maxConcurrency: 1 }) =>
  fileDeTest({ A: politique }, { modeConfigure: () => "optimized" });
type Tour = [nom: string, arrivee: number, model: string, priority: Priorite, duree: number];
/** Tours qui tiennent le serveur A le temps de leur durée ; rend les admissions « instant nom ». */
async function chronologie({ h, q }: { h: HorlogeLogique; q: LLMQueue }, tours: Tour[]): Promise<string[]> {
  const ordre: string[] = [];
  const tenir = async ([nom, , model, priority, duree]: Tour): Promise<void> => {
    const slot = await prendre(q, model, { priority });
    ordre.push(`${h.t} ${nom}`);
    await h.attendre(duree);
    slot.release();
  };
  const fins: Promise<void>[] = [];
  for (const tour of tours) h.planifier(tour[1], () => fins.push(tenir(tour)));
  await h.avancer();
  await Promise.all(fins);
  return ordre;
}

describe("1. saturation des créneaux", () => {
  it("au-delà du plafond, la demande attend chez nous et passe au premier créneau rendu", async () => {
    const { q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 2 } });
    const [a, b] = [await prendre(q, "m"), await prendre(q, "m")];
    const c = suivre(prendre(q, "m"));
    await vider();
    expect(c.etat).toBe("attente");
    a.release();
    await vider();
    expect(c.etat).toBe("tenue");
    b.release();
    c.valeur?.release();
    expect(q.status("A", "m")).toEqual({ kind: "ready" });
  });

  it("un process seul prend tous les créneaux libres ; le cinquième attend", async () => {
    const { q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 4 } });
    const tenus = await Promise.all([1, 2, 3, 4].map(() => prendre(q, "m")));
    const cinquieme = suivre(prendre(q, "m"));
    await vider();
    expect(cinquieme.etat).toBe("attente");
    tenus[0]?.release();
    await vider();
    expect(cinquieme.etat).toBe("tenue");
  });

  it("le plafond lu sur /props (total_slots) prime sur la politique", async () => {
    const { q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 1 } }, { totalSlots: () => 3 });
    await Promise.all([1, 2, 3].map(() => prendre(q, "m")));
    const quatrieme = suivre(prendre(q, "m"));
    await vider();
    expect(quatrieme.etat).toBe("attente");
  });
});

describe("2. high devant low, sans préemption", () => {
  it("à créneau rendu, un high arrivé après un low passe le premier", async () => {
    const { q } = fileDeTest();
    const tenu = await prendre(q, "m");
    const ordre: string[] = [];
    const low = prendre(q, "m", { priority: "low" }).then((s) => (ordre.push("low"), s));
    const high = prendre(q, "m", { priority: "high" }).then((s) => (ordre.push("high"), s));
    tenu.release();
    await vider();
    expect(ordre).toEqual(["high"]);
    (await high).release();
    await vider();
    expect(ordre).toEqual(["high", "low"]);
    (await low).release();
  });

  it("un low en cours n'est jamais interrompu : le high attend sa fin", async () => {
    const { q } = fileDeTest();
    const low = await prendre(q, "m", { priority: "low" });
    const high = suivre(prendre(q, "m"));
    await vider();
    expect(high.etat).toBe("attente");
    low.release();
    await vider();
    expect(high.etat).toBe("tenue");
  });

  it("un high qui attend un autre modèle retient les low au portail, sauf ceux du modèle tenu", async () => {
    const { q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 2 } });
    const h0 = await prendre(q, "m1", { priority: "low" });
    const h2 = suivre(prendre(q, "m2"));
    const autre = suivre(prendre(q, "m3", { priority: "low" }));
    const memeModele = suivre(prendre(q, "m1", { priority: "low" }));
    await vider();
    expect([h2.etat, autre.etat, memeModele.etat]).toEqual(["attente", "attente", "tenue"]);
    h0.release();
    memeModele.valeur?.release();
    await vider();
    expect([h2.etat, autre.etat]).toEqual(["tenue", "attente"]);
  });

  it("un low retenu par des high inscrits ne rejoint pas son modèle tant qu'un high attend, même inscrit avant eux", async () => {
    const apres: Tour[] = [
      ["X", 0, "m2", "high", 10],
      ["H1", 1, "m1", "high", 1],
      ["H2", 2, "m3", "high", 1],
    ];
    expect(await chronologie(fileDeTest(), [...apres, ["L", 3, "m1", "low", 1]])).toEqual([
      "0 X",
      "10 H1",
      "11 H2",
      "20 L",
    ]);
    const avant: Tour[] = [
      ["X", 0, "m2", "low", 10],
      ["L", 1, "m1", "low", 1],
      ["H1", 2, "m1", "high", 1],
    ];
    expect(await chronologie(fileDeTest(), [...avant, ["H2", 3, "m3", "high", 1]])).toEqual([
      "0 X",
      "10 H1",
      "11 H2",
      "20 L",
    ]);
  });

  it("le plafond d'un low inscrit part du blocage vu à une libération, pas de l'arrivée des high", async () => {
    const tours: Tour[] = [
      ["X", 0, "m1", "low", 20],
      ["L", 1, "m2", "low", 1],
      ["H", 5, "m3", "high", 25],
    ];
    expect(await chronologie(fileDeTest(), tours)).toEqual(["0 X", "20 H", "50 L"]);
    const second: Tour = ["H2", 8, "m3", "high", 1];
    expect(await chronologie(fileDeTest(), [...tours, second])).toEqual(["0 X", "20 H", "45 H2", "50 L"]);
  });
});

describe("3. famine évitée", () => {
  it("créneaux : un low devant un flux continu de high passe dès qu'il attend depuis plus de 30 s", async () => {
    const { h, q } = fileDeTest();
    const admis: Record<string, number> = {};
    const lancees: Promise<void>[] = [];
    const tour = (nom: string, priorite: "high" | "low") =>
      q.withLLM(
        "m",
        priorite,
        undefined,
        async () => {
          admis[nom] = h.t;
          await h.attendre(2);
        },
        A,
      );
    for (let k = 0; k < 70; k += 1) h.planifier(k, () => lancees.push(tour(`H${k}`, "high")));
    h.planifier(0.5, () => lancees.push(tour("L", "low")));
    await h.avancer();
    await Promise.all(lancees);
    expect(admis["L"]).toBe(32);
    expect(Object.entries(admis).filter(([n, t]) => n !== "L" && t < 32)).toHaveLength(16);
    expect(LOW_WAIT_CAP_S).toBe(30);
  });

  it("portail : attendre la fin des flux d'un autre modèle ne compte pas, le plafond part du premier blocage", async () => {
    const { h, q } = fileDeTest();
    const long = await prendre(q, "m1");
    const routine = suivre(prendre(q, "m2", { priority: "low" }));
    await h.avancer(100);
    long.release();
    await vider();
    expect(routine.etat).toBe("attente");
    await h.avancer(101);
    const chat = await prendre(q, "m1");
    expect(routine.etat).toBe("attente");
    await h.avancer(130);
    chat.release();
    await vider();
    expect(routine.etat).toBe("tenue");
  });

  it("portail : au plafond, le low passe sans attendre la fin d'une grâce réarmée juste avant", async () => {
    const { h, q } = fileDeTest();
    const h1 = await prendre(q, "m1");
    const routine = suivre(prendre(q, "m2", { priority: "low" }));
    await h.avancer(4);
    h1.release();
    await h.avancer(5);
    const h2 = await prendre(q, "m1");
    await h.avancer(33.5);
    h2.release();
    await h.avancer(33.9);
    expect(routine.etat).toBe("attente");
    await h.avancer(34);
    expect(routine.etat).toBe("tenue");
  });

  it("portail : au plafond, le low repasse derrière les high déjà en attente, devant ceux arrivés après", async () => {
    const { h, q } = fileDeTest();
    const ordre: string[] = [];
    const tenir = async (nom: string, model: string, priority: "high" | "low") => {
      const slot = await prendre(q, model, { priority });
      ordre.push(`${h.t} ${nom}`);
      await h.attendre(5);
      slot.release();
    };
    const long = await prendre(q, "m1", { priority: "low" });
    const tours = [tenir("H1", "m2", "high")];
    h.t = 1;
    tours.push(tenir("L", "m3", "low"));
    h.t = 2;
    tours.push(tenir("H2", "m4", "high"));
    await h.avancer(35);
    tours.push(tenir("H3", "m5", "high"));
    await h.avancer(40);
    long.release();
    await h.avancer();
    await Promise.all(tours);
    expect(ordre).toEqual(["40 H1", "45 H2", "50 L", "55 H3"]);
  });

  it("portail : plafond exact entre deux réveils (premier blocage à 4,6 s, passage à 34,6 s)", async () => {
    const { h, q } = fileDeTest();
    const admissions: Record<string, number> = {};
    const tours: Promise<void>[] = [];
    const demande = (nom: string, arrivee: number, model: string, priority: "high" | "low", duree: number) =>
      h.planifier(arrivee, () => {
        const tour = async (): Promise<void> => {
          const slot = await prendre(q, model, { priority });
          admissions[nom] = h.t;
          await h.attendre(duree);
          slot.release();
        };
        tours.push(tour());
      });
    for (let k = 0; k < 7; k += 1) demande(`H${k}`, 5 * k, "m1", "high", 4);
    demande("H7", 40, "m1", "high", 4);
    demande("L1", 4.6, "m2", "low", 5);
    await h.avancer();
    await Promise.all(tours);
    expect(admissions["L1"]).toBeCloseTo(34.6, 9);
    expect(admissions["H7"]).toBe(40);
  });

  it("portail : au plafond, le low attend toujours la fin des flux de l'autre modèle", async () => {
    const { h, q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 2 } });
    (await prendre(q, "m1")).release();
    const routine = suivre(prendre(q, "m2", { priority: "low" }));
    const chat = await prendre(q, "m1");
    await h.avancer(40);
    expect(routine.etat).toBe("attente");
    chat.release();
    await vider();
    expect(routine.etat).toBe("tenue");
  });
});

describe("fenêtre de grâce (8 s après le tour d'un high)", () => {
  it("un low ne change pas de modèle pendant la grâce ; il passe à son expiration", async () => {
    const { h, q } = fileDeTest();
    (await prendre(q, "m1")).release();
    const routine = suivre(prendre(q, "m2", { priority: "low" }));
    await h.avancer(GRACE_S - 0.1);
    expect(routine.etat).toBe("attente");
    await h.avancer(GRACE_S);
    expect(routine.etat).toBe("tenue");
  });

  it("le modèle en grâce reste ouvert aux low ; un high n'attend jamais la grâce", async () => {
    const { q } = fileDeTest();
    (await prendre(q, "m1")).release();
    (await prendre(q, "m1", { priority: "low" })).release();
    const high = suivre(prendre(q, "m2"));
    await vider();
    expect(high.etat).toBe("tenue");
  });

  it("seul le dernier à rendre le modèle compte : un high suivi d'un low n'ouvre pas de grâce", async () => {
    const { q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 2 } });
    const high = await prendre(q, "m1");
    const low = await prendre(q, "m1", { priority: "low" });
    high.release();
    low.release();
    const routine = suivre(prendre(q, "m2", { priority: "low" }));
    await vider();
    expect(routine.etat).toBe("tenue");
  });

  it("toute prise de modèle efface la grâce (deux modèles à la fois)", async () => {
    const { q } = fileDeTest({ A: { maxModels: 2, maxConcurrency: 1 } });
    (await prendre(q, "m1")).release();
    const routine = suivre(prendre(q, "m3", { priority: "low" }));
    await vider();
    expect(routine.etat).toBe("attente");
    await prendre(q, "m2");
    await vider();
    expect(routine.etat).toBe("tenue");
  });

  it("une grâce effacée en cours de passage profite aussitôt aux low retenus avant", async () => {
    const { h, q } = fileDeTest({ A: { maxModels: 2, maxConcurrency: 1 } });
    (await prendre(q, "m1")).release();
    h.t = 2;
    const l1 = suivre(prendre(q, "m2", { priority: "low" }));
    await vider();
    h.t = 3;
    await prendre(q, "m1", { priority: "low" });
    await vider();
    expect(l1.etat).toBe("tenue");
  });
});

describe("4. changement de modèle", () => {
  it("le modèle tenu accueille ses demandes, qui attendent leur créneau ; le changement attend tous les flux", async () => {
    const { q } = fileDeTest();
    const ordre: string[] = [];
    const h1 = await prendre(q, "m1");
    const h2 = prendre(q, "m2").then((s) => (ordre.push("H2 m2"), s));
    const h3 = prendre(q, "m1").then((s) => (ordre.push("H3 m1"), s));
    await vider();
    h1.release();
    await vider();
    expect(ordre).toEqual(["H3 m1"]);
    (await h3).release();
    await vider();
    expect(ordre).toEqual(["H3 m1", "H2 m2"]);
    (await h2).release();
  });

  it("deux créneaux : la demande du modèle tenu passe en parallèle, le changement attend", async () => {
    const { q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 2 } });
    const h1 = await prendre(q, "m1");
    const w = suivre(prendre(q, "m2"));
    const h3 = await prendre(q, "m1");
    await vider();
    expect(w.etat).toBe("attente");
    expect(q.status("A", "m2")).toMatchObject({ kind: "loading", loaded: "m1", position: 3, active: 2 });
    h1.release();
    await vider();
    expect(w.etat).toBe("attente");
    h3.release();
    await vider();
    expect(w.etat).toBe("tenue");
    const h4 = suivre(prendre(q, "m1"));
    await vider();
    expect(h4.etat).toBe("attente");
  });

  it("modèle absent = modèle par défaut du serveur : pas de changement", async () => {
    const { q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 2 } }, { modeleParDefaut: () => "qwen" });
    const sansNom = await q.acquire({ server: "A", model: null });
    expect(sansNom.model).toBe("qwen");
    const nomme = suivre(prendre(q, "qwen"));
    await vider();
    expect(nomme.etat).toBe("tenue");
    const brut = new LLMQueue({ politique: () => ({ maxModels: 1, maxConcurrency: 1 }) });
    expect(brut.modeleEffectif("A", "")).toBe("default");
  });
});

describe("5. mode optimized : créneau rendu pendant les outils", () => {
  it("l'admission tient le modèle ; chaque appel LLM prend puis rend le créneau", async () => {
    const { q } = optimise();
    const t1 = await prendre(q, "m", { outils: true });
    await t1.reacquire();
    const t2 = await prendre(q, "m", { outils: true });
    const appel2 = suivre(t2.reacquire());
    await vider();
    expect(appel2.etat).toBe("attente");
    t1.yieldForTools();
    await vider();
    expect(appel2.etat).toBe("tenue");
    const appel1 = suivre(t1.reacquire());
    await vider();
    expect(appel1.etat).toBe("attente");
    t2.release();
    await vider();
    expect(appel1.etat).toBe("tenue");
    t1.release();
  });

  it("appelLLM prend le créneau le temps de l'appel ; les appels d'un même slot passent un par un", async () => {
    const { h, q } = optimise({ maxModels: 1, maxConcurrency: 2 });
    const tour = await prendre(q, "m", { outils: true });
    const debuts: number[] = [];
    const appel = () =>
      tour.appelLLM(async () => {
        debuts.push(h.t);
        expect(q.stats("A").active_models[0]?.shared_busy).toBe(1);
        await h.attendre(3);
      });
    const appels = [appel(), appel()];
    await h.avancer();
    await Promise.all(appels);
    expect(debuts).toEqual([0, 3]);
    expect(q.stats("A").active_models).toEqual([]);
  });

  it("attenteCreneau : en optimized, le tour admis attend son premier créneau, rendu au premier appel ; en classic, rien à attendre", async () => {
    const { q } = optimise();
    const t1 = await prendre(q, "m", { outils: true });
    await t1.reacquire();
    expect(t1.attenteCreneau()).toBeNull();
    const t2 = await prendre(q, "m", { outils: true });
    const attente = suivre(t2.attenteCreneau() ?? Promise.reject(new Error("créneau déjà tenu")));
    const appel = suivre(t2.appelLLM(async () => undefined));
    await vider();
    expect([attente.etat, appel.etat]).toEqual(["attente", "attente"]);
    t1.yieldForTools();
    await vider();
    expect([attente.etat, appel.etat]).toEqual(["tenue", "tenue"]);
    expect(t2.attenteCreneau()).toBeNull();
    t1.release();
    t2.release();
    const classique = await prendre(fileDeTest({ A: { maxModels: 1, maxConcurrency: 1 } }).q, "m");
    expect(classique.attenteCreneau()).toBeNull();
    classique.release();
  });

  it("appelLLM garde un créneau repris à la main : il ne rend que celui qu'il a pris", async () => {
    const { q } = optimise();
    const tour = await prendre(q, "m", { outils: true });
    await tour.reacquire();
    await tour.appelLLM(async () => undefined);
    expect(q.stats("A").active_models[0]?.shared_busy).toBe(1);
    tour.yieldForTools();
    await tour.appelLLM(async () => undefined);
    expect(q.stats("A").active_models).toEqual([]);
  });

  it("pendant l'outil, le modèle reste tenu : un changement attend la fin du tour", async () => {
    const { q } = optimise();
    const tour = await prendre(q, "m1", { outils: true });
    await tour.reacquire();
    tour.yieldForTools();
    const autre = suivre(prendre(q, "m2"));
    await vider();
    expect(autre.etat).toBe("attente");
    await tour.reacquire();
    tour.release();
    await vider();
    expect(autre.etat).toBe("tenue");
  });

  it("le high qui prend le modèle fait son premier appel avant le low retenu qui le rejoint au même instant", async () => {
    const { h, q } = optimise();
    const appels: string[] = [];
    const tour = (nom: string, arrivee: number, model: string, priority: Priorite, duree: number) =>
      h.planifier(arrivee, () => {
        const appel = (s: Slot) => s.appelLLM(async () => (appels.push(`${h.t} ${nom}`), h.attendre(duree)));
        void q.withLLM(model, priority, undefined, appel, { ...A, outils: true });
      });
    tour("H0", 0, "m2", "high", 2);
    tour("L", 3, "m1", "low", 1);
    tour("H1", 5.5, "m1", "high", 2);
    await h.avancer();
    expect(appels).toEqual(["0 H0", "5.5 H1", "7.5 L"]);
  });

  it("une reprise low n'a pas de portail : elle passe devant un changement de modèle en attente", async () => {
    const { q } = optimise();
    const tour = await prendre(q, "m1", { outils: true, priority: "low" });
    await tour.reacquire();
    tour.yieldForTools();
    const changement = suivre(prendre(q, "m2"));
    await vider();
    const reprise = suivre(tour.reacquire());
    await vider();
    expect([reprise.etat, changement.etat]).toEqual(["tenue", "attente"]);
  });

  it("une reprise low cède aux high qui attendent un créneau, sauf après 30 s d'attente", async () => {
    const { h, q } = optimise();
    const tenant = await prendre(q, "m", { outils: true });
    await tenant.reacquire();
    const routine = await prendre(q, "m", { outils: true, priority: "low" });
    const reprise = suivre(routine.reacquire());
    const chat = await prendre(q, "m", { outils: true });
    h.t = 1;
    const appelChat = suivre(chat.reacquire());
    tenant.yieldForTools();
    await vider();
    expect([appelChat.etat, reprise.etat]).toEqual(["tenue", "attente"]);
    await chat.reacquire();
    h.t = 31;
    const autreAppel = suivre(tenant.reacquire());
    chat.yieldForTools();
    await vider();
    expect([reprise.etat, autreAppel.etat]).toEqual(["tenue", "attente"]);
  });

  it("un low rejoint aussitôt le modèle tenu, même si un high attend un autre modèle", async () => {
    const { q } = optimise();
    await prendre(q, "m1", { priority: "low", outils: true });
    const chat = suivre(prendre(q, "m2"));
    const enfant = suivre(prendre(q, "m1", { priority: "low", outils: true }));
    await vider();
    expect([chat.etat, enfant.etat]).toEqual(["attente", "tenue"]);
  });

  it("en classic, yieldForTools et reacquire sont neutres : le créneau est tenu tout le tour", async () => {
    const { q } = fileDeTest();
    const tour = await prendre(q, "m", { outils: true });
    tour.yieldForTools();
    const autre = suivre(prendre(q, "m"));
    await tour.reacquire();
    await tour.appelLLM(async () => undefined);
    await vider();
    expect(autre.etat).toBe("attente");
  });

  it("en optimized sans outils, le créneau est pris à l'admission", async () => {
    const { q } = optimise();
    await prendre(q, "m");
    const second = suivre(prendre(q, "m", { outils: true }));
    await vider();
    expect(second.etat).toBe("tenue");
    expect(q.status("A", "m")).toMatchObject({ kind: "waiting" });
  });

  it("le mode est résolu une fois, à l'admission ; « auto » suit la sonde", async () => {
    let mode = "auto";
    const { q } = fileDeTest({}, { modeConfigure: () => mode, modeRecommande: () => "optimized" });
    const slot = await prendre(q, "m", { outils: true });
    mode = "classic";
    expect(slot.mode).toBe("optimized");
    expect(q.mode("A")).toBe("classic");
  });

  it("un reacquire concurrent reçoit la même attente", async () => {
    const { q } = optimise();
    const s1 = await prendre(q, "m", { outils: true });
    await s1.reacquire();
    const s2 = await prendre(q, "m", { outils: true });
    const [p1, p2] = [s2.reacquire(), s2.reacquire()];
    expect(p2).toBe(p1);
    const suivi = suivre(p2);
    await vider();
    expect(suivi.etat).toBe("attente");
    s1.yieldForTools();
    await vider();
    expect(suivi.etat).toBe("tenue");
    expect(q.stats("A").active_models[0]?.shared_busy).toBe(1);
  });
});

describe("6. disjoncteur ouvert puis demi-ouvert", () => {
  const echec = async (): Promise<never> => {
    throw new EchecTransport("refus");
  };

  it("5 échecs de transport : refus immédiat sans entrer en file, puis demi-ouvert après 15 s", async () => {
    const { h, q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 4 } });
    for (let i = 0; i < 5; i += 1)
      await expect(q.withLLM("m", "high", undefined, echec, A)).rejects.toThrow(EchecTransport);
    await expect(prendre(q, "m")).rejects.toBeInstanceOf(LLMCircuitOpen);
    expect(q.status("A", "m")).toEqual({ kind: "ready" });
    h.t = 14.9;
    await expect(q.withLLM("m", "high", undefined, async () => "ok", A)).rejects.toBeInstanceOf(
      LLMCircuitOpen,
    );
    h.t = 15;
    await expect(q.withLLM("m", "high", undefined, echec, A)).rejects.toThrow(EchecTransport);
    await expect(prendre(q, "m")).rejects.toBeInstanceOf(LLMCircuitOpen);
    h.t = 30;
    await expect(q.withLLM("m", "high", undefined, async () => "ok", A)).resolves.toBe("ok");
    expect(q.disjoncteur("A").etats.size).toBe(0);
  });

  it("le succès apparent du tour n'efface pas la panne notée pendant le tour", async () => {
    const { q } = fileDeTest();
    const d = q.disjoncteur("A");
    for (let i = 0; i < 4; i += 1) d.recordFailure("m");
    await q.withLLM(
      "m",
      "high",
      undefined,
      async () => d.noteTransportFailure("m", new EchecTransport("x")),
      A,
    );
    await expect(prendre(q, "m")).rejects.toBeInstanceOf(LLMCircuitOpen);
  });

  it("une erreur métier ne compte pas ; une panne notée par le chemin puis relevée, même enveloppée, compte une fois", async () => {
    const { q } = fileDeTest();
    const metier = async (): Promise<never> => {
      throw new Error("400 contexte dépassé");
    };
    for (let i = 0; i < 6; i += 1)
      await expect(q.withLLM("m", "high", undefined, metier, A)).rejects.toThrow("400");
    const systeme = new EchecTransport("ECONNREFUSED");
    const fetchEchoue = new EchecTransport("fetch failed", { cause: systeme });
    const relevee = q.withLLM(
      "m",
      "high",
      undefined,
      async () => {
        q.disjoncteur("A").noteTransportFailure("m", fetchEchoue);
        throw new Error("LLMFailure", { cause: fetchEchoue });
      },
      A,
    );
    await expect(relevee).rejects.toThrow("LLMFailure");
    expect(q.disjoncteur("A").etats.get("m")?.fails).toBe(1);
  });

  it("un abandon de file n'est jamais compté, même causé par un délai dépassé", async () => {
    const classer = (e: unknown): string =>
      e instanceof DOMException && e.name === "TimeoutError" ? "timeout" : "unknown";
    const { q } = fileDeTest({}, { modeConfigure: () => "optimized", classerErreur: classer });
    const occupe = await prendre(q, "m", { outils: true });
    await occupe.reacquire();
    const ctrl = new AbortController();
    const tour = q.withLLM(
      "m",
      "high",
      ctrl.signal,
      async (slot) => {
        const reprise = slot.reacquire();
        ctrl.abort(new DOMException("budget du run écoulé", "TimeoutError"));
        await reprise;
      },
      { ...A, outils: true },
    );
    await expect(tour).rejects.toBeInstanceOf(LLMQueueAborted);
    expect(q.disjoncteur("A").etats.size).toBe(0);
  });
});

describe("7. annulation pendant l'attente", () => {
  it("la demande sort de la file sans prendre de créneau, ni écouteur ; la suivante est servie", async () => {
    const { q } = fileDeTest();
    const tenu = await prendre(q, "m");
    const stop = new AbortController();
    const abandonnee = suivre(prendre(q, "m", { signal: stop.signal }));
    const suivante = suivre(prendre(q, "m"));
    await vider();
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(1);
    expect(q.status("A", "m")).toMatchObject({ kind: "waiting", position: 1, active: 3 });
    stop.abort(new Error("Stop"));
    await vider();
    expect(abandonnee.etat).toBe("rejetee");
    expect(abandonnee.erreur).toBeInstanceOf(LLMQueueAborted);
    expect((abandonnee.erreur as Error).cause).toEqual(new Error("Stop"));
    expect(q.status("A", "m")).toMatchObject({ active: 2 });
    tenu.release();
    await vider();
    expect(suivante.etat).toBe("tenue");
  });

  it("l'écouteur d'abandon est retiré à l'admission, à la reprise et au rendu", async () => {
    const { q } = optimise();
    const stop = new AbortController();
    const tour = await prendre(q, "m", { outils: true, signal: stop.signal });
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
    const autre = await prendre(q, "m", { outils: true });
    await autre.reacquire();
    const reprise = tour.reacquire();
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(1);
    autre.release();
    await reprise;
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
    tour.release();
    expect(getEventListeners(stop.signal, "abort")).toHaveLength(0);
  });

  it("un abandon relance le passage : la minuterie du low abandonné est désarmée", async () => {
    const { h, q } = fileDeTest();
    (await prendre(q, "m1")).release();
    const stop = new AbortController();
    const routine = suivre(prendre(q, "m2", { priority: "low", signal: stop.signal }));
    await vider();
    expect(h.armees).toBe(1);
    stop.abort();
    await vider();
    expect([routine.etat, h.armees]).toEqual(["rejetee", 0]);
  });

  it("un signal déjà levé est refusé sans attente, à l'admission comme à la reprise", async () => {
    const { q } = optimise();
    await expect(prendre(q, "m", { signal: AbortSignal.abort() })).rejects.toBeInstanceOf(LLMQueueAborted);
    const stop = new AbortController();
    const tour = await prendre(q, "m", { outils: true, signal: stop.signal });
    stop.abort();
    await expect(tour.reacquire()).rejects.toBeInstanceOf(LLMQueueAborted);
    expect(q.stats("A").active_models).toEqual([]);
  });

  it("abandon d'une reprise : le modèle reste tenu jusqu'à release", async () => {
    const { q } = optimise();
    const stop = new AbortController();
    const autre = await prendre(q, "m", { outils: true });
    await autre.reacquire();
    const tour = await prendre(q, "m", { outils: true, signal: stop.signal });
    const reprise = suivre(tour.reacquire());
    const changement = suivre(prendre(q, "m2"));
    stop.abort();
    autre.release();
    await vider();
    expect([reprise.etat, changement.etat]).toEqual(["rejetee", "attente"]);
    tour.release();
    tour.release();
    await vider();
    expect(changement.etat).toBe("tenue");
  });

  it("Stop au moment même de l'admission : withLLM rend le créneau sans appeler fn", async () => {
    const { q } = fileDeTest();
    const tenu = await prendre(q, "m");
    const stop = new AbortController();
    let appele = false;
    const tour = suivre(q.withLLM("m", "high", stop.signal, async () => (appele = true), A));
    await vider();
    tenu.release();
    stop.abort();
    await vider();
    expect([tour.etat, appele]).toEqual(["rejetee", false]);
    expect(tour.erreur).toBeInstanceOf(LLMQueueAborted);
    expect(q.status("A", "m")).toEqual({ kind: "ready" });
  });

  it("une annulation pendant la génération traverse withLLM telle quelle, et le créneau est rendu", async () => {
    const { q } = fileDeTest();
    const annulation = new DOMException("arrêt", "AbortError");
    const tour = q.withLLM(
      "m",
      "high",
      undefined,
      async () => {
        throw annulation;
      },
      A,
    );
    await expect(tour).rejects.toBe(annulation);
    expect(q.status("A", "m")).toEqual({ kind: "ready" });
  });
});

describe("8. politique changée à chaud", () => {
  it("un plafond relevé sert aussitôt les demandes en file, dans leur ordre", async () => {
    const { q } = fileDeTest();
    await prendre(q, "m");
    const ordre: string[] = [];
    const attentes = ["b", "c", "d"].map((n) => prendre(q, "m").then((s) => (ordre.push(n), s)));
    await vider();
    q.setPolicy("A", { maxModels: 1, maxConcurrency: 3 });
    await vider();
    expect(ordre).toEqual(["b", "c"]);
    (await attentes[0])?.release();
    await vider();
    expect(ordre).toEqual(["b", "c", "d"]);
  });

  it("un plafond abaissé laisse finir les flux en cours ; les suivants le respectent", async () => {
    const { q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 3 } });
    const tenus = await Promise.all([1, 2, 3].map(() => prendre(q, "m")));
    q.setPolicy("A", { maxModels: 1, maxConcurrency: 1 });
    const suivante = suivre(prendre(q, "m"));
    tenus[0]?.release();
    tenus[1]?.release();
    await vider();
    expect(suivante.etat).toBe("attente");
    tenus[2]?.release();
    await vider();
    expect(suivante.etat).toBe("tenue");
  });

  it("max_models relevé : un second modèle tourne à côté du premier ; valeurs invalides ramenées à 1", async () => {
    const { q } = fileDeTest();
    await prendre(q, "m1");
    const m2 = suivre(prendre(q, "m2"));
    await vider();
    expect(m2.etat).toBe("attente");
    q.setPolicy("A", { maxModels: 2, maxConcurrency: Number.NaN });
    await vider();
    expect(m2.etat).toBe("tenue");
    const m3 = suivre(prendre(q, "m3"));
    await vider();
    expect(m3.etat).toBe("attente");
  });

  it("la source de la politique est relue toutes les 5 s, sans appel à setPolicy", async () => {
    const politiques: Record<string, Politique> = { A: { maxModels: 1, maxConcurrency: 1 } };
    const { h, q } = fileDeTest(politiques);
    await prendre(q, "m");
    const deuxieme = suivre(prendre(q, "m"));
    politiques["A"] = { maxModels: 1, maxConcurrency: 2 };
    h.t = 4.9;
    void prendre(q, "m");
    await vider();
    expect(deuxieme.etat).toBe("attente");
    h.t = 5;
    void prendre(q, "m");
    await vider();
    expect(deuxieme.etat).toBe("tenue");
  });

  it("forget : politique relue aussitôt ; la file d'un serveur au repos est oubliée", async () => {
    const politiques: Record<string, Politique> = { A: { maxModels: 1, maxConcurrency: 1 } };
    const { q } = fileDeTest(politiques);
    const tenu = await prendre(q, "m");
    const suivante = suivre(prendre(q, "m"));
    politiques["A"] = { maxModels: 1, maxConcurrency: 2 };
    q.forget("A");
    void prendre(q, "m");
    await vider();
    expect(suivante.etat).toBe("tenue");
    const disjoncteur = q.disjoncteur("B");
    q.forget("B");
    expect(q.disjoncteur("B")).not.toBe(disjoncteur);
    q.forget("A");
    expect(q.stats("A").active_models[0]?.holders).toBe(3);
    tenu.release();
  });
});

describe("9. deux serveurs indépendants", () => {
  it("saturation, changement de modèle et disjoncteur restent propres à chaque serveur", async () => {
    const { q } = fileDeTest();
    await prendre(q, "m1");
    const surA = suivre(prendre(q, "m2"));
    const surB = suivre(q.acquire({ server: "B", model: "m2" }));
    await vider();
    expect([surA.etat, surB.etat]).toEqual(["attente", "tenue"]);
    surB.valeur?.release();
    for (let i = 0; i < 5; i += 1) q.disjoncteur("A").recordFailure("m9");
    await expect(prendre(q, "m9")).rejects.toBeInstanceOf(LLMCircuitOpen);
    await expect(q.withLLM("m9", "high", undefined, async () => "ok", B)).resolves.toBe("ok");
  });
});

describe("withLLM", () => {
  it("un serveur hors file (cloud) ne prend ni file ni disjoncteur", async () => {
    const { q } = fileDeTest();
    await prendre(q, "m");
    for (let i = 0; i < 5; i += 1) q.disjoncteur("cloud").recordFailure("claude");
    const nuage = { moteur: { id: "cloud", enFile: false } };
    const slot = await q.withLLM("claude", "high", undefined, async (s: Slot) => s, nuage);
    expect(slot).toMatchObject({ server: "cloud", model: "claude", priority: "high" });
    slot.yieldForTools();
    await slot.reacquire();
    await expect(slot.appelLLM(async () => 7)).resolves.toBe(7);
    slot.release();
  });

  it("un slot rendu n'est plus réutilisé : un appel tardif du même contexte repasse par l'admission complète", async () => {
    const { q } = fileDeTest();
    let declencher = (): void => undefined;
    const signal = new Promise<void>((r) => (declencher = r));
    let tardif: Promise<[Slot, string]> | undefined;
    const parent = await q.withLLM(
      "m",
      "high",
      undefined,
      async (slot) => {
        tardif = signal.then(() =>
          q.withLLM("m", "high", undefined, async (s) => [s, q.status("A", "x").kind], A),
        );
        return slot;
      },
      A,
    );
    declencher();
    const [nouveau, autreModele] = (await tardif) ?? [];
    expect(nouveau).toBeDefined();
    expect(nouveau).not.toBe(parent);
    expect(autreModele).toBe("loading");
    expect(q.stats("A").active_models).toEqual([]);
  });

  it("le créneau est rendu même quand fn lève ; release est idempotent", async () => {
    const { q } = fileDeTest();
    const tour = q.withLLM(
      "m",
      "high",
      undefined,
      async () => {
        throw new Error("boum");
      },
      A,
    );
    await expect(tour).rejects.toThrow("boum");
    const slot = await prendre(q, "m");
    slot.release();
    slot.release();
    await expect(slot.reacquire()).rejects.toBeInstanceOf(LLMQueueAborted);
    expect(q.status("A", "m")).toEqual({ kind: "ready" });
  });

  it("sans moteur précisé : le moteur courant, sinon le serveur intégré", async () => {
    const vus: string[] = [];
    const { q } = fileDeTest({}, { moteurCourant: () => ({ id: "conn:7", enFile: true }) });
    await q.withLLM("m", "high", undefined, async (s) => vus.push(s.server));
    const { q: q2 } = fileDeTest();
    await q2.withLLM("m", "high", undefined, async (s) => vus.push(s.server));
    expect(vus).toEqual(["conn:7", "builtin"]);
  });
});

describe("sous-agents et compaction : withLLM imbriqué (règle de B1-20)", () => {
  const outils = { ...A, outils: true };
  const journal = (h: HorlogeLogique) => {
    const appels: string[] = [];
    let [enCours, pic] = [0, 0];
    const generer = (slot: Slot, nom: string, duree: number) =>
      slot.appelLLM(async () => {
        appels.push(`${h.t} ${nom}`);
        pic = Math.max(pic, (enCours += 1));
        await h.attendre(duree);
        enCours -= 1;
      });
    return { appels, generer, pic: () => pic };
  };

  it("optimized, 3 créneaux : trois sous-agents parallèles génèrent en même temps, chacun avec son slot", async () => {
    const { h, q } = optimise({ maxModels: 1, maxConcurrency: 3 });
    const { appels, generer, pic } = journal(h);
    const slots = new Set<Slot>();
    const enfant = (nom: string) =>
      q.withLLM("m", "high", undefined, (s) => generer(slots.add(s) && s, nom, 4), outils);
    const tour = q.withLLM(
      "m",
      "high",
      undefined,
      async (parent) => {
        slots.add(parent);
        await generer(parent, "P", 4);
        await Promise.all(["E1", "E2", "E3"].map(enfant));
        await generer(parent, "P", 4);
      },
      outils,
    );
    await h.avancer(5);
    expect(q.stats("A").active_models).toEqual([
      { model: "m", holders: 3, sem_locked: true, effective_max_convs: 3, shared_busy: 3 },
    ]);
    const etat = { loaded: "m", est_ms: 15000 };
    expect(q.status("A", "m")).toEqual({ kind: "waiting", model: "m", position: 1, active: 3, ...etat });
    expect(q.status("A", "m2")).toEqual({
      kind: "loading",
      model: "m2",
      position: 2,
      active: 1,
      loaded: "m",
      est_ms: 30000,
    });
    await h.avancer();
    await tour;
    expect(appels).toEqual(["0 P", "4 E1", "4 E2", "4 E3", "8 P"]);
    expect([pic(), slots.size]).toEqual([3, 4]);
  });

  it("optimized, 1 créneau : les sous-agents alternent ; la reprise du parent prend son tour, sans interblocage", async () => {
    const { h, q } = optimise();
    const { appels, generer } = journal(h);
    const enfant = (nom: string) =>
      q.withLLM(
        "m",
        "high",
        undefined,
        async (s) => {
          await generer(s, nom, 2);
          await h.attendre(1);
          await generer(s, nom, 2);
        },
        outils,
      );
    const tour = q.withLLM(
      "m",
      "high",
      undefined,
      async (parent) => {
        await generer(parent, "P", 2);
        const reprise = h.attendre(3).then(() => generer(parent, "P", 2));
        await Promise.all([...["E1", "E2", "E3"].map(enfant), reprise]);
      },
      outils,
    );
    await h.avancer();
    await tour;
    expect(appels).toEqual(["0 P", "2 E1", "4 E2", "6 E3", "8 P", "10 E1", "12 E2", "14 E3"]);
    expect(q.stats("A").active_models).toEqual([]);
  });

  it("un sous-agent d'un autre modèle prend les créneaux de son modèle sans tenir de modèle (`llm_slot`)", async () => {
    const { h, q } = optimise();
    const { appels, generer } = journal(h);
    const tours = [
      q.withLLM(
        "m1",
        "high",
        undefined,
        async (p) => {
          await generer(p, "P", 2);
          await q.withLLM(
            "m2",
            "high",
            undefined,
            async (k) => {
              await generer(k, "K", 3);
              await h.attendre(1);
              await generer(k, "K", 3);
            },
            outils,
          );
          await generer(p, "P", 2);
        },
        outils,
      ),
      q.withLLM("m1", "high", undefined, (u) => h.attendre(2.5).then(() => generer(u, "U", 2)), outils),
    ];
    h.planifier(1, () => tours.push(q.withLLM("m3", "high", undefined, (v) => generer(v, "V", 1), outils)));
    await h.avancer(3);
    expect(q.stats("A")).toMatchObject({
      active_models: [{ model: "m2", holders: 1, shared_busy: 1 }],
      slot_waiters: [{ model: "m1", priority: "high", cancelled: false }],
    });
    expect(q.status("A", "m1")).toEqual({
      kind: "waiting",
      model: "m1",
      loaded: "m1",
      position: 2,
      active: 2,
      est_ms: 30000,
    });
    await h.avancer();
    await Promise.all(tours);
    expect(appels).toEqual(["0 P", "2 K", "5 U", "7 K", "10 P", "12 V"]);
  });

  it("places de modèle servies dans l'ordre, sans saut : un enfant dont le modèle s'ouvre attend l'autre modèle arrivé avant lui", async () => {
    const { h, q } = optimise({ maxModels: 1, maxConcurrency: 2 });
    const { appels, generer } = journal(h);
    const enfant = ([nom, model]: string[]) =>
      q.withLLM(model ?? "", "high", undefined, (k) => generer(k, nom ?? "", 3), outils);
    const tours = [
      q.withLLM(
        "m0",
        "high",
        undefined,
        async (p) => {
          await generer(p, "P", 5);
          await Promise.all(
            [
              ["K1", "m1"],
              ["K2", "m2"],
              ["K3", "m1"],
            ].map(enfant),
          );
        },
        outils,
      ),
      q.withLLM("m0", "high", undefined, (u) => h.attendre(4).then(() => generer(u, "U", 6)), outils),
    ];
    await h.avancer(11);
    expect(q.stats("A").slot_waiters.map((w) => w.model)).toEqual(["m2", "m1"]);
    await h.avancer();
    await Promise.all(tours);
    expect(appels).toEqual(["0 P", "4 U", "10 K1", "13 K2", "16 K3"]);
  });

  it("classic : les sous-agents réutilisent le créneau tenu par le tour, sans acquisition, même sur un autre modèle", async () => {
    const { q } = fileDeTest();
    const vus = new Set<Slot>();
    const pendant = await q.withLLM(
      "m",
      "high",
      undefined,
      async (parent) => {
        vus.add(parent);
        const enfant = (model: string) =>
          q.withLLM(model, "low", undefined, (s) => vus.add(s) && s.appelLLM(async () => undefined), outils);
        await Promise.all(["m", "m2", "m"].map(enfant));
        return q.stats("A");
      },
      outils,
    );
    expect(vus.size).toBe(1);
    expect(pendant).toMatchObject({
      active_models: [{ model: "m", holders: 1, shared_busy: 1 }],
      slot_waiters: [],
    });
    expect(q.stats("A").active_models).toEqual([]);
  });

  it("compaction, cap = 1 : pendant l'appel du tour, elle passe par son créneau ; entre deux appels, elle prend le sien", async () => {
    const { h, q } = optimise();
    const vus: Slot[] = [];
    const compacter = () =>
      q.withLLM(
        "m",
        "high",
        undefined,
        async (s) => {
          vus.push(s);
          return s.appelLLM(async () => (await h.attendre(2), q.stats("A").active_models));
        },
        A,
      );
    const tour = q.withLLM(
      "m",
      "high",
      undefined,
      async (parent) => {
        vus.push(parent);
        const pendant = await parent.appelLLM(async () => (await h.attendre(1), compacter()));
        return [pendant, await compacter()];
      },
      outils,
    );
    await h.avancer();
    const [pendant, entre] = await tour;
    expect([vus[1] === vus[0], vus[2] === vus[0], h.t]).toEqual([true, false, 5]);
    const occupe = { model: "m", holders: 1, sem_locked: true, effective_max_convs: 1, shared_busy: 1 };
    expect([pendant, entre]).toEqual([[occupe], [occupe]]);
  });
});

describe("état du widget et stats", () => {
  it("valeurs mesurées sur le Python (py_statut.py) : 1 créneau, un tour actif, trois en attente", async () => {
    const { q } = fileDeTest();
    await prendre(q, "m");
    for (let i = 0; i < 3; i += 1) void prendre(q, "m");
    await vider();
    expect(q.status("A", "m")).toEqual({
      kind: "waiting",
      model: "m",
      loaded: "m",
      position: 1,
      active: 4,
      est_ms: 15000,
    });
    expect(q.status("A", "m2")).toEqual({
      kind: "loading",
      model: "m2",
      loaded: "m",
      position: 5,
      active: 4,
      est_ms: 75000,
    });
  });

  it("estimation tirée des durées mesurées ; les demandes d'autres modèles ne comptent pas", async () => {
    const { q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 1 } });
    await prendre(q, "m");
    void prendre(q, "m");
    void prendre(q, "x");
    await vider();
    q.recordLlmDuration("A", "m", 1000);
    q.recordLlmDuration("A", "m", -5);
    expect(q.status("A", "m")).toEqual({
      kind: "waiting",
      model: "m",
      loaded: "m",
      position: 1,
      active: 2,
      est_ms: 1200,
    });
  });

  it("chargement : autre modèle tenu, ou routeur sans modèle chargé", async () => {
    let statuts: Map<string, string> | null = null;
    const { q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 2 } }, { statutsModeles: () => statuts });
    expect(q.status("A", "qwen")).toEqual({ kind: "ready" });
    statuts = new Map([["qwen", "unloaded"]]);
    expect(q.status("A", "qwen")).toEqual({
      kind: "loading",
      model: "qwen",
      loaded: null,
      position: 1,
      active: 1,
      est_ms: 15000,
    });
    statuts = new Map([
      ["autre", "loaded"],
      ["qwen", "loaded"],
    ]);
    expect(q.status("A", "qwen")).toEqual({ kind: "ready" });
    statuts = null;
    await prendre(q, "autre");
    await prendre(q, "autre");
    expect(q.status("A", "qwen")).toEqual({
      kind: "loading",
      model: "qwen",
      loaded: "autre",
      position: 3,
      active: 2,
      est_ms: 45000,
    });
  });

  it("stats : les clés de get_stats() (niveau 2) ; une demande qui attend un autre modèle au niveau 1 n'y figure pas", async () => {
    const { q } = fileDeTest({ A: { maxModels: 1, maxConcurrency: 2 } }, { totalSlots: () => 2 });
    await prendre(q, "m");
    await prendre(q, "m");
    void prendre(q, "m");
    void prendre(q, "m2", { priority: "low" });
    await vider();
    expect(q.stats("A")).toEqual({
      max_models: 1,
      max_conversations_per_model_config_fallback: 2,
      total_slots_from_props: 2,
      active_models: [{ model: "m", holders: 3, sem_locked: true, effective_max_convs: 2, shared_busy: 2 }],
      slot_waiters: [],
    });
  });
});
