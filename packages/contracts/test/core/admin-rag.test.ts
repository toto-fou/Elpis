// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-rag.test.ts — contrats REST de la console du RAG rejoués contre le core TS réel en processus admin (vraie garde : un compte ordinaire et un modérateur sont refusés) ; chaque route du domaine rag-admin est interrogée. */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { config, invalidateConfigCache } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let dossier = "";
let lou = 0;
const cookies: Record<"zoe" | "mo" | "lou", string> = { zoe: "", mo: "", lou: "" };
const avantAcces = process.env["ELPIS_RAG_ACCESS_DIR"];

beforeAll(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-contrat-rag-admin-"));
  process.env["ELPIS_RAG_ACCESS_DIR"] = join(dossier, "temoin");
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "mo", "mdp-de-mo-1", 2);
  lou = await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookies.zoe = await core.connecter("zoe", "mdp-de-zoe-1");
  cookies.mo = await core.connecter("mo", "mdp-de-mo-1");
  cookies.lou = await core.connecter("lou", "mdp-de-lou-1");
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
});

afterAll(async () => {
  await core.fermer();
  if (avantAcces === undefined) delete process.env["ELPIS_RAG_ACCESS_DIR"];
  else process.env["ELPIS_RAG_ACCESS_DIR"] = avantAcces;
  rmSync(dossier, { recursive: true, force: true });
});

describe("contrats REST : console du RAG (core réel, processus admin)", () => {
  it("un compte ordinaire et un modérateur sont refusés sur chaque route, sans session aussi", async () => {
    const id = randomUUID();
    const routes = CONTRATS_REST.filter((r) => r.domaine === "rag-admin");
    expect(routes.length).toBe(12);
    for (const r of routes) {
      const url = r.chemin
        .replace(":collection_id", id)
        .replace(":job_id", id)
        .replace(":user_id", String(lou))
        .replace(":service", "qdrant");
      for (const qui of ["lou", "mo"] as const)
        expect(
          await core.appeler(r.methode, url, { cookie: cookies[qui], corps: r.corps ? {} : undefined }),
          `${cle(r)} ${qui}`,
        ).toEqual({ detail: "Admin required" });
      await core.appeler(r.methode, url, { corps: r.corps ? {} : undefined });
    }
  });

  it("parcours d'un administrateur : chaque route répond selon son contrat", async () => {
    const cookie = cookies.zoe;
    const t = Date.now() / 1000;
    const c = randomUUID();
    await core.base.run(
      "INSERT INTO rag_collections(id, owner_user_id, name, description, created_at, updated_at) VALUES(?, ?, 'Contrats', 'à ne pas montrer', ?, ?)",
      [c, lou, t, t],
    );
    const job = randomUUID();
    await core.base.run(
      "INSERT INTO rag_jobs(id, collection_id, owner_user_id, kind, status, created_at) VALUES(?, ?, ?, 'reindex', 'queued', ?)",
      [job, c, lou, t],
    );
    await core.appeler("GET", "/api/admin/rag/etat", { cookie });
    for (const service of ["embeddings", "reranker", "qdrant"])
      await core.appeler("POST", `/api/admin/rag/essai/${service}`, { cookie, corps: {} });
    expect(
      await core.appeler("GET", "/api/admin/rag/collections?q=lou&tri=taille&limit=5", { cookie }),
    ).toMatchObject({ total: 1, collections: [{ id: c, owner: { username: "lou" } }] });
    await core.appeler("GET", "/api/admin/rag/comptes?q=l", { cookie });
    await core.appeler("PUT", `/api/admin/rag/comptes/${lou}/quota`, { cookie, corps: { storage_mb: 10 } });
    await core.appeler("GET", "/api/admin/rag/comptes?seulement_surcharges=1", { cookie });
    await core.appeler("PUT", `/api/admin/rag/comptes/${lou}/quota`, { cookie, corps: { reset: true } });
    await core.appeler("GET", "/api/admin/rag/reindexation", { cookie });
    await core.appeler("POST", "/api/admin/rag/reindexer", { cookie, corps: {} });
    expect(await core.appeler("GET", "/api/admin/rag/travaux?actifs=1", { cookie })).toMatchObject({
      jobs: [{ id: job, collection_name: "Contrats", owner: { username: "lou" } }],
    });
    await core.appeler("POST", `/api/admin/rag/travaux/${job}/suspendre`, { cookie });
    await core.appeler("POST", `/api/admin/rag/travaux/${job}/reprendre`, { cookie });
    await core.appeler("POST", `/api/admin/rag/travaux/${job}/annuler`, { cookie });
    await core.appeler("DELETE", `/api/admin/rag/collections/${c}`, { cookie, corps: { name: "faux" } });
    await core.appeler("DELETE", `/api/admin/rag/collections/${c}`, { cookie, corps: { name: "Contrats" } });
    await core.appeler("POST", "/api/admin/rag/essai/inconnu", { cookie, corps: {} });
  });

  it("toutes les routes du domaine rag-admin ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "rag-admin").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
