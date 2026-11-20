// SPDX-License-Identifier: MIT
/** frontend/test/admin/comptes-identites.test.ts — console › Comptes : colonne Connexion, détachement d'une identité, mention de suppression, réinitialisation masquée sans mot de passe local. */
import { afterEach, describe, expect, it } from "vitest";

import { reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import { json } from "../aides";
import {
  OIDC,
  clic,
  compteConsole,
  demonter,
  el,
  etat,
  monter,
  saisir,
  tous,
  vider,
} from "./rattachement-aide";

afterEach(() => {
  demonter();
  reinitialiserSuiviChargement();
});

const IDENTITE = { provider_id: "sso", ext_username: "alice.martin", linked_at: 1 };
const UTIL = [
  compteConsole(1, "root", { is_admin: 1 }),
  compteConsole(2, "alice", { identity: IDENTITE, has_local_password: false }),
  compteConsole(3, "bob"),
  compteConsole(4, "carole", { identity: { ...IDENTITE, provider_id: "disparu", ext_username: null } }),
];
const DETACH = "POST /api/admin/users/2/identity/detach";

async function ouvrir(accepter = true) {
  const m = monter(etat([OIDC]), { page: "accounts", utilisateurs: UTIL, accepter });
  await m.A.loadEnterpriseAuth();
  await m.A.loadUsers();
  await vider();
  return m;
}
const ligne = (nom: string): HTMLElement | null =>
  tous("tbody tr").find((tr) => tr.textContent?.includes(nom) && tr.querySelector("[data-connexion]")) ??
  null;

describe("page Comptes : identités", () => {
  it("la colonne Connexion dit Locale, ou le fournisseur et l'identifiant externe", async () => {
    await ouvrir();
    expect(ligne("bob")?.querySelector("[data-connexion]")?.textContent?.trim()).toBe("Locale");
    const alice = ligne("alice")?.querySelector("[data-connexion]")?.textContent ?? "";
    expect(alice).toContain("SSO siège");
    expect(alice).toContain("alice.martin");
    expect(ligne("carole")?.querySelector("[data-connexion]")?.textContent).toContain("disparu");
    expect(tous("thead th").some((th) => th.textContent?.trim() === "Connexion")).toBe(true);
  });

  it("sans fournisseur ni identité, le tableau est celui d'avant : pas de colonne Connexion, bouton Désactiver gardé", async () => {
    const m = monter(etat([]), {
      page: "accounts",
      utilisateurs: [compteConsole(1, "root", { is_admin: 1 }), compteConsole(3, "bob")],
    });
    await m.A.loadEnterpriseAuth();
    await m.A.loadUsers();
    await vider();
    expect(tous("thead th").some((th) => th.textContent?.trim() === "Connexion")).toBe(false);
    expect(tous("[data-connexion]")).toHaveLength(0);
    expect(tous("tbody tr").some((tr) => tr.textContent?.includes("bob"))).toBe(true);
  });

  it("la réinitialisation du mot de passe est masquée sans mot de passe local", async () => {
    await ouvrir();
    expect(ligne("alice")?.querySelector('[aria-label^="Réinitialiser"]')).toBeNull();
    expect(ligne("bob")?.querySelector('[aria-label^="Réinitialiser"]')).not.toBeNull();
  });

  it("« Détacher » n'existe que pour un compte à identité, jamais pour soi-même", async () => {
    await ouvrir();
    expect(ligne("alice")?.querySelector("[data-detacher]")).not.toBeNull();
    expect(ligne("bob")?.querySelector("[data-detacher]")).toBeNull();
    expect(ligne("root")?.querySelector("[data-detacher]")).toBeNull();
  });

  it("détacher demande un mot de passe temporaire et envoie la demande", async () => {
    const m = await ouvrir();
    m.reponses[DETACH] = [json({ ok: true })];
    await clic("[data-detacher]");
    const dialogue = el('[aria-label="Détacher le compte"]');
    expect(dialogue?.textContent).toContain(
      "Le compte redeviendra local. La personne devra changer ce mot de passe à sa prochaine connexion.",
    );
    expect(el<HTMLButtonElement>("[data-detach-valider]")?.disabled).toBe(true);
    await saisir("[data-detach-mdp]", "Temporaire-123");
    await clic("[data-detach-valider]");
    expect(m.corps[DETACH]).toEqual([{ new_password: "Temporaire-123" }]);
    expect(m.A.detachCible.value).toBeNull();
    expect(m.appels.filter((a) => a === "GET /api/admin/users-with-groups")).toHaveLength(2);
  });

  it("le refus du serveur (politique de mot de passe) s'affiche et le dialogue reste ouvert", async () => {
    const m = await ouvrir();
    m.reponses[DETACH] = [json({ detail: "Mot de passe trop court." }, 400)];
    await clic("[data-detacher]");
    await saisir("[data-detach-mdp]", "a");
    await clic("[data-detach-valider]");
    expect(el('[aria-label="Détacher le compte"]')?.textContent).toContain("Mot de passe trop court.");
  });

  it("supprimer un compte à identité rappelle que ce n'est pas bannir", async () => {
    const m = await ouvrir();
    const mention =
      "Supprimer n'est pas bannir : le compte sera recréé à la prochaine connexion par le fournisseur d'identité. Pour interdire l'accès, désactivez-le.";
    expect(ligne("alice")?.querySelector('[aria-label="Supprimer alice"]')?.getAttribute("title")).toContain(
      mention,
    );
    expect(ligne("bob")?.querySelector('[aria-label="Supprimer bob"]')?.getAttribute("title")).not.toContain(
      "bannir",
    );
    const alice = m.A.usersList.value.find((u) => u.id === 2);
    if (!alice) throw new Error("compte absent");
    await m.A.deleteUser(alice);
    expect(m.textes.at(-1)).toContain(mention);
    const bob = m.A.usersList.value.find((u) => u.id === 3);
    if (!bob) throw new Error("compte absent");
    await m.A.deleteUser(bob);
    expect(m.textes.at(-1)).not.toContain("bannir");
  });
});
