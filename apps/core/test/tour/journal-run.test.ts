// SPDX-License-Identifier: MIT
/** apps/core/test/tour/journal-run.test.ts — journal des runs : lignes à l'octet près, fusion et plafond, fichiers, relecture, identifiants et dossiers (vecteurs Python) ; balayage, racine privée, écriture par lots. */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { verrousChat, viderEtatPourTests } from "../../src/tour/etat";
import {
  currentRun,
  isEnded,
  journalPath,
  listActiveChatIds,
  readLines,
  reglerJournalPourTests,
  RunJournal,
  safeRunId,
  sweep,
} from "../../src/tour/journal-run";

interface Cas {
  nom: string;
  run_id: string;
  meta?: Dict;
  prealables?: string[];
  ops: ({ ajout: unknown } | { vider: true })[];
  statut?: string | null;
}
interface Obtenu {
  ouvert: boolean;
  plafond: number | null;
  contenu: string | null;
  courant: string | null;
  fichiers: string[] | null;
}
const V = pyJsonLoads(readFileSync(new URL("../vecteurs/tour-journal.json", import.meta.url), "utf-8")) as {
  debut: Dict;
  journaux: Cas[];
  journaux_obtenus: Obtenu[];
  lectures: { octets: string; offset: number; max?: number }[];
  lectures_obtenues: { entrees: Dict[]; offset: number }[];
  identifiants: unknown[];
  identifiants_surs: string[];
  dossiers: [number, string][];
  noms_dossiers: string[];
};

let dossier = "";

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-journal-run-"));
  chmodSync(dossier, 0o700);
  reglerJournalPourTests({
    dossier: join(dossier, "runs"),
    flushIntervalS: 1e9,
    balayage: false,
    maintenant: () => 1700000000.5,
  });
});

afterEach(() => {
  reglerJournalPourTests(null);
  viderEtatPourTests();
  rmSync(dossier, { recursive: true, force: true });
});

const lire = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf-8") : null);

describe("écriture du journal (vecteurs Python)", () => {
  it.each(V.journaux.map((c, i) => [c.nom, i] as const))("%s", async (_nom, i) => {
    const cas = V.journaux[i]!;
    const attendu = V.journaux_obtenus[i]!;
    reglerJournalPourTests({ maxBytes: attendu.plafond ? () => attendu.plafond! : null });
    const j = new RunJournal(1, `chat${i}`, cas.run_id, cas.meta ?? {});
    for (const nom of cas.prealables ?? []) {
      mkdirSync(j.dir, { recursive: true, mode: 0o700 });
      writeFileSync(join(j.dir, nom), "ancien\n");
    }
    const ouvert = await j.open({ ...V.debut });
    for (const op of cas.ops) {
      if ("ajout" in op) j.append(op.ajout);
      else await j.flush();
    }
    if ("statut" in cas) await j.close(cas.statut as string);
    else await j.flush();
    expect({
      ouvert,
      plafond: attendu.plafond,
      contenu: j.runId ? lire(j.path) : null,
      courant: lire(join(j.dir, "current.json")),
      fichiers: existsSync(j.dir) ? readdirSync(j.dir).sort() : null,
    }).toEqual(attendu);
  });

  it("l'objet de l'émetteur n'est jamais modifié par la fusion", async () => {
    const j = new RunJournal(1, "c", "r1");
    await j.open({});
    const premier = { type: "content_token", text: "a" };
    j.append(premier);
    j.append({ type: "content_token", text: "b" });
    await j.close();
    expect(premier).toEqual({ type: "content_token", text: "a" });
  });

  it("append après close, ou journal non ouvert : ignoré ; close idempotent", async () => {
    const ferme = new RunJournal(1, "c", "r1");
    ferme.append({ type: "x" });
    await ferme.close();
    expect(existsSync(ferme.path)).toBe(false);
    const j = new RunJournal(1, "c", "r2");
    await j.open({});
    await j.close("done");
    j.append({ type: "apres" });
    await j.close("error");
    expect(readFileSync(j.path, "utf-8").split("\n").filter(Boolean)).toHaveLength(2);
  });

  it("64 événements en attente réveillent l'écriture sans attendre la cadence", async () => {
    reglerJournalPourTests({ flushIntervalS: 3600 });
    const j = new RunJournal(1, "c", "r1");
    await j.open({});
    for (let i = 0; i < 62; i++) j.append({ type: "tool_call", i });
    await new Promise((ok) => setTimeout(ok, 30));
    expect(readFileSync(j.path, "utf-8")).toBe("");
    j.append({ type: "tool_call", i: 62 });
    await new Promise((ok) => setTimeout(ok, 30));
    expect(readFileSync(j.path, "utf-8").split("\n").filter(Boolean)).toHaveLength(64);
    await j.close();
  });

  it("racine trop ouverte corrigée à l'ouverture ; racine qui n'est pas un dossier : journal désactivé", async () => {
    const base = join(dossier, "runs");
    mkdirSync(base, { mode: 0o700 });
    chmodSync(base, 0o777);
    expect(await new RunJournal(1, "c", "r1").open({})).toBe(true);
    writeFileSync(join(dossier, "fichier"), "");
    reglerJournalPourTests({ dossier: join(dossier, "fichier") });
    expect(await new RunJournal(1, "c", "r2").open({})).toBe(false);
  });
});

describe("relecture, identifiants, dossiers (vecteurs Python)", () => {
  it("lignes entières, CR/LF/CRLF, lignes vides ou invalides écartées, ligne plus longue qu'un bloc", () => {
    for (const [i, c] of V.lectures.entries()) {
      const p = join(dossier, `lecture${i}.jsonl`);
      writeFileSync(p, Buffer.from(c.octets, "hex"));
      const [entrees, offset] = readLines(p, c.offset, c.max);
      expect({ entrees, offset }, c.octets).toEqual(V.lectures_obtenues[i]);
    }
  });

  it("identifiant de run : lettres et chiffres Unicode, 32 au plus, `str(x or '')`", () => {
    expect(V.identifiants.map(safeRunId)).toEqual(V.identifiants_surs);
  });

  it("dossier par compte et chat : condensé, jamais l'identifiant du chat", () => {
    expect(V.dossiers.map(([u, c]) => basename(new RunJournal(u, c, "r").dir))).toEqual(V.noms_dossiers);
  });
});

describe("lecture du pointeur, chats actifs, balayage", () => {
  it("currentRun : `ended`, identifiant assaini, journal absent ou racine ouverte → null", async () => {
    const j = new RunJournal(1, "c", "r1", { base_count: 2 });
    await j.open({});
    expect(currentRun(1, "c")).toMatchObject({ run_id: "r1", chat_id: "c", base_count: 2, ended: false });
    expect(isEnded(1, "c", "r1")).toBe(false);
    await j.close();
    expect(currentRun(1, "c")?.["ended"]).toBe(true);
    expect(isEnded(1, "c", "r-1")).toBe(true);
    expect(journalPath(1, "c", "--")).toBeNull();
    expect(currentRun(2, "c")).toBeNull();
    chmodSync(join(dossier, "runs"), 0o750);
    expect(currentRun(1, "c")).toBeNull();
  });

  it("chats actifs : journal non terminé ET verrou de présence tenu, du compte seulement", async () => {
    for (const [uid, chat] of [
      [1, "a"],
      [1, "b"],
      [1, "fini"],
      [2, "autre"],
    ] as const) {
      const j = new RunJournal(uid, chat, `r${chat}`);
      await j.open({});
      if (chat === "fini") await j.close();
      if (chat !== "b") verrousChat.acquire("gen", uid, chat);
    }
    expect(listActiveChatIds(1)).toEqual(["a"]);
    expect(listActiveChatIds(2)).toEqual(["autre"]);
    expect(listActiveChatIds(3)).toEqual([]);
  });

  it("balayage : terminé depuis 10 min, orphelin depuis 24 h, dossier vide retiré", async () => {
    const vieux = 1700000000;
    const ecrire = async (chat: string, fin: boolean, age: number): Promise<RunJournal> => {
      const j = new RunJournal(1, chat, "r1");
      await j.open({});
      if (fin) await j.close();
      for (const p of [j.path, join(j.dir, "r1.end")])
        if (existsSync(p)) utimesSync(p, vieux - age, vieux - age);
      return j;
    };
    const finiVieux = await ecrire("a", true, 601);
    const finiRecent = await ecrire("b", true, 599);
    const orphelin = await ecrire("c", false, 24 * 3600 + 1);
    const enCours = await ecrire("d", false, 24 * 3600 - 1);
    expect(sweep(vieux)).toBe(2);
    expect(existsSync(finiVieux.dir)).toBe(false);
    expect(existsSync(orphelin.dir)).toBe(false);
    expect(existsSync(finiRecent.path)).toBe(true);
    expect(existsSync(enCours.path)).toBe(true);
  });
});
