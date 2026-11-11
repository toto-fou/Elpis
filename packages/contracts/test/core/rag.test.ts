// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/rag.test.ts — contrats REST du RAG intégré rejoués contre le core TS réel (composition main) : chaque route du domaine `rag` est interrogée et sa réponse, succès ou erreur, respecte le contrat. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config, invalidateConfigCache } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseEtatRag } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let dossier = "";
const avantAcces = process.env["ELPIS_RAG_ACCESS_DIR"];

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-contrat-rag-"));
  process.env["ELPIS_RAG_ACCESS_DIR"] = join(dossier, "temoin");
  core = await demarrerCore();
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
});

afterAll(async () => {
  await core.fermer();
  if (avantAcces === undefined) delete process.env["ELPIS_RAG_ACCESS_DIR"];
  else process.env["ELPIS_RAG_ACCESS_DIR"] = avantAcces;
  rmSync(dossier, { recursive: true, force: true });
});

function configurerRag(): void {
  writeFileSync(
    config.CONFIG_JSON_PATH,
    JSON.stringify({
      rag: {
        store_dir: join(dossier, "magasin"),
        service_url: "http://127.0.0.1:9",
        qdrant_url: "http://127.0.0.1:9",
        embed: { url: "http://127.0.0.1:9", model: "m1", timeout_s: 1 },
      },
    }),
  );
  invalidateConfigCache();
}

describe("contrats REST : RAG intégré (core réel)", () => {
  it("sans session : refusé ; RAG non configuré : l'état dit pourquoi, la liste est vide", async () => {
    await core.appeler("GET", "/api/rag/collections");
    await core.appeler("GET", "/api/rag/etat");
    const etat = schemaReponseEtatRag.parse(await core.appeler("GET", "/api/rag/etat", { cookie }));
    expect(etat).toMatchObject({
      allowed: true,
      usable: false,
      reason: { code: "embeddings_non_configures" },
    });
    expect(await core.appeler("GET", "/api/rag/collections", { cookie })).toEqual({ collections: [] });
    const refus = await core.appeler("POST", "/api/rag/collections", { cookie, corps: { name: "Contrats" } });
    expect(refus).toMatchObject({ code: "rag_desactive" });
  });

  it("parcours d'une collection : chaque route répond selon son contrat", async () => {
    configurerRag();
    const creee = (await core.appeler("POST", "/api/rag/collections", {
      cookie,
      corps: { name: "Contrats", description: "Contrats fournisseurs" },
    })) as { collection: { id: string } };
    const id = creee.collection.id;
    const racine = `/api/rag/collections/${id}`;
    await core.appeler("GET", "/api/rag/collections", { cookie });
    await core.appeler("GET", racine, { cookie });
    await core.appeler("PATCH", racine, { cookie, corps: { description: "Mise à jour" } });
    await core.appeler("GET", "/api/rag/groupes-publication", { cookie });
    await core.appeler("PUT", `${racine}/publication`, {
      cookie,
      corps: { visibility: "all", group_ids: [], allow_source_open: false },
    });
    await core.appeler("PUT", `${racine}/publication`, {
      cookie,
      corps: { visibility: "private", group_ids: [], allow_source_open: false },
    });
    await core.appeler("PUT", `${racine}/masquage`, { cookie, corps: { hidden: true } });
    const depot = (await core.televerser(`${racine}/documents`, {
      cookie,
      fichier: Buffer.from("Le contrat se renouvelle."),
      nom: "note.txt",
      type: "text/plain",
    })) as { results: { document: { id: string } }[]; job: { id: string } };
    const doc = depot.results[0]?.document.id ?? "";
    await core.appeler("GET", `${racine}/documents?status=pending&limit=10`, { cookie });
    await core.appeler("GET", `${racine}/documents/${doc}`, { cookie });
    await core.appeler("POST", `${racine}/import-sandbox`, { cookie, corps: { paths: ["/work/a.txt"] } });
    await core.appeler("GET", `${racine}/documents/${doc}/passages?autour=0`, { cookie });
    await core.appeler("POST", `${racine}/documents/${doc}/localiser`, {
      cookie,
      corps: { texte: "contrat" },
    });
    await core.appeler("POST", `${racine}/recherche`, {
      cookie,
      corps: { requete: "contrat", mode: "mots" },
    });
    await core.appeler("POST", `${racine}/reindexer`, { cookie, corps: {} });
    await core.appeler("GET", "/api/rag/travaux?actifs=1", { cookie });
    await core.appeler("POST", `/api/rag/travaux/${depot.job.id}/suspendre`, { cookie });
    await core.appeler("POST", `/api/rag/travaux/${depot.job.id}/reprendre`, { cookie });
    await core.appeler("POST", `/api/rag/travaux/${depot.job.id}/annuler`, { cookie });
    await core.appeler("DELETE", `${racine}/documents/${doc}`, { cookie });
    await core.appeler("POST", `${racine}/vider`, { cookie });
    await core.appeler("DELETE", racine, { cookie });
    await core.appeler("GET", racine, { cookie });
  });

  it("toutes les routes du domaine rag ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "rag").map(cle);
    expect(attendues.length).toBe(23);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
