// SPDX-License-Identifier: MIT
/** frontend/test/admin/navigation-arbre.test.ts — navigation dépliée de la console : arbre, filtre, rôle, rail. */

import { createApp, defineComponent, h, nextTick, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import BarreLateraleConsole from "../../src/components/admin/BarreLateraleConsole.vue";
import { ARBRE_DEPLIE, filtrerArbre, groupeDeplie } from "../../src/features/admin/arbre";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";
import { NAV_ADMIN } from "../../src/features/admin/registre";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function monter(admin = true): { hote: HTMLElement; ouvertes: string[] } {
  const ouvertes: string[] = [];
  const tab = ref("images");
  const adm = {
    showSidebar: true,
    adminNav: NAV_ADMIN.entries,
    adminPage: NAV_ADMIN.pages["images"],
    get adminTab() {
      return tab.value;
    },
    adminIsAdmin: admin,
    overviewAttention: 0,
    settings: { assistant_name: "Elpis" },
    user: { username: "alice", role: "admin" },
    APP_SKINS: [],
    mainAppUrl: "/",
    adminMeOpen: false,
    goAdminPage: (id: string) => {
      ouvertes.push(id);
      return Promise.resolve(true);
    },
    goAdminEntry: () => undefined,
    openPalette: () => undefined,
  } as unknown as DomaineAdmin;
  const Racine = defineComponent({
    setup() {
      return () => h(BarreLateraleConsole);
    },
  });
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(Racine);
  app.provide(CLE_ADMIN, adm);
  app.mount(hote);
  return { hote, ouvertes };
}

describe("arbre déplié", () => {
  it("couvre chaque page du registre une seule fois", () => {
    const ids = ARBRE_DEPLIE.flatMap((g) => g.pages);
    expect([...ids].sort()).toEqual(Object.keys(NAV_ADMIN.pages).sort());
    expect(groupeDeplie("sandbox-agents")).toBe("Modèles & services");
    expect(groupeDeplie("https")).toBe("Utilisateurs & accès");
  });

  it("filtre par libellé de page ou de réglage, sans accent ni casse", () => {
    const labels = (q: string, admin = true) =>
      filtrerArbre(NAV_ADMIN.pages, admin, q).flatMap((g) => g.pagesVisibles.map((p) => p.id));
    expect(labels("EXECUTIONS")).toContain("activity");
    expect(labels("securite", false)).not.toContain("logs");
    expect(labels("securite", true)).toContain("logs");
    expect(labels("certificat")).toContain("images");
    expect(labels("zzzz")).toEqual([]);
    expect(labels("", false)).not.toContain("accounts");
    expect(labels("", true)).toContain("accounts");
  });

  it("onglet réservé aux admins dans une page staff : Sécurité des Journaux, et Journalisation du Système", () => {
    const ids = (admin: boolean) =>
      filtrerArbre(NAV_ADMIN.pages, admin, "").flatMap((g) => g.pagesVisibles.map((p) => p.id));
    expect(NAV_ADMIN.pages["logs"]?.role).toBe("staff");
    expect(NAV_ADMIN.roleDe("logs", "security")).toBe("admin");
    expect(NAV_ADMIN.roleDe("logs", "technical")).toBe("staff");
    expect(ids(false)).toContain("logs");
    expect(ids(false)).not.toContain("audit-logging");
    expect(ids(true)).toContain("audit-logging");
  });
});

describe("rail de la console", () => {
  it("tous les groupes dépliés et recherche qui filtre", async () => {
    const { hote, ouvertes } = monter();
    expect(hote.querySelector("[data-groupe='sandbox']")).not.toBeNull();
    expect(hote.querySelectorAll(".adm-nav__sub").length).toBe(Object.keys(NAV_ADMIN.pages).length - 1);
    const champ = hote.querySelector<HTMLInputElement>("[data-recherche-pages]");
    champ!.value = "voix";
    champ!.dispatchEvent(new Event("input"));
    await nextTick();
    expect([...hote.querySelectorAll(".adm-nav__sub")].map((b) => b.textContent?.trim())).toEqual(["Voix"]);
    champ!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(ouvertes).toEqual(["voice"]);
  });

  it("aucun résultat : message et aucune page", async () => {
    const { hote } = monter();
    const champ = hote.querySelector<HTMLInputElement>("[data-recherche-pages]");
    champ!.value = "zzzz";
    champ!.dispatchEvent(new Event("input"));
    await nextTick();
    expect(hote.querySelector(".adm-nav-arbre__vide")?.textContent).toContain("Aucune page");
  });
});
