// SPDX-License-Identifier: MIT
/** apps/core/test/tour/routes-compression.test.ts — compression manuelle : état du bouton et refus contre la vraie app FastAPI (vecteurs, SQLite et PostgreSQL) ; compaction persistée (état en tête, jalon en queue) et conflit avec un tour concurrent. */
import "../moteur-environnement";

import { readFileSync } from "node:fs";

import { mergeUserSettings } from "@elpis/auth";
import { pyJsonLoads } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { addChatPrunedKeys, getChat, upsertChat } from "../../src/chats/stockage";
import { pruneKey } from "../../src/contexte/elagage";
import { creerFamilleChatCompression, reglerCompressionPourTests } from "../../src/familles/chat-compression";
import { invalidateCache } from "../../src/llm/acces-moteurs";
import { brancherLlm } from "../../src/llm/branchement";
import { currentUsageCtx } from "../../src/observabilite/usage-contexte";
import type { UsageContext } from "../../src/observabilite/usage-contexte";
import { verrousChat, viderEtatPourTests } from "../../src/tour/etat";
import { appTest } from "../aides";

interface Chat {
  uid: number;
  id: string;
  messages: Dict[];
  etat?: [number, number];
  verrou?: string;
  elagage?: boolean;
}
const V = pyJsonLoads(
  readFileSync(new URL("../vecteurs/chat-compression.json", import.meta.url), "utf-8"),
) as {
  entrees: {
    chats: Chat[];
    reglages: Record<string, Dict>;
    requetes: [number, string, string, string | null][];
  };
  sorties: {
    etats: Record<string, Dict>;
    reponses: { statut: number; corps: string; entetes: Record<string, string | null> }[];
  };
};
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
// Écart voulu au Python (H-03) : la sortie élaguée du chat « outils » devient un condensé, plus long que le marqueur fixe.
const ECARTS_H03: Record<number, [string, string]> = {
  5: ['"tokens_estimate":276', '"tokens_estimate":282'],
};
const RESUME = "## Contexte\n- tâche en cours\n## Fait\n- fichiers lus\n## Suite\n- écrire le rapport";

describe.each(MOTEURS)("compression manuelle (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    brancherLlm(t.base);
    for (const nom of ["alice", "bob"])
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
        [nom, "s", "h", 0, 0],
      );
    for (const [uid, r] of Object.entries(V.entrees.reglages))
      await mergeUserSettings(t.base, Number(uid), (x) => void Object.assign(x, r));
    app = await appTest({
      familles: [creerFamilleChatCompression({ base: t.base })],
      gardes: {
        session: async (req) => {
          req.utilisateur = { id: Number(req.headers["x-uid"]), username: "x" };
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await t.fermer();
  });

  afterEach(() => {
    reglerCompressionPourTests(null);
    viderEtatPourTests();
  });

  async function poserChats(): Promise<void> {
    for (const c of V.entrees.chats) {
      const etat = V.sorties.etats[c.id];
      await upsertChat(t.base, c.uid, c.id, "T", etat ? [etat, ...c.messages] : c.messages, 100.0);
      if (c.elagage) {
        const hist = c.messages.at(-2)!["tool_history"] as Dict[];
        await addChatPrunedKeys(t.base, c.uid, c.id, [pruneKey(hist[1]!)]);
      }
      if (c.verrou) verrousChat.acquire(c.verrou, c.uid, c.id);
    }
  }

  it("réponses identiques au routeur Python (statut, corps à l'octet près, en-têtes)", async () => {
    await poserChats();
    for (const [i, [uid, method, url, corps]] of V.entrees.requetes.entries()) {
      const r = await app.inject({
        method: method as "GET" | "POST",
        url,
        headers: { "x-uid": String(uid), ...(corps === null ? {} : { "content-type": "application/json" }) },
        ...(corps === null ? {} : { payload: corps }),
      });
      const attendu = V.sorties.reponses[i]!;
      const ecart = ECARTS_H03[i];
      if (ecart) expect(attendu.corps, `${i} : l'écart H-03 existe encore`).toContain(ecart[0]);
      const corpsAttendu = ecart ? attendu.corps.replace(ecart[0], ecart[1]) : attendu.corps;
      expect([r.statusCode, r.body], `${method} ${url}`).toEqual([attendu.statut, corpsAttendu]);
      expect(String(r.headers["content-type"]).replace("; charset=utf-8", "")).toBe(
        attendu.entetes["content-type"],
      );
      expect(r.headers["cache-control"] ?? null).toBe(attendu.entetes["cache-control"]);
    }
  });

  it("compaction : état en tête, bulles intactes, jalon en queue ; le bouton passe au tour 1", async () => {
    const messages = V.entrees.chats.find((c) => c.id === "long")!.messages;
    await upsertChat(t.base, 1, "manuel", "T", messages, 100.0);
    const appels: Dict[][] = [];
    reglerCompressionPourTests(async (m) => {
      appels.push(m);
      return [RESUME, { model: "m" }];
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/chat/manuel/compress",
      headers: { "x-uid": "1" },
    });
    const corps = r.json() as Dict;
    expect(r.statusCode).toBe(200);
    expect(corps).toMatchObject({ ok: true, compressed: true, stats: { round: 1, max: 12 } });
    expect(appels).toHaveLength(1);
    const apres = (await getChat(t.base, 1, "manuel"))!["messages"] as Dict[];
    expect(apres[0]).toMatchObject({ role: "system" });
    expect(String(apres[0]!["content"])).toMatch(/^\[COMPRESSION_META v=1 round=1 /u);
    expect(apres.slice(1, -1)).toEqual(messages);
    expect(apres.at(-1)).toMatchObject({ role: "notice", kind: "compaction", round: 1 });
    expect(String(apres.at(-1)!["content"])).toMatch(
      /^Conversation compactée — contexte ≈ \d[\d ]* tokens$/u,
    );
    const etat = await app.inject({
      method: "GET",
      url: "/api/chat/manuel/compression-state",
      headers: { "x-uid": "1" },
    });
    expect(etat.json()).toMatchObject({ round: 1, reason: "too_short" });
    expect(verrousChat.isHeld("compact", 1, "manuel")).toBe(false);
  });

  it("compaction : l'appel du résumé compte pour le compte et la conversation (source « compression »)", async () => {
    const messages = V.entrees.chats.find((c) => c.id === "long")!.messages;
    await upsertChat(t.base, 1, "usage", "T", messages, 100.0);
    let vu: UsageContext | null = null;
    reglerCompressionPourTests(async () => {
      vu = currentUsageCtx();
      return [RESUME, { model: "m" }];
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/chat/usage/compress",
      headers: { "x-uid": "1" },
    });
    expect(r.statusCode).toBe(200);
    expect(vu).toEqual({ source: "compression", userId: 1, originId: "usage", parentId: "" });
  });

  it("deux compactions simultanées du même chat : le verrou « compact » est rendu", async () => {
    const messages = V.entrees.chats.find((c) => c.id === "long")!.messages;
    await upsertChat(t.base, 1, "double", "T", messages, 100.0);
    reglerCompressionPourTests(async () => [RESUME, { model: "m" }]);
    const poster = () =>
      app.inject({ method: "POST", url: "/api/chat/double/compress", headers: { "x-uid": "1" } });
    const statuts = (await Promise.all([poster(), poster()])).map((r) => r.statusCode);
    expect(statuts).toContain(200);
    expect(verrousChat.isHeld("compact", 1, "double")).toBe(false);
  });

  it("chat modifié pendant la compaction : 409 chat_modified, rien d'écrasé", async () => {
    const messages = V.entrees.chats.find((c) => c.id === "long")!.messages;
    await upsertChat(t.base, 1, "concurrent", "T", messages, 100.0);
    reglerCompressionPourTests(async () => {
      await upsertChat(t.base, 1, "concurrent", "T", [{ role: "user", content: "autre onglet" }], 200.0);
      return [RESUME, { model: "m" }];
    });
    const r = await app.inject({
      method: "POST",
      url: "/api/chat/concurrent/compress",
      headers: { "x-uid": "1" },
    });
    expect([r.statusCode, r.json()]).toEqual([
      409,
      { ok: false, compressed: false, reason: "chat_modified" },
    ]);
    expect((await getChat(t.base, 1, "concurrent"))!["messages"]).toEqual([
      { role: "user", content: "autre onglet" },
    ]);
  });

  it("politiques d'accès illisibles : 503 access_check_failed, pas un refus 409", async () => {
    const messages = V.entrees.chats.find((c) => c.id === "long")!.messages;
    await upsertChat(t.base, 1, "panne", "T", messages, 100.0);
    reglerCompressionPourTests(async () => [RESUME, { model: "m" }]);
    await t.base.exec("ALTER TABLE user_groups RENAME TO user_groups_hs");
    invalidateCache(t.base);
    try {
      const r = await app.inject({
        method: "POST",
        url: "/api/chat/panne/compress",
        headers: { "x-uid": "1" },
      });
      expect([r.statusCode, r.json()]).toEqual([
        503,
        {
          detail: {
            code: "engine_unavailable",
            reason: "access_check_failed",
            message: "Contrôle d'accès au serveur indisponible, réessayez.",
          },
        },
      ]);
    } finally {
      await t.base.exec("ALTER TABLE user_groups_hs RENAME TO user_groups");
      invalidateCache(t.base);
    }
  });
});
