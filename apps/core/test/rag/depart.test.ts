// SPDX-License-Identifier: MIT
/** apps/core/test/rag/depart.test.ts — départ d'un utilisateur (SQLite et PostgreSQL) : droit RAG retiré = collections privées illisibles par tous (routes, outils du chat, console) et gardées intactes ; compte supprimé = collections purgées (base, magasin, Qdrant) et lecteurs prévenus. */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { setUserGroups } from "@elpis/auth";
import { ClientQdrant } from "@elpis/rag";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { deleteUserFull } from "../../src/comptes/suppression";
import { CycleDeVie } from "../../src/cycle";
import { appliquerPublication, invaliderAccesRag } from "../../src/rag/acces";
import { creerOutilsChatRag } from "../../src/rag/outils-chat";
import { brancherIndexationRag, installerServiceIndexationRag } from "../../src/rag/service";
import { journalMuet } from "../aides";
import { ajouterConsole } from "./aides-admin";
import type { BancAdmin } from "./aides-admin";
import { creerCollection } from "./aides-indexation";
import {
  demarrerEnvironnement,
  fetchQdrantFaux,
  indexerDirect,
  json,
  MOTEURS,
  ouvrirBanc,
} from "./aides-routes";
import type { Environnement } from "./aides-routes";

let env: Environnement;

beforeAll(async () => {
  env = await demarrerEnvironnement();
});

afterAll(async () => {
  await env.arreter();
});

const MARQUEUR = "SECRET-ALICE-4242";

type Json = Record<string, unknown>;
type Quand = "hors_groupes_autorises" | "sorti_du_groupe_autorise";

describe.each(MOTEURS)("départ d'un utilisateur : RAG (%s)", (moteur) => {
  let b: BancAdmin;

  beforeEach(async () => {
    b = await ajouterConsole(await ouvrirBanc(moteur, env, { reranker: () => null }));
  });

  afterEach(async () => {
    installerServiceIndexationRag(null);
    await b.fermer();
  });

  /** Collection d'un compte avec un document indexé (marqueur secret) et sa source dans le magasin. */
  async function preparer(uid: number, nom: string): Promise<{ col: string; doc: string; source: string }> {
    const col = await creerCollection(b.base, uid, nom);
    const doc = await indexerDirect(b, col, "notes.pdf", [
      { texte: `Le contrat ${MARQUEUR} se renouvelle chaque année.` },
      { texte: "La résiliation exige un préavis de trois mois." },
    ]);
    const dossier = join(env.magasin, String(uid), col, "sources");
    mkdirSync(dossier, { recursive: true });
    const source = join(dossier, `${doc}.pdf`);
    writeFileSync(source, "%PDF-1.4 faux document");
    return { col, doc, source };
  }

  /** Retire le droit RAG d'alice : `rag.groups` restreint à B (alice est dans A), ou alice quitte le seul groupe autorisé A. */
  async function partir(quand: Quand): Promise<void> {
    if (quand === "hors_groupes_autorises") env.ecrireConfig({ groups: [b.groupe.B] });
    else {
      env.ecrireConfig({ groups: [b.groupe.A] });
      await setUserGroups(b.base, b.id.alice, []);
    }
    invaliderAccesRag(b.base);
  }

  /** Comptes qui gardent le droit RAG une fois alice partie (l'administrateur l'a toujours). */
  const gardentLeDroit = (quand: Quand): readonly number[] =>
    quand === "hors_groupes_autorises" ? [b.id.admin, b.id.carol] : [b.id.admin, b.id.bob];

  const appels = (col: string, doc: string): readonly [string, string, unknown?][] => [
    ["GET", `/api/rag/collections/${col}`],
    ["PATCH", `/api/rag/collections/${col}`, { description: "x" }],
    [
      "PUT",
      `/api/rag/collections/${col}/publication`,
      { visibility: "groups", group_ids: [b.groupe.A], allow_source_open: true },
    ],
    ["PUT", `/api/rag/collections/${col}/masquage`, { hidden: true }],
    ["GET", `/api/rag/collections/${col}/documents`],
    ["GET", `/api/rag/collections/${col}/documents/${doc}`],
    ["POST", `/api/rag/collections/${col}/import-sandbox`, { paths: ["/work/a.pdf"] }],
    ["POST", `/api/rag/collections/${col}/reindexer`, {}],
    ["POST", `/api/rag/collections/${col}/recherche`, { requete: "contrat" }],
    ["GET", `/api/rag/collections/${col}/documents/${doc}/passages?autour=0&n=2`],
    ["GET", `/api/rag/collections/${col}/documents/${doc}/passages`],
    ["GET", `/api/rag/collections/${col}/documents/${doc}/pages/1`],
    ["POST", `/api/rag/collections/${col}/documents/${doc}/localiser`, { texte: "Le contrat" }],
    ["GET", `/api/rag/collections/${col}/documents/${doc}/original`],
    ["DELETE", `/api/rag/collections/${col}/documents/${doc}`],
    ["POST", `/api/rag/collections/${col}/vider`],
    ["DELETE", `/api/rag/collections/${col}`],
  ];

  const outils = (uid: number, col: string) =>
    creerOutilsChatRag({
      base: b.base,
      uid,
      chatId: null,
      collections: [col],
      mode: "mixte",
      topK: 8,
      precedentes: [],
      ecriture: true,
      onEvent: () => undefined,
      qdrant: () => new ClientQdrant({ url: "http://qdrant.test", fetch: fetchQdrantFaux(b.q) }),
      reranker: () => null,
      service: () => b.service,
    });

  const appelOutil = async (uid: number, col: string, nom: string, args: Json): Promise<string> => {
    const outil = outils(uid, col).outils[nom];
    expect(outil, nom).toBeDefined();
    return (await outil!.handler(args)) as string;
  };

  async function intact(p: { col: string; doc: string; source: string }, uid: number): Promise<void> {
    expect(existsSync(p.source)).toBe(true);
    expect(await b.base.valeurs("SELECT owner_user_id FROM rag_collections WHERE id=?", [p.col])).toEqual([
      [uid],
    ]);
    expect(await b.base.valeurs("SELECT COUNT(*) FROM rag_documents WHERE id=?", [p.doc])).toEqual([[1]]);
    const points = [...b.q.collections.values()].reduce((n, c) => n + c.points.size, 0);
    expect(points).toBeGreaterThan(0);
  }

  describe.each<Quand>(["hors_groupes_autorises", "sorti_du_groupe_autorise"])(
    "droit RAG retiré (%s)",
    (quand) => {
      it("la collection privée n'est lisible par personne, admin compris, sur aucune route", async () => {
        const p = await preparer(b.id.alice, "Notes privées");
        await partir(quand);
        const avecDroit = gardentLeDroit(quand);
        for (const [nom, uid] of [
          ["alice", b.id.alice],
          ["admin", b.id.admin],
          ["bob", b.id.bob],
          ["carol", b.id.carol],
          ["dave", b.id.dave],
        ] as const) {
          for (const [methode, url, corps] of appels(p.col, p.doc)) {
            const r = await b.appeler(uid, methode, url, corps);
            const detail = `${nom} ${methode} ${url} → ${r.statut}`;
            expect(r.statut, detail).toBe(avecDroit.includes(uid) ? 404 : 403);
            expect(json<{ code: string }>(r).code, detail).toBe(
              avecDroit.includes(uid) ? "collection_introuvable" : "rag_interdit",
            );
            expect(r.brut.toString("utf8"), detail).not.toContain(MARQUEUR);
          }
          const depot = await b.televerser(uid, `/api/rag/collections/${p.col}/documents`, [
            { nom: "nouveau.txt", contenu: "Un nouveau fichier." },
          ]);
          expect(depot.statut, `${nom} dépôt`).toBe(avecDroit.includes(uid) ? 404 : 403);
          const liste = await b.appeler(uid, "GET", "/api/rag/collections");
          if (avecDroit.includes(uid)) {
            expect(json<{ collections: { id: string }[] }>(liste).collections.map((c) => c.id)).not.toContain(
              p.col,
            );
          } else expect(liste.statut, `${nom} liste`).toBe(403);
          expect(liste.brut.toString("utf8")).not.toContain(p.col);
        }
        await intact(p, b.id.alice);
      });

      it("aucun outil du chat ne la rend, même désignée par son identifiant, son nom ou celui de son document", async () => {
        const p = await preparer(b.id.alice, "Notes privées");
        await partir(quand);
        for (const uid of [b.id.alice, b.id.admin, b.id.bob, b.id.carol]) {
          const recherche = await appelOutil(uid, p.col, "rag_search", { query: "contrat résiliation" });
          expect(JSON.parse(recherche), String(uid)).toMatchObject({
            ok: false,
            error: "no_active_collection",
          });
          for (const [nom, args] of [
            ["rag_search", { query: "contrat", collection: p.col }],
            ["rag_search", { query: "contrat", collection: "Notes privées" }],
            ["rag_read", { document: p.doc }],
            ["rag_read", { document: "notes.pdf" }],
            ["rag_list", { collection: p.col }],
            ["rag_list", {}],
          ] as const) {
            const brut = await appelOutil(uid, p.col, nom, args);
            expect(brut, `${uid} ${nom}`).not.toContain(MARQUEUR);
            expect(brut, `${uid} ${nom}`).not.toContain("Notes privées");
            expect(brut, `${uid} ${nom}`).not.toContain(p.doc);
          }
        }
        await intact(p, b.id.alice);
      });

      it("la console n'en voit que les métadonnées, jamais le contenu ; elle peut seulement la supprimer", async () => {
        const p = await preparer(b.id.alice, "Notes privées");
        await partir(quand);
        const liste = await b.appelerAdmin(b.id.admin, "GET", "/api/admin/rag/collections");
        expect(liste.statut).toBe(200);
        expect(
          json<{ collections: { id: string; owner: { username: string } }[] }>(liste).collections,
        ).toMatchObject([{ id: p.col, owner: { username: "alice" } }]);
        expect(liste.brut.toString("utf8")).not.toContain(MARQUEUR);
        expect(liste.brut.toString("utf8")).not.toContain("notes.pdf");
        const confier = await b.appelerAdmin(
          b.id.admin,
          "POST",
          `/api/admin/rag/collections/${p.col}/confier`,
          {
            owner_user_id: b.id.admin,
          },
        );
        expect(confier.statut).toBe(404);
        await intact(p, b.id.alice);
      });

      it("elle reste sur disque, en base et dans Qdrant : le droit rendu, alice la retrouve entière et personne d'autre n'y gagne rien", async () => {
        const p = await preparer(b.id.alice, "Notes privées");
        const avant = {
          points: [...b.q.collections.values()].map((c) => c.points.size),
          noms: [...b.q.collections.keys()],
        };
        await partir(quand);
        expect((await b.appeler(b.id.alice, "GET", `/api/rag/collections/${p.col}`)).statut).toBe(403);
        expect([...b.q.collections.keys()]).toEqual(avant.noms);
        expect([...b.q.collections.values()].map((c) => c.points.size)).toEqual(avant.points);
        await intact(p, b.id.alice);
        env.ecrireConfig();
        await setUserGroups(b.base, b.id.alice, [b.groupe.A]);
        invaliderAccesRag(b.base);
        const lu = await b.appeler(
          b.id.alice,
          "GET",
          `/api/rag/collections/${p.col}/documents/${p.doc}/passages?autour=0&n=2`,
        );
        expect(lu.statut).toBe(200);
        expect(lu.brut.toString("utf8")).toContain(MARQUEUR);
        for (const uid of [b.id.admin, b.id.bob, b.id.carol])
          expect((await b.appeler(uid, "GET", `/api/rag/collections/${p.col}`)).statut, String(uid)).toBe(
            404,
          );
      });
    },
  );

  describe("compte supprimé", () => {
    beforeEach(() => {
      brancherIndexationRag("admin", b.base, new CycleDeVie(journalMuet));
      installerServiceIndexationRag(b.service);
    });

    const notifications = (uid: number) =>
      b.base.all("SELECT kind, title FROM notifications WHERE owner_user_id=? ORDER BY id", [uid]);

    it("ses collections sont purgées de la base, du magasin et de Qdrant ; ses lecteurs perdent l'accès et sont prévenus ; les autres comptes ne perdent rien", async () => {
      const privee = await preparer(b.id.alice, "Notes privées");
      const partagee = await preparer(b.id.alice, "Charte");
      await appliquerPublication(b.base, b.id.alice, partagee.col, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: true,
      });
      const deBob = await preparer(b.id.bob, "Procédures");
      expect((await b.appeler(b.id.bob, "GET", `/api/rag/collections/${partagee.col}`)).statut).toBe(200);
      expect(b.q.collections.size).toBe(3);

      expect(await deleteUserFull(b.base, b.id.alice)).toBe(true);

      expect(await b.base.valeurs("SELECT id FROM rag_collections ORDER BY id")).toEqual([[deBob.col]]);
      expect(await b.base.valeurs("SELECT COUNT(*) FROM rag_documents")).toEqual([[1]]);
      expect(await b.base.valeurs("SELECT COUNT(*) FROM rag_grants")).toEqual([[0]]);
      expect(existsSync(join(env.magasin, String(b.id.alice)))).toBe(false);
      expect(existsSync(privee.source) || existsSync(partagee.source)).toBe(false);
      expect(b.q.collections.size).toBe(1);
      expect(existsSync(deBob.source)).toBe(true);
      expect(
        json<{ collection: { name: string } }>(
          await b.appeler(b.id.bob, "GET", `/api/rag/collections/${deBob.col}`),
        ).collection.name,
      ).toBe("Procédures");
      for (const uid of [b.id.bob, b.id.admin, b.id.carol]) {
        for (const c of [privee.col, partagee.col])
          expect((await b.appeler(uid, "GET", `/api/rag/collections/${c}`)).statut, `${uid} ${c}`).toBe(404);
        expect(
          JSON.parse(await appelOutil(uid, partagee.col, "rag_search", { query: "contrat" })),
          String(uid),
        ).toMatchObject({ ok: false, error: "no_active_collection" });
      }
      expect((await notifications(b.id.bob)).map((n) => [n["kind"], n["title"]])).toEqual([
        ["rag_share_end", "La collection Charte n'est plus disponible"],
      ]);
      expect(await notifications(b.id.carol)).toEqual([]);
      expect(await notifications(b.id.dave)).toEqual([]);
    });

    it("droit RAG retiré puis compte supprimé : la collection privée est purgée comme les autres", async () => {
      const p = await preparer(b.id.alice, "Notes privées");
      await partir("hors_groupes_autorises");
      await intact(p, b.id.alice);
      expect(await deleteUserFull(b.base, b.id.alice)).toBe(true);
      expect(await b.base.valeurs("SELECT COUNT(*) FROM rag_collections")).toEqual([[0]]);
      expect(await b.base.valeurs("SELECT COUNT(*) FROM rag_documents")).toEqual([[0]]);
      expect(existsSync(join(env.magasin, String(b.id.alice)))).toBe(false);
      expect(b.q.collections.size).toBe(0);
      expect(await b.base.all("SELECT id FROM notifications")).toEqual([]);
      const liste = await b.appelerAdmin(b.id.admin, "GET", "/api/admin/rag/collections");
      expect(json<{ total: number }>(liste).total).toBe(0);
    });
  });
});
