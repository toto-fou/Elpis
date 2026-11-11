// SPDX-License-Identifier: MIT
/** apps/toolhost/test/fichiers-entretien.test.ts — thread des remplacements par requête (expression coûteuse tuée à l'échéance, boucle de l'hôte et autres requêtes libres), texte d'un .docx, quota inconnu et balayage périodique des envois abandonnés. */
import { Journal } from "@elpis/http";
import { afterAll, describe, expect, it } from "vitest";

import { RAPPEL_ABSENT } from "../src/fichiers/commun";
import { boucleBalayage } from "../src/fichiers/entretien";
import { quotaMb } from "../src/fichiers/quota";
import {
  arreterFilsCalcul,
  avecFilCalcul,
  DelaiCalcul,
  SessionCalcul,
} from "../src/fichiers/calcul-execution";

const CATASTROPHE = { query: "(a+)+$", replacement: "x", regex: true, caseSensitive: true };
const SIMPLE = { query: "a", replacement: "b", regex: false, caseSensitive: true };
const TEXTE = Buffer.from("a".repeat(40) + "!");

afterAll(async () => {
  await arreterFilsCalcul();
});

describe("thread des remplacements", () => {
  it("aperçu d'un lot dans le thread de la requête : échantillons et nombre", async () => {
    const r = await avecFilCalcul((fil) =>
      fil.lot(
        { query: "o", replacement: "0", regex: false, caseSensitive: true },
        ["a.txt", "b.txt"],
        [Buffer.from("foo\nbar"), null],
        10,
        Date.now() + 10_000,
      ),
    );
    expect(r).toEqual([
      ["a.txt", { n: 2, echantillons: [[1, "foo", "f00"]] }],
      ["b.txt", null],
    ]);
  }, 30_000);

  it("expression catastrophique : seul le thread de sa requête est tué, la boucle et les autres requêtes continuent", async () => {
    let battements = 0;
    const minuterie = setInterval(() => (battements += 1), 50);
    const voisine = new SessionCalcul();
    const debut = Date.now();
    const [r, autre] = await Promise.all([
      avecFilCalcul((fil) => fil.lot(CATASTROPHE, ["a.txt"], [TEXTE], 10, Date.now() + 300)),
      voisine.un(SIMPLE, { kind: "file" }, Buffer.from("aa")),
    ]);
    clearInterval(minuterie);
    expect(r).toBeNull();
    expect(autre).toEqual({ n: 2, echantillons: [[1, "aa", "bb"]], nouveau: "bb" });
    expect(Date.now() - debut).toBeLessThan(10_000);
    expect(battements).toBeGreaterThan(5);
    await expect(
      avecFilCalcul((fil) => fil.un(CATASTROPHE, { kind: "file" }, TEXTE, 300)),
    ).rejects.toBeInstanceOf(DelaiCalcul);
    expect(await voisine.un(SIMPLE, { kind: "file" }, Buffer.from("aa"))).toEqual({
      n: 2,
      echantillons: [[1, "aa", "bb"]],
      nouveau: "bb",
    });
    await voisine.fermer();
  }, 30_000);
});

describe("texte d'un .docx dans le thread", () => {
  it("refus de python-docx rendu en 422, comme sur place", async () => {
    await expect(avecFilCalcul((fil) => fil.docx(Buffer.from("pas un zip")))).rejects.toMatchObject({
      statusCode: 422,
      detail: "Lecture .docx impossible : File is not a zip file",
    });
  }, 30_000);
});

describe("quota du compte", () => {
  it("surcharge inconnue (core injoignable) : 503 plutôt que le quota global", async () => {
    await expect(
      quotaMb({ ...RAPPEL_ABSENT, quotaCompte: () => Promise.resolve(undefined) }, 7),
    ).rejects.toMatchObject({
      statusCode: 503,
      detail: "Quota du compte indisponible (core injoignable)",
    });
    expect(await quotaMb({ ...RAPPEL_ABSENT, quotaCompte: () => Promise.resolve(250) }, 7)).toBe(250);
  });
});

describe("balayage des envois abandonnés", () => {
  it("un passage au démarrage, journal du nombre retiré, arrêt sur le signal ; une panne n'arrête pas la boucle", async () => {
    const lignes: string[] = [];
    const journal = new Journal({ niveau: "debug", sortie: (l) => lignes.push(l) });
    const arret = new AbortController();
    let appels = 0;
    const boucle = boucleBalayage(journal, arret.signal, async () => {
      appels += 1;
      return 3;
    });
    await new Promise((f) => setTimeout(f, 20));
    arret.abort();
    await boucle;
    expect(appels).toBe(1);
    expect(lignes.join("\n")).toContain("3 tmp d'upload abandonnés supprimés");
    const arret2 = new AbortController();
    const boucle2 = boucleBalayage(journal, arret2.signal, () => Promise.reject(new Error("docker absent")));
    await new Promise((f) => setTimeout(f, 20));
    arret2.abort();
    await boucle2;
    expect(lignes.join("\n")).toContain("balayage des tmp d'upload échoué : docker absent");
  });
});
