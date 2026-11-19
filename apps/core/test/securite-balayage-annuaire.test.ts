// SPDX-License-Identifier: MIT
/** apps/core/test/securite-balayage-annuaire.test.ts — le balayage de l'annuaire suspend un départ avéré et jamais une panne ni une réponse illisible : canari, erreur, garde-fou de masse, comptes locaux et suspensions de l'administrateur intacts, réactivation par l'annuaire seulement, une passe à la fois (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createExternalUser, createUser, dependancesParDefaut, ligneUtilisateur } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { creerFamilleAdminIdentite } from "../src/familles/admin-identite";
import { creerFamilleAdminIdentiteBalayage } from "../src/familles/admin-identite-balayage";
import { ancreIdentite } from "../src/identite/ancre";
import { balayerAnnuaire, departsEnMasse, etatBalayage } from "../src/identite/annuaire/balayage";
import type { DependancesBalayage, IssueBalayage } from "../src/identite/annuaire/balayage";
import { ErreurAnnuaire } from "../src/identite/annuaire/erreur";
import { enregistrerSecret, supprimerSecretFournisseur } from "../src/identite/fournisseurs";
import type { FournisseurLdap } from "../src/identite/reglages";
import { appTest, journalMuet, lignesAuditRecentes } from "./aides";
import { AnnuaireFactice, GROUPE, UUID } from "./identite/annuaire/annuaire-factice";
import type { Personne } from "./identite/annuaire/annuaire-factice";
import { ouvrirBancAnnuaire } from "./identite/annuaire/banc-annuaire";
import type { BancAnnuaire } from "./identite/annuaire/banc-annuaire";
import { MOTEURS } from "./identite/banc";

const ACTEUR = { userId: null, username: null, ip: null };
const FREEIPA = {
  preset: "freeipa",
  attrs: { id: "ipaUniqueID", username: "uid", email: "mail", name: "cn" },
};
const AD = {
  preset: "active-directory",
  attrs: { id: "objectGUID", username: "uid", email: "mail", name: "cn" },
};

interface Compte {
  readonly uid: number;
  readonly p: Personne;
}

describe.each(MOTEURS)("balayage de l'annuaire (%s)", (moteur) => {
  let b: BancAnnuaire;
  let annuaire: AnnuaireFactice;
  let audit: string;
  let verrous: string;
  let publiees: number[];
  let app: FastifyInstance;
  let chef: number;

  const f = (): FournisseurLdap => b.fournisseurs[0] as FournisseurLdap;
  const dep = (): DependancesBalayage => ({
    base: b.t.base,
    fabrique: annuaire.fabrique,
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
  const passe = async (confirmer?: number): Promise<IssueBalayage> =>
    balayerAnnuaire(dep(), f(), confirmer === undefined ? {} : { confirmer });
  const bilan = async (confirmer?: number) => {
    const r = await passe(confirmer);
    if (r.type !== "bilan") throw new Error(`pas de bilan : ${r.type}`);
    return r.etat;
  };
  /** Compte externe rattaché à une personne de l'annuaire, vérifié il y a longtemps. */
  const rattacher = async (uid: string, n: number, extra: Partial<Personne> = {}): Promise<Compte> => {
    const p = annuaire.ajouter({ uid, cle: UUID(n), mdp: "x", groupes: [GROUPE], ...extra });
    const id = await createExternalUser(b.t.base, uid, { maintenant: b.horloge - 1000 });
    await b.t.base.run(
      "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at, checked_at) VALUES(?,?,?,?,?,?,?)",
      [id, f().id, p.cle, ancreIdentite(f()), "auto", b.horloge - 1000, 5],
    );
    return { uid: id, p };
  };
  const suspendu = async (c: Compte): Promise<string | null> => {
    const l = await b.t.base.get<{ suspended_at: number | null; suspended_by: string | null }>(
      "SELECT suspended_at, suspended_by FROM users WHERE id=?",
      [c.uid],
    );
    return l && Number(l.suspended_at ?? 0) !== 0 ? String(l.suspended_by) : null;
  };
  const vu = async (c: Compte): Promise<number> =>
    Number(
      (
        await b.t.base.get<{ checked_at: number }>("SELECT checked_at FROM user_identities WHERE user_id=?", [
          c.uid,
        ])
      )?.checked_at,
    );
  const empreinteBase = async (): Promise<unknown> => [
    await b.t.base.valeurs("SELECT id, suspended_at, suspended_by, session_min_ts FROM users ORDER BY id"),
    await b.t.base.valeurs("SELECT user_id, checked_at FROM user_identities ORDER BY id"),
  ];

  const ouvrir = async (extras: Record<string, unknown>[] = [{}]): Promise<void> => {
    annuaire = new AnnuaireFactice();
    b = await ouvrirBancAnnuaire(moteur, extras, annuaire);
    chef = Number((await b.t.base.get<{ id: number }>("SELECT id FROM users WHERE username='chef'"))?.id);
  };

  beforeEach(() => {
    audit = mkdtempSync(join(tmpdir(), "elpis-audit-balayage-"));
    verrous = mkdtempSync(join(tmpdir(), "elpis-verrous-balayage-"));
    configureAudit({ service: "main", auditDir: audit, hmacKeyPath: join(audit, "sans-cle") });
    publiees = [];
  });
  afterEach(async () => {
    await app?.close();
    oublierConfigurationAudit();
    rmSync(audit, { recursive: true, force: true });
    rmSync(verrous, { recursive: true, force: true });
    await b.fermer();
  });

  describe("départs avérés", () => {
    beforeEach(() => ouvrir());

    it("entrée disparue : compte suspendu par l'annuaire, sessions coupées, audit avec la raison", async () => {
      const jean = await rattacher("jean", 1);
      const luc = await rattacher("luc", 2);
      annuaire.personnes = annuaire.personnes.filter((p) => p !== jean.p);
      const e = await bilan();
      expect(e).toMatchObject({ seen: 2, suspended: 1, unknown: 0, aborted: null, pending: 0 });
      expect(await suspendu(jean)).toBe("directory:annuaire");
      expect(await suspendu(luc)).toBeNull();
      expect(Number((await ligneUtilisateur(b.t.base, jean.uid))?.session_min_ts)).toBe(b.horloge);
      expect(publiees).toEqual([jean.uid]);
      expect(lignesAuditRecentes({ actionPrefix: "auth.account.suspend" })[0]).toMatchObject({
        username: "jean",
        details: { provider_id: "annuaire", origin: "directory:annuaire", reason: "entry_missing" },
      });
      expect(await etatBalayage(b.t.base, "annuaire")).toEqual(e);
    });

    it("sortie du groupe requis : compte suspendu", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await bilan();
      expect(await suspendu(jean)).toBe("directory:annuaire");
      expect(lignesAuditRecentes({ actionPrefix: "auth.account.suspend" })[0]?.["details"]).toMatchObject({
        reason: "not_in_group",
      });
    });

    it("entrée présente dans le groupe : rien, la vérification est rafraîchie", async () => {
      const jean = await rattacher("jean", 1);
      expect(await vu(jean)).toBe(5);
      await bilan();
      expect(await suspendu(jean)).toBeNull();
      expect(await vu(jean)).toBe(b.horloge);
    });

    it("compte local (sans identité) : jamais touché, même avec le nom d'une entrée disparue", async () => {
      const locale = await createUser(b.t.base, "locale", "mdp-locale-1");
      await rattacher("jean", 1, { groupes: [] });
      await bilan();
      expect(await b.t.base.get("SELECT suspended_at FROM users WHERE id=?", [locale])).toMatchObject({
        suspended_at: 0,
      });
      expect(await b.t.base.get("SELECT suspended_at FROM users WHERE id=?", [chef])).toMatchObject({
        suspended_at: 0,
      });
    });

    it("rattachée à un autre annuaire ou à une autre ancre : laissée telle quelle, jamais suspendue", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await b.t.base.run("UPDATE user_identities SET issuer='ldap:ou=autre#entryuuid' WHERE user_id=?", [
        jean.uid,
      ]);
      const e = await bilan();
      expect(e).toMatchObject({ seen: 0, suspended: 0, unknown: 1 });
      expect(await suspendu(jean)).toBeNull();
    });
  });

  describe("états de l'entrée", () => {
    it("entrée désactivée (verrou administratif) : compte suspendu", async () => {
      await ouvrir([FREEIPA]);
      const jean = await rattacher("jean", 1, {
        attrs: { nsaccountlock: ["TRUE"], krbpasswordexpiration: ["20990101000000Z"] },
      });
      await bilan();
      expect(await suspendu(jean)).toBe("directory:annuaire");
      expect(lignesAuditRecentes({ actionPrefix: "auth.account.suspend" })[0]?.["details"]).toMatchObject({
        reason: "entry_disabled",
      });
    });

    it("mot de passe expiré : rien", async () => {
      await ouvrir([FREEIPA]);
      const jean = await rattacher("jean", 1, {
        attrs: { nsaccountlock: ["false"], krbpasswordexpiration: ["20000101000000Z"] },
      });
      await bilan();
      expect(await suspendu(jean)).toBeNull();
      expect(await vu(jean)).toBe(b.horloge);
    });

    it("verrou temporaire après des échecs : rien", async () => {
      await ouvrir([AD]);
      const guid = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
      const p = annuaire.ajouter({
        uid: "jean",
        cle: UUID(1),
        mdp: "x",
        groupes: [GROUPE],
        attrs: {
          objectguid: [guid],
          useraccountcontrol: ["512"],
          "msds-user-account-control-computed": ["16"],
        },
      });
      const id = await createExternalUser(b.t.base, "jean", { maintenant: b.horloge - 1000 });
      await b.t.base.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at, checked_at) VALUES(?,?,?,?,?,?,?)",
        [id, f().id, guid.toString("hex"), ancreIdentite(f()), "auto", b.horloge - 1000, 5],
      );
      const e = await bilan();
      expect(e).toMatchObject({ seen: 1, suspended: 0, unknown: 0 });
      expect(await suspendu({ uid: id, p })).toBeNull();
    });

    it("état illisible : rien, l'entrée est comptée comme inconnue", async () => {
      await ouvrir([FREEIPA]);
      const jean = await rattacher("jean", 1, {
        attrs: { nsaccountlock: ["peut-être"], krbpasswordexpiration: ["20990101000000Z"] },
      });
      const e = await bilan();
      expect(e).toMatchObject({ seen: 0, suspended: 0, unknown: 1 });
      expect(await suspendu(jean)).toBeNull();
    });
  });

  describe("pannes et réponses douteuses : jamais un départ", () => {
    beforeEach(() => ouvrir());

    it("canari : un groupe requis introuvable abandonne la passe, rien n'est modifié", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      annuaire.personnes = annuaire.personnes.filter((p) => p !== jean.p);
      annuaire.groupesExistants.clear();
      const avant = await empreinteBase();
      const e = await bilan();
      expect(e).toMatchObject({ aborted: "group_missing", suspended: 0, reactivated: 0, pending: 0 });
      expect(await empreinteBase()).toEqual(avant);
      expect(publiees).toEqual([]);
      expect(lignesAuditRecentes({ actionPrefix: "auth.sweep.alert" })[0]?.["details"]).toMatchObject({
        provider_id: "annuaire",
        reason: "group_missing",
      });
    });

    it("groupe illisible (erreur autre que « inexistant ») : passe abandonnée", async () => {
      await rattacher("jean", 1, { groupes: [] });
      const original = annuaire.fabrique;
      const e = await balayerAnnuaire(
        {
          ...dep(),
          fabrique: async (fo, url) => {
            const c = await original(fo, url);
            return {
              ...c,
              chercher: (base, o) =>
                o.filtre === "(objectClass=*)"
                  ? Promise.reject(new ErreurAnnuaire("protocole", { code: 50 }))
                  : c.chercher(base, o),
            };
          },
        },
        f(),
      );
      expect(e).toMatchObject({ type: "bilan", etat: { aborted: "group_unreadable", suspended: 0 } });
    });

    it("secret du compte de service absent : passe abandonnée, l'annuaire n'est jamais contacté", async () => {
      await rattacher("jean", 1, { groupes: [] });
      await supprimerSecretFournisseur(b.t.base, "annuaire", ACTEUR);
      const e = await bilan();
      expect(e).toMatchObject({ aborted: "secret_missing", suspended: 0 });
      expect(annuaire.traces).toHaveLength(0);
      expect(annuaire.recherches).toHaveLength(0);
    });

    it("liaison de service refusée : aucune recherche n'est envoyée, rien n'est modifié", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await enregistrerSecret(b.t.base, f(), "mauvais-secret", ACTEUR);
      const e = await bilan();
      expect(e).toMatchObject({ aborted: "bind_failed", suspended: 0 });
      expect(annuaire.recherches).toHaveLength(0);
      expect(await suspendu(jean)).toBeNull();
      expect(annuaire.traces.every((t) => t.ferme)).toBe(true);
    });

    it("annuaire injoignable : passe abandonnée, rien n'est modifié", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      annuaire.injoignable = true;
      const e = await bilan();
      expect(e).toMatchObject({ aborted: "directory_unreachable", suspended: 0 });
      expect(await suspendu(jean)).toBeNull();
    });

    it("recherche en erreur pour un compte : ce compte est intact, les autres sont traités", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      const luc = await rattacher("luc", 2, { groupes: [] });
      const zoe = await rattacher("zoe", 3);
      annuaire.clesEnErreur.add(jean.p.cle);
      const e = await bilan();
      expect(e).toMatchObject({ seen: 2, suspended: 1, unknown: 1, aborted: null });
      expect(await suspendu(jean)).toBeNull();
      expect(await suspendu(luc)).toBe("directory:annuaire");
      expect(await suspendu(zoe)).toBeNull();
    });

    it("deux entrées pour une même clé : réponse ambiguë, rien", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      annuaire.ajouter({ uid: "double", cle: jean.p.cle, mdp: "x", groupes: [] });
      const e = await bilan();
      expect(e).toMatchObject({ seen: 0, unknown: 1, suspended: 0 });
      expect(await suspendu(jean)).toBeNull();
    });

    it("annuaire à qui l'on ne peut plus lire les groupes : appartenance inconnue, rien", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      annuaire.groupesLisibles = false;
      const e = await bilan();
      expect(e).toMatchObject({ seen: 0, unknown: 1, suspended: 0 });
      expect(await suspendu(jean)).toBeNull();
    });

    it("passe trop longue : abandonnée, rien n'est modifié", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      const r = await balayerAnnuaire({ ...dep(), delaiMs: -1 }, f());
      expect(r).toMatchObject({ type: "bilan", etat: { aborted: "timeout", suspended: 0 } });
      expect(await suspendu(jean)).toBeNull();
    });
  });

  describe("garde-fou de masse", () => {
    const peuple = async (partis: number, total: number): Promise<Compte[]> => {
      const comptes: Compte[] = [];
      for (let i = 1; i <= total; i++)
        comptes.push(await rattacher(`u${i}`, i, i <= partis ? { groupes: [] } : {}));
      return comptes;
    };
    const suspendus = async (cs: Compte[]): Promise<number> => {
      let n = 0;
      for (const c of cs) if ((await suspendu(c)) !== null) n++;
      return n;
    };

    beforeEach(() => ouvrir());

    it("seuil : au moins 3 départs et plus de 20 % des identités", () => {
      expect(departsEnMasse(2, 3)).toBe(false);
      expect(departsEnMasse(3, 9)).toBe(true);
      expect(departsEnMasse(3, 15)).toBe(false);
      expect(departsEnMasse(20, 100)).toBe(false);
      expect(departsEnMasse(21, 100)).toBe(true);
    });

    it("3 comptes sur 9 : personne n'est suspendu, le décompte est rangé ; la confirmation suspend ces 3", async () => {
      const cs = await peuple(3, 9);
      const e = await bilan();
      expect(e).toMatchObject({ suspended: 0, pending: 3, aborted: null });
      expect(await suspendus(cs)).toBe(0);
      expect(await etatBalayage(b.t.base, "annuaire")).toMatchObject({ pending: 3 });
      expect(lignesAuditRecentes({ actionPrefix: "auth.sweep.alert" })[0]?.["details"]).toMatchObject({
        reason: "mass_departure",
        pending: 3,
      });
      expect(await bilan(3)).toMatchObject({ suspended: 3, pending: 0 });
      expect(await suspendus(cs)).toBe(3);
    });

    it("décompte changé entre la lecture et la confirmation : rien n'est suspendu", async () => {
      const cs = await peuple(3, 9);
      await bilan();
      const [, , , quatrieme] = cs;
      annuaire.personnes = annuaire.personnes.filter((p) => p !== quatrieme?.p);
      expect(await passe(3)).toEqual({ type: "decompte_change", trouve: 4 });
      expect(await suspendus(cs)).toBe(0);
    });

    it("2 comptes sur 9 : sous le seuil, suspendus sans confirmation", async () => {
      const cs = await peuple(2, 9);
      expect(await bilan()).toMatchObject({ suspended: 2, pending: 0 });
      expect(await suspendus(cs)).toBe(2);
    });

    it("les comptes déjà suspendus ne comptent pas dans le décompte", async () => {
      const cs = await peuple(3, 9);
      await b.t.base.run("UPDATE users SET suspended_at=?, suspended_by='admin' WHERE id=?", [
        b.horloge - 5,
        (cs[0] as Compte).uid,
      ]);
      expect(await bilan()).toMatchObject({ suspended: 2, pending: 0 });
      expect(await suspendu(cs[0] as Compte)).toBe("admin");
    });
  });

  describe("suspensions et réactivations", () => {
    beforeEach(() => ouvrir());

    it("compte suspendu par un administrateur : jamais réactivé, même présent et dans le groupe", async () => {
      const jean = await rattacher("jean", 1);
      await b.t.base.run("UPDATE users SET suspended_at=?, suspended_by='admin' WHERE id=?", [
        b.horloge - 5,
        jean.uid,
      ]);
      const e = await bilan();
      expect(e).toMatchObject({ reactivated: 0, suspended: 0 });
      expect(await suspendu(jean)).toBe("admin");
    });

    it("compte suspendu par l'annuaire puis revenu : réactivé, les anciennes sessions restent mortes", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await bilan();
      expect(await suspendu(jean)).toBe("directory:annuaire");
      const coupure = Number((await ligneUtilisateur(b.t.base, jean.uid))?.session_min_ts);
      b.horloge += 600;
      jean.p.groupes = [GROUPE];
      const e = await bilan();
      expect(e).toMatchObject({ reactivated: 1, suspended: 0 });
      expect(await suspendu(jean)).toBeNull();
      expect(Number((await ligneUtilisateur(b.t.base, jean.uid))?.session_min_ts)).toBe(b.horloge);
      expect(Number((await ligneUtilisateur(b.t.base, jean.uid))?.session_min_ts)).toBeGreaterThan(coupure);
      expect(lignesAuditRecentes({ actionPrefix: "auth.account.reactivate" })[0]?.["details"]).toMatchObject({
        origin: "directory:annuaire",
      });
    });

    it("une suspension de l'administrateur posée pendant la passe n'est pas levée", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await bilan();
      jean.p.groupes = [GROUPE];
      await b.t.base.run("UPDATE users SET suspended_by='admin' WHERE id=?", [jean.uid]);
      expect(await bilan()).toMatchObject({ reactivated: 0 });
      expect(await suspendu(jean)).toBe("admin");
    });

    it("un compte déjà suspendu par l'annuaire et toujours parti n'est pas suspendu une seconde fois", async () => {
      await rattacher("jean", 1, { groupes: [] });
      await bilan();
      publiees.length = 0;
      expect(await bilan()).toMatchObject({ suspended: 0 });
      expect(publiees).toEqual([]);
    });
  });

  describe("une passe à la fois", () => {
    beforeEach(() => ouvrir());

    it("deux passes simultanées (deux process simulés) : une seule s'exécute, l'autre rend « occupé »", async () => {
      await rattacher("jean", 1, { groupes: [] });
      let ouvrirPause: () => void = () => undefined;
      annuaire.pause = new Promise<void>((ok) => (ouvrirPause = ok));
      const premiere = passe();
      await vi.waitFor(() => expect(annuaire.traces.length).toBeGreaterThan(0));
      expect(await passe()).toEqual({ type: "occupe" });
      ouvrirPause();
      expect((await premiere).type).toBe("bilan");
      expect(annuaire.traces.filter((t) => t.liaisons.length > 0)).toHaveLength(1);
      expect((await passe()).type).toBe("bilan");
    });
  });

  describe("routes de la console", () => {
    const appeler = (url: string, corps?: unknown) =>
      app.inject({
        method: "POST",
        url,
        headers: { "x-uid": String(chef) },
        ...(corps === undefined ? {} : { payload: corps as object }),
      });
    const garde = async (req: FastifyRequest): Promise<void> => {
      const uid = req.headers["x-uid"];
      if (!uid) throw new HttpError(401, "not logged in");
      const ligne = await ligneUtilisateur(b.t.base, Number(uid));
      req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
      if (!ligne || Number(ligne.is_admin) !== 1) throw new HttpError(403, "Admin required");
    };
    const monter = async (): Promise<void> => {
      app = await appTest({
        mode: "admin",
        familles: [
          creerFamilleAdminIdentiteBalayage(dep()),
          creerFamilleAdminIdentite({
            base: b.t.base,
            auth: {
              attributsCookie: () => ({
                cookie_name: "mcpwebui_session",
                same_site: "lax" as const,
                https_only: true,
                max_age: 86_400,
              }),
            },
            journal: journalMuet,
            revoquer: async () => undefined,
          }),
        ],
        gardes: { admin: garde, staff: garde, session: garde, service: async () => undefined },
      });
    };

    beforeEach(async () => {
      await ouvrir();
      await monter();
    });

    it("POST sweep : passe immédiate, état rendu, audit ; GET /api/admin/auth porte le même état", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      const r = await appeler("/api/admin/auth/providers/annuaire/sweep");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        at: b.horloge,
        seen: 1,
        suspended: 1,
        reactivated: 0,
        unknown: 0,
        aborted: null,
        pending: 0,
      });
      expect(await suspendu(jean)).toBe("directory:annuaire");
      expect(lignesAuditRecentes({ actionPrefix: "admin.auth.sweep" })[0]).toMatchObject({
        outcome: "success",
      });
      const g = await app.inject({
        method: "GET",
        url: "/api/admin/auth",
        headers: { "x-uid": String(chef) },
      });
      expect(g.json().providers[0].sweep).toEqual(r.json());
    });

    it("GET avant toute passe : sweep nul", async () => {
      const g = await app.inject({
        method: "GET",
        url: "/api/admin/auth",
        headers: { "x-uid": String(chef) },
      });
      expect(g.json().providers[0].sweep).toBeNull();
    });

    it("annuaire inconnu ou inactif : 404 ; non administrateur : refusé", async () => {
      expect((await appeler("/api/admin/auth/providers/autre/sweep")).statusCode).toBe(404);
      const alice = await createUser(b.t.base, "alice", "mdp-alice-1");
      const r = await app.inject({
        method: "POST",
        url: "/api/admin/auth/providers/annuaire/sweep",
        headers: { "x-uid": String(alice) },
      });
      expect(r.statusCode).toBe(403);
    });

    it("passe déjà en cours : 409", async () => {
      await rattacher("jean", 1);
      let ouvrirPause: () => void = () => undefined;
      annuaire.pause = new Promise<void>((ok) => (ouvrirPause = ok));
      const premiere = appeler("/api/admin/auth/providers/annuaire/sweep");
      await vi.waitFor(() => expect(annuaire.traces.length).toBeGreaterThan(0));
      expect((await appeler("/api/admin/auth/providers/annuaire/sweep")).statusCode).toBe(409);
      ouvrirPause();
      expect((await premiere).statusCode).toBe(200);
    });

    it("confirm : 3 départs sur 9 retenus puis confirmés avec le décompte vu ; audit", async () => {
      const cs: Compte[] = [];
      for (let i = 1; i <= 9; i++) cs.push(await rattacher(`u${i}`, i, i <= 3 ? { groupes: [] } : {}));
      expect((await appeler("/api/admin/auth/providers/annuaire/sweep")).json()).toMatchObject({
        suspended: 0,
        pending: 3,
      });
      const r = await appeler("/api/admin/auth/providers/annuaire/sweep/confirm", { pending: 3 });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ suspended: 3, pending: 0 });
      for (const c of cs.slice(0, 3)) expect(await suspendu(c)).toBe("directory:annuaire");
      expect(lignesAuditRecentes({ actionPrefix: "admin.auth.sweep.confirm" })[0]?.["details"]).toMatchObject(
        {
          provider_id: "annuaire",
          confirmed: 3,
        },
      );
    });

    it("confirm : décompte différent de celui rangé, ou changé depuis : 409 et rien de suspendu", async () => {
      const cs: Compte[] = [];
      for (let i = 1; i <= 9; i++) cs.push(await rattacher(`u${i}`, i, i <= 3 ? { groupes: [] } : {}));
      await appeler("/api/admin/auth/providers/annuaire/sweep");
      expect(
        (await appeler("/api/admin/auth/providers/annuaire/sweep/confirm", { pending: 4 })).statusCode,
      ).toBe(409);
      annuaire.personnes = annuaire.personnes.filter((p) => p !== cs[3]?.p);
      expect(
        (await appeler("/api/admin/auth/providers/annuaire/sweep/confirm", { pending: 3 })).statusCode,
      ).toBe(409);
      for (const c of cs) expect(await suspendu(c)).toBeNull();
    });

    it("confirm sans rien en attente ou corps invalide : 409 / 400", async () => {
      await rattacher("jean", 1);
      await appeler("/api/admin/auth/providers/annuaire/sweep");
      expect(
        (await appeler("/api/admin/auth/providers/annuaire/sweep/confirm", { pending: 1 })).statusCode,
      ).toBe(409);
      expect(
        (await appeler("/api/admin/auth/providers/annuaire/sweep/confirm", { pending: "3" })).statusCode,
      ).toBe(400);
      expect(
        (await appeler("/api/admin/auth/providers/annuaire/sweep/confirm", { pending: 0 })).statusCode,
      ).toBe(400);
      expect((await appeler("/api/admin/auth/providers/annuaire/sweep/confirm", {})).statusCode).toBe(400);
    });

    it("confirm : passe abandonnée entre-temps (canari) : 409, rien de suspendu", async () => {
      const cs: Compte[] = [];
      for (let i = 1; i <= 9; i++) cs.push(await rattacher(`u${i}`, i, i <= 3 ? { groupes: [] } : {}));
      await appeler("/api/admin/auth/providers/annuaire/sweep");
      annuaire.groupesExistants.clear();
      expect(
        (await appeler("/api/admin/auth/providers/annuaire/sweep/confirm", { pending: 3 })).statusCode,
      ).toBe(409);
      for (const c of cs) expect(await suspendu(c)).toBeNull();
    });
  });
});
