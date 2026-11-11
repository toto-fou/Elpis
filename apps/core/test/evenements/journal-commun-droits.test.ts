// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/journal-commun-droits.test.ts — journal technique commun : dossier choisi par ELPIS_APP_LOG_DIR, fichier jamais lisible par tous (créé en 0640, resserré s'il était plus ouvert). */
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { cheminJournalCommun, ecrivainJournalCommun } from "../../src/evenements/journal-commun";

let dossier = "";

beforeEach(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-journal-commun-"));
});

afterEach(() => {
  rmSync(dossier, { recursive: true, force: true });
});

const ligne = { level: "INFO", category: "app", message: "m", logger: "t" };

describe("journal technique commun", () => {
  it("ELPIS_APP_LOG_DIR choisit le dossier ; sans lui, user_db/logs du dépôt", () => {
    expect(cheminJournalCommun("/depot", { ELPIS_APP_LOG_DIR: "/var/log/elpis" })).toBe(
      "/var/log/elpis/app.log.jsonl",
    );
    expect(cheminJournalCommun("/depot", {})).toBe("/depot/user_db/logs/app.log.jsonl");
  });

  it("fichier créé en 0640 ; un ancien fichier en 0644 est resserré", () => {
    const neuf = path.join(dossier, "neuf", "app.log.jsonl");
    const e1 = ecrivainJournalCommun(neuf, "main");
    e1(ligne);
    e1.fermer();
    expect(statSync(neuf).mode & 0o777).toBe(0o640);
    const ancien = path.join(dossier, "app.log.jsonl");
    writeFileSync(ancien, "", { mode: 0o644 });
    const e2 = ecrivainJournalCommun(ancien, "admin");
    e2(ligne);
    e2.fermer();
    expect(statSync(ancien).mode & 0o777).toBe(0o640);
  });
});
