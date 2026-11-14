// SPDX-License-Identifier: MIT
/** packages/navigateur/test/mode.test.ts — résolveur du service navigateur d'un compte : socket et jeton de son bac, services des bacs au jeton posé ; requête par le socket, refus d'un lien posé à sa place. */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { AGENT_RUN_DIR } from "@elpis/bac";
import { surchargerConfig } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  cheminsNavigateurBac,
  reglagesServiceBac,
  requeteService,
  serviceNavigateur,
  servicesDesBacs,
} from "../src/mode";

const tmp = mkdtempSync(path.join(tmpdir(), "nav-mode-"));
let restaurer: () => void = () => undefined;

beforeAll(() => {
  restaurer = surchargerConfig({ SANDBOX_DIR: path.join(tmp, "sb") });
});

afterAll(() => {
  restaurer();
  rmSync(tmp, { recursive: true, force: true });
});

describe("résolveur du service navigateur", () => {
  it("socket et jeton du bac du compte ; services des bacs dont le jeton est posé", () => {
    expect(servicesDesBacs()).toEqual([]);
    const c = cheminsNavigateurBac("alice");
    expect(c.socket).toBe(path.join(tmp, "sb", "alice", AGENT_RUN_DIR, "browser.sock"));
    expect(serviceNavigateur("alice")).toEqual({ socket: c.socket, jeton: "" });
    mkdirSync(path.dirname(c.socket), { recursive: true });
    mkdirSync(path.join(tmp, "sb", "bob"), { recursive: true });
    writeFileSync(c.jeton, "jeton-du-bac\n");
    expect(serviceNavigateur("alice")).toEqual({ socket: c.socket, jeton: "jeton-du-bac" });
    expect(servicesDesBacs()).toEqual([{ socket: c.socket, jeton: "jeton-du-bac" }]);
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
        requeteService({ ...s, socket: lien }, "/health", { delaiMs: 2000 }),
      ).rejects.toMatchObject({
        code: "ENOTSOCK",
      });
    } finally {
      srv.close();
    }
  });

  it("réponse du service du bac bornée : au-delà de la borne, la requête échoue au lieu de tout garder en mémoire", async () => {
    const c = cheminsNavigateurBac("alice");
    const srv = createServer((_req, res) => res.end(Buffer.alloc(4096, 120)));
    await new Promise<void>((ok) => srv.listen(c.socket, () => ok()));
    const avant = reglagesServiceBac.reponseMax;
    try {
      const s = serviceNavigateur("alice");
      expect((await requeteService(s, "/x", { delaiMs: 2000 })).corps.length).toBe(4096);
      reglagesServiceBac.reponseMax = 1024;
      await expect(requeteService(s, "/x", { delaiMs: 2000 })).rejects.toMatchObject({
        code: "UND_ERR_RES_EXCEEDED_MAX_SIZE",
      });
    } finally {
      reglagesServiceBac.reponseMax = avant;
      srv.close();
    }
  });
});
