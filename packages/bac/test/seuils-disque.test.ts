// SPDX-License-Identifier: MIT
/** packages/bac/test/seuils-disque.test.ts — seuils de remplissage du bac (harnais N-08, propres au TS) : défauts 85/97, bornes, alerte sous le refus, relecture à chaud de config.json. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { HttpError } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { assainirSeuilsDisque, DEFAUTS_DISQUE, seuilsDisque, seuilsDisqueDepuis } from "../src";

let dossier = "";
let restaurer: () => void = () => undefined;

beforeEach(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-seuils-disque-"));
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: path.join(dossier, "config.json") });
});

afterEach(() => {
  restaurer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("seuils de remplissage du bac (harnais N-08)", () => {
  it("défauts : alerte à 85 %, refus à 97 %", () => {
    expect(DEFAUTS_DISQUE).toEqual({ warn_pct: 85, refuse_pct: 97 });
    expect(seuilsDisque()).toEqual(DEFAUTS_DISQUE);
  });

  it("console : entiers bornés, clé absente au défaut, alerte strictement sous le refus ; sinon 400", () => {
    expect(assainirSeuilsDisque({ warn_pct: 50, refuse_pct: 60 })).toEqual({ warn_pct: 50, refuse_pct: 60 });
    expect(assainirSeuilsDisque({ warn_pct: "70" })).toEqual({ warn_pct: 70, refuse_pct: 97 });
    expect(assainirSeuilsDisque({})).toEqual(DEFAUTS_DISQUE);
    for (const [brut, motif] of [
      [null, /objet/u],
      [{ warn_pct: "x" }, /warn_pct doit être un entier/u],
      [{ warn_pct: 9 }, /warn_pct doit être entre 10 et 99/u],
      [{ refuse_pct: 101 }, /refuse_pct doit être entre 11 et 100/u],
      [{ warn_pct: 90, refuse_pct: 90 }, /inférieur/u],
      [{ warn_pct: 98 }, /inférieur/u],
    ] as const) {
      let e: unknown = null;
      try {
        assainirSeuilsDisque(brut);
      } catch (x) {
        e = x;
      }
      expect(e, JSON.stringify(brut)).toBeInstanceOf(HttpError);
      expect((e as HttpError).statusCode).toBe(400);
      expect(String((e as Error).message)).toMatch(motif);
    }
  });

  it("valeurs effectives : clé illisible ou hors bornes à son défaut, alerte au niveau du refus → défauts", () => {
    expect(seuilsDisqueDepuis(undefined)).toEqual(DEFAUTS_DISQUE);
    expect(seuilsDisqueDepuis({ warn_pct: "x", refuse_pct: 99 })).toEqual({ warn_pct: 85, refuse_pct: 99 });
    expect(seuilsDisqueDepuis({ warn_pct: 5, refuse_pct: 300 })).toEqual(DEFAUTS_DISQUE);
    expect(seuilsDisqueDepuis({ warn_pct: 98 })).toEqual(DEFAUTS_DISQUE);
  });

  it("config.json relu à chaud : executors.disk modifié, seuils suivants sans redémarrage", () => {
    const fichier = path.join(dossier, "config.json");
    writeFileSync(fichier, JSON.stringify({ executors: { disk: { warn_pct: 50, refuse_pct: 60 } } }));
    expect(seuilsDisque()).toEqual({ warn_pct: 50, refuse_pct: 60 });
    writeFileSync(fichier, JSON.stringify({ executors: { disk: { warn_pct: 40, refuse_pct: 95 }, x: 1 } }));
    expect(seuilsDisque()).toEqual({ warn_pct: 40, refuse_pct: 95 });
    writeFileSync(fichier, "{illisible");
    expect(seuilsDisque()).toEqual(DEFAUTS_DISQUE);
  });
});
