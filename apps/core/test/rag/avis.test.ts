// SPDX-License-Identifier: MIT
/** apps/core/test/rag/avis.test.ts — suppression d'un compte auteur (SQLite et PostgreSQL) : chaque lecteur d'une collection publiée est prévenu, ni les comptes sans accès ni les collections privées. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteUserFull } from "../../src/comptes/suppression";
import { appliquerPublication } from "../../src/rag/acces";
import { CycleDeVie } from "../../src/cycle";
import { brancherIndexationRag, installerServiceIndexationRag } from "../../src/rag/service";
import { journalMuet } from "../aides";
import { creerCollection } from "./aides-indexation";
import { demarrerEnvironnement, MOTEURS, ouvrirBanc } from "./aides-routes";
import type { Banc, Environnement } from "./aides-routes";

let env: Environnement;

beforeAll(async () => {
  env = await demarrerEnvironnement();
});

afterAll(async () => {
  await env.arreter();
});

describe.each(MOTEURS)("avis aux lecteurs à la suppression de l'auteur (%s)", (moteur) => {
  let b: Banc;

  beforeEach(async () => {
    b = await ouvrirBanc(moteur, env);
    brancherIndexationRag("admin", b.base, new CycleDeVie(journalMuet));
    installerServiceIndexationRag(b.service);
  });

  afterEach(async () => {
    installerServiceIndexationRag(null);
    await b.fermer();
  });

  const notifications = (uid: number) =>
    b.base.all("SELECT kind, title, body FROM notifications WHERE owner_user_id=? ORDER BY id", [uid]);

  it("les membres des groupes accordés sont prévenus une fois par collection ; privée et tiers ignorés", async () => {
    const privee = await creerCollection(b.base, b.id.alice, "Brouillon");
    const g1 = await creerCollection(b.base, b.id.alice, "Contrats");
    const g2 = await creerCollection(b.base, b.id.alice, "Charte");
    await appliquerPublication(b.base, b.id.alice, g1, {
      visibility: "groups",
      group_ids: [b.groupe.A],
      allow_source_open: false,
    });
    await appliquerPublication(b.base, b.id.alice, g2, {
      visibility: "groups",
      group_ids: [b.groupe.A],
      allow_source_open: false,
    });
    expect(privee).not.toBe(g1);
    expect(await deleteUserFull(b.base, b.id.alice)).toBe(true);
    const chezBob = await notifications(b.id.bob);
    expect(chezBob.map((n) => [n["kind"], n["title"]]).sort()).toEqual([
      ["rag_share_end", "La collection Charte n'est plus disponible"],
      ["rag_share_end", "La collection Contrats n'est plus disponible"],
    ]);
    expect(await notifications(b.id.carol)).toEqual([]);
    expect(await notifications(b.id.dave)).toEqual([]);
  });

  it("publiée à tous les comptes : tous les autres comptes sont prévenus", async () => {
    const c = await creerCollection(b.base, b.id.admin, "Charte");
    await appliquerPublication(b.base, b.id.admin, c, {
      visibility: "all",
      group_ids: [],
      allow_source_open: false,
    });
    expect(await deleteUserFull(b.base, b.id.admin)).toBe(true);
    for (const uid of [b.id.alice, b.id.bob, b.id.carol, b.id.dave])
      expect(
        (await notifications(uid)).map((n) => n["kind"]),
        String(uid),
      ).toEqual(["rag_share_end"]);
  });

  it("aucune collection publiée : aucun avis", async () => {
    await creerCollection(b.base, b.id.alice, "Privée");
    expect(await deleteUserFull(b.base, b.id.alice)).toBe(true);
    expect(await b.base.all("SELECT id FROM notifications")).toEqual([]);
  });
});
