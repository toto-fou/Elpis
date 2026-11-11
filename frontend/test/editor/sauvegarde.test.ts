// SPDX-License-Identifier: MIT
/** frontend/test/editor/sauvegarde.test.ts — service de sauvegarde : fichier d'origine, écritures sérialisées, aucune version ancienne n'écrase une plus récente. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ServiceSauvegarde } from "../../src/features/editor/sauvegarde";
import type { DepsSauvegarde, Instantane } from "../../src/features/editor/sauvegarde";

interface Attente {
  chemin: string;
  texte: string;
  rendre(ok: boolean): void;
}

function banc() {
  const contenus = new Map<string, Instantane>();
  const disque = new Map<string, string>();
  const attentes: Attente[] = [];
  const propres: [string, number][] = [];
  const deps: DepsSauvegarde = {
    lire: (c) => contenus.get(c) ?? null,
    ecrire: (chemin, texte) =>
      new Promise<boolean>((resolve) => {
        attentes.push({
          chemin,
          texte,
          rendre: (ok) => {
            if (ok) disque.set(chemin, texte);
            resolve(ok);
          },
        });
      }),
    enregistre: (c, v) => propres.push([c, v]),
  };
  const taper = (chemin: string, texte: string): void => {
    contenus.set(chemin, { texte, version: (contenus.get(chemin)?.version ?? 0) + 1 });
  };
  return { service: new ServiceSauvegarde(deps), contenus, disque, attentes, propres, taper };
}

describe("sauvegarde retardée", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("cible le fichier d'origine même après un changement d'onglet", async () => {
    const b = banc();
    b.taper("a.py", "A1");
    b.taper("b.py", "B1");
    b.service.planifier("gauche", "a.py", 30_000);
    vi.advanceTimersByTime(30_000);
    expect(b.attentes.map((a) => a.chemin)).toEqual(["a.py"]);
    b.attentes[0]?.rendre(true);
    await vi.runAllTimersAsync();
    expect(b.disque.get("a.py")).toBe("A1");
    expect(b.disque.has("b.py")).toBe(false);
  });

  it("vider sauve l'onglet quitté puis annule le retard", async () => {
    const b = banc();
    b.taper("a.py", "A1");
    b.service.planifier("gauche", "a.py", 60_000);
    const issue = b.service.vider("gauche");
    expect(b.service.cheminRetarde("gauche")).toBeNull();
    b.attentes[0]?.rendre(true);
    await expect(issue).resolves.toBe("enregistre");
    vi.advanceTimersByTime(60_000);
    expect(b.attentes).toHaveLength(1);
    expect(b.service.vider("gauche")).toBeNull();
  });

  it("une frappe reprogramme le retard (anti-rebond) et un délai nul n'en pose pas", () => {
    const b = banc();
    b.taper("a.py", "A1");
    b.service.planifier("gauche", "a.py", 30_000);
    vi.advanceTimersByTime(20_000);
    b.service.planifier("gauche", "a.py", 30_000);
    vi.advanceTimersByTime(20_000);
    expect(b.attentes).toHaveLength(0);
    b.service.planifier("gauche", "a.py", 0);
    vi.advanceTimersByTime(60_000);
    expect(b.attentes).toHaveLength(0);
  });

  it("les panneaux ont des retards indépendants", () => {
    const b = banc();
    b.taper("a.py", "A1");
    b.taper("b.py", "B1");
    b.service.planifier("gauche", "a.py", 30_000);
    b.service.planifier("droite", "b.py", 30_000);
    vi.advanceTimersByTime(30_000);
    expect(b.attentes.map((a) => a.chemin).sort()).toEqual(["a.py", "b.py"]);
  });
});

describe("écritures concurrentes", () => {
  it("une demande pendant une écriture repart après elle avec le contenu le plus récent", async () => {
    const b = banc();
    b.taper("a.py", "v1");
    const premiere = b.service.sauvegarder("a.py");
    b.taper("a.py", "v2");
    const deuxieme = b.service.sauvegarder("a.py");
    const troisieme = b.service.sauvegarder("a.py");
    expect(troisieme).toBe(deuxieme);
    expect(b.attentes).toHaveLength(1);
    b.attentes[0]?.rendre(true);
    await expect(premiere).resolves.toBe("enregistre");
    await Promise.resolve();
    expect(b.attentes[1]?.texte).toBe("v2");
    b.attentes[1]?.rendre(true);
    await expect(deuxieme).resolves.toBe("enregistre");
    expect(b.disque.get("a.py")).toBe("v2");
    expect(b.propres).toEqual([
      ["a.py", 1],
      ["a.py", 2],
    ]);
  });

  it("une sauvegarde retardée n'écrase pas une version plus récente déjà écrite", async () => {
    const b = banc();
    b.taper("a.py", "v1");
    b.taper("a.py", "v2");
    const p = b.service.sauvegarder("a.py");
    b.attentes[0]?.rendre(true);
    await p;
    b.contenus.set("a.py", { texte: "v1", version: 1 });
    await expect(b.service.sauvegarder("a.py")).resolves.toBe("a-jour");
    expect(b.attentes).toHaveLength(1);
    expect(b.disque.get("a.py")).toBe("v2");
  });

  it("un échec ne marque pas le fichier propre et laisse réessayer", async () => {
    const b = banc();
    b.taper("a.py", "v1");
    const p = b.service.sauvegarder("a.py");
    b.attentes[0]?.rendre(false);
    await expect(p).resolves.toBe("echec");
    expect(b.propres).toEqual([]);
    const q = b.service.sauvegarder("a.py");
    b.attentes[1]?.rendre(true);
    await expect(q).resolves.toBe("enregistre");
  });

  it("une écriture qui lève est rendue en échec", async () => {
    const service = new ServiceSauvegarde({
      lire: () => ({ texte: "x", version: 1 }),
      ecrire: () => Promise.reject(new Error("réseau")),
      enregistre: () => undefined,
    });
    await expect(service.sauvegarder("a.py")).resolves.toBe("echec");
  });

  it("fichier sans modèle : absent ; oublier rouvre l'écriture après un rechargement", async () => {
    const b = banc();
    await expect(b.service.sauvegarder("x.py")).resolves.toBe("absent");
    b.taper("a.py", "v1");
    const p = b.service.sauvegarder("a.py");
    b.attentes[0]?.rendre(true);
    await p;
    b.service.oublier("a.py");
    b.contenus.set("a.py", { texte: "rechargé", version: 1 });
    const q = b.service.sauvegarder("a.py");
    b.attentes[1]?.rendre(true);
    await expect(q).resolves.toBe("enregistre");
    expect(b.disque.get("a.py")).toBe("rechargé");
  });
});

describe("options et échéances", () => {
  it("un geste explicite en file l'emporte : silencieux ET, force OU, et n'est jamais sauté", async () => {
    const vues: { silencieux: boolean; force: boolean }[] = [];
    let rendre: (ok: boolean) => void = () => undefined;
    const service = new ServiceSauvegarde({
      lire: () => ({ texte: "x", version: 1 }),
      ecrire: (_c, _t, o) =>
        new Promise<boolean>((r) => {
          vues.push({ silencieux: o.silencieux, force: o.force });
          rendre = r;
        }),
      enregistre: () => undefined,
    });
    const premiere = service.sauvegarder("a.py");
    expect(service.enCours("a.py")).toBe(true);
    const deuxieme = service.sauvegarder("a.py", { silencieux: true, force: false });
    expect(service.sauvegarder("a.py", { silencieux: false, force: true })).toBe(deuxieme);
    rendre(true);
    await premiere;
    await Promise.resolve();
    rendre(true);
    await expect(deuxieme).resolves.toBe("enregistre");
    expect(vues).toEqual([
      { silencieux: true, force: false },
      { silencieux: false, force: true },
    ]);
    expect(service.enCours("a.py")).toBe(false);
  });

  it("l'échéance d'un retard passe par la garde de l'éditeur, avec le chemin d'origine", async () => {
    vi.useFakeTimers();
    try {
      const echeances: string[] = [];
      const service = new ServiceSauvegarde({
        lire: () => null,
        ecrire: () => Promise.resolve(true),
        enregistre: () => undefined,
        echeance: (c) => {
          echeances.push(c);
          return Promise.reject(new Error("refus"));
        },
      });
      service.planifier("gauche", "a.py", 1_000);
      service.planifier("droite", "b.py", 1_000);
      await expect(service.vider("droite")).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(echeances).toEqual(["b.py", "a.py"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("libération des retards", () => {
  it("annulerRetards : aucun retard ne tire après la libération de l'éditeur", async () => {
    vi.useFakeTimers();
    try {
      const ecrits: string[] = [];
      const s = new ServiceSauvegarde({
        lire: () => ({ texte: "x", version: 1 }),
        ecrire: (c) => {
          ecrits.push(c);
          return Promise.resolve(true);
        },
        enregistre: () => undefined,
      });
      s.planifier("left", "a.py", 1000);
      s.planifier("right", "b.py", 1000);
      s.annulerRetards();
      await vi.advanceTimersByTimeAsync(2000);
      expect(ecrits).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
