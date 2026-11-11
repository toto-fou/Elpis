// SPDX-License-Identifier: MIT
/** apps/core/test/code/greffon-resynchro.test.ts — greffon opencode : un instantané de session raté est republié à l'event suivant. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type Dict = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const CHEMIN_GREFFON = "../../greffon-opencode/elpis-remote";

describe("greffon : resynchronisation des sessions", () => {
  const vraiFetch = globalThis.fetch;
  const vraiHome = process.env["HOME"];
  let home = "";
  afterEach(() => {
    globalThis.fetch = vraiFetch;
    if (vraiHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = vraiHome;
    if (home) rmSync(home, { recursive: true, force: true });
    vi.resetModules();
  });

  it("l'app injoignable au premier instantané : l'event suivant de la session le relance", async () => {
    home = mkdtempSync(join(tmpdir(), "elpis-greffon-"));
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(
      join(home, ".config", "opencode", "elpis-remote.json"),
      JSON.stringify({ app_url: "http://app.test", token: "pcr_x", enabled: true }),
    );
    process.env["HOME"] = home;
    const snapshots: number[] = [];
    let panne = true;
    globalThis.fetch = (async (url: string, init: Dict = {}) => {
      if (String(url).includes("/api/code/pull"))
        return new Promise((_ok, ko) =>
          init["signal"]?.addEventListener("abort", () => ko(new Error("abort"))),
        );
      if (String(url).includes("/api/code/ingest")) {
        const evs = JSON.parse(init["body"]).events as Dict[];
        if (evs.some((e) => e["type"] === "session.snapshot")) {
          snapshots.push(1);
          if (panne) {
            panne = false;
            throw new Error("ECONNREFUSED");
          }
        }
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const generique = (): Dict =>
      new Proxy(async () => ({ data: [] }), { get: (_c, p) => (p === "then" ? undefined : generique()) });
    const client = {
      session: { get: async () => ({ data: { id: "s1" } }), messages: async () => ({ data: [] }) },
      tui: { showToast: async () => ({}), publish: async () => ({}) },
      app: generique(),
      command: generique(),
      config: generique(),
      provider: generique(),
    };
    const { ElpisRemote } = await import(/* @vite-ignore */ CHEMIN_GREFFON);
    const hooks = (await ElpisRemote({
      client,
      directory: join(home, "projet"),
      serverUrl: "",
    } as never)) as Dict;
    try {
      const evenement = {
        event: { type: "session.updated", properties: { sessionID: "s1", info: { id: "s1" } } },
      };
      await hooks["event"](evenement);
      await vi.waitFor(() => expect(snapshots).toHaveLength(1));
      await hooks["event"](evenement);
      await vi.waitFor(() => expect(snapshots).toHaveLength(2));
    } finally {
      await hooks["dispose"]();
    }
  });
});
