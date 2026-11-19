// SPDX-License-Identifier: MIT
/** apps/core/test/securite-connexion-annuaire.test.ts — `/api/login-lite` avec un annuaire actif : sans annuaire la route est celle d'avant ; un compte local à mot de passe n'envoie jamais de mot de passe à l'annuaire ; seule la clé stable désigne le compte (aucun rattachement par nom) ; groupes illisibles = refus sans rien modifier ; tous les refus sont le même 401 ; aucun mot de passe dans un journal (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Minuteurs from "node:timers/promises";

import { createUser, dependancesParDefaut, revoquerOauthDuCompte } from "@elpis/auth";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PAR_NOM_ET_ADRESSE } from "../src/comptes/debit-connexion";
import { composer } from "../src/composition";
import { MOTEURS } from "./identite/banc";
import { AnnuaireFactice, BASE, GROUPE, UUID } from "./identite/annuaire/annuaire-factice";
import { ouvrirBancAnnuaire } from "./identite/annuaire/banc-annuaire";
import type { BancAnnuaire } from "./identite/annuaire/banc-annuaire";
import { appTest, journalMuet, lignesAuditRecentes, lignesJournal } from "./aides";

const suivi = vi.hoisted(() => ({ delais: [] as number[] }));

vi.mock("node:timers/promises", async (original) => {
  const reel = await original<typeof Minuteurs>();
  return {
    ...reel,
    setTimeout: (...a: Parameters<typeof reel.setTimeout>) => {
      suivi.delais.push(Number(a[0]));
      return Promise.resolve(a[1]);
    },
  };
});

const MDP = "Pl4nt3-Mdp-Reconnaissable";
const REFUS = { statusCode: 401, body: JSON.stringify({ detail: "invalid credentials" }) };

describe.each(MOTEURS)("connexion par l'annuaire (%s)", (moteur) => {
  let b: BancAnnuaire;
  let annuaire: AnnuaireFactice;
  let app: FastifyInstance;
  let racine: string;
  let audit: string;

  const ouvrir = async (extras: Record<string, unknown>[] = [{}]): Promise<void> => {
    annuaire = new AnnuaireFactice();
    annuaire.ajouter({ uid: "jean", cle: UUID(1), mdp: MDP, groupes: [GROUPE] });
    b = await ouvrirBancAnnuaire(moteur, extras, annuaire);
    audit = mkdtempSync(join(tmpdir(), "elpis-audit-ldap-"));
    racine = mkdtempSync(join(tmpdir(), "elpis-racine-ldap-"));
    await monter();
  };
  const monter = async (): Promise<void> => {
    await composerApp();
    configureAudit({ service: "main", auditDir: audit, hmacKeyPath: join(audit, "sans-cle") });
  };
  const composerApp = async (): Promise<void> => {
    const dep = {
      ...dependancesParDefaut(b.t.base),
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax" as const,
        https_only: true,
        max_age: 86400,
      }),
      secret: () => "secret-de-test",
      jetonService: () => "",
      revoquerOauth: (uid: number) => revoquerOauthDuCompte(b.t.base, uid, 1),
    };
    app = await appTest({
      ...(await composer("main", b.t.base, journalMuet, dep, racine, {
        fabriqueAnnuaire: annuaire.fabrique,
      })),
    });
  };
  const essai = (
    username: string,
    password: unknown,
    remoteAddress = "10.0.0.5",
  ): Promise<LightMyRequestResponse> =>
    app.inject({ method: "POST", url: "/api/login-lite", remoteAddress, payload: { username, password } });
  const cookie = (r: LightMyRequestResponse): string => {
    const brut = r.headers["set-cookie"];
    return ((Array.isArray(brut) ? brut[0] : brut) ?? "").split(";")[0] ?? "";
  };
  const moi = async (c: string): Promise<Record<string, unknown>> =>
    (await app.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: c } })).json();
  const utilisateurs = (): Promise<unknown[][]> => b.t.base.valeurs("SELECT username FROM users ORDER BY id");
  const refuse = (r: LightMyRequestResponse): { statusCode: number; body: string } => ({
    statusCode: r.statusCode,
    body: r.body,
  });
  const audits = (prefixe = "auth.login") => lignesAuditRecentes({ actionPrefix: prefixe });

  beforeEach(async () => {
    suivi.delais.length = 0;
    lignesJournal.length = 0;
    await ouvrir();
  });
  afterEach(async () => {
    await app.close();
    oublierConfigurationAudit();
    rmSync(audit, { recursive: true, force: true });
    rmSync(racine, { recursive: true, force: true });
    await b.fermer();
  });

  describe("sans annuaire actif : la route d'avant", () => {
    const sansAnnuaire: [string, () => void][] = [
      ["aucun fournisseur", () => b.cfg.ecrire({ auth: { providers: [] } })],
      [
        "fournisseur éteint",
        () =>
          b.cfg.ecrire({
            auth: {
              public_url: "https://elpis.exemple.lan",
              providers: [{ ...b.fournisseurs[0], enabled: false }],
            },
          }),
      ],
      [
        "fournisseur sans test réussi",
        () =>
          b.cfg.ecrire({
            auth: {
              public_url: "https://elpis.exemple.lan",
              providers: [{ ...b.fournisseurs[0], user_filter: "(&(uid={username})(x=y))" }],
            },
          }),
      ],
    ];
    it.each(sansAnnuaire)(
      "%s : mêmes réponses, même audit, aucun appel à l'annuaire, aucun délai ajouté",
      async (_n, regler) => {
        regler();
        await createUser(b.t.base, "alice", "mdp-alice-1");
        const bon = await essai("alice", "mdp-alice-1");
        expect([bon.statusCode, bon.json()]).toEqual([
          200,
          { ok: true, is_admin: false, must_change_password: false },
        ]);
        expect(cookie(bon)).not.toBe("");
        for (const nom of ["alice", "jean", "inconnu"]) {
          suivi.delais.length = 0;
          const r = await essai(nom, "faux");
          expect(refuse(r)).toEqual(REFUS);
          expect(r.headers["set-cookie"]).toBeUndefined();
          expect(suivi.delais).toEqual([]);
        }
        expect(annuaire.traces).toEqual([]);
        expect(audits("auth.login")[0]).toMatchObject({
          action: "auth.login.denied",
          details: { reason: "unknown_user" },
        });
        expect(audits("auth.login").map((e) => (e["details"] as Record<string, unknown>)["reason"])).toEqual([
          "unknown_user",
          "unknown_user",
          "bad_password",
          null,
        ]);
        expect((audits("auth.login")[3]?.["details"] as Record<string, unknown>)["login_method"]).toBe(
          "password",
        );
        expect(audits("auth.login")[0]?.["details"]).not.toHaveProperty("login_method");
      },
    );

    it("la clé du limiteur reste le nom tel que saisi (la casse ouvre un seau neuf)", async () => {
      b.cfg.ecrire({ auth: { providers: [] } });
      await createUser(b.t.base, "alice", "mdp-alice-1");
      for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite; i++) await essai("alice", "faux");
      expect((await essai("alice", "faux")).statusCode).toBe(429);
      expect((await essai("ALICE", "faux")).statusCode).toBe(401);
    });
  });

  describe("compte local à mot de passe local : l'annuaire n'est jamais appelé", () => {
    it.each([
      ["bon mot de passe", "mdp-local-1", 200],
      ["mauvais mot de passe", MDP, 401],
    ])("homonyme de l'annuaire, %s", async (_n, mdp, statut) => {
      await createUser(b.t.base, "jean", "mdp-local-1");
      const r = await essai("jean", mdp);
      expect(r.statusCode).toBe(statut);
      expect(annuaire.traces).toEqual([]);
      if (statut === 401) expect(refuse(r)).toEqual(REFUS);
    });

    it("le mot de passe de l'annuaire ne donne pas le compte local du même nom", async () => {
      await createUser(b.t.base, "jean", "mdp-local-1");
      expect((await essai("jean", MDP)).statusCode).toBe(401);
      expect(await utilisateurs()).toEqual([["chef"], ["jean"]]);
    });
  });

  describe("compte d'annuaire", () => {
    it("première connexion : compte créé, session `ldap:<id>`, mot de passe géré ailleurs ; seconde : même compte", async () => {
      const a = await essai("jean", MDP);
      expect([a.statusCode, a.json()]).toEqual([
        200,
        { ok: true, is_admin: false, must_change_password: false },
      ]);
      expect(await utilisateurs()).toEqual([["chef"], ["jean"]]);
      expect(await moi(cookie(a))).toMatchObject({
        logged_in: true,
        username: "jean",
        role: "user",
        password_managed: true,
      });
      const ev = audits("auth.login")[0];
      expect(ev).toMatchObject({
        action: "auth.login",
        username: "jean",
        details: { login_method: "ldap:annuaire" },
      });
      const b2 = await essai("jean", MDP, "10.0.0.6");
      expect(b2.statusCode).toBe(200);
      expect(await utilisateurs()).toEqual([["chef"], ["jean"]]);
      expect((await moi(cookie(b2)))["id"]).toBe((await moi(cookie(a)))["id"]);
      expect(await b.t.base.valeurs("SELECT user_id, linked_by FROM user_identities")).toHaveLength(1);
    });

    it("compte local : `password_managed` faux", async () => {
      await createUser(b.t.base, "alice", "mdp-alice-1");
      expect(await moi(cookie(await essai("alice", "mdp-alice-1")))).toMatchObject({
        password_managed: false,
      });
    });

    it("identifiant d'annuaire rebaptisé : retrouvé par la clé stable, même compte", async () => {
      const a = cookie(await essai("jean", MDP));
      annuaire.personnes[0]!.uid = "jean.dupont";
      const r = await essai("jean.dupont", MDP);
      expect(r.statusCode).toBe(200);
      expect(await utilisateurs()).toEqual([["chef"], ["jean"]]);
      expect((await moi(cookie(r)))["id"]).toBe((await moi(a))["id"]);
    });

    it.each([
      ["Jean-Dupont", "jean.dupont"],
      ["Jean-Dupont", "JEAN-DUPONT"],
      ["Jean_Dupont", "jean_dupont"],
    ])(
      "homonyme du compte local « %s » (annuaire : %s) : refus, aucun compte créé ni modifié",
      async (existant, ext) => {
        await createUser(b.t.base, existant, "mdp-local-1");
        annuaire.ajouter({ uid: ext, cle: UUID(9), mdp: MDP, groupes: [GROUPE] });
        const avant = await b.t.base.all("SELECT * FROM users ORDER BY id");
        const r = await essai(ext, MDP);
        expect(refuse(r)).toEqual(REFUS);
        expect(r.headers["set-cookie"]).toBeUndefined();
        expect(await b.t.base.all("SELECT * FROM users ORDER BY id")).toEqual(avant);
        expect(await b.t.base.valeurs("SELECT 1 FROM user_identities")).toEqual([]);
        expect(audits("auth.login")[0]).toMatchObject({
          details: { reason: "account_conflict", login_method: "ldap:annuaire" },
        });
        expect(audits("auth.identity.refused")[0]?.["details"]).toEqual({
          provider_id: "annuaire",
          reason: "account_conflict",
        });
      },
    );

    it("compte local de même nom à la casse près : l'annuaire décide, homonyme refusé", async () => {
      await createUser(b.t.base, "jean", "mdp-local-1");
      expect(refuse(await essai("JEAN", MDP))).toEqual(REFUS);
      expect(await utilisateurs()).toEqual([["chef"], ["jean"]]);
    });

    it("hors du groupe à la création : refus, aucun compte", async () => {
      annuaire.personnes[0]!.groupes = [];
      expect(refuse(await essai("jean", MDP))).toEqual(REFUS);
      expect(await utilisateurs()).toEqual([["chef"]]);
      expect(audits("auth.login")[0]).toMatchObject({ details: { reason: "not_in_group" } });
    });

    it("retiré du groupe : refus ET compte suspendu ; groupes illisibles : refus sans suspension ; remis : réactivé", async () => {
      const ouverte = cookie(await essai("jean", MDP));
      const etat = () =>
        b.t.base.get<{ suspended_at: number; suspended_by: string | null }>(
          "SELECT suspended_at, suspended_by FROM users WHERE username='jean'",
        );
      annuaire.personnes[0]!.groupes = [];
      expect(refuse(await essai("jean", MDP))).toEqual(REFUS);
      expect(await etat()).toMatchObject({ suspended_by: "directory:annuaire" });
      expect((await moi(ouverte))["logged_in"]).toBe(false);
      annuaire.personnes[0]!.groupes = [GROUPE];
      annuaire.groupesLisibles = false;
      const avant = await etat();
      expect(refuse(await essai("jean", MDP))).toEqual(REFUS);
      expect(await etat()).toEqual(avant);
      annuaire.groupesLisibles = true;
      const r = await essai("jean", MDP);
      expect(r.statusCode).toBe(200);
      expect(Number((await etat())?.suspended_at)).toBe(0);
      expect((await moi(cookie(r)))["logged_in"]).toBe(true);
      expect((await moi(ouverte))["logged_in"]).toBe(false);
    });

    it("groupes illisibles dès la première connexion : refus, aucun compte", async () => {
      annuaire.groupesLisibles = false;
      expect(refuse(await essai("jean", MDP))).toEqual(REFUS);
      expect(await utilisateurs()).toEqual([["chef"]]);
    });

    it("suspendu par un administrateur : refus même dans le groupe, la suspension reste", async () => {
      await essai("jean", MDP);
      await b.t.base.run("UPDATE users SET suspended_at=1, suspended_by='admin' WHERE username='jean'");
      expect(refuse(await essai("jean", MDP))).toEqual(REFUS);
      expect(await b.t.base.get("SELECT suspended_by FROM users WHERE username='jean'")).toEqual({
        suspended_by: "admin",
      });
    });

    it("fournisseur repointé vers un autre annuaire : refus, personne n'est rattaché", async () => {
      await essai("jean", MDP);
      await b.t.base.run("UPDATE user_identities SET issuer='ldap:ou=autre,dc=exemple,dc=lan#entryuuid'");
      expect(refuse(await essai("jean", MDP))).toEqual(REFUS);
      expect(audits("auth.login")[0]).toMatchObject({ details: { reason: "issuer_mismatch" } });
    });

    it("mot de passe vide : 400 comme avant, annuaire intact ; mot de passe de 1 025 octets : refus sans appel", async () => {
      expect((await essai("jean", "")).statusCode).toBe(400);
      expect(refuse(await essai("jean", "x".repeat(1025)))).toEqual(REFUS);
      expect(annuaire.traces).toEqual([]);
    });

    it("deux premières connexions simultanées : un seul compte", async () => {
      const [x, y] = await Promise.all([essai("jean", MDP, "10.0.0.7"), essai("jean", MDP, "10.0.0.8")]);
      expect([x.statusCode, y.statusCode]).toEqual([200, 200]);
      expect(await utilisateurs()).toEqual([["chef"], ["jean"]]);
      expect(await b.t.base.valeurs("SELECT 1 FROM user_identities")).toHaveLength(1);
    });
  });

  describe("états de l'entrée", () => {
    const freeipa = {
      preset: "freeipa",
      attrs: { id: "ipaUniqueID", username: "uid", email: "mail", name: "cn" },
    };
    beforeEach(async () => {
      await app.close();
      oublierConfigurationAudit();
      await b.fermer();
      await ouvrir([freeipa]);
    });
    it.each([
      [
        "verrouillée par l'administrateur",
        { nsaccountlock: ["TRUE"], krbpasswordexpiration: ["20990101000000Z"] },
        "entry_disabled",
      ],
      ["mot de passe expiré", { krbpasswordexpiration: ["20000101000000Z"] }, "password_expired"],
      [
        "état illisible",
        { nsaccountlock: ["?"], krbpasswordexpiration: ["20990101000000Z"] },
        "state_unknown",
      ],
    ])("%s : refus, aucun compte", async (_n, attrs, raison) => {
      annuaire.personnes[0]!.attrs = attrs;
      expect(refuse(await essai("jean", MDP))).toEqual(REFUS);
      expect(audits("auth.login")[0]).toMatchObject({ details: { reason: raison } });
      expect(await utilisateurs()).toEqual([["chef"]]);
    });
    it("verrouillage temporaire (Active Directory) : refus entry_locked", async () => {
      await app.close();
      oublierConfigurationAudit();
      await b.fermer();
      await ouvrir([
        {
          preset: "active-directory",
          attrs: { id: "objectGUID", username: "uid", email: "mail", name: "cn" },
        },
      ]);
      annuaire.personnes[0]!.attrs = {
        objectguid: [Buffer.alloc(16, 3)],
        useraccountcontrol: ["512"],
        "msds-user-account-control-computed": ["16"],
      };
      expect(refuse(await essai("jean", MDP))).toEqual(REFUS);
      expect(audits("auth.login")[0]).toMatchObject({ details: { reason: "entry_locked" } });
    });
  });

  describe("limiteur et compteur par entrée", () => {
    it("`JEAN`, `Jean` et `jean` partagent le même seau du limiteur quand un annuaire est actif", async () => {
      const noms = ["jean", "JEAN", "Jean", "jEAN"];
      for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite; i++) await essai(noms[i % noms.length]!, "faux");
      const r = await essai("jean", "faux");
      expect(r.statusCode).toBe(429);
    });

    it("seuil d'échecs de l'entrée atteint : l'annuaire n'est plus contacté, depuis une autre adresse comme depuis un autre process", async () => {
      await app.close();
      oublierConfigurationAudit();
      await b.fermer();
      await ouvrir([{ max_failures: 2, failure_window_sec: 900 }]);
      for (const ip of ["10.0.1.1", "10.0.1.2"])
        expect((await essai("jean", "faux", ip)).statusCode).toBe(401);
      const liaisons = annuaire.liaisonsUtilisateur.length;
      const autre = await essai("jean", MDP, "10.0.1.3");
      expect(refuse(autre)).toEqual(REFUS);
      expect(annuaire.liaisonsUtilisateur.length).toBe(liaisons);
      expect(audits("auth.login")[0]).toMatchObject({ details: { reason: "throttled" } });
      const appPrincipale = app;
      await monter();
      expect(refuse(await essai("jean", MDP, "10.0.1.4"))).toEqual(REFUS);
      expect(annuaire.liaisonsUtilisateur.length).toBe(liaisons);
      await appPrincipale.close();
    });

    it("annuaire injoignable : même 401, la tentative est rendue (jamais de 429)", async () => {
      annuaire.injoignable = true;
      for (let i = 0; i < PAR_NOM_ET_ADRESSE.capacite + 3; i++)
        expect(refuse(await essai("jean", MDP))).toEqual(REFUS);
      expect(audits("auth.login")[0]).toMatchObject({ details: { reason: "directory_unavailable" } });
    });

    it("identifiant présent dans deux annuaires : seul le premier est essayé", async () => {
      await app.close();
      oublierConfigurationAudit();
      await b.fermer();
      await ouvrir([{}, {}]);
      expect(refuse(await essai("jean", "faux"))).toEqual(REFUS);
      expect(annuaire.traces.every((t) => t.url === "ldaps://ldap.exemple.lan")).toBe(true);
    });
  });

  describe("refus indiscernables", () => {
    it("même code, même corps, aucun cookie ; délai plancher commun (local compris)", async () => {
      await createUser(b.t.base, "alice", "mdp-alice-1");
      await createUser(b.t.base, "Jean-Dupont", "mdp-local-1");
      annuaire.ajouter({ uid: "jean.dupont", cle: UUID(9), mdp: MDP, groupes: [GROUPE] });
      annuaire.ajouter({ uid: "hors", cle: UUID(8), mdp: MDP, groupes: [] });
      const cas: [string, string][] = [
        ["alice", "faux"],
        ["inconnu", "faux"],
        ["jean", "faux"],
        ["hors", MDP],
        ["jean.dupont", MDP],
        ["alice", "x".repeat(1025)],
      ];
      const reponses: { statusCode: number; body: string; type: unknown; longueur: unknown }[] = [];
      for (const [nom, mdp] of cas) {
        suivi.delais.length = 0;
        const debut = performance.now();
        const r = await essai(nom, mdp, `10.0.2.${reponses.length + 1}`);
        const ecoule = performance.now() - debut;
        expect(r.headers["set-cookie"], nom).toBeUndefined();
        const attente = suivi.delais.find((ms) => ms > 0 && ms <= 500) ?? 0;
        expect(attente + ecoule, nom).toBeGreaterThanOrEqual(499);
        reponses.push({
          statusCode: r.statusCode,
          body: r.body,
          type: r.headers["content-type"],
          longueur: r.headers["content-length"],
        });
      }
      expect(new Set(reponses.map((r) => JSON.stringify(r))).size).toBe(1);
      expect(reponses[0]).toMatchObject(REFUS);
    });
  });

  describe("comptes sans mot de passe local", () => {
    it("changer le mot de passe est refusé, `must_change_pwd` n'est jamais posé", async () => {
      const c = cookie(await essai("jean", MDP));
      const r = await app.inject({
        method: "POST",
        url: "/api/users/change-password",
        headers: { cookie: c, origin: "http://localhost:80", host: "localhost:80" },
        payload: { old_password: "x", new_password: "Nouveau-mdp-1234" },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json()).toEqual({ detail: "Votre mot de passe est géré par votre organisation." });
      expect(
        await b.t.base.get("SELECT pass_hash, must_change_pwd FROM users WHERE username='jean'"),
      ).toEqual({
        pass_hash: "!",
        must_change_pwd: 0,
      });
    });

    it("la session de l'annuaire ne survit pas au fournisseur éteint", async () => {
      const c = cookie(await essai("jean", MDP));
      expect((await moi(c))["logged_in"]).toBe(true);
      b.cfg.ecrire({
        auth: {
          public_url: "https://elpis.exemple.lan",
          providers: [{ ...b.fournisseurs[0], enabled: false }],
        },
      });
      expect((await moi(c))["logged_in"]).toBe(false);
    });
  });

  it("aucun mot de passe dans une ligne d'audit, un journal ou une réponse", async () => {
    const reponses: string[] = [];
    await createUser(b.t.base, "Marie-Curie", "mdp-local-1");
    annuaire.ajouter({ uid: "marie.curie", cle: UUID(7), mdp: MDP, groupes: [GROUPE] });
    annuaire.ajouter({ uid: "hors", cle: UUID(8), mdp: MDP, groupes: [] });
    for (const [nom, mdp] of [
      ["jean", MDP],
      ["jean", `${MDP}x`],
      ["marie.curie", MDP],
      ["hors", MDP],
      [MDP, MDP],
      ["inconnu", MDP],
    ] as const)
      reponses.push((await essai(nom, mdp)).body);
    annuaire.injoignable = true;
    reponses.push((await essai("jean", MDP, "10.0.3.1")).body);
    annuaire.injoignable = false;
    annuaire.groupesLisibles = false;
    reponses.push((await essai("jean", MDP, "10.0.3.2")).body);
    const fichiers = readdirSync(audit).map((f) => readFileSync(join(audit, f), "utf8"));
    const tout = [...fichiers, ...lignesJournal, ...reponses].join("\n");
    expect(tout).not.toContain(MDP);
    expect(fichiers.join("")).toContain("auth.login");
    expect(BASE).toBeTruthy();
  });
});
