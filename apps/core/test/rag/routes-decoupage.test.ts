// SPDX-License-Identifier: MIT
/** apps/core/test/rag/routes-decoupage.test.ts — découpage avancé par les routes (SQLite et PostgreSQL) avec le vrai travailleur : aperçu (méthodes, unités, redécoupes, bornes, regex refusées), découpage propre d'un document, règles par extension, passages indexés, droits. */
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  schemaReponseApercuDecoupageRag,
  schemaReponseDecoupageDocumentRag,
  schemaReponseLectureDecoupageDocumentRag,
  schemaReponsePassagesListeRag,
} from "@elpis/contracts";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appliquerPublication } from "../../src/rag/acces";
import { TravailleurRag } from "../../src/rag/travailleur";
import type { ReglagesTravailleurRag } from "../../src/rag/travailleur";
import { jusqua } from "./aides-indexation";
import { demarrerEnvironnement, indexerDirect, json, MOTEURS, ouvrirBanc } from "./aides-routes";
import type { Banc, Environnement } from "./aides-routes";

const RAPIDE: Partial<ReglagesTravailleurRag> = {
  tickActifMs: 15,
  tickInactifMs: 30,
  tickDesactiveMs: 30,
  battementMs: 30,
  attenteMinMs: 80,
  attenteMaxMs: 200,
  debitEvenementsMs: 40,
  arretMs: 5_000,
};

const CONTRAT =
  "# Durée\n\nArticle 1 alpha beta. Article 2 gamma delta.\n\nArticle 3 epsilon zeta.\n\n# Fin\n\nArticle 4 eta theta iota.";
const NOTES = "# Notes\n\nPremier point. Second point.\n\n# Annexe\n\nDernier point du document.";
const GRAND = Array.from({ length: 2300 }, (_, i) => `Ligne ${i}.`).join("\n\n");
const PIEGE = Array.from({ length: 5 }, () => `${"a".repeat(45)}!`).join("\n\n");

const P = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  methode: "taille",
  unite: "caracteres",
  taille: 200,
  chevauchement: 0,
  taille_max: 400,
  ...o,
});

let env: Environnement;

beforeAll(async () => {
  env = await demarrerEnvironnement();
});

afterAll(async () => {
  await env.arreter();
});

interface Erreur {
  detail: string;
  code: string;
}

interface Doc {
  id: string;
  rel_path: string;
  status: string;
  chunk_count: number;
}

describe.each(MOTEURS)("routes RAG : découpage avancé (%s)", (moteur) => {
  let b: Banc;
  let arret: AbortController;
  let boucle: Promise<void>;
  let col: string;
  let docs: Record<string, Doc>;

  const url = (suite = ""): string => `/api/rag/collections/${col}${suite}`;
  const durl = (nom: string, suite: string): string => url(`/documents/${docs[nom]?.id}${suite}`);
  const attendre = (): Promise<void> =>
    jusqua(async () => {
      const r = json<{ jobs: unknown[] }>(await b.appeler(b.id.alice, "GET", "/api/rag/travaux?actifs=1"));
      return r.jobs.length === 0;
    }, "travaux terminés");
  const relire = async (): Promise<void> => {
    const liste = json<{ documents: Doc[] }>(await b.appeler(b.id.alice, "GET", url("/documents"))).documents;
    docs = Object.fromEntries(liste.map((d) => [d.rel_path, d]));
  };
  const apercu = async (nom: string, decoupage: unknown, uid = b.id.alice) =>
    b.appeler(uid, "POST", durl(nom, "/apercu-decoupage"), { decoupage });
  const apercuOk = async (nom: string, decoupage: unknown) => {
    const r = await apercu(nom, decoupage);
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    return schemaReponseApercuDecoupageRag.parse(r.corps);
  };
  const liste = async (nom: string, q = "", uid = b.id.alice) => {
    const r = await b.appeler(uid, "GET", durl(nom, `/passages/liste${q}`));
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    return schemaReponsePassagesListeRag.parse(r.corps);
  };
  const enregistrer = async (nom: string, decoupage: unknown) => {
    const r = await b.appeler(b.id.alice, "PUT", durl(nom, "/decoupage"), { decoupage });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    return schemaReponseDecoupageDocumentRag.parse(r.corps);
  };
  const erreur = (r: { statut: number; corps: unknown }): [number, string] => [
    r.statut,
    json<Erreur>(r as never).code,
  ];

  beforeEach(async () => {
    b = await ouvrirBanc(moteur, env, {
      travailleur: (base, q, evenements) =>
        new TravailleurRag({
          base,
          meneur: { tenu: true, essayer: async () => true },
          diffuser: (m) => void evenements.push(m),
          notifier: async () => undefined,
          qdrant: () => q,
          reglages: RAPIDE,
        }),
    });
    arret = new AbortController();
    boucle = (b.service.travailleur as TravailleurRag).demarrer(arret.signal);
    col = json<{ collection: { id: string } }>(
      await b.appeler(b.id.alice, "POST", "/api/rag/collections", { name: "Découpage" }),
    ).collection.id;
    const depot = await b.televerser(b.id.alice, url("/documents"), [
      { nom: "contrat.txt", contenu: CONTRAT },
      { nom: "notes.md", contenu: NOTES },
      { nom: "grand.txt", contenu: GRAND },
      { nom: "piege.txt", contenu: PIEGE },
    ]);
    expect(depot.statut, JSON.stringify(depot.corps)).toBe(200);
    await attendre();
    await relire();
    expect(Object.values(docs).map((d) => d.status)).toEqual(["ready", "ready", "ready", "ready"]);
  });

  afterEach(async () => {
    arret.abort();
    await (b.service.travailleur as TravailleurRag).arreter();
    await boucle;
    await b.fermer();
  });

  it("aperçu : chaque méthode, unité caractères, sections, pages et estimation des jetons", async () => {
    const auto = await apercuOk("contrat.txt", {});
    expect(auto.passages.map((p) => p.texte)).toEqual(
      (await liste("contrat.txt")).passages.map((p) => p.texte),
    );
    expect(auto).toMatchObject({ total: auto.passages.length, tronque: false, avertissements: [] });
    const taille = await apercuOk("contrat.txt", { params: P({ taille: 30 }) });
    expect(taille.passages.length).toBeGreaterThan(3);
    for (const p of taille.passages) {
      expect(p.caracteres).toBe(p.texte.length);
      expect(p.caracteres).toBeLessThanOrEqual(30);
      expect(p.jetons).toBe(Math.ceil(p.caracteres / 3.3));
      expect(p.page).toBe(1);
      expect(p.redecoupe_de).toBeNull();
    }
    const phrase = await apercuOk("contrat.txt", { params: P({ methode: "phrase", taille: 30 }) });
    expect(phrase.passages.map((p) => p.texte)).toContain("Article 3 epsilon zeta.");
    const md = await apercuOk("contrat.txt", {
      params: P({ methode: "markdown", taille: 1000, taille_max: 2000 }),
    });
    expect(md.passages.map((p) => p.section)).toEqual(["Durée", "Fin"]);
    const sep = await apercuOk("contrat.txt", { params: P({ methode: "separateur", valeur: "\\n\\n" }) });
    expect(sep.passages.map((p) => p.texte)).toEqual([
      "Durée",
      "Article 1 alpha beta. Article 2 gamma delta.",
      "Article 3 epsilon zeta.",
      "Fin",
      "Article 4 eta theta iota.",
    ]);
    const regex = await apercuOk("contrat.txt", { params: P({ methode: "regex", valeur: "Article \\d" }) });
    expect(regex.passages.map((p) => p.texte)).toEqual([
      "Durée",
      "Article 1 alpha beta.",
      "Article 2 gamma delta.",
      "Article 3 epsilon zeta.\n\nFin",
      "Article 4 eta theta iota.",
    ]);
    const jetons = await apercuOk("contrat.txt", {
      params: P({ unite: "jetons", taille: 20, taille_max: 20 }),
    });
    expect(jetons.passages.every((p) => p.caracteres <= 66)).toBe(true);
    expect(jetons.passages.some((p) => p.caracteres > 20)).toBe(true);
  });

  it("aperçu : redécoupes, indices hors découpage signalés, 2 000 passages au plus", async () => {
    const r = await apercuOk("contrat.txt", {
      params: P({ methode: "separateur", valeur: "\\n\\n" }),
      redecoupes: [
        { index: 1, params: P({ methode: "regex", valeur: "Article \\d" }) },
        { index: 9, params: P() },
      ],
    });
    expect(r.passages.map((p) => [p.index, p.redecoupe_de, p.texte])).toEqual([
      [0, null, "Durée"],
      [1, 1, "Article 1 alpha beta."],
      [2, 1, "Article 2 gamma delta."],
      [3, null, "Article 3 epsilon zeta."],
      [4, null, "Fin"],
      [5, null, "Article 4 eta theta iota."],
    ]);
    expect(r.avertissements).toHaveLength(1);
    expect(r.avertissements[0]).toContain("9");
    const grand = await apercuOk("grand.txt", { params: P({ methode: "separateur", valeur: "\\n\\n" }) });
    expect(grand).toMatchObject({ total: 2300, tronque: true });
    expect(grand.passages).toHaveLength(2000);
    expect(grand.passages.at(-1)?.index).toBe(1999);
  });

  it("aperçu et enregistrement : regex invalide ou catastrophique refusée sans écho, extrait absent, corps invalide", async () => {
    for (const valeur of ["(secret[", "a{2,1}"]) {
      const r = await apercu("contrat.txt", { params: P({ methode: "regex", valeur }) });
      expect(erreur(r)).toEqual([400, "regex_invalide"]);
      expect(json<Erreur>(r).detail).not.toContain("secret");
      const put = await b.appeler(b.id.alice, "PUT", durl("contrat.txt", "/decoupage"), {
        decoupage: { redecoupes: [{ index: 0, params: P({ methode: "regex", valeur }) }] },
      });
      expect(erreur(put)).toEqual([400, "regex_invalide"]);
    }
    const debut = Date.now();
    const lente = await apercu("piege.txt", { params: P({ methode: "regex", valeur: "^(a+)+$" }) });
    expect(erreur(lente)).toEqual([400, "regex_invalide"]);
    expect(Date.now() - debut).toBeLessThan(8000);
    for (const corps of [
      { params: P({ methode: "regex" }) },
      { params: P({ chevauchement: 100 }) },
      { params: P({ unite: "mots" }) },
      { redecoupes: [{ index: -1, params: P() }] },
      {
        redecoupes: [
          { index: 0, params: P() },
          { index: 0, params: P() },
        ],
      },
    ])
      expect(erreur(await apercu("contrat.txt", corps)), JSON.stringify(corps)).toEqual([
        400,
        "requete_invalide",
      ]);
    const direct = await indexerDirect(b, col, "direct.pdf", [{ texte: "Sans extrait." }]);
    const sans = await b.appeler(b.id.alice, "POST", url(`/documents/${direct}/apercu-decoupage`), {
      decoupage: {},
    });
    expect(erreur(sans)).toEqual([409, "extrait_indisponible"]);
    expect(
      erreur(
        await b.appeler(b.id.alice, "POST", url(`/documents/${col}/apercu-decoupage`), { decoupage: {} }),
      ),
    ).toEqual([404, "document_introuvable"]);
  }, 20_000);

  it("découpage propre d'un document : enregistré, réindexé comme l'aperçu, redécoupes indexées, puis retiré", async () => {
    const avant = (await liste("contrat.txt")).passages.map((p) => p.texte);
    const propre = { params: P({ methode: "separateur", valeur: "\\n\\n" }) };
    const r1 = await enregistrer("contrat.txt", propre);
    expect(r1.job).toMatchObject({ kind: "reindex", total: 1 });
    expect(["pending", "extracting", "indexing", "ready"]).toContain(r1.document.status);
    const fichier = join(
      env.magasin,
      String(b.id.alice),
      col,
      "extraits",
      `${docs["contrat.txt"]?.id}.decoupage.json`,
    );
    expect(existsSync(fichier)).toBe(true);
    await attendre();
    const lu = schemaReponseLectureDecoupageDocumentRag.parse(
      (await b.appeler(b.id.alice, "GET", durl("contrat.txt", "/decoupage"))).corps,
    );
    expect(lu.decoupage).toEqual({
      params: {
        methode: "separateur",
        valeur: "\\n\\n",
        unite: "caracteres",
        taille: 200,
        chevauchement: 0,
        taille_max: 400,
      },
      redecoupes: [],
    });
    expect((await liste("contrat.txt")).passages.map((p) => p.texte)).toEqual(
      (await apercuOk("contrat.txt", propre)).passages.map((p) => p.texte),
    );
    expect((await enregistrer("contrat.txt", propre)).job).toBeNull();

    const avecRedecoupe = {
      ...propre,
      redecoupes: [{ index: 1, params: P({ methode: "regex", valeur: "Article \\d" }) }],
    };
    const attendu = await apercuOk("contrat.txt", avecRedecoupe);
    expect((await enregistrer("contrat.txt", avecRedecoupe)).job).toMatchObject({ total: 1 });
    await attendre();
    const indexes = await liste("contrat.txt");
    expect(indexes.total).toBe(attendu.total);
    expect(indexes.passages.map((p) => [p.index, p.texte, p.redecoupe_de])).toEqual(
      attendu.passages.map((p) => [p.index, p.texte, null]),
    );
    const enBase = await b.base.get("SELECT chunk_count FROM rag_documents WHERE id=?", [
      String(docs["contrat.txt"]?.id),
    ]);
    expect(Number(enBase?.["chunk_count"])).toBe(6);

    const retrait = await enregistrer("contrat.txt", null);
    expect(retrait.job).toMatchObject({ total: 1 });
    expect(existsSync(fichier)).toBe(false);
    await attendre();
    expect((await liste("contrat.txt")).passages.map((p) => p.texte)).toEqual(avant);
    expect(
      schemaReponseLectureDecoupageDocumentRag.parse(
        (await b.appeler(b.id.alice, "GET", durl("contrat.txt", "/decoupage"))).corps,
      ).decoupage,
    ).toBeNull();
  });

  it("règles par extension : seuls les documents concernés sont réindexés, un découpage propre l'emporte", async () => {
    await enregistrer("notes.md", { params: P({ methode: "separateur", valeur: "\\n\\n" }) });
    await attendre();
    await relire();
    const propreNotes = docs["notes.md"]?.chunk_count;
    expect(propreNotes).toBe(4);
    const regle = P({ methode: "regex", valeur: "Article \\d" });
    const r = await b.appeler(b.id.alice, "PATCH", url(), {
      chunking: {
        methode: "auto",
        unite: "jetons",
        taille: 512,
        chevauchement: 64,
        taille_max: 1200,
        par_extension: { txt: regle, md: P({ methode: "markdown" }) },
      },
    });
    expect(r.statut, JSON.stringify(r.corps)).toBe(200);
    expect(json<{ job: { total: number } }>(r).job.total).toBe(3);
    await attendre();
    await relire();
    expect(docs["notes.md"]?.chunk_count).toBe(propreNotes);
    expect((await liste("contrat.txt")).passages.map((p) => p.texte)).toEqual([
      "Durée",
      "Article 1 alpha beta.",
      "Article 2 gamma delta.",
      "Article 3 epsilon zeta.\n\nFin",
      "Article 4 eta theta iota.",
    ]);
    const autre = await b.appeler(b.id.alice, "PATCH", url(), {
      chunking: {
        methode: "phrase",
        unite: "jetons",
        taille: 512,
        chevauchement: 64,
        taille_max: 1200,
        par_extension: { txt: regle, md: P({ methode: "markdown" }) },
      },
    });
    expect(json<{ job: unknown }>(autre).job).toBeNull();
  });

  it("liste des passages indexés : ordre, pagination bornée, total ; limite invalide refusée", async () => {
    const tout = await liste("grand.txt", "?limit=500");
    const n = docs["grand.txt"]?.chunk_count ?? 0;
    expect(n).toBeGreaterThan(3);
    expect(tout.total).toBe(n);
    expect(tout.passages.map((p) => p.index)).toEqual(Array.from({ length: Math.min(n, 200) }, (_, i) => i));
    const page = await liste("grand.txt", "?offset=2&limit=2");
    expect(page.passages.map((p) => p.index)).toEqual([2, 3]);
    expect(page.passages[0]?.texte).toBe(tout.passages[2]?.texte);
    expect(page.passages[0]?.section).toBeNull();
    expect((await liste("grand.txt", `?offset=${n}`)).passages).toEqual([]);
    const contrat = await liste("contrat.txt");
    expect(contrat.passages[0]?.section).toBe("Durée");
    for (const q of ["?limit=abc", "?offset=-1", "?limit=1000"])
      expect(erreur(await b.appeler(b.id.alice, "GET", durl("grand.txt", `/passages/liste${q}`)))).toEqual([
        400,
        "requete_invalide",
      ]);
  });

  it("droits : lecteur (aperçu et enregistrement refusés, liste selon l'ouverture des sources), autre compte 404", async () => {
    const publier = async (ouvertes: boolean): Promise<void> =>
      void (await appliquerPublication(b.base, b.id.alice, col, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: ouvertes,
      }));
    await publier(false);
    expect(erreur(await apercu("contrat.txt", {}, b.id.bob))).toEqual([403, "lecture_seule"]);
    for (const [methode, suite, corps] of [
      ["PUT", "/decoupage", { decoupage: null }],
      ["GET", "/decoupage", undefined],
    ] as const)
      expect(erreur(await b.appeler(b.id.bob, methode, durl("contrat.txt", suite), corps))).toEqual([
        403,
        "lecture_seule",
      ]);
    expect(erreur(await b.appeler(b.id.bob, "GET", durl("contrat.txt", "/passages/liste")))).toEqual([
      403,
      "sources_fermees",
    ]);
    await publier(true);
    expect((await liste("contrat.txt", "", b.id.bob)).passages.length).toBe(docs["contrat.txt"]?.chunk_count);
    expect(erreur(await apercu("contrat.txt", {}, b.id.bob))).toEqual([403, "lecture_seule"]);
    for (const [methode, suite, corps] of [
      ["POST", "/apercu-decoupage", { decoupage: {} }],
      ["PUT", "/decoupage", { decoupage: null }],
      ["GET", "/decoupage", undefined],
      ["GET", "/passages/liste", undefined],
    ] as const)
      expect(erreur(await b.appeler(b.id.carol, methode, durl("contrat.txt", suite), corps))).toEqual([
        404,
        "collection_introuvable",
      ]);
  });
});
