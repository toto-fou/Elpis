// SPDX-License-Identifier: MIT
/** frontend/test/admin/partage-identite-annuaire.test.ts — fenêtre de partage : identifiant d'annuaire et libellé du fournisseur à côté du nom d'un compte rattaché, rien pour un compte local ; le schéma de la liste accepte l'ancienne forme. */
import { createApp, defineComponent, h, nextTick, provide } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it } from "vitest";
import { schemaReponseComptesLite } from "@elpis/contracts";

import ModalesGroupes from "../../src/components/admin/ModalesGroupes.vue";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

const COMPTES = [
  { id: 2, username: "jean-dupont", groups: "", ext_username: "jean.dupont", provider_label: "Annuaire" },
  { id: 3, username: "marie", groups: "", ext_username: "marie.d", provider_label: null },
  { id: 4, username: "paul", groups: "", ext_username: null, provider_label: null },
];

async function monter(): Promise<HTMLElement> {
  const domaine = {
    isShareModalOpen: true,
    promptToShare: { title: "P" },
    filteredShareUsers: COMPTES,
    groupedShareUsers: [{ groupLabel: null, users: COMPTES }],
    shareTargetUsers: [],
    selectAllUsers: false,
    groupModal: { show: false },
    groupMembersModal: { show: false },
    myGroups: [],
    selectedGroupFilter: "",
    shareSending: false,
  } as unknown as DomaineAdmin;
  const hote = document.createElement("div");
  document.body.append(hote);
  app = createApp(
    defineComponent({
      setup() {
        provide(CLE_ADMIN, domaine);
        return () => h(ModalesGroupes);
      },
    }),
  );
  app.mount(hote);
  await nextTick();
  return hote;
}

describe("partage : identité d'annuaire", () => {
  it("affiche « identifiant · libellé », l'identifiant seul sans libellé, rien pour un compte local", async () => {
    const hote = await monter();
    const lignes = [...hote.querySelectorAll("label")].filter((l) =>
      l.querySelector("input[type=checkbox][value]"),
    );
    const texte = (i: number): string | null =>
      lignes[i]?.querySelector('[data-testid="identite-annuaire"]')?.textContent?.trim() ?? null;
    expect(lignes).toHaveLength(3);
    expect(texte(0)).toBe("jean.dupont · Annuaire");
    expect(texte(1)).toBe("marie.d");
    expect(texte(2)).toBeNull();
  });

  it("le schéma de la liste accepte une ancienne forme (champs par défaut à null)", () => {
    const r = schemaReponseComptesLite.parse({
      users: [{ id: 1, username: "a", groups: "" }],
      my_groups: [],
    });
    expect(r.users[0]).toMatchObject({ ext_username: null, provider_label: null });
  });
});
