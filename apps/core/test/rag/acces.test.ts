// SPDX-License-Identifier: MIT
/** apps/core/test/rag/acces.test.ts — droits RAG sur SQLite et PostgreSQL : matrice des rôles, révocations immédiates, droit RAG, publication, suppressions, routes de la console. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createGroup, deleteGroup, dependancesParDefaut, ligneUtilisateur, setUserGroups } from "@elpis/auth";
import { HttpError } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { CODES_REFUS_RAG, GROUPES_PUBLICATION_RAG_MAX, ROLES_RAG, VISIBILITES_RAG } from "@elpis/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteUserFull } from "../../src/comptes/suppression";
import { creerFamilleAdminComptes } from "../../src/familles/admin-comptes";
import {
  accesCollection,
  appliquerPublication,
  GROUPES_PUBLICATION_MAX,
  MESSAGES_REFUS_RAG,
  VISIBILITES_ACCES_RAG,
  collectionsLisibles,
  droitRag,
  invaliderAccesRag,
  purgerGroupeRag,
  RefusRag,
  reglagesAccesRag,
  supprimerCollectionRag,
  verifierPublication,
} from "../../src/rag/acces";
import type { CodeRefusRag, RoleRag } from "../../src/rag/acces";
import { inscrireNettoyageRag } from "../../src/rag/nettoyage";
import type { CollectionPartieRag } from "../../src/rag/nettoyage";
import { appTest, journalMuet } from "../aides";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

let dossier: string;
let configJson: string;
let restaurer: () => void;
const avantEnv = process.env["ELPIS_RAG_ACCESS_DIR"];

beforeAll(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-rag-acces-"));
  configJson = join(dossier, "config.json");
  process.env["ELPIS_RAG_ACCESS_DIR"] = join(dossier, "temoin");
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: configJson, DB_PATH: join(dossier, "user_db", "app.db") });
});

afterAll(() => {
  restaurer();
  if (avantEnv === undefined) delete process.env["ELPIS_RAG_ACCESS_DIR"];
  else process.env["ELPIS_RAG_ACCESS_DIR"] = avantEnv;
  rmSync(dossier, { recursive: true, force: true });
});

function groupesRag(groupes: number[]): void {
  writeFileSync(configJson, JSON.stringify({ rag: { groups: groupes } }));
  invalidateConfigCache();
}

async function refus(f: () => Promise<unknown>): Promise<CodeRefusRag | "ok"> {
  try {
    await f();
    return "ok";
  } catch (e) {
    if (e instanceof RefusRag) return e.code;
    throw e;
  }
}

describe("constantes partagées avec @elpis/contracts", () => {
  it("visibilités, rôles, codes de refus et plafond de groupes identiques", () => {
    expect([...VISIBILITES_ACCES_RAG]).toEqual([...VISIBILITES_RAG]);
    const roles: RoleRag[] = ["proprietaire", "lecteur"];
    expect(roles).toEqual([...ROLES_RAG]);
    expect(Object.keys(MESSAGES_REFUS_RAG).sort()).toEqual([...CODES_REFUS_RAG].sort());
    expect(GROUPES_PUBLICATION_MAX).toBe(GROUPES_PUBLICATION_RAG_MAX);
  });
});

describe.each(MOTEURS)("droits RAG (%s)", (moteur) => {
  let t: BaseDeTest;
  let b: Base;
  const id: Record<string, number> = {};
  const g: Record<string, number> = {};
  const c: Record<string, string> = {};

  async function compte(nom: string, niveau = 0): Promise<number> {
    return b.insertId(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?, '', '', 1, ?)",
      [nom, niveau],
    );
  }

  async function collection(owner: number, nom: string, visibilite = "private", groupes: number[] = []) {
    const cid = randomUUID();
    await b.run(
      "INSERT INTO rag_collections(id, owner_user_id, name, visibility, created_at, updated_at) VALUES(?,?,?,?,1,1)",
      [cid, owner, nom, visibilite],
    );
    for (const gid of groupes)
      await b.run(
        "INSERT INTO rag_grants(collection_id, principal_type, principal_id, created_at) VALUES(?, 'group', ?, 1)",
        [cid, gid],
      );
    return cid;
  }

  async function roles(cid: string): Promise<Record<string, RoleRag | null>> {
    const out: Record<string, RoleRag | null> = {};
    for (const nom of ["alice", "bob", "carol", "dave", "eve", "mod"])
      out[nom] = await accesCollection(b, id[nom], cid);
    return out;
  }

  beforeEach(async () => {
    groupesRag([]);
    reglagesAccesRag.ttlS = 3.0;
    t = ouvrirBaseDeTest(moteur);
    b = t.base;
    await initialiserBase(b);
    id["alice"] = await compte("alice");
    id["bob"] = await compte("bob");
    id["carol"] = await compte("carol");
    id["dave"] = await compte("dave");
    id["eve"] = await compte("eve", 1);
    id["mod"] = await compte("mod", 2);
    id["root"] = await compte("root", 1);
    g["A"] = await createGroup(b, "A");
    g["B"] = await createGroup(b, "B");
    g["C"] = await createGroup(b, "C");
    await setUserGroups(b, id["alice"] as number, [g["A"] as number]);
    await setUserGroups(b, id["bob"] as number, [g["A"] as number]);
    await setUserGroups(b, id["carol"] as number, [g["B"] as number]);
    await setUserGroups(b, id["mod"] as number, [g["A"] as number]);
    c["privee"] = await collection(id["alice"] as number, "Privée");
    c["groupesA"] = await collection(id["alice"] as number, "Équipe A", "groups", [g["A"] as number]);
    c["groupesB"] = await collection(id["alice"] as number, "Équipe B", "groups", [g["B"] as number]);
    c["tous"] = await collection(id["eve"] as number, "Tous", "all");
    c["tousNonAdmin"] = await collection(id["alice"] as number, "Tous (non admin)", "all");
    c["groupesVides"] = await collection(id["alice"] as number, "Sans groupe", "groups");
    c["priveeGrants"] = await collection(id["alice"] as number, "Privée accordée", "private", [
      g["A"] as number,
    ]);
    c["admin"] = await collection(id["eve"] as number, "De l'admin");
    invaliderAccesRag(b);
  });

  afterEach(async () => {
    reglagesAccesRag.ttlS = 3.0;
    await t.fermer();
  });

  describe("matrice : propriétaire, même groupe, autre groupe, sans groupe, admin, modérateur", () => {
    const attendus: [string, Record<string, RoleRag | null>][] = [
      ["privee", { alice: "proprietaire", bob: null, carol: null, dave: null, eve: null, mod: null }],
      [
        "groupesA",
        { alice: "proprietaire", bob: "lecteur", carol: null, dave: null, eve: null, mod: "lecteur" },
      ],
      ["groupesB", { alice: "proprietaire", bob: null, carol: "lecteur", dave: null, eve: null, mod: null }],
      [
        "tous",
        {
          alice: "lecteur",
          bob: "lecteur",
          carol: "lecteur",
          dave: "lecteur",
          eve: "proprietaire",
          mod: "lecteur",
        },
      ],
      [
        "tousNonAdmin",
        {
          alice: "proprietaire",
          bob: "lecteur",
          carol: "lecteur",
          dave: "lecteur",
          eve: "lecteur",
          mod: "lecteur",
        },
      ],
      ["groupesVides", { alice: "proprietaire", bob: null, carol: null, dave: null, eve: null, mod: null }],
      ["priveeGrants", { alice: "proprietaire", bob: null, carol: null, dave: null, eve: null, mod: null }],
      ["admin", { alice: null, bob: null, carol: null, dave: null, eve: "proprietaire", mod: null }],
    ];
    it.each(attendus)("%s", async (nom, attendu) => {
      expect(await roles(c[nom] as string)).toEqual(attendu);
    });

    it("collections lisibles : les miennes puis celles publiées pour moi, jamais une privée d'autrui (admin compris)", async () => {
      const vues = async (nom: string): Promise<[string, RoleRag][]> =>
        (await collectionsLisibles(b, id[nom])).map((x) => [x.id, x.role]);
      const miennes = ["privee", "groupesA", "groupesB", "tousNonAdmin", "groupesVides", "priveeGrants"]
        .map((n) => c[n] as string)
        .sort();
      expect(await vues("alice")).toEqual([
        ...miennes.map((x) => [x, "proprietaire"]),
        [c["tous"], "lecteur"],
      ]);
      expect(await vues("bob")).toEqual(
        [c["groupesA"] as string, c["tous"] as string, c["tousNonAdmin"] as string]
          .sort()
          .map((x) => [x, "lecteur"]),
      );
      expect(await vues("dave")).toEqual(
        [c["tous"] as string, c["tousNonAdmin"] as string].sort().map((x) => [x, "lecteur"]),
      );
      expect(await vues("eve")).toEqual([
        ...[c["admin"] as string, c["tous"] as string].sort().map((x) => [x, "proprietaire"]),
        [c["tousNonAdmin"], "lecteur"],
      ]);
      const deBob = new Map((await collectionsLisibles(b, id["bob"])).map((x) => [x.id, x.owner_user_id]));
      expect([deBob.get(c["groupesA"] as string), deBob.get(c["tous"] as string)]).toEqual([
        id["alice"],
        id["eve"],
      ]);
    });

    it("entrées invalides : aucun accès, sans erreur", async () => {
      for (const uid of [0, -1, 1.5, Number.NaN, "1", null, undefined, 2 ** 60])
        expect(await accesCollection(b, uid, c["tous"]), String(uid)).toBeNull();
      for (const cid of [
        (c["tous"] as string).toUpperCase(),
        `${c["tous"]}/..`,
        `elpis_${(c["tous"] as string).replaceAll("-", "")}`,
        "' OR 1=1 --",
        "",
        42,
      ])
        expect(await accesCollection(b, id["alice"], cid), String(cid)).toBeNull();
      expect(await accesCollection(b, 9999, c["tous"])).toBeNull();
      expect(await collectionsLisibles(b, "x")).toEqual([]);
    });
  });

  describe("révocations", () => {
    it("retrait d'un groupe : révocation immédiate après invalidation", async () => {
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
      await setUserGroups(b, id["bob"] as number, []);
      invaliderAccesRag(b);
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBeNull();
      expect(await accesCollection(b, id["bob"], c["tous"])).toBe("lecteur");
    });

    it("témoin partagé : un changement fait par un autre processus est vu à la lecture suivante, cache local intact", async () => {
      reglagesAccesRag.ttlS = 3600;
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
      await b.run("DELETE FROM user_groups WHERE user_id=?", [id["bob"] as number]);
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
      invaliderAccesRag();
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBeNull();
    });

    it("sans invalidation, un accès retiré expire avec le cache (3 s, ici 50 ms)", async () => {
      reglagesAccesRag.ttlS = 0.05;
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
      await b.run("UPDATE rag_collections SET visibility='private' WHERE id=?", [c["groupesA"] as string]);
      await new Promise((r) => setTimeout(r, 80));
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBeNull();
    });

    it("une collection absente du cache est revérifiée en base (création ou publication d'un autre processus)", async () => {
      reglagesAccesRag.ttlS = 3600;
      expect(await accesCollection(b, id["dave"], c["tous"])).toBe("lecteur");
      const neuve = await collection(id["dave"] as number, "Neuve");
      expect(await accesCollection(b, id["dave"], neuve)).toBe("proprietaire");
      await b.run("UPDATE rag_collections SET visibility='all' WHERE id=?", [c["admin"] as string]);
      expect(await accesCollection(b, id["dave"], c["admin"])).toBe("lecteur");
    });

    it("dépublication : plus aucun lecteur, propriétaire gardé", async () => {
      await appliquerPublication(b, id["alice"], c["groupesA"], {
        visibility: "private",
        group_ids: [],
        allow_source_open: false,
      });
      expect(await roles(c["groupesA"] as string)).toEqual({
        alice: "proprietaire",
        bob: null,
        carol: null,
        dave: null,
        eve: null,
        mod: null,
      });
      expect(
        await b.valeurs("SELECT COUNT(*) FROM rag_grants WHERE collection_id=?", [c["groupesA"] as string]),
      ).toEqual([[0]]);
    });

    it("groupe supprimé : ses accès purgés, ses membres révoqués", async () => {
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
      await deleteGroup(b, g["A"] as number, (x) => purgerGroupeRag(x, g["A"] as number));
      invaliderAccesRag(b);
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBeNull();
      expect(
        await b.valeurs("SELECT COUNT(*) FROM rag_grants WHERE principal_id=?", [g["A"] as number]),
      ).toEqual([[0]]);
    });

    it("collection supprimée : plus aucun rôle, lignes dépendantes parties, description rendue pour le nettoyage", async () => {
      await b.run("INSERT INTO rag_hidden(user_id, collection_id, created_at) VALUES(?,?,1)", [
        id["bob"] as number,
        c["groupesA"] as string,
      ]);
      const partie = await supprimerCollectionRag(b, c["groupesA"]);
      expect(partie).toEqual({
        id: c["groupesA"],
        owner_user_id: id["alice"],
        name: "Équipe A",
        visibility: "groups",
        group_ids: [g["A"]],
      });
      expect(Object.values(await roles(c["groupesA"] as string))).toEqual([
        null,
        null,
        null,
        null,
        null,
        null,
      ]);
      expect(await b.valeurs("SELECT COUNT(*) FROM rag_hidden")).toEqual([[0]]);
      expect(await supprimerCollectionRag(b, c["groupesA"])).toBeNull();
      expect(await supprimerCollectionRag(b, "../x")).toBeNull();
    });

    it("compte supprimé : ses collections et partages partent, ses lecteurs perdent l'accès, rappel de nettoyage appelé", async () => {
      const vus: [number, CollectionPartieRag[]][] = [];
      const retirer = inscrireNettoyageRag((uid, parties) => {
        vus.push([uid, [...parties]]);
      });
      const retirerCasse = inscrireNettoyageRag(() => {
        throw new Error("Qdrant injoignable");
      });
      try {
        await b.run("INSERT INTO rag_hidden(user_id, collection_id, created_at) VALUES(?,?,1)", [
          id["alice"] as number,
          c["admin"] as string,
        ]);
        await b.run(
          "INSERT INTO rag_documents(id, collection_id, rel_path, name, ext, added_by, created_at) VALUES(?,?,?,?,?,?,1)",
          [randomUUID(), c["admin"] as string, "a.md", "a.md", "md", id["alice"] as number],
        );
        expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
        expect(await deleteUserFull(b, id["alice"] as number)).toBe(true);
        expect(await accesCollection(b, id["bob"], c["groupesA"])).toBeNull();
        expect(await accesCollection(b, id["bob"], c["tous"])).toBe("lecteur");
        expect(
          await b.valeurs("SELECT COUNT(*) FROM rag_collections WHERE owner_user_id=?", [
            id["alice"] as number,
          ]),
        ).toEqual([[0]]);
        expect(await b.valeurs("SELECT COUNT(*) FROM rag_grants")).toEqual([[0]]);
        expect(await b.valeurs("SELECT COUNT(*) FROM rag_hidden")).toEqual([[0]]);
        expect(await b.valeurs("SELECT added_by FROM rag_documents")).toEqual([[null]]);
        expect(vus).toHaveLength(1);
        expect(vus[0]?.[0]).toBe(id["alice"]);
        expect(vus[0]?.[1].map((p) => p.name).sort()).toEqual(
          ["Privée", "Équipe A", "Équipe B", "Tous (non admin)", "Sans groupe", "Privée accordée"].sort(),
        );
        expect(vus[0]?.[1].find((p) => p.id === c["groupesB"])?.group_ids).toEqual([g["B"]]);
        expect(await deleteUserFull(b, id["alice"] as number)).toBe(false);
        expect(vus).toHaveLength(1);
      } finally {
        retirer();
        retirerCasse();
      }
    });

    it("cascade seule (sans la purge applicative) : un DELETE du compte emporte ses lignes RAG", async () => {
      await b.run("DELETE FROM users WHERE id=?", [id["alice"] as number]);
      expect(await b.valeurs("SELECT id FROM rag_collections ORDER BY id")).toEqual(
        [c["admin"] as string, c["tous"] as string].sort().map((x) => [x]),
      );
      expect(await b.valeurs("SELECT COUNT(*) FROM rag_grants")).toEqual([[0]]);
    });
  });

  describe("droit RAG (`rag.groups`)", () => {
    it("vide : tout le monde ; restreint : membres et admins seulement, même pour leurs propres collections", async () => {
      expect(await droitRag(b, id["dave"])).toBe(true);
      groupesRag([g["A"] as number]);
      expect(await droitRag(b, id["dave"])).toBe(false);
      expect(await droitRag(b, id["carol"])).toBe(false);
      expect(await droitRag(b, id["bob"])).toBe(true);
      expect(await droitRag(b, id["eve"])).toBe(true);
      expect(await droitRag(b, id["mod"])).toBe(true);
      const deCarol = await collection(id["carol"] as number, "À Carol");
      expect(await accesCollection(b, id["carol"], deCarol)).toBeNull();
      expect(await accesCollection(b, id["carol"], c["tous"])).toBeNull();
      expect(await collectionsLisibles(b, id["carol"])).toEqual([]);
      expect(await accesCollection(b, id["alice"], c["privee"])).toBe("proprietaire");
      expect(await b.valeurs("SELECT COUNT(*) FROM rag_collections WHERE id=?", [deCarol])).toEqual([[1]]);
    });

    it("changement de `rag.groups` pris en compte sans invalidation ; un modérateur n'a pas le droit d'office", async () => {
      reglagesAccesRag.ttlS = 3600;
      expect(await accesCollection(b, id["dave"], c["tous"])).toBe("lecteur");
      expect(await accesCollection(b, id["mod"], c["tous"])).toBe("lecteur");
      groupesRag([g["C"] as number]);
      expect(await accesCollection(b, id["dave"], c["tous"])).toBeNull();
      expect(await accesCollection(b, id["mod"], c["tous"])).toBeNull();
      expect(await accesCollection(b, id["eve"], c["admin"])).toBe("proprietaire");
      expect(await accesCollection(b, id["eve"], c["privee"])).toBeNull();
      groupesRag([]);
      expect(await accesCollection(b, id["dave"], c["tous"])).toBe("lecteur");
    });

    it("auteur privé du droit : ses publiées restent lisibles, ses privées par personne, lui ne lit plus rien", async () => {
      await setUserGroups(b, id["dave"] as number, [g["B"] as number]);
      await setUserGroups(b, id["bob"] as number, [g["A"] as number, g["B"] as number]);
      const deDave = await collection(id["dave"] as number, "De Dave", "groups", [g["B"] as number]);
      const priveeDave = await collection(id["dave"] as number, "Privée de Dave", "private", []);
      invaliderAccesRag(b);
      expect(await accesCollection(b, id["bob"], deDave)).toBe("lecteur");
      groupesRag([g["A"] as number]);
      expect(await droitRag(b, id["dave"])).toBe(false);
      expect(await accesCollection(b, id["bob"], deDave)).toBe("lecteur");
      expect(await accesCollection(b, id["dave"], deDave)).toBeNull();
      for (const qui of ["bob", "root", "dave"])
        expect(await accesCollection(b, id[qui], priveeDave)).toBeNull();
      expect(await accesCollection(b, id["bob"], c["tous"])).toBe("lecteur");
    });
  });

  describe("publication", () => {
    const pub = (visibility: string, group_ids: number[] = [], allow_source_open = false) => ({
      visibility,
      group_ids,
      allow_source_open,
    });

    it("refus : codes clairs, rien d'écrit", async () => {
      const A = g["A"] as number;
      const B = g["B"] as number;
      const cas: [string, string, unknown, CodeRefusRag][] = [
        ["bob", "groupesA", pub("private"), "non_proprietaire"],
        ["carol", "groupesA", pub("private"), "collection_introuvable"],
        ["eve", "privee", pub("all"), "collection_introuvable"],
        ["alice", "tous", pub("private"), "non_proprietaire"],
        ["alice", "inconnue", pub("private"), "collection_introuvable"],
        ["alice", "privee", pub("all"), "tous_reserve_admin"],
        ["alice", "privee", pub("groups", [B]), "groupe_non_membre"],
        ["alice", "privee", pub("groups", [A, B]), "groupe_non_membre"],
        ["alice", "privee", pub("groups", [987654]), "groupe_non_membre"],
        ["alice", "privee", pub("groups"), "groupes_requis"],
        [
          "alice",
          "privee",
          pub(
            "groups",
            Array.from({ length: 51 }, (_, i) => i + 1),
          ),
          "trop_de_groupes",
        ],
        ["alice", "privee", pub("public"), "demande_invalide"],
        ["alice", "privee", { visibility: "private" }, "demande_invalide"],
        ["alice", "privee", pub("groups", [0]), "demande_invalide"],
        ["alice", "privee", pub("groups", ["1" as unknown as number]), "demande_invalide"],
        ["alice", "privee", null, "demande_invalide"],
        ["alice", "privee", [], "demande_invalide"],
        ["mod", "tous", pub("all"), "non_proprietaire"],
      ];
      const avant = await b.all("SELECT id, visibility, allow_source_open FROM rag_collections ORDER BY id");
      for (const [qui, quoi, demande, code] of cas) {
        const cid = quoi === "inconnue" ? randomUUID() : c[quoi];
        expect(await refus(() => appliquerPublication(b, id[qui], cid, demande)), `${qui} ${quoi}`).toBe(
          code,
        );
      }
      expect(
        await b.all("SELECT id, visibility, allow_source_open FROM rag_collections ORDER BY id"),
      ).toEqual(avant);
      const deMod = await collection(id["mod"] as number, "Du modérateur");
      expect(await refus(() => verifierPublication(b, id["mod"], deMod, pub("all")))).toBe(
        "tous_reserve_admin",
      );
      groupesRag([g["C"] as number]);
      expect(await refus(() => verifierPublication(b, id["alice"], c["privee"], pub("private")))).toBe(
        "rag_interdit",
      );
      expect(await refus(() => verifierPublication(b, 0, c["privee"], pub("private")))).toBe("rag_interdit");
    });

    it("statut HTTP et message de chaque refus", () => {
      const e = new RefusRag("groupe_inconnu", "7, 9");
      expect([e.statut, e.message]).toEqual([400, "Groupe introuvable. 7, 9"]);
      expect(new RefusRag("collection_introuvable").statut).toBe(404);
      expect(new RefusRag("tous_reserve_admin").statut).toBe(403);
    });

    it("utilisateur : ses groupes seulement, doublons retirés ; accès donnés tout de suite, sources ouvrables", async () => {
      await setUserGroups(b, id["alice"] as number, [g["A"] as number, g["B"] as number]);
      const p = await appliquerPublication(b, id["alice"], c["privee"], {
        visibility: "groups",
        group_ids: [g["B"] as number, g["A"] as number, g["B"] as number],
        allow_source_open: true,
      });
      expect(p).toEqual({
        visibility: "groups",
        group_ids: [g["A"], g["B"]].sort((x, y) => (x ?? 0) - (y ?? 0)),
        allow_source_open: true,
      });
      expect(await roles(c["privee"] as string)).toMatchObject({
        bob: "lecteur",
        carol: "lecteur",
        dave: null,
        eve: null,
      });
      expect(
        await b.valeurs("SELECT visibility, allow_source_open FROM rag_collections WHERE id=?", [
          c["privee"] as string,
        ]),
      ).toEqual([["groups", 1]]);
      const q = await appliquerPublication(
        b,
        id["alice"],
        c["privee"],
        pub("private", [g["A"] as number], false),
      );
      expect(q).toEqual({ visibility: "private", group_ids: [], allow_source_open: false });
      expect(await accesCollection(b, id["bob"], c["privee"])).toBeNull();
    });

    it("admin : tous les comptes et n'importe quel groupe existant", async () => {
      expect(await appliquerPublication(b, id["eve"], c["admin"], pub("all", [g["A"] as number]))).toEqual({
        visibility: "all",
        group_ids: [],
        allow_source_open: false,
      });
      expect(await accesCollection(b, id["dave"], c["admin"])).toBe("lecteur");
      await appliquerPublication(b, id["eve"], c["admin"], pub("groups", [g["C"] as number]));
      expect(await accesCollection(b, id["dave"], c["admin"])).toBeNull();
      expect(await accesCollection(b, id["bob"], c["admin"])).toBeNull();
      expect(
        await refus(() => verifierPublication(b, id["eve"], c["admin"], pub("groups", [987654, 987655]))),
      ).toBe("groupe_inconnu");
    });

    it("admin publie à un groupe dont il n'est pas membre : lisible même après sa rétrogradation, lignes jamais réécrites", async () => {
      await appliquerPublication(b, id["eve"], c["admin"], pub("groups", [g["C"] as number]));
      await setUserGroups(b, id["dave"] as number, [g["C"] as number]);
      invaliderAccesRag(b);
      expect(await accesCollection(b, id["dave"], c["admin"])).toBe("lecteur");
      await b.run("UPDATE users SET is_admin=0 WHERE id=?", [id["eve"] as number]);
      invaliderAccesRag(b);
      expect(await accesCollection(b, id["dave"], c["admin"])).toBe("lecteur");
      expect(await accesCollection(b, id["eve"], c["admin"])).toBe("proprietaire");
      expect(
        await b.valeurs("SELECT principal_id FROM rag_grants WHERE collection_id=?", [c["admin"] as string]),
      ).toEqual([[g["C"]]]);
      await b.run("UPDATE users SET is_admin=1 WHERE id=?", [id["eve"] as number]);
      invaliderAccesRag(b);
      expect(await accesCollection(b, id["dave"], c["admin"])).toBe("lecteur");
    });

    it("publication à un groupe : survit au départ de l'auteur, qui ne peut plus y republier", async () => {
      await setUserGroups(b, id["alice"] as number, [g["A"] as number, g["B"] as number]);
      invaliderAccesRag(b);
      expect(await accesCollection(b, id["carol"], c["groupesB"])).toBe("lecteur");
      await setUserGroups(b, id["alice"] as number, [g["A"] as number]);
      invaliderAccesRag(b);
      expect(await accesCollection(b, id["carol"], c["groupesB"])).toBe("lecteur");
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
      expect(
        await refus(() =>
          verifierPublication(b, id["alice"], c["groupesB"], pub("groups", [g["B"] as number])),
        ),
      ).toBe("groupe_non_membre");
    });
  });

  describe("routes de la console : groupes, rôle et suppression révoquent tout de suite", () => {
    let app: FastifyInstance;

    beforeEach(async () => {
      app = await appTest({
        mode: "admin",
        familles: [
          creerFamilleAdminComptes({
            base: b,
            auth: dependancesParDefaut(b),
            journal: journalMuet,
            revoquer: async () => null,
          }),
        ],
        gardes: {
          admin: async (req) => {
            const uid = Number(req.headers["x-uid"]);
            const ligne = await ligneUtilisateur(b, uid);
            if (!ligne || Number(ligne.is_admin) !== 1) throw new HttpError(403, "Admin required");
            req.utilisateur = { id: uid, username: String(ligne.username) };
          },
        },
      });
      reglagesAccesRag.ttlS = 3600;
    });

    afterEach(async () => app.close());

    async function appel(
      method: "PUT" | "POST" | "DELETE",
      url: string,
      corps?: unknown,
      qui = "root",
    ): Promise<number> {
      const r = await app.inject({
        method,
        url,
        headers: {
          "x-uid": String(id[qui]),
          ...(corps === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(corps === undefined ? {} : { payload: JSON.stringify(corps) }),
      });
      return r.statusCode;
    }

    it("appartenance du lecteur aux groupes changée", async () => {
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
      expect(await appel("PUT", `/api/admin/users/${id["bob"]}/groups`, { group_ids: [g["B"]] })).toBe(200);
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBeNull();
      expect(await accesCollection(b, id["bob"], c["tous"])).toBe("lecteur");
    });

    it("le propriétaire quitte le groupe : ses lecteurs gardent l'accès, rien d'autre ne s'ouvre", async () => {
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
      expect(await appel("PUT", `/api/admin/users/${id["alice"]}/groups`, { group_ids: [] })).toBe(200);
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
      expect(await accesCollection(b, id["mod"], c["groupesA"])).toBe("lecteur");
      expect(await accesCollection(b, id["carol"], c["groupesA"])).toBeNull();
      expect(await accesCollection(b, id["alice"], c["groupesA"])).toBe("proprietaire");
    });

    it("un admin publie à tous puis est rétrogradé : toujours lisible par les autres, rien de réécrit", async () => {
      await appliquerPublication(b, id["eve"], c["admin"], {
        visibility: "all",
        group_ids: [],
        allow_source_open: false,
      });
      expect(await accesCollection(b, id["dave"], c["admin"])).toBe("lecteur");
      expect(await appel("POST", `/api/admin/users/${id["eve"]}/role`, { role: "user" })).toBe(200);
      expect(await accesCollection(b, id["dave"], c["admin"])).toBe("lecteur");
      expect(await accesCollection(b, id["dave"], c["tous"])).toBe("lecteur");
      expect(await accesCollection(b, id["eve"], c["admin"])).toBe("proprietaire");
      expect(
        await b.valeurs("SELECT visibility FROM rag_collections WHERE id=?", [c["admin"] as string]),
      ).toEqual([["all"]]);
      expect(await appel("POST", `/api/admin/users/${id["eve"]}/role`, { role: "admin" })).toBe(200);
      expect(await accesCollection(b, id["dave"], c["admin"])).toBe("lecteur");
    });

    it("groupe supprimé : accès accordés purgés", async () => {
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
      expect(await appel("DELETE", `/api/admin/groups/${g["A"]}`)).toBe(200);
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBeNull();
      expect(
        await b.valeurs("SELECT COUNT(*) FROM rag_grants WHERE principal_id=?", [g["A"] as number]),
      ).toEqual([[0]]);
    });

    it("rôle changé : le droit RAG de l'admin suit", async () => {
      groupesRag([g["C"] as number]);
      expect(await droitRag(b, id["dave"])).toBe(false);
      expect(await appel("POST", `/api/admin/users/${id["dave"]}/role`, { role: "admin" })).toBe(200);
      expect(await droitRag(b, id["dave"])).toBe(true);
      expect(await accesCollection(b, id["dave"], c["privee"])).toBeNull();
    });

    it("compte supprimé", async () => {
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBe("lecteur");
      expect(await appel("DELETE", `/api/admin/users/${id["alice"]}`)).toBe(200);
      expect(await accesCollection(b, id["bob"], c["groupesA"])).toBeNull();
      expect(await b.valeurs("SELECT COUNT(*) FROM rag_collections")).toEqual([[2]]);
    });
  });
});
