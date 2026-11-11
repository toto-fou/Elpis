// SPDX-License-Identifier: MIT
/** apps/core/test/affichage-chat.test.ts — préférences d'affichage du chat (déroulé, contexte, réflexions, métriques, densité) et `hide_web_screenshots` : liste blanche, valeurs fermées, absentes par défaut, hors console. */
import { createUser, getUserSettings } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADMIN_PORT_SETTINGS,
  CHOIX_AFFICHAGE,
  ecrireReglages,
  USER_SETTINGS_ALLOWED,
} from "../src/comptes/reglages";
import { journalMuet } from "./aides";

let t: BaseDeTest;
let alice: number;
let bob: number;

beforeAll(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  alice = await createUser(t.base, "alice", "motdepasse-alice");
  bob = await createUser(t.base, "bob", "motdepasse-bob");
});
afterAll(async () => {
  await t.fermer();
});

describe("préférences d'affichage du chat", () => {
  it("préférences du compte, pas de la console", () => {
    expect(Object.keys(CHOIX_AFFICHAGE)).toEqual([
      "chat_workflow",
      "context_display",
      "thinking_display",
      "footer_metrics",
      "thread_density",
      "editor_ui",
    ]);
    for (const cle of Object.keys(CHOIX_AFFICHAGE)) {
      expect(USER_SETTINGS_ALLOWED.has(cle)).toBe(true);
      expect(ADMIN_PORT_SETTINGS.has(cle)).toBe(false);
    }
  });

  it("absentes tant que le compte ne les a pas choisies", async () => {
    const s = await getUserSettings(t.base, alice);
    for (const cle of Object.keys(CHOIX_AFFICHAGE)) expect(s).not.toHaveProperty(cle);
  });

  it("chaque valeur permise s'enregistre", async () => {
    for (const [cle, valeurs] of Object.entries(CHOIX_AFFICHAGE))
      for (const v of valeurs) {
        await ecrireReglages(t.base, alice, { [cle]: v }, "main", journalMuet);
        expect((await getUserSettings(t.base, alice))[cle]).toBe(v);
      }
  });

  it("une valeur hors liste n'est pas écrite et garde la précédente, sans bloquer les autres clés", async () => {
    await ecrireReglages(t.base, bob, { chat_workflow: "terminal" }, "main", journalMuet);
    for (const v of ["Terminal", "autre", 1, true, null, ["terminal"]])
      await ecrireReglages(t.base, bob, { chat_workflow: v, thread_density: "compact" }, "main", journalMuet);
    const s = await getUserSettings(t.base, bob);
    expect(s).toMatchObject({ chat_workflow: "terminal", thread_density: "compact" });
    await ecrireReglages(t.base, bob, { context_display: "barre" }, "main", journalMuet);
    expect(await getUserSettings(t.base, bob)).not.toHaveProperty("context_display");
  });
});

describe("préférence hide_web_screenshots", () => {
  it("booléen strict du compte, absent par défaut, hors console", async () => {
    expect(USER_SETTINGS_ALLOWED.has("hide_web_screenshots")).toBe(true);
    expect(ADMIN_PORT_SETTINGS.has("hide_web_screenshots")).toBe(false);
    expect(await getUserSettings(t.base, alice)).not.toHaveProperty("hide_web_screenshots");
    await ecrireReglages(t.base, alice, { hide_web_screenshots: "oui" }, "main", journalMuet);
    expect((await getUserSettings(t.base, alice))["hide_web_screenshots"]).toBe(true);
    await ecrireReglages(t.base, alice, { hide_web_screenshots: 0 }, "main", journalMuet);
    expect((await getUserSettings(t.base, alice))["hide_web_screenshots"]).toBe(false);
  });
});

describe("ancienne préférence classic_ui", () => {
  it("n'est plus une préférence du compte et n'est pas écrite", async () => {
    expect(USER_SETTINGS_ALLOWED.has("classic_ui")).toBe(false);
    expect(ADMIN_PORT_SETTINGS.has("classic_ui")).toBe(false);
    await ecrireReglages(t.base, alice, { classic_ui: true }, "main", journalMuet);
    expect(await getUserSettings(t.base, alice)).not.toHaveProperty("classic_ui");
  });
});
