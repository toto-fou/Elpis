// SPDX-License-Identifier: MIT
/** packages/mcp/test/concurrence.test.ts — verrou et sémaphore asynchrones (FIFO, délai, annulation), bornes par signal et course. */
import { describe, expect, it } from "vitest";

import { course, DelaiDepasse, delaiMinuterie, Semaphore, signalBorne, Verrou } from "../src";

const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("Verrou", () => {
  it("FIFO, remise directe au suivant, pas de passe-droit", async () => {
    const v = new Verrou();
    const ordre: number[] = [];
    await v.acquerir();
    const attentes = [1, 2, 3].map((i) => v.acquerir().then(() => ordre.push(i)));
    expect(v.enAttente).toBe(3);
    v.liberer();
    expect(v.essayer()).toBe(false);
    await attentes[0];
    v.liberer();
    await attentes[1];
    v.liberer();
    await attentes[2];
    v.liberer();
    expect(ordre).toEqual([1, 2, 3]);
    expect(v.locked).toBe(false);
    expect(() => v.liberer()).toThrow("Lock is not acquired.");
  });

  it("attente bornée : DelaiDepasse (TimeoutError, message vide), l'attendeur sort de la file", async () => {
    const v = new Verrou();
    await v.acquerir();
    const e = await v.acquerir({ delaiMs: 10 }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DelaiDepasse);
    expect(e).toMatchObject({ name: "TimeoutError", message: "" });
    expect(v.enAttente).toBe(0);
    v.liberer();
    expect(v.locked).toBe(false);
  });

  it("annulation : rejet par la raison du signal, déjà annulé ou pendant l'attente", async () => {
    const v = new Verrou();
    await v.acquerir();
    const ctl = new AbortController();
    const p = v.acquerir({ signal: ctl.signal });
    ctl.abort("arrêt");
    await expect(p).rejects.toBe("arrêt");
    await expect(v.acquerir({ signal: ctl.signal })).rejects.toBe("arrêt");
    expect(v.enAttente).toBe(0);
    await expect(v.avec(async () => 1, { signal: AbortSignal.abort("x") })).rejects.toBe("x");
  });
});

describe("Semaphore", () => {
  it("permis comptés, attente FIFO, valeur rendue", async () => {
    const s = new Semaphore(2);
    await s.acquerir();
    await s.acquerir();
    expect(s.value).toBe(0);
    let servi = false;
    const p = s.acquerir().then(() => (servi = true));
    await attendre(1);
    expect(servi).toBe(false);
    s.liberer();
    await p;
    expect(servi).toBe(true);
    s.liberer();
    s.liberer();
    expect(s.value).toBe(2);
    await s.acquerir({ delaiMs: 0 });
    await s.acquerir({ delaiMs: 0 });
    await expect(s.acquerir({ delaiMs: 5 })).rejects.toBeInstanceOf(DelaiDepasse);
  });
});

describe("délais extrêmes", () => {
  it("+∞, NaN ou au-delà du plafond de setTimeout : jamais un délai immédiat (Node ramène > 2^31-1 ms à 1 ms)", async () => {
    expect(delaiMinuterie(Infinity)).toBeNull();
    expect(delaiMinuterie(Number.NaN)).toBeNull();
    expect(delaiMinuterie(3e12)).toBe(2_147_483_647);
    expect(delaiMinuterie(-5)).toBe(0);
    const bornes = [signalBorne(undefined, Infinity), signalBorne(undefined, 3e12)];
    const v = new Verrou();
    await v.acquerir();
    let rejete = false;
    const attente = v.acquerir({ delaiMs: 3e12 }).catch(() => (rejete = true));
    await attendre(20);
    expect(bornes.map((b) => b.signal.aborted)).toEqual([false, false]);
    expect(rejete).toBe(false);
    v.liberer();
    await attente;
    for (const b of bornes) b.liberer();
  });
});

describe("bornes par signal", () => {
  it("signalBorne : délai → raison DelaiDepasse ; parent annulé → raison du parent ; libérée → rien", async () => {
    const b = signalBorne(undefined, 5);
    await attendre(15);
    expect(b.signal.aborted).toBe(true);
    expect(b.signal.reason).toBe(b.delai);
    const ctl = new AbortController();
    const c = signalBorne(ctl.signal, 1000);
    ctl.abort("parent");
    expect(c.signal.reason).toBe("parent");
    c.liberer();
    const d = signalBorne(undefined, 5);
    d.liberer();
    await attendre(15);
    expect(d.signal.aborted).toBe(false);
  });

  it("course : résultat, erreur, ou raison d'annulation ; la promesse abandonnée ne lève plus", async () => {
    expect(await course(Promise.resolve(1), undefined)).toBe(1);
    const ctl = new AbortController();
    await expect(course(Promise.reject(new Error("x")), ctl.signal)).rejects.toThrow("x");
    const lente = new Promise((_, r) => setTimeout(() => r(new Error("tardive")), 5));
    const p = course(lente, ctl.signal);
    ctl.abort("stop");
    await expect(p).rejects.toBe("stop");
    await attendre(10);
    await expect(course(Promise.resolve(2), AbortSignal.abort("déjà"))).rejects.toBe("déjà");
  });
});
