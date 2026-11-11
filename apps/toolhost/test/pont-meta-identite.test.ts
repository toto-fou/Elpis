// SPDX-License-Identifier: MIT
/** apps/toolhost/test/pont-meta-identite.test.ts — pont core → hôte d'outils en HTTP : `_meta` construit par la boucle du core (buildCallMeta), porté par son client MCP avec le jeton de service, reçu et résolu par l'hôte champ par champ. */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { getChatId, getUsername } from "@elpis/outils-mcp";
import type { ContexteAppel } from "@elpis/outils-mcp";
import { current } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildCallMeta } from "../../core/src/boucle/dispatch-outils";
import { ClientMcpHttp, pickToolPayload } from "../../core/src/outils/mcp/clients";
import type { FabriqueNative } from "../src/mcp/natives";
import { configTest, hoteTest, SVC } from "./aides";

const ENV_AVANT = { ...process.env };
let dossier = "";
let coeur: Server;
let urlCoeur = "";
const demandes: string[] = [];

/** Famille d'essai : un outil qui rend le `_meta` reçu et l'identité résolue par l'hôte. */
const familleIdentite: FabriqueNative = () => ({
  famille: "todo",
  outils: [
    {
      nom: "todo_qui",
      famille: "todo",
      definition: {
        name: "todo_qui",
        description: "Identité de l'appel.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
      },
      signature: {},
      traiter: (_args: Dict, ctx: ContexteAppel) => ({
        ok: true,
        recu: ctx.meta,
        compte: getUsername(ctx),
        chat: getChatId(ctx),
        user_id: current()?.user_id ?? null,
        chat_identite: current()?.chat_id ?? null,
      }),
    },
  ],
});

beforeAll(async () => {
  dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-pont-meta-")));
  for (const [k, v] of Object.entries({
    APP_CONFIG_PATH: path.join(dossier, "config.json"),
    APP_FILE_HISTORY_DIR: path.join(dossier, "fh"),
    ELPIS_AUDIT_DIR: path.join(dossier, "audit"),
    APP_MCP_MANIFEST: path.join(dossier, "absent-mcp.json"),
  }))
    process.env[k] = v;
  coeur = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://coeur");
    const nom = u.searchParams.get("username") ?? "";
    demandes.push(`${u.pathname}|${nom}`);
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(
        JSON.stringify({ ok: true, user_id: 42, username: nom, is_admin: false, network_profile_id: "lan" }),
      );
  });
  await new Promise<void>((fin) => coeur.listen(0, "127.0.0.1", () => fin()));
  urlCoeur = `http://127.0.0.1:${(coeur.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((fin) => coeur.close(() => fin()));
  for (const k of Object.keys(process.env)) if (!(k in ENV_AVANT)) delete process.env[k];
  Object.assign(process.env, ENV_AVANT);
  if (dossier) rmSync(dossier, { recursive: true, force: true });
});

/** Appels de `todo_qui` par le client MCP du core, en HTTP avec le jeton de service ; rend ce que l'hôte a vu. */
async function vues(appUrl: string, metas: (Dict | null)[]): Promise<Dict[]> {
  const h = await hoteTest(
    configTest({
      families: ["todo"],
      familles_natives: ["todo"],
      db_path: path.join(dossier, "toolhost.db"),
      sandbox_dir: path.join(dossier, "sb"),
      app_url: appUrl,
    }),
    { natives: { todo: familleIdentite } },
  );
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  const base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  const cl = new ClientMcpHttp(`${base}/mcp/todo`, { Authorization: `Bearer ${SVC}` });
  const signal = AbortSignal.timeout(30_000);
  try {
    await cl.connecter(signal);
    const sorties: Dict[] = [];
    for (const meta of metas)
      sorties.push(
        pickToolPayload(await cl.appelerOutil("todo_qui", {}, { ...(meta ? { meta } : {}), signal })) as Dict,
      );
    return sorties;
  } finally {
    await cl.fermer();
    await h.fermer();
  }
}

const meta = (o: { username?: string; userId?: number | null; chatId?: string; isLocal?: boolean }) =>
  buildCallMeta({
    isLocal: o.isLocal ?? true,
    username: o.username ?? "alice",
    userId: o.userId === undefined ? 7 : o.userId,
    chatId: o.chatId ?? "c1",
    liveShell: false,
    callId: "k1",
    runLogTok: "r1",
  });

describe("pont core → hôte d'outils : `_meta` de l'appel d'outil", () => {
  it("buildCallMeta → client MCP du core → hôte : username, user_id, chat_id, call_id, log_token reçus tels quels ; compte et id résolus sans rappel", async () => {
    demandes.length = 0;
    const [v] = await vues(urlCoeur, [meta({})]);
    const recu = (v?.["recu"] ?? {}) as Dict;
    expect(recu["username"]).toBe("alice");
    expect(recu["user_id"]).toBe("7");
    expect(recu["chat_id"]).toBe("c1");
    expect(recu["call_id"]).toBe("k1");
    expect(recu["log_token"]).toBe("r1:k1");
    expect(recu["live_shell"]).toBeUndefined();
    expect(v?.["compte"]).toBe("alice");
    expect(v?.["user_id"]).toBe(7);
    expect(v?.["chat"]).toBe("c1");
    expect(v?.["chat_identite"]).toBe("c1");
    expect(demandes).toEqual([]);
  });

  it("user_id absent ou illisible : id redemandé au core par le nom (rappel), jamais pris à un autre compte ; sans URL du core : 0", async () => {
    demandes.length = 0;
    const sansId = meta({ userId: null });
    expect(sansId && "user_id" in sansId).toBe(false);
    const [a, b] = await vues(urlCoeur, [sansId, { username: "alice", user_id: "abc", chat_id: "c1" }]);
    expect([a?.["compte"], a?.["user_id"], b?.["compte"], b?.["user_id"]]).toEqual([
      "alice",
      42,
      "alice",
      42,
    ]);
    // Une seule demande : la réponse du core est gardée par nom de compte.
    expect(demandes).toEqual(["/api/internal/identity|alice"]);
    demandes.length = 0;
    const [c] = await vues("", [sansId]);
    expect([c?.["compte"], c?.["user_id"]]).toEqual(["alice", 0]);
    expect(demandes).toEqual([]);
  });

  it("jeton de service = core de confiance : user_id du `_meta` pris tel quel (comme IdentityCapture du Python) ; outil d'un serveur externe : aucun `_meta`, compte invité", async () => {
    demandes.length = 0;
    const [confiance, externe] = await vues(urlCoeur, [
      meta({ username: "bob", userId: 3, chatId: "c9" }),
      meta({ isLocal: false }),
    ]);
    expect([confiance?.["compte"], confiance?.["user_id"], confiance?.["chat"]]).toEqual(["bob", 3, "c9"]);
    expect(meta({ isLocal: false })).toBeNull();
    expect([externe?.["recu"], externe?.["compte"], externe?.["user_id"]]).toEqual([null, "guest", null]);
    expect(demandes).toEqual([]);
  });
});
