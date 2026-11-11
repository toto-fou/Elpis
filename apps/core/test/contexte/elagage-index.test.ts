// SPDX-License-Identifier: MIT
/** apps/core/test/contexte/elagage-index.test.ts — H-02 : une sortie d'outil élaguée est indexée avant son effacement (session_search la retrouve), sans doublon quand la compression couvre ensuite le même tour. */
import "../moteur-environnement";

import { createUser } from "@elpis/auth";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { compresseurDuProcess } from "../../src/contexte/branchements";
import { ConversationCompressor, indexPrunedToolOutputs } from "../../src/contexte/compresseur";
import { applyPruneMarks, selectPruneKeys } from "../../src/contexte/elagage";
import { installerPortCompresseur } from "../../src/contexte/ports";
import type * as Jetons from "../../src/contexte/tokens";
import type * as Modeles from "../../src/llm/modeles";
import { sessionSearch } from "../../src/memoire/outil";
import type { Dict } from "../../src/python";

vi.mock("../../src/contexte/tokens", async (importOriginal) => {
  const reel = await importOriginal<typeof Jetons>();
  const compter = (messages: readonly unknown[]): number[] =>
    messages.map((m) => {
      const c = typeof m === "object" && m !== null ? (m as Dict)["content"] : undefined;
      return 4 + (typeof c === "string" ? Array.from(c).length : 50);
    });
  return {
    ...reel,
    countMessagesTokensPerMsg: async (messages: readonly unknown[]) => compter(messages),
    countTokensForMessages: async (messages: readonly unknown[]) =>
      compter(messages).reduce((a, b) => a + b, 0),
  };
});
vi.mock("../../src/llm/modeles", async (importOriginal) => ({
  ...(await importOriginal<typeof Modeles>()),
  getModelContextSize: async () => 100_000,
}));

const JETON = "aiguille7f3a";
const SESSION = "chat-h02";

/** Mission, une grosse sortie ancienne qui contient le jeton (dans les 4 000 premiers caractères indexés), puis des pas récents. */
function conversation(): Dict[] {
  const pas = (id: string, sortie: string): Dict[] => [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id, type: "function", function: { name: "read_file", arguments: `{"path": "${id}.log"}` } },
      ],
    },
    { role: "tool", tool_call_id: id, content: sortie },
  ];
  return [
    { role: "system", content: "socle" },
    { role: "user", content: "analyse les journaux" },
    ...pas("c0", `${"ligne ordinaire\n".repeat(100)}erreur ${JETON} au démarrage\n${"suite\n".repeat(2000)}`),
    { role: "assistant", content: "j'ai lu le premier journal" },
    { role: "user", content: "continue" },
    ...pas("c1", "court"),
    ...pas("c2", "court aussi"),
    { role: "assistant", content: "fini" },
  ];
}

async function lignesDuJeton(t: BaseDeTest): Promise<number> {
  const r = await t.base.get<{ n: number }>(
    "SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ? AND role = 'tool' AND content LIKE ?",
    [SESSION, `%${JETON}%`],
  );
  return Number(r?.n ?? 0);
}

describe("H-02 : index de session avant l'effacement d'une sortie", () => {
  let t: BaseDeTest;
  let restaurer: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 0 });
    installerPortCompresseur(compresseurDuProcess(t.base));
    restaurer = surchargerConfig({ PRUNE_ENABLED: true, PRUNE_PROTECT_TOKENS: 100, PRUNE_MIN_TOKENS: 100 });
  });

  afterAll(async () => {
    restaurer();
    installerPortCompresseur(null);
    await t.fermer();
  });

  it("élaguer, puis session_search retrouve une chaîne exacte de la sortie effacée ; la compression ne la réindexe pas", async () => {
    const messages = conversation();
    const cles = await selectPruneKeys(messages, { ctxSize: 100_000 });
    expect(cles.length).toBe(1);
    expect(await indexPrunedToolOutputs(messages, cles, "alice", SESSION)).toBe(1);
    const vue = applyPruneMarks(messages, cles) as Dict[];
    expect(JSON.stringify(vue)).not.toContain(JETON);

    const dep = {
      base: t.base,
      idUtilisateur: async (nom: string) =>
        Number((await t.base.get<{ id: number }>("SELECT id FROM users WHERE username = ?", [nom]))?.id),
    };
    const trouve = await sessionSearch(dep, { username: "alice", chatId: SESSION }, { query: JETON });
    expect(trouve["ok"]).toBe(true);
    const matches = trouve["matches"] as Dict[];
    expect(matches.length).toBe(1);
    expect(matches[0]!["role"]).toBe("tool");
    expect(String(matches[0]!["excerpt"])).toContain(JETON);

    const compresseur = new ConversationCompressor(
      async () => ["## Contexte\n- analyse des journaux\n## Fait\n- premier journal lu", { model: "m" }],
      {
        keepRecentTurns: 1,
        keepBridgeTurns: 0,
      },
    );
    const [, stats] = await compresseur.compress(messages, {
      userId: "alice",
      ftsSessionId: SESSION,
      force: true,
      ftsDejaIndexees: new Set(cles),
    });
    expect(stats["compressed"], JSON.stringify(stats)).toBe(true);
    expect(await lignesDuJeton(t)).toBe(1);
    const appels = await t.base.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ? AND role = 'tool_call'",
      [SESSION],
    );
    expect(Number(appels?.n)).toBeGreaterThan(0);
  });

  it("tour éphémère (ftsIndexer: false) : la compression n'indexe rien", async () => {
    const compresseur = new ConversationCompressor(
      async () => ["## Contexte\n- analyse des journaux\n## Fait\n- premier journal lu", { model: "m" }],
      { keepRecentTurns: 1, keepBridgeTurns: 0 },
    );
    const [, stats] = await compresseur.compress(conversation(), {
      userId: "alice",
      ftsSessionId: "chat-ephemere",
      force: true,
      ftsIndexer: false,
    });
    expect(stats["compressed"], JSON.stringify(stats)).toBe(true);
    const n = await t.base.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?",
      ["chat-ephemere"],
    );
    expect(Number(n?.n)).toBe(0);
  });
});
