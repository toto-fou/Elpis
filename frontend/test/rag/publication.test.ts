// SPDX-License-Identifier: MIT
/** frontend/test/rag/publication.test.ts — boîte « Publier » : choix de départ, groupes, comptes concernés, validation, corps envoyé, refus du serveur en clair. */
import { describe, expect, it } from "vitest";

import {
  basculerGroupe,
  choixInchange,
  choixInitial,
  comptesConcernes,
  corpsPublication,
  messageRefusPublication,
  phraseComptes,
  validerChoix,
} from "../../src/features/rag/publication";
import type { ChoixPublication } from "../../src/features/rag/publication";

const GROUPES = [
  { id: 1, name: "Réseau", members: 6 },
  { id: 2, name: "Support", members: 11 },
  { id: 3, name: "Direction", members: 4 },
];
const choix = (o: Partial<ChoixPublication> = {}): ChoixPublication => ({
  visibility: "groups",
  groupIds: [],
  allowSourceOpen: false,
  ...o,
});

describe("choix de départ", () => {
  it("reprend la publication de la collection", () => {
    expect(
      choixInitial({
        visibility: "groups",
        groups: [{ id: 1, name: "Réseau", members: 6 }],
        allow_source_open: true,
      }),
    ).toEqual({
      visibility: "groups",
      groupIds: [1],
      allowSourceOpen: true,
    });
    expect(choixInitial({ visibility: "private", groups: [], allow_source_open: false })).toEqual({
      visibility: "private",
      groupIds: [],
      allowSourceOpen: false,
    });
  });

  it("bascule un groupe sans changer l'ordre des autres", () => {
    expect(basculerGroupe([1, 2], 3)).toEqual([1, 2, 3]);
    expect(basculerGroupe([1, 2, 3], 2)).toEqual([1, 3]);
  });
});

describe("comptes concernés", () => {
  it("privée : personne ; tous : l'effectif de l'instance ; groupes : somme plafonnée", () => {
    expect(comptesConcernes(choix({ visibility: "private" }), GROUPES, 40)).toBe(0);
    expect(comptesConcernes(choix({ visibility: "all" }), GROUPES, 40)).toBe(40);
    expect(comptesConcernes(choix({ groupIds: [1, 2] }), GROUPES, 40)).toBe(17);
    expect(comptesConcernes(choix({ groupIds: [1, 2] }), GROUPES, 10)).toBe(10);
    expect(comptesConcernes(choix({ groupIds: [9] }), GROUPES, 40)).toBe(0);
  });

  it("phrase sous les options", () => {
    expect(phraseComptes(choix({ visibility: "private" }), GROUPES, 40)).toBe("Seul votre compte y a accès.");
    expect(phraseComptes(choix({ groupIds: [] }), GROUPES, 40)).toBe(
      "Aucun compte n’y aura accès pour l’instant.",
    );
    expect(phraseComptes(choix({ groupIds: [1] }), GROUPES, 40)).toBe(
      "6 comptes y auront accès. Vous pourrez la dépublier à tout moment.",
    );
    expect(phraseComptes(choix({ groupIds: [1, 2] }), GROUPES, 40)).toBe(
      "Jusqu’à 17 comptes y auront accès. Vous pourrez la dépublier à tout moment.",
    );
    expect(phraseComptes(choix({ visibility: "all" }), GROUPES, 1)).toBe(
      "1 compte y aura accès. Vous pourrez la dépublier à tout moment.",
    );
  });
});

describe("validation", () => {
  it("des groupes sont requis pour une publication à des groupes", () => {
    expect(validerChoix(choix({ groupIds: [] }), GROUPES, false)).toBe("Choisissez au moins un groupe.");
    expect(validerChoix(choix({ groupIds: [1] }), GROUPES, false)).toBeNull();
  });

  it("un utilisateur ne publie pas à tous les comptes, un admin oui", () => {
    expect(validerChoix(choix({ visibility: "all" }), GROUPES, false)).toBe(
      "Seul un administrateur peut publier à tous les comptes.",
    );
    expect(validerChoix(choix({ visibility: "all" }), GROUPES, true)).toBeNull();
    expect(validerChoix(choix({ visibility: "private" }), GROUPES, false)).toBeNull();
  });

  it("un groupe qui n'est plus offert est refusé à un utilisateur, pas à un admin", () => {
    expect(validerChoix(choix({ groupIds: [1, 99] }), GROUPES, false)).toBe(
      "Un des groupes choisis n’existe plus.",
    );
    expect(validerChoix(choix({ groupIds: [1, 99] }), GROUPES, true)).toBeNull();
  });

  it("au plus 50 groupes", () => {
    expect(
      validerChoix(choix({ groupIds: Array.from({ length: 51 }, (_, i) => i + 1) }), GROUPES, true),
    ).toBe("Au plus 50 groupes.");
  });
});

describe("corps envoyé", () => {
  it("les groupes ne partent que pour la visibilité « groupes »", () => {
    expect(corpsPublication(choix({ groupIds: [1, 2], allowSourceOpen: true }))).toEqual({
      visibility: "groups",
      group_ids: [1, 2],
      allow_source_open: true,
    });
    expect(corpsPublication(choix({ visibility: "all", groupIds: [1], allowSourceOpen: true }))).toEqual({
      visibility: "all",
      group_ids: [],
      allow_source_open: true,
    });
  });

  it("rendre privée referme l'ouverture des sources", () => {
    expect(corpsPublication(choix({ visibility: "private", groupIds: [1], allowSourceOpen: true }))).toEqual({
      visibility: "private",
      group_ids: [],
      allow_source_open: false,
    });
  });

  it("le choix identique à la publication actuelle est « inchangé », quel que soit l'ordre des groupes", () => {
    const c = {
      visibility: "groups" as const,
      groups: [
        { id: 1, name: "A", members: 1 },
        { id: 2, name: "B", members: 2 },
      ],
      allow_source_open: false,
    };
    expect(choixInchange(choix({ groupIds: [2, 1] }), c)).toBe(true);
    expect(choixInchange(choix({ groupIds: [1] }), c)).toBe(false);
    expect(choixInchange(choix({ groupIds: [1, 2], allowSourceOpen: true }), c)).toBe(false);
    expect(
      choixInchange(choix({ visibility: "private" }), {
        visibility: "private",
        groups: [],
        allow_source_open: false,
      }),
    ).toBe(true);
  });
});

describe("refus du serveur", () => {
  it("messages en clair par code", () => {
    expect(messageRefusPublication("groupe_non_membre", "x")).toBe(
      "Vous ne pouvez publier qu’aux groupes dont vous êtes membre.",
    );
    expect(messageRefusPublication("tous_reserve_admin", null)).toBe(
      "Seul un administrateur peut publier à tous les comptes.",
    );
    expect(messageRefusPublication("groupes_requis", null)).toBe("Choisissez au moins un groupe.");
    expect(messageRefusPublication("groupe_inconnu", null)).toBe("Un des groupes choisis n’existe plus.");
    expect(messageRefusPublication("lecture_seule", null)).toBe(
      "Seul l’auteur d’une collection peut la publier.",
    );
    expect(messageRefusPublication("collection_introuvable", null)).toBe("Cette collection n’existe plus.");
  });

  it("code inconnu : le message du serveur, sinon une phrase générique", () => {
    expect(messageRefusPublication("autre", "Détail du serveur")).toBe("Détail du serveur");
    expect(messageRefusPublication(null, null)).toBe("La publication a échoué.");
  });
});
