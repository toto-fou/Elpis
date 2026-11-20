// SPDX-License-Identifier: MIT
/** frontend/test/admin/rattachement.test.ts — console › Connexion d'entreprise : rattachements préparés d'un fournisseur SSO. */
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

const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("rattachements préparés", () => {
  const PRE = "/api/admin/auth/providers/sso/prelinks";
  const ITEM = {
    id: 7,
    user_id: 2,
    username: "alice",
    expected: "alice@sso",
    waiver: true,
    created_by: 1,
    created_at: 1,
    expires_at: 2000000000,
  };
  const UTIL = [
    compteConsole(1, "root", { is_admin: 1 }),
    compteConsole(2, "alice"),
    compteConsole(3, "bob", { identity: { provider_id: "sso", ext_username: "bob", linked_at: 1 } }),
    compteConsole(4, "carole", { is_admin: 2 }),
  ];

  async function ouvrirSso(items: unknown[] = [ITEM]) {
    const m = monter(etat([OIDC]), { utilisateurs: UTIL });
    m.reponses["GET " + PRE] = [json({ items })];
    await m.A.loadEnterpriseAuth();
    await vider();
    m.A.authModifier("sso");
    await vider();
    await attendre(20);
    await vider();
    return m;
  }

  it("liste les rattachements préparés et propose les seuls comptes sans identité", async () => {
    await ouvrirSso();
    const t = el("[data-prelinks]")?.textContent ?? "";
    expect(t).toContain("Comptes existants");
    expect(t).toContain(
      "À sa première connexion par ce fournisseur, la personne devra saisir une fois son ancien mot de passe Elpis.",
    );
    expect(el("[data-prelink]")?.textContent).toContain("alice");
    expect(el("[data-prelink]")?.textContent).toContain("alice@sso");
    expect(el("[data-prelink]")?.textContent).toContain("Sans ancien mot de passe");
    const options = tous<HTMLOptionElement>("#ent-prelien-compte option").map((o) => o.textContent?.trim());
    expect(options).toEqual(["—", "root (administrateur)", "alice", "carole (modérateur)"]);
  });

  it("ajoute un rattachement : corps exact, dispense cochable pour un compte ordinaire", async () => {
    const m = await ouvrirSso([]);
    m.reponses["POST " + PRE] = [json(ITEM)];
    m.reponses["GET " + PRE] = [json({ items: [ITEM] })];
    await saisir("#ent-prelien-compte", "2");
    await saisir("#ent-prelien-attendu", " alice@sso ");
    await clic("#ent-prelien-dispense");
    await clic("#ent-prelien-ajouter");
    expect(m.corps["POST " + PRE]).toEqual([
      { user_id: 2, expected: "alice@sso", waiver: true, confirm_admin: false },
    ]);
    expect(el("[data-prelink]")).not.toBeNull();
  });

  it("administrateur : dispense désactivée et décochée, case de confirmation obligatoire", async () => {
    const m = await ouvrirSso([]);
    await clic("#ent-prelien-dispense");
    await saisir("#ent-prelien-compte", "1");
    await saisir("#ent-prelien-attendu", "root@sso");
    const dispense = el<HTMLInputElement>("#ent-prelien-dispense");
    expect(dispense?.disabled).toBe(true);
    expect(dispense?.checked).toBe(false);
    expect(el("[data-prelink-dispense-admin]")?.textContent).toContain("ancien mot de passe");
    expect(el<HTMLButtonElement>("#ent-prelien-ajouter")?.disabled).toBe(true);
    m.reponses["POST " + PRE] = [json(ITEM)];
    await clic("#ent-prelien-admin");
    expect(el<HTMLButtonElement>("#ent-prelien-ajouter")?.disabled).toBe(false);
    await clic("#ent-prelien-ajouter");
    expect(m.corps["POST " + PRE]).toEqual([
      { user_id: 1, expected: "root@sso", waiver: false, confirm_admin: true },
    ]);
  });

  it("modérateur : dispense désactivée, confirmation obligatoire, aide de la dispense affichée", async () => {
    const m = await ouvrirSso([]);
    expect(el("[data-prelink-dispense-aide]")?.textContent).toContain(
      "À n'utiliser que si votre fournisseur ne laisse pas les personnes changer leur identifiant.",
    );
    await saisir("#ent-prelien-compte", "4");
    await saisir("#ent-prelien-attendu", "carole@sso");
    expect(el<HTMLInputElement>("#ent-prelien-dispense")?.disabled).toBe(true);
    expect(el<HTMLButtonElement>("#ent-prelien-ajouter")?.disabled).toBe(true);
    m.reponses["POST " + PRE] = [json(ITEM)];
    await clic("#ent-prelien-admin");
    await clic("#ent-prelien-ajouter");
    expect(m.corps["POST " + PRE]).toEqual([
      { user_id: 4, expected: "carole@sso", waiver: false, confirm_admin: true },
    ]);
  });

  it("l'échéance affichée est celle du serveur", async () => {
    await ouvrirSso([{ ...ITEM, waiver: true, expires_at: 1_700_000_000 + 72 * 3600 }]);
    expect(el("[data-prelink]")?.textContent).toContain("Échéance :");
  });

  it("une erreur 400 ou 409 affiche le détail du serveur", async () => {
    const m = await ouvrirSso([]);
    m.reponses["POST " + PRE] = [json({ detail: "Ce compte a déjà un rattachement préparé." }, 409)];
    await saisir("#ent-prelien-compte", "2");
    await saisir("#ent-prelien-attendu", "alice@sso");
    await clic("#ent-prelien-ajouter");
    expect(el("[data-prelinks-erreur]")?.textContent).toContain("Ce compte a déjà un rattachement préparé.");
  });

  it("supprime un rattachement préparé après confirmation", async () => {
    const m = await ouvrirSso();
    m.reponses["DELETE " + PRE + "/7"] = [json({ ok: true })];
    m.reponses["GET " + PRE] = [json({ items: [] })];
    await clic("[data-prelink-supprimer]");
    expect(m.confirmations).toEqual(["Supprimer ce rattachement préparé"]);
    expect(m.appels).toContain("DELETE " + PRE + "/7");
    expect(el("[data-prelink]")).toBeNull();
  });
});
