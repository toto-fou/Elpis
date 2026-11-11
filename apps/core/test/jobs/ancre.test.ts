// SPDX-License-Identifier: MIT
/** apps/core/test/jobs/ancre.test.ts — JB-16 : après une compaction, l'ancre épinglée porte la ligne « active jobs » (id, libellé, déclencheurs, consigne de reprise) ; sans job actif, l'ancre est inchangée. */
import "../moteur-environnement";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { compresseurDuProcess } from "../../src/contexte/branchements";
import { ConversationCompressor, jobsSurLaQuestion, pinTaskAnchor } from "../../src/contexte/compresseur";
import { LEADING_ANCHOR_TEXT } from "../../src/contexte/elagage";
import { installerPortCompresseur } from "../../src/contexte/ports";
import type * as Jetons from "../../src/contexte/tokens";
import type * as Modeles from "../../src/llm/modeles";
import type { Dict } from "../../src/python";
import { creerBanc, creerChat, lancerJob } from "./aides";
import type { Banc } from "./aides";

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

const JOBS = 'active jobs (you will be woken automatically, do not poll): j-00000001 "pytest" wake_on=exit';

describe("ligne des jobs actifs dans l'ancre (pinTaskAnchor)", () => {
  it("ajoutée à l'ancre épinglée (mission perdue, repli, tête assistant) ; rien sans job ; ancre gardée telle quelle sinon", () => {
    const mission = { role: "user", content: "Corrige les tests" };
    const reponse = { role: "assistant", content: "ok" };
    expect(pinTaskAnchor([reponse], [mission], JOBS)).toEqual([
      { role: "user", content: `Corrige les tests\n\n${JOBS}`, _ephemeral: true, _task_anchor: true },
    ]);
    expect(pinTaskAnchor([reponse], [mission])).toEqual([
      { role: "user", content: "Corrige les tests", _ephemeral: true, _task_anchor: true },
    ]);
    expect(String(pinTaskAnchor([reponse], [], JOBS)[0]?.["content"]).endsWith(`.\n\n${JOBS}`)).toBe(true);
    expect(pinTaskAnchor([reponse, mission], [], JOBS)).toEqual([
      { role: "user", content: `${LEADING_ANCHOR_TEXT}\n\n${JOBS}`, _ephemeral: true },
    ]);
    expect(pinTaskAnchor([mission, reponse], [], JOBS)).toEqual([]);
    expect(jobsSurLaQuestion([mission, reponse], [], JOBS)).toEqual([
      { role: "user", content: `Corrige les tests\n\n${JOBS}` },
      reponse,
    ]);
    expect(jobsSurLaQuestion([mission, reponse], [], "")).toEqual([mission, reponse]);
  });
});

describe("JB-16 : reprise après compaction", () => {
  let b: Banc;

  beforeEach(async () => {
    b = await creerBanc();
    installerPortCompresseur(compresseurDuProcess(b.t.base));
    await creerChat(b, 1, "c1");
  });

  afterEach(async () => {
    installerPortCompresseur(null);
    await b.fermer();
  });

  it("la compaction épingle la mission avec les jobs actifs de la conversation et leur `resume_note`", async () => {
    const id = await lancerJob(b, 1, "c1", {
      label: "suite longue",
      resume_note: "If green, commit; else fix it.",
    });
    expect(await b.service.ligneAncre("alice", "c1")).toBe(
      `active jobs (you will be woken automatically, do not poll): ${id} "suite longue" wake_on=exit resume_note="If green, commit; else fix it."`,
    );
    expect(await b.service.ligneAncre("bob", "c1")).toBe("");
    const messages: Dict[] = [
      { role: "system", content: "socle" },
      { role: "user", content: "Lance la suite et corrige" },
      { role: "assistant", content: "x".repeat(4000) },
      { role: "user", content: "continue" },
      { role: "assistant", content: "y".repeat(4000) },
      { role: "user", content: "et maintenant ?" },
      { role: "assistant", content: "fini" },
    ];
    const compresseur = new ConversationCompressor(
      async () => [
        "## Contexte\n- suite de tests lancée en tâche de fond\n## Fait\n- premier lot corrigé",
        { model: "m" },
      ],
      {
        keepRecentTurns: 1,
        keepBridgeTurns: 0,
      },
    );
    const [sortie, stats] = await compresseur.compress(messages, {
      userId: "alice",
      ftsSessionId: "c1",
      force: true,
    });
    expect(stats["compressed"], JSON.stringify(stats)).toBe(true);
    const ancre = sortie.find((m) => m["_task_anchor"] === true);
    expect(String(ancre?.["content"])).toContain(`${id} "suite longue" wake_on=exit resume_note="If green`);
    const [sansJob] = await compresseur.compress(messages, {
      userId: "alice",
      ftsSessionId: "autre",
      force: true,
    });
    expect(String(sansJob.find((m) => m["_task_anchor"] === true)?.["content"])).not.toContain("active jobs");
    const compresseur2 = new ConversationCompressor(
      async () => [
        "## Contexte\n- suite de tests lancée en tâche de fond\n## Fait\n- premier lot corrigé",
        { model: "m" },
      ],
      {
        keepRecentTurns: 2,
        keepBridgeTurns: 0,
      },
    );
    const [question, st2] = await compresseur2.compress(messages, {
      userId: "alice",
      ftsSessionId: "c1",
      force: true,
    });
    expect(st2["compressed"], JSON.stringify(st2)).toBe(true);
    const roles = question.filter((m) => m["role"] !== "system").map((m) => m["role"]);
    expect(roles).toEqual(["user", "assistant"]);
    expect(question.find((m) => m["role"] === "user")?.["content"]).toBe(
      `et maintenant ?\n\nactive jobs (you will be woken automatically, do not poll): ${id} "suite longue" wake_on=exit resume_note="If green, commit; else fix it."`,
    );
    expect(messages[5]!["content"]).toBe("et maintenant ?");
  });
});
