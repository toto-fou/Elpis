// SPDX-License-Identifier: MIT
/** frontend/test/chat/liste/regroupement.test.ts — réveils regroupés à l'affichage : têtes de bulle, réveils successifs, replis (rien, utilisateur, erreur avant le réveil), remontée locale identique au parcours complet, compte des bulles. */
import { describe, expect, it } from "vitest";

import { compterBulles, teteDeBulle, tetesDeBulles } from "../../../src/features/chat/liste/regroupement";
import type { MessageGroupable } from "../../../src/features/chat/liste/regroupement";

const U: MessageGroupable = { role: "user" };
const A: MessageGroupable = { role: "assistant" };
const W: MessageGroupable = { role: "user", origin: "job_wake" };
const E: MessageGroupable = { role: "assistant", isError: true };
const N: MessageGroupable = { role: "notice" };

describe("tetesDeBulles", () => {
  it("réponse + (réveil + réponse)* : une seule tête, jusqu'au prochain message de l'utilisateur", () => {
    expect(tetesDeBulles([U, A, W, A, W, A, U, A])).toEqual([0, 1, 1, 1, 1, 1, 6, 7]);
  });

  it("réveils successifs sans réponse entre eux : tous dans la bulle", () => {
    expect(tetesDeBulles([U, A, W, W, A])).toEqual([0, 1, 1, 1, 1]);
  });

  it("réveil en fin de liste (tour qui démarre) : déjà dans la bulle", () => {
    expect(tetesDeBulles([U, A, W])).toEqual([0, 1, 1]);
  });

  it("repli : réveil en tête de conversation, après l'utilisateur, après une erreur ou une notice", () => {
    expect(tetesDeBulles([W, A])).toEqual([0, 1]);
    expect(tetesDeBulles([U, W, A])).toEqual([0, 1, 2]);
    expect(tetesDeBulles([U, E, W, A])).toEqual([0, 1, 2, 3]);
    expect(tetesDeBulles([U, A, N, W, A])).toEqual([0, 1, 2, 3, 4]);
  });

  it("réponse en erreur après un réveil : bulle à part, et les réveils suivants ne s'y rattachent pas", () => {
    expect(tetesDeBulles([U, A, W, E, W, A])).toEqual([0, 1, 1, 3, 4, 5]);
  });

  it("une réponse sans réveil devant elle ouvre sa propre bulle", () => {
    expect(tetesDeBulles([U, A, A, W, A])).toEqual([0, 1, 2, 2, 2]);
  });

  it("liste vide ou trouée", () => {
    expect(tetesDeBulles([])).toEqual([]);
    expect(tetesDeBulles([undefined, A, W])).toEqual([0, 1, 1]);
  });
});

describe("teteDeBulle", () => {
  // Référence : automate qui parcourt toute la liste (bulle ouverte ou non).
  function reference(msgs: readonly MessageGroupable[]): number[] {
    const out: number[] = [];
    let tete = -1;
    msgs.forEach((m, i) => {
      const reveil = m.role === "user" && m.origin === "job_wake";
      const reponse = m.role === "assistant" && !m.isError;
      const avant = msgs[i - 1];
      const apresReveil = avant?.role === "user" && avant.origin === "job_wake";
      if (tete >= 0 && (reveil || (apresReveil && reponse))) out.push(tete);
      else {
        out.push(i);
        tete = reponse ? i : -1;
      }
    });
    return out;
  }

  it("remontée locale = parcours complet = automate de référence, sur 300 fils tirés au sort", () => {
    const sortes = [U, A, W, E, N];
    let graine = 7;
    const tirer = (): number => (graine = (graine * 1103515245 + 12345) % 2147483648) % sortes.length;
    for (let n = 0; n < 300; n++) {
      const msgs = Array.from({ length: 1 + (n % 25) }, () => sortes[tirer()] as MessageGroupable);
      const attendu = reference(msgs);
      expect(tetesDeBulles(msgs)).toEqual(attendu);
      expect(msgs.map((_, i) => teteDeBulle(msgs, i))).toEqual(attendu);
    }
  });
});

describe("compterBulles", () => {
  it("compte les bulles, pas les messages", () => {
    const msgs = [
      { ...U, t: "pytest ?" },
      { ...A, t: "pytest lancé" },
      { ...W, t: "pytest exit" },
      { ...A, t: "pytest ok" },
    ];
    expect(compterBulles(msgs, (m) => m.t.includes("pytest"))).toBe(2);
    expect(compterBulles(msgs, (m) => m.t.includes("ok"))).toBe(1);
    expect(compterBulles(msgs, () => false)).toBe(0);
  });
});
