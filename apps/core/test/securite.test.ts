// SPDX-License-Identifier: MIT
/** apps/core/test/securite.test.ts — le core chiffre avec la clé à côté de la base, comme le Python. */
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { surchargerConfig } from "@elpis/config";
import { brancherJournal as brancherJournalMcp } from "@elpis/mcp";
import { brancherJournal, decrypt, encrypt } from "@elpis/securite";

import { configurerSecuriteDuCore } from "../src/securite";

const dossier = mkdtempSync(join(tmpdir(), "elpis-securite-"));
afterAll(() => rmSync(dossier, { recursive: true, force: true }));

describe("chiffrement du core", () => {
  it("crée la clé à côté de la base (0600) et relit ce qu'il chiffre", () => {
    const restaurer = surchargerConfig({ DB_PATH: join(dossier, "user_db", "app.db") });
    try {
      configurerSecuriteDuCore({});
      const jeton = encrypt("secret é");
      expect(decrypt(jeton)).toBe("secret é");
      const cle = join(dossier, "user_db", ".encryption_key");
      expect(existsSync(cle)).toBe(true);
      expect(statSync(cle).mode & 0o777).toBe(0o600);
      expect(readFileSync(cle, "utf-8").trim()).toHaveLength(44);
    } finally {
      restaurer();
    }
  });

  it("la clé d'environnement prime sur le fichier", () => {
    const restaurer = surchargerConfig({ DB_PATH: join(dossier, "autre", "app.db") });
    try {
      configurerSecuriteDuCore({ APP_ENCRYPTION_KEY: "une phrase secrète quelconque" });
      expect(decrypt(encrypt("x"))).toBe("x");
      expect(existsSync(join(dossier, "autre", ".encryption_key"))).toBe(false);
    } finally {
      restaurer();
    }
  });
});

describe("journal des paquets", () => {
  it("un seul branchement : celui de @elpis/securite sert aussi @elpis/mcp", () => {
    expect(brancherJournalMcp).toBe(brancherJournal);
  });
});
