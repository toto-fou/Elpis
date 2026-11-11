// SPDX-License-Identifier: MIT
/** apps/core/test/rag/routes-bout-en-bout.test.ts — parcours complet par les routes (SQLite et PostgreSQL) avec le vrai travailleur d'indexation : dépôt multipart, indexation, recherche, fenêtre de passages, partage à un groupe, suppression d'un document. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TravailleurRag } from "../../src/rag/travailleur";
import type { ReglagesTravailleurRag } from "../../src/rag/travailleur";
import { jusqua } from "./aides-indexation";
import { demarrerEnvironnement, json, MOTEURS, ouvrirBanc } from "./aides-routes";
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

let env: Environnement;

beforeAll(async () => {
  env = await demarrerEnvironnement();
});

afterAll(async () => {
  await env.arreter();
});

interface Doc {
  id: string;
  rel_path: string;
  status: string;
  chunk_count: number;
}

describe.each(MOTEURS)("parcours RAG par les routes (%s)", (moteur) => {
  let b: Banc;
  let arret: AbortController;
  let boucle: Promise<void>;

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
  });

  afterEach(async () => {
    arret.abort();
    await (b.service.travailleur as TravailleurRag).arreter();
    await boucle;
    await b.fermer();
  });

  it("dépôt, indexation, recherche, fenêtre, partage, suppression", async () => {
    const creation = await b.appeler(b.id.alice, "POST", "/api/rag/collections", { name: "Contrats" });
    const col = json<{ collection: { id: string } }>(creation).collection.id;
    const url = (suite = ""): string => `/api/rag/collections/${col}${suite}`;

    const depot = await b.televerser(b.id.alice, url("/documents"), [
      {
        nom: "droit/contrat.txt",
        contenu:
          "# Durée\n\nLe contrat se renouvelle par tacite reconduction chaque année.\n\n# Fin\n\nLa résiliation exige un préavis de trois mois par lettre recommandée.",
      },
      {
        nom: "finance/tarifs.txt",
        contenu: "# Tarifs\n\nLes tarifs sont révisés selon l'indice annuel de référence.",
      },
    ]);
    expect(depot.statut, JSON.stringify(depot.corps)).toBe(200);

    await jusqua(async () => {
      const r = json<{ jobs: unknown[] }>(await b.appeler(b.id.alice, "GET", "/api/rag/travaux?actifs=1"));
      return r.jobs.length === 0;
    }, "travaux terminés");
    const liste = json<{ documents: Doc[] }>(await b.appeler(b.id.alice, "GET", url("/documents"))).documents;
    expect(liste.map((d) => [d.rel_path, d.status])).toEqual([
      ["droit/contrat.txt", "ready"],
      ["finance/tarifs.txt", "ready"],
    ]);
    expect(liste.every((d) => d.chunk_count > 0)).toBe(true);
    const collection = json<{
      collection: { doc_count: number; chunk_count: number; status: string; embed_model: string };
    }>(await b.appeler(b.id.alice, "GET", url())).collection;
    expect(collection).toMatchObject({ doc_count: 2, status: "ready", embed_model: "m1" });
    expect(collection.chunk_count).toBe(liste.reduce((s, d) => s + d.chunk_count, 0));
    expect(b.evenements.some((e) => (e as { type: string }).type === "rag_job")).toBe(true);

    const recherche = json<{
      mode: string;
      passages: { text: string; document_name: string; chunk_index: number; document_id: string }[];
      map: { document_name: string }[];
    }>(
      await b.appeler(b.id.alice, "POST", url("/recherche"), {
        requete: "préavis résiliation",
        mode: "mots",
      }),
    );
    expect(recherche.passages[0]).toMatchObject({ document_name: "contrat.txt" });
    expect(recherche.passages[0]?.text).toContain("préavis de trois mois");
    expect(recherche.map.map((d) => d.document_name)).toContain("contrat.txt");

    const contrat = liste[0] as Doc;
    const fenetre = json<{ passages: { chunk_index: number }[]; chunk_count: number }>(
      await b.appeler(b.id.alice, "GET", url(`/documents/${contrat.id}/passages?autour=0&n=5`)),
    );
    expect(fenetre.passages.map((p) => p.chunk_index)).toEqual(
      Array.from({ length: contrat.chunk_count }, (_, i) => i),
    );

    await b.appeler(b.id.alice, "PUT", url("/publication"), {
      visibility: "groups",
      group_ids: [b.groupe.A],
      allow_source_open: false,
    });
    const chezBob = json<{ passages: { text: string }[] }>(
      await b.appeler(b.id.bob, "POST", url("/recherche"), { requete: "tacite reconduction", mode: "mots" }),
    );
    expect(chezBob.passages[0]?.text).toContain("tacite reconduction");
    const fermee = await b.appeler(b.id.bob, "GET", url(`/documents/${contrat.id}/passages`));
    expect(fermee.statut).toBe(403);
    expect((await b.appeler(b.id.carol, "POST", url("/recherche"), { requete: "tacite" })).statut).toBe(404);

    expect((await b.appeler(b.id.alice, "DELETE", url(`/documents/${contrat.id}`))).statut).toBe(200);
    const apres = json<{ passages: { document_id: string }[] }>(
      await b.appeler(b.id.alice, "POST", url("/recherche"), {
        requete: "préavis résiliation",
        mode: "mots",
      }),
    );
    expect(apres.passages.some((p) => p.document_id === contrat.id)).toBe(false);
    expect(
      json<{ collection: { doc_count: number } }>(await b.appeler(b.id.alice, "GET", url())).collection
        .doc_count,
    ).toBe(1);
  }, 30_000);
});
