// SPDX-License-Identifier: MIT
/** apps/core/test/evenements/journal-staff.test.ts — suivi du journal JSONL : lignes entières, rotation, relais au seul staff. */
import { appendFileSync, mkdtempSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileAttente } from "../../src/evenements/file";
import { FileTail, SuiviJournalStaff } from "../../src/evenements/journal-staff";
import { SystemEvents } from "../../src/evenements/systeme";
import type { ElementSysteme } from "../../src/evenements/systeme";
import { attendreQue } from "./aides";

const dossiers: string[] = [];

function journalTemporaire(): string {
  const dossier = mkdtempSync(path.join(tmpdir(), "elpis-journal-"));
  dossiers.push(dossier);
  return path.join(dossier, "app.log.jsonl");
}

afterEach(() => {
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});

function ligne(objet: unknown): string {
  return JSON.stringify(objet) + "\n";
}

describe("FileTail (journal tourné par renommage)", () => {
  it("une ligne incomplète attend sa fin", async () => {
    const chemin = journalTemporaire();
    writeFileSync(chemin, "");
    const suivi = new FileTail(chemin);
    await suivi.skipToEnd();
    appendFileSync(chemin, '{"a": 1}\n{"b": ');
    expect(await suivi.readNew()).toEqual([{ a: 1 }]);
    appendFileSync(chemin, "2}\n");
    expect(await suivi.readNew()).toEqual([{ b: 2 }]);
  });

  it("la rotation ne perd ni l'arriéré ni la ligne qui suit", async () => {
    const chemin = journalTemporaire();
    writeFileSync(chemin, "");
    const suivi = new FileTail(chemin);
    await suivi.skipToEnd();
    const recus: number[] = [];
    for (let i = 0; i < 60; i++) {
      appendFileSync(chemin, ligne({ n: i }));
      if (statSync(chemin).size > 200) renameSync(chemin, chemin + ".1");
      if (i % 3 === 2) recus.push(...(await suivi.readNew()).map((m) => m["n"] as number));
    }
    recus.push(...(await suivi.readNew()).map((m) => m["n"] as number));
    expect(recus).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it("hasNew voit l'écriture et la rotation ; recalage sur un fichier absent", async () => {
    const chemin = journalTemporaire();
    writeFileSync(chemin, "");
    const suivi = new FileTail(chemin);
    await suivi.skipToEnd();
    expect(await suivi.hasNew()).toBe(false);
    appendFileSync(chemin, ligne({ a: 1 }));
    expect(await suivi.hasNew()).toBe(true);
    expect(await suivi.readNew()).toEqual([{ a: 1 }]);
    expect(await suivi.hasNew()).toBe(false);
    renameSync(chemin, chemin + ".1");
    appendFileSync(chemin, ligne({ b: 2 }));
    expect(await suivi.hasNew()).toBe(true);
    expect(await suivi.readNew()).toEqual([{ b: 2 }]);
    rmSync(chemin);
    suivi.pos = 999;
    await suivi.skipToEnd();
    expect(suivi.pos).toBe(0);
    expect(await suivi.readNew()).toEqual([]);
  });

  it("troncature : repart du début ; lignes illisibles, vides ou non-objets ignorées ; UTF-8 abîmé remplacé", async () => {
    const chemin = journalTemporaire();
    writeFileSync(chemin, ligne({ x: 1 }) + ligne({ x: 2 }));
    const suivi = new FileTail(chemin);
    await suivi.skipToEnd();
    writeFileSync(chemin, "");
    appendFileSync(chemin, "  \n[1]\npas du json\n" + ligne({ ok: true }));
    appendFileSync(
      chemin,
      Buffer.concat([Buffer.from('{"m": "a'), Buffer.from([0xff]), Buffer.from('b"}\r\n')]),
    );
    expect(await suivi.readNew()).toEqual([{ ok: true }, { m: "a�b" }]);
  });
});

describe("SuiviJournalStaff", () => {
  it("une ligne vivante atteint le staff, jamais un compte ordinaire ; une ligne forensique reste au fichier", async () => {
    const chemin = journalTemporaire();
    writeFileSync(chemin, ligne({ message: "ancienne" }));
    const bus: SystemEvents = new SystemEvents({ surAbonneJournal: () => suivi.assurer() });
    const suivi = new SuiviJournalStaff(() => bus, chemin, { pollMs: 10 });
    const staff = bus.listen({ isStaff: true, journal: true, userId: 1 });
    const ordinaire = new FileAttente<ElementSysteme>();
    bus.clients.set(ordinaire, { staff: false, uid: 2 });
    const premier = staff.next();
    expect(suivi.actif).toBe(true);
    await attendreQue(() => suivi.positionne, 2_000, "curseur posé");
    appendFileSync(chemin, ligne({ message: "http 200", live: false, service: "main", category: "http" }));
    appendFileSync(
      chemin,
      ligne({
        message: "ligne émise ailleurs",
        service: "admin",
        category: "app",
        level: "WARNING",
        ts: 1.5,
      }),
    );
    expect((await premier).value).toBe(
      '{"type": "log", "message": "[admin/app] ligne \\u00e9mise ailleurs", "level": "WARNING", ' +
        '"category": "app", "service": "admin", "ts": 1.5}',
    );
    expect(ordinaire.taille).toBe(0);
    await staff.return();
    await attendreQue(() => !suivi.actif, 2_000, "arrêt du suivi sans staff");
  });

  it("un log diffusé passe par le journal commun et revient au staff de chaque process", async () => {
    const chemin = journalTemporaire();
    writeFileSync(chemin, "");
    const ecrire = (l: { level: string; category: unknown; message: string; logger: string }): void =>
      appendFileSync(chemin, ligne({ ts: 2.5, service: "main", ...l }));
    const bus: SystemEvents = new SystemEvents({
      ecrireJournal: ecrire,
      surAbonneJournal: () => suivi.assurer(),
    });
    const suivi = new SuiviJournalStaff(() => bus, chemin, { pollMs: 10 });
    const staff = bus.listen({ isStaff: true, journal: true, userId: 1 });
    const premier = staff.next();
    await attendreQue(() => suivi.positionne, 2_000, "curseur posé");
    bus.broadcast({ type: "log", message: "vu partout", level: "info" });
    expect(JSON.parse((await premier).value as string)).toMatchObject({
      type: "log",
      message: "[main/app] vu partout",
      level: "INFO",
    });
    await staff.return();
  });

  it("l'arrêt du process arrête le suivi", async () => {
    const chemin = journalTemporaire();
    writeFileSync(chemin, "");
    const arret = new AbortController();
    const bus: SystemEvents = new SystemEvents({ surAbonneJournal: () => suivi.assurer() });
    const suivi = new SuiviJournalStaff(() => bus, chemin, { pollMs: 10, arret: arret.signal });
    void bus.listen({ isStaff: true, journal: true, userId: 1 });
    expect(suivi.actif).toBe(true);
    arret.abort();
    await attendreQue(() => !suivi.actif, 2_000, "arrêt du suivi");
    suivi.assurer();
    expect(suivi.actif).toBe(false);
  });
});
