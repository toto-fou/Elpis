// SPDX-License-Identifier: MIT
/** frontend/test/admin/droits-fournisseur.test.ts — console › fournisseur : section « Rôles et groupes » (repliée, éteinte, corps envoyés, confirmation par saisie, second facteur), essai de connexion avec droits, page Comptes (rôle géré, 409). */
import { afterEach, describe, expect, it } from "vitest";

import { lignesDroits } from "../../src/features/admin/identite";
import { reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import { json } from "../aides";
import {
  OIDC,
  clic,
  cocher,
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

const PUT_SSO = "PUT /api/admin/auth/providers/sso";
const SSO_2FA = { ...OIDC, required_acr: ["mfa"], mfa_acr: ["mfa"] };
const GROUPES = [
  { id: 7, name: "développeurs" },
  { id: 8, name: "support" },
];

async function ouvrir(prov: unknown, id: string, opts: { accepter?: boolean } = {}) {
  const m = monter(etat([prov]), opts);
  m.A.groupsList.value = GROUPES as never;
  await m.A.loadEnterpriseAuth();
  m.A.authModifier(id);
  await vider();
  return m;
}
const section = (): HTMLDetailsElement | null => el<HTMLDetailsElement>("[data-droits-section]");
const ajouterAdmin = async (g: string): Promise<void> => {
  await saisir("#ent-admin-groupe", g);
  await clic("[data-admin-ajouter]");
};
const enregistrer = (): HTMLButtonElement | null => el<HTMLButtonElement>("#ent-enregistrer-fournisseur");
const envoye = (m: { corps: Record<string, unknown[]> }, cle: string) =>
  m.corps[cle]?.[0] as Record<string, unknown>;

describe("section Rôles et groupes : état d'origine", () => {
  it("est repliée, éteinte, sans avertissement", async () => {
    await ouvrir(SSO_2FA, "sso");
    expect(section()?.open).toBe(false);
    expect(el<HTMLInputElement>("#ent-roles-actif")?.checked).toBe(false);
    expect(el<HTMLInputElement>("#ent-groupes-actif")?.checked).toBe(false);
    expect(el("[data-avertissement-admin]")).toBeNull();
    expect(el("[data-exiger-second-facteur]")).toBeNull();
  });

  it("sans ces options, le corps envoyé ne porte ni roles ni group_map ni confirm_admin_mapping", async () => {
    const m = await ouvrir(SSO_2FA, "sso");
    m.reponses[PUT_SSO] = [json(etat([SSO_2FA]))];
    await saisir("#ent-label", "SSO bis");
    await clic("#ent-enregistrer-fournisseur");
    const c = envoye(m, PUT_SSO);
    expect(Object.keys(c)).not.toContain("roles");
    expect(Object.keys(c)).not.toContain("group_map");
    expect(Object.keys(c)).not.toContain("confirm_admin_mapping");
    expect(m.mots).toEqual([]);
  });

  it("le test d'un fournisseur sans option n'envoie rien de plus", async () => {
    const m = await ouvrir(SSO_2FA, "sso");
    m.reponses["POST /api/admin/auth/providers/test"] = [json({ ok: true, steps: [] })];
    await clic("#ent-tester");
    const c = envoye(m, "POST /api/admin/auth/providers/test");
    expect(Object.keys(c)).not.toContain("roles");
    expect(Object.keys(c)).not.toContain("group_map");
  });
});

describe("section Rôles et groupes : groupes administrateurs", () => {
  it("un groupe administrateur saisi montre l'avertissement fixe", async () => {
    await ouvrir(SSO_2FA, "sso");
    await ajouterAdmin("cn=admins");
    expect(el("[data-avertissement-admin]")?.textContent).toContain(
      "Un administrateur d'Elpis peut faire exécuter des commandes sur le serveur. Ne donnez ce rôle qu'à un groupe que vous maîtrisez.",
    );
    expect(el("[data-exiger-second-facteur]")).toBeNull();
  });

  it("l'enregistrement demande de taper « administrateur » puis envoie confirm_admin_mapping", async () => {
    const m = await ouvrir(SSO_2FA, "sso");
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins");
    m.reponses[PUT_SSO] = [json(etat([SSO_2FA]))];
    await clic("#ent-enregistrer-fournisseur");
    expect(m.mots).toEqual(["administrateur"]);
    const c = envoye(m, PUT_SSO);
    expect(c["roles"]).toEqual({ enabled: true, admin_groups: ["cn=admins"], moderator_groups: [] });
    expect(c["confirm_admin_mapping"]).toBe(true);
  });

  it("refuser la saisie n'envoie rien", async () => {
    const m = await ouvrir(SSO_2FA, "sso", { accepter: false });
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins");
    await clic("#ent-enregistrer-fournisseur");
    expect(m.mots).toEqual(["administrateur"]);
    expect(m.corps[PUT_SSO]).toBeUndefined();
  });

  it("une liste inchangée ne rouvre pas la confirmation (libellé seul modifié)", async () => {
    const enreg = {
      ...SSO_2FA,
      roles: { enabled: true, admin_groups: ["cn=admins"], moderator_groups: [] },
    };
    const m = await ouvrir(enreg, "sso");
    m.reponses[PUT_SSO] = [json(etat([enreg]))];
    await saisir("#ent-label", "SSO bis");
    await clic("#ent-enregistrer-fournisseur");
    expect(m.mots).toEqual([]);
    const c = envoye(m, PUT_SSO);
    expect(c["roles"]).toEqual(enreg.roles);
    expect(Object.keys(c)).not.toContain("confirm_admin_mapping");
  });

  it("une liste modifiée rouvre la confirmation", async () => {
    const enreg = {
      ...SSO_2FA,
      roles: { enabled: true, admin_groups: ["cn=admins"], moderator_groups: [] },
    };
    const m = await ouvrir(enreg, "sso");
    m.reponses[PUT_SSO] = [json(etat([enreg]))];
    await ajouterAdmin("cn=autres");
    await clic("#ent-enregistrer-fournisseur");
    expect(m.mots).toEqual(["administrateur"]);
    expect(envoye(m, PUT_SSO)["confirm_admin_mapping"]).toBe(true);
  });

  it("groupes modérateurs seuls : pas d'avertissement ni de confirmation", async () => {
    const m = await ouvrir(SSO_2FA, "sso");
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await saisir("#ent-mod-groupe", "cn=mods");
    await clic("[data-mod-ajouter]");
    expect(el("[data-avertissement-admin]")).toBeNull();
    m.reponses[PUT_SSO] = [json(etat([SSO_2FA]))];
    await clic("#ent-enregistrer-fournisseur");
    expect(m.mots).toEqual([]);
    expect(envoye(m, PUT_SSO)["roles"]).toEqual({
      enabled: true,
      admin_groups: [],
      moderator_groups: ["cn=mods"],
    });
  });

  it("retirer tous les groupes d'un fournisseur déjà réglé envoie des listes vides", async () => {
    const enreg = { ...SSO_2FA, roles: { enabled: true, admin_groups: [], moderator_groups: ["cn=m"] } };
    const m = await ouvrir(enreg, "sso");
    m.reponses[PUT_SSO] = [json(etat([enreg]))];
    await clic('[aria-label="Retirer cn=m"]');
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await clic("#ent-enregistrer-fournisseur");
    expect(envoye(m, PUT_SSO)["roles"]).toEqual({ enabled: false, admin_groups: [], moderator_groups: [] });
  });
});

describe("section Rôles et groupes : confirmation à la création et au changement de sens", () => {
  const ADMINS = { enabled: true, admin_groups: ["cn=admins"], moderator_groups: [] };

  it("la création d'un fournisseur avec des groupes administrateurs demande la saisie et l'envoie", async () => {
    const m = monter(etat([]), {});
    await m.A.loadEnterpriseAuth();
    m.A.authNouveau();
    await vider();
    const f = m.A.authTiroir.value;
    if (!f) throw new Error("tiroir absent");
    Object.assign(f, {
      id: "neuf",
      label: "Neuf",
      issuer: "https://idp.example",
      client_id: "elpis",
      required_acr: "mfa",
      mfa_acr: "mfa",
      roles_enabled: true,
      admin_groups: ["cn=admins"],
    });
    m.reponses["POST /api/admin/auth/providers"] = [json(etat([SSO_2FA]))];
    await clic("#ent-enregistrer-fournisseur");
    expect(m.mots).toEqual(["administrateur"]);
    expect(envoye(m, "POST /api/admin/auth/providers")["confirm_admin_mapping"]).toBe(true);
  });

  for (const champ of ["groups_claim", "required_acr", "required_amr", "mfa_acr"] as const)
    it(`un SSO : changer ${champ} rouvre la confirmation`, async () => {
      const enreg = { ...SSO_2FA, roles: ADMINS };
      const m = await ouvrir(enreg, "sso");
      m.reponses[PUT_SSO] = [json(etat([enreg]))];
      const f = m.A.authTiroir.value;
      if (!f) throw new Error("tiroir absent");
      f[champ] = champ === "groups_claim" ? "roles" : "mfa pwd";
      await vider();
      await clic("#ent-enregistrer-fournisseur");
      expect(m.mots).toEqual(["administrateur"]);
      expect(envoye(m, PUT_SSO)["confirm_admin_mapping"]).toBe(true);
    });

  it("le 400 d'un groupe Elpis inexistant affiche son détail", async () => {
    const m = await ouvrir(SSO_2FA, "sso");
    m.reponses[PUT_SSO] = [
      json({ detail: "Champ « group_map.map.group_id » : ce groupe n'existe pas." }, 400),
    ];
    await clic("#ent-enregistrer-fournisseur");
    expect(el("[role=alert].adm-field__warn:not([data-avertissement-admin])")?.textContent).toContain(
      "ce groupe n'existe pas.",
    );
  });
});

describe("section Rôles et groupes : SSO sans second facteur", () => {
  it("la phrase s'affiche et l'enregistrement est indisponible quand les rôles sont allumés", async () => {
    const m = await ouvrir(OIDC, "sso");
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins");
    expect(el("[data-exiger-second-facteur]")?.textContent).toContain(
      "Exigez d'abord un second facteur (section 4).",
    );
    expect(enregistrer()?.disabled).toBe(true);
    await clic("#ent-enregistrer-fournisseur");
    expect(m.corps[PUT_SSO]).toBeUndefined();
    expect(m.mots).toEqual([]);
  });

  it("une exigence à un seul facteur (acr 1, amr pwd) laisse l'enregistrement indisponible, comme au serveur", async () => {
    const m = await ouvrir(OIDC, "sso");
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins");
    await saisir("#ent-acr", "1");
    await saisir("#ent-amr", "pwd");
    expect(el("[data-exiger-second-facteur]")?.textContent).toContain(
      "Exigez d'abord un second facteur (section 4).",
    );
    expect(enregistrer()?.disabled).toBe(true);
    await clic("#ent-enregistrer-fournisseur");
    expect(m.corps[PUT_SSO]).toBeUndefined();
  });

  it("rôles éteints : la section dit d'exiger un second facteur pour les donner, l'enregistrement reste disponible", async () => {
    const m = await ouvrir(OIDC, "sso");
    m.reponses[PUT_SSO] = [json(etat([OIDC]))];
    await ajouterAdmin("cn=admins");
    expect(el("[data-exiger-second-facteur]")?.textContent?.trim()).toBe(
      "Pour donner les rôles, exigez d'abord un second facteur (section 4).",
    );
    expect(el("[data-raison-enregistrer]")).toBeNull();
    expect(enregistrer()?.disabled).toBe(false);
    await clic("#ent-enregistrer-fournisseur");
    expect(m.corps[PUT_SSO]).toHaveLength(1);
  });

  it("rôles allumés : le pied du tiroir dit pourquoi Enregistrer est grisé, sans répéter la section 5", async () => {
    await ouvrir(OIDC, "sso");
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins");
    const pied = el("[data-raison-enregistrer]")?.textContent?.trim();
    expect(pied).toBe(
      "Enregistrement indisponible : groupes administrateurs sans second facteur exigé (section 5).",
    );
    expect(enregistrer()?.title).toBe(pied);
    expect(el("[data-exiger-second-facteur]")?.textContent?.trim()).not.toBe(pied);
  });

  it("niveaux exigés sans niveau qui prouve un second facteur (`loa-2 loa-5`) : enregistrement indisponible, quel que soit le nom des niveaux", async () => {
    const m = await ouvrir(OIDC, "sso");
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins");
    for (const acr of ["loa-2 loa-5", "2", "urn:gold mfa"]) {
      await saisir("#ent-acr", acr);
      expect(el("[data-exiger-second-facteur]")?.textContent, acr).toContain(
        "Exigez d'abord un second facteur (section 4).",
      );
      expect(enregistrer()?.disabled, acr).toBe(true);
      expect(el("[data-aide-second-facteur]")?.textContent?.trim(), acr).toBe(
        "⚠ Aucun second facteur garanti par Elpis.",
      );
    }
    await clic("#ent-enregistrer-fournisseur");
    expect(m.corps[PUT_SSO]).toBeUndefined();
  });

  it("déclarer un niveau qui prouve un second facteur rend l'enregistrement disponible et part dans le corps", async () => {
    const m = await ouvrir(OIDC, "sso");
    m.reponses[PUT_SSO] = [json(etat([OIDC]))];
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins");
    await saisir("#ent-acr", "loa-2 loa-5");
    await saisir("#ent-mfa-acr", "loa-5");
    expect(el("[data-exiger-second-facteur]")).toBeNull();
    expect(enregistrer()?.disabled).toBe(false);
    expect(el("[data-aide-second-facteur]")?.textContent?.trim()).toBe(
      "⚠ Second facteur exigé des administrateurs seulement : les autres comptes peuvent entrer avec acr loa-2.",
    );
    await clic("#ent-enregistrer-fournisseur");
    expect(envoye(m, PUT_SSO)).toMatchObject({ required_acr: ["loa-2", "loa-5"], mfa_acr: ["loa-5"] });
  });

  it("le 409 du serveur est affiché tel quel", async () => {
    const m = await ouvrir(SSO_2FA, "sso");
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins,dc=example");
    m.reponses[PUT_SSO] = [
      json({ detail: "Confirmez que les membres de ces groupes deviennent administrateurs." }, 409),
    ];
    await clic("#ent-enregistrer-fournisseur");
    expect(el("[role=alert].adm-field__warn:not([data-avertissement-admin])")?.textContent).toContain(
      "Confirmez que les membres de ces groupes deviennent administrateurs.",
    );
    expect(el("#ent-id")).not.toBeNull();
  });
});

describe("section Rôles et groupes : groupes Elpis", () => {
  it("une correspondance se compose avec la liste des groupes Elpis et part dans le corps", async () => {
    const m = await ouvrir(SSO_2FA, "sso");
    expect(tous<HTMLOptionElement>("#ent-map-groupe option").map((o) => o.textContent)).toEqual([
      "Groupe Elpis…",
      "développeurs",
      "support",
    ]);
    expect(el<HTMLButtonElement>("[data-map-ajouter]")?.disabled).toBe(true);
    await cocher(el<HTMLInputElement>("#ent-groupes-actif"));
    await saisir("#ent-map-externe", "cn=dev,dc=example");
    await saisir("#ent-map-groupe", "7");
    await clic("[data-map-ajouter]");
    expect(el("[data-correspondance]")?.textContent).toContain("cn=dev,dc=example");
    expect(el("[data-correspondance]")?.textContent).toContain("développeurs");
    m.reponses[PUT_SSO] = [json(etat([SSO_2FA]))];
    await clic("#ent-enregistrer-fournisseur");
    expect(envoye(m, PUT_SSO)["group_map"]).toEqual({
      enabled: true,
      map: [{ external: "cn=dev,dc=example", group_id: 7 }],
    });
    expect(m.mots).toEqual([]);
  });

  it("un groupe Elpis disparu reste lisible et une correspondance se retire", async () => {
    const enreg = {
      ...SSO_2FA,
      group_map: { enabled: true, map: [{ external: "cn=x", group_id: 99 }] },
    };
    await ouvrir(enreg, "sso");
    expect(el("[data-correspondance]")?.textContent).toContain("Groupe n°99");
    await clic('[aria-label="Retirer la correspondance cn=x"]');
    expect(el("[data-correspondance]")).toBeNull();
  });
});

const DROITS = {
  roles_enabled: true,
  groups_enabled: true,
  readable: true,
  role: "moderator" as const,
  groups: [{ id: 7, name: "développeurs" }],
  missing_group_ids: [] as number[],
  admin_ignored: false,
};

describe("lignesDroits", () => {
  it("rien sans option ni résultat", () => {
    expect(lignesDroits(null)).toEqual([]);
    expect(lignesDroits({ ...DROITS, roles_enabled: false, groups_enabled: false })).toEqual([]);
  });
  it("rôle et groupes obtenus", () => {
    expect(lignesDroits(DROITS)).toEqual(["Rôle obtenu : modérateur.", "Groupes Elpis : développeurs."]);
    expect(lignesDroits({ ...DROITS, groups: [] })[1]).toBe("Groupes Elpis : aucun.");
  });
  it("groupes absents : aucune autre ligne de droits", () => {
    expect(lignesDroits({ ...DROITS, readable: false })).toEqual([
      "Groupes absents ou illisibles : aucun rôle ni groupe ne serait modifié.",
    ]);
  });
  it("administrateurs ignorés et groupes Elpis disparus", () => {
    const l = lignesDroits({ ...DROITS, admin_ignored: true, missing_group_ids: [4, 5] });
    expect(l).toContain(
      "Les groupes administrateurs sont ignorés tant qu'un second facteur n'est pas exigé.",
    );
    expect(l).toContain("2 groupes Elpis de la correspondance n'existent plus.");
    expect(lignesDroits({ ...DROITS, missing_group_ids: [4] })).toContain(
      "1 groupe Elpis de la correspondance n'existe plus.",
    );
  });
});

describe("essai de connexion SSO : droits affichés", () => {
  it("montre le rôle et les groupes Elpis du résultat", async () => {
    const m = await ouvrir(SSO_2FA, "sso");
    m.A.authTrial.value = {
      at: 1,
      ok: true,
      claims: null,
      decision: { outcome: "login", username: "alice", reason: null },
      rights: DROITS,
      warnings: [],
    };
    await vider();
    const t = el("[data-droits-essai]")?.textContent ?? "";
    expect(t).toContain("Rôle obtenu : modérateur.");
    expect(t).toContain("Groupes Elpis : développeurs.");
  });
  it("sans droits dans le résultat, aucune ligne", async () => {
    const m = await ouvrir(SSO_2FA, "sso");
    m.A.authTrial.value = {
      at: 1,
      ok: true,
      claims: null,
      decision: { outcome: "login", username: "alice", reason: null },
      rights: null,
      warnings: [],
    };
    await vider();
    expect(el("[data-droits-essai]")).toBeNull();
  });
});

describe("page Comptes : rôle géré par le fournisseur", () => {
  const UTIL = [
    compteConsole(1, "root", { is_admin: 1 }),
    compteConsole(2, "alice", { is_admin: 2, role_managed: true }),
    compteConsole(3, "bob"),
  ];
  async function page() {
    const m = monter(etat([OIDC]), { page: "accounts", utilisateurs: UTIL });
    await m.A.loadEnterpriseAuth();
    await m.A.loadUsers();
    await vider();
    return m;
  }
  const ouvrirEdition = async (m: Awaited<ReturnType<typeof page>>, id: number): Promise<void> => {
    const u = m.A.usersList.value.find((x) => x.id === id);
    if (!u) throw new Error("compte absent");
    m.A.toggleUserEdit(u);
    await vider();
  };

  const OPTIONS = "[data-role-gere] select[data-user-edit-first] option";

  it("un modérateur géré garde un sélecteur limité à son rôle et au rôle inférieur, avec la mention", async () => {
    const m = await page();
    await ouvrirEdition(m, 2);
    const bloc = el("[data-role-gere]");
    expect(tous<HTMLOptionElement>(OPTIONS).map((o) => o.value)).toEqual(["moderator", "user"]);
    expect(bloc?.textContent).toContain("géré par le fournisseur");
    expect(bloc?.querySelector(".adm-pill")?.getAttribute("title")).toBe(
      "Le rôle de ce compte est donné par un groupe de votre fournisseur d'identité. Vous pouvez seulement le rétrograder ; il sera recalculé à sa prochaine connexion.",
    );
  });

  it("un administrateur géré peut descendre à tout rôle inférieur", async () => {
    const m = monter(etat([OIDC]), {
      page: "accounts",
      utilisateurs: [
        compteConsole(1, "root", { is_admin: 1 }),
        compteConsole(4, "carl", { is_admin: 1, role_managed: true }),
      ],
    });
    await m.A.loadEnterpriseAuth();
    await m.A.loadUsers();
    await vider();
    await ouvrirEdition(m, 4);
    expect(tous<HTMLOptionElement>(OPTIONS).map((o) => o.value)).toEqual(["admin", "moderator", "user"]);
  });

  it("un compte géré déjà utilisateur reste en lecture seule", async () => {
    const m = monter(etat([OIDC]), {
      page: "accounts",
      utilisateurs: [
        compteConsole(1, "root", { is_admin: 1 }),
        compteConsole(5, "dora", { is_admin: 0, role_managed: true }),
      ],
    });
    await m.A.loadEnterpriseAuth();
    await m.A.loadUsers();
    await vider();
    await ouvrirEdition(m, 5);
    expect(el("[data-role-gere]")?.textContent).toContain("Utilisateur");
    expect(el("[data-user-edit] select[data-user-edit-first]")).toBeNull();
  });

  it("la rétrogradation d'un rôle géré part au serveur", async () => {
    const m = await page();
    await ouvrirEdition(m, 2);
    m.reponses["POST /api/admin/users/2/role"] = [json({ ok: true, role: "user" })];
    await saisir("[data-role-gere] select[data-user-edit-first]", "user");
    await clic('[data-user-edit] button[type="submit"]');
    expect(m.corps["POST /api/admin/users/2/role"]?.[0]).toEqual({ role: "user" });
  });

  it("un compte non géré garde son sélecteur", async () => {
    const m = await page();
    await ouvrirEdition(m, 3);
    expect(el("[data-role-gere]")).toBeNull();
    expect(el("[data-user-edit] select[data-user-edit-first]")).not.toBeNull();
  });

  it("le 409 d'un changement de rôle affiche le détail du serveur", async () => {
    const m = await page();
    await ouvrirEdition(m, 3);
    m.reponses["POST /api/admin/users/3/role"] = [
      json(
        {
          detail:
            "Le rôle de ce compte est donné par votre fournisseur d'identité : vous pouvez seulement le rétrograder.",
        },
        409,
      ),
    ];
    await saisir("[data-user-edit] select[data-user-edit-first]", "moderator");
    await clic('[data-user-edit] button[type="submit"]');
    expect(m.toasts).toContain(
      "Le rôle de ce compte est donné par votre fournisseur d'identité : vous pouvez seulement le rétrograder.",
    );
  });
});
