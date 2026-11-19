// SPDX-License-Identifier: MIT
/** apps/core/test/securite-auth-essai-annuaire.test.ts — le test complet d'un annuaire est le seul chemin vers l'activation : l'empreinte enregistrée est celle des réglages testés, un test incomplet n'enregistre rien, jamais de liaison vide ni de mot de passe d'utilisateur, le secret saisi n'est pas gardé, rien du serveur n'est rendu tel quel (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as serveurTls } from "node:tls";
import type { Server as ServeurTlsType } from "node:tls";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, ligneUtilisateur } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { JugeHote } from "@elpis/http";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { creerFamilleAdminIdentite } from "../src/familles/admin-identite";
import type {
  ConnexionAnnuaire,
  EntreeAnnuaire,
  FabriqueConnexion,
  OptionsRecherche,
} from "../src/identite/annuaire/client";
import {
  liaisonDeTestRefusee,
  noterEchecLiaisonDeTest,
  oublierEchecsLiaisonDeTest,
} from "../src/identite/annuaire/echecs";
import { ErreurAnnuaire } from "../src/identite/annuaire/erreur";
import {
  empreinteFournisseur,
  enregistrerSecret,
  enregistrerTestReussi,
  fournisseursActifs,
  hmacCoffre,
  hotesDuFournisseur,
  contexteSecretTeste,
  nomSecret,
  secretFournisseur,
} from "../src/identite/fournisseurs";
import { creerSecret } from "../src/secrets/stockage";
import { validerFournisseur } from "../src/identite/reglages";
import type { FournisseurLdap } from "../src/identite/reglages";
import { appTest, journalMuet, lignesAuditRecentes, lignesJournal } from "./aides";
import { CA_PEM, cleCoffreDeTest, configDeTest, ldapValide } from "./identite/aides";
import type { ConfigDeTest } from "./identite/aides";
import { MOTEURS, URL_PUBLIQUE } from "./identite/banc";
import { creerAutorite, creerFeuille, effacer, OPENSSL_DISPONIBLE } from "./identite/pki-openssl";
import type { Autorite } from "./identite/pki-openssl";

const NOM = "annuaire-essai.invalid";
const BASE = "cn=users,dc=exemple,dc=lan";
const GROUPE = "cn=elpis,cn=groups,dc=exemple,dc=lan";
const GROUPE_2 = "cn=autres,cn=groups,dc=exemple,dc=lan";
const DN_SERVICE = "uid=svc,cn=users,dc=exemple,dc=lan";
const MDP_SERVICE = "mot-de-passe-de-service";
const MARQUEUR = "MARQUEUR-SECRET-DU-TEST-5b7e";
const MARQUEUR_SERVEUR = "MARQUEUR-DU-SERVEUR-DE-TEST-c41d";
const URL_ESSAI = "/api/admin/auth/providers/test";
const ACTEUR = { userId: null, username: null, ip: null };
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface Utilisateur {
  dn: string;
  attrs: Record<string, (string | Buffer)[]>;
}

/** Annuaire en mémoire : objets existants, appartenances, utilisateurs, rootDSE ; compte les liaisons et les fermetures. */
class AnnuaireEssai {
  objets = new Set<string>([BASE, GROUPE, GROUPE_2]);
  attrsObjet: Record<string, Record<string, string[]>> = {};
  membres: Record<string, string[]> = {};
  utilisateurs: Utilisateur[] = [];
  rootDse: Record<string, string[]> | null = {};
  secretService = MDP_SERVICE;
  pause: Promise<void> | null = null;
  liaisons: [string, string][] = [];
  ouvertures = 0;
  fermetures = 0;

  ajouter(
    uid: string,
    extra: Record<string, (string | Buffer)[]> = {},
    groupes: string[] = [GROUPE],
  ): Utilisateur {
    const u: Utilisateur = {
      dn: `uid=${uid},${BASE}`,
      attrs: {
        uid: [uid],
        entryuuid: [uuid(this.utilisateurs.length + 1)],
        mail: [`${uid}@exemple.lan`],
        cn: [`Nom ${uid}`],
        description: [MARQUEUR_SERVEUR],
        ...extra,
      },
    };
    this.utilisateurs.push(u);
    for (const g of groupes) (this.membres[g] ??= []).push(u.dn);
    return u;
  }

  get liaisonsUtilisateur(): [string, string][] {
    return this.liaisons.filter(([dn]) => dn !== DN_SERVICE);
  }

  readonly fabrique: FabriqueConnexion = () => {
    this.ouvertures += 1;
    let lie = false;
    const cnx: ConnexionAnnuaire = {
      lier: async (dn, mdp) => {
        if (lie || mdp === "") throw new ErreurAnnuaire("configuration");
        lie = true;
        this.liaisons.push([dn, mdp]);
        if (this.pause) await this.pause;
        if (dn !== DN_SERVICE || mdp !== this.secretService) throw new ErreurAnnuaire("identifiants");
      },
      chercher: (base, o) => Promise.resolve(this.chercher(base, o)),
      fermer: () => {
        this.fermetures += 1;
        return Promise.resolve();
      },
    };
    return Promise.resolve(cnx);
  };

  private chercher(base: string, o: OptionsRecherche): EntreeAnnuaire[] {
    if (base === "") {
      if (this.rootDse === null) throw new ErreurAnnuaire("protocole", { code: 50 });
      return [{ dn: "", attrs: this.rootDse }];
    }
    if (o.filtre === "(objectClass=*)") {
      if (!this.objets.has(base)) throw new ErreurAnnuaire("protocole", { code: 32 });
      return [{ dn: base, attrs: this.attrsObjet[base] ?? {} }];
    }
    const principal = /^\(primaryGroupID=(\d+)\)$/u.exec(o.filtre);
    if (principal !== null)
      return this.utilisateurs
        .filter((u) => u.attrs["primarygroupid"]?.[0] === principal[1])
        .map((u) => ({ dn: u.dn, attrs: {} }));
    const membre = /^\(\|\(member=(.*)\)\(uniqueMember=.*\)\)$/u.exec(o.filtre);
    if (membre !== null) {
      if (membre[1] === "*") return (this.membres[base]?.length ?? 0) > 0 ? [{ dn: base, attrs: {} }] : [];
      return this.membres[base]?.includes(membre[1] ?? "") ? [{ dn: base, attrs: {} }] : [];
    }
    const deGroupe = /^\(memberOf=(.*)\)$/u.exec(o.filtre);
    if (deGroupe !== null)
      return (this.membres[deGroupe[1] ?? ""] ?? [])
        .filter((dn) => base === BASE || dn === base)
        .slice(0, 1)
        .map((dn) => ({ dn, attrs: {} }));
    const uid = /\(uid=([^)]*)\)/u.exec(o.filtre);
    if (uid === null || base !== BASE) return [];
    return this.utilisateurs
      .filter((u) => u.attrs["uid"]?.[0] === uid[1])
      .map((u) => ({ dn: u.dn, attrs: u.attrs }));
  }
}

interface Etape {
  id: string;
  label: string;
  level: "ok" | "warn" | "fail";
  detail: string;
  target: string | null;
}
interface Reponse {
  ok: boolean;
  complete: boolean;
  steps: Etape[];
}

describe.skipIf(!OPENSSL_DISPONIBLE)("test complet d'un annuaire", () =>
  describe.each(MOTEURS)("%s", (moteur) => {
    let t: BaseDeTest;
    let cfg: ConfigDeTest;
    let dossier: string;
    let admin: FastifyInstance;
    let chef = 0;
    let modo = 0;
    let ca: Autorite;
    let serveur: ServeurTlsType;
    let port = 0;
    let cookieSecure = true;
    let annuaire = new AnnuaireEssai();
    const essai: { sortant: { juger: JugeHote; delaiConnexionMs: number }; delaiGlobalMs?: number } = {
      sortant: { juger: async () => ({ motif: null, adresses: ["127.0.0.1"] }), delaiConnexionMs: 2000 },
    };
    const sockets: { destroy: () => void }[] = [];

    beforeAll(async () => {
      t = ouvrirBaseDeTest(moteur);
      await initialiserBase(t.base);
      cleCoffreDeTest();
      cfg = configDeTest({ https: true });
      dossier = mkdtempSync(join(tmpdir(), "elpis-essai-annuaire-"));
      configureAudit({
        service: "admin",
        auditDir: join(dossier, "audit"),
        hmacKeyPath: join(dossier, "sans-cle"),
      });
      chef = await createUser(t.base, "chef", "mdp-chef-1", { isAdmin: 1 });
      modo = await createUser(t.base, "modo", "mdp-modo-1", { isAdmin: 2 });
      ca = creerAutorite("CA essai annuaire");
      const feuille = creerFeuille(ca, { noms: [NOM] });
      serveur = serveurTls({ cert: feuille.cert, key: feuille.cle }, (s) => {
        s.on("error", () => undefined);
        sockets.push(s);
      });
      await new Promise<void>((r) => serveur.listen(0, "127.0.0.1", () => r()));
      port = (serveur.address() as AddressInfo).port;
      const role = async (req: FastifyRequest, roles: number[]): Promise<void> => {
        const uid = req.headers["x-uid"];
        if (!uid) throw new HttpError(401, "not logged in");
        const ligne = await ligneUtilisateur(t.base, Number(uid));
        req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
        if (!ligne || !roles.includes(Number(ligne.is_admin))) throw new HttpError(403, "Admin required");
      };
      const auth = {
        ...dependancesParDefaut(t.base),
        attributsCookie: () => ({
          cookie_name: "mcpwebui_session",
          same_site: "lax" as const,
          https_only: cookieSecure,
          max_age: 86_400,
        }),
      };
      admin = await appTest({
        mode: "admin",
        familles: [
          creerFamilleAdminIdentite({
            base: t.base,
            auth,
            journal: journalMuet,
            revoquer: async () => undefined,
            essai,
            fabriqueAnnuaire: () => annuaire.fabrique,
          }),
        ],
        gardes: {
          admin: (req: FastifyRequest) => role(req, [1]),
          staff: (req: FastifyRequest) => role(req, [1, 2]),
          session: (req: FastifyRequest) => role(req, [0, 1, 2]),
          service: async () => {
            throw new HttpError(403, "service");
          },
        },
      });
    });
    afterAll(async () => {
      await admin.close();
      for (const x of sockets) x.destroy();
      await new Promise<void>((r) => serveur.close(() => r()));
      oublierConfigurationAudit();
      effacer(ca);
      cfg.fermer();
      await t.fermer();
      rmSync(dossier, { recursive: true, force: true });
    });

    const reglages = (extra: Record<string, unknown> = {}): Record<string, unknown> =>
      ldapValide({
        urls: [`ldaps://${NOM}:${port}`],
        ca_pem: ca.cert,
        required_groups: [GROUPE],
        groups: { mode: "member" },
        ...extra,
      });
    const fournisseur = (extra: Record<string, unknown> = {}): FournisseurLdap => {
      const f = validerFournisseur(reglages(extra));
      if (f.type !== "ldap") throw new Error("LDAP attendu");
      return f;
    };
    const etat = (): Promise<unknown[][]> =>
      t.base.valeurs("SELECT provider_id, tested_hash FROM auth_provider_state");
    const appeler = (
      methode: "POST" | "PUT",
      url: string,
      corps: unknown,
      uid: number | null = chef,
    ): Promise<LightMyRequestResponse> =>
      admin.inject({
        method: methode,
        url,
        headers: uid === null ? {} : { "x-uid": String(uid) },
        payload: corps as object,
      });
    const tester = async (corps: Record<string, unknown>): Promise<Reponse> => {
      const r = await appeler("POST", URL_ESSAI, corps);
      expect(r.statusCode, r.body).toBe(200);
      return r.json<Reponse>();
    };
    const ids = (r: Reponse): string[] => r.steps.map((s) => s.id);
    const etape = (r: Reponse, id: string): Etape | undefined => r.steps.find((s) => s.id === id);
    const avecSecretRange = async (f: FournisseurLdap): Promise<void> => {
      await enregistrerSecret(t.base, f, MDP_SERVICE, ACTEUR);
    };

    beforeEach(async () => {
      annuaire = new AnnuaireEssai();
      annuaire.ajouter("jean");
      cookieSecure = true;
      essai.delaiGlobalMs = undefined;
      lignesJournal.length = 0;
      await t.base.run("DELETE FROM auth_provider_state");
      await t.base.run("DELETE FROM auth_failures");
      await t.base.run("DELETE FROM vault_secrets");
      cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [fournisseur()] } });
    });
    afterEach(() => {
      essai.delaiGlobalMs = undefined;
    });

    it("groupes des rôles et de la correspondance : ils existent, et l'utilisateur d'essai montre le rôle et les groupes Elpis obtenus", async () => {
      await avecSecretRange(fournisseur());
      annuaire.ajouter("luc", {}, [GROUPE, GROUPE_2]);
      const regles = {
        roles: { enabled: true, admin_groups: [GROUPE_2], moderator_groups: [] },
        group_map: { enabled: true, map: [{ external: GROUPE_2, group_id: 7 }] },
      };
      const r = await tester({ ...reglages(regles), test_user: "luc" });
      expect(ids(r).slice(7)).toEqual([
        "groups",
        "role_groups",
        "test_user",
        "test_user_groups",
        "test_user_rights",
        "test_user_profile",
      ]);
      expect(etape(r, "role_groups")).toMatchObject({ level: "ok" });
      expect(etape(r, "test_user_rights")).toMatchObject({ level: "ok" });
      expect(etape(r, "test_user_rights")?.detail).toBe(
        "Rôle obtenu : administrateur. Groupes Elpis (identifiants) : 7.",
      );
      expect(r.complete).toBe(true);
      const simple = await tester({ ...reglages(regles), test_user: "jean" });
      expect(etape(simple, "test_user_rights")?.detail).toBe(
        "Rôle obtenu : utilisateur. Groupes Elpis (identifiants) : aucun.",
      );
      const absent = "cn=absent,cn=groups,dc=exemple,dc=lan";
      const manque = await tester({
        ...reglages({ ...regles, roles: { enabled: true, admin_groups: [absent], moderator_groups: [] } }),
        test_user: "luc",
      });
      expect(etape(manque, "role_groups")).toMatchObject({ level: "fail" });
      expect(etape(manque, "role_groups")?.detail).toContain(absent);
      expect(manque.complete).toBe(false);
    });

    it("test complet : toutes les étapes, empreinte enregistrée, jamais de liaison d'utilisateur, activation acceptée", async () => {
      const f = fournisseur();
      await avecSecretRange(f);
      const r = await tester({ ...reglages(), test_user: "jean" });
      expect(ids(r)).toEqual([
        "settings",
        "prerequisites",
        "resolve",
        "address",
        "tls",
        "service_bind",
        "user_base",
        "groups",
        "test_user",
        "test_user_groups",
        "test_user_profile",
      ]);
      expect(r.steps.map((s) => s.level)).toEqual(r.steps.map(() => "ok"));
      expect(r.ok && r.complete).toBe(true);
      expect(etape(r, "service_bind")?.target).toBe(`${NOM}:${port}`);
      expect(etape(r, "test_user_profile")?.detail).toContain("Nom Elpis : jean");
      expect(annuaire.liaisons).toEqual([[DN_SERVICE, MDP_SERVICE]]);
      expect(annuaire.liaisonsUtilisateur).toEqual([]);
      expect(annuaire.fermetures).toBe(annuaire.ouvertures);
      const [[idEtat, rangee]] = (await etat()) as [[string, string]];
      expect(idEtat).toBe("annuaire");
      expect(JSON.parse(rangee)).toEqual({
        h: empreinteFournisseur(f, URL_PUBLIQUE),
        s: hmacCoffre(contexteSecretTeste("annuaire"), MDP_SERVICE),
      });
      expect(rangee).not.toContain(MDP_SERVICE);
      const ev = lignesAuditRecentes({ actionPrefix: "admin.auth.provider.test" })[0];
      expect(ev?.["details"]).toEqual({
        provider_id: "annuaire",
        type: "ldap",
        ok: true,
        complete: true,
        failed_step: null,
        targets: [`${NOM}:${port}`],
        bind_dn: DN_SERVICE,
        secret_origin: "stored",
        test_user: hmacCoffre("elpis.auth.test-user.v1", "jean")?.slice(0, 16),
      });
      expect((ev?.["details"] as Record<string, unknown>)["test_user"]).not.toBe(
        createHash("sha256").update("jean").digest("hex").slice(0, 16),
      );
      const activer = await appeler("POST", "/api/admin/auth/providers/annuaire/enable", {});
      expect(activer.statusCode, activer.body).toBe(200);
    });

    it("sans utilisateur d'essai : étapes jouées, avertissement, jamais complet, rien d'enregistré", async () => {
      await avecSecretRange(fournisseur());
      for (const corps of [reglages(), { ...reglages(), test_user: "" }]) {
        const r = await tester(corps);
        expect(ids(r).slice(5)).toEqual(["service_bind", "user_base", "groups", "test_user"]);
        expect(etape(r, "test_user")).toMatchObject({ level: "warn" });
        expect(r.ok).toBe(true);
        expect(r.complete).toBe(false);
      }
      expect(await etat()).toEqual([]);
      expect((await appeler("POST", "/api/admin/auth/providers/annuaire/enable", {})).statusCode).toBe(409);
    });

    it("réglages modifiés après le test : l'empreinte ne correspond plus et l'activation est refusée", async () => {
      await avecSecretRange(fournisseur());
      expect((await tester({ ...reglages(), test_user: "jean" })).complete).toBe(true);
      const modif = await appeler("PUT", "/api/admin/auth/providers/annuaire", {
        user_filter: "(&(objectClass=person)(uid={username}))",
      });
      expect(modif.statusCode, modif.body).toBe(200);
      const activer = await appeler("POST", "/api/admin/auth/providers/annuaire/enable", {});
      expect([activer.statusCode, activer.json<{ detail: string }>().detail]).toEqual([
        409,
        expect.stringMatching(/test réussi/u),
      ]);
    });

    it("l'empreinte est celle des réglages testés, non des réglages enregistrés", async () => {
      await avecSecretRange(fournisseur());
      const autres = { user_filter: "(&(objectClass=person)(uid={username}))" };
      expect((await tester({ ...reglages(autres), test_user: "jean" })).complete).toBe(true);
      expect((await appeler("POST", "/api/admin/auth/providers/annuaire/enable", {})).statusCode).toBe(409);
      expect((await appeler("PUT", "/api/admin/auth/providers/annuaire", autres)).statusCode).toBe(200);
      expect((await appeler("POST", "/api/admin/auth/providers/annuaire/enable", {})).statusCode).toBe(200);
    });

    it("fournisseur inconnu de la configuration : rien n'est enregistré", async () => {
      const r = await tester({ ...reglages({ id: "autre" }), test_user: "jean", secret: MDP_SERVICE });
      expect(r.complete).toBe(true);
      expect(await etat()).toEqual([]);
    });

    it("fournisseur allumé : un test complet d'autres réglages ne retire pas son test réussi", async () => {
      const f = fournisseur({ enabled: true });
      await avecSecretRange(f);
      await enregistrerTestReussi(t.base, f, URL_PUBLIQUE);
      cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [f] } });
      const avant = await etat();
      const r = await tester({
        ...reglages({ user_filter: "(&(objectClass=person)(uid={username}))" }),
        test_user: "jean",
      });
      expect(r.complete).toBe(true);
      expect(await etat()).toEqual(avant);
    });

    it("un test incomplet n'enregistre rien : délai global, même si le travail finit ensuite", async () => {
      await avecSecretRange(fournisseur());
      let lacher: () => void = () => undefined;
      annuaire.pause = new Promise<void>((r) => {
        lacher = r;
      });
      essai.delaiGlobalMs = 150;
      const r = await tester({ ...reglages(), test_user: "jean" });
      lacher();
      await new Promise((x) => setTimeout(x, 300));
      expect(r.complete).toBe(false);
      expect(r.steps.at(-1)?.id).toBe("timeout");
      expect(await etat()).toEqual([]);
      expect(annuaire.liaisonsUtilisateur).toEqual([]);
    });

    it("une autre adresse en échec rend le test incomplet", async () => {
      await avecSecretRange(fournisseur());
      const r = await tester({
        ...reglages({ urls: [`ldaps://${NOM}:${port}`, `ldaps://${NOM}:${port + 1}`] }),
        test_user: "jean",
      });
      expect(r.ok).toBe(false);
      expect(r.complete).toBe(false);
      expect(await etat()).toEqual([]);
    });

    describe("secret", () => {
      it("secret saisi : il sert, il n'est pas enregistré, il ne sort nulle part", async () => {
        annuaire.secretService = MARQUEUR;
        const avant = await t.base.valeurs("SELECT id FROM vault_secrets");
        const r = await appeler("POST", URL_ESSAI, { ...reglages(), test_user: "jean", secret: MARQUEUR });
        expect(r.json<Reponse>().complete).toBe(true);
        expect(await t.base.valeurs("SELECT id FROM vault_secrets")).toEqual(avant);
        const sorties = [
          r.body,
          JSON.stringify(lignesAuditRecentes({ limit: 50 })),
          lignesJournal.join("\n"),
          readFileSync(cfg.chemin, "utf8"),
        ].join("\n");
        expect(sorties).not.toContain(MARQUEUR);
        expect(annuaire.liaisons).toEqual([[DN_SERVICE, MARQUEUR]]);
      });

      it("secret saisi refusé par l'annuaire : phrase claire, rien d'autre n'est tenté", async () => {
        await avecSecretRange(fournisseur());
        const r = await tester({ ...reglages(), test_user: "jean", secret: "faux" });
        expect(r.steps.at(-1)).toMatchObject({ id: "service_bind", level: "fail" });
        expect(ids(r)).not.toContain("user_base");
        expect(r.complete).toBe(false);
        expect(await etat()).toEqual([]);
      });

      it("secret absent ou hors de la portée de l'adresse testée : « ressaisissez », aucune connexion à l'annuaire", async () => {
        const sans = await tester({ ...reglages(), test_user: "jean" });
        expect(etape(sans, "service_bind")).toMatchObject({ level: "fail" });
        expect(etape(sans, "service_bind")?.detail).toContain("ressaisissez");
        await avecSecretRange(fournisseur({ urls: ["ldaps://ailleurs.invalid:636"] }));
        const hors = await tester({ ...reglages(), test_user: "jean" });
        expect(etape(hors, "service_bind")?.detail).toContain("ressaisissez");
        expect(annuaire.ouvertures).toBe(0);
        expect(annuaire.liaisons).toEqual([]);
        expect(hors.complete).toBe(false);
      });

      it("secret invalide ou vide : jamais de liaison vide", async () => {
        for (const secret of [123, "a\0b", "x".repeat(2000)]) {
          const r = await tester({ ...reglages(), test_user: "jean", secret });
          expect(etape(r, "service_bind")).toMatchObject({ level: "fail" });
        }
        const vide = await tester({ ...reglages(), test_user: "jean", secret: "" });
        expect(etape(vide, "service_bind")?.detail).toContain("ressaisissez");
        expect(annuaire.liaisons).toEqual([]);
      });
    });

    describe("bouton Tester : pas d'oracle de liaison", () => {
      const DN_VOISIN = "uid=autre,cn=users,dc=exemple,dc=lan";

      it("secret enregistré et DN de liaison différent : refus « ressaisissez », aucune connexion à l'annuaire", async () => {
        await avecSecretRange(fournisseur());
        const r = await tester({ ...reglages({ bind_dn: DN_VOISIN }), test_user: "jean" });
        expect(etape(r, "service_bind")).toMatchObject({ level: "fail" });
        expect(etape(r, "service_bind")?.detail).toContain("ressaisissez");
        expect(annuaire.ouvertures).toBe(0);
        expect(annuaire.liaisons).toEqual([]);
        expect(r.complete).toBe(false);
        expect(await etat()).toEqual([]);
      });

      it("même DN écrit autrement (casse, blancs) : le secret enregistré sert, ce DN-là seul le reçoit", async () => {
        await avecSecretRange(fournisseur());
        const variante = "UID=svc , cn=users,DC=exemple, dc=lan";
        await tester({ ...reglages({ bind_dn: variante }), test_user: "jean" });
        expect(annuaire.liaisons).toEqual([[variante, MDP_SERVICE]]);
      });

      it("secret saisi : il sert pour n'importe quel DN, jamais le secret enregistré", async () => {
        await avecSecretRange(fournisseur());
        await tester({ ...reglages({ bind_dn: DN_VOISIN }), test_user: "jean", secret: "essai-1" });
        expect(annuaire.liaisons).toEqual([[DN_VOISIN, "essai-1"]]);
      });

      it("adresses : le secret enregistré ne part jamais vers une adresse que le fournisseur enregistré n'a pas", async () => {
        await avecSecretRange(fournisseur());
        const r = await tester({
          ...reglages({ urls: [`ldaps://${NOM}:${port}`, `ldaps://${NOM}:${port + 1}`] }),
          test_user: "jean",
        });
        expect(annuaire.liaisons.filter(([, mdp]) => mdp === MDP_SERVICE)).toEqual([]);
        expect(r.complete).toBe(false);
      });

      it("secret enregistré et autorité de certification différente, retirée ou ajoutée : « ressaisissez », aucune connexion", async () => {
        await avecSecretRange(fournisseur());
        for (const ca_pem of [CA_PEM, ""]) {
          const r = await tester({ ...reglages({ ca_pem }), test_user: "jean" });
          expect(r.complete).toBe(false);
        }
        cfg.ecrire({ auth: { public_url: URL_PUBLIQUE, providers: [fournisseur({ ca_pem: "" })] } });
        const ajoutee = await tester({ ...reglages(), test_user: "jean" });
        expect(etape(ajoutee, "service_bind")?.detail).toContain("ressaisissez");
        expect(annuaire.ouvertures).toBe(0);
        expect(annuaire.liaisons).toEqual([]);
        expect(await etat()).toEqual([]);
      });

      it("réglages enregistrés d'abord (PUT) puis testés : autorité ou DN changés, le secret enregistré ne part nulle part et le fournisseur n'est pas activable", async () => {
        await avecSecretRange(fournisseur());
        const put = await appeler("PUT", "/api/admin/auth/providers/annuaire", { ca_pem: CA_PEM });
        expect(put.statusCode, put.body).toBe(200);
        const sousAutreAc = await tester({ ...reglages({ ca_pem: CA_PEM }), test_user: "jean" });
        expect(sousAutreAc.complete).toBe(false);
        expect(await secretFournisseur(t.base, fournisseur({ ca_pem: CA_PEM }))).toBeNull();
        await appeler("PUT", "/api/admin/auth/providers/annuaire", { ca_pem: ca.cert });
        const dn = await appeler("PUT", "/api/admin/auth/providers/annuaire", { bind_dn: DN_VOISIN });
        expect(dn.statusCode, dn.body).toBe(200);
        const autreDn = await tester({ ...reglages({ bind_dn: DN_VOISIN }), test_user: "jean" });
        expect(etape(autreDn, "service_bind")?.detail).toContain("ressaisissez");
        expect(annuaire.ouvertures).toBe(0);
        expect(annuaire.liaisons).toEqual([]);
        expect(await etat()).toEqual([]);
        const ids = await fournisseursActifs(t.base, () => true);
        expect(ids).toEqual([]);
      });

      it("secret rangé avec l'ancienne forme de portée (hôtes seuls) : hors de portée", async () => {
        const f = fournisseur();
        await creerSecret(
          t.base,
          null,
          {
            name: nomSecret(f.id),
            kind: "token",
            scope: { hosts: hotesDuFournisseur(f) },
            value: MDP_SERVICE,
            policy: { subagents: false, routines: false, confirm_first_use: false, tls: "strict" },
          },
          ACTEUR,
        );
        expect(await secretFournisseur(t.base, f)).toBeNull();
      });

      it("secret enregistré et même autorité : il sert", async () => {
        await avecSecretRange(fournisseur());
        await tester({ ...reglages(), test_user: "jean" });
        expect(annuaire.liaisons).toEqual([[DN_SERVICE, MDP_SERVICE]]);
      });

      it("10 échecs de liaison pour toute l'instance, quels que soient les DN : le onzième test est refusé ; un succès ne remet pas ce budget à zéro", async () => {
        const ecrit = (i: number): string =>
          [
            `uid=a${i},cn=users,dc=exemple,dc=lan`,
            `UID=a${i} , cn=users,dc=exemple,dc=lan`,
            `uid=\\61${i},cn=users,dc=exemple,dc=lan`,
            `0.9.2342.19200300.100.1.1=a${i},cn=users,dc=exemple,dc=lan`,
            `cn=users+uid=a${i},dc=exemple,dc=lan`,
          ][i % 5] as string;
        for (let i = 0; i < 9; i++)
          await tester({ ...reglages({ bind_dn: ecrit(i) }), test_user: "jean", secret: "faux" });
        await tester({ ...reglages(), test_user: "jean", secret: MDP_SERVICE });
        await tester({ ...reglages({ bind_dn: ecrit(9) }), test_user: "jean", secret: "faux" });
        const ouvertures = annuaire.ouvertures;
        const refuse = await tester({
          ...reglages({ bind_dn: ecrit(10) }),
          test_user: "jean",
          secret: "faux",
        });
        expect(etape(refuse, "service_bind")?.detail).toContain("Trop d'échecs");
        const bon = await tester({ ...reglages(), test_user: "jean", secret: MDP_SERVICE });
        expect(etape(bon, "service_bind")?.detail).toContain("Trop d'échecs");
        expect(annuaire.ouvertures).toBe(ouvertures);
      });

      it("le budget de l'instance se vide avec la fenêtre", async () => {
        const t0 = 1_800_000_000;
        for (let i = 0; i < 10; i++) await noterEchecLiaisonDeTest(t.base, `uid=u${i},dc=x`, t0);
        expect(await liaisonDeTestRefusee(t.base, "uid=neuf,dc=x", t0 + 899)).toBe(true);
        expect(await liaisonDeTestRefusee(t.base, "uid=neuf,dc=x", t0 + 900)).toBe(false);
      });

      it("5 échecs de liaison pour un même DN : le sixième test est refusé sans contacter l'annuaire ; un autre DN n'est pas touché", async () => {
        for (let i = 0; i < 5; i++) {
          const r = await tester({ ...reglages(), test_user: "jean", secret: `faux-${i}` });
          expect(etape(r, "service_bind")?.detail).toContain("refuse le compte de service");
        }
        const ouvertures = annuaire.ouvertures;
        const refuse = await tester({ ...reglages(), test_user: "jean", secret: MDP_SERVICE });
        expect(etape(refuse, "service_bind")).toMatchObject({ level: "fail" });
        expect(etape(refuse, "service_bind")?.detail).toContain("Trop d'échecs");
        expect(annuaire.ouvertures).toBe(ouvertures);
        expect(refuse.complete).toBe(false);
        await tester({ ...reglages({ bind_dn: DN_VOISIN }), test_user: "jean", secret: "faux" });
        expect(annuaire.ouvertures).toBe(ouvertures + 1);
      });

      it("le compteur se vide avec le temps et une liaison réussie le remet à zéro", async () => {
        const dn = "uid=temps,dc=x";
        const t0 = 1_800_000_000;
        for (let i = 0; i < 5; i++) await noterEchecLiaisonDeTest(t.base, dn, t0);
        expect(await liaisonDeTestRefusee(t.base, dn, t0)).toBe(true);
        expect(await liaisonDeTestRefusee(t.base, dn.toUpperCase(), t0)).toBe(true);
        expect(await liaisonDeTestRefusee(t.base, dn, t0 + 899)).toBe(true);
        expect(await liaisonDeTestRefusee(t.base, dn, t0 + 900)).toBe(false);
        await noterEchecLiaisonDeTest(t.base, dn, t0 + 901);
        expect(await liaisonDeTestRefusee(t.base, dn, t0 + 901)).toBe(false);
        await oublierEchecsLiaisonDeTest(t.base, dn);
        expect(await liaisonDeTestRefusee(t.base, dn, t0)).toBe(false);
      });

      it("audit : bind_dn et origine du secret (saisi, enregistré, aucun)", async () => {
        const details = (): Record<string, unknown> =>
          lignesAuditRecentes({ actionPrefix: "admin.auth.provider.test" })[0]?.["details"] as Record<
            string,
            unknown
          >;
        await tester({ ...reglages(), test_user: "jean", secret: MDP_SERVICE });
        expect(details()).toMatchObject({ bind_dn: DN_SERVICE, secret_origin: "typed" });
        await avecSecretRange(fournisseur());
        await tester({ ...reglages(), test_user: "jean" });
        expect(details()).toMatchObject({ bind_dn: DN_SERVICE, secret_origin: "stored" });
        await t.base.run("DELETE FROM vault_secrets");
        await tester({ ...reglages(), test_user: "jean" });
        expect(details()).toMatchObject({ secret_origin: "none" });
      });

      it("sortie : marques de direction et largeur nulle retirées des valeurs venues de l'annuaire", async () => {
        annuaire.utilisateurs = [];
        annuaire.membres = {};
        annuaire.ajouter("jean", { cn: ["Je\u200Ban\u202E Dupont"], mail: ["a\u2066@exemple.lan"] });
        await avecSecretRange(fournisseur());
        const r = await tester({ ...reglages(), test_user: "jean" });
        const detail = [etape(r, "test_user")?.detail, etape(r, "test_user_profile")?.detail].join(" ");
        expect(detail).toContain("Jean Dupont");
        expect(detail).not.toMatch(/[\u200B\u202E\u2066]/u);
      });

      it("l'empreinte du test couvre le secret employé : saisi différent de l'enregistré, ou enregistré changé après le test, refusent l'activation", async () => {
        await avecSecretRange(fournisseur());
        await tester({ ...reglages(), test_user: "jean", secret: MDP_SERVICE });
        annuaire.secretService = "autre-secret";
        await appeler("PUT", "/api/admin/auth/providers/annuaire/secret", { secret: "autre-secret" });
        const refus = await appeler("POST", "/api/admin/auth/providers/annuaire/enable", {});
        expect(refus.statusCode).toBe(409);
        const refait = await tester({ ...reglages(), test_user: "jean" });
        expect(refait.complete).toBe(true);
        expect((await appeler("POST", "/api/admin/auth/providers/annuaire/enable", {})).statusCode).toBe(200);
      });

      it("test avec un secret saisi différent du secret enregistré : le test réussit mais l'activation reste refusée", async () => {
        await avecSecretRange(fournisseur());
        annuaire.secretService = "saisi-different";
        const r = await tester({ ...reglages(), test_user: "jean", secret: "saisi-different" });
        expect(r.complete).toBe(true);
        expect((await appeler("POST", "/api/admin/auth/providers/annuaire/enable", {})).statusCode).toBe(409);
      });
    });

    describe("étapes de l'annuaire", () => {
      beforeEach(() => avecSecretRange(fournisseur()));

      it("compte de service refusé : phrase sans le message du serveur, suite abandonnée", async () => {
        annuaire.secretService = "autre";
        const r = await tester({ ...reglages(), test_user: "jean" });
        expect(etape(r, "service_bind")).toMatchObject({ level: "fail" });
        expect(ids(r).at(-1)).toBe("service_bind");
        expect(r.complete).toBe(false);
      });

      it("base des utilisateurs absente : échec, les groupes sont quand même vérifiés", async () => {
        annuaire.objets.delete(BASE);
        const r = await tester({ ...reglages(), test_user: "jean" });
        expect(etape(r, "user_base")?.level).toBe("fail");
        expect(etape(r, "groups")?.level).toBe("ok");
        expect(r.complete).toBe(false);
      });

      it("groupe requis absent, ou aucun groupe requis : échec", async () => {
        annuaire.objets.delete(GROUPE_2);
        const absent = await tester({
          ...reglages({ required_groups: [GROUPE, GROUPE_2] }),
          test_user: "jean",
        });
        expect(etape(absent, "groups")).toMatchObject({ level: "fail" });
        expect(etape(absent, "groups")?.detail).toContain(GROUPE_2);
        const aucun = await tester({ ...reglages({ required_groups: [] }), test_user: "jean" });
        expect(etape(aucun, "groups")).toMatchObject({ level: "fail" });
        expect(aucun.complete).toBe(false);
        expect(await etat()).toEqual([]);
      });

      it("Active Directory : un groupe principal est refusé", async () => {
        annuaire.attrsObjet[GROUPE] = { primarygrouptoken: ["513"] };
        annuaire.ajouter("ana", { primarygroupid: ["513"], objectguid: [Buffer.alloc(16, 7)] });
        const ad = {
          preset: "active-directory",
          groups: { mode: "chain" },
          attrs: { id: "objectGUID", username: "uid", email: "mail", name: "cn" },
        };
        const r = await tester({ ...reglages(ad), test_user: "ana" });
        expect(etape(r, "groups")).toMatchObject({ level: "fail" });
        expect(etape(r, "groups")?.detail).toContain("groupe principal");
        expect(r.complete).toBe(false);
      });

      it("utilisateur d'essai introuvable, ambigu ou invalide : échec", async () => {
        annuaire.ajouter("jean");
        for (const [uid, motif] of [
          ["inconnu", /Aucun utilisateur/u],
          ["jean", /Plusieurs/u],
        ] as const) {
          const r = await tester({ ...reglages(), test_user: uid });
          expect(etape(r, "test_user")).toMatchObject({
            level: "fail",
            detail: expect.stringMatching(motif),
          });
          expect(r.complete).toBe(false);
        }
        const invalide = await tester({ ...reglages(), test_user: "a\nb" });
        expect(etape(invalide, "test_user")).toMatchObject({ level: "fail" });
        const pasTexte = await tester({ ...reglages(), test_user: 12 });
        expect(etape(pasTexte, "test_user")).toMatchObject({ level: "fail" });
        expect(annuaire.liaisonsUtilisateur).toEqual([]);
      });

      it("clé stable absente : échec qui nomme l'attribut", async () => {
        annuaire.ajouter("sans-cle", { entryuuid: [] });
        const r = await tester({ ...reglages(), test_user: "sans-cle" });
        expect(etape(r, "test_user")).toMatchObject({ level: "fail" });
        expect(etape(r, "test_user")?.detail).toContain("entryUUID");
        expect(ids(r)).not.toContain("test_user_profile");
        expect(r.complete).toBe(false);
      });

      it("identifiant à caractère combinant : avertissement qui dit qu'Elpis ne l'accepte pas à la connexion, le test reste complet", async () => {
        annuaire.ajouter("ax\u0301b");
        const r = await tester({ ...reglages(), test_user: "ax\u0301b" });
        expect(etape(r, "test_user")).toMatchObject({ level: "warn" });
        expect(etape(r, "test_user")?.detail).toContain(
          "Cet identifiant contient des caractères qu'Elpis n'accepte pas à la connexion.",
        );
        expect(r.complete).toBe(true);
      });

      it("FreeIPA sans expiration ni dernier changement lisibles : échec qui nomme les deux attributs", async () => {
        annuaire.ajouter("sans-etat", { nsaccountlock: ["false"] });
        const r = await tester({
          ...reglages({
            preset: "freeipa",
            attrs: { id: "entryUUID", username: "uid", email: "mail", name: "cn" },
          }),
          test_user: "sans-etat",
        });
        expect(etape(r, "test_user")).toMatchObject({ level: "fail" });
        expect(etape(r, "test_user")?.detail).toContain("krbPasswordExpiration");
        expect(etape(r, "test_user")?.detail).toContain("krbLastPwdChange");
        expect(r.complete).toBe(false);
      });

      it("FreeIPA sans expiration mais avec dernier changement : politique sans expiration, test complet", async () => {
        annuaire.ajouter("sans-fin", { nsaccountlock: ["false"], krblastpwdchange: ["20250101000000Z"] });
        const r = await tester({
          ...reglages({
            preset: "freeipa",
            attrs: { id: "entryUUID", username: "uid", email: "mail", name: "cn" },
          }),
          test_user: "sans-fin",
        });
        expect(etape(r, "test_user")).toMatchObject({ level: "ok" });
        expect(r.complete).toBe(true);
      });

      it("attribut d'état illisible : échec qui nomme l'attribut que le compte de service ne lit pas", async () => {
        annuaire.ajouter("sans-etat", { nsaccountlock: ["false"], krbpasswordexpiration: ["demain"] });
        const r = await tester({
          ...reglages({
            preset: "freeipa",
            attrs: { id: "entryUUID", username: "uid", email: "mail", name: "cn" },
          }),
          test_user: "sans-etat",
        });
        expect(etape(r, "test_user")).toMatchObject({ level: "fail" });
        expect(etape(r, "test_user")?.detail).toContain("krbPasswordExpiration");
        expect(r.complete).toBe(false);
      });

      it("utilisateur d'essai hors des groupes requis : avertissement, le test reste complet", async () => {
        annuaire.ajouter("seul", {}, []);
        const r = await tester({ ...reglages(), test_user: "seul" });
        expect(etape(r, "test_user_groups")).toMatchObject({ level: "warn" });
        expect(etape(r, "test_user_groups")?.detail).toContain(GROUPE);
        expect(r.complete).toBe(true);
      });

      it("nom Elpis non dérivable : échec", async () => {
        annuaire.ajouter("admin");
        const r = await tester({ ...reglages(), test_user: "admin" });
        expect(etape(r, "test_user_profile")).toMatchObject({ level: "fail" });
        expect(r.complete).toBe(false);
      });

      it("horloge : absente sans étape, mesurée sinon, avertissement au-delà de 60 s", async () => {
        expect(ids(await tester({ ...reglages(), test_user: "jean" }))).not.toContain("clock");
        const temps = (decalageSec: number): string =>
          new Date(Date.now() + decalageSec * 1000).toISOString().replace(/[-:T]/gu, "").slice(0, 14) + ".0Z";
        annuaire.rootDse = { currenttime: [temps(0)] };
        expect(etape(await tester({ ...reglages(), test_user: "jean" }), "clock")).toMatchObject({
          level: "ok",
        });
        annuaire.rootDse = { currenttime: [temps(300)] };
        const decale = await tester({ ...reglages(), test_user: "jean" });
        expect(etape(decale, "clock")).toMatchObject({ level: "warn" });
        expect(decale.complete).toBe(true);
        annuaire.rootDse = null;
        expect(ids(await tester({ ...reglages(), test_user: "jean" }))).not.toContain("clock");
      });

      it("rien de ce que renvoie l'annuaire ne sort tel quel : attributs non prévus, messages du serveur", async () => {
        annuaire.objets.delete(GROUPE_2);
        const r = await appeler("POST", URL_ESSAI, {
          ...reglages({ required_groups: [GROUPE, GROUPE_2] }),
          test_user: "jean",
        });
        const complet = await appeler("POST", URL_ESSAI, { ...reglages(), test_user: "jean" });
        for (const x of [r, complet]) {
          expect(x.body).not.toContain(MARQUEUR_SERVEUR);
          for (const s of x.json<Reponse>().steps) {
            expect(Object.keys(s).sort()).toEqual(["detail", "id", "label", "level", "target"]);
            expect(s.detail.length).toBeLessThanOrEqual(300);
          }
        }
        expect(lignesJournal.join("\n")).not.toContain(MARQUEUR_SERVEUR);
      });

      it("aucun mot de passe d'utilisateur : champ refusé, jamais de liaison d'utilisateur", async () => {
        const r = await tester({ ...reglages(), test_user: "jean", test_user_password: "x" });
        expect(etape(r, "settings")).toMatchObject({ level: "fail" });
        expect(annuaire.ouvertures).toBe(0);
        await tester({ ...reglages(), test_user: "jean" });
        expect(annuaire.liaisonsUtilisateur).toEqual([]);
      });
    });

    it("un modérateur reçoit 403, sans session 401", async () => {
      expect((await appeler("POST", URL_ESSAI, reglages(), modo)).statusCode).toBe(403);
      expect((await appeler("POST", URL_ESSAI, reglages(), null)).statusCode).toBe(401);
    });
  }),
);
