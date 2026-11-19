// SPDX-License-Identifier: MIT
/** frontend/test/admin/securite-rattachement.test.ts — l'assistant de rattachement ne rend jamais le geste facile par mégarde : une case par ligne, aucun « tout cocher », une confirmation distincte par administrateur, un second clic réfléchi. */
import { afterEach, describe, expect, it } from "vitest";

import { reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import { json } from "../aides";
import {
  LDAP,
  aMigrer,
  clic,
  demonter,
  el,
  etat,
  monter,
  proposition,
  tous,
  vider,
} from "./rattachement-aide";

afterEach(() => {
  demonter();
  reinitialiserSuiviChargement();
});

const MIG = "GET /api/admin/auth/providers/ipa/migration";
const LIEN = "POST /api/admin/auth/providers/ipa/migration/link";
const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const LIGNES = {
  items: [
    aMigrer(2, "alice", "user", proposition()),
    aMigrer(3, "bob", "user", proposition({ subject: "uid-2", ext_username: "bob" })),
    aMigrer(1, "root", "admin", proposition({ subject: "uid-r", ext_username: "root" })),
    aMigrer(4, "carole", "moderator", proposition({ subject: "uid-3", ext_username: "carole" })),
  ],
  total: 4,
  offset: 0,
  limit: 100,
};

async function ouvrir() {
  const m = monter(etat([{ ...LDAP, sweep: null }]));
  await m.A.loadEnterpriseAuth();
  await vider();
  m.reponses[MIG] = [json(LIGNES)];
  await clic("[data-rattacher]");
  return m;
}
const cases = (): HTMLInputElement[] => tous<HTMLInputElement>("[data-ratt-case]");
const cochees = (): boolean[] => cases().map((c) => c.checked);

describe("assistant de rattachement : pas de sélection en masse", () => {
  it("aucune case ni bouton « tout cocher » : une seule case par ligne", async () => {
    await ouvrir();
    const entete = el("[data-assistant-rattachement]");
    expect(cases()).toHaveLength(LIGNES.items.length);
    const option = ":not([data-ratt-garder-jetons])";
    expect(
      entete?.querySelectorAll(`header input${option}, footer input${option}, thead input`),
    ).toHaveLength(0);
    expect(entete?.querySelectorAll(`input[type="checkbox"]${option}`)).toHaveLength(LIGNES.items.length);
    const texte = (entete?.textContent ?? "").toLowerCase();
    for (const mot of ["tout cocher", "tout sélectionner", "sélectionner tout", "tout rattacher"])
      expect(texte).not.toContain(mot);
    expect(entete?.querySelector("[data-ratt-tout]")).toBeNull();
  });

  it("cocher une ligne ne coche aucune autre", async () => {
    await ouvrir();
    cases()[1]?.click();
    await vider();
    expect(cochees()).toEqual([false, true, false, false]);
  });

  it("aucun raccourci clavier ne coche tout", async () => {
    await ouvrir();
    const tiroir = el("[data-assistant-rattachement]");
    for (const cible of [tiroir, cases()[0], document.body]) {
      cible?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", ctrlKey: true, bubbles: true }));
      cible?.dispatchEvent(new KeyboardEvent("keydown", { key: "a", metaKey: true, bubbles: true }));
    }
    await vider();
    expect(cochees()).toEqual([false, false, false, false]);
    expect(el<HTMLButtonElement>("[data-ratt-valider]")?.disabled).toBe(true);
  });

  it("la sélection ne survit pas à un envoi : tout est décoché ensuite", async () => {
    const m = await ouvrir();
    cases()[0]?.click();
    cases()[1]?.click();
    await vider();
    el("[data-ratt-valider]")?.click();
    await vider();
    await attendre(450);
    m.reponses[LIEN] = [
      json({
        results: [
          { user_id: 2, subject: "uid-1", result: "entry_already_linked" },
          { user_id: 3, subject: "uid-2", result: "not_in_group" },
        ],
      }),
    ];
    el("[data-ratt-valider]")?.click();
    await vider();
    expect(cochees()).toEqual([false, false, false, false]);
  });
});

describe("assistant de rattachement : confirmation d'un administrateur", () => {
  it("la case de confirmation n'apparaît que pour un administrateur ou un modérateur coché, une par compte", async () => {
    await ouvrir();
    expect(tous("[data-ratt-admin]")).toHaveLength(0);
    cases()[0]?.click();
    await vider();
    expect(tous("[data-ratt-admin]")).toHaveLength(0);
    cases()[2]?.click();
    await vider();
    let admin = tous<HTMLInputElement>("[data-ratt-admin]");
    expect(admin).toHaveLength(1);
    expect(admin[0]?.closest("label")?.textContent).toContain(
      "Je confirme le rattachement de cet administrateur",
    );
    cases()[3]?.click();
    await vider();
    admin = tous<HTMLInputElement>("[data-ratt-admin]");
    expect(admin).toHaveLength(2);
    expect(admin[1]?.closest("label")?.textContent).toContain("Je confirme le rattachement de ce modérateur");
  });

  it("un modérateur coché mais non confirmé n'est ni compté ni envoyé", async () => {
    const m = await ouvrir();
    cases()[3]?.click();
    await vider();
    expect(el("[data-ratt-valider]")?.textContent?.trim()).toBe("Rattacher 0 compte");
    expect(el<HTMLButtonElement>("[data-ratt-valider]")?.disabled).toBe(true);
    el<HTMLInputElement>("[data-ratt-admin]")?.click();
    await vider();
    expect(el("[data-ratt-valider]")?.textContent?.trim()).toBe("Rattacher 1 compte");
    el("[data-ratt-valider]")?.click();
    await vider();
    await attendre(450);
    m.reponses[LIEN] = [json({ results: [] })];
    el("[data-ratt-valider]")?.click();
    await vider();
    expect(m.corps[LIEN]).toEqual([
      { links: [{ user_id: 4, subject: "uid-3" }], confirm_admins: [4], keep_tokens: false },
    ]);
  });

  it("un administrateur coché mais non confirmé n'est ni compté ni envoyé", async () => {
    const m = await ouvrir();
    cases()[0]?.click();
    cases()[2]?.click();
    await vider();
    expect(el("[data-ratt-valider]")?.textContent?.trim()).toBe("Rattacher 1 compte");
    el("[data-ratt-valider]")?.click();
    await vider();
    await attendre(450);
    m.reponses[LIEN] = [json({ results: [{ user_id: 2, subject: "uid-1", result: "linked" }] })];
    el("[data-ratt-valider]")?.click();
    await vider();
    expect(m.corps[LIEN]).toEqual([
      { links: [{ user_id: 2, subject: "uid-1" }], confirm_admins: [], keep_tokens: false },
    ]);
  });

  it("seuls les comptes privilégiés confirmés partent dans confirm_admins", async () => {
    const m = await ouvrir();
    cases()[0]?.click();
    cases()[2]?.click();
    cases()[3]?.click();
    await vider();
    for (const c of tous<HTMLInputElement>("[data-ratt-admin]")) c.click();
    await vider();
    expect(el("[data-ratt-valider]")?.textContent?.trim()).toBe("Rattacher 3 comptes");
    el("[data-ratt-valider]")?.click();
    await vider();
    await attendre(450);
    m.reponses[LIEN] = [json({ results: [] })];
    el("[data-ratt-valider]")?.click();
    await vider();
    expect(m.corps[LIEN]).toEqual([
      {
        links: [
          { user_id: 2, subject: "uid-1" },
          { user_id: 1, subject: "uid-r" },
          { user_id: 4, subject: "uid-3" },
        ],
        confirm_admins: [1, 4],
        keep_tokens: false,
      },
    ]);
  });

  it("décocher un administrateur retire sa confirmation", async () => {
    await ouvrir();
    cases()[2]?.click();
    await vider();
    el<HTMLInputElement>("[data-ratt-admin]")?.click();
    await vider();
    cases()[2]?.click();
    await vider();
    cases()[2]?.click();
    await vider();
    expect(el<HTMLInputElement>("[data-ratt-admin]")?.checked).toBe(false);
    expect(el("[data-ratt-valider]")?.textContent?.trim()).toBe("Rattacher 0 compte");
  });
});

describe("assistant de rattachement : second clic réfléchi", () => {
  it("le premier clic n'envoie rien, un double-clic ne vaut pas confirmation, changer la sélection désarme", async () => {
    const m = await ouvrir();
    cases()[0]?.click();
    await vider();
    const b = el<HTMLButtonElement>("[data-ratt-valider]");
    b?.click();
    b?.click();
    await vider();
    expect(m.appels.some((a) => a.includes("/migration/link"))).toBe(false);
    expect(el("[data-ratt-annuler]")).not.toBeNull();
    cases()[1]?.click();
    await vider();
    expect(el("[data-ratt-annuler]")).toBeNull();
    b?.click();
    await vider();
    await clic("[data-ratt-annuler]");
    expect(el("[data-ratt-annuler]")).toBeNull();
    expect(m.appels.some((a) => a.includes("/migration/link"))).toBe(false);
  });

  it("une entrée non active ou hors groupe ne peut pas être envoyée, même par un clic forcé", async () => {
    const m = monter(etat([{ ...LDAP, sweep: null }]));
    await m.A.loadEnterpriseAuth();
    await vider();
    m.reponses[MIG] = [
      json({
        items: [
          aMigrer(2, "alice", "user", proposition({ state: "verrouillee" })),
          aMigrer(3, "bob", "user", proposition({ subject: "u2", in_required_group: null })),
        ],
        total: 2,
        offset: 0,
        limit: 100,
      }),
    ];
    await clic("[data-rattacher]");
    for (const c of cases()) {
      c.disabled = false;
      c.click();
    }
    await vider();
    expect(el<HTMLButtonElement>("[data-ratt-valider]")?.disabled).toBe(true);
    el("[data-ratt-valider]")?.click();
    await vider();
    expect(m.appels.some((a) => a.includes("/migration/link"))).toBe(false);
  });
});
