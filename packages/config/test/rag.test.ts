// SPDX-License-Identifier: MIT
/** packages/config/test/rag.test.ts — section `rag` de config.json : défauts, bornes, adresses, groupes, quotas, magasin, relecture à chaud. */
import { DOSSIER_TEST } from "./environnement";

import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { config, configRag, lireQuotasRag, QUOTAS_RAG_DEFAUT, writeConfigJson } from "../src/index";
import { groupesRag, urlHttp } from "../src/rag";

const avantEnv = process.env["RAG_STORE_DIR"];

afterEach(() => {
  if (avantEnv === undefined) delete process.env["RAG_STORE_DIR"];
  else process.env["RAG_STORE_DIR"] = avantEnv;
});

describe("configRag", () => {
  it("défauts : Qdrant local, embeddings non configurés, reranker éteint, tous les comptes, quotas du plan", () => {
    expect(configRag({})).toEqual({
      store_dir: path.join(path.dirname(config.DB_PATH), "rag"),
      qdrant_url: "http://127.0.0.1:6333",
      embed: { url: "", model: "bge-m3", api_key: "", batch: 32, timeout_s: 60 },
      reranker: { enabled: false, url: "", model: "bge-reranker-v2-m3" },
      ocr: { url: "", model: "", api_key: "", timeout_s: 180, max_side_px: 1280, max_tokens: 8192 },
      groups: [],
      quotas: { storage_mb: 2048, collections: 10, file_mb: 200, docs_per_collection: 2000 },
      indexation: { concurrence: 2, par_compte: 1 },
    });
    expect(configRag(null)).toEqual(configRag({ rag: "x" }));
  });

  it("valeurs lues, bornées ; type faux ou hors bornes : le défaut", () => {
    const c = configRag({
      rag: {
        qdrant_url: "https://qdrant.lan:6333/",
        embed: { url: "http://10.0.0.5:8081/v1/", model: " e5 ", api_key: "k", batch: 0, timeout_s: "30" },
        reranker: { enabled: "true", url: "ftp://x", model: "" },
        ocr: {
          url: "http://vision.lan:8090/",
          model: " ocr ",
          api_key: "o",
          timeout_s: 4,
          max_side_px: 2048,
          max_tokens: "1",
        },
        groups: [3, "4", 3, -1, 2.5, 7],
        quotas: { storage_mb: 512, collections: -1, file_mb: 50.5, docs_per_collection: true },
        indexation: { concurrence: 4, par_compte: 9 },
      },
    });
    expect(c.qdrant_url).toBe("https://qdrant.lan:6333");
    expect(c.embed).toEqual({
      url: "http://10.0.0.5:8081/v1",
      model: "e5",
      api_key: "k",
      batch: 32,
      timeout_s: 60,
    });
    expect(c.reranker).toEqual({ enabled: false, url: "", model: "bge-reranker-v2-m3" });
    expect(c.ocr).toEqual({
      url: "http://vision.lan:8090",
      model: "ocr",
      api_key: "o",
      timeout_s: 180,
      max_side_px: 2048,
      max_tokens: 8192,
    });
    expect(c.groups).toEqual([3, 7]);
    expect(c.quotas).toEqual({ storage_mb: 512, collections: 10, file_mb: 200, docs_per_collection: 2000 });
    expect(c.indexation).toEqual({ concurrence: 4, par_compte: 4 });
  });

  it("adresses : http(s) seulement, `/` final retiré", () => {
    expect(urlHttp("http://a:1///", "d")).toBe("http://a:1");
    for (const v of ["javascript:alert(1)", "file:///etc/passwd", "a b", "", 42, "http://"])
      expect(urlHttp(v, "d"), String(v)).toBe("d");
  });

  it("groupes : entiers positifs dédoublonnés, 200 premiers éléments lus", () => {
    expect(groupesRag(Array.from({ length: 300 }, (_, i) => i + 1))).toHaveLength(200);
    expect(groupesRag("1,2")).toEqual([]);
  });

  it("quotas d'un compte : surcharge clé par clé, le reste vient des défauts de l'instance", () => {
    const instance = lireQuotasRag({ storage_mb: 4096 });
    expect(lireQuotasRag({ collections: 3, inconnu: 1 }, instance)).toEqual({
      ...QUOTAS_RAG_DEFAUT,
      storage_mb: 4096,
      collections: 3,
    });
    expect(lireQuotasRag({ storage_mb: 10_000_001 }, instance).storage_mb).toBe(4096);
    expect(lireQuotasRag({ file_mb: 0 }).file_mb).toBe(0);
  });

  it("magasin : `RAG_STORE_DIR` > `rag.store_dir` (relatif à la racine) > dossier de la base ; racine du disque refusée", () => {
    expect(configRag({ rag: { store_dir: "/srv/rag" } }).store_dir).toBe("/srv/rag");
    expect(configRag({ rag: { store_dir: "donnees/rag" } }).store_dir).toBe(
      path.join(config.PROJECT_ROOT, "donnees", "rag"),
    );
    const defaut = path.join(path.dirname(config.DB_PATH), "rag");
    expect(configRag({ rag: { store_dir: "/" } }).store_dir).toBe(defaut);
    expect(configRag({ rag: { store_dir: "a\0b" } }).store_dir).toBe(defaut);
    process.env["RAG_STORE_DIR"] = "/var/lib/elpis/rag";
    expect(configRag({ rag: { store_dir: "/srv/rag" } }).store_dir).toBe("/var/lib/elpis/rag");
  });

  it("relue à chaque appel depuis config.json", () => {
    expect(config.CONFIG_JSON_PATH.startsWith(DOSSIER_TEST)).toBe(true);
    writeConfigJson({ rag: { groups: [5] } });
    expect(configRag().groups).toEqual([5]);
    writeConfigJson({ rag: { groups: [] } });
    expect(configRag().groups).toEqual([]);
  });
});
