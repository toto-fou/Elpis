// SPDX-License-Identifier: MIT
/** frontend/test/admin/comptes.test.ts — console › Comptes : tri par colonne, filtres, sélection, actions groupées (groupe, mot de passe, suppression par saisie du mot). */
import type { CompteConsole } from "@elpis/contracts";
import * as Vue from "vue";
import { createApp, h, nextTick, proxyRefs, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import PageComptes from "../../src/components/admin/PageComptes.vue";
import { setupAdmin } from "../../src/features/admin/console";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

const compte = (id: number, nom: string, extra: Partial<CompteConsole> = {}): CompteConsole =>
  ({
    id,
    username: nom,
    is_admin: 0,
    group_ids: [],
    group_names: "",
    sandbox_used_mb: 0,
    sandbox_quota_mb: 0,
    llm_effective_engine_keys: [],
    llm_effective_can_manage_models: true,
    ...extra,
  }) as unknown as CompteConsole;

function monter(opts: { typed?: boolean } = {}) {
  const appels: { url: string; methode: string; corps: unknown }[] = [];
  const mots: string[] = [];
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => {
    appels.push({
      url,
      methode: init?.method ?? "GET",
      corps: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Promise.resolve(
      json({ ok: true, users: [], groups: [], network_profiles: [], desktop_targets: [] }),
    );
  };
  const refs: RefsAdmin = {
    user: ref({ id: 1, username: "root", role: "admin", is_admin: 1 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: () => undefined,
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(false),
    openChoice: () => Promise.resolve("save"),
    ...(opts.typed === false
      ? {}
      : {
          openTypedConfirm: (_t: string, _x: string, mot: string) => {
            mots.push(mot);
            return Promise.resolve(true);
          },
        }),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  A.usersList.value = [
    compte(1, "root", { is_admin: 1, group_ids: [], group_names: "" }),
    compte(2, "alice", { group_ids: [10], group_names: "dev", sandbox_used_mb: 90, sandbox_quota_mb: 100 }),
    compte(3, "bob", { llm_effective_engine_keys: ["a", "b"] }),
    compte(4, "carole", { group_ids: [10, 11], group_names: "dev, design" }),
  ];
  return { A, appels, mots, refs };
}

const noms = (A: ReturnType<typeof monter>["A"]) => A.filteredSortedUsers.value.map((u) => u.username);

describe("tri et filtres", () => {
  it("trie chaque colonne, dans les deux sens", () => {
    const { A } = monter();
    A.toggleUsersSort("sandbox");
    expect(noms(A)[3]).toBe("alice");
    A.toggleUsersSort("sandbox");
    expect(noms(A)[0]).toBe("alice");
    A.toggleUsersSort("servers");
    expect(noms(A).slice(0, 2)).toEqual(["alice", "carole"]);
    A.toggleUsersSort("role");
    expect(noms(A)[0]).toBe("root");
    A.toggleUsersSort("group_names");
    expect(noms(A).slice(0, 2)).toEqual(["root", "bob"]);
  });

  it("puces Admins et Sans groupe, combinables avec la recherche", () => {
    const { A } = monter();
    A.toggleUsersFilter("admin");
    expect(noms(A)).toEqual(["root"]);
    A.toggleUsersFilter("admin");
    A.toggleUsersFilter("sans-groupe");
    expect(noms(A)).toEqual(["root", "bob"]);
    A.usersSearch.value = "bo";
    expect(noms(A)).toEqual(["bob"]);
  });
});

describe("sélection et actions groupées", () => {
  it("sélectionne la page, puis la vide ; la sélection suit la liste", () => {
    const { A } = monter();
    A.toggleToutesChoisies();
    expect(A.comptesSelection.value).toHaveLength(4);
    A.toggleToutesChoisies();
    expect(A.comptesSelection.value).toEqual([]);
    A.toggleCompteChoisi(3);
    A.usersList.value = A.usersList.value.filter((u) => u.id !== 3);
    return nextTick().then(() => expect(A.comptesSelection.value).toEqual([]));
  });

  it("ajout à un groupe : un PUT par compte, ses autres groupes gardés, déjà membres ignorés", async () => {
    const { A, appels } = monter();
    for (const id of [2, 3, 4]) A.toggleCompteChoisi(id);
    await A.ajouterSelectionAuGroupe(10);
    const puts = appels.filter((a) => a.methode === "PUT");
    expect(puts.map((p) => p.url)).toEqual(["/api/admin/users/3/groups"]);
    expect(puts[0]?.corps).toEqual({ group_ids: [10] });
  });

  it("réinitialisation : jamais un même mot de passe pour plusieurs comptes", async () => {
    const { A, appels } = monter();
    for (const id of [2, 3]) A.toggleCompteChoisi(id);
    A.reinitialiserSelection();
    expect(A.resetLibelle.value).toBe("");
    A.newPasswordInput.value = "Temporaire-1";
    await A.confirmReset();
    expect(appels.filter((a) => a.url === "/api/admin/reset-password")).toEqual([]);
  });

  it("réinitialisation : un seul compte sélectionné, le vôtre exclu", async () => {
    const { A, appels } = monter();
    for (const id of [1, 2]) A.toggleCompteChoisi(id);
    A.reinitialiserSelection();
    expect(A.resetLibelle.value).toBe(A.usersList.value.find((u) => u.id === 2)?.username);
    A.newPasswordInput.value = "Temporaire-1";
    await A.confirmReset();
    expect(appels.filter((a) => a.url === "/api/admin/reset-password").map((a) => a.corps)).toEqual([
      { target_id: 2, new_password: "Temporaire-1" },
    ]);
  });

  it("suppression : saisie du mot SUPPRIMER, puis seulement si la seconde question le dit, les sandboxes", async () => {
    const { A, appels, mots } = monter();
    for (const id of [1, 3]) A.toggleCompteChoisi(id);
    await A.supprimerSelection();
    expect(mots).toEqual(["SUPPRIMER"]);
    const dels = appels.filter((a) => a.methode === "DELETE");
    expect(dels.map((d) => d.url)).toEqual(["/api/admin/users/3"]);
  });

  it("suppression refusée : rien n'est envoyé", async () => {
    const { A, appels } = monter({ typed: false });
    A.toggleCompteChoisi(3);
    await A.supprimerSelection();
    expect(appels.filter((a) => a.methode === "DELETE")).toEqual([]);
  });
});

describe("suppression d'un compte", () => {
  it("demande la saisie du mot SUPPRIMER puis supprime", async () => {
    const { A, appels, mots } = monter();
    await A.deleteUser(compte(3, "bob"));
    expect(mots).toEqual(["SUPPRIMER"]);
    expect(appels.filter((a) => a.methode === "DELETE")).toHaveLength(1);
  });

  it("sans saisie confirmée, aucune suppression", async () => {
    const { A, appels } = monter({ typed: false });
    await A.deleteUser(compte(3, "bob"));
    expect(appels.filter((a) => a.methode === "DELETE")).toEqual([]);
  });
});

describe("tableau", () => {
  it("colonnes triables, cases, barre d'actions groupées", async () => {
    const { A } = monter();
    A.adminTab.value = "accounts";
    const domaine = proxyRefs({ ...A, user: { id: 1, username: "root" } }) as unknown as DomaineAdmin;
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp({ render: () => h(PageComptes) });
    app.provide(CLE_ADMIN, domaine);
    app.mount(hote);
    await nextTick();
    expect(hote.querySelectorAll("[data-tri]")).toHaveLength(7);
    expect(hote.querySelector("[data-actions-groupees]")).toBeNull();
    hote.querySelectorAll<HTMLInputElement>("[data-compte-choisi]")[1]?.click();
    await nextTick();
    expect(hote.querySelector("[data-actions-groupees]")?.textContent).toContain("1 sélectionné(s)");
    hote.querySelector<HTMLElement>('[data-filtre="admin"]')?.click();
    await nextTick();
    expect(hote.querySelectorAll("[data-compte-choisi]")).toHaveLength(1);
    expect(hote.querySelector(".adm-pill--warn")).toBeNull();
    hote.querySelector<HTMLElement>('[data-tri="username"]')?.click();
    await nextTick();
    expect(hote.querySelector("th[aria-sort='ascending']")?.textContent).toContain("Compte");
  });
});
