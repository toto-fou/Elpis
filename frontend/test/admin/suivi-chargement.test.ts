// SPDX-License-Identifier: MIT
/** frontend/test/admin/suivi-chargement.test.ts — un chargeur en échec est signalé (jamais lu comme « vide »), avec fraîcheur et nouvel essai. */
import * as Vue from "vue";
import { ref } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import { setupAdmin } from "../../src/features/admin/console";
import {
  chargementDe,
  chargementEchoue,
  chargementReussi,
  reinitialiserSuiviChargement,
  suivreChargement,
} from "../../src/features/admin/suivi-chargement";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

afterEach(reinitialiserSuiviChargement);

describe("suivi des chargeurs", () => {
  it("échec puis succès : la bannière disparaît", async () => {
    expect(
      await suivreChargement(
        "x",
        () => Promise.resolve(false),
        () => undefined,
      ),
    ).toBe(false);
    expect(chargementDe(["x"]).echecs).toHaveLength(1);
    expect(chargementDe(["x"]).fraicheur).toBeNull();
    expect(
      await suivreChargement(
        "x",
        () => Promise.resolve(true),
        () => undefined,
      ),
    ).toBe(true);
    expect(chargementDe(["x"]).echecs).toHaveLength(0);
  });

  it("exception = échec ; fraîcheur = dernier succès conservé", async () => {
    chargementReussi("y");
    await suivreChargement(
      "y",
      () => Promise.reject(new Error("délai")),
      () => undefined,
    );
    const c = chargementDe(["y", "z"]);
    expect(c.echecs[0]?.message).toBe("délai");
    expect(c.fraicheur).not.toBeNull();
    chargementEchoue("z", "m", () => undefined);
    expect(chargementDe(["y", "z"]).fraicheur).toBeNull();
  });
});

describe("liste des comptes", () => {
  function monter(reponse: () => Response) {
    const fetchFaux = (): Promise<Response> => Promise.resolve(reponse());
    const refs: RefsAdmin = {
      user: ref({ id: 1, username: "root", role: "admin", is_admin: 1 }),
      isAdminView: ref(true),
    };
    const ctx: CtxAdmin = {
      showToast: () => undefined,
      fetchAuth: () => fetchFaux(),
      openConfirm: () => Promise.resolve(true),
      openChoice: () => Promise.resolve("save"),
      nextTick: () => Vue.nextTick(),
      loadPublicConfig: () => undefined,
      systemAlert: ref(""),
    };
    return setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  }

  it("un 500 donne « Chargement impossible » sur la page Comptes, puis Réessayer recharge", async () => {
    let etat = 500;
    const A = monter(() =>
      etat === 200
        ? json({ users: [], network_profiles: [], desktop_targets: [] })
        : json({ detail: "boum" }, 500),
    );
    A.adminTab.value = "accounts";
    await A.loadUsers();
    expect(A.chargementPage.value.echecs.map((e) => e.nom)).toContain("loadUsers");
    etat = 200;
    A.reessayerChargement();
    await new Promise((r) => setTimeout(r, 10));
    expect(A.chargementPage.value.echecs.map((e) => e.nom)).not.toContain("loadUsers");
  });
});
