// SPDX-License-Identifier: MIT
/** frontend/test/rag/bulle.test.ts — bulle d'une source : ouverture après un délai, fermeture différée gardée par le survol de la bulle, Échap, position dans l'écran. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerBulle, ID_BULLE_SOURCE, positionBulle } from "../../src/features/rag/bulle";
import { source } from "./aides-sources";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function pastille(): HTMLElement {
  const b = document.createElement("button");
  document.body.appendChild(b);
  return b;
}

describe("bulle", () => {
  it("s'ouvre après le délai et décrit la pastille", () => {
    const b = creerBulle();
    const p = pastille();
    b.survol(source(2), p, () => undefined);
    expect(b.etat.value).toBeNull();
    vi.advanceTimersByTime(150);
    expect(b.etat.value?.source.n).toBe(2);
    expect(p.getAttribute("aria-describedby")).toBe(ID_BULLE_SOURCE);
  });

  it("quitter avant le délai : elle ne s'ouvre pas", () => {
    const b = creerBulle();
    b.survol(source(1), pastille(), () => undefined);
    b.sortie();
    vi.advanceTimersByTime(500);
    expect(b.etat.value).toBeNull();
  });

  it("se ferme après un court délai quand on quitte la pastille, gardée ouverte par le survol de la bulle", () => {
    const b = creerBulle();
    const p = pastille();
    b.survol(source(1), p, () => undefined);
    vi.advanceTimersByTime(150);
    b.sortie();
    b.entrerBulle();
    vi.advanceTimersByTime(500);
    expect(b.etat.value).not.toBeNull();
    b.quitterBulle();
    vi.advanceTimersByTime(200);
    expect(b.etat.value).toBeNull();
    expect(p.hasAttribute("aria-describedby")).toBe(false);
  });

  it("passer d'une pastille à l'autre change de source sans attendre", () => {
    const b = creerBulle();
    const p1 = pastille();
    const p2 = pastille();
    b.survol(source(1), p1, () => undefined);
    vi.advanceTimersByTime(150);
    b.sortie();
    b.survol(source(2), p2, () => undefined);
    vi.advanceTimersByTime(1);
    expect(b.etat.value?.source.n).toBe(2);
    expect(p1.hasAttribute("aria-describedby")).toBe(false);
  });

  it("Échap ferme la bulle ; vrai seulement si elle était ouverte", () => {
    const b = creerBulle();
    expect(b.echap()).toBe(false);
    b.survol(source(1), pastille(), () => undefined);
    vi.advanceTimersByTime(150);
    expect(b.echap()).toBe(true);
    expect(b.etat.value).toBeNull();
  });

  it("garde le geste « Voir dans le document » de celui qui a posé la pastille", () => {
    const b = creerBulle();
    const voir = vi.fn();
    b.survol(source(1), pastille(), voir);
    vi.advanceTimersByTime(150);
    b.etat.value?.voir();
    expect(voir).toHaveBeenCalledOnce();
  });
});

describe("page qui bouge", () => {
  it("ferme une bulle ouverte depuis un moment, mais pas une ouverture en attente ni celle qui vient de s'ouvrir", () => {
    const b = creerBulle();
    const p = pastille();
    b.survol(source(1), p, () => undefined);
    b.pageBouge();
    vi.advanceTimersByTime(150);
    expect(b.etat.value).not.toBeNull();
    b.pageBouge();
    expect(b.etat.value).not.toBeNull();
    vi.advanceTimersByTime(500);
    b.pageBouge();
    expect(b.etat.value).toBeNull();
  });
});

describe("position", () => {
  const ancre = { gauche: 300, haut: 400, bas: 420, droite: 320 };

  it("sous la pastille, calée dans l'écran", () => {
    expect(positionBulle(ancre, 1440, 900)).toEqual({ left: "276px", top: "428px", width: "420px" });
    expect(positionBulle({ ...ancre, gauche: 1430 }, 1440, 900)).toMatchObject({ left: "1008px" });
    expect(positionBulle({ ...ancre, gauche: 2 }, 1440, 900)).toMatchObject({ left: "12px" });
  });

  it("au-dessus quand le bas manque de place", () => {
    expect(positionBulle({ gauche: 300, haut: 800, bas: 820, droite: 320 }, 1440, 900)).toEqual({
      left: "276px",
      bottom: "108px",
      width: "420px",
    });
  });

  it("écran étroit : la largeur suit l'écran", () => {
    expect(positionBulle(ancre, 360, 700)).toMatchObject({ width: "336px", left: "12px" });
  });
});
