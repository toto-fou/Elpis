// SPDX-License-Identifier: MIT
/** apps/core/test/securite-roles-oidc.test.ts — le rôle et les groupes Elpis donnés par le fournisseur OIDC : options éteintes sans effet, « inconnu » jamais « non », valeur exacte, montée à la connexion seulement, rétrogradation sans session survivante, rôle géré non modifiable à la main, administrateur refusé sans second facteur ni confirmation (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createExternalUser,
  createGroup,
  createUser,
  dependancesParDefaut,
  ligneUtilisateur,
} from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { schemaReponseComptesConsole, schemaReponseDernierEssai } from "@elpis/contracts";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { creerFamilleAdminComptes } from "../src/familles/admin-comptes";
import { decider } from "../src/identite/correspondance";
import { appliquerDroits, fournisseursAuRoleGere } from "../src/identite/droits";
import type { BilanDroits, DependancesDroits } from "../src/identite/droits";
import { resultatEssaiBlanc } from "../src/identite/oidc/essai-blanc";
import { validerFournisseur } from "../src/identite/reglages";
import type { Fournisseur } from "../src/identite/reglages";
import { appTest, journalMuet, lignesAuditRecentes, lignesJournal } from "./aides";
import { oidcValide } from "./identite/aides";
import { MOTEURS, ouvrirBanc } from "./identite/banc";
import type { Banc } from "./identite/banc";
import { ouvrirBancFournisseur } from "./identite/banc-fournisseur";
import type { BancFournisseur } from "./identite/banc-fournisseur";
import { ELPIS, ouvrirBancOidc } from "./identite/banc-oidc";
import type { BancOidc } from "./identite/banc-oidc";
import { OPENSSL_DISPONIBLE } from "./identite/pki-openssl";

const NIVEAU = { user: 0, admin: 1, moderator: 2 } as const;
const MFA = { amr: ["mfa"] };
const ADMINS = { roles: { enabled: true, admin_groups: ["admins"], moderator_groups: [] } };
const MESSAGE_ROLE_GERE =
  "Le rôle de ce compte est donné par votre fournisseur d'identité : vous pouvez seulement le rétrograder.";

const roles = (admin: string[], moderateur: string[] = [], enabled = true) => ({
  roles: { enabled, admin_groups: admin, moderator_groups: moderateur },
});

const niveauDe = async (base: BancFournisseur["t"]["base"], nom: string): Promise<number> =>
  Number(
    (await base.get<{ is_admin: number }>("SELECT is_admin FROM users WHERE username=?", [nom]))?.is_admin,
  );

const groupesDeCompte = async (base: BancFournisseur["t"]["base"], nom: string): Promise<number[]> =>
  (
    await base.valeurs<[number]>(
      "SELECT group_id FROM user_groups WHERE user_id=(SELECT id FROM users WHERE username=?) ORDER BY group_id",
      [nom],
    )
  ).map(([g]) => Number(g));

const audits = (action: string): Record<string, unknown>[] =>
  lignesAuditRecentes({ actionPrefix: action })
    .filter((l) => l["action"] === action)
    .reverse();

describe.each(MOTEURS)("rôles et groupes du fournisseur : décisions communes (%s)", (moteur) => {
  let b: BancFournisseur;
  let dossierAudit: string;
  let courant: Fournisseur;
  let gEquipe: number;
  let gAutre: number;
  let appels: string[];

  const regler = (extra: Record<string, unknown>): void => {
    courant = validerFournisseur({ ...courant, ...extra });
  };
  const dep = (): DependancesDroits => ({
    base: b.t.base,
    maintenant: () => b.horloge,
    journal: journalMuet,
    publierSuspension: async () => void appels.push("suspension"),
  });
  const appliquer = (
    uid: number,
    groupes: string[] | null,
    o: { mode?: "connexion" | "retrait" } = {},
  ): Promise<BilanDroits> =>
    appliquerDroits(dep(), {
      fournisseur: courant,
      uid,
      groupes,
      mode: o.mode ?? "connexion",
    });
  const compte = (nom: string, niveau: number = NIVEAU.user): Promise<number> =>
    createUser(b.t.base, nom, `mdp-${nom}-1`, { isAdmin: niveau });
  const poserGroupe = (uid: number, g: number): Promise<unknown> =>
    b.t.base.run("INSERT INTO user_groups(user_id, group_id) VALUES(?,?)", [uid, g]);
  const minSession = async (uid: number): Promise<number> =>
    Number((await ligneUtilisateur(b.t.base, uid))?.session_min_ts ?? 0);
  const rien = { role: null, ajoutes: [], retires: [] };

  beforeEach(async () => {
    appels = [];
    lignesJournal.length = 0;
    b = await ouvrirBancFournisseur(moteur);
    courant = validerFournisseur({ ...(b.fournisseurs[0] as Fournisseur), required_amr: ["mfa"] });
    gEquipe = await createGroup(b.t.base, "Equipe");
    gAutre = await createGroup(b.t.base, "Autre");
    dossierAudit = mkdtempSync(join(tmpdir(), "elpis-audit-roles-"));
    configureAudit({ service: "main", auditDir: dossierAudit, hmacKeyPath: join(dossierAudit, "sans-cle") });
  });
  afterEach(async () => {
    oublierConfigurationAudit();
    rmSync(dossierAudit, { recursive: true, force: true });
    await b.fermer();
  });

  describe("rôle", () => {
    it("une rétrogradation coupe les sessions du compte et publie la suspension, jamais une simple révocation ; une montée ne coupe rien", async () => {
      regler(roles(["admins"], ["mods"]));
      const jean = await compte("jean", NIVEAU.admin);
      expect(await appliquer(jean, ["elpis", "mods"])).toMatchObject({
        role: { de: "admin", vers: "moderator" },
      });
      expect(await niveauDe(b.t.base, "jean")).toBe(NIVEAU.moderator);
      expect(await minSession(jean)).toBe(b.horloge);
      expect(appels).toEqual(["suspension"]);
      expect(audits("auth.role.sync")[0]).toMatchObject({
        user_id: jean,
        username: "jean",
        details: { target_user_id: jean, provider_id: "sso", from: "admin", to: "moderator" },
      });

      const luc = await compte("luc");
      appels.length = 0;
      expect(await appliquer(luc, ["elpis", "mods"])).toMatchObject({
        role: { de: "user", vers: "moderator" },
      });
      expect(await minSession(luc)).toBe(0);
      expect(appels).toEqual([]);
    });

    it("rien à changer : aucune écriture exclusive n'est ouverte, avec ou sans groupes gérés", async () => {
      regler({
        ...roles(["admins"]),
        group_map: { enabled: true, map: [{ external: "equipe", group_id: gEquipe }] },
      });
      const jean = await compte("jean");
      await appliquer(jean, ["equipe"]);
      const ecriture = b.t.base.ecriture.bind(b.t.base);
      let ouvertes = 0;
      b.t.base.ecriture = ((f: never) => {
        ouvertes += 1;
        return ecriture(f);
      }) as typeof b.t.base.ecriture;
      expect(await appliquer(jean, ["equipe"])).toEqual(rien);
      expect(ouvertes).toBe(0);
      expect(await appliquer(jean, [])).toMatchObject({ retires: [gEquipe] });
      expect(ouvertes).toBe(1);
    });

    it("l'état du compte est relu sous le verrou d'écriture : une appartenance posée entre-temps n'est ni doublée ni comptée", async () => {
      regler({ group_map: { enabled: true, map: [{ external: "equipe", group_id: gEquipe }] } });
      const jean = await compte("jean");
      const ecriture = b.t.base.ecriture.bind(b.t.base);
      b.t.base.ecriture = ((f: never) => {
        b.t.base.ecriture = ecriture;
        return b.t.base
          .run("INSERT INTO user_groups(user_id, group_id) VALUES(?,?)", [jean, gEquipe])
          .then(() => ecriture(f));
      }) as typeof b.t.base.ecriture;
      expect(await appliquer(jean, ["equipe"])).toEqual(rien);
      expect(await groupesDeCompte(b.t.base, "jean")).toEqual([gEquipe]);
      expect(audits("auth.groups.sync")).toEqual([]);
    });

    it("un rôle n'est dit géré que si l'option agit : allumée sans groupe utilisable, il reste modifiable à la main", () => {
      const brut = (extra: Record<string, unknown>): Record<string, unknown> => ({
        ...(b.fournisseurs[0] as Fournisseur),
        ...extra,
      });
      b.cfg.ecrire({
        auth: {
          public_url: "https://elpis.exemple.lan",
          providers: [
            brut({ id: "vide", roles: { enabled: true, admin_groups: [], moderator_groups: [] } }),
            brut({ id: "agit", roles: { enabled: true, admin_groups: [], moderator_groups: ["mods"] } }),
          ],
        },
        security: { https: { enabled: true } },
      });
      expect([...fournisseursAuRoleGere()]).toEqual(["agit"]);
    });

    it("administrateur avant modérateur ; l'audit n'écrit que les changements", async () => {
      regler(roles(["admins"], ["mods"]));
      const jean = await compte("jean");
      await appliquer(jean, ["elpis", "mods", "admins"]);
      expect(await niveauDe(b.t.base, "jean")).toBe(NIVEAU.admin);
      expect(await appliquer(jean, ["elpis", "mods", "admins"])).toEqual(rien);
      expect(audits("auth.role.sync")).toHaveLength(1);
      expect(audits("auth.role.sync")[0]).toMatchObject({ details: { from: "user", to: "admin" } });
    });

    it("le dernier administrateur local n'est jamais rétrogradé par le fournisseur ; un autre administrateur actif lève la protection", async () => {
      regler(roles(["admins"]));
      await b.t.base.run("UPDATE users SET suspended_at=1 WHERE username='chef'");
      const seul = await compte("seul", NIVEAU.admin);
      expect(await appliquer(seul, ["elpis"])).toEqual(rien);
      expect(await niveauDe(b.t.base, "seul")).toBe(NIVEAU.admin);
      expect(await minSession(seul)).toBe(0);
      expect(audits("auth.role.sync")).toEqual([]);
      expect(appels).toEqual([]);
      expect(lignesJournal.some((l) => l.includes("dernier administrateur local"))).toBe(true);

      await b.t.base.run("UPDATE users SET suspended_at=NULL WHERE username='chef'");
      expect(await appliquer(seul, ["elpis"])).toMatchObject({ role: { de: "admin", vers: "user" } });
      expect(await niveauDe(b.t.base, "seul")).toBe(NIVEAU.user);
    });

    it("au retour d'un rattachement par preuve (mode retrait), le rôle baisse mais ne monte jamais", async () => {
      regler({
        ...roles(["admins"], ["mods"]),
        group_map: { enabled: true, map: [{ external: "equipe", group_id: gEquipe }] },
      });
      const jean = await compte("jean");
      expect(await appliquer(jean, ["elpis", "mods", "equipe"], { mode: "retrait" })).toEqual(rien);
      expect(await niveauDe(b.t.base, "jean")).toBe(NIVEAU.user);
      expect(await groupesDeCompte(b.t.base, "jean")).toEqual([]);

      const luc = await compte("luc", NIVEAU.admin);
      await poserGroupe(luc, gEquipe);
      expect(await appliquer(luc, ["elpis"], { mode: "retrait" })).toMatchObject({
        role: { de: "admin", vers: "user" },
        retires: [gEquipe],
      });
      expect(await niveauDe(b.t.base, "luc")).toBe(NIVEAU.user);
      expect(await groupesDeCompte(b.t.base, "luc")).toEqual([]);
      expect(appels).toEqual(["suspension"]);
    });
  });

  describe("groupes Elpis", () => {
    it("seuls les groupes cités sont gérés : ajout, retrait, autres appartenances intactes, audit des seuls changements", async () => {
      regler({ group_map: { enabled: true, map: [{ external: "equipe", group_id: gEquipe }] } });
      const jean = await compte("jean");
      expect(await appliquer(jean, ["elpis", "equipe"])).toMatchObject({ ajoutes: [gEquipe], retires: [] });
      expect(await groupesDeCompte(b.t.base, "jean")).toEqual([gEquipe]);
      expect(audits("auth.groups.sync")[0]).toMatchObject({
        user_id: jean,
        username: "jean",
        details: { target_user_id: jean, provider_id: "sso", added: [gEquipe], removed: [] },
      });

      await poserGroupe(jean, gAutre);
      expect(await appliquer(jean, ["elpis", "equipe"])).toEqual(rien);
      expect(audits("auth.groups.sync")).toHaveLength(1);

      expect(await appliquer(jean, ["elpis"])).toMatchObject({ ajoutes: [], retires: [gEquipe] });
      expect(await groupesDeCompte(b.t.base, "jean")).toEqual([gAutre]);
      expect(audits("auth.groups.sync")[1]).toMatchObject({ details: { added: [], removed: [gEquipe] } });
      expect(audits("auth.role.sync")).toEqual([]);
    });

    it("un groupe Elpis disparu est ignoré et jamais recréé", async () => {
      regler({ group_map: { enabled: true, map: [{ external: "equipe", group_id: 9999 }] } });
      const jean = await compte("jean");
      expect(await appliquer(jean, ["elpis", "equipe"])).toEqual(rien);
      expect(await groupesDeCompte(b.t.base, "jean")).toEqual([]);
      expect(await b.t.base.get('SELECT 1 AS un FROM "groups" WHERE id=9999')).toBeUndefined();
      expect(lignesJournal.some((l) => l.includes("n'existe plus"))).toBe(true);
      expect(audits("auth.groups.sync")).toEqual([]);
      lignesJournal.length = 0;
      await appliquer(jean, ["elpis", "equipe"]);
      expect(lignesJournal.filter((l) => l.includes("n'existe plus"))).toEqual([]);
    });

    it("deux valeurs externes pour un même groupe Elpis : l'appartenance à l'une suffit, le retrait exige de n'avoir ni l'une ni l'autre", async () => {
      regler({
        group_map: {
          enabled: true,
          map: [
            { external: "equipe", group_id: gEquipe },
            { external: "equipe-bis", group_id: gEquipe },
          ],
        },
      });
      const jean = await compte("jean");
      await appliquer(jean, ["elpis", "equipe-bis"]);
      expect(await groupesDeCompte(b.t.base, "jean")).toEqual([gEquipe]);
      expect(await appliquer(jean, ["elpis", "equipe"])).toEqual(rien);
      expect(await groupesDeCompte(b.t.base, "jean")).toEqual([gEquipe]);
      await appliquer(jean, ["elpis"]);
      expect(await groupesDeCompte(b.t.base, "jean")).toEqual([]);
    });
  });

  describe("inconnu n'est jamais « non »", () => {
    const preparer = async (): Promise<number> => {
      regler({
        ...roles(["admins"], ["mods"]),
        group_map: { enabled: true, map: [{ external: "equipe", group_id: gEquipe }] },
      });
      const jean = await compte("jean", NIVEAU.admin);
      await poserGroupe(jean, gEquipe);
      await poserGroupe(jean, gAutre);
      return jean;
    };
    const inchange = async (jean: number): Promise<void> => {
      expect(await niveauDe(b.t.base, "jean")).toBe(NIVEAU.admin);
      expect(await groupesDeCompte(b.t.base, "jean")).toEqual([gEquipe, gAutre].sort((x, y) => x - y));
      expect(await minSession(jean)).toBe(0);
      expect(audits("auth.role.sync")).toEqual([]);
      expect(audits("auth.groups.sync")).toEqual([]);
      expect(appels).toEqual([]);
    };

    it("groupes du jeton absents ou illisibles : ni le rôle ni les groupes ne bougent, une ligne au journal", async () => {
      const jean = await preparer();
      expect(await appliquer(jean, null)).toEqual(rien);
      await inchange(jean);
      expect(lignesJournal.some((l) => l.includes("appartenance illisible"))).toBe(true);
    });

    it("la décision pure : des groupes illisibles rendent aucune décision, aucun groupe lu rend utilisateur et retrait", () => {
      const f = validerFournisseur({
        ...courant,
        ...roles(["admins"], ["mods"]),
        group_map: { enabled: true, map: [{ external: "equipe", group_id: gEquipe }] },
      });
      expect(decider(f, null)).toBeNull();
      expect(decider(f, ["equipe"])).toEqual({ role: "user", groupes: new Map([[gEquipe, true]]) });
      expect(decider(f, [])).toEqual({ role: "user", groupes: new Map([[gEquipe, false]]) });
    });
  });

  describe("options éteintes", () => {
    it("rôles éteints malgré des groupes réglés, ou allumés sans aucun groupe : rien ne change, rien n'est audité", async () => {
      const jean = await compte("jean", NIVEAU.admin);
      await poserGroupe(jean, gAutre);
      for (const extra of [
        {
          ...roles(["admins"], ["mods"], false),
          group_map: { enabled: false, map: [{ external: "equipe", group_id: gEquipe }] },
        },
        { ...roles([], []), group_map: { enabled: true, map: [] } },
      ]) {
        regler(extra);
        expect(await appliquer(jean, ["elpis", "equipe"])).toEqual(rien);
        expect(await appliquer(jean, null)).toEqual(rien);
        expect(await niveauDe(b.t.base, "jean")).toBe(NIVEAU.admin);
        expect(await groupesDeCompte(b.t.base, "jean")).toEqual([gAutre]);
      }
      expect(audits("auth.role.sync")).toEqual([]);
      expect(audits("auth.groups.sync")).toEqual([]);
      expect(appels).toEqual([]);
    });
  });
});

describe.each(MOTEURS)("console : rôle géré et enregistrement de la correspondance (%s)", (moteur) => {
  let b: Banc;
  let comptes: FastifyInstance;

  const ecrireFournisseur = (extra: Record<string, unknown> = {}): void =>
    b.cfg.ecrire({
      auth: {
        public_url: "https://elpis.exemple.lan",
        providers: [oidcValide({ required_groups: ["elpis"], ...extra })],
      },
    });
  const modifier = (corps: Record<string, unknown>, id = "sso") =>
    b.appeler("PUT", `/api/admin/auth/providers/${id}`, corps);
  const sansEtatEcrit = (): unknown => b.lireConfig()["auth"];
  const fournisseurEcrit = (id = "sso"): Record<string, unknown> | undefined =>
    (b.lireConfig()["auth"] as { providers: Record<string, unknown>[] }).providers.find(
      (p) => p["id"] === id,
    );
  const rattacherA = async (uid: number, fournisseur: string): Promise<void> => {
    await b.t.base.run(
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, ext_username, linked_by, linked_at) VALUES(?,?,?,?,?,?,?)",
      [uid, fournisseur, `cle-${uid}`, "oidc:x", `ext-${uid}`, "auto", 1_800_000_000.5],
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
  const avecAdmins = { ...ADMINS, required_amr: ["mfa"] };

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
    it("rattaché à un fournisseur dont les rôles sont gérés : role_managed et 409 à la montée ; compte local ou autre fournisseur : modifiable", async () => {
      b.cfg.ecrire({
        auth: {
          public_url: "https://elpis.exemple.lan",
          providers: [
            oidcValide({ required_groups: ["elpis"], ...roles([], ["mods"]) }),
            oidcValide({
              id: "autre",
              issuer: "https://idp2.exemple.lan/realms/elpis",
              required_groups: ["elpis"],
            }),
          ],
        },
      });
      const gere = await createUser(b.t.base, "gere", "mdp-gere-1");
      const libre = await createUser(b.t.base, "libre", "mdp-libre-1");
      await rattacherA(gere, "sso");
      await rattacherA(libre, "autre");
      const vue = await listeComptes();
      expect(vue["gere"]?.["role_managed"]).toBe(true);
      expect(vue["libre"]?.["role_managed"]).toBe(false);
      expect(vue["alice"]?.["role_managed"]).toBe(false);
      const refus = await role(gere, "moderator");
      expect(refus.statusCode).toBe(409);
      expect(refus.json()).toEqual({ detail: MESSAGE_ROLE_GERE });
      expect(Number((await ligneUtilisateur(b.t.base, gere))?.is_admin)).toBe(0);
      expect((await role(libre, "moderator")).statusCode).toBe(200);
      expect((await role(b.alice, "moderator")).statusCode).toBe(200);
    });

    it("la console peut rétrograder un rôle donné par le fournisseur, jamais le monter ; l'audit le dit", async () => {
      ecrireFournisseur(roles([], ["mods"]));
      const gere = await createUser(b.t.base, "gere", "mdp-gere-1", { isAdmin: NIVEAU.moderator });
      await rattacherA(gere, "sso");
      const refus = await role(gere, "admin");
      expect(refus.statusCode).toBe(409);
      expect(refus.json()).toEqual({ detail: MESSAGE_ROLE_GERE });
      expect(Number((await ligneUtilisateur(b.t.base, gere))?.is_admin)).toBe(NIVEAU.moderator);
      expect((await role(gere, "moderator")).statusCode).toBe(200);
      expect((await role(gere, "user")).statusCode).toBe(200);
      expect(Number((await ligneUtilisateur(b.t.base, gere))?.is_admin)).toBe(0);
      expect((await role(gere, "moderator")).statusCode).toBe(409);
      const baisse = audits("admin.user.role").find(
        (l) => (l["details"] as Record<string, unknown>)["after"] === "user",
      );
      expect(baisse?.["details"]).toMatchObject({
        target_user_id: gere,
        before: "moderator",
        after: "user",
        role_managed: true,
      });
    });

    it("la liste des comptes rend l'identité externe d'un compte rattaché et dit s'il a un mot de passe local", async () => {
      ecrireFournisseur(roles([], ["mods"]));
      const ext = await createExternalUser(b.t.base, "externe", { maintenant: 1_800_000_000 });
      await rattacherA(ext, "sso");
      const local = await createUser(b.t.base, "locale", "mdp-locale-1");
      await rattacherA(local, "sso");
      const vue = await listeComptes();
      expect(vue["externe"]).toMatchObject({
        identity: { provider_id: "sso", ext_username: `ext-${ext}` },
        has_local_password: false,
        role_managed: true,
      });
      expect(vue["locale"]).toMatchObject({ identity: { provider_id: "sso" }, has_local_password: true });
      expect(vue["alice"]).toMatchObject({ identity: null, has_local_password: true, role_managed: false });
    });
  });

  describe("enregistrement d'une correspondance d'administrateurs", () => {
    it("confirmation explicite exigée ; jamais enregistrée dans les réglages", async () => {
      ecrireFournisseur({ required_amr: ["mfa"] });
      const avant = sansEtatEcrit();
      const refus = await modifier(ADMINS);
      expect(refus.statusCode).toBe(409);
      expect(refus.json<{ detail: string }>().detail).toContain("Confirmez");
      expect((await modifier({ ...ADMINS, confirm_admin_mapping: false })).statusCode).toBe(409);
      expect((await modifier({ ...ADMINS, confirm_admin_mapping: "oui" })).statusCode).toBe(400);
      expect(sansEtatEcrit()).toEqual(avant);
      const ok = await modifier({ ...ADMINS, confirm_admin_mapping: true });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(fournisseurEcrit()?.["roles"]).toEqual(ADMINS.roles);
      expect(fournisseurEcrit()).not.toHaveProperty("confirm_admin_mapping");
      expect((await modifier({ label: "Autre libellé" })).statusCode).toBe(200);
    });

    it("des groupes de modérateurs seuls ne demandent aucune confirmation", async () => {
      ecrireFournisseur();
      const r = await modifier(roles([], ["mods"]));
      expect(r.statusCode, r.body).toBe(200);
    });

    it("sans second facteur exigé, une correspondance d'administrateurs est refusée même confirmée ; avec, elle demande la confirmation", async () => {
      ecrireFournisseur();
      const avant = sansEtatEcrit();
      const refus = await modifier({ ...ADMINS, confirm_admin_mapping: true });
      expect(refus.statusCode).toBe(400);
      expect(refus.json<{ detail: string }>().detail).toContain("second facteur");
      expect(sansEtatEcrit()).toEqual(avant);
      expect((await modifier({ ...ADMINS, required_amr: ["mfa"] })).statusCode).toBe(409);
      const ok = await modifier({ ...ADMINS, required_amr: ["mfa"], confirm_admin_mapping: true });
      expect(ok.statusCode, ok.body).toBe(200);
    });

    it("des niveaux exigés sans niveau déclaré comme preuve ne valent pas un second facteur : refusé même confirmé ; avec `loa-5` déclaré, accepté", async () => {
      ecrireFournisseur();
      const avant = sansEtatEcrit();
      for (const acr of [["loa-2", "loa-5"], ["2"], ["urn:gold"]]) {
        const refus = await modifier({ ...ADMINS, required_acr: acr, confirm_admin_mapping: true });
        expect(refus.statusCode, JSON.stringify(acr)).toBe(400);
        expect(refus.json<{ detail: string }>().detail).toContain("second facteur");
      }
      expect(sansEtatEcrit()).toEqual(avant);
      const ok = await modifier({
        ...ADMINS,
        required_acr: ["loa-2", "loa-5"],
        mfa_acr: ["loa-5"],
        confirm_admin_mapping: true,
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(fournisseurEcrit()?.["mfa_acr"]).toEqual(["loa-5"]);
    });

    it("création : même confirmation et même exigence de second facteur que la modification", async () => {
      const cree = (extra: Record<string, unknown>) =>
        b.appeler("POST", "/api/admin/auth/providers", oidcValide({ id: "neuf", ...extra }));
      const avant = sansEtatEcrit();
      expect((await cree({ ...avecAdmins })).statusCode).toBe(409);
      expect((await cree({ ...avecAdmins, confirm_admin_mapping: false })).statusCode).toBe(409);
      expect((await cree({ ...ADMINS, confirm_admin_mapping: true })).statusCode).toBe(400);
      expect(sansEtatEcrit()).toEqual(avant);
      const ok = await cree({ ...avecAdmins, confirm_admin_mapping: true });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(fournisseurEcrit("neuf")?.["roles"]).toEqual(ADMINS.roles);
      expect(fournisseurEcrit("neuf")).not.toHaveProperty("confirm_admin_mapping");
    });

    it("le sens de la correspondance change : confirmation redemandée ; le libellé seul non ; rôles éteints puis rallumés : redemandée", async () => {
      ecrireFournisseur({ required_amr: ["mfa"] });
      expect((await modifier({ ...ADMINS, confirm_admin_mapping: true })).statusCode).toBe(200);
      const avant = sansEtatEcrit();
      const autresGroupes = await modifier(roles(["admins", "autres"]));
      expect(autresGroupes.statusCode).toBe(409);
      expect(sansEtatEcrit()).toEqual(avant);
      expect(
        (await modifier({ ...roles(["admins", "autres"]), confirm_admin_mapping: true })).statusCode,
      ).toBe(200);
      expect((await modifier({ label: "Autre libellé" })).statusCode).toBe(200);
      expect((await modifier(roles(["admins", "autres"], [], false))).statusCode).toBe(200);
      const rallume = await modifier(roles(["admins", "autres"]));
      expect(rallume.statusCode, "rôles rallumés").toBe(409);
    });

    it("la revendication des groupes, acr, amr et les niveaux qui prouvent un second facteur font aussi le sens de la correspondance", async () => {
      ecrireFournisseur({ required_amr: ["mfa"] });
      expect((await modifier({ ...ADMINS, confirm_admin_mapping: true })).statusCode).toBe(200);
      for (const change of [
        { groups_claim: "roles" },
        { required_acr: ["urn:gold"] },
        { required_amr: ["mfa", "mca"] },
        { mfa_acr: ["urn:gold"] },
      ]) {
        expect((await modifier(change)).statusCode, JSON.stringify(change)).toBe(409);
        expect((await modifier({ ...change, confirm_admin_mapping: true })).statusCode).toBe(200);
      }
    });

    it("une correspondance de groupes vers un groupe Elpis inexistant est refusée ; un groupe déjà cité reste enregistrable", async () => {
      ecrireFournisseur();
      const g = await createGroup(b.t.base, "Equipe");
      const carte = (id: number) => ({
        group_map: { enabled: true, map: [{ external: "equipe", group_id: id }] },
      });
      const refus = await modifier(carte(g + 500));
      expect(refus.statusCode).toBe(400);
      expect((await modifier(carte(g))).statusCode).toBe(200);
      await b.t.base.run('DELETE FROM "groups" WHERE id=?', [g]);
      expect((await modifier({ label: "Autre" })).statusCode).toBe(200);
      const cree = await b.appeler("POST", "/api/admin/auth/providers", {
        ...oidcValide({ id: "neuf" }),
        ...carte(g + 500),
      });
      expect(cree.statusCode).toBe(400);
    });

    it("valeur vide ou en double refusée ; deux valeurs externes pour un même groupe Elpis acceptées", async () => {
      ecrireFournisseur();
      const gEquipe = await createGroup(b.t.base, "Equipe");
      const gAutre = await createGroup(b.t.base, "Autre");
      const refuse = async (corps: Record<string, unknown>): Promise<void> =>
        expect((await modifier(corps)).statusCode, JSON.stringify(corps)).toBe(400);
      await refuse(roles([""]));
      await refuse(roles(["a", "a"]));
      await refuse({ group_map: { enabled: false, map: [{ external: "", group_id: 1 }] } });
      await refuse({
        group_map: {
          enabled: false,
          map: [
            { external: "g", group_id: 1 },
            { external: "g", group_id: 1 },
          ],
        },
      });
      const ok = await modifier({
        group_map: {
          enabled: true,
          map: [
            { external: "g", group_id: gEquipe },
            { external: "g", group_id: gAutre },
          ],
        },
      });
      expect(ok.statusCode, ok.body).toBe(200);
    });
  });
});

describe.skipIf(!OPENSSL_DISPONIBLE).each(MOTEURS)("rôles et groupes par le SSO (%s)", (moteur) => {
  let b: BancOidc;
  let gEquipe: number;

  const reglages = (extra: Record<string, unknown>) => b.reglages(extra);
  const niveau = (nom: string): Promise<number> => niveauDe(b.t.base, nom);
  const groupesDe = (nom: string): Promise<number[]> => groupesDeCompte(b.t.base, nom);
  const connecte = async (
    sub: string,
    groupes: string[] | undefined,
    extra: Record<string, unknown> = {},
  ) => {
    const r = await b.connecter(ELPIS(sub, { groups: groupes, ...extra }));
    expect(r.retour.statusCode, String(r.retour.headers.location)).toBe(200);
    return r.session;
  };
  const vivante = async (session: string): Promise<boolean> =>
    (await b.main.inject({ method: "GET", url: "/api/me-lite", headers: { cookie: session } })).json<{
      logged_in?: boolean;
    }>().logged_in === true;
  const idDe = async (nom: string): Promise<number> =>
    Number((await b.t.base.get<{ id: number }>("SELECT id FROM users WHERE username=?", [nom]))?.id);

  beforeEach(async () => {
    lignesJournal.length = 0;
    b = await ouvrirBancOidc(moteur);
    gEquipe = await createGroup(b.t.base, "Equipe");
  });
  afterEach(async () => {
    await b.fermer();
  });

  it("administrateur par groupe avec second facteur exigé : monté à la connexion, audité, modérateur puis utilisateur au gré du jeton", async () => {
    await reglages({ ...roles(["admins"], ["mods"]), required_amr: ["mfa"] });
    const r = await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "admins"], ...MFA }));
    expect(r.retour.statusCode, r.retour.body).toBe(200);
    expect(r.session).toContain("mcpwebui_session");
    expect(await niveau("sub-jean")).toBe(NIVEAU.admin);
    const jean = await idDe("sub-jean");
    const ligne = audits("auth.role.sync")[0];
    expect(ligne).toMatchObject({
      user_id: jean,
      username: "sub-jean",
      details: { target_user_id: jean, provider_id: "sso", from: "user", to: "admin" },
    });
    expect(JSON.stringify(ligne)).not.toContain("admins");
    await connecte("sub-jean", ["elpis", "mods"], MFA);
    expect(await niveau("sub-jean")).toBe(NIVEAU.moderator);
    await connecte("sub-jean", ["elpis"], MFA);
    expect(await niveau("sub-jean")).toBe(NIVEAU.user);
    expect(audits("auth.role.sync").map((l) => (l["details"] as Record<string, unknown>)["to"])).toEqual([
      "admin",
      "moderator",
      "user",
    ]);
    await connecte("sub-jean", ["elpis"], MFA);
    expect(audits("auth.role.sync")).toHaveLength(3);
  });

  it("une rétrogradation coupe les anciennes sessions du compte ; une montée n'en coupe aucune", async () => {
    await reglages({ ...roles(["admins"], ["mods"]), required_amr: ["mfa"] });
    const simple = await connecte("sub-jean", ["elpis", "mods"], MFA);
    const admin = await connecte("sub-jean", ["elpis", "admins"], MFA);
    expect(await vivante(simple), "montée : l'ancienne session vit").toBe(true);
    const moderateur = await connecte("sub-jean", ["elpis", "mods"], MFA);
    expect(await vivante(admin), "rétrogradation : l'ancienne session est morte").toBe(false);
    expect(await vivante(moderateur)).toBe(true);
    const utilisateur = await connecte("sub-jean", ["elpis"], MFA);
    expect(await vivante(moderateur)).toBe(false);
    expect(await vivante(utilisateur)).toBe(true);
  });

  it("modérateur sans administrateur à régler : aucun second facteur demandé ; administrateur avant modérateur quand les deux groupes figurent", async () => {
    await reglages(roles([], ["mods"]));
    await connecte("sub-luc", ["elpis", "mods"]);
    expect(await niveau("sub-luc")).toBe(NIVEAU.moderator);
    await reglages({ ...roles(["admins"], ["mods"]), required_amr: ["mfa"] });
    await connecte("sub-luc", ["elpis", "mods", "admins"], MFA);
    expect(await niveau("sub-luc")).toBe(NIVEAU.admin);
  });

  it("valeur exacte : la casse, un chemin ou un nom proche ne donnent rien", async () => {
    await reglages({ ...roles(["admins"]), required_amr: ["mfa"] });
    for (const proche of ["Admins", "/admins", "admins ", "admin", "autre/admins"]) {
      await connecte("sub-jean", ["elpis", proche], MFA);
      expect(await niveau("sub-jean"), proche).toBe(NIVEAU.user);
    }
    await reglages({ ...roles(["/elpis/admins"]), required_amr: ["mfa"] });
    await connecte("sub-jean", ["elpis", "admins"], MFA);
    expect(await niveau("sub-jean")).toBe(NIVEAU.user);
    await connecte("sub-jean", ["elpis", "/elpis/admins"], MFA);
    expect(await niveau("sub-jean")).toBe(NIVEAU.admin);
    expect(audits("auth.role.sync")).toHaveLength(1);
  });

  it("sans second facteur exigé (réglage écrit à la main), les groupes d'administrateurs sont ignorés ; ceux des modérateurs agissent", async () => {
    await reglages(roles(["admins"], ["mods"]));
    await connecte("sub-jean", ["elpis", "admins"]);
    expect(await niveau("sub-jean")).toBe(NIVEAU.user);
    await connecte("sub-jean", ["elpis", "admins", "mods"]);
    expect(await niveau("sub-jean")).toBe(NIVEAU.moderator);
    await reglages(roles(["admins"]));
    await connecte("sub-jean", ["elpis"]);
    expect(await niveau("sub-jean")).toBe(NIVEAU.moderator);
    expect(audits("auth.role.sync")).toHaveLength(1);
  });

  it("une connexion refusée ne donne ni compte ni rôle", async () => {
    await reglages({ ...roles(["admins"]), required_amr: ["mfa"] });
    const { retour } = await b.connecter(ELPIS("sub-jean", { groups: ["elpis", "admins"] }));
    expect(retour.statusCode).toBe(302);
    expect(await b.utilisateurs()).toEqual(["chef"]);
    expect(audits("auth.role.sync")).toEqual([]);
    const { retour: hors } = await b.connecter(ELPIS("sub-luc", { groups: ["admins"], ...MFA }));
    expect(hors.statusCode).toBe(302);
    expect(await b.utilisateurs()).toEqual(["chef"]);
    expect(audits("auth.role.sync")).toEqual([]);
  });

  it("options éteintes : rien ne change, même avec des groupes réglés", async () => {
    await reglages({
      roles: { enabled: false, admin_groups: ["admins"], moderator_groups: ["mods"] },
      group_map: { enabled: false, map: [{ external: "equipe", group_id: gEquipe }] },
      required_amr: ["mfa"],
    });
    await connecte("sub-jean", ["elpis", "admins", "mods", "equipe"], MFA);
    expect(await niveau("sub-jean")).toBe(NIVEAU.user);
    expect(await groupesDe("sub-jean")).toEqual([]);
    const jean = await idDe("sub-jean");
    await b.t.base.run("UPDATE users SET is_admin=? WHERE id=?", [NIVEAU.moderator, jean]);
    await connecte("sub-jean", ["elpis"], MFA);
    expect(await niveau("sub-jean")).toBe(NIVEAU.moderator);
    expect(audits("auth.role.sync")).toEqual([]);
    expect(audits("auth.groups.sync")).toEqual([]);
  });

  it("groupes Elpis : ajout, retrait selon le jeton, valeur exacte, autres groupes intacts", async () => {
    const autre = await createGroup(b.t.base, "Autre");
    await reglages({ group_map: { enabled: true, map: [{ external: "equipe", group_id: gEquipe }] } });
    await connecte("sub-jean", ["elpis", "Equipe"]);
    expect(await groupesDe("sub-jean")).toEqual([]);
    expect(audits("auth.groups.sync")).toEqual([]);
    await connecte("sub-jean", ["elpis", "equipe"]);
    expect(await groupesDe("sub-jean")).toEqual([gEquipe]);
    const jean = await idDe("sub-jean");
    await b.t.base.run("INSERT INTO user_groups(user_id, group_id) VALUES(?,?)", [jean, autre]);
    await connecte("sub-jean", ["elpis", "Equipe"]);
    expect(await groupesDe("sub-jean")).toEqual([autre]);
    expect(
      audits("auth.groups.sync").map((l) => {
        const d = l["details"] as Record<string, unknown>;
        return [d["added"], d["removed"]];
      }),
    ).toEqual([
      [[gEquipe], []],
      [[], [gEquipe]],
    ]);
  });

  it("groupes absents du jeton ou en dépassement : la connexion est refusée et rien ne change pour le compte", async () => {
    await reglages({
      ...roles(["admins"], ["mods"]),
      required_amr: ["mfa"],
      group_map: { enabled: true, map: [{ external: "equipe", group_id: gEquipe }] },
    });
    await connecte("sub-jean", ["elpis", "admins", "equipe"], MFA);
    expect(await niveau("sub-jean")).toBe(NIVEAU.admin);
    expect(await groupesDe("sub-jean")).toEqual([gEquipe]);
    const avant = audits("auth.role.sync").length + audits("auth.groups.sync").length;
    for (const claims of [
      { groups: undefined },
      { groups: undefined, _claim_names: { groups: "src1" }, _claim_sources: { src1: {} } },
      { groups: ["elpis"], hasgroups: true },
    ]) {
      const { retour } = await b.connecter(ELPIS("sub-jean", { ...claims, ...MFA }));
      expect(retour.statusCode, JSON.stringify(claims)).toBe(302);
      expect(await niveau("sub-jean"), JSON.stringify(claims)).toBe(NIVEAU.admin);
      expect(await groupesDe("sub-jean")).toEqual([gEquipe]);
    }
    expect(audits("auth.role.sync").length + audits("auth.groups.sync").length).toBe(avant);
    await connecte("sub-jean", ["elpis"], MFA);
    expect(await niveau("sub-jean")).toBe(NIVEAU.user);
    expect(await groupesDe("sub-jean")).toEqual([]);
  });

  it("l'essai à blanc montre le rôle et les groupes Elpis qui seraient donnés, sans rien écrire", async () => {
    await reglages({
      ...roles(["admins"], ["mods"]),
      required_amr: ["mfa"],
      group_map: {
        enabled: true,
        map: [
          { external: "equipe", group_id: gEquipe },
          { external: "disparue", group_id: 9999 },
        ],
      },
    });
    const f = b.fournisseur;
    const retour = (groupes: string[] | null, secondFacteur = true) =>
      ({
        profil: { subject: "s", issuer: `oidc:${f.issuer}`, extUsername: "sujet-s" },
        appartenance: "oui",
        vue: {
          iss: f.issuer,
          sujet: "s",
          identifiant: "s",
          nom: "",
          email: "",
          emailVerifie: false,
          acr: null,
          amr: secondFacteur ? ["mfa"] : [],
          preuveSecondFacteur: secondFacteur ? "amr" : null,
          groupes,
          sujetEstIdentifiant: true,
        },
        groupesComplets: groupes,
        secondFacteur,
        idToken: null,
        idpSid: null,
        sub: "s",
      }) as Parameters<typeof resultatEssaiBlanc>[2];
    const r = await resultatEssaiBlanc(b.t.base, f, retour(["elpis", "admins", "equipe", "disparue"]), 1);
    expect(r.rights).toEqual({
      roles_enabled: true,
      groups_enabled: true,
      readable: true,
      role: "admin",
      groups: [{ id: gEquipe, name: "Equipe" }],
      missing_group_ids: [9999],
      admin_ignored: false,
    });
    expect(schemaReponseDernierEssai.safeParse({ result: r }).success).toBe(true);
    expect((await resultatEssaiBlanc(b.t.base, f, retour(["elpis", "mods"]), 1)).rights).toMatchObject({
      role: "moderator",
      groups: [],
    });
    const illisible = await resultatEssaiBlanc(b.t.base, f, retour(null), 1);
    expect(illisible.rights).toMatchObject({ readable: false, role: null, groups: [] });
    expect(await b.utilisateurs()).toEqual(["chef"]);
    expect(await b.t.base.valeurs("SELECT COUNT(*) FROM user_groups")).toEqual([[0]]);
    expect(audits("auth.role.sync")).toEqual([]);
  });

  it("l'essai à blanc signale les groupes d'administrateurs ignorés faute de second facteur exigé", async () => {
    await reglages(roles(["admins"], ["mods"]));
    const r = await resultatEssaiBlanc(
      b.t.base,
      b.fournisseur,
      {
        profil: { subject: "s", issuer: "i", extUsername: "sujet-s" },
        appartenance: "oui",
        vue: {
          iss: "",
          sujet: "s",
          identifiant: "s",
          nom: "",
          email: "",
          emailVerifie: false,
          acr: null,
          amr: [],
          preuveSecondFacteur: null,
          groupes: ["elpis", "mods"],
          sujetEstIdentifiant: true,
        },
        groupesComplets: ["elpis", "mods"],
        secondFacteur: false,
        idToken: null,
        idpSid: null,
        sub: "s",
      } as Parameters<typeof resultatEssaiBlanc>[2],
      1,
    );
    expect(r.rights).toMatchObject({ admin_ignored: true, role: "moderator", readable: true });
  });
});
