// SPDX-License-Identifier: MIT
/** apps/core/test/outils/todo/persistance.test.ts — `todowrite` sur une vraie base (SQLite et PostgreSQL) : liste du chat relue, remplacée, chat inconnu non enregistré. */
import "../../moteur-environnement";

import { createUser, getUser } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { getChat, getChatTodos, setChatTodos, setChatTools, upsertChat } from "../../../src/chats/stockage";
import { dependancesTodo, todowrite } from "../../../src/outils/todo";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

describe.each(MOTEURS)("todowrite sur la base du compte (%s)", (moteur) => {
  let t: BaseDeTest;
  let uid = 0;
  const dep = (): ReturnType<typeof dependancesTodo> =>
    dependancesTodo(t.base, { idUtilisateur: async (nom) => (await getUser(t.base, nom))?.id ?? null });

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 0 });
    uid = (await getUser(t.base, "alice"))?.id ?? 0;
    await upsertChat(t.base, uid, "c1", "Chat", [], 1_700_000_000);
    await setChatTools(t.base, uid, "c1", ["fs"]);
  });
  afterAll(async () => {
    await t.fermer();
  });

  it("enregistre la liste normalisée dans le chat, sans toucher aux autres réglages du chat", async () => {
    const r = await todowrite(dep(), { username: "alice", chatId: "c1" }, [
      { content: "a", status: "in_progress", priority: "high" },
      "b",
    ]);
    expect(r.persisted).toBe(true);
    expect(await getChatTodos(t.base, uid, "c1")).toEqual([
      { content: "a", status: "in_progress", priority: "medium" },
      { content: "b", status: "pending", priority: "medium" },
    ]);
    expect((await getChat(t.base, uid, "c1"))?.["tools"]).toEqual(["fs"]);
  });

  it("relit la liste précédente : statut hérité, priorité reprise, liste inchangée signalée, remplacement total", async () => {
    await setChatTodos(t.base, uid, "c1", [
      { content: "a", status: "in_progress", priority: "medium" },
      { content: "b", status: "pending", priority: "medium" },
    ]);
    const r = await todowrite(dep(), { username: "alice", chatId: "c1" }, [
      { content: "a" },
      { content: "b" },
    ]);
    expect(r.todos.map((x) => x.status)).toEqual(["in_progress", "pending"]);
    expect(r.notes).toHaveLength(3);
    expect(r.notes[2]).toContain("List unchanged");
    const vide = await todowrite(dep(), { username: "alice", chatId: "c1" }, []);
    expect(vide.total).toBe(0);
    expect(await getChatTodos(t.base, uid, "c1")).toEqual([]);
  });

  it("chat inconnu, chat « default », compte inconnu ou sans chat : résultat complet mais persisted faux", async () => {
    await setChatTodos(t.base, uid, "c1", []);
    for (const [username, chatId] of [
      ["alice", "inconnu"],
      ["alice", "default"],
      ["alice", ""],
      ["nobody", "c1"],
    ] as const) {
      const r = await todowrite(dep(), { username, chatId }, [{ content: "x", status: "pending" }]);
      expect(r.persisted, `${username}/${chatId}`).toBe(false);
      expect(r.checklist).toBe("1. [pending] x");
    }
    expect(await getChatTodos(t.base, uid, "c1")).toEqual([]);
  });
});
