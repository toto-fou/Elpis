// SPDX-License-Identifier: MIT
/** frontend/test/admin/navigation-chargeurs.test.ts — chargeurs et flux des journaux selon page et onglet, avec un compte connu après l'ancre (câblage de racine.ts). */
import * as Vue from "vue";
import { ref } from "vue";
import { describe, expect, it, vi } from "vitest";

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
function monter(compte: Compte | null, vueOuverte = true, route?: (url: string) => Response | undefined) {
  const portee = Vue.effectScope();
  const urls: string[] = [];
  const flux: string[] = [];
  const histo: string[] = [];
  const toasts: string[] = [];
  const fetchFaux = (url: string): Promise<Response> => {
    urls.push(url);
    const propre = route?.(url);
    if (propre) return Promise.resolve(propre);
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

describe("pages de réglages : config.json et sondes", () => {
  it("config.json relu seulement s'il date de plus de 30 s ou vient d'être enregistré ; chaque sonde sur sa seule page", async () => {
    const contenu = JSON.stringify({
      voice: { stt: { endpoint_url: "http://stt" }, tts: { endpoint_url: "http://tts" } },
      image: { url: "http://img" },
    });
    const m = monter(ROOT, true, (url) =>
      url.startsWith("/api/admin/config-file") ? json({ content: contenu }) : undefined,
    );
    const aller = async (page: string): Promise<void> => {
      await m.A.goAdminPage(page);
      await attendre();
      await attendre();
    };
    try {
      await aller("instance");
      const formulaire = m.A.configForm.value;
      for (const page of ["https", "sessions", "rights", "instance"]) await aller(page);
      expect(compter(m.urls, "/api/admin/config-file")).toBe(1);
      expect(m.A.configForm.value).toBe(formulaire);
      expect(compter(m.urls, "/api/admin/security/https")).toBe(1);
      expect(compter(m.urls, "/api/admin/security/sessions")).toBe(1);
      expect(compter(m.urls, "/api/admin/voice/models") + compter(m.urls, "/api/admin/image/models")).toBe(0);

      await aller("voice");
      expect(compter(m.urls, "/api/admin/voice/models")).toBe(2);
      await aller("images");
      expect(compter(m.urls, "/api/admin/image/models")).toBe(1);

      await aller("instance");
      m.A.configForm.value!.app_info.name = "Autre nom";
      expect(await m.A.saveAdminPage()).toBe(true);
      await aller("https");
      expect(compter(m.urls, "/api/admin/config-file")).toBe(2);

      const maintenant = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(maintenant + 31_000);
      await aller("sessions");
      expect(compter(m.urls, "/api/admin/config-file")).toBe(3);
    } finally {
      vi.restoreAllMocks();
      m.arreter();
    }
  });

  it("une saisie faite pendant la relecture est gardée ; « Annuler » repart du fichier même inchangé", async () => {
    let rendre: ((r: Response) => void) | null = null;
    let lent = false;
    const contenu = JSON.stringify({ app_info: { name: "Elpis" } });
    const m = monter(ROOT, true, (url) => {
      if (!url.startsWith("/api/admin/config-file")) return undefined;
      if (!lent) return json({ content: contenu });
      return new Promise<Response>((r) => {
        rendre = r;
      }) as unknown as Response;
    });
    try {
      await m.A.goAdminPage("instance");
      await attendre();
      lent = true;
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31_000);
      await m.A.goAdminPage("https");
      await vi.waitFor(() => expect(rendre).not.toBeNull());
      m.A.configForm.value!.app_info.name = "Saisie";
      (rendre as unknown as (r: Response) => void)(
        json({ content: JSON.stringify({ app_info: { name: "Ailleurs" } }) }),
      );
      await attendre();
      await attendre();
      expect(m.A.configForm.value!.app_info.name).toBe("Saisie");
      lent = false;
      await m.A.goAdminPage("instance");
      await attendre();
      await m.A.discardAdminPage();
      expect(m.A.configForm.value!.app_info.name).toBe("Elpis");
      expect(m.A.adminDirtyCount.value).toBe(0);
    } finally {
      vi.restoreAllMocks();
      m.arreter();
    }
  });

  it("après un enregistrement, un fichier redevenu identique à la première lecture est relu et affiché ; un secret saisi est remasqué", async () => {
    let contenu = JSON.stringify({ app_info: { name: "Elpis" }, rag: { embed: { api_key: "********" } } });
    const m = monter(ROOT, true, (url) =>
      url.startsWith("/api/admin/config-file") ? json({ content: contenu }) : undefined,
    );
    const aller = async (page: string): Promise<void> => {
      await m.A.goAdminPage(page);
      await attendre();
      await attendre();
    };
    try {
      await aller("instance");
      m.A.configForm.value!.app_info.name = "Nouveau";
      expect(await m.A.saveAdminPage()).toBe(true);
      contenu = JSON.stringify({ app_info: { name: "Elpis" }, rag: { embed: { api_key: "********" } } });
      await aller("https");
      expect(compter(m.urls, "/api/admin/config-file")).toBe(2);
      expect(m.A.configForm.value!.app_info.name).toBe("Elpis");

      await aller("rag");
      m.A.configForm.value!.rag.embed.api_key = "cle-en-clair";
      expect(await m.A.saveAdminPage()).toBe(true);
      await aller("instance");
      expect(compter(m.urls, "/api/admin/config-file")).toBe(3);
      expect(m.A.configForm.value!.rag.embed.api_key).toBe("********");
    } finally {
      m.arreter();
    }
  });
});
