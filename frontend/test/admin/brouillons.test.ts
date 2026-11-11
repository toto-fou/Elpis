// SPDX-License-Identifier: MIT
/** frontend/test/admin/brouillons.test.ts — saisies hors barre d'enregistrement : la sortie de page les signale, les enregistre ou les abandonne. */
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { setupAdmin } from "../../src/features/admin/console";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

function monter(choix: string | null) {
  const appels: string[] = [];
  const questions: string[] = [];
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => {
    appels.push((init?.method ?? "GET") + " " + url);
    return Promise.resolve(json({ has_key: true, stale: false }));
  };
  const refs: RefsAdmin = {
    user: ref({ id: 1, username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: () => undefined,
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(true),
    openChoice: (_t, texte) => {
      questions.push(texte);
      return Promise.resolve(choix);
    },
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  A.adminTab.value = "images";
  return { A, appels, questions };
}

describe("saisies hors barre", () => {
  it("sans saisie, la sortie est libre", async () => {
    const { A, questions } = monter("discard");
    expect(await A.adminConfirmLeave()).toBe(true);
    expect(questions).toEqual([]);
  });

  it("clé en cours de saisie : la sortie demande ; Rester la garde", async () => {
    const { A, questions } = monter(null);
    A.imageKey.value.draft = "sk-123";
    expect(await A.adminConfirmLeave()).toBe(false);
    expect(questions[0]).toContain("Clé du moteur d'images");
    expect(A.imageKey.value.draft).toBe("sk-123");
  });

  it("Ignorer abandonne la saisie ; Enregistrer l'envoie", async () => {
    const a = monter("discard");
    a.A.imageKey.value.draft = "sk-123";
    expect(await a.A.adminConfirmLeave()).toBe(true);
    expect(a.A.imageKey.value.draft).toBe("");
    const b = monter("save");
    b.A.imageKey.value.draft = "sk-456";
    expect(await b.A.adminConfirmLeave()).toBe(true);
    expect(b.appels).toContain("PUT /api/admin/image/key");
  });

  it("une saisie d'une autre page ne bloque pas celle-ci", async () => {
    const { A, questions } = monter("discard");
    A.imageKey.value.draft = "sk-123";
    A.adminTab.value = "instance";
    expect(await A.adminConfirmLeave()).toBe(true);
    expect(questions).toEqual([]);
  });
});

describe("révocation de toutes les sessions", () => {
  it("exige la saisie d'un mot", async () => {
    const mots: string[] = [];
    const appels: string[] = [];
    const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => {
      appels.push((init?.method ?? "GET") + " " + url);
      return Promise.resolve(json({}));
    };
    const ctx: CtxAdmin = {
      showToast: () => undefined,
      fetchAuth: (url, options) => fetchFaux(url, options),
      openConfirm: () => Promise.resolve(true),
      openChoice: () => Promise.resolve(null),
      openTypedConfirm: (_t, _x, mot) => {
        mots.push(mot);
        return Promise.resolve(false);
      },
      nextTick: () => Vue.nextTick(),
      loadPublicConfig: () => undefined,
      systemAlert: ref(""),
    };
    const refs: RefsAdmin = {
      user: ref({ id: 1, username: "root", role: "admin", is_admin: 1 }),
      isAdminView: ref(true),
    };
    const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
    await A.revokeAllSessions();
    expect(mots).toEqual(["REVOQUER"]);
    expect(appels.filter((a) => a.includes("revoke"))).toEqual([]);
  });
});
