// SPDX-License-Identifier: MIT
/** apps/toolhost/test/desktop.test.ts — famille desktop servie par l'hôte : tools/list identique aux goldens Python selon l'exposition, outil masqué refusé à l'appel, appel réel pour le compte du `_meta`. */
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";

import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import { configTest, hoteTest, SVC } from "./aides";

const golden = (nom: string): Dict[] =>
  (
    JSON.parse(
      readFileSync(new URL(`../../../packages/outils-mcp/goldens/${nom}.json`, import.meta.url), "utf-8"),
    ) as { outils: Dict[] }
  ).outils;

const ouverts: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const f of ouverts.splice(0).reverse()) await f();
});

async function desktop(reglages: Record<string, boolean> = {}): Promise<Client> {
  ouverts.push(
    surchargerConfig({ DESKTOP_DISABLE_SHELL: false, DESKTOP_EXPOSE_RAW_TOOLS: false, ...reglages }),
  );
  const h = await hoteTest(configTest({ families: ["fs", "desktop"], familles_natives: ["desktop"] }));
  await h.app.listen({ port: 0, host: "127.0.0.1" });
  ouverts.push(() => h.fermer());
  expect(h.composition.natif?.familles.map((f) => f.famille)).toEqual(["desktop"]);
  const base = `http://127.0.0.1:${(h.app.server.address() as AddressInfo).port}`;
  const c = new Client({ name: "essai", version: "1" });
  await c.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp/desktop`), {
      requestInit: { headers: { authorization: `Bearer ${SVC}` } },
    }),
  );
  ouverts.push(() => c.close());
  return c;
}

describe("famille desktop servie par l'hôte", () => {
  it("tools/list : les 11 outils du golden Python, définitions identiques", async () => {
    const c = await desktop();
    expect((await c.listTools()).tools).toEqual(golden("desktop"));
  });

  it("DESKTOP_EXPOSE_RAW_TOOLS : desktop_screenshot et desktop_inspect en plus, comme le Python", async () => {
    const c = await desktop({ DESKTOP_EXPOSE_RAW_TOOLS: true });
    expect((await c.listTools()).tools).toEqual([...golden("desktop"), ...golden("desktop-brut")]);
  });

  it("DESKTOP_DISABLE_SHELL : desktop_shell ni listé ni appelable", async () => {
    const c = await desktop({ DESKTOP_DISABLE_SHELL: true });
    const noms = (await c.listTools()).tools.map((t) => t.name);
    expect(noms).not.toContain("desktop_shell");
    expect(noms).toHaveLength(10);
    await expect(c.callTool({ name: "desktop_shell", arguments: { command: "id" } })).rejects.toThrow(
      "Unknown tool: 'desktop_shell'",
    );
  });

  it("outil listé au démarrage puis masqué (DESKTOP_DISABLE_SHELL) : refusé à l'appel", async () => {
    const c = await desktop();
    expect((await c.listTools()).tools.map((t) => t.name)).toContain("desktop_shell");
    ouverts.push(surchargerConfig({ DESKTOP_DISABLE_SHELL: true }));
    const r = await c.callTool({ name: "desktop_shell", arguments: { command: "id" } });
    expect(r.isError).toBe(true);
    expect((r.content as { text: string }[])[0]?.text).toContain("desktop tool not exposed: desktop_shell");
  });

  it("appel réel pour le compte du `_meta` : sans cible configurée, l'erreur du Python", async () => {
    const c = await desktop();
    ouverts.push(surchargerConfig({ DESKTOP_TARGETS: [] }));
    const r = await c.callTool({ name: "desktop_session", arguments: {}, _meta: { username: "hugo" } });
    expect(r.isError).toBe(true);
    expect(JSON.parse((r.content as { text: string }[])[0]?.text ?? "")).toEqual({
      ok: false,
      error: "no_target",
      message: "no desktop control target is configured",
      fix: "add one in Admin → Vision & Desktop (name, OS, agent URL)",
      next_action: "ask the user to configure a target, then retry",
    });
    const mauvais = await c.callTool({ name: "desktop_wait", arguments: { count: "beaucoup" } });
    expect(mauvais.isError).toBe(true);
  });
});
