// SPDX-License-Identifier: MIT
/** apps/core/test/balayage-annuaire-planification.test.ts — balayage périodique : main seulement, première passe 2 minutes après le démarrage puis toutes les 15 minutes, arrêt propre, une erreur ne l'arrête pas (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { dependancesParDefaut } from "@elpis/auth";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CycleDeVie } from "../src/cycle";
import { etatBalayage } from "../src/identite/annuaire/balayage";
import type { DependancesBalayage } from "../src/identite/annuaire/balayage";
import {
  brancherBalayageAnnuaire,
  INTERVALLE_BALAYAGE_MS,
  PREMIERE_PASSE_MS,
} from "../src/ops/balayage-annuaire";
import { journalMuet } from "./aides";
import { AnnuaireFactice } from "./identite/annuaire/annuaire-factice";
import { ouvrirBancAnnuaire } from "./identite/annuaire/banc-annuaire";
import type { BancAnnuaire } from "./identite/annuaire/banc-annuaire";
import { MOTEURS } from "./identite/banc";

describe("délais du balayage", () => {
  it("première passe 2 minutes après le démarrage, puis toutes les 15 minutes", () => {
    expect(PREMIERE_PASSE_MS).toBe(120_000);
    expect(INTERVALLE_BALAYAGE_MS).toBe(900_000);
  });
});

describe.each(MOTEURS)("balayage planifié (%s)", (moteur) => {
  let b: BancAnnuaire;
  let annuaire: AnnuaireFactice;
  let verrous: string;
  const dep = (): DependancesBalayage => ({
    base: b.t.base,
    fabrique: annuaire.fabrique,
    maintenant: () => b.horloge,
    cookieSecure: () => true,
    journal: journalMuet,
    cheminVerrou: (id) => join(verrous, `${id}.lock`),
    etat: {
      base: b.t.base,
      acces: dependancesParDefaut(b.t.base),
      maintenant: () => b.horloge,
      publierSuspension: async () => true,
      journal: journalMuet,
    },
  });

  beforeEach(async () => {
    annuaire = new AnnuaireFactice();
    b = await ouvrirBancAnnuaire(moteur, [{}], annuaire);
    verrous = mkdtempSync(join(tmpdir(), "elpis-verrous-plan-"));
  });
  afterEach(async () => {
    rmSync(verrous, { recursive: true, force: true });
    await b.fermer();
  });

  it("main : une passe après chaque attente, délais 2 min puis 15 min, arrêt au signal", async () => {
    const cycle = new CycleDeVie(journalMuet);
    const delais: number[] = [];
    let fini: () => void = () => undefined;
    const troisAttentes = new Promise<void>((ok) => (fini = ok));
    const dormir = vi.fn(async (ms: number) => {
      delais.push(ms);
      if (delais.length === 1) expect(await etatBalayage(b.t.base, "annuaire")).toBeNull();
      if (delais.length === 2) expect(await etatBalayage(b.t.base, "annuaire")).not.toBeNull();
      if (delais.length >= 3) fini();
    });
    brancherBalayageAnnuaire("main", cycle, dep(), { dormir });
    await cycle.demarrer("main");
    await troisAttentes;
    cycle.annoncerArret();
    await cycle.executerArrets();
    expect(delais.slice(0, 3)).toEqual([120_000, 900_000, 900_000]);
  });

  it("admin : rien n'est planifié", async () => {
    const cycle = new CycleDeVie(journalMuet);
    const dormir = vi.fn(async () => undefined);
    brancherBalayageAnnuaire("admin", cycle, dep(), { dormir });
    await cycle.demarrer("admin");
    await cycle.demarrer("main");
    expect(dormir).not.toHaveBeenCalled();
  });

  it("une erreur de passe est journalisée sans arrêter la suite", async () => {
    const cycle = new CycleDeVie(journalMuet);
    let fini: () => void = () => undefined;
    const deux = new Promise<void>((ok) => (fini = ok));
    let n = 0;
    const dormir = vi.fn(async () => {
      if (++n >= 3) fini();
    });
    const casse = { ...dep(), fabrique: () => Promise.reject(new Error("panne")) };
    brancherBalayageAnnuaire("main", cycle, casse, { dormir });
    await cycle.demarrer("main");
    await deux;
    cycle.annoncerArret();
    await cycle.executerArrets();
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
