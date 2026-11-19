// SPDX-License-Identifier: MIT
/** apps/core/test/securite-balayage-annuaire.test.ts — le balayage de l'annuaire suspend un départ avéré et jamais une panne ni une réponse illisible : canari, erreur, garde-fou de masse, comptes locaux et suspensions de l'administrateur intacts, réactivation par l'annuaire seulement, une passe à la fois (SQLite, PostgreSQL si ELPIS_TEST_PG). */
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  creerJeton,
  createExternalUser,
  createUser,
  dependancesParDefaut,
  ligneUtilisateur,
  resoudreJeton,
} from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { schemaCorpsConfirmationBalayage, schemaEtatBalayage } from "@elpis/contracts";
import { configureAudit, oublierConfigurationAudit } from "@elpis/securite";
import { VerrouFichier } from "@elpis/verrous";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { suspendre } from "../src/comptes/etat";
import { balayerLesAnnuaires } from "../src/ops/balayage-annuaire";
import { creerFamilleAdminIdentite } from "../src/familles/admin-identite";
import { creerFamilleAdminIdentiteBalayage } from "../src/familles/admin-identite-balayage";
import { ancreIdentite } from "../src/identite/ancre";
import {
  alerterSiPerime,
  balayerAnnuaire,
  cheminVerrouBalayage,
  departsEnMasse,
  DUREE_AVANT_REVOCATION_S,
  etatBalayage,
  viderObservations,
} from "../src/identite/annuaire/balayage";
import type { DependancesBalayage, IssueBalayage } from "../src/identite/annuaire/balayage";
import { ErreurAnnuaire } from "../src/identite/annuaire/erreur";
import { enregistrerSecret, supprimerSecretFournisseur } from "../src/identite/fournisseurs";
import type { FournisseurLdap } from "../src/identite/reglages";
import { appTest, journalMuet, lignesAuditRecentes } from "./aides";
import { AnnuaireFactice, GROUPE, UUID } from "./identite/annuaire/annuaire-factice";
import type { Personne } from "./identite/annuaire/annuaire-factice";
import { ouvrirBancAnnuaire, URL_PUBLIQUE } from "./identite/annuaire/banc-annuaire";
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
  /** Passe ; avec `confirmer`, l'empreinte envoyée est celle de l'état rangé (ce que la console a lu), sauf `empreinte` donnée. */
  const passe = async (confirmer?: number[], empreinte?: string): Promise<IssueBalayage> =>
    balayerAnnuaire(
      dep(),
      f(),
      confirmer === undefined
        ? {}
        : {
            confirmer: {
              user_ids: confirmer,
              held_hash: empreinte ?? (await etatBalayage(b.t.base, "annuaire"))?.held_hash ?? "",
            },
          },
    );
  const bilan = async (confirmer?: number[]) => {
    const r = await passe(confirmer);
    if (r.type !== "bilan") throw new Error(`pas de bilan : ${r.type}`);
    return r.etat;
  };
  /** Deux passes abouties successives (un départ n'est suspendu qu'à la seconde) ; rend la seconde. */
  const deuxPasses = async () => {
    await bilan();
    b.horloge += 600;
    return bilan();
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
      const premiere = await bilan();
      expect(premiere).toMatchObject({
        suspended: 0,
        observed: [{ user_id: jean.uid, reason: "entry_missing" }],
      });
      expect(await suspendu(jean)).toBeNull();
      b.horloge += 600;
      const e = await bilan();
      expect(e).toMatchObject({ seen: 2, suspended: 1, unknown: 0, aborted: null, pending: 0, observed: [] });
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
      await rattacher("luc", 2);
      await deuxPasses();
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
      await rattacher("luc", 2, {
        attrs: { nsaccountlock: ["false"], krbpasswordexpiration: ["20990101000000Z"] },
      });
      await deuxPasses();
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
      const e = await deuxPasses();
      expect(e).toMatchObject({ seen: 2, suspended: 1, unknown: 1, aborted: null });
      expect(await suspendu(jean)).toBeNull();
      expect(await suspendu(luc)).toBe("directory:annuaire");
      expect(await suspendu(zoe)).toBeNull();
    });

    it("deux entrées pour une même clé : réponse ambiguë, rien", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("zoe", 3);
      annuaire.ajouter({ uid: "double", cle: jean.p.cle, mdp: "x", groupes: [] });
      const e = await deuxPasses();
      expect(e).toMatchObject({ seen: 1, unknown: 1, suspended: 0 });
      expect(await suspendu(jean)).toBeNull();
    });

    it("annuaire à qui l'on ne peut plus lire les groupes : passe abandonnée, rien", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("zoe", 3);
      annuaire.groupesLisibles = false;
      const e = await bilan();
      expect(e).toMatchObject({ aborted: "membership_unreadable", suspended: 0 });
      expect(await suspendu(jean)).toBeNull();
    });

    it("passe trop longue : abandonnée, rien n'est modifié", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("zoe", 3);
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

    it("seuil : au moins 3 départs et plus de 20 % des identités non suspendues ; la totalité est toujours retenue", () => {
      expect(departsEnMasse(2, 3)).toBe(false);
      expect(departsEnMasse(3, 9)).toBe(true);
      expect(departsEnMasse(3, 15)).toBe(false);
      expect(departsEnMasse(20, 100)).toBe(false);
      expect(departsEnMasse(21, 100)).toBe(true);
      expect(departsEnMasse(1, 1)).toBe(true);
      expect(departsEnMasse(2, 2)).toBe(true);
      expect(departsEnMasse(0, 0)).toBe(false);
    });

    it("3 comptes sur 9 : personne n'est suspendu, la liste est rangée ; la confirmation de cette liste suspend ces 3 sans seconde observation", async () => {
      const cs = await peuple(3, 9);
      const e = await bilan();
      expect(e).toMatchObject({ suspended: 0, pending: 3, held_total: 3, aborted: null, observed: [] });
      expect(e.held).toEqual(
        cs.slice(0, 3).map((c, i) => ({ user_id: c.uid, username: `u${i + 1}`, reason: "not_in_group" })),
      );
      expect(await suspendus(cs)).toBe(0);
      expect(await etatBalayage(b.t.base, "annuaire")).toEqual(e);
      expect(lignesAuditRecentes({ actionPrefix: "auth.sweep.alert" })[0]?.["details"]).toMatchObject({
        reason: "mass_departure",
        pending: 3,
      });
      const confirmee = await bilan(cs.slice(0, 3).map((c) => c.uid));
      expect(confirmee).toMatchObject({ suspended: 3, pending: 0, held: [], held_total: 0 });
      expect(await suspendus(cs)).toBe(3);
    });

    it("ensemble des partis changé entre la lecture et la confirmation (un en plus ou un en moins) : rien n'est suspendu, le nouvel état est rendu", async () => {
      const cs = await peuple(3, 9);
      await bilan();
      const ids = cs.slice(0, 3).map((c) => c.uid);
      (cs[3] as Compte).p.groupes = [];
      const plus = await passe(ids);
      expect(plus).toMatchObject({
        type: "decompte_change",
        etat: { pending: 4, suspended: 0, held_total: 4 },
      });
      expect(await suspendus(cs)).toBe(0);
      (cs[3] as Compte).p.groupes = [GROUPE];
      (cs[2] as Compte).p.groupes = [GROUPE];
      expect(await passe(ids)).toMatchObject({ type: "decompte_change", etat: { pending: 2 } });
      expect(await suspendus(cs)).toBe(0);
    });

    it("la confirmation ne suspend jamais un compte que l'administrateur n'a pas vu : u4-u6 partis après la lecture, u1-u3 revenus", async () => {
      const cs = await peuple(3, 9);
      await bilan();
      const vus = cs.slice(0, 3).map((c) => c.uid);
      for (const c of cs.slice(0, 3)) c.p.groupes = [GROUPE];
      for (const c of cs.slice(3, 6)) c.p.groupes = [];
      expect(await passe(vus)).toMatchObject({ type: "decompte_change", etat: { pending: 3 } });
      expect(await suspendus(cs)).toBe(0);
    });

    it("2 comptes sur 9 : sous le seuil, suspendus à la seconde passe seulement", async () => {
      const cs = await peuple(2, 9);
      expect(await bilan()).toMatchObject({ suspended: 0, pending: 0, observed: [{}, {}] });
      expect(await suspendus(cs)).toBe(0);
      b.horloge += 600;
      expect(await bilan()).toMatchObject({ suspended: 2, pending: 0, observed: [] });
      expect(await suspendus(cs)).toBe(2);
    });

    it("les comptes déjà suspendus ne comptent ni parmi les départs ni dans le dénominateur", async () => {
      const cs = await peuple(3, 9);
      await b.t.base.run("UPDATE users SET suspended_at=?, suspended_by='admin' WHERE id=?", [
        b.horloge - 5,
        (cs[0] as Compte).uid,
      ]);
      expect(await deuxPasses()).toMatchObject({ suspended: 2, pending: 0 });
      expect(await suspendu(cs[0] as Compte)).toBe("admin");
    });

    it("dénominateur : 60 identités dont 50 suspendues, 10 actifs absents : retenus (100 % des non suspendues)", async () => {
      const cs: Compte[] = [];
      for (let i = 1; i <= 60; i++) cs.push(await rattacher(`u${i}`, i, i <= 10 ? { groupes: [] } : {}));
      await b.t.base.run(
        "UPDATE users SET suspended_at=?, suspended_by='admin' WHERE id IN (" +
          cs
            .slice(10)
            .map((c) => c.uid)
            .join(",") +
          ")",
        [b.horloge - 5],
      );
      // 10 actifs, 10 partis : la totalité des identités non suspendues de l'ancre
      expect(await bilan()).toMatchObject({ suspended: 0, pending: 10, held_total: 10 });
      expect(await suspendus(cs.slice(0, 10))).toBe(0);
    });

    it("identités d'une autre ancre : hors du dénominateur, jamais jugées", async () => {
      const cs = await peuple(3, 12);
      for (let i = 1; i <= 30; i++) await rattacher(`x${i}`, 100 + i);
      await b.t.base.run("UPDATE user_identities SET issuer='ldap:ou=autre#entryuuid' WHERE user_id>?", [
        (cs[11] as Compte).uid,
      ]);
      // 3 partis sur 12 de l'ancre (25 %) : retenus, bien que 3 sur 42 ne le seraient pas
      expect(await bilan()).toMatchObject({ pending: 3, suspended: 0 });
    });

    it("une passe où toutes les identités paraissent parties est retenue, quel que soit le nombre", async () => {
      const cs = [await rattacher("u1", 1, { groupes: [] }), await rattacher("u2", 2, { groupes: [] })];
      annuaire.ajouter({ uid: "autre", cle: UUID(77), mdp: "x", groupes: [GROUPE] });
      expect(await bilan()).toMatchObject({ pending: 2, suspended: 0 });
      b.horloge += 600;
      expect(await bilan()).toMatchObject({ pending: 2, suspended: 0, observed: [] });
      expect(await suspendus(cs)).toBe(0);
    });
  });

  describe("canaris : une perte de droits n'est jamais un départ", () => {
    beforeEach(() => ouvrir());

    it("aucune entrée visible sous la base des utilisateurs (droits perdus, réponse vide) : passe abandonnée, rien n'est modifié", async () => {
      const jean = await rattacher("jean", 1);
      await rattacher("luc", 2);
      annuaire.entreesLisibles = false;
      const avant = await empreinteBase();
      const e = await bilan();
      expect(e).toMatchObject({ aborted: "users_unreadable", suspended: 0, observed: [] });
      expect(await empreinteBase()).toEqual(avant);
      expect(await suspendu(jean)).toBeNull();
      expect(lignesAuditRecentes({ actionPrefix: "auth.sweep.alert" })[0]?.["details"]).toMatchObject({
        reason: "users_unreadable",
      });
    });

    it("aucun membre visible d'aucun groupe requis : passe abandonnée, même avec deux identités", async () => {
      await rattacher("jean", 1);
      await rattacher("luc", 2);
      annuaire.membresVisibles = false;
      expect(await bilan()).toMatchObject({ aborted: "membership_unreadable", suspended: 0 });
      expect(await empreinteBase()).toEqual(await empreinteBase());
    });

    it("mode memberOf : appartenance illisible = abandon ; lisible = jugée", async () => {
      await b.fermer();
      await ouvrir([{ groups: { mode: "memberof" } }]);
      const jean = await rattacher("jean", 1);
      await rattacher("luc", 2);
      annuaire.membresVisibles = false;
      expect(await bilan()).toMatchObject({ aborted: "membership_unreadable" });
      annuaire.membresVisibles = true;
      expect(await bilan()).toMatchObject({ aborted: null, seen: 2 });
      expect(await suspendu(jean)).toBeNull();
    });

    it("une seule identité parti, aucune présente : retenue, pas suspendue (n = 1)", async () => {
      const jean = await rattacher("jean", 1);
      annuaire.personnes = annuaire.personnes.filter((p) => p !== jean.p);
      annuaire.ajouter({ uid: "autre", cle: UUID(9), mdp: "x", groupes: [GROUPE] });
      expect(await bilan()).toMatchObject({ pending: 1, suspended: 0, held: [{ user_id: jean.uid }] });
      b.horloge += 600;
      await bilan();
      expect(await suspendu(jean)).toBeNull();
    });

    it("aucun présent alors que des départs : tout est retenu, quel que soit le nombre (5 sur 5)", async () => {
      const cs: Compte[] = [];
      for (let i = 1; i <= 5; i++) cs.push(await rattacher(`u${i}`, i, { groupes: [] }));
      annuaire.ajouter({ uid: "autre", cle: UUID(9), mdp: "x", groupes: [GROUPE] });
      const e = await deuxPasses();
      expect(e).toMatchObject({ suspended: 0, pending: 5 });
      for (const c of cs) expect(await suspendu(c)).toBeNull();
    });

    it("recherche par clé : la limite n'est pas transmise au serveur (réponse tronquée côté client)", async () => {
      await rattacher("jean", 1);
      await rattacher("luc", 2);
      const vus: boolean[] = [];
      const original = annuaire.fabrique;
      await balayerAnnuaire(
        {
          ...dep(),
          fabrique: async (fo, url) => {
            const c = await original(fo, url);
            return {
              ...c,
              chercher: (base, o) => {
                if (/^\(entryUUID=[^*]/u.test(o.filtre)) vus.push(o.sansLimiteServeur === true);
                return c.chercher(base, o);
              },
            };
          },
        },
        f(),
      );
      expect(vus).toEqual([true, true]);
    });
  });

  describe("un départ n'est suspendu qu'à la seconde observation", () => {
    beforeEach(() => ouvrir());

    it("première passe : notée, rien d'irréversible ; seconde passe : suspendu, sessions coupées, jetons et accès OAuth gardés mais inutilisables", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const depAcces = {
        ...dependancesParDefaut(b.t.base),
        maintenant: () => b.horloge,
        fraicheursFournisseurs: async () => new Map([["annuaire", 14]]),
      };
      await b.t.base.run("UPDATE user_identities SET checked_at=? WHERE user_id=?", [b.horloge, jean.uid]);
      const [jeton] = await creerJeton(depAcces, jean.uid, "tools", "t", ["fs"], 5);
      const utilisable = async (): Promise<boolean> =>
        (await resoudreJeton(depAcces, jeton as string, ["tools"], false)) !== null;
      expect(await utilisable()).toBe(true);
      expect(await bilan()).toMatchObject({ suspended: 0, observed: [{ user_id: jean.uid }] });
      expect(await suspendu(jean)).toBeNull();
      expect(await utilisable()).toBe(false);
      b.horloge += 600;
      expect(await bilan()).toMatchObject({ suspended: 1 });
      expect(await suspendu(jean)).toBe("directory:annuaire");
      expect(publiees).toEqual([jean.uid]);
      expect(Number((await ligneUtilisateur(b.t.base, jean.uid))?.session_min_ts)).toBe(b.horloge);
      const restants = await b.t.base.valeurs("SELECT id FROM tool_tokens WHERE user_id=?", [jean.uid]);
      expect(restants).toHaveLength(1);
      expect(await utilisable()).toBe(false);
    });

    it("un compte qui revient entre les deux passes n'est pas suspendu, et sa note est effacée", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      await bilan();
      jean.p.groupes = [GROUPE];
      b.horloge += 600;
      expect(await bilan()).toMatchObject({ suspended: 0, observed: [] });
      jean.p.groupes = [];
      b.horloge += 600;
      expect(await bilan()).toMatchObject({ suspended: 0, observed: [{ user_id: jean.uid }] });
      expect(await suspendu(jean)).toBeNull();
    });

    it("une passe abandonnée ne compte ni n'efface une observation", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      await bilan();
      annuaire.injoignable = true;
      b.horloge += 600;
      const ab = await bilan();
      expect(ab).toMatchObject({
        aborted: "directory_unreachable",
        suspended: 0,
        observed: [{ user_id: jean.uid }],
      });
      expect(await suspendu(jean)).toBeNull();
      annuaire.injoignable = false;
      b.horloge += 600;
      expect(await bilan()).toMatchObject({ suspended: 1 });
      expect(await suspendu(jean)).toBe("directory:annuaire");
    });

    it("une passe retenue ne compte pas comme observation", async () => {
      const cs: Compte[] = [];
      for (let i = 1; i <= 9; i++) cs.push(await rattacher(`u${i}`, i, i <= 3 ? { groupes: [] } : {}));
      await bilan();
      cs[2]?.p.groupes?.splice(0, 1, GROUPE);
      b.horloge += 600;
      expect(await bilan()).toMatchObject({ suspended: 0, observed: [{}, {}] });
      expect(await suspendu(cs[0] as Compte)).toBeNull();
    });

    it("les jetons et accès OAuth sont supprimés quand la suspension d'annuaire dure plus de 7 jours sans interruption", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const depAcces = { ...dependancesParDefaut(b.t.base), maintenant: () => b.horloge };
      await creerJeton(depAcces, jean.uid, "tools", "t", ["fs"], 5);
      await deuxPasses();
      const nombre = async (): Promise<number> =>
        Number(
          (
            await b.t.base.valeurs<[number]>("SELECT COUNT(*) FROM tool_tokens WHERE user_id=?", [jean.uid])
          )[0]?.[0],
        );
      expect(await nombre()).toBe(1);
      b.horloge += DUREE_AVANT_REVOCATION_S - 2000;
      await bilan();
      expect(await nombre()).toBe(1);
      b.horloge += 3000;
      await bilan();
      expect(await nombre()).toBe(0);
      expect(lignesAuditRecentes({ actionPrefix: "auth.account.access_revoke" })[0]).toMatchObject({
        details: { target_user_id: jean.uid, tokens_revoked: 1 },
      });
    });

    it("une suspension interrompue (le compte revient) ne mène à aucune suppression de jetons", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const depAcces = { ...dependancesParDefaut(b.t.base), maintenant: () => b.horloge };
      await creerJeton(depAcces, jean.uid, "tools", "t", ["fs"], 90);
      await deuxPasses();
      b.horloge += DUREE_AVANT_REVOCATION_S - 100;
      jean.p.groupes = [GROUPE];
      await bilan();
      expect(await suspendu(jean)).toBeNull();
      jean.p.groupes = [];
      b.horloge += 3000;
      await bilan();
      expect(await b.t.base.valeurs("SELECT id FROM tool_tokens WHERE user_id=?", [jean.uid])).toHaveLength(
        1,
      );
    });

    it("la suspension par un administrateur révoque tout de suite, comme avant", async () => {
      const jean = await rattacher("jean", 1);
      const depAcces = { ...dependancesParDefaut(b.t.base), maintenant: () => b.horloge };
      await creerJeton(depAcces, jean.uid, "tools", "t", ["fs"], 5);
      const bilanAdmin = await suspendre({ ...dep().etat, acces: depAcces }, jean.uid, "admin");
      expect(bilanAdmin).toMatchObject({ change: true, tokens: 1 });
      expect(await b.t.base.valeurs("SELECT id FROM tool_tokens WHERE user_id=?", [jean.uid])).toHaveLength(
        0,
      );
    });

    it("suspendre un compte déjà suspendu par le même acteur ne coupe plus rien", async () => {
      const jean = await rattacher("jean", 1);
      await suspendre(dep().etat, jean.uid, "admin");
      publiees.length = 0;
      expect(await suspendre(dep().etat, jean.uid, "admin")).toMatchObject({
        change: false,
        propage: false,
        tokens: 0,
        remplace: null,
      });
      expect(publiees).toEqual([]);
    });
  });

  describe("une observation a un âge, et ce qui est réversible se ferme tout de suite", () => {
    beforeEach(() => ouvrir());

    it.each([
      ["éteint", { enabled: false }],
      ["réglages modifiés", { user_base_dn: "cn=autres,dc=exemple,dc=lan" }],
    ])(
      "fournisseur %s pendant la passe : rien n'est suspendu, aucune observation réécrite, passe écartée",
      async (_nom, changement) => {
        const jean = await rattacher("jean", 1, { groupes: [] });
        await rattacher("luc", 2);
        const t0 = b.horloge;
        await bilan();
        b.horloge = t0 + 600;
        const avant = await etatBalayage(b.t.base, "annuaire");
        const original = annuaire.fabrique;
        let change = false;
        const r = await balayerAnnuaire(
          {
            ...dep(),
            fabrique: async (fo, url) => {
              if (!change) {
                change = true;
                b.cfg.ecrire({
                  auth: { public_url: URL_PUBLIQUE, providers: [{ ...f(), ...changement }] },
                });
              }
              return original(fo, url);
            },
          },
          f(),
        );
        expect(change).toBe(true);
        expect(r).toEqual({ type: "ecarte" });
        expect(await suspendu(jean)).toBeNull();
        expect(await etatBalayage(b.t.base, "annuaire")).toEqual(avant);
        expect(avant?.observed).toEqual([{ user_id: jean.uid, reason: expect.any(String), at: t0 }]);
      },
    );

    it("deux passes à moins de 2 minutes : rien n'est suspendu et la date de la première observation est gardée ; au-delà : suspendu", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const t0 = b.horloge;
      await bilan();
      b.horloge = t0 + 119;
      expect(await bilan()).toMatchObject({ suspended: 0, observed: [{ user_id: jean.uid, at: t0 }] });
      expect(await suspendu(jean)).toBeNull();
      b.horloge = t0 + 120;
      expect(await bilan()).toMatchObject({ suspended: 1, observed: [] });
      expect(await suspendu(jean)).toBe("directory:annuaire");
    });

    it("observation plus vieille que deux intervalles : une première observation de nouveau, rien de suspendu", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const t0 = b.horloge;
      await bilan();
      b.horloge = t0 + 1801;
      const e = await bilan();
      expect(e).toMatchObject({ suspended: 0, observed: [{ user_id: jean.uid, at: t0 + 1801 }] });
      expect(await suspendu(jean)).toBeNull();
      b.horloge = t0 + 1801 + 300;
      expect(await bilan()).toMatchObject({ suspended: 1 });
    });

    it("une passe abandonnée n'efface pas la date de l'observation", async () => {
      await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const t0 = b.horloge;
      await bilan();
      annuaire.injoignable = true;
      b.horloge += 300;
      expect(await bilan()).toMatchObject({ aborted: "directory_unreachable", observed: [{ at: t0 }] });
    });

    it("une confirmation refusée garde les observations en cours", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const t0 = b.horloge;
      await bilan();
      b.horloge += 30;
      const r = await passe([jean.uid], "0".repeat(32));
      expect(r).toMatchObject({
        type: "decompte_change",
        etat: { observed: [{ user_id: jean.uid, at: t0 }] },
      });
      expect(await suspendu(jean)).toBeNull();
    });

    it("viderObservations : la liste est oubliée, le reste de l'état est gardé", async () => {
      await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const e = await bilan();
      await b.t.base.ecriture((x) => viderObservations(x, "annuaire"));
      expect(await etatBalayage(b.t.base, "annuaire")).toEqual({ ...e, observed: [] });
    });

    it("première observation : les accès non interactifs sont refusés tout de suite, sans rien supprimer ; l'entrée revue les rend à la passe suivante", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const depAcces = {
        ...dependancesParDefaut(b.t.base),
        maintenant: () => b.horloge,
        fraicheursFournisseurs: async () => new Map([["annuaire", 14]]),
      };
      await b.t.base.run("UPDATE user_identities SET checked_at=? WHERE user_id=?", [b.horloge, jean.uid]);
      const [jeton] = await creerJeton(depAcces, jean.uid, "tools", "t", ["fs"], 5);
      const utilisable = async (): Promise<boolean> =>
        (await resoudreJeton(depAcces, jeton as string, ["tools"], false)) !== null;
      expect(await utilisable()).toBe(true);
      await bilan();
      expect(await vu(jean)).toBe(0);
      expect(await utilisable()).toBe(false);
      expect(await suspendu(jean)).toBeNull();
      expect(await b.t.base.valeurs("SELECT id FROM tool_tokens WHERE user_id=?", [jean.uid])).toHaveLength(
        1,
      );
      expect(Number((await ligneUtilisateur(b.t.base, jean.uid))?.session_min_ts ?? 0)).toBe(0);
      jean.p.groupes = [GROUPE];
      b.horloge += 600;
      await bilan();
      expect(await vu(jean)).toBe(b.horloge);
      expect(await utilisable()).toBe(true);
    });

    it("compte retenu par le garde-fou de masse : accès non interactifs refusés tout de suite, comptes présents intacts", async () => {
      const cs: Compte[] = [];
      for (let i = 1; i <= 9; i++) cs.push(await rattacher(`u${i}`, i, i <= 3 ? { groupes: [] } : {}));
      const e = await bilan();
      expect(e).toMatchObject({ pending: 3, suspended: 0 });
      for (const c of cs.slice(0, 3)) expect(await vu(c)).toBe(0);
      for (const c of cs.slice(3)) expect(await vu(c)).toBe(b.horloge);
    });

    it("panne ou droits perdus : rien n'est fermé", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      annuaire.injoignable = true;
      await bilan();
      expect(await vu(jean)).toBe(5);
    });

    it("révocation OAuth après 7 jours : l'état de suspension est relu juste avant, un compte réactivé entre-temps garde ses accès OAuth", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      await deuxPasses();
      b.horloge += DUREE_AVANT_REVOCATION_S + 10;
      const revoques: number[] = [];
      const base = Object.create(b.t.base) as typeof b.t.base;
      base.ecriture = async (fn) => {
        const r = await b.t.base.ecriture(fn);
        await b.t.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL WHERE id=?", [jean.uid]);
        return r;
      };
      const d = dep();
      await balayerAnnuaire(
        {
          ...d,
          base,
          etat: {
            ...d.etat,
            acces: { ...d.etat.acces, revoquerOauth: async (uid) => (revoques.push(uid), 1) },
          },
        },
        f(),
      );
      expect(revoques).toEqual([]);
    });

    it("suppression des jetons après 7 jours : l'état de suspension est relu dans l'écriture, un compte réactivé pendant la passe ne perd rien", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const depAcces = { ...dependancesParDefaut(b.t.base), maintenant: () => b.horloge };
      await creerJeton(depAcces, jean.uid, "tools", "t", ["fs"], 5);
      await deuxPasses();
      b.horloge += DUREE_AVANT_REVOCATION_S + 10;
      const original = annuaire.fabrique;
      let leve = false;
      await balayerAnnuaire(
        {
          ...dep(),
          fabrique: async (fo, url) => {
            const c = await original(fo, url);
            return {
              ...c,
              chercher: async (base, o) => {
                if (!leve) {
                  leve = true;
                  await b.t.base.run("UPDATE users SET suspended_at=0, suspended_by=NULL WHERE id=?", [
                    jean.uid,
                  ]);
                }
                return c.chercher(base, o);
              },
            };
          },
        },
        f(),
      );
      expect(leve).toBe(true);
      expect(await b.t.base.valeurs("SELECT id FROM tool_tokens WHERE user_id=?", [jean.uid])).toHaveLength(
        1,
      );
    });
  });

  describe("suspension d'un administrateur sur un compte suspendu par l'annuaire", () => {
    beforeEach(() => ouvrir());

    it("remplace l'origine par admin, révoque les jetons ; le balayage ne réactive plus ce compte", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const depAcces = { ...dependancesParDefaut(b.t.base), maintenant: () => b.horloge };
      await creerJeton(depAcces, jean.uid, "tools", "t", ["fs"], 5);
      await deuxPasses();
      expect(await suspendu(jean)).toBe("directory:annuaire");
      const r = await suspendre({ ...dep().etat, acces: depAcces }, jean.uid, "admin");
      expect(r).toMatchObject({ change: true, remplace: "directory:annuaire", tokens: 1 });
      expect(await suspendu(jean)).toBe("admin");
      jean.p.groupes = [GROUPE];
      b.horloge += 600;
      expect(await bilan()).toMatchObject({ reactivated: 0 });
      expect(await suspendu(jean)).toBe("admin");
    });

    it("la suspension d'annuaire ne remplace jamais celle d'un administrateur", async () => {
      const jean = await rattacher("jean", 1);
      await suspendre(dep().etat, jean.uid, "admin");
      const r = await suspendre(dep().etat, jean.uid, "directory:annuaire");
      expect(r.change).toBe(false);
      expect(await suspendu(jean)).toBe("admin");
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
      await rattacher("luc", 2);
      await deuxPasses();
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
      await rattacher("luc", 2);
      await deuxPasses();
      jean.p.groupes = [GROUPE];
      await b.t.base.run("UPDATE users SET suspended_by='admin' WHERE id=?", [jean.uid]);
      expect(await bilan()).toMatchObject({ reactivated: 0 });
      expect(await suspendu(jean)).toBe("admin");
    });

    it("un compte déjà suspendu par l'annuaire et toujours parti n'est pas suspendu une seconde fois", async () => {
      await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      await deuxPasses();
      publiees.length = 0;
      expect(await bilan()).toMatchObject({ suspended: 0 });
      expect(publiees).toEqual([]);
    });

    it("le dernier administrateur local n'est jamais visé, même parti de l'annuaire", async () => {
      const p = annuaire.ajouter({ uid: "chef", cle: UUID(50), mdp: "x", groupes: [] });
      await b.t.base.run(
        "INSERT INTO user_identities(user_id, provider_id, subject, issuer, linked_by, linked_at, checked_at) VALUES(?,?,?,?,?,?,?)",
        [chef, f().id, p.cle, ancreIdentite(f()), "auto", b.horloge - 1000, 5],
      );
      await rattacher("luc", 2);
      await rattacher("zoe", 3);
      await deuxPasses();
      expect(await suspendu({ uid: chef, p })).toBeNull();
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

  describe("verrou : dossier privé, prise bornée, alerte de péremption", () => {
    beforeEach(() => ouvrir());

    it("le verrou par défaut vit dans un dossier privé 0700 sous le dossier de données, jamais dans /tmp", () => {
      const donnees = mkdtempSync(join(tmpdir(), "elpis-donnees-"));
      try {
        const chemin = cheminVerrouBalayage("annuaire", donnees);
        expect(chemin).toBe(join(donnees, ".verrous", ".elpis_auth_sweep_annuaire.lock"));
        expect(statSync(join(donnees, ".verrous")).mode & 0o777).toBe(0o700);
        chmodSync(join(donnees, ".verrous"), 0o755);
        cheminVerrouBalayage("annuaire", donnees);
        expect(statSync(join(donnees, ".verrous")).mode & 0o777).toBe(0o700);
      } finally {
        rmSync(donnees, { recursive: true, force: true });
      }
    });

    it("dossier inutilisable (un fichier à sa place) : passe abandonnée avec une ligne au journal, aucun repli sur /tmp", async () => {
      const donnees = mkdtempSync(join(tmpdir(), "elpis-donnees-"));
      try {
        writeFileSync(join(donnees, ".verrous"), "x");
        const avertir = vi.fn();
        await rattacher("jean", 1, { groupes: [] });
        const r = await balayerAnnuaire(
          {
            ...dep(),
            journal: { ...journalMuet, warn: avertir } as never,
            cheminVerrou: (id) => cheminVerrouBalayage(id, donnees),
          },
          f(),
        );
        expect(r).toEqual({ type: "verrou_indisponible" });
        expect(avertir).toHaveBeenCalledTimes(1);
        expect(annuaire.traces).toHaveLength(0);
      } finally {
        rmSync(donnees, { recursive: true, force: true });
      }
    });

    it("prise du verrou qui ne rend jamais la main : bornée dans le temps, la passe est abandonnée", async () => {
      const fifo = join(verrous, "bloque.lock");
      execFileSync("mkfifo", [fifo]);
      const t0 = Date.now();
      const r = await balayerAnnuaire({ ...dep(), cheminVerrou: () => fifo, delaiVerrouMs: 300 }, f());
      expect(r).toEqual({ type: "verrou_indisponible" });
      expect(Date.now() - t0).toBeLessThan(3000);
      const fd = openSync(fifo, "w");
      closeSync(fd);
    });

    it("le planificateur journalise l'issue « occupé » sans bloquer les autres annuaires", async () => {
      await b.fermer();
      await ouvrir([{}, {}]);
      await rattacher("jean", 1);
      const verrou = new VerrouFichier(join(verrous, "annuaire.lock"), { battement: true });
      expect(await verrou.essayer()).toBe(true);
      const infos: string[] = [];
      await balayerLesAnnuaires({
        ...dep(),
        journal: { ...journalMuet, info: (m: string) => infos.push(m) } as never,
      });
      await verrou.rendre();
      expect(infos.some((m) => m.includes("annuaire") && m.includes("autre est en cours"))).toBe(true);
      expect(await etatBalayage(b.t.base, "annuaire2")).not.toBeNull();
    });

    it("alerte « stale » (journal et audit) quand la dernière passe aboutie date de plus de deux intervalles, une fois", async () => {
      await rattacher("jean", 1);
      await bilan();
      const avertir = vi.fn();
      const d = { ...dep(), journal: { ...journalMuet, warn: avertir } as never };
      await alerterSiPerime(d, f(), 900_000);
      expect(avertir).not.toHaveBeenCalled();
      b.horloge += 1801;
      await alerterSiPerime(d, f(), 900_000);
      await alerterSiPerime(d, f(), 900_000);
      expect(avertir).toHaveBeenCalledTimes(1);
      expect(lignesAuditRecentes({ actionPrefix: "auth.sweep.alert" })[0]?.["details"]).toMatchObject({
        provider_id: "annuaire",
        reason: "stale",
      });
    });

    it("des passes abandonnées ne rafraîchissent pas la date de la dernière passe aboutie", async () => {
      await rattacher("jean", 1);
      const premiere = await bilan();
      annuaire.injoignable = true;
      b.horloge += 5000;
      const ab = await bilan();
      expect(ab).toMatchObject({ aborted: "directory_unreachable", ok_at: premiere.ok_at });
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
    const peuple9 = async (): Promise<Compte[]> => {
      const cs: Compte[] = [];
      for (let i = 1; i <= 9; i++) cs.push(await rattacher(`u${i}`, i, i <= 3 ? { groupes: [] } : {}));
      return cs;
    };
    const CONFIRM = "/api/admin/auth/providers/annuaire/sweep/confirm";

    beforeEach(async () => {
      await ouvrir();
      await monter();
    });

    it("POST sweep : passe immédiate, état rendu, audit ; GET /api/admin/auth porte le même état", async () => {
      const jean = await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const r = await appeler("/api/admin/auth/providers/annuaire/sweep");
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({
        at: b.horloge,
        seen: 2,
        suspended: 0,
        reactivated: 0,
        unknown: 0,
        aborted: null,
        pending: 0,
        held: [],
        held_total: 0,
        held_hash: "",
        observed: [{ user_id: jean.uid, reason: "not_in_group", at: b.horloge }],
        ok_at: b.horloge,
      });
      b.horloge += 600;
      expect((await appeler("/api/admin/auth/providers/annuaire/sweep")).json()).toMatchObject({
        suspended: 1,
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
      expect(g.json().providers[0].sweep).toEqual(await etatBalayage(b.t.base, "annuaire"));
      expect(schemaEtatBalayage.safeParse(g.json().providers[0].sweep).success).toBe(true);
    });

    it("éteindre, modifier ou réactiver le fournisseur oublie les observations", async () => {
      await rattacher("jean", 1, { groupes: [] });
      await rattacher("luc", 2);
      const observees = async (): Promise<number> =>
        (await etatBalayage(b.t.base, "annuaire"))?.observed.length ?? 0;
      await appeler("/api/admin/auth/providers/annuaire/sweep");
      expect(await observees()).toBe(1);
      const modif = await app.inject({
        method: "PUT",
        url: "/api/admin/auth/providers/annuaire",
        headers: { "x-uid": String(chef) },
        payload: { label: "Autre libellé" },
      });
      expect(modif.statusCode).toBe(200);
      expect(await observees()).toBe(0);
      await appeler("/api/admin/auth/providers/annuaire/sweep");
      expect(await observees()).toBe(1);
      expect((await appeler("/api/admin/auth/providers/annuaire/disable")).statusCode).toBe(200);
      expect(await observees()).toBe(0);
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

    it("confirm : 3 départs sur 9 retenus puis confirmés avec la liste vue ; audit avec les identifiants", async () => {
      const cs = await peuple9();
      const vu = (await appeler("/api/admin/auth/providers/annuaire/sweep")).json();
      expect(vu).toMatchObject({ suspended: 0, pending: 3, held_total: 3 });
      expect(vu.held.map((h: { user_id: number }) => h.user_id)).toEqual(cs.slice(0, 3).map((c) => c.uid));
      const ids = vu.held.map((h: { user_id: number }) => h.user_id);
      expect(vu.held_hash).toMatch(/^[0-9a-f]{32}$/u);
      const r = await appeler(CONFIRM, { user_ids: ids, held_hash: vu.held_hash });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ suspended: 3, pending: 0, held: [], held_hash: "" });
      for (const c of cs.slice(0, 3)) expect(await suspendu(c)).toBe("directory:annuaire");
      expect(lignesAuditRecentes({ actionPrefix: "admin.auth.sweep.confirm" })[0]?.["details"]).toMatchObject(
        { provider_id: "annuaire", confirmed: 3, confirmed_user_ids: ids },
      );
    });

    it("confirm : compte jamais vu, ensemble changé ou empreinte fausse : 409 avec le nouvel état, rien de suspendu", async () => {
      const cs = await peuple9();
      const vu = (await appeler("/api/admin/auth/providers/annuaire/sweep")).json();
      const ids = cs.slice(0, 3).map((c) => c.uid);
      const jamaisVu = await appeler(CONFIRM, {
        user_ids: [...ids.slice(0, 2), (cs[5] as Compte).uid],
        held_hash: vu.held_hash,
      });
      expect(jamaisVu.statusCode).toBe(409);
      const fausse = await appeler(CONFIRM, { user_ids: ids, held_hash: "0".repeat(32) });
      expect(fausse.statusCode).toBe(409);
      cs[3]?.p.groupes.splice(0, 1);
      const change = await appeler(CONFIRM, { user_ids: ids, held_hash: vu.held_hash });
      expect(change.statusCode).toBe(409);
      expect(change.json().detail.sweep).toMatchObject({ pending: 4, suspended: 0 });
      expect(change.json().detail.sweep.held_hash).not.toBe(vu.held_hash);
      for (const c of cs) expect(await suspendu(c)).toBeNull();
    });

    it("confirm : une partie seulement de l'ensemble vu : seuls ces comptes sont suspendus, les autres restent retenus", async () => {
      const cs = await peuple9();
      const vu = (await appeler("/api/admin/auth/providers/annuaire/sweep")).json();
      const ids = cs.slice(0, 2).map((c) => c.uid);
      const r = await appeler(CONFIRM, { user_ids: ids, held_hash: vu.held_hash });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toMatchObject({ suspended: 2, pending: 1, held_total: 1 });
      expect(await suspendu(cs[0] as Compte)).toBe("directory:annuaire");
      expect(await suspendu(cs[2] as Compte)).toBeNull();
    });

    it("confirm : ensemble de plus de 200 comptes, même règle : empreinte de l'ensemble complet, comptes confirmés pris dans la liste rendue", async () => {
      const comptes: Compte[] = [];
      for (let i = 1; i <= 205; i++) comptes.push(await rattacher(`u${i}`, i, { groupes: [] }));
      annuaire.ajouter({ uid: "present", cle: UUID(999), mdp: "x", groupes: [GROUPE] });
      const vu = (await appeler("/api/admin/auth/providers/annuaire/sweep")).json();
      expect(vu.held).toHaveLength(200);
      const ids = vu.held.slice(0, 2).map((h: { user_id: number }) => h.user_id);
      const horsListe = comptes.at(-1)?.uid as number;
      expect((await appeler(CONFIRM, { user_ids: [horsListe], held_hash: vu.held_hash })).statusCode).toBe(
        409,
      );
      comptes[204]?.p.groupes.splice(0, 1, GROUPE);
      const change = await appeler(CONFIRM, { user_ids: ids, held_hash: vu.held_hash });
      expect(change.statusCode).toBe(409);
      expect(change.json().detail.sweep.held_hash).not.toBe(vu.held_hash);
      for (const c of comptes) expect(await suspendu(c)).toBeNull();
      const neuf = change.json().detail.sweep;
      const ok = await appeler(CONFIRM, { user_ids: ids, held_hash: neuf.held_hash });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ suspended: 2, pending: 202 });
    });

    it("confirm sans rien en attente ou corps invalide : 409 / 400", async () => {
      const jean = await rattacher("jean", 1);
      await appeler("/api/admin/auth/providers/annuaire/sweep");
      const h = "a".repeat(32);
      expect((await appeler(CONFIRM, { user_ids: [jean.uid], held_hash: h })).statusCode).toBe(409);
      expect((await appeler(CONFIRM, { user_ids: [jean.uid] })).statusCode).toBe(400);
      expect((await appeler(CONFIRM, { user_ids: [jean.uid], held_hash: "" })).statusCode).toBe(400);
      expect((await appeler(CONFIRM, { user_ids: [jean.uid], held_hash: 5 })).statusCode).toBe(400);
      expect((await appeler(CONFIRM, { pending: 1, held_hash: h })).statusCode).toBe(400);
      expect((await appeler(CONFIRM, { user_ids: [], held_hash: h })).statusCode).toBe(400);
      expect((await appeler(CONFIRM, { user_ids: [1, 1], held_hash: h })).statusCode).toBe(400);
      expect((await appeler(CONFIRM, { user_ids: ["3"], held_hash: h })).statusCode).toBe(400);
      expect((await appeler(CONFIRM, { user_ids: [0], held_hash: h })).statusCode).toBe(400);
      expect((await appeler(CONFIRM, { user_ids: [1], held_hash: h, pending: 1 })).statusCode).toBe(400);
      expect((await appeler(CONFIRM, {})).statusCode).toBe(400);
    });

    it("confirm : passe abandonnée entre-temps (canari) : 409, rien de suspendu", async () => {
      const cs = await peuple9();
      const vu = (await appeler("/api/admin/auth/providers/annuaire/sweep")).json();
      annuaire.groupesExistants.clear();
      const corps = { user_ids: cs.slice(0, 3).map((c) => c.uid), held_hash: vu.held_hash };
      expect((await appeler(CONFIRM, corps)).statusCode).toBe(409);
      for (const c of cs) expect(await suspendu(c)).toBeNull();
    });

    it("la liste rendue est plafonnée à 200 et porte le total", async () => {
      const ids: number[] = [];
      for (let i = 1; i <= 205; i++) ids.push((await rattacher(`u${i}`, i, { groupes: [] })).uid);
      annuaire.ajouter({ uid: "present", cle: UUID(999), mdp: "x", groupes: [GROUPE] });
      const e = (await appeler("/api/admin/auth/providers/annuaire/sweep")).json();
      expect(e).toMatchObject({ pending: 205, held_total: 205 });
      expect(e.held).toHaveLength(200);
    });

    it("le contrat de confirmation et celui de l'état acceptent les corps de la route", () => {
      expect(schemaCorpsConfirmationBalayage.safeParse({ user_ids: [1, 2], held_hash: "ab" }).success).toBe(
        true,
      );
      expect(schemaCorpsConfirmationBalayage.safeParse({ user_ids: [1, 2] }).success).toBe(false);
      expect(schemaCorpsConfirmationBalayage.safeParse({ pending: 3 }).success).toBe(false);
      expect(
        schemaEtatBalayage.safeParse({
          at: 1,
          seen: 0,
          suspended: 0,
          reactivated: 0,
          unknown: 0,
          aborted: null,
          pending: 0,
        }).success,
      ).toBe(true);
    });
  });
});
