// SPDX-License-Identifier: MIT
/** frontend/test/admin/rattachement.test.ts — console › SSO OpenID Connect : rattachements préparés, depuis la carte « Comptes existants » de la page (fournisseur choisi ou seul enregistré). */
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
    username: "alice",
    expected: "alice@sso",
    waiver: true,
    expires_at: 2000000000,
  };
  const UTIL = [
    compteConsole(1, "root", { is_admin: 1 }),
    compteConsole(2, "alice"),
    compteConsole(3, "bob", { identity: { provider_id: "sso", ext_username: "bob" } }),
    compteConsole(4, "carole", { is_admin: 2 }),
  ];

  async function ouvrirSso(items: unknown[] = [ITEM]) {
    const m = monter(etat([OIDC]), { utilisateurs: UTIL });
    m.reponses["GET " + PRE] = [json({ items })];
    await m.A.loadEnterpriseAuth();
    await vider();
    await attendre(20);
    await vider();
    return m;
  }

  it("la carte de la page porte les rattachements, sans ouvrir le tiroir ; seul fournisseur présélectionné", async () => {
    const m = await ouvrirSso();
    expect(m.A.authTiroir.value).toBeNull();
    expect(document.querySelector(".adm-drawer")).toBeNull();
    const carte = m.hote.querySelector("#ent-comptes[data-prelinks]");
    expect(carte?.querySelector("[data-prelink]")?.textContent).toContain("alice@sso");
    expect(el<HTMLSelectElement>("#ent-prelien-fournisseur")?.value).toBe("sso");
    expect(m.appels).toContain("GET " + PRE);
    expect(el("#ent-prelien-compte")?.hasAttribute("aria-describedby")).toBe(false);
    expect(el("#ent-prelien-admin")?.getAttribute("aria-describedby")).toBe("ent-prelien-admin-aide");
  });

  it("aucun fournisseur : carte visible, grisée, avec sa raison écrite", async () => {
    const m = monter(etat([]), { utilisateurs: UTIL });
    await m.A.loadEnterpriseAuth();
    await vider();
    expect(el("[data-prelinks-raison]")?.textContent?.trim()).toBe(
      "Enregistrez d'abord un fournisseur (carte « 2. Fournisseurs »).",
    );
    for (const sel of [
      "#ent-prelien-fournisseur",
      "#ent-prelien-compte",
      "#ent-prelien-attendu",
      "#ent-prelien-dispense",
      "#ent-prelien-admin",
      "#ent-prelien-ajouter",
    ])
      expect(el<HTMLInputElement>(sel)?.disabled, sel).toBe(true);
    for (const sel of [
      "#ent-prelien-compte",
      "#ent-prelien-attendu",
      "#ent-prelien-dispense",
      "#ent-prelien-admin",
    ])
      expect(el(sel)?.getAttribute("aria-describedby")?.split(" "), sel).toContain("ent-prelien-raison");
    expect(m.appels.some((a) => a.includes("/prelinks"))).toBe(false);
  });

  it("plusieurs fournisseurs : rien n'est choisi d'office, le choix charge la liste de ce fournisseur", async () => {
    const AUTRE = { ...OIDC, id: "autre", label: "Autre" };
    const m = monter(etat([OIDC, AUTRE]), { utilisateurs: UTIL });
    m.reponses["GET /api/admin/auth/providers/autre/prelinks"] = [json({ items: [ITEM] })];
    m.reponses["POST /api/admin/auth/providers/autre/prelinks"] = [json(ITEM)];
    await m.A.loadEnterpriseAuth();
    await vider();
    expect(el<HTMLSelectElement>("#ent-prelien-fournisseur")?.value).toBe("");
    expect(el("[data-prelinks-raison]")?.textContent?.trim()).toBe("Choisissez d'abord le fournisseur.");
    expect(el<HTMLSelectElement>("#ent-prelien-compte")?.disabled).toBe(true);
    expect(m.appels.some((a) => a.includes("/prelinks"))).toBe(false);
    await saisir("#ent-prelien-fournisseur", "autre");
    await attendre(20);
    await vider();
    expect(m.appels).toContain("GET /api/admin/auth/providers/autre/prelinks");
    expect(el("[data-prelink]")?.textContent).toContain("alice@sso");
    await saisir("#ent-prelien-compte", "2");
    await saisir("#ent-prelien-attendu", "alice@sso");
    await clic("#ent-prelien-ajouter");
    expect(m.corps["POST /api/admin/auth/providers/autre/prelinks"]).toHaveLength(1);
    expect(m.corps["POST " + PRE]).toBeUndefined();
  });

  it("la case de confirmation reste affichée : grisée et sans objet pour un compte ordinaire", async () => {
    await ouvrirSso([]);
    await saisir("#ent-prelien-compte", "2");
    expect(el<HTMLInputElement>("#ent-prelien-admin")?.disabled).toBe(true);
    expect(el("[data-prelink-confirmation-aide]")?.textContent?.trim()).toBe(
      "Sans objet : seulement pour un administrateur ou un modérateur.",
    );
    await saisir("#ent-prelien-compte", "1");
    expect(el<HTMLInputElement>("#ent-prelien-admin")?.disabled).toBe(false);
    expect(el("[data-prelink-confirmation-aide]")?.textContent?.trim()).toBe(
      "Obligatoire pour un administrateur ou un modérateur.",
    );
  });

  it("liste les rattachements préparés et propose les seuls comptes sans identité", async () => {
    await ouvrirSso();
    const t = el("[data-prelinks]")?.textContent ?? "";
    expect(t).toContain("Comptes existants");
    expect(t).toContain(
      "À sa première connexion par ce fournisseur, la personne saisit une fois son ancien mot de passe Elpis, sauf dispense ci-dessous.",
    );
    expect(el("[data-prelink]")?.textContent).toContain("alice");
    expect(el("[data-prelink]")?.textContent).toContain("alice@sso");
    expect(el("[data-prelink]")?.textContent).toContain("Sans ancien mot de passe");
    expect(el("[data-prelink] .font-medium")?.textContent).toBe("alice");
    expect(el("[data-prelink-attendu]")?.textContent).toBe(" · identifiant attendu : alice@sso");
    expect(el("[data-prelink]")?.textContent).toContain("alice · identifiant attendu : alice@sso");
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
