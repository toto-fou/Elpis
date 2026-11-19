// SPDX-License-Identifier: MIT
/** apps/core/test/securite-roles-annuaire.test.ts — le rôle et les groupes Elpis donnés par l'annuaire ou le SSO : options éteintes sans effet, « inconnu » jamais « non », correspondance exacte, montée à la connexion seulement, rétrogradation sans session survivante, rôle géré non modifiable à la main, administrateur refusé sans second facteur ni confirmation (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as Minuteurs from "node:timers/promises";

import {
  createExternalUser,
  createGroup,
  createUser,
  dependancesParDefaut,
  ligneUtilisateur,
  revoquerOauthDuCompte,
} from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { schemaReponseComptesConsole, schemaReponseDernierEssai } from "@elpis/contracts";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composer } from "../src/composition";
import { creerFamilleAdminComptes } from "../src/familles/admin-comptes";
import { ancreIdentite } from "../src/identite/ancre";
import { balayerAnnuaire } from "../src/identite/annuaire/balayage";
import type { DependancesBalayage } from "../src/identite/annuaire/balayage";
import type { FabriqueConnexion } from "../src/identite/annuaire/client";
import { ErreurAnnuaire } from "../src/identite/annuaire/erreur";
import { decider, lectureOidc } from "../src/identite/correspondance";
import {
  empreinteFournisseur,
  enregistrerTestReussi,
  fournisseursActifs,
} from "../src/identite/fournisseurs";
import { resultatEssaiBlanc } from "../src/identite/oidc/essai-blanc";
import { validerFournisseur } from "../src/identite/reglages";
import type { FournisseurLdap } from "../src/identite/reglages";
import { diagnostiquerAuth } from "../src/exploitation/identite-doctor";
import { appTest, journalMuet, lignesAuditRecentes, lignesJournal } from "./aides";
import { AnnuaireFactice, GROUPE, UUID } from "./identite/annuaire/annuaire-factice";
import { ouvrirBancAnnuaire, URL_PUBLIQUE as URL_ANNUAIRE } from "./identite/annuaire/banc-annuaire";
import type { BancAnnuaire } from "./identite/annuaire/banc-annuaire";
import { MOTEURS, ouvrirBanc } from "./identite/banc";
import type { Banc } from "./identite/banc";
import { ELPIS, ouvrirBancOidc } from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { ldapValide, oidcValide } from "./identite/aides";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

vi.mock("node:timers/promises", async (original) => {
  const reel = await original<typeof Minuteurs>();
  return { ...reel, setTimeout: (...a: Parameters<typeof reel.setTimeout>) => Promise.resolve(a[1]) };
});

const MDP = "Pl4nt3-Mdp-Reconnaissable";
const G_ADMIN = "cn=admins,cn=groups,dc=exemple,dc=lan";
const G_MOD = "cn=moderateurs,cn=groups,dc=exemple,dc=lan";
const G_HOMONYME = "cn=admins,cn=groups,dc=autre,dc=lan";
const G_EQUIPE = "cn=equipe,cn=groups,dc=exemple,dc=lan";
const NIVEAU = { user: 0, admin: 1, moderator: 2 } as const;
let adresses = 0;
let depart = 0;
const adresseNeuve = (): string => `10.9.${(adresses >> 8) & 255}.${++adresses & 255}`;

describe.each(MOTEURS)("rôles et groupes par l'annuaire LDAP (%s)", (moteur) => {
  let b: BancAnnuaire;
  let annuaire: AnnuaireFactice;
  let app: FastifyInstance;
  let racine: string;
  let audit: string;
  let verrous: string;
  let courant: FournisseurLdap;
  let gEquipe: number;
  let gAutre: number;
  let publiees: number[];
  const enPanne = new Set<string>();

  const fabrique: FabriqueConnexion = async (f, url) => {
    const c = await annuaire.fabrique(f, url);
    return {
      ...c,
      chercher: (base, o) =>
        enPanne.has(base)
          ? Promise.reject(new ErreurAnnuaire("protocole", { code: 50 }))
          : c.chercher(base, o),
    };
  };
  const monter = async (): Promise<void> => {
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
      ...(await composer("main", b.t.base, journalMuet, dep, racine, { fabriqueAnnuaire: fabrique })),
    });
  };
  /** Réglages du fournisseur remplacés, test réussi retenu sur ces réglages. */
  const regler = async (extra: Record<string, unknown>): Promise<void> => {
    courant = validerFournisseur({ ...courant, ...extra }) as FournisseurLdap;
    await enregistrerTestReussi(b.t.base, courant, URL_ANNUAIRE);
    b.cfg.ecrire({ auth: { public_url: URL_ANNUAIRE, providers: [courant] } });
  };
  const roles = (enabled = true, admin = [G_ADMIN], moderateur = [G_MOD]) => ({
    roles: { enabled, admin_groups: admin, moderator_groups: moderateur },
  });
  const carte = (enabled = true, map = [{ external: G_EQUIPE, group_id: gEquipe }]) => ({
    group_map: { enabled, map },
  });
  const personne = (uid: string, n: number, groupes: string[] = []) =>
    annuaire.ajouter({ uid, cle: UUID(n), mdp: MDP, groupes: [GROUPE, ...groupes] });
  const connexion = (uid: string, mdp = MDP): Promise<LightMyRequestResponse> =>
    app.inject({
      method: "POST",
      url: "/api/login-lite",
      remoteAddress: adresseNeuve(),
      payload: { username: uid, password: mdp },
    });
  const cookie = (r: LightMyRequestResponse): string => {
    const brut = r.headers["set-cookie"];
    return ((Array.isArray(brut) ? brut[0] : brut) ?? "").split(";")[0] ?? "";
  };
  const connecte = async (uid: string): Promise<string> => {
    const r = await connexion(uid);
    expect(r.statusCode, r.body).toBe(200);
    return cookie(r);
  };
  const moi = async (c: string): Promise<Record<string, unknown>> =>
    (await app.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: c } })).json();
  const niveau = async (nom: string): Promise<number> =>
    Number(
      (await b.t.base.get<{ is_admin: number }>("SELECT is_admin FROM users WHERE username=?", [nom]))
        ?.is_admin,
    );
  const idDe = async (nom: string): Promise<number> =>
    Number((await b.t.base.get<{ id: number }>("SELECT id FROM users WHERE username=?", [nom]))?.id);
  const groupesDe = async (nom: string): Promise<number[]> =>
    (
      await b.t.base.valeurs<[number]>(
        "SELECT group_id FROM user_groups WHERE user_id=(SELECT id FROM users WHERE username=?) ORDER BY group_id",
        [nom],
      )
    ).map(([g]) => Number(g));
  const audits = (action: string) =>
    lignesAuditRecentes({ actionPrefix: action })
      .filter((l) => l["action"] === action && Number(l["ts"]) >= depart)
      .reverse();
  const dep = (): DependancesBalayage => ({
    base: b.t.base,
    fabrique,
    maintenant: () => b.horloge,
    cookieSecure: () => true,
    journal: journalMuet,
    cheminVerrou: (id) => join(verrous, `${id}.lock`),
    etat: {
      base: b.t.base,
      acces: dependancesParDefaut(b.t.base),
      maintenant: () => b.horloge,
      publierSuspension: async (uid) => (publiees.push(uid), true),
      journal: journalMuet,
    },
  });
  const passe = async () => {
    const r = await balayerAnnuaire(dep(), courant);
    if (r.type !== "bilan") throw new Error(`pas de bilan : ${r.type}`);
    return r.etat;
  };
  /** Compte externe rattaché à une personne de l'annuaire (déjà là avant la passe). */
  const rattacher = async (uid: string, n: number, groupes: string[] = []): Promise<number> => {
    const p = personne(uid, n, groupes);
    const id = await createExternalUser(b.t.base, uid, { maintenant: b.horloge - 1000 });
    await b.t.base.run(
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at, checked_at) VALUES(?,?,?,?,?,?,?)",
      [id, courant.id, p.cle, ancreIdentite(courant), "auto", b.horloge - 1000, 5],
    );
    return id;
  };
  const poserRole = (uid: number, n: number) =>
    b.t.base.run("UPDATE users SET is_admin=? WHERE id=?", [n, uid]);
  const poserGroupe = (uid: number, g: number) =>
    b.t.base.run("INSERT INTO user_groups(user_id, group_id) VALUES(?,?)", [uid, g]);

  beforeEach(async () => {
    depart = Date.now() / 1000 - 0.001;
    lignesJournal.length = 0;
    enPanne.clear();
    publiees = [];
    annuaire = new AnnuaireFactice();
    for (const g of [G_ADMIN, G_MOD, G_HOMONYME, G_EQUIPE]) annuaire.groupesExistants.add(g);
    b = await ouvrirBancAnnuaire(moteur, [{}], annuaire);
    courant = b.fournisseurs[0] as FournisseurLdap;
    gEquipe = await createGroup(b.t.base, "Equipe");
    gAutre = await createGroup(b.t.base, "Autre");
    audit = mkdtempSync(join(tmpdir(), "elpis-audit-roles-"));
    racine = mkdtempSync(join(tmpdir(), "elpis-racine-roles-"));
    verrous = mkdtempSync(join(tmpdir(), "elpis-verrous-roles-"));
    configureAudit({ service: "main", auditDir: audit, hmacKeyPath: join(audit, "sans-cle") });
    await monter();
  });
  afterEach(async () => {
    await app.close();
    oublierConfigurationAudit();
    for (const d of [audit, racine, verrous]) rmSync(d, { recursive: true, force: true });
    await b.fermer();
  });

  describe("options éteintes", () => {
    it("rien ne change pour personne : ni rôle, ni groupe, ni audit, ni recherche des groupes", async () => {
      await regler({ ...roles(false), ...carte(false) });
      personne("jean", 1, [G_ADMIN, G_EQUIPE]);
      await connecte("jean");
      expect(await niveau("jean")).toBe(0);
      expect(await groupesDe("jean")).toEqual([]);
      const jean = await idDe("jean");
      await poserRole(jean, NIVEAU.moderator);
      await poserGroupe(jean, gAutre);
      await connecte("jean");
      expect(await niveau("jean")).toBe(NIVEAU.moderator);
      expect(await groupesDe("jean")).toEqual([gAutre]);
      expect(audits("auth.role.sync")).toEqual([]);
      expect(audits("auth.groups.sync")).toEqual([]);
      expect(annuaire.recherches.filter((r) => r.includes(G_ADMIN) || r.includes(G_EQUIPE))).toEqual([]);
    });

    it("un groupe sans option allumée : une option sans groupe ne rétrograde personne", async () => {
      await regler({ ...roles(true, [], []), ...carte(true, []) });
      personne("jean", 1);
      await connecte("jean");
      const jean = await idDe("jean");
      await poserRole(jean, NIVEAU.admin);
      await connecte("jean");
      expect(await niveau("jean")).toBe(NIVEAU.admin);
      expect(audits("auth.role.sync")).toEqual([]);
    });

    it("la passe ne touche à rien non plus", async () => {
      await regler({ ...roles(false), ...carte(false) });
      const jean = await rattacher("jean", 1);
      await poserRole(jean, NIVEAU.admin);
      await poserGroupe(jean, gEquipe);
      await passe();
      expect(await niveau("jean")).toBe(NIVEAU.admin);
      expect(await groupesDe("jean")).toEqual([gEquipe]);
      expect(annuaire.recherches.filter((r) => r.includes(G_ADMIN) || r.includes(G_EQUIPE))).toEqual([]);
    });
  });

  describe("à la connexion", () => {
    it("monte et rétrograde ; l'audit n'écrit que les changements ; la rétrogradation coupe les anciennes sessions", async () => {
      await regler(roles());
      const p = personne("jean", 1, [G_ADMIN]);
      const premiere = await connecte("jean");
      expect(await niveau("jean")).toBe(NIVEAU.admin);
      expect(audits("auth.role.sync")).toHaveLength(1);
      expect(audits("auth.role.sync")[0]).toMatchObject({
        username: "jean",
        details: { provider_id: "annuaire", from: "user", to: "admin" },
      });
      await connecte("jean");
      expect(audits("auth.role.sync")).toHaveLength(1);
      expect((await moi(premiere))["logged_in"]).toBe(true);

      p.groupes = [GROUPE, G_MOD];
      const apres = await connecte("jean");
      expect(await niveau("jean")).toBe(NIVEAU.moderator);
      expect(audits("auth.role.sync")[1]).toMatchObject({ details: { from: "admin", to: "moderator" } });
      expect((await moi(premiere))["logged_in"], "ancienne session morte").toBe(false);
      expect((await moi(apres))["logged_in"], "nouvelle session vivante").toBe(true);

      p.groupes = [GROUPE];
      const derniere = await connecte("jean");
      expect(await niveau("jean")).toBe(NIVEAU.user);
      expect(audits("auth.role.sync")[2]).toMatchObject({ details: { from: "moderator", to: "user" } });
      expect((await moi(apres))["logged_in"]).toBe(false);
      expect((await moi(derniere))["logged_in"]).toBe(true);
    });

    it("administrateur avant modérateur ; une montée ne coupe aucune session", async () => {
      await regler(roles());
      personne("jean", 1, [G_MOD]);
      const avant = await connecte("jean");
      expect(await niveau("jean")).toBe(NIVEAU.moderator);
      annuaire.personnes[0]?.groupes.push(G_ADMIN);
      await connecte("jean");
      expect(await niveau("jean")).toBe(NIVEAU.admin);
      expect((await moi(avant))["logged_in"]).toBe(true);
    });

    it("correspondance exacte : un groupe du même nom ailleurs dans l'annuaire ne donne rien", async () => {
      await regler(roles());
      personne("jean", 1, [G_HOMONYME]);
      await connecte("jean");
      expect(await niveau("jean")).toBe(NIVEAU.user);
      expect(audits("auth.role.sync")).toEqual([]);
    });

    it("tentative qui échoue : aucune montée, aucun compte, aucune lecture des groupes de rôles", async () => {
      await regler(roles());
      personne("jean", 1, [G_ADMIN]);
      const r = await connexion("jean", "mauvais-mot-de-passe");
      expect(r.statusCode).toBe(401);
      expect(await b.t.base.get("SELECT 1 AS un FROM users WHERE username='jean'")).toBeUndefined();
      expect(annuaire.recherches.filter((x) => x.includes(G_ADMIN))).toEqual([]);
      await connecte("jean");
      await poserRole(await idDe("jean"), NIVEAU.user);
      const r2 = await connexion("jean", "mauvais-mot-de-passe");
      expect(r2.statusCode).toBe(401);
      expect(await niveau("jean")).toBe(NIVEAU.user);
    });

    describe("inconnu n'est jamais « non »", () => {
      const preparer = async (): Promise<number> => {
        await regler({ ...roles(), ...carte() });
        personne("jean", 1);
        await connecte("jean");
        const jean = await idDe("jean");
        await poserRole(jean, NIVEAU.admin);
        await poserGroupe(jean, gEquipe);
        await poserGroupe(jean, gAutre);
        return jean;
      };
      const inchange = async (): Promise<void> => {
        expect(await niveau("jean")).toBe(NIVEAU.admin);
        expect(await groupesDe("jean")).toEqual([gEquipe, gAutre].sort((x, y) => x - y));
        expect(audits("auth.role.sync")).toEqual([]);
        expect(audits("auth.groups.sync")).toEqual([]);
      };

      it("un groupe de rôles illisible : ni rôle ni groupe ne bougent, la connexion réussit", async () => {
        await preparer();
        enPanne.add(G_MOD);
        const r = await connexion("jean");
        expect(r.statusCode, r.body).toBe(200);
        await inchange();
      });

      it("un groupe de la correspondance illisible : le rôle non plus ne bouge pas", async () => {
        await preparer();
        enPanne.add(G_EQUIPE);
        expect((await connexion("jean")).statusCode).toBe(200);
        await inchange();
      });

      it("un groupe qui n'existe pas dans l'annuaire vaut « inconnu », pas « non »", async () => {
        await preparer();
        annuaire.groupesExistants.delete(G_ADMIN);
        expect((await connexion("jean")).statusCode).toBe(200);
        await inchange();
      });

      it("membre d'un groupe d'administrateurs lu et un autre illisible : aucune montée", async () => {
        await regler(roles());
        personne("luc", 2, [G_ADMIN]);
        enPanne.add(G_MOD);
        expect((await connexion("luc")).statusCode).toBe(200);
        expect(await niveau("luc")).toBe(NIVEAU.user);
        expect(audits("auth.role.sync")).toEqual([]);
      });

      it("la lecture d'un groupe illisible rend « aucune décision » (unitaire)", () => {
        const f = validerFournisseur({ ...courant, ...roles(), ...carte() });
        const lue = new Map([
          [G_ADMIN, "non" as const],
          [G_MOD, "inconnu" as const],
          [G_EQUIPE, "oui" as const],
        ]);
        expect(decider(f, lue)).toBeNull();
        expect(decider(f, new Map([[G_ADMIN, "non" as const]]))).toBeNull();
        expect(decider(f, new Map([...lue, [G_MOD, "non" as const]]))).toEqual({
          role: "user",
          groupes: new Map([[gEquipe, true]]),
        });
        expect(decider(f, lectureOidc(f, null))).toBeNull();
      });
    });

    describe("groupes Elpis", () => {
      it("seuls les groupes cités sont gérés : ajout, retrait, autres appartenances intactes", async () => {
        await regler(carte());
        const p = personne("jean", 1, [G_EQUIPE]);
        await connecte("jean");
        const jean = await idDe("jean");
        expect(await groupesDe("jean")).toEqual([gEquipe]);
        expect(audits("auth.groups.sync")[0]).toMatchObject({
          username: "jean",
          details: { provider_id: "annuaire", added: [gEquipe], removed: [] },
        });
        await poserGroupe(jean, gAutre);
        await connecte("jean");
        expect(audits("auth.groups.sync")).toHaveLength(1);
        p.groupes = [GROUPE];
        await connecte("jean");
        expect(await groupesDe("jean")).toEqual([gAutre]);
        expect(audits("auth.groups.sync")[1]).toMatchObject({ details: { added: [], removed: [gEquipe] } });
        expect(audits("auth.role.sync")).toEqual([]);
      });

      it("un groupe Elpis disparu est ignoré, jamais recréé", async () => {
        await regler(carte(true, [{ external: G_EQUIPE, group_id: 9999 }]));
        personne("jean", 1, [G_EQUIPE]);
        expect((await connexion("jean")).statusCode).toBe(200);
        expect(await groupesDe("jean")).toEqual([]);
        expect(await b.t.base.get('SELECT 1 AS un FROM "groups" WHERE id=9999')).toBeUndefined();
        expect(lignesJournal.some((l) => l.includes("n'existe plus"))).toBe(true);
        expect(audits("auth.groups.sync")).toEqual([]);
      });

      it("deux valeurs externes pour un même groupe : membre de l'une suffit", async () => {
        await regler(
          carte(true, [
            { external: G_EQUIPE, group_id: gEquipe },
            { external: G_MOD, group_id: gEquipe },
          ]),
        );
        personne("jean", 1, [G_MOD]);
        await connecte("jean");
        expect(await groupesDe("jean")).toEqual([gEquipe]);
      });
    });
  });

  describe("à la passe de balayage", () => {
    it("ne monte jamais et n'ajoute jamais : la montée attend la connexion de la personne", async () => {
      await regler({ ...roles(), ...carte() });
      const jean = await rattacher("jean", 1, [G_ADMIN, G_EQUIPE]);
      const luc = await rattacher("luc", 2, [G_ADMIN]);
      await poserRole(luc, NIVEAU.moderator);
      await passe();
      expect(await niveau("jean")).toBe(NIVEAU.user);
      expect(await groupesDe("jean")).toEqual([]);
      expect(await niveau("luc")).toBe(NIVEAU.moderator);
      expect(audits("auth.role.sync")).toEqual([]);
      expect(audits("auth.groups.sync")).toEqual([]);
      await connecte("jean");
      expect(await niveau("jean")).toBe(NIVEAU.admin);
      expect(await groupesDe("jean")).toEqual([gEquipe]);
      expect(jean).toBeGreaterThan(0);
    });

    it("rétrograde et retire sur une appartenance lue : rôle, groupes, sessions, flux et audit", async () => {
      await regler({ ...roles(), ...carte() });
      const jean = await rattacher("jean", 1);
      const luc = await rattacher("luc", 2, [G_MOD]);
      await poserRole(jean, NIVEAU.admin);
      await poserGroupe(jean, gEquipe);
      await poserGroupe(jean, gAutre);
      await poserRole(luc, NIVEAU.admin);
      await passe();
      expect(await niveau("jean")).toBe(NIVEAU.user);
      expect(await groupesDe("jean")).toEqual([gAutre]);
      expect(await niveau("luc")).toBe(NIVEAU.moderator);
      expect(publiees.sort()).toEqual([jean, luc].sort());
      expect(Number((await ligneUtilisateur(b.t.base, jean))?.session_min_ts)).toBe(b.horloge);
      expect(
        audits("auth.role.sync")
          .map((l) => (l["details"] as Record<string, unknown>)["to"])
          .sort(),
      ).toEqual(["moderator", "user"]);
      expect(audits("auth.groups.sync")[0]).toMatchObject({ details: { added: [], removed: [gEquipe] } });
      await passe();
      expect(audits("auth.role.sync")).toHaveLength(2);
    });

    it("appartenance illisible : aucune rétrogradation, aucun retrait", async () => {
      await regler({ ...roles(), ...carte() });
      const jean = await rattacher("jean", 1);
      await poserRole(jean, NIVEAU.admin);
      await poserGroupe(jean, gEquipe);
      for (const g of [G_ADMIN, G_MOD, G_EQUIPE]) {
        enPanne.add(g);
        await passe();
        enPanne.clear();
        expect(await niveau("jean"), g).toBe(NIVEAU.admin);
        expect(await groupesDe("jean"), g).toEqual([gEquipe]);
      }
      annuaire.groupesExistants.delete(G_MOD);
      await passe();
      expect(await niveau("jean")).toBe(NIVEAU.admin);
      expect(publiees).toEqual([]);
    });

    it("passe abandonnée (canari) : aucune rétrogradation", async () => {
      await regler({ ...roles(), ...carte() });
      const jean = await rattacher("jean", 1);
      await poserRole(jean, NIVEAU.admin);
      annuaire.entreesLisibles = false;
      expect((await passe()).aborted).toBe("users_unreadable");
      expect(await niveau("jean")).toBe(NIVEAU.admin);
      annuaire.entreesLisibles = true;
      annuaire.membresVisibles = false;
      expect((await passe()).aborted).toBe("membership_unreadable");
      expect(await niveau("jean")).toBe(NIVEAU.admin);
    });

    it("le dernier administrateur local n'est jamais rétrogradé par l'annuaire", async () => {
      await regler(roles());
      await b.t.base.run("UPDATE users SET suspended_at=1 WHERE username='chef'");
      const seul = await createUser(b.t.base, "seul", "mdp-seul-1", { isAdmin: 1 });
      const p = personne("seul", 3);
      await b.t.base.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at, checked_at) VALUES(?,?,?,?,?,?,?)",
        [seul, courant.id, p.cle, ancreIdentite(courant), "auto", b.horloge - 1000, 5],
      );
      await passe();
      expect(await niveau("seul")).toBe(NIVEAU.admin);
      expect(audits("auth.role.sync")).toEqual([]);
    });

    it("un compte local sans identité n'est jamais touché", async () => {
      await regler({ ...roles(), ...carte() });
      const local = await createUser(b.t.base, "locale", "mdp-locale-1", { isAdmin: 2 });
      await rattacher("jean", 1);
      await passe();
      expect(await niveau("locale")).toBe(NIVEAU.moderator);
      expect(local).toBeGreaterThan(0);
    });
  });

  describe("changer la correspondance exige un nouveau test", () => {
    it("l'empreinte du test couvre les rôles et la correspondance : fournisseur écarté tant qu'il n'est pas retesté", async () => {
      await regler(roles(false));
      expect((await fournisseursActifs(b.t.base, () => true)).map((x) => x.id)).toEqual(["annuaire"]);
      const change = validerFournisseur({ ...courant, ...roles(true) });
      const autre = validerFournisseur({ ...courant, ...carte(true) });
      for (const f of [change, autre])
        expect(empreinteFournisseur(f, URL_ANNUAIRE)).not.toBe(empreinteFournisseur(courant, URL_ANNUAIRE));
      b.cfg.ecrire({ auth: { public_url: URL_ANNUAIRE, providers: [change] } });
      expect(await fournisseursActifs(b.t.base, () => true)).toEqual([]);
      b.cfg.ecrire({ auth: { public_url: URL_ANNUAIRE, providers: [autre] } });
      expect(await fournisseursActifs(b.t.base, () => true)).toEqual([]);
    });
  });

  describe("doctor", () => {
    it("signale les rôles et groupes gérés par le fournisseur", async () => {
      await regler({ ...roles(), ...carte() });
      b.cfg.ecrire({
        auth: { public_url: URL_ANNUAIRE, providers: [courant] },
        security: { session: { https_only: true }, https: { enabled: true } },
      });
      const lignes = await diagnostiquerAuth(b.t.base, { maintenant: () => b.horloge });
      expect(lignes.some((l) => l.texte.includes("rôles et groupes gérés par le fournisseur"))).toBe(true);
    });
  });
});

describe.each(MOTEURS)("console : rôle géré, enregistrement de la correspondance (%s)", (moteur) => {
  let b: Banc;
  let comptes: FastifyInstance;

  const ecrireFournisseur = (extra: Record<string, unknown>, type: "ldap" | "oidc" = "ldap"): void =>
    b.cfg.ecrire({
      auth: {
        public_url: "https://elpis.exemple.lan",
        providers: [
          type === "ldap"
            ? ldapValide({ required_groups: ["cn=elpis"], ...extra })
            : oidcValide({ required_groups: ["elpis"], ...extra }),
        ],
      },
    });
  const modifier = (id: string, corps: Record<string, unknown>) =>
    b.appeler("PUT", `/api/admin/auth/providers/${id}`, corps);
  const sansEtatEcrit = (): unknown => b.lireConfig()["auth"];
  const rattacherA = async (uid: number, fournisseur: string): Promise<void> => {
    await b.t.base.run(
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at) VALUES(?,?,?,?,?,?)",
      [uid, fournisseur, `cle-${uid}`, "oidc:x", "auto", 1],
    );
  };
  const listeComptes = async (): Promise<Record<string, Record<string, unknown>>> => {
    const r = await comptes.inject({
      method: "GET",
      url: "/api/admin/users-with-groups",
      headers: { "x-uid": String(b.chef) },
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(schemaReponseComptesConsole.safeParse(r.json()).success).toBe(true);
    return Object.fromEntries(
      r.json<{ users: Record<string, unknown>[] }>().users.map((u) => [String(u["username"]), u]),
    );
  };
  const role = (uid: number, valeur: string) =>
    comptes.inject({
      method: "POST",
      url: `/api/admin/users/${uid}/role`,
      headers: { "x-uid": String(b.chef) },
      payload: { role: valeur },
    });

  beforeEach(async () => {
    b = await ouvrirBanc(moteur);
    const auth = { ...dependancesParDefaut(b.t.base) };
    comptes = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminComptes({ base: b.t.base, auth, journal: journalMuet, revoquer: async () => null }),
      ],
      gardes: {
        admin: async (req) => {
          const uid = req.headers["x-uid"];
          if (!uid) throw new HttpError(401, "not logged in");
          const ligne = await ligneUtilisateur(b.t.base, Number(uid));
          req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
          if (!ligne || Number(ligne.is_admin) !== 1) throw new HttpError(403, "Admin required");
        },
      },
    });
  });
  afterEach(async () => {
    await comptes.close();
    await b.fermer();
  });

  describe("rôle géré", () => {
    it("rattaché à un fournisseur dont les rôles sont gérés : role_managed et 409 ; local ou autre fournisseur : modifiable", async () => {
      b.cfg.ecrire({
        auth: {
          public_url: "https://elpis.exemple.lan",
          providers: [
            ldapValide({
              required_groups: ["cn=elpis"],
              roles: { enabled: true, admin_groups: [], moderator_groups: ["cn=mod"] },
            }),
            ldapValide({ id: "autre", required_groups: ["cn=elpis"] }),
          ],
        },
      });
      const gere = await createUser(b.t.base, "gere", "mdp-gere-1");
      const libre = await createUser(b.t.base, "libre", "mdp-libre-1");
      await rattacherA(gere, "annuaire");
      await rattacherA(libre, "autre");
      const vue = await listeComptes();
      expect(vue["gere"]?.["role_managed"]).toBe(true);
      expect(vue["libre"]?.["role_managed"]).toBe(false);
      expect(vue["alice"]?.["role_managed"]).toBe(false);
      const refus = await role(gere, "moderator");
      expect(refus.statusCode).toBe(409);
      expect(refus.json()).toEqual({ detail: "Le rôle de ce compte est géré par votre annuaire." });
      expect(Number((await ligneUtilisateur(b.t.base, gere))?.is_admin)).toBe(0);
      expect((await role(libre, "moderator")).statusCode).toBe(200);
      expect((await role(b.alice, "moderator")).statusCode).toBe(200);
    });
  });

  describe("enregistrement d'une correspondance d'administrateurs", () => {
    const admins = { roles: { enabled: true, admin_groups: ["cn=admins,dc=x"], moderator_groups: [] } };

    it("annuaire : confirmation explicite exigée ; jamais enregistrée dans les réglages", async () => {
      ecrireFournisseur({});
      const avant = sansEtatEcrit();
      const refus = await modifier("annuaire", admins);
      expect(refus.statusCode).toBe(409);
      expect(refus.json<{ detail: string }>().detail).toContain("Confirmez");
      expect((await modifier("annuaire", { ...admins, confirm_admin_mapping: false })).statusCode).toBe(409);
      expect((await modifier("annuaire", { ...admins, confirm_admin_mapping: "oui" })).statusCode).toBe(400);
      expect(sansEtatEcrit()).toEqual(avant);
      const ok = await modifier("annuaire", { ...admins, confirm_admin_mapping: true });
      expect(ok.statusCode, ok.body).toBe(200);
      const f = (b.lireConfig()["auth"] as { providers: Record<string, unknown>[] }).providers[0];
      expect(f?.["roles"]).toEqual(admins.roles);
      expect(f).not.toHaveProperty("confirm_admin_mapping");
      expect((await modifier("annuaire", { label: "Autre libellé" })).statusCode).toBe(200);
    });

    it("des groupes de modérateurs seuls ne demandent aucune confirmation", async () => {
      ecrireFournisseur({});
      const r = await modifier("annuaire", {
        roles: { enabled: true, admin_groups: [], moderator_groups: ["cn=mod"] },
      });
      expect(r.statusCode, r.body).toBe(200);
    });

    it("SSO : refusé sans acr ni amr exigé, même confirmé ; accepté avec", async () => {
      ecrireFournisseur({}, "oidc");
      const avant = sansEtatEcrit();
      const refus = await modifier("sso", { ...admins, confirm_admin_mapping: true });
      expect(refus.statusCode).toBe(409);
      expect(refus.json<{ detail: string }>().detail).toContain("second facteur");
      expect(sansEtatEcrit()).toEqual(avant);
      for (const second of [{ required_acr: ["mfa"] }, { required_amr: ["otp"] }]) {
        ecrireFournisseur({}, "oidc");
        const sansConfirmation = await modifier("sso", { ...admins, ...second });
        expect(sansConfirmation.statusCode).toBe(409);
        const ok = await modifier("sso", { ...admins, ...second, confirm_admin_mapping: true });
        expect(ok.statusCode, ok.body).toBe(200);
      }
    });

    it("valeur vide ou en double refusée par le validateur", async () => {
      ecrireFournisseur({});
      expect(
        (await modifier("annuaire", { roles: { enabled: false, admin_groups: [""], moderator_groups: [] } }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await modifier("annuaire", {
            roles: { enabled: false, admin_groups: ["a", "a"], moderator_groups: [] },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (await modifier("annuaire", { group_map: { enabled: false, map: [{ external: "", group_id: 1 }] } }))
          .statusCode,
      ).toBe(400);
      expect(
        (
          await modifier("annuaire", {
            group_map: {
              enabled: false,
              map: [
                { external: "g", group_id: 1 },
                { external: "g", group_id: 1 },
              ],
            },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await modifier("annuaire", {
            group_map: {
              enabled: true,
              map: [
                { external: "g", group_id: 1 },
                { external: "g", group_id: 2 },
              ],
            },
          })
        ).statusCode,
      ).toBe(200);
    });
  });
});

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("rôles et groupes par le SSO (%s)", (moteur) => {
  let b: BancOidc;
  let gEquipe: number;
  const MFA = { acr: "mfa" };

  const reglages = (extra: Record<string, unknown>) => b.reglages(extra);
  const niveau = async (nom: string): Promise<number> =>
    Number(
      (await b.t.base.get<{ is_admin: number }>("SELECT is_admin FROM users WHERE username=?", [nom]))
        ?.is_admin,
    );
  const groupesDe = async (nom: string): Promise<number[]> =>
    (
      await b.t.base.valeurs<[number]>(
        "SELECT group_id FROM user_groups WHERE user_id=(SELECT id FROM users WHERE username=?) ORDER BY group_id",
        [nom],
      )
    ).map(([g]) => Number(g));
  const audits = (action: string) =>
    lignesAuditRecentes({ actionPrefix: action })
      .filter((l) => l["action"] === action && Number(l["ts"]) >= depart)
      .reverse();
  const roles = (admin: string[], moderateur: string[] = []) => ({
    roles: { enabled: true, admin_groups: admin, moderator_groups: moderateur },
  });

  beforeEach(async () => {
    depart = Date.now() / 1000 - 0.001;
    lignesJournal.length = 0;
    b = await ouvrirBancOidc(moteur);
    gEquipe = await createGroup(b.t.base, "Equipe");
  });
  afterEach(async () => {
    await b.fermer();
  });

  it("administrateur par groupe avec second facteur exigé : monté à la connexion, audité, sans effet à l'essai", async () => {
    await reglages({ ...roles(["admins"], ["mods"]), required_acr: ["mfa"] });
    const { retour, session } = await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "admins"], ...MFA }));
    expect(retour.statusCode, retour.body).toBe(200);
    expect(session).toContain("mcpwebui_session");
    expect(await niveau("sub-jean")).toBe(NIVEAU.admin);
    expect(audits("auth.role.sync")[0]).toMatchObject({
      details: { provider_id: "sso", from: "user", to: "admin" },
    });
    await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "mods"], ...MFA }));
    expect(await niveau("sub-jean")).toBe(NIVEAU.moderator);
    await b.connecter(ELPIS("sub-jean", { groups: ["elpis"], ...MFA }));
    expect(await niveau("sub-jean")).toBe(NIVEAU.user);
    expect(audits("auth.role.sync")).toHaveLength(3);
  });

  it("valeur exacte : la casse, un chemin ou un nom proche ne donnent rien", async () => {
    await reglages({ ...roles(["admins"]), required_acr: ["mfa"] });
    for (const proche of ["Admins", "/admins", "admins ", "admin", "autre/admins"]) {
      await b.connecter(ELPIS("sub-jean", { groups: ["elpis", proche], ...MFA }));
      expect(await niveau("sub-jean"), proche).toBe(NIVEAU.user);
    }
    await reglages({ ...roles(["/elpis/admins"]), required_acr: ["mfa"] });
    await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "admins"], ...MFA }));
    expect(await niveau("sub-jean")).toBe(NIVEAU.user);
    await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "/elpis/admins"], ...MFA }));
    expect(await niveau("sub-jean")).toBe(NIVEAU.admin);
  });

  it("sans second facteur exigé (réglage écrit à la main), les groupes d'administrateurs sont ignorés", async () => {
    await reglages(roles(["admins"], ["mods"]));
    await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "admins"] }));
    expect(await niveau("sub-jean")).toBe(NIVEAU.user);
    await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "admins", "mods"] }));
    expect(await niveau("sub-jean")).toBe(NIVEAU.moderator);
    await reglages(roles(["admins"]));
    await b.connecter(ELPIS("sub-jean", { groups: ["elpis"] }));
    expect(await niveau("sub-jean")).toBe(NIVEAU.moderator);
  });

  it("une connexion refusée ne donne ni compte ni rôle", async () => {
    await reglages({ ...roles(["admins"]), required_acr: ["mfa"] });
    const { retour } = await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "admins"] }));
    expect(retour.statusCode).toBe(302);
    expect(await b.utilisateurs()).toEqual(["chef"]);
    expect(audits("auth.role.sync")).toEqual([]);
    const { retour: hors } = await b.connecter(ELPIS("sub-luc", { groups: ["admins"], ...MFA }));
    expect(hors.statusCode).toBe(302);
    expect(await b.utilisateurs()).toEqual(["chef"]);
  });

  it("options éteintes : rien ne change, même avec des groupes réglés", async () => {
    await reglages({
      roles: { enabled: false, admin_groups: ["admins"], moderator_groups: [] },
      group_map: { enabled: false, map: [{ external: "equipe", group_id: gEquipe }] },
      required_acr: ["mfa"],
    });
    await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "admins", "equipe"], ...MFA }));
    expect(await niveau("sub-jean")).toBe(NIVEAU.user);
    expect(await groupesDe("sub-jean")).toEqual([]);
    expect(audits("auth.role.sync")).toEqual([]);
    expect(audits("auth.groups.sync")).toEqual([]);
  });

  it("groupes Elpis : ajout, retrait, autres groupes intacts", async () => {
    const autre = await createGroup(b.t.base, "Autre");
    await reglages({ group_map: { enabled: true, map: [{ external: "equipe", group_id: gEquipe }] } });
    await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "equipe"] }));
    expect(await groupesDe("sub-jean")).toEqual([gEquipe]);
    const jean = Number(
      (await b.t.base.get<{ id: number }>("SELECT id FROM users WHERE username='sub-jean'"))?.id,
    );
    await b.t.base.run("INSERT INTO user_groups(user_id, group_id) VALUES(?,?)", [jean, autre]);
    await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "Equipe"] }));
    expect(await groupesDe("sub-jean")).toEqual([autre]);
    expect(audits("auth.groups.sync")).toHaveLength(2);
  });

  it("l'essai à blanc montre le rôle et les groupes Elpis qui seraient donnés, sans rien écrire", async () => {
    await reglages({
      ...roles(["admins"]),
      required_acr: ["mfa"],
      group_map: { enabled: true, map: [{ external: "equipe", group_id: gEquipe }] },
    });
    const f = b.fournisseur;
    const retour = (groupes: string[] | null) =>
      ({
        profil: { subject: "s", issuer: `oidc:${f.issuer}`, extUsername: "s", extEmail: "", extName: "" },
        appartenance: "oui",
        vue: {
          iss: f.issuer,
          sujet: "s",
          identifiant: "s",
          nom: "",
          email: "",
          emailVerifie: false,
          acr: "mfa",
          amr: [],
          groupes,
          sujetEstIdentifiant: true,
        },
        groupesComplets: groupes,
        idToken: null,
        idpSid: null,
        sub: "s",
      }) as Parameters<typeof resultatEssaiBlanc>[2];
    const r = await resultatEssaiBlanc(b.t.base, f, retour(["elpis", "admins", "equipe"]), 1);
    expect(r.rights).toEqual({
      roles_enabled: true,
      groups_enabled: true,
      readable: true,
      role: "admin",
      groups: [{ id: gEquipe, name: "Equipe" }],
      missing_group_ids: [],
      admin_ignored: false,
    });
    expect(schemaReponseDernierEssai.safeParse({ result: r }).success).toBe(true);
    const illisible = await resultatEssaiBlanc(b.t.base, f, retour(null), 1);
    expect(illisible.rights).toMatchObject({ readable: false, role: null, groups: [] });
    expect(await b.utilisateurs()).toEqual(["chef"]);
    expect(await b.t.base.valeurs("SELECT COUNT(*) FROM user_groups")).toEqual([[0]]);
  });
});
