// SPDX-License-Identifier: MIT
/** apps/core/test/rag/routes-droits.test.ts — matrice des droits sur chaque route RAG (SQLite et PostgreSQL) : propriétaire, lecteur avec et sans ouverture des sources, autre compte, administrateur sur une collection privée d'autrui, compte sans droit RAG ; 404 jamais 403 pour une collection invisible. */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { setUserGroups } from "@elpis/auth";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { appliquerPublication, invaliderAccesRag } from "../../src/rag/acces";
import { creerCollection, creerCompte } from "./aides-indexation";
import { demarrerEnvironnement, indexerDirect, json, MOTEURS, ouvrirBanc } from "./aides-routes";
import type { Banc, Environnement } from "./aides-routes";

let env: Environnement;

beforeAll(async () => {
  env = await demarrerEnvironnement();
});

afterAll(async () => {
  await env.arreter();
});

type Acteur = "proprietaire" | "lecteur" | "lecteur_sources" | "autre" | "admin" | "sans_droit";

interface Cas {
  readonly nom: string;
  readonly methode: string;
  /** Chemin avec `{c}` (collection) et `{d}` (document). */
  readonly chemin: string;
  readonly corps?: (b: Banc) => unknown;
  readonly televerser?: boolean;
  readonly attendu: Record<Acteur, number>;
  readonly codes?: Partial<Record<Acteur, string>>;
}

const SOUS_LES_DROITS = { autre: 404, admin: 404, sans_droit: 403 } as const;
const PUBLICATION = (b: Banc): unknown => ({
  visibility: "groups",
  group_ids: [b.groupe.A],
  allow_source_open: false,
});

const CAS: readonly Cas[] = [
  {
    nom: "lire la collection",
    methode: "GET",
    chemin: "/api/rag/collections/{c}",
    attendu: { proprietaire: 200, lecteur: 200, lecteur_sources: 200, ...SOUS_LES_DROITS },
  },
  {
    nom: "modifier la collection",
    methode: "PATCH",
    chemin: "/api/rag/collections/{c}",
    corps: () => ({ description: "Nouvelle description" }),
    attendu: { proprietaire: 200, lecteur: 403, lecteur_sources: 403, ...SOUS_LES_DROITS },
    codes: { lecteur: "lecture_seule", lecteur_sources: "lecture_seule" },
  },
  {
    nom: "publier",
    methode: "PUT",
    chemin: "/api/rag/collections/{c}/publication",
    corps: PUBLICATION,
    attendu: { proprietaire: 200, lecteur: 403, lecteur_sources: 403, ...SOUS_LES_DROITS },
    codes: { lecteur: "lecture_seule" },
  },
  {
    nom: "masquer",
    methode: "PUT",
    chemin: "/api/rag/collections/{c}/masquage",
    corps: () => ({ hidden: true }),
    attendu: { proprietaire: 400, lecteur: 200, lecteur_sources: 200, ...SOUS_LES_DROITS },
    codes: { proprietaire: "non_masquable" },
  },
  {
    nom: "lister les documents",
    methode: "GET",
    chemin: "/api/rag/collections/{c}/documents",
    attendu: { proprietaire: 200, lecteur: 200, lecteur_sources: 200, ...SOUS_LES_DROITS },
  },
  {
    nom: "lire un document",
    methode: "GET",
    chemin: "/api/rag/collections/{c}/documents/{d}",
    attendu: { proprietaire: 200, lecteur: 200, lecteur_sources: 200, ...SOUS_LES_DROITS },
  },
  {
    nom: "déposer des fichiers",
    methode: "POST",
    chemin: "/api/rag/collections/{c}/documents",
    televerser: true,
    attendu: { proprietaire: 200, lecteur: 403, lecteur_sources: 403, ...SOUS_LES_DROITS },
    codes: { lecteur: "lecture_seule" },
  },
  {
    nom: "importer depuis le bac",
    methode: "POST",
    chemin: "/api/rag/collections/{c}/import-sandbox",
    corps: () => ({ paths: ["/work/a.pdf"] }),
    attendu: { proprietaire: 503, lecteur: 403, lecteur_sources: 403, ...SOUS_LES_DROITS },
    codes: { proprietaire: "sandbox_indisponible", lecteur: "lecture_seule" },
  },
  {
    nom: "réindexer",
    methode: "POST",
    chemin: "/api/rag/collections/{c}/reindexer",
    corps: () => ({}),
    attendu: { proprietaire: 200, lecteur: 403, lecteur_sources: 403, ...SOUS_LES_DROITS },
    codes: { lecteur: "lecture_seule" },
  },
  {
    nom: "chercher",
    methode: "POST",
    chemin: "/api/rag/collections/{c}/recherche",
    corps: () => ({ requete: "contrat" }),
    attendu: { proprietaire: 200, lecteur: 200, lecteur_sources: 200, ...SOUS_LES_DROITS },
  },
  {
    nom: "fenêtre de passages (ramenée à un passage sans le droit complet)",
    methode: "GET",
    chemin: "/api/rag/collections/{c}/documents/{d}/passages?autour=1&n=1",
    attendu: { proprietaire: 200, lecteur: 200, lecteur_sources: 200, ...SOUS_LES_DROITS },
  },
  {
    nom: "passages sans position précise",
    methode: "GET",
    chemin: "/api/rag/collections/{c}/documents/{d}/passages",
    attendu: { proprietaire: 200, lecteur: 403, lecteur_sources: 200, ...SOUS_LES_DROITS },
    codes: { lecteur: "sources_fermees" },
  },
  {
    nom: "passage précis",
    methode: "GET",
    chemin: "/api/rag/collections/{c}/documents/{d}/passages?autour=1",
    attendu: { proprietaire: 200, lecteur: 200, lecteur_sources: 200, ...SOUS_LES_DROITS },
  },
  {
    nom: "page rendue",
    methode: "GET",
    chemin: "/api/rag/collections/{c}/documents/{d}/pages/1",
    attendu: { proprietaire: 200, lecteur: 403, lecteur_sources: 200, ...SOUS_LES_DROITS },
    codes: { lecteur: "sources_fermees" },
  },
  {
    nom: "localiser un passage",
    methode: "POST",
    chemin: "/api/rag/collections/{c}/documents/{d}/localiser",
    corps: () => ({ texte: "Le contrat se renouvelle" }),
    attendu: { proprietaire: 200, lecteur: 403, lecteur_sources: 200, ...SOUS_LES_DROITS },
    codes: { lecteur: "sources_fermees" },
  },
  {
    nom: "télécharger l'original",
    methode: "GET",
    chemin: "/api/rag/collections/{c}/documents/{d}/original",
    attendu: { proprietaire: 200, lecteur: 403, lecteur_sources: 200, ...SOUS_LES_DROITS },
    codes: { lecteur: "sources_fermees" },
  },
  {
    nom: "supprimer un document",
    methode: "DELETE",
    chemin: "/api/rag/collections/{c}/documents/{d}",
    attendu: { proprietaire: 200, lecteur: 403, lecteur_sources: 403, ...SOUS_LES_DROITS },
    codes: { lecteur: "lecture_seule" },
  },
  {
    nom: "vider la collection",
    methode: "POST",
    chemin: "/api/rag/collections/{c}/vider",
    attendu: { proprietaire: 200, lecteur: 403, lecteur_sources: 403, ...SOUS_LES_DROITS },
    codes: { lecteur: "lecture_seule" },
  },
  {
    nom: "supprimer la collection",
    methode: "DELETE",
    chemin: "/api/rag/collections/{c}",
    attendu: { proprietaire: 200, lecteur: 403, lecteur_sources: 403, ...SOUS_LES_DROITS },
    codes: { lecteur: "lecture_seule" },
  },
];

describe.each(MOTEURS)("droits des routes RAG (%s)", (moteur) => {
  let b: Banc;
  /** Collection de alice publiée au groupe A, sources fermées puis ouvertes. */
  let fermee: { col: string; doc: string };
  let ouverte: { col: string; doc: string };
  let privee: { col: string; doc: string };

  async function preparer(uid: number, nom: string, ouvertes: boolean, publiee: boolean) {
    const col = await creerCollection(b.base, uid, nom);
    const doc = await indexerDirect(b, col, "contrat.pdf", [
      { texte: "Le contrat se renouvelle chaque année par tacite reconduction." },
      { texte: "La résiliation exige un préavis de trois mois." },
      { texte: "Les tarifs sont révisés selon l'indice annuel." },
    ]);
    const dossier = join(env.magasin, String(uid), col, "sources");
    mkdirSync(dossier, { recursive: true });
    writeFileSync(join(dossier, `${doc}.pdf`), "%PDF-1.4 faux document");
    if (publiee)
      await appliquerPublication(b.base, uid, col, {
        visibility: "groups",
        group_ids: [b.groupe.A],
        allow_source_open: ouvertes,
      });
    return { col, doc };
  }

  beforeEach(async () => {
    b = await ouvrirBanc(moteur, env);
    fermee = await preparer(b.id.alice, "Contrats fermés", false, true);
    ouverte = await preparer(b.id.alice, "Contrats ouverts", true, true);
    privee = await preparer(b.id.alice, "Notes privées", false, false);
  });

  afterEach(async () => {
    await b.fermer();
  });

  /** Le propriétaire passe en dernier : une suppression ne prive pas les autres de leur essai. */
  function acteurs(): [Acteur, { uid: number; ref: () => { col: string; doc: string } }][] {
    return [
      ["lecteur", { uid: b.id.bob, ref: () => fermee }],
      ["lecteur_sources", { uid: b.id.bob, ref: () => ouverte }],
      ["autre", { uid: b.id.carol, ref: () => fermee }],
      ["admin", { uid: b.id.admin, ref: () => privee }],
      ["sans_droit", { uid: b.id.dave, ref: () => fermee }],
      ["proprietaire", { uid: b.id.alice, ref: () => fermee }],
    ];
  }

  for (const cas of CAS) {
    it(`${cas.nom} : ${cas.methode} ${cas.chemin}`, async () => {
      // Seul le compte « sans droit » est privé du RAG : les groupes autorisés sont ceux d'alice et de bob.
      env.ecrireConfig({ groups: [b.groupe.A, b.groupe.B] });
      for (const [acteur, { uid, ref }] of acteurs()) {
        const { col, doc } = ref();
        const url = cas.chemin.replace("{c}", col).replace("{d}", doc);
        const r = cas.televerser
          ? await b.televerser(uid, url, [{ nom: "nouveau.txt", contenu: "Un nouveau fichier." }])
          : await b.appeler(uid, cas.methode, url, cas.corps?.(b));
        expect(r.statut, `${acteur} : ${cas.methode} ${url} → ${r.brut.toString("utf8").slice(0, 200)}`).toBe(
          cas.attendu[acteur],
        );
        const attendu = cas.codes?.[acteur];
        if (attendu !== undefined) expect(json<{ code: string }>(r).code, acteur).toBe(attendu);
        if (r.statut === 404) expect(json<{ code: string }>(r).code, acteur).toMatch(/introuvable/u);
      }
    });
  }

  it("un compte sans droit RAG reçoit 403 rag_interdit partout, même sur sa propre collection", async () => {
    const maCol = await creerCollection(b.base, b.id.dave, "Ma collection");
    env.ecrireConfig({ groups: [b.groupe.A] });
    for (const [methode, url, corps] of [
      ["GET", "/api/rag/collections", undefined],
      ["POST", "/api/rag/collections", { name: "Autre" }],
      ["GET", `/api/rag/collections/${maCol}`, undefined],
      ["PATCH", `/api/rag/collections/${maCol}`, { description: "x" }],
      ["DELETE", `/api/rag/collections/${maCol}`, undefined],
      ["GET", "/api/rag/groupes-publication", undefined],
      ["GET", "/api/rag/travaux", undefined],
      ["POST", `/api/rag/collections/${maCol}/recherche`, { requete: "x" }],
    ] as const) {
      const r = await b.appeler(b.id.dave, methode, url, corps);
      expect([r.statut, json<{ code: string }>(r).code], `${methode} ${url}`).toEqual([403, "rag_interdit"]);
    }
    const etat = await b.appeler(b.id.dave, "GET", "/api/rag/etat");
    expect(etat.statut).toBe(200);
    expect(json<{ allowed: boolean; usable: boolean; reason: { code: string } }>(etat)).toMatchObject({
      allowed: false,
      usable: false,
      reason: { code: "rag_interdit" },
    });
  });

  it("sans session : 401 partout ; identifiants mal formés : 404 avant toute requête", async () => {
    expect((await b.appeler(null, "GET", "/api/rag/collections")).statut).toBe(401);
    expect((await b.appeler(null, "GET", "/api/rag/etat")).statut).toBe(401);
    for (const url of [
      "/api/rag/collections/pas-un-uuid",
      "/api/rag/collections/..%2F..%2Fetc",
      `/api/rag/collections/${fermee.col.toUpperCase()}`,
      `/api/rag/collections/${fermee.col}/documents/xyz/passages`,
      `/api/rag/collections/${fermee.col}/documents/${fermee.col}%00/original`,
    ]) {
      const r = await b.appeler(b.id.alice, "GET", url);
      expect(r.statut, url).toBe(404);
    }
    const t = await b.appeler(b.id.alice, "POST", "/api/rag/travaux/pas-un-uuid/annuler");
    expect([t.statut, json<{ code: string }>(t).code]).toEqual([404, "travail_introuvable"]);
  });

  it("l'administrateur n'a aucun accès implicite : ni liste, ni lecture, ni suppression, ni publication d'une collection privée", async () => {
    const liste = json<{ collections: { id: string }[] }>(
      await b.appeler(b.id.admin, "GET", "/api/rag/collections"),
    );
    expect(liste.collections).toEqual([]);
    for (const [methode, url, corps] of [
      ["GET", `/api/rag/collections/${privee.col}`, undefined],
      ["DELETE", `/api/rag/collections/${privee.col}`, undefined],
      [
        "PUT",
        `/api/rag/collections/${privee.col}/publication`,
        { visibility: "all", group_ids: [], allow_source_open: true },
      ],
      ["POST", `/api/rag/collections/${privee.col}/recherche`, { requete: "contrat" }],
      ["GET", `/api/rag/collections/${privee.col}/documents/${privee.doc}/original`, undefined],
    ] as const) {
      const r = await b.appeler(b.id.admin, methode, url, corps);
      expect(r.statut, `${methode} ${url}`).toBe(404);
    }
    const encore = await b.base.get("SELECT id FROM rag_collections WHERE id=?", [privee.col]);
    expect(encore).toBeDefined();
  });

  it("un compte qui perd l'accès (retrait du groupe) reçoit 404 aussitôt", async () => {
    expect((await b.appeler(b.id.bob, "GET", `/api/rag/collections/${fermee.col}`)).statut).toBe(200);
    await setUserGroups(b.base, b.id.bob, []);
    invaliderAccesRag(b.base);
    expect((await b.appeler(b.id.bob, "GET", `/api/rag/collections/${fermee.col}`)).statut).toBe(404);
    expect(
      json<{ collections: unknown[] }>(await b.appeler(b.id.bob, "GET", "/api/rag/collections")).collections,
    ).toEqual([]);
  });

  it("créer un compte de plus ne donne rien : une collection d'un autre groupe reste invisible", async () => {
    const extra = await creerCompte(b.base, "extra");
    const r = await b.appeler(extra, "GET", `/api/rag/collections/${fermee.col}`);
    expect([r.statut, json<{ code: string }>(r).code]).toEqual([404, "collection_introuvable"]);
  });
});
