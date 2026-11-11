// SPDX-License-Identifier: MIT
/** apps/core/test/tour/goldens-rattachement.test.ts — rejoue les goldens `rattachement_*` (suivi d'un run en cours) sous horloge logique, comme tests/chatbot/rattachement_harness.py ; ping, revalidation et déconnexion du suivi. */
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HttpError, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { verrousChat, viderEtatPourTests } from "../../src/tour/etat";
import type { JetonVerrou } from "../../src/tour/etat";
import { reglerJournalPourTests, RunJournal } from "../../src/tour/journal-run";
import { ligneNdjson } from "../../src/tour/ndjson";
import { evenementsDuRun, preparerSuivi, reglerSuiviPourTests } from "../../src/tour/suivi-run";

const DOSSIER = new URL("../../../../tests/goldens/", import.meta.url);
const NOMS = readdirSync(DOSSIER)
  .filter((n) => n.startsWith("rattachement_") && n.endsWith(".json"))
  .map((n) => n.slice(0, -5))
  .sort();
const HORIZON_S = 15;

interface Minuteur {
  readonly when: number;
  readonly seq: number;
  readonly rappel: () => void;
}

/** Boucle asyncio de `BoucleLogique` : le temps saute au prochain minuteur ; ceux à moins d'une nanoseconde partent ensemble. */
class BoucleLogique {
  t = 0;
  private seq = 0;
  private readonly minuteurs: Minuteur[] = [];

  readonly maintenant = (): number => this.t;

  readonly dormir = (s: number, signal?: AbortSignal): Promise<void> =>
    new Promise((ok) => {
      if (s <= 0) {
        setImmediate(ok);
        return;
      }
      const m = { when: this.t + s, seq: (this.seq += 1), rappel: ok };
      this.minuteurs.push(m);
      signal?.addEventListener("abort", () => (this.retirer(m), ok()), { once: true });
    });

  private retirer(m: Minuteur): void {
    const i = this.minuteurs.indexOf(m);
    if (i >= 0) this.minuteurs.splice(i, 1);
  }

  async executer(fini: () => boolean): Promise<void> {
    for (;;) {
      for (let i = 0; i < 4; i++) await new Promise((ok) => setImmediate(ok));
      if (fini()) return;
      if (this.minuteurs.length === 0)
        throw new Error("scénario bloqué : plus aucun minuteur ni tâche prête");
      const prochain = Math.min(...this.minuteurs.map((m) => m.when));
      this.t = this.t + Math.max(0, prochain - this.t);
      const fin = this.t + 1e-9;
      const prets = this.minuteurs
        .filter((m) => m.when < fin)
        .sort((a, b) => a.when - b.when || a.seq - b.seq);
      for (const m of prets) {
        this.retirer(m);
        m.rappel();
      }
    }
  }
}

let dossier = "";

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-rattachement-"));
  chmodSync(dossier, 0o700);
});

afterEach(() => {
  reglerJournalPourTests(null);
  reglerSuiviPourTests(null);
  viderEtatPourTests();
  rmSync(dossier, { recursive: true, force: true });
});

type Op = { a: number } & Dict;

/** Joue la chronologie (README, harnais `rattachement`) ; rend ce que reçoit le client et ses instants. */
async function rejouer(entrees: Dict): Promise<[Dict, number[]]> {
  const boucle = new BoucleLogique();
  const plafond = entrees["plafond_octets"] as number | undefined;
  reglerJournalPourTests({
    dossier: join(dossier, "runs"),
    flushIntervalS: 1e9,
    balayage: false,
    maxBytes: plafond === undefined ? null : () => plafond,
    maintenant: () => 1_700_000_000 + boucle.t,
    dormir: boucle.dormir,
  });
  reglerSuiviPourTests({ maintenant: boucle.maintenant, dormir: boucle.dormir });
  const chatId = entrees["chat_id"] as string;
  const recu: Dict[] = [];
  const instants: number[] = [];
  const sortie: Dict = {};
  let verrou: JetonVerrou | null = null;

  const client = async (params: Dict): Promise<void> => {
    let suivi;
    try {
      const texte = (v: unknown): string | null => (v === undefined ? null : String(v));
      suivi = preparerSuivi(1, chatId, texte(params["run_id"]), texte(params["from"]));
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      sortie["refus"] = { statut: e.statusCode, detail: e.detail };
      return;
    }
    const signal = new AbortController().signal;
    for await (const ev of evenementsDuRun(suivi, { signal, revalider: async () => true })) {
      recu.push(pyJsonLoads(ligneNdjson(ev)) as Dict);
      instants.push(Math.round(boucle.t * 1000) / 1000);
    }
  };

  const principal = async (): Promise<void> => {
    let journal: RunJournal | null = null;
    let suivi: Promise<void> | null = null;
    const chrono = entrees["chronologie"] as Op[];
    for (const [i, o] of chrono.entries()) {
      await boucle.dormir(Math.max(0, o.a - boucle.t));
      const [nom, v] = Object.entries(o).find(([k]) => k !== "a")!;
      if (nom === "ouvrir") {
        const { run_id: runId, debut } = v as { run_id: string; debut: Dict };
        journal = new RunJournal(1, chatId, runId);
        await journal.open({ ...debut });
      } else if (nom === "evenement") journal!.append({ ...(v as Dict) });
      else if (nom === "fermer") await journal!.close(v as string);
      else if (nom === "marquer_fin") {
        journal!.closed = true;
        await journal!.flush();
        journal!.markEnd();
      } else if (nom === "effacer") unlinkSync(journal!.path);
      else if (nom === "verrou") {
        if (v === "pris") verrou = verrousChat.acquire("gen", 1, chatId);
        else {
          verrousChat.release(verrou);
          verrou = null;
        }
      } else suivi = boucle.dormir(0).then(() => client({ ...(v as Dict) }));
      if (journal !== null && (i + 1 === chrono.length || chrono[i + 1]!.a !== o.a)) await journal.flush();
    }
    const limite = boucle.dormir(HORIZON_S).then(() => {
      throw new Error("horizon dépassé");
    });
    await Promise.race([suivi, limite]);
  };

  let fini = false;
  const p = principal().finally(() => (fini = true));
  await boucle.executer(() => fini);
  await p;
  return ["refus" in sortie ? sortie : { flux: recu }, instants];
}

function golden(nom: string): { texte: string; entrees: Dict } {
  const texte = readFileSync(new URL(`${nom}.json`, DOSSIER), "utf-8");
  return { texte, entrees: (pyJsonLoads(texte) as { entrees: Dict }).entrees };
}

async function rejouerGolden(nom: string): Promise<[Dict, number[]]> {
  const { texte, entrees } = golden(nom);
  const [obtenu, instants] = await rejouer(structuredClone(entrees));
  const canon = pyJsonDumps({ entrees, ...obtenu }, { ensureAscii: false, indent: 2, sortKeys: true }) + "\n";
  expect(canon, `dérive vs golden « ${nom} »`).toBe(texte);
  return [obtenu, instants];
}

describe("goldens rattachement_* (horloge logique)", () => {
  it("dix goldens présents", () => {
    expect(NOMS).toHaveLength(10);
  });

  it.each(NOMS)("%s", async (nom) => {
    await rejouerGolden(nom);
  });

  it("run perdu après trois secondes de grâce, verrou sondé chaque seconde", async () => {
    const [sortie, instants] = await rejouerGolden("rattachement_worker_perdu");
    expect((sortie["flux"] as Dict[]).at(-1)).toEqual({ type: "run_lost", reason: "worker" });
    expect(instants.at(-1)).toBeGreaterThan(3 + 3);
    expect(instants.at(-1)).toBeLessThanOrEqual(3 + 3 + 1.5);
  });

  it("verrou repris pendant la grâce : le suivi continue jusqu'à run_end", async () => {
    const [sortie] = await rejouerGolden("rattachement_verrou_repris");
    expect((sortie["flux"] as Dict[]).at(-1)).toEqual({ _s: 4, type: "run_end", status: "done" });
  });

  it("rejeu d'un bloc à la connexion, puis direct", async () => {
    const [sortie, instants] = await rejouerGolden("rattachement_rejeu_puis_direct");
    const types = (sortie["flux"] as Dict[]).map((e) => e["type"]);
    const finRejeu = types.indexOf("replay_done");
    expect(new Set(instants.slice(0, finRejeu + 1))).toEqual(new Set([2]));
    expect(instants.slice(finRejeu + 1).every((t) => t > 2)).toBe(true);
  });
});

describe("suivi : ping, revalidation de session, déconnexion", () => {
  async function suivre(revalider: () => Promise<boolean>, arreterA?: number): Promise<[Dict[], number[]]> {
    const boucle = new BoucleLogique();
    reglerJournalPourTests({
      dossier: join(dossier, "runs"),
      flushIntervalS: 1e9,
      balayage: false,
      dormir: boucle.dormir,
    });
    reglerSuiviPourTests({ maintenant: () => 100 + boucle.t, dormir: boucle.dormir });
    verrousChat.acquire("gen", 1, "c");
    const j = new RunJournal(1, "c", "r1");
    await j.open({});
    await j.flush();
    const arret = new AbortController();
    if (arreterA !== undefined) void boucle.dormir(arreterA).then(() => arret.abort());
    const recu: Dict[] = [];
    const instants: number[] = [];
    let fini = false;
    const p = (async () => {
      for await (const ev of evenementsDuRun(preparerSuivi(1, "c", null, null), {
        signal: arret.signal,
        revalider,
      })) {
        recu.push(ev);
        instants.push(Math.round(boucle.t * 100) / 100);
      }
    })().finally(() => (fini = true));
    await boucle.executer(() => fini);
    await p;
    return [recu.slice(2), instants.slice(2)];
  }

  it("ping toutes les 20 s, session révoquée détectée après 60 s", async () => {
    let appels = 0;
    const [evs, instants] = await suivre(async () => (appels += 1) > 1);
    expect(evs.map((e) => e["type"])).toEqual(["ping", "ping", "session_expired"]);
    expect(instants[0]).toBeGreaterThan(20);
    expect(instants[2]).toBeGreaterThan(60);
    expect(appels).toBe(1);
  });

  it("verrou sondé une fois par seconde, pas à chaque passe", async () => {
    const sonde = vi.spyOn(verrousChat, "isHeld");
    await suivre(async () => true, 10);
    expect(sonde.mock.calls.length).toBeGreaterThanOrEqual(9);
    expect(sonde.mock.calls.length).toBeLessThanOrEqual(11);
    sonde.mockRestore();
  });

  it("revalidation en panne : le suivi continue ; déconnexion : il s'arrête", async () => {
    const [evs, instants] = await suivre(async () => Promise.reject(new Error("base indisponible")), 70);
    expect(evs.map((e) => e["type"])).toEqual(["ping", "ping", "ping"]);
    expect(instants.at(-1)).toBeLessThan(70.2);
  });
});
