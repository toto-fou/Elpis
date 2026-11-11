// SPDX-License-Identifier: MIT
/** frontend/test/admin/navigation-chargeurs.test.ts — chargeurs et flux des journaux selon page et onglet, avec un compte connu après l'ancre (câblage de racine.ts). */
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it } from "vitest";

import { filtrerArbre } from "../../src/features/admin/arbre";
import { setupAdmin } from "../../src/features/admin/console";
import { suivreChargementConsole } from "../../src/features/admin/chargeurs-page";
import { NAV_ADMIN } from "../../src/features/admin/registre";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

type Compte = { username: string; role: string; is_admin: number };
const MODO: Compte = { username: "mo", role: "moderator", is_admin: 2 };
const ROOT: Compte = { username: "root", role: "admin", is_admin: 1 };
const attendre = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

const liberations: (() => void)[] = [];
const vueDeTest = { ...Vue, onUnmounted: (f: () => void) => void liberations.push(f) } as typeof Vue;

/** Console montée dans une portée arrêtée à la fin, avec le vrai observateur de chargement de racine.ts. */
function monter(compte: Compte | null, vueOuverte = true) {
  const portee = Vue.effectScope();
  const urls: string[] = [];
  const flux: string[] = [];
  const histo: string[] = [];
  const toasts: string[] = [];
  const fetchFaux = (url: string): Promise<Response> => {
    urls.push(url);
    if (url.startsWith("/api/admin/audit/events"))
      return Promise.resolve(
        json({
          events: [],
          cursor: null,
          scanned_bytes: 0,
          budget_reached: false,
          unreadable: 0,
          last_ts: null,
        }),
      );
    return Promise.resolve(json({}));
  };
  const user = ref<Compte | null>(compte);
  const isAdminView = ref(vueOuverte);
  const refs = { user, isAdminView } as unknown as RefsAdmin;
  const ctx = {
    showToast: (m: string) => void toasts.push(m),
    fetchAuth: (url: string) => fetchFaux(url),
    openConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
    creerSourceJournal: (url: string) => {
      flux.push("open:" + url);
      return { close: () => flux.push("close"), readyState: 0 } as never;
    },
  } as unknown as CtxAdmin;
  const push = history.pushState.bind(history);
  const remplace = history.replaceState.bind(history);
  history.pushState = (d, t, u) => {
    histo.push("push " + String(u));
    push(d, t, u);
  };
  history.replaceState = (d, t, u) => {
    histo.push("replace " + String(u));
    remplace(d, t, u);
  };
  const A = portee.run(() => {
    const surface = setupAdmin(vueDeTest, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
    suivreChargementConsole(
      isAdminView,
      () => surface,
      () => [surface],
    );
    return surface;
  })!;
  return {
    A,
    urls,
    flux,
    histo,
    toasts,
    user,
    isAdminView,
    arreter: () => {
      portee.stop();
      for (const f of liberations.splice(0)) f();
      history.pushState = push;
      history.replaceState = remplace;
    },
  };
}

const compter = (urls: string[], prefixe: string): number => urls.filter((u) => u.startsWith(prefixe)).length;

describe("arrivée avant l'authentification (checkAuth : compte puis console ouverte dans le même tour)", () => {
  const fenetre = window as unknown as { __ADMIN_ONLY_MODE__?: boolean };

  for (const ancre of ["#logs/security", "#audit"]) {
    it(`admin sur ${ancre} : ancre gardée, aucune entrée d'historique, une seule recherche`, async () => {
      fenetre.__ADMIN_ONLY_MODE__ = true;
      location.hash = ancre;
      const m = monter(null, false);
      try {
        expect(location.hash).toBe(ancre);
        m.user.value = ROOT;
        m.isAdminView.value = true;
        await attendre();
        await attendre();
        expect([m.A.adminTab.value, m.A.adminOngletCourant.value]).toEqual(["logs", "security"]);
        expect(location.hash).toBe("#logs/security");
        expect(m.histo.filter((h) => h.startsWith("push"))).toEqual([]);
        expect(compter(m.urls, "/api/admin/audit/events")).toBe(1);
        expect(compter(m.urls, "/api/admin/audit/status")).toBe(1);
        expect(m.flux.filter((f) => f.startsWith("open:"))).toEqual([]);
      } finally {
        fenetre.__ADMIN_ONLY_MODE__ = false;
        m.arreter();
        location.hash = "";
      }
    });

    it(`modérateur sur ${ancre} : Technique, avertissement, aucune requête d'audit, flux ouvert`, async () => {
      fenetre.__ADMIN_ONLY_MODE__ = true;
      location.hash = ancre;
      const m = monter(null, false);
      try {
        m.user.value = MODO;
        m.isAdminView.value = true;
        await attendre();
        await attendre();
        expect([m.A.adminTab.value, m.A.adminOngletCourant.value]).toEqual(["logs", "technical"]);
        expect(location.hash).toBe("#logs/technical");
        expect(m.toasts).toHaveLength(1);
        expect(m.histo.filter((h) => h.startsWith("push"))).toEqual([]);
        expect(compter(m.urls, "/api/admin/audit")).toBe(0);
        expect(m.flux.filter((f) => f.startsWith("open:"))).toHaveLength(1);
      } finally {
        fenetre.__ADMIN_ONLY_MODE__ = false;
        m.arreter();
        location.hash = "";
      }
    });
  }

  it("session expirée puis même admin reconnecté : l'onglet demandé est gardé, sans entrée d'historique", async () => {
    fenetre.__ADMIN_ONLY_MODE__ = true;
    location.hash = "#logs/security";
    const m = monter(ROOT, true);
    try {
      await attendre();
      m.user.value = null;
      await attendre();
      m.user.value = ROOT;
      await attendre();
      expect(m.A.adminOngletCourant.value).toBe("security");
      expect(location.hash).toBe("#logs/security");
      expect(m.histo.filter((h) => h.startsWith("push"))).toEqual([]);
    } finally {
      fenetre.__ADMIN_ONLY_MODE__ = false;
      m.arreter();
      location.hash = "";
    }
  });
});

describe("chargeurs par onglet", () => {
  it("chaque changement d'onglet lance une fois les seuls chargeurs de l'onglet ; le flux suit logs/technical", async () => {
    const m = monter(ROOT);
    try {
      await m.A.goAdminPage("logs", "technical");
      await attendre();
      expect(m.flux).toEqual([expect.stringContaining("open:")]);
      await m.A.goAdminOnglet("logs", "security");
      await attendre();
      expect(compter(m.urls, "/api/admin/audit/events")).toBe(1);
      expect(m.flux).toEqual([expect.stringContaining("open:"), "close"]);
      await m.A.goAdminOnglet("logs", "technical");
      await attendre();
      expect(m.flux.filter((f) => f.startsWith("open:"))).toHaveLength(2);
      await m.A.goAdminPage("activity", "tool-calls");
      await attendre();
      expect(m.flux.at(-1)).toBe("close");
      const avant = m.urls.length;
      await m.A.goAdminPage("activity", "tool-calls");
      await attendre();
      expect(m.urls.length).toBe(avant);
    } finally {
      m.arreter();
    }
  });
});

describe("registre et arbre : invariants", () => {
  it("clés du prototype : aucune page, aucune erreur", () => {
    for (const cle of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(NAV_ADMIN.resolveLien(cle)).toBeNull();
      expect(NAV_ADMIN.resolveLien(cle + "/x")).toBeNull();
      expect(NAV_ADMIN.roleDe(cle, "x")).toBe("staff");
    }
  });

  it("une page à onglets ne déclare aucun `stores` (le changement d'onglet ne confirme aucun brouillon)", () => {
    for (const p of Object.values(NAV_ADMIN.pages)) {
      if (p.onglets.length) expect(p.stores, p.id).toEqual([]);
    }
  });

  it("recherche de l'arbre : un libellé d'onglet désigne cet onglet, un libellé de page non", () => {
    const g = filtrerArbre(NAV_ADMIN.pages, true, "securite").find((x) =>
      x.pagesVisibles.some((p) => p.id === "logs"),
    );
    expect(g?.ongletTrouve["logs"]).toBe("security");
    const h = filtrerArbre(NAV_ADMIN.pages, true, "journaux").find((x) =>
      x.pagesVisibles.some((p) => p.id === "logs"),
    );
    expect(h?.ongletTrouve["logs"]).toBeUndefined();
  });
});
