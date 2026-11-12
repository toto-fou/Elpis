// SPDX-License-Identifier: MIT
/** frontend/test/chat/coeur/versement.test.ts — versement à débit constant : régularité et retard sur des flux réguliers, par salves et irréguliers, tranche bornée, paires de substitution, CRLF. */
import { describe, expect, it } from "vitest";

import {
  creerVersement,
  noterArrivee,
  reinitialiserVersement,
  tranche,
} from "../../../src/features/chat/coeur/versement";

const IMAGE = 1000 / 60;

type Arrivee = [number, number];

function arrivees(profil: string, dureeMs = 20000): Arrivee[] {
  const out: Arrivee[] = [];
  let t = 0;
  let graine = 12345;
  const alea = (): number => (graine = (graine * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  while (t < dureeMs) {
    if (profil === "regulier60") {
      out.push([t, 3 + (out.length % 3 === 0 ? 1 : 0)]);
      t += 1000 / 60;
    } else if (profil === "regulier150") {
      out.push([t, 3 + (out.length % 3 === 0 ? 1 : 0)]);
      t += 1000 / 150;
    } else if (profil === "salves250") {
      out.push([t, 50]);
      t += 250;
    } else if (profil === "irregulier") {
      const g = 20 + alea() * 280;
      out.push([t, Math.round(g * 0.2)]);
      t += g;
    } else {
      out.push([t, 4]);
      t += 125;
    }
  }
  return out;
}

interface Mesure {
  mises: [number, number, number][];
  retards: number[];
}

/** Rejoue des arrivées à 60 images par seconde : un `tranche` par image, comme le battement. */
function simuler(arr: Arrivee[], dureeMs: number): Mesure {
  const v = creerVersement();
  const mises: [number, number, number][] = [];
  const files: [number, number][] = [];
  let attente = "";
  let i = 0;
  let recu = 0;
  let montre = 0;
  for (let t = IMAGE; t < dureeMs + 2000; t += IMAGE) {
    while (i < arr.length && (arr[i]?.[0] ?? Infinity) <= t) {
      const [ta, n] = arr[i] as Arrivee;
      attente += "x".repeat(n);
      noterArrivee(v, ta, n);
      recu += n;
      files.push([ta, recu]);
      i++;
    }
    const prise = tranche(v, attente, t, IMAGE);
    expect(prise).toBeLessThanOrEqual(attente.length);
    if (prise > 0) {
      attente = attente.slice(prise);
      montre += prise;
      mises.push([t, prise, montre]);
    }
  }
  const vus = mises.filter((m) => m[0] >= 1500);
  const retards: number[] = [];
  let k = 0;
  for (const [ta, c] of files.filter((f) => f[0] >= 1500)) {
    while (k < vus.length && (vus[k]?.[2] ?? Infinity) < c) k++;
    const m = vus[k];
    if (m) retards.push(m[0] - ta);
  }
  retards.sort((a, b) => a - b);
  return { mises: vus, retards };
}

const quantile = (a: number[], p: number): number => a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
const ecartMax = (m: Mesure): number =>
  Math.max(...m.mises.slice(1).map((v, i) => v[0] - (m.mises[i]?.[0] ?? 0)));
const parSeconde = (m: Mesure): number =>
  m.mises.length / (((m.mises[m.mises.length - 1]?.[0] ?? 0) - (m.mises[0]?.[0] ?? 0)) / 1000);

describe("versement à débit constant", () => {
  it("flux régulier à 60 jetons/s : une mise à jour par image, retard d'une image au plus", () => {
    const m = simuler(arrivees("regulier60"), 20000);
    expect(parSeconde(m)).toBeGreaterThan(55);
    expect(Math.max(...m.mises.map((v) => v[1]))).toBeLessThanOrEqual(6);
    expect(quantile(m.retards, 0.5)).toBeLessThanOrEqual(IMAGE + 1);
    expect(quantile(m.retards, 0.95)).toBeLessThanOrEqual(IMAGE + 1);
  });

  it("flux régulier à 150 jetons/s : retard médian sous 20 ms, p95 sous 35 ms, au plus 12 caractères", () => {
    const m = simuler(arrivees("regulier150"), 20000);
    expect(parSeconde(m)).toBeGreaterThan(55);
    expect(Math.max(...m.mises.map((v) => v[1]))).toBeLessThanOrEqual(12);
    expect(quantile(m.retards, 0.5)).toBeLessThanOrEqual(20);
    expect(quantile(m.retards, 0.95)).toBeLessThanOrEqual(35);
  });

  it("salves de 50 caractères toutes les 250 ms : aucun trou de plus de deux images, au plus 6 caractères par image", () => {
    const m = simuler(arrivees("salves250"), 20000);
    expect(ecartMax(m)).toBeLessThanOrEqual(2 * IMAGE + 1);
    expect(Math.max(...m.mises.map((v) => v[1]))).toBeLessThanOrEqual(6);
    expect(parSeconde(m)).toBeGreaterThan(55);
    // Le retard vaut l'intervalle des salves, jamais davantage.
    expect(quantile(m.retards, 0.95)).toBeLessThanOrEqual(300);
  });

  it("flux irrégulier : trou borné, tranches modérées", () => {
    const m = simuler(arrivees("irregulier"), 20000);
    expect(Math.max(...m.mises.map((v) => v[1]))).toBeLessThanOrEqual(14);
    expect(quantile(m.retards, 0.95)).toBeLessThanOrEqual(300);
  });

  it("flux lent à 8 jetons/s : tout est versé peu après l'arrivée", () => {
    const m = simuler(arrivees("lent8"), 20000);
    expect(quantile(m.retards, 0.95)).toBeLessThanOrEqual(200);
  });

  it("après la dernière arrivée, le tampon est vidé en moins de deux intervalles", () => {
    const v = creerVersement();
    let attente = "";
    let t = 0;
    for (let k = 0; k < 20; k++) {
      t += 250;
      attente += "y".repeat(50);
      noterArrivee(v, t, 50);
      for (let j = 0; j < 15; j++) {
        t += IMAGE;
        attente = attente.slice(tranche(v, attente, t, IMAGE));
      }
    }
    const derniere = t;
    while (attente && t - derniere < 3000) {
      t += IMAGE;
      attente = attente.slice(tranche(v, attente, t, IMAGE));
    }
    expect(attente).toBe("");
    expect(t - derniere).toBeLessThanOrEqual(500);
  });

  it("les premières arrivées ne attendent pas d'estimation : au moins 3 caractères tout de suite", () => {
    const v = creerVersement();
    noterArrivee(v, 0, 10);
    expect(tranche(v, "abcdefghij", IMAGE, IMAGE)).toBeGreaterThanOrEqual(3);
  });

  it("une pause suivie d'une reprise ne verse pas la salve d'un coup : le temps compté est celui de l'image", () => {
    const v = creerVersement();
    let t = 0;
    for (let k = 0; k < 30; k++) {
      t += IMAGE;
      noterArrivee(v, t, 4);
      tranche(v, "abcd", t, IMAGE);
    }
    t += 2000;
    noterArrivee(v, t, 200);
    const prise = tranche(v, "z".repeat(200), t + IMAGE, IMAGE);
    expect(prise).toBeLessThan(40);
  });

  it("une pause de la source : au moins un caractère par image jusqu'au bout", () => {
    const v = creerVersement();
    let t = 0;
    for (let k = 0; k < 10; k++) {
      t += 250;
      noterArrivee(v, t, 50);
      tranche(v, "a".repeat(50), t, IMAGE);
    }
    t += 1000;
    expect(tranche(v, "abc", t, IMAGE)).toBeGreaterThanOrEqual(1);
  });

  it("jamais plus que ce qui attend, ni sur un tampon vide", () => {
    const v = creerVersement();
    expect(tranche(v, "", 10, IMAGE)).toBe(0);
    noterArrivee(v, 0, 2);
    expect(tranche(v, "ab", 1000, 100)).toBeLessThanOrEqual(2);
  });

  it("ne coupe pas une paire de substitution UTF-16", () => {
    const v = creerVersement();
    noterArrivee(v, 0, 3);
    const texte = "ab😀cd";
    // 3 caractères demandés : la coupe tomberait au milieu de l'émoji (deux unités après « ab »).
    const prise = tranche(v, texte, IMAGE, IMAGE);
    expect(texte.slice(0, prise)).not.toMatch(/[\ud800-\udbff]$/);
    expect(prise).toBe(4);
  });

  it("ne coupe pas entre CR et LF", () => {
    const v = creerVersement();
    noterArrivee(v, 0, 3);
    const prise = tranche(v, "ab\r\ncd", IMAGE, IMAGE);
    expect("ab\r\ncd".slice(0, prise)).not.toMatch(/\r$/);
  });

  it("des événements du même paquet réseau comptent pour une arrivée", () => {
    const groupee = creerVersement();
    for (let k = 0; k < 6; k++) noterArrivee(groupee, 100 + k * 0.2, 4);
    noterArrivee(groupee, 160, 4);
    tranche(groupee, "x", 200, IMAGE);
    // Un débit estimé de 4 caractères en une milliseconde ne doit pas s'installer.
    expect(groupee.debit).toBeLessThan(0.5);
  });

  it("la remise à zéro efface l'estimation", () => {
    const v = creerVersement();
    noterArrivee(v, 0, 10);
    noterArrivee(v, 20, 10);
    tranche(v, "x".repeat(10), 40, IMAGE);
    reinitialiserVersement(v);
    expect(v).toEqual(creerVersement());
  });
});
