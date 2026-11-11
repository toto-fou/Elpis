// SPDX-License-Identifier: MIT
/** packages/navigateur/test/mode.test.ts — résolveur du service navigateur d'un compte : central (URL et jeton de l'instance) ou socket et jeton de son bac ; requête par le socket, refus d'un lien posé à sa place. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { AGENT_RUN_DIR } from "@elpis/bac";
import { surchargerConfig } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { cheminsNavigateurBac, requeteService, serviceNavigateur } from "../src/mode";

const tmp = mkdtempSync(path.join(tmpdir(), "nav-mode-"));
let restaurer: () => void = () => undefined;

beforeAll(() => {
  restaurer = surchargerConfig({
    CONFIG_JSON_PATH: path.join(tmp, "config.json"),
    SANDBOX_DIR: path.join(tmp, "sb"),
  });
  vi.stubEnv("PLAYWRIGHT_API_URL", "http://127.0.0.1:3999");
  vi.stubEnv("BROWSER_SERVICE_TOKEN", "central");
});

afterAll(() => {
  restaurer();
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("résolveur du service navigateur", () => {
  it("central sans mode bac ; socket et jeton du bac du compte en mode bac", () => {
    writeFileSync(path.join(tmp, "config.json"), JSON.stringify({}));
    expect(serviceNavigateur("alice")).toEqual({
      mode: "central",
      base: "http://127.0.0.1:3999",
      jeton: "central",
    });
    writeFileSync(
      path.join(tmp, "config.json"),
      JSON.stringify({ browser: { mode: "sandbox", sandbox_users: ["alice"] } }),
    );
    const c = cheminsNavigateurBac("alice");
    expect(c.socket).toBe(path.join(tmp, "sb", "alice", AGENT_RUN_DIR, "browser.sock"));
    mkdirSync(path.dirname(c.socket), { recursive: true });
    writeFileSync(c.jeton, "jeton-du-bac\n");
    expect(serviceNavigateur("alice")).toEqual({
      mode: "sandbox",
      base: "http://browser",
      socket: c.socket,
      jeton: "jeton-du-bac",
    });
    expect(serviceNavigateur("bob").mode).toBe("central");
  });

  it("requête par le socket du bac avec son jeton ; un lien à la place du socket est refusé", async () => {
    const c = cheminsNavigateurBac("alice");
    const vus: string[] = [];
    const srv = createServer((req, res) => {
      vus.push(String(req.headers["authorization"]));
      res.end('{"ok":true}');
    });
    await new Promise<void>((ok) => srv.listen(c.socket, () => ok()));
    try {
      const s = serviceNavigateur("alice");
      const r = await requeteService(s, "/health", { delaiMs: 2000 });
      expect([r.statut, r.corps.toString(), vus]).toEqual([200, '{"ok":true}', ["Bearer jeton-du-bac"]]);
      const lien = path.join(tmp, "lien.sock");
      symlinkSync(c.socket, lien);
      await expect(
        requeteService({ ...s, socket: lien } as typeof s, "/health", { delaiMs: 2000 }),
      ).rejects.toMatchObject({
        code: "ENOTSOCK",
      });
    } finally {
      srv.close();
    }
  });
});
