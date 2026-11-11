// SPDX-License-Identifier: MIT
/** apps/core/test/contexte/elagage-condenses.test.ts — élagage du contexte long : fenêtre protégée et marques éparses (aligné sur le Python), condensé d'une ligne (H-03), arguments d'écriture condensés (H-04), stabilité pour le cache de préfixe. */
import "../moteur-environnement";

import { createHash } from "node:crypto";

import { surchargerConfig } from "@elpis/config";
import { contientContenuElide } from "@elpis/outils-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as P from "../../src/contexte/elagage";
import type * as Jetons from "../../src/contexte/tokens";
import type { Dict } from "../../src/python";
import { expandHistoryForLlm } from "../../src/tour/historique";
import { messageAssistant } from "../../src/tour/persistance";

vi.mock("../../src/contexte/tokens", async (importOriginal) => {
  const reel = await importOriginal<typeof Jetons>();
  return {
    ...reel,
    // Même doublure que elagage.test.ts : 4 + longueur (points de code) du contenu texte, sinon 54.
    countMessagesTokensPerMsg: async (messages: readonly unknown[]) =>
      messages.map((m) => {
        const c = typeof m === "object" && m !== null ? (m as Dict)["content"] : undefined;
        return 4 + (typeof c === "string" ? Array.from(c).length : 50);
      }),
  };
});

let rang = 0;
let restaurer: () => void = () => undefined;

beforeEach(() => {
  rang = 0;
});

afterEach(() => restaurer());

function regler(protect: number, minGain: number): void {
  restaurer = surchargerConfig({
    PRUNE_ENABLED: true,
    PRUNE_PROTECT_TOKENS: protect,
    PRUNE_MIN_TOKENS: minGain,
  });
}

/** Un pas d'outil : l'assistant appelle `nom(args)`, l'outil répond `sortie`. */
function pas(nom: string, args: Dict, sortie: string): Dict[] {
  const id = `c${rang++}`;
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [{ id, type: "function", function: { name: nom, arguments: JSON.stringify(args) } }],
    },
    { role: "tool", tool_call_id: id, content: sortie },
  ];
}

function sortieDe(messages: readonly Dict[], id: string): Dict {
  return messages.find((m) => m["role"] === "tool" && m["tool_call_id"] === id)!;
}

function sha12(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex").slice(0, 12);
}

describe("élagage aligné sur le Python : fenêtre protégée intacte, marques éparses reprises, lots entiers", () => {
  const proteges = (): Dict[] => [
    ...pas("list_files", { path: "." }, "x"),
    ...pas("list_files", { path: "." }, "y"),
  ];
  const marquees = (cles: readonly string[], p: readonly Dict[][]): boolean[] =>
    p.map((x) => cles.includes(P.pruneKey(x[1]!)!));

  /** 3 petites très anciennes, une vieille de 20 Ko, 10 petites récentes, 2 pas protégés. */
  function session(): { messages: Dict[]; grosse: string; anciennes: string[] } {
    const anciennes = [0, 1, 2].map((k) => pas("read_file", { path: `old${k}.txt` }, "a".repeat(200)));
    const grosse = pas("read_file", { path: "big.log" }, "B".repeat(20_000));
    const recentes = Array.from({ length: 10 }, (_v, k) =>
      pas("grep", { pattern: `p${k}` }, "s".repeat(200)),
    );
    const messages = [
      { role: "system", content: "socle" },
      { role: "user", content: "mission" },
      ...anciennes.flat(),
      ...grosse,
      ...recentes.flat(),
      ...proteges(),
    ];
    return { messages, grosse: P.pruneKey(grosse[1]!)!, anciennes: anciennes.map((p) => P.pruneKey(p[1]!)!) };
  }

  it("une grosse sortie dans la fenêtre protégée reste ; tout ce qui la dépasse part", async () => {
    regler(22_100, 500);
    const { messages, grosse, anciennes } = session();
    const cles = await P.selectPruneKeys(messages, { ctxSize: 1_000_000 });
    expect(cles).toStrictEqual([...anciennes].reverse());
    expect(cles).not.toContain(grosse);
    expect(await P.selectPruneKeys(structuredClone(messages), { ctxSize: 1_000_000 })).toStrictEqual(cles);
  });

  it("mêmes déclenchements : rien sous le budget protégé ni sous le gain minimal", async () => {
    regler(30_000, 500);
    expect(await P.selectPruneKeys(session().messages, { ctxSize: 1_000_000 })).toStrictEqual([]);
    restaurer();
    regler(22_100, 5_000);
    expect(await P.selectPruneKeys(session().messages, { ctxSize: 1_000_000 })).toStrictEqual([]);
  });

  it("des sorties récentes plus grosses que les anciennes ne partent pas avant elles", async () => {
    regler(1_000, 500);
    const anciennes = Array.from({ length: 14 }, (_v, k) =>
      pas("read_file", { path: `o${k}` }, "o".repeat(100)),
    );
    const moyenne = pas("read_file", { path: "mid" }, "M".repeat(5_000));
    const recentes = [0, 1, 2].map((k) => pas("read_file", { path: `r${k}` }, "r".repeat(300)));
    const messages = [
      { role: "user", content: "q" },
      ...anciennes.flat(),
      ...moyenne,
      ...recentes.flat(),
      ...proteges(),
    ];
    const cles = await P.selectPruneKeys(messages, { ctxSize: 1_000_000 });
    expect(marquees(cles, recentes)).toStrictEqual([false, false, false]);
    expect(marquees(cles, [moyenne, ...anciennes]).every(Boolean)).toBe(true);
  });

  it("une marque récente n'arrête plus le parcours : les anciennes non marquées sont reprises (run et rechargement)", async () => {
    regler(600, 100);
    const anciennes = Array.from({ length: 10 }, (_v, k) =>
      pas("read_file", { path: `o${k}` }, "o".repeat(500)),
    );
    const deja = pas("read_file", { path: "deja" }, "d".repeat(500));
    const messages = [{ role: "user", content: "q" }, ...anciennes.flat(), ...deja, ...proteges()];
    const cleDeja = P.pruneKey(deja[1]!)!;
    const pendantLeRun = await P.selectPruneKeys(messages, { ctxSize: 1_000_000, alreadyMarked: [cleDeja] });
    expect(pendantLeRun).not.toContain(cleDeja);
    expect(marquees(pendantLeRun, anciennes).filter(Boolean).length).toBe(9);
    const recharge = messages.map((m) =>
      m === deja[1] ? { ...m, content: P.condensePrunedOutput(m["content"] as string, null) } : m,
    );
    expect(await P.selectPruneKeys(recharge, { ctxSize: 1_000_000 })).toStrictEqual(pendantLeRun);
  });

  it("appels parallèles : leurs sorties restent ensemble du même côté de la fenêtre protégée", async () => {
    regler(1_000, 500);
    const vieille = pas("read_file", { path: "old" }, "v".repeat(2_000));
    const lot: Dict[] = [
      {
        role: "assistant",
        content: "",
        tool_calls: ["la", "lb"].map((id) => ({
          id,
          type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: id }) },
        })),
      },
      { role: "tool", tool_call_id: "la", content: "a".repeat(600) },
      { role: "tool", tool_call_id: "lb", content: "b".repeat(600) },
    ];
    const recente = pas("grep", { pattern: "x" }, "r".repeat(300));
    const messages = [{ role: "user", content: "q" }, ...vieille, ...lot, ...recente, ...proteges()];
    const cles = await P.selectPruneKeys(messages, { ctxSize: 1_000_000 });
    expect(cles).toStrictEqual([P.pruneKey(vieille[1]!)]);
  });
});

describe("H-03 : condensé d'une ligne à la place du marqueur fixe", () => {
  const appel = (nom: string, args: Dict): Dict => ({
    id: "x",
    function: { name: nom, arguments: JSON.stringify(args) },
  });

  it("outil, statut, argument principal, taille, faits triviaux", () => {
    const lecture = JSON.stringify({
      ok: true,
      path: "src/a.ts",
      total_lines: 412,
      content: "c".repeat(500),
    });
    expect(P.condensePrunedOutput(lecture, appel("read_file", { path: "src/a.ts" }))).toBe(
      `[Old tool output cleared: read_file ok, path=src/a.ts, ${lecture.length} chars, lines=412 — use session_search to retrieve it]`,
    );
    const shell = JSON.stringify({ ok: true, returncode: 1, stdout: "FAIL x\n".repeat(30) });
    expect(P.condensePrunedOutput(shell, appel("execute_shell", { command: "npm   test\n--run" }))).toBe(
      `[Old tool output cleared: execute_shell ok, command=npm test --run, ${shell.length} chars, exit=1 — use session_search to retrieve it]`,
    );
    const grep = JSON.stringify({ ok: true, format: "grep", matches: 12, content: "l\n".repeat(12) });
    expect(P.condensePrunedOutput(grep, appel("read_file", { path: "b.py", pattern: "def " }))).toBe(
      `[Old tool output cleared: read_file ok, path=b.py, ${grep.length} chars, 12 matches — use session_search to retrieve it]`,
    );
    const echec = JSON.stringify({ ok: false, error: "not_found", message: "no such file" });
    expect(P.condensePrunedOutput(echec, appel("read_file", { path: "zz" }))).toBe(
      `[Old tool output cleared: read_file error, path=zz, ${echec.length} chars, error=not_found — use session_search to retrieve it]`,
    );
    expect(P.condensePrunedOutput("Error: boom\ntrace", undefined)).toBe(
      "[Old tool output cleared: tool error, 17 chars — use session_search to retrieve it]",
    );
  });

  it("une seule ligne, argument tronqué, reconnu comme marqueur (fixe ou condensé)", () => {
    const m = P.condensePrunedOutput("ok", appel("fetch", { url: `https://h/${"p".repeat(200)}` }));
    expect(m).not.toContain("\n");
    expect(m).toContain(`url=https://h/${"p".repeat(70)}…,`);
    expect(m.endsWith("use session_search to retrieve it]")).toBe(true);
    expect(P.estMarqueurElague(m)).toBe(true);
    expect(P.estMarqueurElague(P.PRUNE_CLEARED_MARKER)).toBe(true);
    expect(P.estMarqueurElague("[Old tool output cleared but\nuse session_search to retrieve it]")).toBe(
      false,
    );
    expect(P.estMarqueurElague("sortie ordinaire")).toBe(false);
  });

  it("stable d'un tour à l'autre : même condensé dans la vue du run et dans l'historique rejoué", () => {
    const [a, t] = pas(
      "read_file",
      { path: "src/x.ts" },
      JSON.stringify({ ok: true, content: "y".repeat(3000) }),
    );
    const cle = P.pruneKey(t!)!;
    const vue = P.applyPruneMarks([{ role: "user", content: "q" }, a, t], [cle]) as Dict[];
    const vue2 = P.applyPruneMarks(structuredClone([{ role: "user", content: "q" }, a, t]), [cle]) as Dict[];
    expect(JSON.stringify(vue2)).toBe(JSON.stringify(vue));
    const rejoue = expandHistoryForLlm(
      [
        { role: "user", content: "q" },
        {
          role: "assistant",
          content: "fini",
          tool_history: structuredClone([a, t]),
          tool_history_delta: true,
        },
      ],
      { prunedKeys: [cle] },
    );
    expect(sortieDe(rejoue, t!["tool_call_id"] as string)["content"]).toBe(vue[2]!["content"]);
    expect(t!["content"]).not.toBe(vue[2]!["content"]);
  });

  it("une sortie déjà condensée est sautée, pas une frontière : la plus ancienne reste candidate", async () => {
    regler(10, 10);
    const vieux = pas("read_file", { path: "v" }, "v".repeat(400));
    const marque = pas("read_file", { path: "m" }, "m".repeat(400));
    marque[1]!["content"] = P.condensePrunedOutput("m".repeat(400), marque[0]!["tool_calls"]);
    const neuf = pas("read_file", { path: "n" }, "n".repeat(400));
    const messages = [
      { role: "user", content: "q" },
      ...vieux,
      ...marque,
      ...neuf,
      ...pas("ls", {}, "1"),
      ...pas("ls", {}, "2"),
    ];
    expect(await P.selectPruneKeys(messages, { ctxSize: 1_000_000 })).toStrictEqual([
      P.pruneKey(neuf[1]!),
      P.pruneKey(vieux[1]!),
    ]);
  });
});

describe("H-04 : arguments volumineux des écritures anciennes condensés", () => {
  const contenu = "x".repeat(20_000);

  /** write_file de 20 Ko, puis 10 pas de lecture, puis une autre grosse écriture dans le dernier pas. */
  function session(): { messages: Dict[]; ecriture: Dict[]; recente: Dict[] } {
    const ecriture = pas(
      "write_file",
      { path: "src/big.ts", content: contenu },
      '{"ok": true, "bytes": 20000}',
    );
    const lectures = Array.from({ length: 10 }, (_v, k) => pas("read_file", { path: `f${k}` }, "petit"));
    const recente = pas("write_file", { path: "src/neuf.ts", content: "n".repeat(5000) }, '{"ok": true}');
    const messages = [{ role: "user", content: "écris" }, ...ecriture, ...lectures.flat(), ...recente];
    return { messages, ecriture, recente };
  }

  it("write_file de 20 Ko puis 10 tours : argument remplacé par un condensé (chemin, taille, sha256 court), JSON valide", async () => {
    regler(0, 0);
    const { messages, ecriture, recente } = session();
    const avant = JSON.stringify(messages);
    const cles = await P.selectPruneKeys(messages, { ctxSize: 100_000 });
    expect(cles).toStrictEqual([P.argsPruneKey((ecriture[0]!["tool_calls"] as Dict[])[0])]);
    expect(cles.every(P.estCleArguments)).toBe(true);
    const vue = P.applyPruneMarks(messages, cles) as Dict[];
    expect(JSON.stringify(messages)).toBe(avant);
    const args = ((vue[1]!["tool_calls"] as Dict[])[0]!["function"] as Dict)["arguments"] as string;
    expect(JSON.parse(args)).toStrictEqual({
      path: "src/big.ts",
      content: `[content elided: 20000 chars, sha256 ${sha12(contenu)} — re-read the file if needed]`,
    });
    expect(vue.slice(2)).toStrictEqual(messages.slice(2));
    expect(vue.at(-2)).toBe(recente[0]);
    expect(P.sanitizeMessageHistory(vue)[1]).toStrictEqual(vue[1]);
    const vue2 = P.applyPruneMarks(structuredClone(messages), cles);
    expect(JSON.stringify(vue2)).toBe(JSON.stringify(vue));
  });

  it("pas de passe pour des arguments sous le seuil ou d'un outil qui n'écrit pas", async () => {
    regler(0, 0);
    const messages = [
      { role: "user", content: "q" },
      ...pas("write_file", { path: "a", content: "p".repeat(1500) }, "{}"),
      ...pas("execute_shell", { command: "c".repeat(20_000) }, "{}"),
      ...pas("ls", {}, "1"),
      ...pas("ls", {}, "2"),
    ];
    expect(await P.selectPruneKeys(messages, { ctxSize: 100_000 })).toStrictEqual([]);
  });

  it("le condensé émis est celui que l'hôte d'outils refuse à l'écriture (motif partagé)", () => {
    const elide = JSON.parse(
      P.condenseWriteArguments(JSON.stringify({ path: "a", content: contenu })),
    ) as Dict;
    expect(contientContenuElide(elide["content"])).toBe(true);
    expect(contientContenuElide(elide["path"])).toBe(false);
  });

  it("edit_file multi : chaque long champ condensé, les champs courts et l'action gardés", () => {
    const args = JSON.stringify({
      path: "m.ts",
      action: "multi",
      edits: [
        { old_str: "o".repeat(1500), new_str: "b".repeat(1500) },
        { old_str: "court", new_str: "c".repeat(900) },
      ],
    });
    const elide = JSON.parse(P.condenseWriteArguments(args)) as Dict;
    expect(elide).toStrictEqual({
      path: "m.ts",
      action: "multi",
      edits: [
        {
          old_str: `[content elided: 1500 chars, sha256 ${sha12("o".repeat(1500))} — re-read the file if needed]`,
          new_str: `[content elided: 1500 chars, sha256 ${sha12("b".repeat(1500))} — re-read the file if needed]`,
        },
        {
          old_str: "court",
          new_str: `[content elided: 900 chars, sha256 ${sha12("c".repeat(900))} — re-read the file if needed]`,
        },
      ],
    });
  });

  it("une écriture déjà condensée n'est pas recomptée ; le décompte affiché ne compte que les sorties", async () => {
    regler(0, 0);
    const { messages } = session();
    const cles = await P.selectPruneKeys(messages, { ctxSize: 100_000 });
    expect(await P.selectPruneKeys(messages, { ctxSize: 100_000, alreadyMarked: cles })).toStrictEqual([]);
    expect(P.estCleArguments(P.pruneKey(messages[2]!))).toBe(false);
    const [msg] = messageAssistant(
      "ok",
      "",
      {},
      {
        execId: "e",
        ctxSnap: null,
        taskUsage: {},
        filesChanged: new Map(),
        compactions: [],
        pruneKeys: [P.pruneKey(messages[2]!), ...cles],
        msgs: [],
        isContinue: false,
      },
    );
    expect(msg["pruned"]).toBe(1);
  });
});
