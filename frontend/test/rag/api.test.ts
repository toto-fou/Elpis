// SPDX-License-Identifier: MIT
/** frontend/test/rag/api.test.ts — accès REST de la page RAG : URLs, méthodes, corps, réponses validées par les contrats, codes d'erreur stables. */
import { describe, expect, it } from "vitest";

import { GestionnaireSession } from "../../src/features/auth/session";
import { creerApiRag } from "../../src/features/rag/api";
import { ClientHttp } from "../../src/platform/http/client";
import { json } from "../aides";
import { collection, document, etat, idRag, travail } from "./aides";

type Appel = { url: string; init: RequestInit | undefined };

function api(reponse: (u: string, i?: RequestInit) => Response | Promise<Response>) {
  const appels: Appel[] = [];
  const a = creerApiRag(
    new ClientHttp(new GestionnaireSession(), (u, i) => {
      appels.push({ url: u, init: i });
      return Promise.resolve(reponse(u, i));
    }),
  );
  return { a, appels };
}

const C = idRag(1);

describe("lectures", () => {
  it("état du RAG pour le compte", async () => {
    const { a, appels } = api(() => json(etat({ can_publish_all: true })));
    const r = await a.etat();
    expect(appels[0]?.url).toBe("/api/rag/etat");
    expect(r.ok && r.valeur.can_publish_all).toBe(true);
  });

  it("liste des collections avec les masquées, rendue sans l'enveloppe", async () => {
    const { a, appels } = api(() =>
      json({ collections: [collection(1), collection(2, { hidden: true, role: "lecteur" })] }),
    );
    const r = await a.collections();
    expect(appels[0]?.url).toBe("/api/rag/collections?masquees=1");
    expect(r.ok && r.valeur.map((c) => c.id)).toEqual([idRag(1), idRag(2)]);
  });

  it("documents paginés par décalage et limite", async () => {
    const { a, appels } = api(() =>
      json({ documents: [document(1, C)], total: 1200, offset: 500, limit: 500 }),
    );
    const r = await a.documents(C, 500, 500);
    expect(appels[0]?.url).toBe(`/api/rag/collections/${C}/documents?offset=500&limit=500`);
    expect(r.ok && r.valeur.total).toBe(1200);
  });

  it("travaux actifs du compte", async () => {
    const { a, appels } = api(() => json({ jobs: [travail(1, C)] }));
    const r = await a.travaux(true);
    expect(appels[0]?.url).toBe("/api/rag/travaux?actifs=1");
    expect(r.ok && r.valeur).toHaveLength(1);
  });

  it("arbre du bac et URL de l'original", async () => {
    const { a, appels } = api(() =>
      json({
        root: "/work",
        items: [{ name: "a.md", path: "a.md", type: "file" }],
        truncated: false,
        max_entries: 5000,
      }),
    );
    const r = await a.arbreBac();
    expect(appels[0]?.url).toBe("/api/sandbox/tree");
    expect(r.ok && r.valeur.items).toHaveLength(1);
    expect(a.urlOriginal(C, idRag(1001))).toBe(`/api/rag/collections/${C}/documents/${idRag(1001)}/original`);
  });
});

describe("écritures", () => {
  it("création : description omise si vide, JSON", async () => {
    const { a, appels } = api(() => json({ collection: collection(1, { name: "Réseau" }) }));
    await a.creer("Réseau", "  ");
    await a.creer("Réseau", "Notes");
    expect(appels[0]?.init?.method).toBe("POST");
    expect(appels[0]?.url).toBe("/api/rag/collections");
    expect(appels[0]?.init?.body).toBe('{"name":"Réseau"}');
    expect(appels[1]?.init?.body).toBe('{"name":"Réseau","description":"Notes"}');
  });

  it("mise à jour partielle (PATCH), publication (PUT), masquage (PUT)", async () => {
    const { a, appels } = api((u) =>
      u.endsWith("/publication")
        ? json({ collection: collection(1), notified: 3 })
        : u.endsWith("/masquage")
          ? json({ collection: collection(1) })
          : json({ collection: collection(1), job: null }),
    );
    await a.maj(C, { name: "N", ocr: true });
    await a.publier(C, { visibility: "groups", group_ids: [1, 2], allow_source_open: false });
    await a.masquer(C, true);
    expect(appels.map((x) => [x.init?.method, x.url])).toEqual([
      ["PATCH", `/api/rag/collections/${C}`],
      ["PUT", `/api/rag/collections/${C}/publication`],
      ["PUT", `/api/rag/collections/${C}/masquage`],
    ]);
    expect(appels[0]?.init?.body).toBe('{"name":"N","ocr":true}');
    expect(appels[1]?.init?.body).toBe('{"visibility":"groups","group_ids":[1,2],"allow_source_open":false}');
    expect(appels[2]?.init?.body).toBe('{"hidden":true}');
  });

  it("suppression de collection et de document, vidage", async () => {
    const { a, appels } = api((u) =>
      u.endsWith("/vider") ? json({ ok: true, deleted: 4 }) : json({ ok: true }),
    );
    await a.supprimer(C);
    await a.supprimerDocument(C, idRag(1001));
    const v = await a.vider(C);
    expect(appels.map((x) => [x.init?.method, x.url])).toEqual([
      ["DELETE", `/api/rag/collections/${C}`],
      ["DELETE", `/api/rag/collections/${C}/documents/${idRag(1001)}`],
      ["POST", `/api/rag/collections/${C}/vider`],
    ]);
    expect(v.ok && v.valeur.deleted).toBe(4);
  });

  it("dépôt : multipart sans en-tête de type fixé (la frontière vient du navigateur)", async () => {
    const { a, appels } = api(() =>
      json({ results: [{ name: "a.md", status: "ajoute", document: document(1, C) }], job: travail(1, C) }),
    );
    const fd = new FormData();
    fd.append("files", new File(["x"], "a.md"), "dossier/a.md");
    const r = await a.deposer(C, fd);
    expect(appels[0]?.init?.method).toBe("POST");
    expect(appels[0]?.init?.body).toBe(fd);
    expect(appels[0]?.init?.headers).toBeUndefined();
    expect(r.ok && r.valeur.results[0]?.status).toBe("ajoute");
  });

  it("import du bac, réindexation (une seule ou toute la collection), actions sur un travail", async () => {
    const { a, appels } = api((u) =>
      u.includes("/travaux/")
        ? json({ job: travail(1, C, { status: "paused" }) })
        : u.endsWith("/reindexer")
          ? json({ job: null })
          : json({ results: [], job: null }),
    );
    await a.importerBac(C, ["docs/a.pdf"]);
    await a.reindexer(C, [idRag(1001)], true);
    await a.reindexer(C);
    const t = await a.agirTravail(idRag(2001), "suspendre");
    expect(appels[0]?.init?.body).toBe('{"paths":["docs/a.pdf"]}');
    expect(appels[1]?.init?.body).toBe(`{"documents":["${idRag(1001)}"],"force":true}`);
    expect(appels[2]?.init?.body).toBe("{}");
    expect(appels[3]?.url).toBe(`/api/rag/travaux/${idRag(2001)}/suspendre`);
    expect(t.ok && t.valeur.status).toBe("paused");
  });

  it("recherche de l'onglet Tester", async () => {
    const { a, appels } = api(() =>
      json({
        mode: "mixte",
        reranked: false,
        passages: [],
        map: [],
        duration_ms: 4,
        tokens: 0,
        warnings: [],
        errors: [],
      }),
    );
    const r = await a.rechercher(C, { requete: "q", mode: "sens", limite: 6, reclasser: true });
    expect(appels[0]?.url).toBe(`/api/rag/collections/${C}/recherche`);
    expect(appels[0]?.init?.body).toBe('{"requete":"q","mode":"sens","limite":6,"reclasser":true}');
    expect(r.ok).toBe(true);
  });
});

describe("découpage avancé", () => {
  const D = idRag(1001);
  const regles = {
    methode: "phrase",
    unite: "jetons",
    taille: 300,
    chevauchement: 30,
    taille_max: 900,
  } as const;
  const passageListe = {
    index: 0,
    texte: "t",
    caracteres: 1,
    jetons: 1,
    page: null,
    section: null,
    redecoupe_de: null,
  };

  it("collection : le PATCH porte le découpage entier, règles par extension comprises", async () => {
    const { a, appels } = api(() => json({ collection: collection(1), job: null }));
    await a.maj(C, { chunking: { ...regles, par_extension: { pdf: regles } } });
    expect(appels[0]?.url).toBe(`/api/rag/collections/${C}`);
    expect(appels[0]?.init?.method).toBe("PATCH");
    expect(JSON.parse(String(appels[0]?.init?.body))).toEqual({
      chunking: { ...regles, par_extension: { pdf: regles } },
    });
  });

  it("aperçu : POST du découpage du document, réponse validée", async () => {
    const { a, appels } = api(() =>
      json({ passages: [passageListe], total: 1, tronque: false, avertissements: ["a", "b"] }),
    );
    const r = await a.apercuDecoupage(C, D, { params: regles, redecoupes: [{ index: 2, params: regles }] });
    expect(appels[0]?.url).toBe(`/api/rag/collections/${C}/documents/${D}/apercu-decoupage`);
    expect(appels[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(appels[0]?.init?.body))).toEqual({
      decoupage: { params: regles, redecoupes: [{ index: 2, params: regles }] },
    });
    expect(r.ok && r.valeur.avertissements).toEqual(["a", "b"]);
  });

  it("application : PUT du découpage (ou null pour revenir à la collection), document et travail rendus", async () => {
    const { a, appels } = api(() =>
      json({ document: document(1, C), job: travail(1, C, { kind: "reindex" }) }),
    );
    const r = await a.appliquerDecoupage(C, D, null);
    await a.appliquerDecoupage(C, D, { redecoupes: [] });
    expect(appels[0]?.url).toBe(`/api/rag/collections/${C}/documents/${D}/decoupage`);
    expect(appels[0]?.init?.method).toBe("PUT");
    expect(appels[0]?.init?.body).toBe('{"decoupage":null}');
    expect(appels[1]?.init?.body).toBe('{"decoupage":{"redecoupes":[]}}');
    expect(r.ok && r.valeur.job?.kind).toBe("reindex");
  });

  it("découpage propre d'un document : GET, ou null s'il suit la collection", async () => {
    const propre = api(() => json({ decoupage: { params: regles, redecoupes: [] } }));
    const r = await propre.a.decoupageDocument(C, D);
    expect(propre.appels[0]?.url).toBe(`/api/rag/collections/${C}/documents/${D}/decoupage`);
    expect(propre.appels[0]?.init?.method).toBeUndefined();
    expect(r.ok && r.valeur?.params?.methode).toBe("phrase");
    const aucun = api(() => json({ decoupage: null }));
    expect(await aucun.a.decoupageDocument(C, D)).toEqual({ ok: true, valeur: null });
  });

  it("passages indexés : GET paginé", async () => {
    const { a, appels } = api(() => json({ passages: [passageListe], total: 240 }));
    const r = await a.passagesListe(C, D, 50, 200);
    expect(appels[0]?.url).toBe(
      `/api/rag/collections/${C}/documents/${D}/passages/liste?offset=50&limit=200`,
    );
    expect(r.ok && r.valeur.total).toBe(240);
  });

  it("codes stables : regex invalide, sources fermées", async () => {
    const regex = api(() => json({ detail: "Expression invalide", code: "regex_invalide" }, 400));
    expect(await regex.a.apercuDecoupage(C, D, { redecoupes: [] })).toMatchObject({
      ok: false,
      code: "regex_invalide",
    });
    const fermees = api(() => json({ detail: "Sources fermées", code: "sources_fermees" }, 403));
    expect(await fermees.a.passagesListe(C, D, 0, 50)).toMatchObject({ ok: false, code: "sources_fermees" });
  });

  it("réponse hors contrat : jamais une valeur partielle", async () => {
    const { a } = api(() => json({ passages: [{ index: 0 }], total: 1 }));
    expect(await a.passagesListe(C, D, 0, 50)).toEqual({
      ok: false,
      code: null,
      message: "Réponse du serveur inattendue",
    });
  });
});

describe("échecs", () => {
  it("code stable et message du serveur", async () => {
    const { a } = api(() =>
      json({ detail: "Vous avez déjà une collection de ce nom.", code: "nom_deja_pris" }, 409),
    );
    const r = await a.creer("X", "");
    expect(r).toEqual({
      ok: false,
      code: "nom_deja_pris",
      message: "Vous avez déjà une collection de ce nom.",
    });
  });

  it("refus 403 avec code", async () => {
    const { a } = api(() => json({ detail: "Lecture seule", code: "lecture_seule" }, 403));
    const r = await a.supprimer(C);
    expect(r).toMatchObject({ ok: false, code: "lecture_seule" });
  });

  it("réponse hors contrat : échec « inattendu », jamais une valeur partielle", async () => {
    const { a } = api(() => json({ collections: [{ id: "pas-un-uuid" }] }));
    const r = await a.collections();
    expect(r).toEqual({ ok: false, code: null, message: "Réponse du serveur inattendue" });
  });

  it("réseau coupé", async () => {
    const a = creerApiRag(
      new ClientHttp(new GestionnaireSession(), () => Promise.reject(new Error("coupé"))),
    );
    const r = await a.etat();
    expect(r).toMatchObject({ ok: false, code: null, message: "Erreur réseau" });
  });

  it("erreur serveur sans corps lisible", async () => {
    const { a } = api(() => new Response("boom", { status: 500, headers: { "content-type": "text/plain" } }));
    const r = await a.travaux(false);
    expect(r).toMatchObject({ ok: false, message: "Erreur serveur (HTTP 500)" });
  });
});
