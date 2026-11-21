// SPDX-License-Identifier: MIT
/** apps/core/test/rag/jeton-service.test.ts — jeton du service RAG : `RAG_SERVICE_TOKEN` > `rag.service_token` > fichier `RAG_SERVICE_TOKEN_FILE` (celui de l'extracteur) > `user_db/.rag_service_token`. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getServiceToken } from "../../src/rag/client";

let dossier = "";
let restaurer: () => void = () => undefined;

beforeEach(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-jeton-rag-"));
  mkdirSync(path.join(dossier, "user_db"));
  writeFileSync(path.join(dossier, "user_db", ".rag_service_token"), "jeton-par-defaut\n");
  writeFileSync(path.join(dossier, "config.json"), "{}");
  vi.stubEnv("RAG_SERVICE_TOKEN", "");
  vi.stubEnv("RAG_SERVICE_TOKEN_FILE", "");
  restaurer = surchargerConfig({
    CONFIG_JSON_PATH: path.join(dossier, "config.json"),
    PROJECT_ROOT: dossier,
  });
  invalidateConfigCache();
});

afterEach(() => {
  restaurer();
  invalidateConfigCache();
  vi.unstubAllEnvs();
  rmSync(dossier, { recursive: true, force: true });
});

describe("jeton du service RAG", () => {
  it("fichier nommé par RAG_SERVICE_TOKEN_FILE avant le chemin par défaut, après l'environnement et config.json", () => {
    expect(getServiceToken()).toBe("jeton-par-defaut");
    const fichier = path.join(dossier, "rag.token");
    writeFileSync(fichier, " jeton-du-fichier \n");
    vi.stubEnv("RAG_SERVICE_TOKEN_FILE", fichier);
    expect(getServiceToken()).toBe("jeton-du-fichier");
    vi.stubEnv("RAG_SERVICE_TOKEN_FILE", path.join(dossier, "absent.token"));
    expect(getServiceToken()).toBe("");
    writeFileSync(
      path.join(dossier, "config.json"),
      JSON.stringify({ rag: { service_token: "jeton-config" } }),
    );
    invalidateConfigCache();
    expect(getServiceToken()).toBe("jeton-config");
    vi.stubEnv("RAG_SERVICE_TOKEN", "jeton-env");
    expect(getServiceToken()).toBe("jeton-env");
  });
});
