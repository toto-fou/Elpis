// SPDX-License-Identifier: MIT
/** frontend/test/admin/rattachement.test.ts — console › Connexion d'entreprise : balayage de l'annuaire, assistant de rattachement des comptes existants, rattachements préparés d'un fournisseur SSO. */
import { afterEach, describe, expect, it } from "vitest";

import { reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import { json } from "../aides";
import {
  LDAP,
  OIDC,
  aMigrer,
  clic,
  compteConsole,
  demonter,
  el,
  etat,
  monter,
  proposition,
  retenus,
  saisir,
  sweep,
  tous,
  vider,
} from "./rattachement-aide";

afterEach(() => {
  demonter();
  reinitialiserSuiviChargement();
});

const MIG = "GET /api/admin/auth/providers/ipa/migration";
const LIEN = "POST /api/admin/auth/providers/ipa/migration/link";
const attendre = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function ouvrirPage(initial: unknown, opts: Parameters<typeof monter>[1] = {}) {
  const m = monter(initial, opts);
  await m.A.loadEnterpriseAuth();
  await vider();
  return m;
}

/** Empreinte de l'ensemble retenu, telle que le serveur la range avec la passe. */
const EMPREINTE = "0123456789abcdef0123456789abcdef";

describe("balayage de l'annuaire", () => {
  it("affiche « Jamais » quand aucune passe n'a eu lieu, seulement pour un annuaire actif", async () => {
    await ouvrirPage(
      etat([{ ...LDAP, sweep: null }, OIDC, { ...LDAP, id: "autre", active: false, enabled: false }]),
    );
    const blocs = tous("[data-balayage]");
    expect(blocs).toHaveLength(1);
    expect(blocs[0]?.textContent).toContain("Dernière vérification de l'annuaire : Jamais");
    expect(blocs[0]?.textContent).toContain("Vérifier maintenant");
  });

  it("affiche la date relative et les comptes vus, suspendus, réactivés, non lisibles", async () => {
    await ouvrirPage(etat([{ ...LDAP, sweep: sweep() }]));
    const t = el("[data-balayage-etat]")?.textContent ?? "";
    expect(t).toContain("il y a 10 min");
    expect(t).toContain("120 comptes vus");
    expect(t).toContain("2 suspendus");
    expect(t).toContain("1 réactivé");
    expect(t).toContain("3 non lisibles");
    expect(el("[data-balayage-abandon]")).toBeNull();
    expect(el("[data-balayage-retenues]")).toBeNull();
  });

  it("une passe abandonnée dit que rien n'a été modifié, une phrase par raison", async () => {
    const cas: [string, string][] = [
      ["group_missing", "Un groupe requis est introuvable dans l'annuaire : aucun compte n'a été modifié."],
      ["secret_missing", "Le secret du compte de service est à ressaisir."],
      ["directory_unreachable", "Annuaire injoignable."],
      [
        "users_unreadable",
        "Le compte de service ne peut plus lire les entrées des utilisateurs : aucun compte n'a été modifié.",
      ],
      ["membership_unreadable", "ne peut plus lire l'appartenance aux groupes requis"],
      ["raison_inconnue", "aucun compte n'a été modifié"],
    ];
    for (const [raison, phrase] of cas) {
      demonter();
      await ouvrirPage(etat([{ ...LDAP, sweep: sweep({ aborted: raison }) }]));
      const t = el("[data-balayage-abandon]")?.textContent ?? "";
      expect(t).toContain(phrase);
      expect(t).toContain("n'a été modifié");
      expect(t).not.toContain(raison);
    }
  });

  it("« Vérifier maintenant » envoie la demande puis recharge l'état", async () => {
    const m = await ouvrirPage(etat([{ ...LDAP, sweep: null }]));
    m.reponses["POST /api/admin/auth/providers/ipa/sweep"] = [json(sweep())];
    m.reponses["GET /api/admin/auth"] = [json(etat([{ ...LDAP, sweep: sweep({ seen: 7 }) }]))];
    await clic("[data-balayage-lancer]");
    expect(m.appels).toContain("POST /api/admin/auth/providers/ipa/sweep");
    expect(m.appels.filter((a) => a === "GET /api/admin/auth")).toHaveLength(2);
    expect(el("[data-balayage-etat]")?.textContent).toContain("7 comptes vus");
  });

  it("un 409 dit qu'une vérification est déjà en cours", async () => {
    const m = await ouvrirPage(etat([{ ...LDAP, sweep: null }]));
    m.reponses["POST /api/admin/auth/providers/ipa/sweep"] = [json({ detail: "occupé" }, 409)];
    await clic("[data-balayage-lancer]");
    expect(el("[data-balayage-message]")?.textContent).toContain("Une vérification est déjà en cours.");
  });

  it("des suspensions retenues proposent de désactiver, après saisie du nombre", async () => {
    const m = await ouvrirPage(
      etat([
        { ...LDAP, sweep: sweep({ pending: 3, held: retenus(3), held_total: 3, held_hash: EMPREINTE }) },
      ]),
    );
    const t = el("[data-balayage-retenues]")?.textContent ?? "";
    expect(t).toContain("3 comptes ne sont plus dans l'annuaire ou dans un groupe requis.");
    expect(t).toContain("Par précaution, aucun n'a été désactivé.");
    expect(el("[data-balayage-confirmer]")?.textContent).toContain("Désactiver ces 3 comptes");
    m.reponses["POST /api/admin/auth/providers/ipa/sweep/confirm"] = [json(sweep())];
    await clic("[data-balayage-confirmer]");
    expect(m.mots).toEqual(["3"]);
    expect(m.corps["POST /api/admin/auth/providers/ipa/sweep/confirm"]).toEqual([
      { user_ids: [1, 2, 3], held_hash: EMPREINTE },
    ]);
  });

  it("la liste des comptes retenus est montrée avec une raison en clair, et seuls ces comptes sont confirmés", async () => {
    const held = [
      { user_id: 5, username: "eve", reason: "entry_missing" },
      { user_id: 9, username: "bob", reason: "entry_disabled" },
      { user_id: 12, username: "zoe", reason: "not_in_group" },
    ];
    const m = await ouvrirPage(
      etat([{ ...LDAP, sweep: sweep({ pending: 3, held, held_total: 3, held_hash: EMPREINTE }) }]),
    );
    const l = tous("[data-balayage-compte]").map((x) => x.textContent?.replace(/\s+/g, " ").trim());
    expect(l).toEqual([
      "eve · entrée introuvable",
      "bob · entrée désactivée",
      "zoe · hors des groupes requis",
    ]);
    expect(el("[data-balayage-autres]")).toBeNull();
    m.reponses["POST /api/admin/auth/providers/ipa/sweep/confirm"] = [json(sweep())];
    await clic("[data-balayage-confirmer]");
    expect(m.corps["POST /api/admin/auth/providers/ipa/sweep/confirm"]).toEqual([
      { user_ids: [5, 9, 12], held_hash: EMPREINTE },
    ]);
  });

  it("liste incomplète : « et N autres », phrase dédiée, confirmation indisponible", async () => {
    const m = await ouvrirPage(
      etat([
        {
          ...LDAP,
          sweep: sweep({ pending: 250, held: retenus(200), held_total: 250, held_hash: EMPREINTE }),
        },
      ]),
    );
    expect(tous("[data-balayage-compte]")).toHaveLength(200);
    expect(el("[data-balayage-autres]")?.textContent).toContain("et 50 autres");
    expect(el("[data-balayage-trop]")?.textContent).toContain(
      "Trop de comptes pour une confirmation ici : vérifiez l'annuaire, puis relancez la vérification.",
    );
    expect(el("[data-balayage-confirmer]")).toBeNull();
    await m.A.balayageConfirmer("ipa", m.A.authEtat.value!.providers[0]!.sweep!);
    expect(m.appels.some((a) => a.includes("/sweep/confirm"))).toBe(false);
    expect(m.mots).toEqual([]);
  });

  it("des départs observés une fois sont annoncés sans bouton", async () => {
    await ouvrirPage(
      etat([
        {
          ...LDAP,
          sweep: sweep({
            observed: [
              { user_id: 4, reason: "entry_missing", at: 1_800_000_000 },
              { user_id: 6, reason: "not_in_group", at: 1_800_000_000 },
            ],
          }),
        },
      ]),
    );
    expect(el("[data-balayage-observes]")?.textContent).toContain(
      "2 comptes paraissent partis ; ils seront désactivés s'ils le sont encore à la prochaine vérification.",
    );
    expect(el("[data-balayage-confirmer]")).toBeNull();
  });

  it("un refus de la saisie n'envoie rien", async () => {
    const m = await ouvrirPage(
      etat([
        { ...LDAP, sweep: sweep({ pending: 3, held: retenus(3), held_total: 3, held_hash: EMPREINTE }) },
      ]),
      { accepter: false },
    );
    await clic("[data-balayage-confirmer]");
    expect(m.mots).toEqual(["3"]);
    expect(m.appels.some((a) => a.includes("/sweep/confirm"))).toBe(false);
  });

  it("un 409 à la confirmation recharge l'état et dit que la situation a changé", async () => {
    const m = await ouvrirPage(
      etat([
        { ...LDAP, sweep: sweep({ pending: 3, held: retenus(3), held_total: 3, held_hash: EMPREINTE }) },
      ]),
    );
    m.reponses["POST /api/admin/auth/providers/ipa/sweep/confirm"] = [json({ detail: "x" }, 409)];
    m.reponses["GET /api/admin/auth"] = [
      json(
        etat([
          { ...LDAP, sweep: sweep({ pending: 4, held: retenus(4), held_total: 4, held_hash: EMPREINTE }) },
        ]),
      ),
    ];
    await clic("[data-balayage-confirmer]");
    expect(el("[data-balayage-message]")?.textContent).toContain(
      "La situation a changé, vérifiez à nouveau.",
    );
    expect(el("[data-balayage-retenues]")?.textContent).toContain("4 comptes");
  });
});

describe("assistant de rattachement", () => {
  const LIGNES = {
    items: [
      aMigrer(2, "alice", "user", proposition()),
      aMigrer(3, "bob", "user", proposition({ subject: "uid-2", ext_username: "bob", state: "verrouillee" })),
      aMigrer(4, "carole", "user", proposition({ subject: "uid-3", in_required_group: false })),
      aMigrer(5, "dan", "user", proposition({ subject: "uid-4", in_required_group: null })),
      aMigrer(6, "eve", "user", null),
    ],
    total: 5,
    offset: 0,
    limit: 100,
  };

  async function ouvrirAssistant(reponse: Response = json(LIGNES)) {
    const m = await ouvrirPage(etat([{ ...LDAP, sweep: null }]));
    m.reponses[MIG] = [reponse];
    await clic("[data-rattacher]");
    return m;
  }

  it("liste les comptes locaux avec la proposition ou « Aucune entrée de ce nom »", async () => {
    const m = await ouvrirAssistant();
    expect(m.appels).toContain("GET /api/admin/auth/providers/ipa/migration?offset=0&limit=100");
    const lignes = tous("[data-ratt-ligne]");
    expect(lignes).toHaveLength(5);
    const t0 = lignes[0]?.textContent ?? "";
    expect(t0).toContain("alice");
    expect(t0).toContain("Alice Martin");
    expect(t0).toContain("alice@example.lan");
    expect(t0).toContain("Active");
    expect(t0).toContain("Dans un groupe requis : oui");
    expect(lignes[2]?.textContent).toContain("Dans un groupe requis : non");
    expect(lignes[3]?.textContent).toContain("Dans un groupe requis : inconnu");
    expect(lignes[4]?.textContent).toContain("Aucune entrée de ce nom.");
    expect(el("[data-ratt-phrase]")?.textContent).toContain(
      "Le mot de passe local de ces comptes sera retiré et leurs sessions fermées. Ils se connecteront avec leur identifiant d'annuaire.",
    );
  });

  it("seule une entrée active et dans un groupe requis est cochable", async () => {
    await ouvrirAssistant();
    const cases = tous<HTMLInputElement>("[data-ratt-case]");
    expect(cases.map((c) => c.disabled)).toEqual([false, true, true, true, true]);
  });

  it("le bouton est désactivé à 0 et compte les lignes cochées", async () => {
    await ouvrirAssistant();
    const b = el<HTMLButtonElement>("[data-ratt-valider]");
    expect(b?.disabled).toBe(true);
    expect(b?.textContent?.trim()).toBe("Rattacher 0 compte");
    tous<HTMLInputElement>("[data-ratt-case]")[0]?.click();
    await vider();
    expect(b?.disabled).toBe(false);
    expect(b?.textContent?.trim()).toBe("Rattacher 1 compte");
  });

  it("la recherche demande 3 caractères, envoie la requête et le choix devient la proposition", async () => {
    const m = await ouvrirAssistant();
    await clic("[data-ratt-ligne]:nth-child(5) [data-ratt-chercher]");
    await saisir("[data-ratt-recherche-champ]", "ev");
    await clic("[data-ratt-recherche-lancer]");
    expect(el("[data-ratt-recherche]")?.textContent).toContain("3 caractères au moins");
    expect(m.appels.some((a) => a.includes("/migration/search"))).toBe(false);
    m.reponses["POST /api/admin/auth/providers/ipa/migration/search"] = [
      json({ items: [proposition({ subject: "uid-9", ext_username: "eve", ext_name: "Eve Durand" })] }),
    ];
    await saisir("[data-ratt-recherche-champ]", "eve");
    await clic("[data-ratt-recherche-lancer]");
    expect(m.corps["POST /api/admin/auth/providers/ipa/migration/search"]).toEqual([{ query: "eve" }]);
    expect(el("[data-ratt-resultat]")?.textContent).toContain("Eve Durand");
    await clic("[data-ratt-choisir]");
    const ligne = tous("[data-ratt-ligne]")[4];
    expect(ligne?.textContent).toContain("Eve Durand");
    expect(ligne?.textContent).not.toContain("Aucune entrée de ce nom.");
    expect(ligne?.querySelector<HTMLInputElement>("[data-ratt-case]")?.disabled).toBe(false);
  });

  it("envoie les liens cochés après une confirmation sur place, puis dit le résultat de chaque ligne", async () => {
    const m = await ouvrirAssistant();
    tous<HTMLInputElement>("[data-ratt-case]")[0]?.click();
    await vider();
    const b = el<HTMLButtonElement>("[data-ratt-valider]");
    b?.click();
    await vider();
    expect(m.appels.some((a) => a.includes("/migration/link"))).toBe(false);
    expect(el("[data-ratt-annuler]")).not.toBeNull();
    expect(el("[data-ratt-valider]")).toBe(b);
    m.reponses[LIEN] = [
      json({ results: [{ user_id: 2, subject: "uid-1", result: "entry_already_linked" }] }),
    ];
    await attendre(450);
    b?.click();
    await vider();
    expect(m.corps[LIEN]).toEqual([
      { links: [{ user_id: 2, subject: "uid-1" }], confirm_admins: [], keep_tokens: false },
    ]);
    expect(tous("[data-ratt-ligne]")[0]?.textContent).toContain(
      "Cette entrée est déjà rattachée à un autre compte.",
    );
    expect(el("[data-ratt-resume]")?.textContent).toContain("Aucun compte n'a été rattaché.");
  });

  it("la case des jetons est décochée par défaut ; cochée, elle envoie keep_tokens", async () => {
    const m = await ouvrirAssistant();
    const garder = el<HTMLInputElement>("[data-ratt-garder-jetons]");
    expect(garder?.checked).toBe(false);
    expect(garder?.closest("label")?.textContent).toContain(
      "Conserver les jetons d'API et les accès des applications de ces comptes",
    );
    garder?.click();
    tous<HTMLInputElement>("[data-ratt-case]")[0]?.click();
    await vider();
    el("[data-ratt-valider]")?.click();
    await vider();
    await attendre(450);
    m.reponses[LIEN] = [json({ results: [{ user_id: 2, subject: "uid-1", result: "linked", kept: true }] })];
    el("[data-ratt-valider]")?.click();
    await vider();
    expect(m.corps[LIEN]).toEqual([
      { links: [{ user_id: 2, subject: "uid-1" }], confirm_admins: [], keep_tokens: true },
    ]);
  });

  it("le résultat dit les jetons et accès révoqués quand le serveur les rend", async () => {
    const m = await ouvrirAssistant();
    tous<HTMLInputElement>("[data-ratt-case]")[0]?.click();
    await vider();
    el("[data-ratt-valider]")?.click();
    await vider();
    await attendre(450);
    m.reponses[LIEN] = [
      json({
        results: [{ user_id: 2, subject: "uid-1", result: "linked", revoked_tokens: 2, revoked_oauth: 1 }],
      }),
    ];
    el("[data-ratt-valider]")?.click();
    await vider();
    expect(el("[data-ratt-resume]")?.textContent).toContain("1 compte rattaché.");
    expect(el("[data-ratt-resume]")?.textContent).toContain(
      "Révoqués : 2 jetons d'API, 1 accès d'application.",
    );
  });

  it("une entrée qui ne peut pas se connecter est dite en clair", async () => {
    const m = await ouvrirAssistant();
    tous<HTMLInputElement>("[data-ratt-case]")[0]?.click();
    await vider();
    el("[data-ratt-valider]")?.click();
    await vider();
    await attendre(450);
    m.reponses[LIEN] = [json({ results: [{ user_id: 2, subject: "uid-1", result: "entry_not_loginable" }] })];
    el("[data-ratt-valider]")?.click();
    await vider();
    expect(tous("[data-ratt-ligne]")[0]?.textContent).toContain(
      "Cette entrée ne peut pas se connecter avec les réglages de cet annuaire.",
    );
  });

  it("une ligne rattachée quitte la liste au rechargement", async () => {
    const m = await ouvrirAssistant();
    tous<HTMLInputElement>("[data-ratt-case]")[0]?.click();
    await vider();
    el("[data-ratt-valider]")?.click();
    await vider();
    await attendre(450);
    m.reponses[LIEN] = [json({ results: [{ user_id: 2, subject: "uid-1", result: "linked" }] })];
    m.reponses[MIG] = [json({ ...LIGNES, items: LIGNES.items.slice(1), total: 4 })];
    el("[data-ratt-valider]")?.click();
    await vider();
    expect(tous("[data-ratt-ligne]")).toHaveLength(4);
    expect(el("[data-ratt-resume]")?.textContent).toContain("1 compte rattaché.");
  });

  it("une phrase par raison de refus, une phrase générique pour une raison inconnue", async () => {
    const m = await ouvrirAssistant();
    const cases = tous<HTMLInputElement>("[data-ratt-case]");
    cases[0]?.click();
    await vider();
    el("[data-ratt-valider]")?.click();
    await vider();
    await attendre(450);
    m.reponses[LIEN] = [json({ results: [{ user_id: 2, subject: "uid-1", result: "last_local_admin" }] })];
    el("[data-ratt-valider]")?.click();
    await vider();
    expect(tous("[data-ratt-ligne]")[0]?.textContent).toContain(
      "Dernier administrateur à mot de passe local : gardez-le comme accès de secours.",
    );
    tous<HTMLInputElement>("[data-ratt-case]")[0]?.click();
    await vider();
    el("[data-ratt-valider]")?.click();
    await vider();
    await attendre(450);
    m.reponses[LIEN] = [json({ results: [{ user_id: 2, subject: "uid-1", result: "autre_chose" }] })];
    el("[data-ratt-valider]")?.click();
    await vider();
    expect(tous("[data-ratt-ligne]")[0]?.textContent).toContain("Rattachement impossible pour ce compte.");
  });

  it("503 : annuaire injoignable ; 409 : annuaire non activé", async () => {
    await ouvrirAssistant(json({ detail: "x" }, 503));
    expect(el("[data-ratt-erreur]")?.textContent).toContain("Annuaire injoignable, réessayez.");
    demonter();
    await ouvrirAssistant(json({ detail: "x" }, 409));
    expect(el("[data-ratt-erreur]")?.textContent).toContain("Cet annuaire n'est pas activé.");
  });

  it("la liste est paginée par 100", async () => {
    const m = await ouvrirAssistant(json({ ...LIGNES, total: 230 }));
    expect(el("[data-ratt-precedent]")?.hasAttribute("disabled")).toBe(true);
    m.reponses[MIG] = [json({ ...LIGNES, total: 230, offset: 100 })];
    await clic("[data-ratt-suivant]");
    expect(m.appels).toContain("GET /api/admin/auth/providers/ipa/migration?offset=100&limit=100");
  });
});

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
    compteConsole(3, "bob", { identity: { provider_id: "ipa", ext_username: "bob", linked_at: 1 } }),
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

  it("n'apparaît pas pour un annuaire LDAP", async () => {
    const m = monter(etat([LDAP]));
    await m.A.loadEnterpriseAuth();
    m.A.authModifier("ipa");
    await vider();
    expect(el("[data-prelinks]")).toBeNull();
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
