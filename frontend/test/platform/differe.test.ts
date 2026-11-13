// SPDX-License-Identifier: MIT
/** frontend/test/platform/differe.test.ts — morceaux à la demande : import partagé, nouvel essai, version remplacée qui recharge la page (une fois par minute), coupure signalée. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chargeurUnique, creerMorceaux, rechargerPage, versionRemplacee } from "../../src/platform/differe";

const PAGE = '<script type="module" src="/static/dist/assets/main-AAAA1111.js"></script>';
let recharge: ReturnType<typeof vi.fn<() => void>>;

function servir(reponse: () => Promise<Response>): void {
  vi.stubGlobal("fetch", vi.fn(reponse));
}

beforeEach(() => {
  // Script inerte à l'insertion (happy-dom ne charge rien), module ensuite : seule la balise compte.
  document.head.innerHTML = '<script type="text/plain" src="/static/dist/assets/main-AAAA1111.js"></script>';
  document.head.querySelector("script")?.setAttribute("type", "module");
  sessionStorage.clear();
  recharge = vi.fn<() => void>();
  vi.spyOn(location, "reload").mockImplementation(recharge);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.head.innerHTML = "";
});

describe("morceaux à la demande", () => {
  it("un import partagé par les appels concurrents, relancé après un échec", async () => {
    let n = 0;
    const charger = chargeurUnique(() =>
      ++n === 1 ? Promise.reject(new Error("coupure")) : Promise.resolve(n),
    );
    await expect(charger()).rejects.toThrow("coupure");
    const [a, b] = await Promise.all([charger(), charger()]);
    expect([a, b, n]).toEqual([2, 2, 2]);
  });

  it("version remplacée : la page servie n'annonce plus le module chargé ; réseau coupé ou même page : non", async () => {
    servir(() => Promise.resolve(new Response(PAGE.replace("AAAA1111", "BBBB2222"))));
    expect(await versionRemplacee()).toBe(true);
    servir(() => Promise.resolve(new Response(PAGE)));
    expect(await versionRemplacee()).toBe(false);
    servir(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(await versionRemplacee()).toBe(false);
    servir(() => Promise.resolve(new Response("", { status: 502 })));
    expect(await versionRemplacee()).toBe(false);
  });

  it("au plus un rechargement par minute", () => {
    expect(rechargerPage()).toBe(true);
    expect(rechargerPage()).toBe(false);
    expect(recharge).toHaveBeenCalledTimes(1);
  });

  it("préchargement silencieux ; ouverture : monté, message puis nouvel essai sur une coupure, après une mise à jour rechargement proposé (saisie en cours) ou d'office", async () => {
    const charges: string[] = [];
    const echecs: (() => void)[] = [];
    const propositions: (() => void)[] = [];
    let coupure = true;
    let saisie = "";
    const m = creerMorceaux(
      {
        studio: () => Promise.resolve({ default: "PageStudio" }),
        code: () =>
          coupure ? Promise.reject(new Error("coupure")) : Promise.resolve({ default: "PageCode" }),
        rag: () => Promise.reject(new Error("404")),
      },
      {
        charge: (k) => charges.push(k),
        echec: (_k, reessayer) => echecs.push(reessayer),
        rechargeable: () => !saisie,
        miseAJour: (recharger) => propositions.push(recharger),
      },
    );
    await m.precharger("studio");
    await m.demander("studio");
    expect(charges).toEqual(["studio"]);

    servir(() => Promise.resolve(new Response(PAGE)));
    await m.demander("code");
    expect([charges, echecs.length, recharge.mock.calls.length]).toEqual([["studio"], 1, 0]);
    coupure = false;
    echecs[0]?.();
    await vi.waitFor(() => expect(charges).toEqual(["studio", "code"]));

    servir(() => Promise.resolve(new Response(PAGE.replace("AAAA1111", "CCCC3333"))));
    saisie = "brouillon en cours";
    await m.demander("rag");
    expect([echecs.length, propositions.length, recharge.mock.calls.length]).toEqual([1, 1, 0]);
    propositions[0]?.();
    expect(recharge).toHaveBeenCalledTimes(1);
    sessionStorage.clear();
    recharge.mockClear();
    saisie = "";
    await m.demander("rag");
    expect([echecs.length, propositions.length, recharge.mock.calls.length]).toEqual([1, 1, 1]);
    await expect(m.precharger("rag")).rejects.toThrow("404");
    expect(recharge).toHaveBeenCalledTimes(1);
  });
});
