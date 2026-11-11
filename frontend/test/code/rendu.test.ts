// SPDX-License-Identifier: MIT
/** frontend/test/code/rendu.test.ts — rendu du transcript opencode : diff unifié, parts brutes en éléments typés, lecture défensive. */
import { describe, expect, it } from "vitest";

import { analyserDiff, decouperFencesDiff, etapes, ressembleADiff } from "../../src/features/code/rendu";
import type { MessageOpencode } from "../../src/features/code/rendu";

const DIFF =
  "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n ctx\n-vieux\n+neuf\n";

function message(parts: MessageOpencode["parts"], info: MessageOpencode["info"] = {}): MessageOpencode {
  return { id: "m1", role: "assistant", parts, info };
}

describe("diff unifié", () => {
  it("sépare les fichiers, compte les ajouts et suppressions", () => {
    const [f] = analyserDiff("p1", DIFF);
    expect(f?.path).toBe("src/a.ts");
    expect([f?.additions, f?.deletions]).toEqual([1, 1]);
    expect(f?.lines.map((l) => l.t)).toEqual(["hunk", "ctx", "del", "add"]);
  });

  it("accepte un diff sans en-têtes et rend le même objet depuis le cache", () => {
    const a = analyserDiff("p2", "@@ -1 +1 @@\n-a\n+b");
    expect(a).toHaveLength(1);
    expect(analyserDiff("p2", "@@ -1 +1 @@\n-a\n+b")).toBe(a);
    expect(analyserDiff("p3", "")).toEqual([]);
  });

  it("reconnaît une sortie d'outil qui est un diff", () => {
    expect(ressembleADiff(DIFF)).toBe(true);
    expect(ressembleADiff("hello\n+++ x\n@@")).toBe(false);
    expect(ressembleADiff("   ")).toBe(false);
  });

  it("découpe les blocs diff fermés d'un texte", () => {
    const segs = decouperFencesDiff("avant\n```diff\n+x\n```\naprès ```diff\n+ouvert");
    expect(segs.map((s) => [s.diff === true, s.text])).toEqual([
      [false, "avant\n"],
      [true, "+x"],
      [false, "\naprès ```diff\n+ouvert"],
    ]);
  });
});

describe("parts en éléments", () => {
  it("rend texte, réflexion terminée et étape intermédiaire", () => {
    const els = etapes(
      message(
        [
          { id: "a", type: "step-start" },
          { id: "b", type: "reasoning", text: "je pense", time: { start: 1000, end: 3000 } },
          { id: "c", type: "text", text: "réponse" },
          { id: "d", type: "step-start" },
          { id: "e", type: "snapshot" },
          { id: "f", type: "mystère" },
        ],
        { time: { completed: 5 } },
      ),
    );
    expect(els.map((e) => e.kind)).toEqual(["think", "text", "step", "unknown"]);
    expect(els[0]).toMatchObject({ done: true });
  });

  it("décrit un outil edit terminé avec son diff, sa métrique et sa mémoïsation", () => {
    const part = {
      id: "t1",
      type: "tool",
      tool: "edit",
      state: {
        status: "completed",
        metadata: { filepath: "src/a.ts", diff: DIFF, filediff: { additions: 3, deletions: 1 } },
      },
    };
    const [el] = etapes(message([part]));
    expect(el).toMatchObject({
      kind: "tool",
      tool: "edit",
      subject: "src/a.ts",
      metric: "+3 −1",
      icon: "ph-pencil-simple",
      running: false,
    });
    expect(etapes(message([part]))[0]).toBe(el);
  });

  it("fabrique un diff pour write et marque un outil en cours", () => {
    const els = etapes(
      message([
        {
          id: "w",
          type: "tool",
          tool: "write",
          state: { status: "completed", input: { filePath: "n.txt", content: "a\nb\n" } },
        },
        { id: "r", type: "tool", tool: "bash", state: { status: "running", input: { command: "ls\npwd" } } },
      ]),
    );
    expect(els[0]).toMatchObject({ kind: "tool" });
    expect((els[0] as { diff: string }).diff).toContain("+++ b/n.txt");
    expect(els[1]).toMatchObject({ running: true, subject: "ls", icon: "ph-terminal" });
  });

  it("ajoute le statut d'activité du message en direct", () => {
    const els = etapes(message([{ id: "x", type: "reasoning", text: "…", time: { start: 42 } }]), true);
    expect(els[els.length - 1]).toMatchObject({ kind: "status", phase: "Réflexion", since: 42 });
    expect(etapes(message([]), true)[0]).toMatchObject({ kind: "status", phase: "Génération" });
  });

  it("ignore les parts synthétiques et ouvre un sous-agent", () => {
    const els = etapes(
      message([
        { id: "s", type: "text", text: "caché", synthetic: true },
        {
          id: "k",
          type: "subtask",
          agent: "explore",
          description: "cherche\nplus",
          prompt: "p",
          model: { modelID: "m" },
        },
        { id: "c", type: "compaction", auto: true },
      ]),
    );
    expect(els).toMatchObject([
      { kind: "subtask", agent: "explore", desc: "cherche", model: "m" },
      { kind: "compaction", label: "Contexte compacté" },
    ]);
  });
});
