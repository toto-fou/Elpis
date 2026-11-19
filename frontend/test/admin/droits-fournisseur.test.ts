// SPDX-License-Identifier: MIT
/** frontend/test/admin/droits-fournisseur.test.ts — console › fournisseur : section « Rôles et groupes » (repliée, éteinte, corps envoyés, confirmation par saisie, second facteur), essai de connexion avec droits, page Comptes (rôle géré, 409). */
import { afterEach, describe, expect, it } from "vitest";

import { lignesDroits } from "../../src/features/admin/identite";
import { reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import { json } from "../aides";
import {
  LDAP,
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
const PUT_IPA = "PUT /api/admin/auth/providers/ipa";
const SSO_2FA = { ...OIDC, required_acr: ["mfa"] };
const LDAP_ETEINT = { ...LDAP, enabled: false, active: false, tested: false };
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
    const m = await ouvrir(LDAP_ETEINT, "ipa");
    m.reponses["POST /api/admin/auth/providers/test"] = [json({ ok: true, complete: false, steps: [] })];
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

describe("section Rôles et groupes : SSO sans second facteur", () => {
  it("la phrase s'affiche et l'enregistrement est indisponible quand les rôles sont allumés", async () => {
    const m = await ouvrir(OIDC, "sso");
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins");
    expect(el("[data-exiger-second-facteur]")?.textContent).toContain(
      "Exigez d'abord une vérification en deux étapes pour ce fournisseur.",
    );
    expect(enregistrer()?.disabled).toBe(true);
    await clic("#ent-enregistrer-fournisseur");
    expect(m.corps[PUT_SSO]).toBeUndefined();
    expect(m.mots).toEqual([]);
  });

  it("exiger un niveau d'authentification rend l'enregistrement disponible", async () => {
    await ouvrir(OIDC, "sso");
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins");
    await saisir("details input.set-input.font-mono:not([placeholder])", "mfa");
    expect(el("[data-exiger-second-facteur]")).toBeNull();
    expect(enregistrer()?.disabled).toBe(false);
  });

  it("un annuaire n'est jamais bloqué", async () => {
    await ouvrir(LDAP_ETEINT, "ipa");
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins,dc=example");
    expect(el("[data-exiger-second-facteur]")).toBeNull();
    expect(enregistrer()?.disabled).toBe(false);
  });

  it("le 409 du serveur est affiché tel quel", async () => {
    const m = await ouvrir(LDAP_ETEINT, "ipa");
    await cocher(el<HTMLInputElement>("#ent-roles-actif"));
    await ajouterAdmin("cn=admins,dc=example");
    m.reponses[PUT_IPA] = [
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
    const m = await ouvrir(LDAP_ETEINT, "ipa");
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
    m.reponses[PUT_IPA] = [json(etat([LDAP_ETEINT]))];
    await clic("#ent-enregistrer-fournisseur");
    expect(envoye(m, PUT_IPA)["group_map"]).toEqual({
      enabled: true,
      map: [{ external: "cn=dev,dc=example", group_id: 7 }],
    });
    expect(m.mots).toEqual([]);
  });

  it("un groupe Elpis disparu reste lisible et une correspondance se retire", async () => {
    const enreg = {
      ...LDAP_ETEINT,
      group_map: { enabled: true, map: [{ external: "cn=x", group_id: 99 }] },
    };
    await ouvrir(enreg, "ipa");
    expect(el("[data-correspondance]")?.textContent).toContain("Groupe n°99");
    await clic('[aria-label="Retirer la correspondance cn=x"]');
    expect(el("[data-correspondance]")).toBeNull();
  });
});

describe("activation et essai", () => {
  it("une modification des droits demande d'enregistrer puis de tester avant d'activer", async () => {
    const prov = { ...LDAP_ETEINT, tested: false };
    const m = await ouvrir(prov, "ipa");
    expect(el<HTMLButtonElement>("#ent-activer")?.disabled).toBe(true);
    await cocher(el<HTMLInputElement>("#ent-groupes-actif"));
    m.reponses["POST /api/admin/auth/providers/test"] = [
      json({
        ok: true,
        complete: true,
        steps: [{ id: "a", label: "A", level: "ok", detail: "", target: null }],
      }),
    ];
    await clic("#ent-tester");
    expect(el("#ent-essai-enregistrer")?.textContent).toContain("Enregistrez ces réglages");
  });

  it("le Tester d'un annuaire montre les deux étapes de droits rendues par le serveur", async () => {
    const m = await ouvrir(LDAP_ETEINT, "ipa");
    m.reponses["POST /api/admin/auth/providers/test"] = [
      json({
        ok: true,
        complete: true,
        steps: [
          {
            id: "role_groups",
            label: "Groupes des rôles",
            level: "ok",
            detail: "2 groupes trouvés.",
            target: null,
          },
          {
            id: "test_user_rights",
            label: "Droits de l'utilisateur d'essai",
            level: "ok",
            detail: "Rôle obtenu : administrateur. Groupes Elpis (identifiants) : 7.",
            target: null,
          },
        ],
      }),
    ];
    await clic("#ent-tester");
    expect(el('[data-etape="role_groups"]')?.textContent).toContain("Groupes des rôles");
    expect(el('[data-etape="test_user_rights"]')?.textContent).toContain(
      "Rôle obtenu : administrateur. Groupes Elpis (identifiants) : 7.",
    );
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
  it("groupes illisibles : aucune autre ligne de droits", () => {
    expect(lignesDroits({ ...DROITS, readable: false })).toEqual([
      "Groupes non lisibles : aucun rôle ni groupe ne serait modifié.",
    ]);
  });
  it("administrateurs ignorés et groupes Elpis disparus", () => {
    const l = lignesDroits({ ...DROITS, admin_ignored: true, missing_group_ids: [4, 5] });
    expect(l).toContain(
      "Les groupes administrateurs sont ignorés tant qu'une vérification en deux étapes n'est pas exigée.",
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

describe("page Comptes : rôle géré par l'annuaire", () => {
  const UTIL = [
    compteConsole(1, "root", { is_admin: 1 }),
    compteConsole(2, "alice", { is_admin: 2, role_managed: true }),
    compteConsole(3, "bob"),
  ];
  async function page() {
    const m = monter(etat([LDAP]), { page: "accounts", utilisateurs: UTIL });
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

  it("remplace le sélecteur par le rôle en lecture seule et la mention", async () => {
    const m = await page();
    await ouvrirEdition(m, 2);
    const bloc = el("[data-role-gere]");
    expect(bloc?.textContent).toContain("Modérateur");
    expect(bloc?.textContent).toContain("géré par l'annuaire");
    expect(bloc?.querySelector(".adm-pill")?.getAttribute("title")).toBe(
      "Le rôle de ce compte est donné par un groupe de votre annuaire.",
    );
    expect(el("[data-user-edit] select[data-user-edit-first]")).toBeNull();
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
      json({ detail: "Le rôle de ce compte est géré par votre annuaire." }, 409),
    ];
    await saisir("[data-user-edit] select[data-user-edit-first]", "moderator");
    await clic('[data-user-edit] button[type="submit"]');
    expect(m.toasts).toContain("Le rôle de ce compte est géré par votre annuaire.");
  });
});
