// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/journal-commun.test.ts — écriture du journal JSONL commun : forme de `write_event`, message borné, dossier recréé, rotation, relecture par le suivi staff. */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cheminJournalCommun,
  ecrivainJournalCommun,
  LOG_MAX_BYTES,
  tournerSiPlein,
} from "../../src/evenements/journal-commun";
import { FileTail, logRecordToEvent } from "../../src/evenements/journal-staff";

const dossiers: string[] = [];

function racineTemporaire(): string {
  const dossier = mkdtempSync(path.join(tmpdir(), "elpis-journal-commun-"));
  dossiers.push(dossier);
  return dossier;
}

afterEach(() => {
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("journal commun (write_event)", () => {
  it("une ligne par événement, à l'octet près celle du Python hors `ts` et `pid` ; message borné à 2000 caractères ; dossier créé à la volée", async () => {
    const chemin = cheminJournalCommun(racineTemporaire());
    expect(chemin.endsWith(path.join("user_db", "logs", "app.log.jsonl"))).toBe(true);
    const suivi = new FileTail(chemin);
    await suivi.skipToEnd();
    const ecrire = ecrivainJournalCommun(chemin, "main");
    ecrire({ level: "INFO", category: "app", message: 'é中😀 "q" \\ \n', logger: "system_events" });
    ecrire({ level: "WARNING", category: 3, message: "😀".repeat(2001), logger: "system_events" });
    const lignes = readFileSync(chemin, "utf8").split("\n");
    expect(lignes.map((l) => l.replace(/^\{"ts": [\d.]+, /u, "{").replace(/, "pid": \d+\}$/u, "}"))).toEqual([
      '{"service": "main", "level": "INFO", "category": "app", "message": "é中😀 \\"q\\" \\\\ \\n", "logger": "system_events"}',
      `{"service": "main", "level": "WARNING", "category": 3, "message": "${"😀".repeat(2000)}", "logger": "system_events"}`,
      "",
    ]);
    expect(lignes[0]).toMatch(new RegExp(`, "pid": ${process.pid}\\}$`, "u"));
    expect((await suivi.readNew()).map((rec) => logRecordToEvent(rec))).toEqual([
      expect.objectContaining({ type: "log", message: '[main/app] é中😀 "q" \\ \n', level: "INFO" }),
      expect.objectContaining({ type: "log", message: `[main/3] ${"😀".repeat(2000)}`, level: "WARNING" }),
    ]);
  });

  it('comme `time.time()` et `encode(errors="replace")` : horodatage entier écrit en flottant, demi-paire isolée en « ? »', () => {
    const chemin = cheminJournalCommun(racineTemporaire());
    const horloge = vi.spyOn(Date, "now").mockReturnValue(1_759_843_045_000);
    try {
      ecrivainJournalCommun(
        chemin,
        "main",
      )({
        level: "INFO",
        category: "app",
        message: "a\ud800b 😀",
        logger: "system_events",
      });
    } finally {
      horloge.mockRestore();
    }
    expect(readFileSync(chemin, "utf8")).toBe(
      `{"ts": 1759843045.0, "service": "main", "level": "INFO", "category": "app", "message": "a?b 😀", "logger": "system_events", "pid": ${process.pid}}\n`,
    );
  });

  it("rotation : `.1` à `.3` gardés, le plus ancien supprimé ; contrôlée toutes les 256 lignes ; jamais d'exception", () => {
    const racine = racineTemporaire();
    const chemin = cheminJournalCommun(racine);
    expect(LOG_MAX_BYTES).toBe(8 * 1024 * 1024);
    const ecrire = ecrivainJournalCommun(chemin, "admin", 1_000);
    for (let i = 0; i < 255; i++) ecrire({ level: "INFO", category: "app", message: `n${i}`, logger: "l" });
    expect(existsSync(`${chemin}.1`)).toBe(false);
    ecrire({ level: "INFO", category: "app", message: "n255", logger: "l" });
    expect(existsSync(chemin)).toBe(false);
    expect(readFileSync(`${chemin}.1`, "utf8").split("\n")).toHaveLength(257);
    ecrire({ level: "INFO", category: "app", message: "après", logger: "l" });
    expect(readFileSync(chemin, "utf8")).toContain('"message": "après"');

    const fichiers: [string, string][] = [
      ["", "courant-assez-long"],
      [".1", "un"],
      [".2", "deux"],
      [".3", "trois"],
    ];
    for (const [suffixe, contenu] of fichiers) writeFileSync(`${chemin}${suffixe}`, contenu);
    tournerSiPlein(chemin, 1_000);
    expect(readFileSync(chemin, "utf8")).toBe("courant-assez-long");
    tournerSiPlein(chemin, 10);
    expect([".1", ".2", ".3"].map((s) => readFileSync(`${chemin}${s}`, "utf8"))).toEqual([
      "courant-assez-long",
      "un",
      "deux",
    ]);
    expect(existsSync(chemin)).toBe(false);
    expect(() => tournerSiPlein(chemin, 10)).not.toThrow();

    writeFileSync(path.join(racine, "fichier"), "");
    const impossible = ecrivainJournalCommun(path.join(racine, "fichier", "app.log.jsonl"), "main");
    expect(() => impossible({ level: "INFO", category: "app", message: "x", logger: "l" })).not.toThrow();
  });
});
