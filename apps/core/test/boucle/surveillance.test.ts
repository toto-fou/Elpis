// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/surveillance.test.ts — traceur contexte/perf : enregistrements Python rejoués, écriture NDJSON du jour, rapport hors ligne. */
import "../moteur-environnement";

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, onTestFinished } from "vitest";

import { recordLlmCall, report, watchLlmCall, watchToolCall } from "../../src/boucle/surveillance";
import type { Dict } from "../../src/python";
import { lireVecteurs } from "../vecteurs-moteur";

interface Appel {
  chat_id: string | null;
  path: string;
  iteration: number | null;
  model: string | null;
  messages: unknown[];
  tools_payload: unknown[] | null;
  usage: Dict | null;
  timings: Dict | null;
  fit: Dict | null;
  full: boolean;
}

const V = lireVecteurs<{ appels: Appel[]; enregistrements: Dict[]; lignes: Dict[]; rapport: string }>(
  "boucle-surveillance",
);

afterEach(() => {
  for (const v of ["LLAMA_WATCH", "LLAMA_WATCH_DIR", "LLAMA_WATCH_FULL"]) delete process.env[v];
});

const versAppel = (a: Appel) => ({
  chatId: a.chat_id,
  path: a.path,
  iteration: a.iteration,
  model: a.model,
  messages: a.messages,
  toolsPayload: a.tools_payload,
  usage: a.usage,
  timings: a.timings,
  fit: a.fit,
});

describe("traceur contexte/perf", () => {
  it("enregistrement d'un appel identique au Python (extraits, marqueurs, cache KV)", () => {
    V.appels.forEach((a, i) => {
      process.env["LLAMA_WATCH_FULL"] = a.full ? "1" : "";
      expect(recordLlmCall(versAppel(a))).toStrictEqual(V.enregistrements[i]);
    });
  });

  it("rapport hors ligne identique au Python", () => {
    const d = mkdtempSync(path.join(tmpdir(), "elpis-watch-"));
    onTestFinished(() => rmSync(d, { recursive: true, force: true }));
    const f = path.join(d, "watch.ndjson");
    writeFileSync(f, V.lignes.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(report([f, path.join(d, "absent.ndjson")])).toBe(V.rapport);
    expect(report([])).toBe("aucun record (fichiers vides ou LLAMA_WATCH inactif)");
  });

  it("écriture : rien sans LLAMA_WATCH ; sinon une ligne par appel et par outil, fichier du jour", () => {
    const d = mkdtempSync(path.join(tmpdir(), "elpis-watch-"));
    onTestFinished(() => rmSync(d, { recursive: true, force: true }));
    process.env["LLAMA_WATCH_DIR"] = d;
    watchLlmCall(versAppel(V.appels[0]!));
    expect(readdirSync(d)).toEqual([]);
    process.env["LLAMA_WATCH"] = "on";
    watchLlmCall(versAppel(V.appels[0]!));
    watchToolCall({
      chatId: "c",
      iteration: 1,
      tool: "f",
      argsChars: 2,
      resultChars: 3,
      durationMs: 4.7,
      status: "ok",
    });
    const [nom] = readdirSync(d);
    expect(nom).toMatch(new RegExp(`^watch-\\d{8}-${process.pid}\\.ndjson$`));
    const lignes = readFileSync(path.join(d, nom!), "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Dict);
    expect(lignes.map((l) => l["kind"])).toEqual(["llm_call", "tool"]);
    expect(lignes[1]).toMatchObject({ chat: "c", iter: 1, tool: "f", args_chars: 2, result_chars: 3, ms: 4 });
    expect(typeof lignes[0]!["ts"]).toBe("number");
  });
});
