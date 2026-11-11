// SPDX-License-Identifier: MIT
// packages/navigateur/test/securite-jeton-service.test.ts — le client présente le jeton du service navigateur (variable, sinon fichier) et rien sans jeton.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { enTetesServiceNavigateur, jetonServiceNavigateur } from "../src/client";

describe("jeton du service navigateur côté client", () => {
  afterEach(() => {
    delete process.env["BROWSER_SERVICE_TOKEN"];
    delete process.env["BROWSER_SERVICE_TOKEN_FILE"];
  });

  it("variable d'abord, puis première ligne du fichier ; en-tête Bearer ajouté aux autres", () => {
    const d = mkdtempSync(path.join(tmpdir(), "jeton-"));
    const f = path.join(d, ".browser_service_token");
    writeFileSync(f, "du-fichier\nautre\n");
    process.env["BROWSER_SERVICE_TOKEN_FILE"] = f;
    expect(jetonServiceNavigateur(1e12)).toBe("du-fichier");
    expect(enTetesServiceNavigateur({ "content-type": "application/json" })).toEqual({
      "content-type": "application/json",
      authorization: "Bearer du-fichier",
    });
    process.env["BROWSER_SERVICE_TOKEN"] = "  direct  ";
    expect(jetonServiceNavigateur()).toBe("direct");
    rmSync(d, { recursive: true, force: true });
  });

  it("sans jeton : aucun en-tête d'autorisation", () => {
    process.env["BROWSER_SERVICE_TOKEN_FILE"] = "/inexistant/.browser_service_token";
    expect(jetonServiceNavigateur(2e12)).toBe("");
    expect(enTetesServiceNavigateur()).toEqual({});
  });
});
