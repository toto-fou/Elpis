// SPDX-License-Identifier: MIT
/** apps/core/test/llm/part-compte.test.ts — plafond de requêtes simultanées au moteur par compte : attente, ordre, abandon, réglage à chaud. */
import type * as C from "@elpis/config";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChampsRun } from "../../src/boucle/run";
import type { Slot, SourcesFile } from "../../src/llm/ordonnanceur/file";

let plafond: unknown = 0;
vi.mock("@elpis/config", async (orig) => ({
  ...(await orig<typeof C>()),
  liveConfigValue: (chemin: string, defaut: unknown) =>
    chemin === "llm.max_requests_per_user" ? plafond : defaut,
}));

const { avecPartDuCompte, etatPart, plafondRequetesParCompte } = await import("../../src/llm/part-compte");
const { LLMQueue } = await import("../../src/llm/ordonnanceur/file");
const { RunContext } = await import("../../src/boucle/run");

/** Appel au moteur retenu jusqu'à `finir()`. */
function appel(): { fn: () => Promise<string>; finir: (v?: string) => void; parti: () => boolean } {
  let finir: (v?: string) => void = () => undefined;
  let parti = false;
  const fn = (): Promise<string> => {
    parti = true;
    return new Promise<string>((ok) => {
      finir = (v = "ok") => ok(v);
    });
  };
  return { fn, finir: (v) => finir(v), parti: () => parti };
}

const tic = (): Promise<void> => new Promise((r) => setImmediate(r));

afterEach(() => {
  plafond = 0;
});

describe("interblocage créneau et part : classic et optimized sur un même serveur", () => {
  it("un run qui garde son créneau n'attend pas la part tenue par celui qui attend ce créneau", async () => {
    plafond = 1;
    let mode: "classic" | "optimized" = "classic";
    const file = new LLMQueue({
      politique: () => ({ maxModels: 1, maxConcurrency: 1 }),
      totalSlots: () => 1,
      modeConfigure: () => mode,
    } as unknown as SourcesFile);
    const moteur = { id: "s", enFile: true };
    const champs = (slot: Slot): ChampsRun =>
      ({ username: "melange", signal: undefined, slot }) as unknown as ChampsRun;
    const ordre: string[] = [];
    let relancer: () => void = () => undefined;
    const reprise = new Promise<void>((r) => (relancer = r));
    const classique = file.withLLM(
      "m",
      "high",
      undefined,
      async (slot) => {
        const ctx = new RunContext(champs(slot));
        await ctx.appelLLM(async () => ordre.push("classique 1"));
        await reprise;
        await ctx.appelLLM(async () => ordre.push("classique 2"));
      },
      { moteur, outils: true },
    );
    await tic();
    mode = "optimized";
    const optimise = file.withLLM(
      "m",
      "high",
      undefined,
      (slot) => new RunContext(champs(slot)).appelLLM(async () => ordre.push("optimise")),
      { moteur, outils: true },
    );
    await tic();
    expect(etatPart("melange").actifs).toBe(1);
    relancer();
    await Promise.race([
      Promise.all([classique, optimise]),
      new Promise((_, ko) => setTimeout(() => ko(new Error("interblocage")), 2000)),
    ]);
    expect(ordre).toEqual(["classique 1", "classique 2", "optimise"]);
    expect(etatPart("melange")).toEqual({ actifs: 0, enAttente: 0 });
  });
});

describe("RunContext.appelLLM", () => {
  it("le signal de l'appel coupe l'attente de la part (échéance du run)", async () => {
    plafond = 1;
    const ctx = new RunContext({
      username: "echeance",
      signal: undefined,
      slot: null,
    } as unknown as ChampsRun);
    const a = appel();
    const pa = ctx.appelLLM(a.fn);
    await tic();
    const coupure = new AbortController();
    const b = appel();
    const pb = ctx.appelLLM(b.fn, coupure.signal);
    await tic();
    coupure.abort(new Error("échéance"));
    await expect(pb).rejects.toThrow("échéance");
    expect(b.parti()).toBe(false);
    a.finir();
    await pa;
  });

  it("un agent en fond (priorité basse) cède la place au tour interactif du compte", async () => {
    plafond = 1;
    const slot = (priority: "high" | "low"): Slot =>
      ({ priority, appelLLM: <T>(f: () => Promise<T>) => f() }) as unknown as Slot;
    const ctx = (s: Slot) =>
      new RunContext({ username: "fond", signal: undefined, slot: s } as unknown as ChampsRun);
    const a = appel();
    const fond = appel();
    const tour = appel();
    const pa = ctx(slot("high")).appelLLM(a.fn);
    const pf = ctx(slot("low")).appelLLM(fond.fn);
    const pt = ctx(slot("high")).appelLLM(tour.fn);
    await tic();
    a.finir();
    await tic();
    expect([tour.parti(), fond.parti()]).toEqual([true, false]);
    tour.finir();
    await tic();
    fond.finir();
    await Promise.all([pa, pf, pt]);
  });
});

describe("plafondRequetesParCompte", () => {
  it.each([
    [0, 0],
    [3, 3],
    [-2, 0],
    [1.5, 0],
    ["4", 4],
    [" 4 ", 4],
    ["abc", 0],
    ["", 0],
    ["2.5", 0],
    [true, 0],
    [null, 0],
  ])("valeur %j : %d", (v, attendu) => {
    plafond = v;
    expect(plafondRequetesParCompte()).toBe(attendu);
  });
});

describe("avecPartDuCompte", () => {
  it("sans plafond, tout part à la fois et la part est oubliée à la fin", async () => {
    const a = Array.from({ length: 20 }, () => appel());
    const p = a.map((x) => avecPartDuCompte("sans", undefined, x.fn));
    await tic();
    expect(a.every((x) => x.parti())).toBe(true);
    expect(etatPart("sans")).toEqual({ actifs: 20, enAttente: 0 });
    a.forEach((x) => x.finir());
    await Promise.all(p);
    expect(etatPart("sans")).toEqual({ actifs: 0, enAttente: 0 });
  });

  it("au plafond, le surplus attend et part dans l'ordre d'arrivée, sans refus", async () => {
    plafond = 2;
    const a = Array.from({ length: 4 }, () => appel());
    const p = a.map((x) => avecPartDuCompte("plein", undefined, x.fn));
    await tic();
    expect(a.map((x) => x.parti())).toEqual([true, true, false, false]);
    expect(etatPart("plein")).toEqual({ actifs: 2, enAttente: 2 });
    a[1]!.finir();
    await tic();
    expect(a.map((x) => x.parti())).toEqual([true, true, true, false]);
    a[0]!.finir();
    await tic();
    expect(a[3]!.parti()).toBe(true);
    a[2]!.finir();
    a[3]!.finir();
    expect(await Promise.all(p)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(etatPart("plein")).toEqual({ actifs: 0, enAttente: 0 });
  });

  it("un compte au plafond ne retient pas un autre compte", async () => {
    plafond = 1;
    const a = appel();
    const b = appel();
    const c = appel();
    const pa = avecPartDuCompte("alice", undefined, a.fn);
    const pb = avecPartDuCompte("alice", undefined, b.fn);
    const pc = avecPartDuCompte("bob", undefined, c.fn);
    await tic();
    expect([a.parti(), b.parti(), c.parti()]).toEqual([true, false, true]);
    a.finir();
    await tic();
    b.finir();
    c.finir();
    await Promise.all([pa, pb, pc]);
  });

  it("un nouvel appel ne double pas ceux qui attendent", async () => {
    plafond = 1;
    const a = appel();
    const b = appel();
    const c = appel();
    const pa = avecPartDuCompte("ordre", undefined, a.fn);
    const pb = avecPartDuCompte("ordre", undefined, b.fn);
    await tic();
    a.finir();
    const pc = avecPartDuCompte("ordre", undefined, c.fn);
    await tic();
    expect([b.parti(), c.parti()]).toEqual([true, false]);
    b.finir();
    await tic();
    c.finir();
    await Promise.all([pa, pb, pc]);
  });

  it("l'échec d'un appel rend sa place", async () => {
    plafond = 1;
    const b = appel();
    const pa = avecPartDuCompte("echec", undefined, () => Promise.reject(new Error("moteur")));
    const pb = avecPartDuCompte("echec", undefined, b.fn);
    await expect(pa).rejects.toThrow("moteur");
    await tic();
    expect(b.parti()).toBe(true);
    b.finir();
    await pb;
    expect(etatPart("echec")).toEqual({ actifs: 0, enAttente: 0 });
  });

  it("un abandon en attente sort de la file avec la raison du signal, sans lancer l'appel", async () => {
    plafond = 1;
    const a = appel();
    const b = appel();
    const c = appel();
    const ctrl = new AbortController();
    const pa = avecPartDuCompte("stop", undefined, a.fn);
    const pb = avecPartDuCompte("stop", ctrl.signal, b.fn);
    const pc = avecPartDuCompte("stop", undefined, c.fn);
    await tic();
    const raison = new Error("arrêté");
    ctrl.abort(raison);
    await expect(pb).rejects.toBe(raison);
    expect(etatPart("stop")).toEqual({ actifs: 1, enAttente: 1 });
    a.finir();
    await tic();
    expect([b.parti(), c.parti()]).toEqual([false, true]);
    c.finir();
    await Promise.all([pa, pc]);
    expect(etatPart("stop")).toEqual({ actifs: 0, enAttente: 0 });
  });

  it("un signal déjà abandonné n'entre pas", async () => {
    const a = appel();
    const ctrl = new AbortController();
    ctrl.abort(new Error("déjà"));
    await expect(avecPartDuCompte("avant", ctrl.signal, a.fn)).rejects.toThrow("déjà");
    expect(a.parti()).toBe(false);
    expect(etatPart("avant")).toEqual({ actifs: 0, enAttente: 0 });
  });

  it("un appel imbriqué du même compte reste dans la place tenue (pas d'interblocage à 1)", async () => {
    plafond = 1;
    const r = await avecPartDuCompte("imbrique", undefined, () =>
      avecPartDuCompte("imbrique", undefined, () => Promise.resolve("dedans")),
    );
    expect(r).toBe("dedans");
    expect(etatPart("imbrique")).toEqual({ actifs: 0, enAttente: 0 });
  });

  it("les appels interactifs passent avant ceux d'un agent en fond ou d'une routine", async () => {
    plafond = 1;
    const a = appel();
    const fond = appel();
    const tour = appel();
    const pa = avecPartDuCompte("prio", undefined, a.fn);
    const pf = avecPartDuCompte("prio", undefined, fond.fn, { basse: true });
    const pt = avecPartDuCompte("prio", undefined, tour.fn);
    await tic();
    a.finir();
    await tic();
    expect([tour.parti(), fond.parti()]).toEqual([true, false]);
    tour.finir();
    await tic();
    expect(fond.parti()).toBe(true);
    fond.finir();
    await Promise.all([pa, pf, pt]);
    expect(etatPart("prio")).toEqual({ actifs: 0, enAttente: 0 });
  });

  it("sansAttente : compté et lancé malgré le plafond, sans qu'un autre passe devant ensuite", async () => {
    plafond = 1;
    const a = appel();
    const b = appel();
    const c = appel();
    const pa = avecPartDuCompte("tient", undefined, a.fn);
    const pb = avecPartDuCompte("tient", undefined, b.fn, { sansAttente: true });
    const pc = avecPartDuCompte("tient", undefined, c.fn);
    await tic();
    expect([a.parti(), b.parti(), c.parti()]).toEqual([true, true, false]);
    expect(etatPart("tient")).toEqual({ actifs: 2, enAttente: 1 });
    a.finir();
    await tic();
    expect(c.parti()).toBe(false);
    b.finir();
    await tic();
    expect(c.parti()).toBe(true);
    c.finir();
    await Promise.all([pa, pb, pc]);
  });

  it("le plafond est relu à chaud : le monter libère l'attente au prochain appel rendu", async () => {
    plafond = 1;
    const a = Array.from({ length: 3 }, () => appel());
    const p = a.map((x) => avecPartDuCompte("chaud", undefined, x.fn));
    await tic();
    expect(a.map((x) => x.parti())).toEqual([true, false, false]);
    plafond = 0;
    a[0]!.finir();
    await tic();
    expect(a.map((x) => x.parti())).toEqual([true, true, true]);
    a[1]!.finir();
    a[2]!.finir();
    await Promise.all(p);
  });

  it("le plafond baissé ne coupe rien : il s'applique aux suivants", async () => {
    plafond = 0;
    const a = Array.from({ length: 3 }, () => appel());
    const p = a.map((x) => avecPartDuCompte("baisse", undefined, x.fn));
    await tic();
    plafond = 1;
    const d = appel();
    const pd = avecPartDuCompte("baisse", undefined, d.fn);
    await tic();
    expect(d.parti()).toBe(false);
    a[0]!.finir();
    a[1]!.finir();
    await tic();
    expect(d.parti()).toBe(false);
    a[2]!.finir();
    await tic();
    expect(d.parti()).toBe(true);
    d.finir();
    await Promise.all([...p, pd]);
  });
});
