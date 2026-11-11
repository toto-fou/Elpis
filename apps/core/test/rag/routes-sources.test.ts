// SPDX-License-Identifier: MIT
/** apps/core/test/rag/routes-sources.test.ts — sources de la visionneuse (SQLite et PostgreSQL) : fenêtre de passages, page rendue et son cache, localisation, original en téléchargement ; règle d'ouverture des sources entre propriétaire et lecteur. */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { schemaReponseLocalisationRag, schemaReponsePassagesDocumentRag } from "@elpis/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appliquerPublication } from "../../src/rag/acces";
import {
  lectureRestreintePermise,
  oublierLecturesRestreintes,
  PAGES_EN_CACHE_MAX,
  reglagesLecturesRestreintes,
} from "../../src/rag/sources";
import { creerCollection } from "./aides-indexation";
import { demarrerEnvironnement, faussePage, indexerDirect, json, MOTEURS, ouvrirBanc } from "./aides-routes";
import type { Banc, Environnement } from "./aides-routes";

let env: Environnement;
let autresOrigine: Environnement["ext"]["autres"];

beforeAll(async () => {
  env = await demarrerEnvironnement();
  autresOrigine = env.ext.autres;
});

afterAll(async () => {
  await env.arreter();
});

interface Erreur {
  detail: string;
  code: string;
}

describe.each(MOTEURS)("routes RAG : sources (%s)", (moteur) => {
  let b: Banc;
  let col: string;
  let doc: string;
  let autreDoc: string;
  const base = (): string => `/api/rag/collections/${col}/documents/${doc}`;
  const dossierPages = (): string => join(env.magasin, String(b.id.alice), col, "pages", doc);

  beforeEach(async () => {
    b = await ouvrirBanc(moteur, env);
    col = await creerCollection(b.base, b.id.alice, "Contrats");
    doc = await indexerDirect(
      b,
      col,
      "droit/contrat.pdf",
      Array.from({ length: 12 }, (_, i) => ({
        texte: `Passage numéro ${i} du contrat.`,
        titres: `${i + 1} › Section`,
        page: 1 + Math.floor(i / 4),
        boites: [[10, 10 + i, 100, 30 + i]] as [number, number, number, number][],
      })),
    );
    autreDoc = await indexerDirect(b, col, "autre.pdf", [{ texte: "Le seul passage de l'autre document." }]);
    const sources = join(env.magasin, String(b.id.alice), col, "sources");
    mkdirSync(sources, { recursive: true });
    writeFileSync(join(sources, `${doc}.pdf`), "%PDF-1.4\ncontenu binaire\u0000\u0001 de test");
  });

  afterEach(async () => {
    env.ext.autres = autresOrigine;
    await b.fermer();
  });

  const publier = async (ouvertes: boolean): Promise<void> =>
    void (await appliquerPublication(b.base, b.id.alice, col, {
      visibility: "groups",
      group_ids: [b.groupe.A],
      allow_source_open: ouvertes,
    }));

  describe("passages", () => {
    const fenetre = async (q: string, uid = b.id.alice) => {
      const r = await b.appeler(uid, "GET", `${base()}/passages${q}`);
      expect(r.statut, JSON.stringify(r.corps)).toBe(200);
      return schemaReponsePassagesDocumentRag.parse(r.corps);
    };

    it("le propriétaire lit une fenêtre autour d'un passage, dans l'ordre, sans les passages d'un autre document", async () => {
      const r = await fenetre("?autour=5&n=2");
      expect(r.passages.map((p) => p.chunk_index)).toEqual([3, 4, 5, 6, 7]);
      expect(r).toMatchObject({ chunk_count: 12, restricted: false });
      expect(r.passages[2]).toMatchObject({
        text: "Passage numéro 5 du contrat.",
        heading_path: "6 › Section",
        page: 2,
        boxes: [[2, 10, 15, 100, 35]],
      });
      expect(r.passages[2]?.char_end).toBeGreaterThan(r.passages[2]?.char_start ?? 0);
    });

    it("bords : début, fin, hors du document, fenêtre bornée à 10 de chaque côté", async () => {
      expect((await fenetre("?autour=0&n=1")).passages.map((p) => p.chunk_index)).toEqual([0, 1]);
      expect((await fenetre("?autour=11&n=3")).passages.map((p) => p.chunk_index)).toEqual([8, 9, 10, 11]);
      expect((await fenetre("?autour=40&n=2")).passages).toEqual([]);
      expect((await fenetre("?autour=6&n=50")).passages).toHaveLength(12);
      expect((await fenetre("")).passages.map((p) => p.chunk_index)).toEqual([0, 1, 2, 3]);
      expect((await fenetre("?autour=2&n=0")).passages.map((p) => p.chunk_index)).toEqual([2]);
    });

    it("lecteur sans ouverture des sources : le seul passage demandé, jamais ses voisins ni de fenêtre sans position", async () => {
      await publier(false);
      const r = await fenetre("?autour=5&n=3", b.id.bob);
      expect(r.passages.map((p) => p.chunk_index)).toEqual([5]);
      expect(r.restricted).toBe(true);
      const sans = await b.appeler(b.id.bob, "GET", `${base()}/passages`);
      expect([sans.statut, json<Erreur>(sans).code]).toEqual([403, "sources_fermees"]);
    });

    it("lecteur sans ouverture : lectures passage par passage plafonnées par minute (429), le propriétaire jamais", async () => {
      await publier(false);
      oublierLecturesRestreintes();
      const avant = { ...reglagesLecturesRestreintes };
      reglagesLecturesRestreintes.max = 3;
      try {
        for (const i of [0, 1, 2]) expect((await fenetre(`?autour=${i}`, b.id.bob)).passages).toHaveLength(1);
        const trop = await b.appeler(b.id.bob, "GET", `${base()}/passages?autour=3`);
        expect([trop.statut, json<Erreur>(trop).code]).toEqual([429, "trop_de_requetes"]);
        for (const i of [0, 1, 2, 3, 4]) expect((await fenetre(`?autour=${i}`)).restricted).toBe(false);
        expect(lectureRestreintePermise(b.id.bob, col, Date.now() + 61_000)).toBe(true);
      } finally {
        Object.assign(reglagesLecturesRestreintes, avant);
        oublierLecturesRestreintes();
      }
    });

    it("lecteur avec sources ouvertes : la fenêtre complète", async () => {
      await publier(true);
      const r = await fenetre("?autour=5&n=2", b.id.bob);
      expect(r.passages).toHaveLength(5);
      expect(r.restricted).toBe(false);
    });

    it("document d'une autre collection, identifiant inconnu ou paramètres invalides", async () => {
      const autre = await creerCollection(b.base, b.id.alice, "Autre collection");
      const ailleurs = await indexerDirect(b, autre, "x.pdf", [{ texte: "x" }]);
      for (const id of [ailleurs, "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d", "x"]) {
        const r = await b.appeler(
          b.id.alice,
          "GET",
          `/api/rag/collections/${col}/documents/${id}/passages?autour=0`,
        );
        expect([r.statut, json<Erreur>(r).code], id).toEqual([404, "document_introuvable"]);
      }
      for (const q of ["?autour=-1", "?autour=abc", "?n=100", "?n=x", "?autour=1.5"]) {
        const r = await b.appeler(b.id.alice, "GET", `${base()}/passages${q}`);
        expect([r.statut, json<Erreur>(r).code], q).toEqual([400, "requete_invalide"]);
      }
      expect(autreDoc).not.toBe(doc);
    });

    it("Qdrant injoignable : 503 ; collection vectorielle absente : liste vide", async () => {
      b.q.panne = true;
      const r = await b.appeler(b.id.alice, "GET", `${base()}/passages?autour=1`);
      expect([r.statut, json<Erreur>(r).code]).toEqual([503, "qdrant_indisponible"]);
      b.q.panne = false;
      b.q.collections.clear();
      expect((await fenetre("?autour=1")).passages).toEqual([]);
    });
  });

  describe("pages", () => {
    const page = (n: number | string, uid = b.id.alice, entetes: Record<string, string> = {}) =>
      b.app.inject({
        method: "GET",
        url: `${base()}/pages/${n}`,
        headers: { "x-uid": String(uid), ...entetes },
      });

    it("rendu par l'extracteur puis gardé : en-têtes, octets, chemin relatif au magasin, jeton de service", async () => {
      const r = await page(1);
      expect(r.statusCode).toBe(200);
      expect(r.rawPayload.equals(faussePage(1))).toBe(true);
      expect(r.headers).toMatchObject({
        "content-type": "image/webp",
        "x-content-type-options": "nosniff",
        "x-rag-dpi": "110",
        "x-rag-pages": "3",
        "cache-control": "private, no-cache",
      });
      expect(String(r.headers["etag"])).toMatch(/^"[0-9a-f]{16}-1"$/u);
      expect(env.rendus.rendus).toEqual([
        {
          source: `${b.id.alice}/${col}/sources/${doc}.pdf`,
          ext: "pdf",
          page: 1,
          dpi: 110,
          jeton: expect.stringMatching(/^Bearer /u),
        },
      ]);
      expect(existsSync(join(dossierPages(), "1.webp"))).toBe(true);
      const encore = await page(1);
      expect(encore.rawPayload.equals(faussePage(1))).toBe(true);
      expect(env.rendus.rendus).toHaveLength(1);
    });

    it("If-None-Match : 304 sans corps ; une page demandée en parallèle n'est rendue qu'une fois", async () => {
      const r = await page(2);
      const etag = String(r.headers["etag"]);
      const m = await page(2, b.id.alice, { "if-none-match": etag });
      expect([m.statusCode, m.rawPayload.length]).toEqual([304, 0]);
      env.rendus.rendus.length = 0;
      const rs = await Promise.all([page(3), page(3), page(3)]);
      expect(rs.every((x) => x.statusCode === 200)).toBe(true);
      expect(env.rendus.rendus).toHaveLength(1);
    });

    it("pages hors du document ou mal écrites : 404 page_introuvable, sans appeler l'extracteur", async () => {
      for (const n of ["4", "0", "-1", "abc", "1.5", "1000000", "01"]) {
        const r = await page(n);
        expect([r.statusCode, r.json<Erreur>().code], n).toEqual([404, "page_introuvable"]);
      }
      expect(env.rendus.rendus).toEqual([]);
    });

    it("rendu sans nombre de pages connu : l'extracteur tranche", async () => {
      await b.base.run("UPDATE rag_documents SET pages=NULL WHERE id=?", [doc]);
      env.rendus.pages = 2;
      const r = await page(5);
      expect([r.statusCode, r.json<Erreur>().code]).toEqual([404, "page_introuvable"]);
      expect(env.rendus.rendus).toHaveLength(1);
      env.rendus.pages = 3;
    });

    it("extracteur en panne : 503 ; document illisible : 422 ; rien n'est gardé", async () => {
      env.rendus.modeRendu = "panne";
      const p = await page(1);
      expect([p.statusCode, p.json<Erreur>().code]).toEqual([503, "extracteur_indisponible"]);
      env.rendus.modeRendu = "illisible";
      const i = await page(1);
      expect([i.statusCode, i.json<Erreur>().code]).toEqual([422, "rendu_impossible"]);
      expect(existsSync(dossierPages())).toBe(false);
    });

    it("cache abîmé (pas du WebP) : rendu refait ; cache élagué au-delà du plafond, les plus anciens d'abord", async () => {
      mkdirSync(dossierPages(), { recursive: true });
      writeFileSync(join(dossierPages(), "1.webp"), "pas une image");
      expect((await page(1)).rawPayload.equals(faussePage(1))).toBe(true);
      expect(readFileSync(join(dossierPages(), "1.webp")).equals(faussePage(1))).toBe(true);
      for (let n = 10; n < 10 + PAGES_EN_CACHE_MAX; n++) {
        const f = join(dossierPages(), `${n}.webp`);
        writeFileSync(f, faussePage(n));
        const t = new Date(Date.now() - (PAGES_EN_CACHE_MAX + 100 - n) * 1000);
        utimesSync(f, t, t);
      }
      expect((await page(2)).statusCode).toBe(200);
      const restes = readdirSync(dossierPages());
      expect(restes.length).toBeLessThanOrEqual(PAGES_EN_CACHE_MAX);
      expect(restes).toContain("2.webp");
      expect(restes).not.toContain("10.webp");
    });

    it("version remplacée pendant le rendu : l'ancien rendu n'est pas gardé", async () => {
      env.ext.autres = ((ancien) => async (req, res) => {
        if (req.url === "/api/render")
          await b.base.run("UPDATE rag_documents SET sha256=? WHERE id=?", ["f".repeat(64), doc]);
        return ancien?.(req, res) ?? false;
      })(env.ext.autres);
      const r = await page(1);
      expect(r.statusCode).toBe(200);
      expect(existsSync(join(dossierPages(), "1.webp"))).toBe(false);
    });

    it("lecteur : sources ouvertes, il reçoit la page ; fermées, 403", async () => {
      await publier(false);
      expect((await page(1, b.id.bob)).statusCode).toBe(403);
      await publier(true);
      expect((await page(1, b.id.bob)).statusCode).toBe(200);
    });
  });

  describe("localisation", () => {
    const localiser = (corps: unknown, uid = b.id.alice) =>
      b.appeler(uid, "POST", `${base()}/localiser`, corps);

    it("page et rectangles au format [page, x0, y0, x1, y1] avec la taille de la page", async () => {
      const r = await localiser({ texte: "Passage numéro 5 du contrat." });
      expect(r.statut, JSON.stringify(r.corps)).toBe(200);
      expect(schemaReponseLocalisationRag.parse(r.corps)).toEqual({
        page: 2,
        boxes: [
          [2, 10, 20, 110, 40],
          [2, 10, 44, 90, 60],
        ],
        score: 1,
        page_width: 595.28,
        page_height: 841.89,
      });
      expect(env.rendus.localisations).toEqual([
        {
          source: `${b.id.alice}/${col}/sources/${doc}.pdf`,
          ext: "pdf",
          text: "Passage numéro 5 du contrat.",
          page_hint: null,
        },
      ]);
    });

    it("page probable transmise ; passage introuvable : page nulle, aucun rectangle", async () => {
      const r = await localiser({ texte: "autre texte", page: 3 });
      expect(json<{ page: number }>(r).page).toBe(3);
      expect(env.rendus.localisations.at(-1)?.page_hint).toBe(3);
      const rien = await localiser({ texte: "INTROUVABLE" });
      expect(schemaReponseLocalisationRag.parse(rien.corps)).toMatchObject({
        page: null,
        boxes: [],
        score: 0,
      });
    });

    it("extracteur en panne : 503 ; corps invalides : 400", async () => {
      env.rendus.modeRendu = "ok";
      env.ext.autres = ((ancien) => async (req, res) => {
        if (req.url === "/api/locate") {
          res.writeHead(503).end();
          return true;
        }
        return ancien?.(req, res) ?? false;
      })(env.ext.autres);
      const panne = await localiser({ texte: "x" });
      expect([panne.statut, json<Erreur>(panne).code]).toEqual([503, "extracteur_indisponible"]);
      for (const corps of [
        {},
        { texte: "" },
        { texte: "x".repeat(20_001) },
        { texte: "x", page: 0 },
        { texte: 5 },
      ]) {
        const r = await localiser(corps);
        expect([r.statut, json<Erreur>(r).code]).toEqual([400, "requete_invalide"]);
      }
    });

    it("lecteur : sources fermées 403, ouvertes 200", async () => {
      await publier(false);
      expect((await localiser({ texte: "x" }, b.id.bob)).statut).toBe(403);
      await publier(true);
      expect((await localiser({ texte: "x" }, b.id.bob)).statut).toBe(200);
    });
  });

  describe("original", () => {
    const original = (uid = b.id.alice) =>
      b.app.inject({ method: "GET", url: `${base()}/original`, headers: { "x-uid": String(uid) } });

    it("téléchargement : octets intacts, en pièce jointe, sans interprétation par le navigateur", async () => {
      const r = await original();
      expect(r.statusCode).toBe(200);
      expect(
        r.rawPayload.equals(
          readFileSync(join(env.magasin, String(b.id.alice), col, "sources", `${doc}.pdf`)),
        ),
      ).toBe(true);
      expect(r.headers).toMatchObject({
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="contrat.pdf"',
        "x-content-type-options": "nosniff",
        "content-length": String(r.rawPayload.length),
        "cache-control": "private, no-store",
      });
    });

    it("nom accentué ou piégé : encodé dans l'en-tête, jamais injecté", async () => {
      await b.base.run("UPDATE rag_documents SET name=?, rel_path=? WHERE id=?", [
        'rapport "final"\r\nSet-Cookie: x=1 é.pdf',
        "rapport.pdf",
        doc,
      ]);
      const r = await original();
      expect(r.statusCode).toBe(200);
      const d = String(r.headers["content-disposition"]);
      expect(d).toMatch(/^attachment; filename\*=utf-8''/u);
      expect(d).not.toMatch(/[\r\n"]/u);
      expect(r.headers["set-cookie"]).toBeUndefined();
    });

    it("source absente ou remplacée par un lien symbolique : 404, jamais le fichier visé", async () => {
      const f = join(env.magasin, String(b.id.alice), col, "sources", `${doc}.pdf`);
      const secret = join(env.dossier, "secret.txt");
      writeFileSync(secret, "contenu secret");
      rmSync(f);
      const absent = await original();
      expect([absent.statusCode, absent.json<Erreur>().code]).toEqual([404, "document_introuvable"]);
      symlinkSync(secret, f);
      const lien = await original();
      expect(lien.statusCode).toBe(404);
      expect(lien.body).not.toContain("secret");
    });

    it("lecteur : sources fermées 403, ouvertes 200 ; un tiers 404", async () => {
      await publier(false);
      expect((await original(b.id.bob)).statusCode).toBe(403);
      await publier(true);
      expect((await original(b.id.bob)).statusCode).toBe(200);
      expect((await original(b.id.carol)).statusCode).toBe(404);
    });
  });
});
