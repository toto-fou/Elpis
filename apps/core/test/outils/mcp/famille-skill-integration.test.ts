// SPDX-License-Identifier: MIT
/** apps/core/test/outils/mcp/famille-skill-integration.test.ts — famille skill servie en processus : client `inprocess` du pool, pont /api/mcp-bridge/skill (jeton d'outils, identité, portée), façade OpenAPI (famille du compte non exposée), écritures sous verrou. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut } from "@elpis/auth";
import type { DependancesOAuth } from "@elpis/auth";
import { configView, invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { load, oublierManifeste } from "@elpis/mcp";
import type { Golden } from "@elpis/outils-mcp";
import { tokenDigest } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { creerFamilleOpenapi } from "../../../src/familles/openapi";
import { creerPontMcp } from "../../../src/familles/pont-mcp";
import type { PontMcp } from "../../../src/familles/pont-mcp";
import { EXPOSABLE_FAMILIES, familyCfg } from "../../../src/outils/openapi";
import { resoudreClientMcp } from "../../../src/outils/mcp/clients";
import {
  creerServeurEnProcessus,
  enregistrerFamillesEnProcessus,
  oublierServeurEnProcessus,
  serveurEnProcessus,
  serviceEnProcessus,
} from "../../../src/outils/mcp/en-processus";
import { outilsSkill } from "../../../src/outils/mcp/famille-skill";
import { appTest, journalMuet } from "../../aides";
import { poserEnv } from "../../skills/arbre";

type Dict = Record<string, unknown>;

const GOLDEN = JSON.parse(
  readFileSync(new URL("../../../../../packages/outils-mcp/goldens/skill.json", import.meta.url), "utf-8"),
) as Golden;
const OPENCODE = "pcr_" + "a".repeat(40);
const OPENCODE_BOB = "pcr_" + "b".repeat(40);
const OUTILS_FS = "ept_" + "f".repeat(40);
const J = { "content-type": "application/json", accept: "application/json, text/event-stream" };
const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
};

function messages(texte: string): Dict[] {
  return texte
    .split("\r\n\r\n")
    .filter((b) => b.startsWith("event: message"))
    .map((b) => JSON.parse(b.split("\r\ndata: ")[1] ?? "null") as Dict);
}

describe("famille skill servie en processus", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let pont: PontMcp;
  let dossier: string;
  let restaurer: () => void;
  let remettreEnv: () => void;
  let base = "";

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 1 });
    await createUser(t.base, "bob", "mdp-bob", { isAdmin: 0 });
    for (const [jeton, uid, type, familles] of [
      [OPENCODE, 1, "opencode", ""],
      [OPENCODE_BOB, 2, "opencode", ""],
      [OUTILS_FS, 1, "tools", "fs"],
    ] as const)
      await t.base.run(
        "INSERT INTO tool_tokens(user_id, kind, name, token_hash, hint, families, created_at) VALUES(?,?,?,?,?,?,?)",
        [uid, type, type, tokenDigest(jeton), jeton.slice(-4), familles, Date.now() / 1000],
      );
    dossier = mkdtempSync(join(tmpdir(), "elpis-skill-integration-"));
    await mkdir(join(dossier, "global"), { recursive: true });
    writeFileSync(
      join(dossier, "config.json"),
      JSON.stringify({ mcp: { tokens: { tools_families: "skill,fs" } } }),
    );
    writeFileSync(
      join(dossier, "mcp.json"),
      JSON.stringify({
        version: 1,
        mcpServers: { "elpis-skill": { "x-elpis": { role: "app", families: ["skill"] } } },
      }),
    );
    remettreEnv = poserEnv({
      APP_SKILLS_DIR: join(dossier, "global"),
      APP_USER_SKILLS_DIR: join(dossier, "user_skills"),
      APP_SANDBOX_DIR: join(dossier, "sandboxes"),
      SKILLS_LOCK_PATH: join(dossier, "skills.lock"),
    });
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    vi.stubEnv("APP_MCP_MANIFEST", join(dossier, "mcp.json"));
    oublierManifeste();
    creerServeurEnProcessus({ famillesOpencode: ["skill"], limiteDebit: null, limiteConcurrence: null });
    enregistrerFamillesEnProcessus([["skill", outilsSkill()]]);
    const oauth: DependancesOAuth = { base: t.base, config: () => configView() };
    const jetons = dependancesParDefaut(t.base);
    pont = creerPontMcp({
      jetons,
      oauth,
      journal: journalMuet,
      reverificationMs: 50,
      enProcessus: () => serviceEnProcessus(),
    });
    app = await appTest({
      familles: [pont.famille, creerFamilleOpenapi({ jetons, journal: journalMuet })],
      extensions: [pont.extension],
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    try {
      await serviceEnProcessus()?.fermer();
      app?.server.closeAllConnections();
      await app?.close();
    } finally {
      oublierServeurEnProcessus();
      vi.unstubAllEnvs();
      oublierManifeste();
      restaurer?.();
      remettreEnv?.();
      invalidateConfigCache();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("la famille est enregistrée une fois, dans l'ordre de register_library", () => {
    expect(serveurEnProcessus()?.famillesActives).toEqual(["skill"]);
    expect(enregistrerFamillesEnProcessus([["skill", outilsSkill()]])).toEqual([]);
  });

  it("client inprocess du pool : tools/list identique au golden, appels avec l'identité du _meta, erreurs en isError", async () => {
    const entree = load().get("elpis-skill");
    expect(entree?.type).toBe("inprocess");
    const client = resoudreClientMcp(entree?.clientCfg() ?? {});
    expect(client?.constructor.name).toBe("ClientMcpEnProcessus");
    if (client === null) return;
    const signal = new AbortController().signal;
    await client.connecter(signal);
    try {
      const outils = (await client.listerOutils(signal)) as Dict[];
      expect(outils.map((o) => o["name"])).toEqual(GOLDEN.outils.map((o) => o["name"]));
      for (const [i, o] of outils.entries()) {
        const attendu = GOLDEN.outils[i] as Dict;
        for (const cle of ["title", "description", "inputSchema", "outputSchema", "annotations", "_meta"])
          expect(o[cle], `${o["name"] as string}.${cle}`).toEqual(attendu[cle]);
      }
      const meta = { username: "alice", user_id: 1 };
      const sauve = (await client.appelerOutil(
        "skill_save",
        { name: "Déployer", description: "d", body: "corps", tags: ["a"] },
        { meta, signal },
      )) as Dict;
      expect(sauve["isError"]).toBe(false);
      const structure = (sauve["structuredContent"] as Dict)["result"] as Dict;
      expect(structure).toMatchObject({ ok: true, name: "deployer", source: "user", tags: ["a"] });
      expect(String(structure["path"])).toBe(join(dossier, "user_skills", "alice", "deployer", "SKILL.md"));
      const lu = (await client.appelerOutil("skill_get", { name: "deployer" }, { meta, signal })) as Dict;
      expect(((lu["structuredContent"] as Dict)["result"] as Dict)["body"]).toBe("corps");
      const bob = (await client.appelerOutil(
        "skill_get",
        { name: "deployer" },
        { meta: { username: "bob", user_id: 2 }, signal },
      )) as Dict;
      expect(bob["isError"]).toBe(true);
      expect(JSON.parse(((bob["content"] as Dict[])[0] as Dict)["text"] as string)).toMatchObject({
        ok: false,
        error: "skill_not_found",
      });
      const invalide = (await client.appelerOutil("skill_get", {}, { meta, signal })) as Dict;
      expect(invalide["isError"]).toBe(true);
      expect(((invalide["content"] as Dict[])[0] as Dict)["text"]).toContain(
        "1 validation error for call[skill_get]",
      );
    } finally {
      await client.fermer();
    }
  });

  async function poster(chemin: string, entetes: Record<string, string>, corps: unknown) {
    const r = await fetch(base + chemin, {
      method: "POST",
      headers: { ...J, ...entetes },
      body: JSON.stringify(corps),
    });
    return { statut: r.status, entetes: r.headers, texte: await r.text() };
  }

  async function session(jeton: string): Promise<Record<string, string>> {
    const auth = { authorization: `Bearer ${jeton}` };
    const init = await poster("/api/mcp-bridge/skill", auth, INIT);
    expect(init.statut).toBe(200);
    const S = { ...auth, "mcp-session-id": init.entetes.get("mcp-session-id") ?? "" };
    await poster("/api/mcp-bridge/skill", S, { jsonrpc: "2.0", method: "notifications/initialized" });
    return S;
  }

  async function appeler(S: Record<string, string>, id: number, nom: string, args: Dict, meta?: Dict) {
    const r = await poster("/api/mcp-bridge/skill", S, {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: nom, arguments: args, ...(meta ? { _meta: meta } : {}) },
    });
    return (messages(r.texte).find((m) => m["id"] === id)?.["result"] ?? null) as Dict;
  }

  it("pont /api/mcp-bridge/skill : jeton opencode, cinq outils, compte du jeton (un _meta menteur est ignoré), cloisonnement", async () => {
    const S = await session(OPENCODE);
    const liste = messages(
      (await poster("/api/mcp-bridge/skill", S, { jsonrpc: "2.0", id: 2, method: "tools/list" })).texte,
    );
    expect(((liste[0]?.["result"] as Dict)["tools"] as Dict[]).map((o) => o["name"])).toEqual(
      GOLDEN.outils.map((o) => o["name"]),
    );
    const r = await appeler(
      S,
      3,
      "skill_save",
      { name: "Pont", description: "d", body: "via le pont" },
      { username: "mallory", user_id: 99 },
    );
    expect((r["structuredContent"] as Dict)["result"]).toMatchObject({ ok: true, name: "pont" });
    expect(await readFile(join(dossier, "user_skills", "alice", "pont", "SKILL.md"), "utf8")).toContain(
      "via le pont",
    );
    const SB = await session(OPENCODE_BOB);
    const refus = await appeler(SB, 5, "skill_get", { name: "pont" });
    expect(refus["isError"]).toBe(true);
    expect(JSON.parse(((refus["content"] as Dict[])[0] as Dict)["text"] as string)["error"]).toBe(
      "skill_not_found",
    );
  });

  it("pont : un jeton sans la famille voit une liste vide ; façade OpenAPI : famille du compte non exposée (404)", async () => {
    const S = await session(OUTILS_FS);
    const liste = messages(
      (await poster("/api/mcp-bridge/skill", S, { jsonrpc: "2.0", id: 2, method: "tools/list" })).texte,
    );
    expect((liste[0]?.["result"] as Dict)["tools"]).toEqual([]);
    expect(EXPOSABLE_FAMILIES).not.toContain("skill");
    expect(familyCfg("skill")).toBeNull();
    for (const chemin of ["/api/tools/skill/openapi.json", "/api/tools/skill/skill_get"]) {
      const r = await fetch(base + chemin, {
        method: chemin.endsWith("json") ? "GET" : "POST",
        headers: { authorization: `Bearer ${OUTILS_FS}`, "content-type": "application/json" },
        body: chemin.endsWith("json") ? undefined : "{}",
      });
      expect([chemin, r.status]).toEqual([chemin, 404]);
      await r.arrayBuffer();
    }
  });
});
