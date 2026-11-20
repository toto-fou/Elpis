// SPDX-License-Identifier: MIT
/** apps/core/test/securite-suppression-bac-garde.test.ts — un compte supprimé en gardant son bac ne laisse jamais son espace de travail à un compte recréé sous le même nom (local et hôte d'outils distant). */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser } from "@elpis/auth";
import { reglagesBac, resetUserSandboxCache } from "@elpis/bac";
import { creerFauxDocker } from "@elpis/bac/test";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { oublierConfigurationAudit } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { oublierHotes } from "../src/relais/hotes";
import { ouvrirConsole } from "./admin/aides-bac";
import type { ConsoleDeTest } from "./admin/aides-bac";
import { FauxToolhost, JETON } from "./relais/aides";

let tmp: string;
let c: ConsoleDeTest;
let restaurer: () => void;
let compte: number;
let distant: FauxToolhost | null = null;
const manifesteAvant = process.env["APP_MCP_MANIFEST"];

const bac = (): string => join(tmp, "sb", "pgarde");
const misDeCote = (): string[] => readdirSync(join(tmp, "sb")).filter((n) => n.startsWith(".supprime-"));
const supprimer = (): Promise<{ statusCode: number; json(): unknown }> =>
  c.app.inject({ method: "DELETE", url: `/api/admin/users/${compte}`, headers: c.entetes });

function garnir(): void {
  mkdirSync(join(bac(), "work"), { recursive: true });
  writeFileSync(join(bac(), "work", "secret.txt"), "ancien");
  mkdirSync(join(tmp, "sb", "_snapshots", "pgarde", "snap1"), { recursive: true });
  writeFileSync(join(tmp, "sb", "_snapshots", "pgarde", "snap1", "f"), "instantane");
}
const instantanes = (): string[] => readdirSync(join(tmp, "sb", "_snapshots"));

async function hoteDistant(): Promise<FauxToolhost> {
  distant = await new FauxToolhost().demarrer("127.0.0.2");
  const manifeste = join(tmp, "mcp.json");
  writeFileSync(
    manifeste,
    JSON.stringify({
      mcpServers: {},
      sandboxHosts: { loin: { url: distant.url, token: JETON } },
      placement: { strategy: "by_user" },
    }),
  );
  process.env["APP_MCP_MANIFEST"] = manifeste;
  oublierHotes();
  return distant;
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "elpis-bac-garde-"));
  const docker = creerFauxDocker(join(tmp, "docker"));
  vi.stubEnv("PATH", `${docker.bin}:${process.env["PATH"] ?? ""}`);
  vi.stubEnv("FAUX_DOCKER", docker.etat);
  vi.stubEnv("ELPIS_AUDIT_DIR", join(tmp, "audit"));
  oublierConfigurationAudit();
  writeFileSync(join(tmp, "config.json"), "{}");
  mkdirSync(join(tmp, "sb"));
  restaurer = surchargerConfig({ SANDBOX_DIR: join(tmp, "sb"), CONFIG_JSON_PATH: join(tmp, "config.json") });
  invalidateConfigCache();
  reglagesBac.attenteCreationMs = 0;
  process.env["APP_MCP_MANIFEST"] = join(tmp, "absent.json");
  oublierHotes();
  c = await ouvrirConsole(["pgarde"]);
  compte = c.ids.get("pgarde") ?? 0;
});

afterEach(async () => {
  chmodSync(join(tmp, "sb"), 0o700);
  if (existsSync(join(tmp, "sb", "_snapshots"))) chmodSync(join(tmp, "sb", "_snapshots"), 0o700);
  await c.fermer();
  await distant?.arreter();
  distant = null;
  reglagesBac.attenteCreationMs = 800;
  resetUserSandboxCache();
  oublierConfigurationAudit();
  restaurer();
  vi.unstubAllEnvs();
  if (manifesteAvant === undefined) delete process.env["APP_MCP_MANIFEST"];
  else process.env["APP_MCP_MANIFEST"] = manifesteAvant;
  oublierHotes();
  rmSync(tmp, { recursive: true, force: true });
});

describe("compte supprimé en gardant son bac : un compte recréé sous le même nom n'en hérite pas", () => {
  it("bac local : dossier renommé hors de portée des noms de comptes, contenu gardé, nouveau compte au bac vide", async () => {
    garnir();
    const r = await supprimer();
    expect([r.statusCode, r.json()]).toEqual([200, { ok: true, sandbox_deleted: false }]);
    expect(existsSync(bac())).toBe(false);
    const gardes = misDeCote();
    expect(gardes).toHaveLength(1);
    expect(gardes[0]).toMatch(new RegExp(`^\\.supprime-${compte}-\\d+$`, "u"));
    expect(readdirSync(join(tmp, "sb", gardes[0] as string, "work"))).toEqual(["secret.txt"]);
    await createUser(c.t.base, "pgarde", "mdp-nouveau", { isAdmin: 0 });
    expect(existsSync(join(bac(), "work", "secret.txt"))).toBe(false);
  });

  it("bac local : instantanés renommés avec le bac (même nom), contenu intact, aucun instantané pour le nouveau compte", async () => {
    garnir();
    await supprimer();
    const [garde] = misDeCote();
    expect(instantanes()).toEqual([garde]);
    expect(readFileSync(join(tmp, "sb", "_snapshots", garde as string, "snap1", "f"), "utf-8")).toBe(
      "instantane",
    );
    await createUser(c.t.base, "pgarde", "mdp-nouveau", { isAdmin: 0 });
    expect(existsSync(join(tmp, "sb", "_snapshots", "pgarde"))).toBe(false);
  });

  it("instantanés impossibles à renommer : suppression refusée, bac et instantanés remis en place", async () => {
    garnir();
    chmodSync(join(tmp, "sb", "_snapshots"), 0o500);
    const r = await supprimer();
    chmodSync(join(tmp, "sb", "_snapshots"), 0o700);
    expect(r.statusCode).toBe(502);
    expect(await c.t.base.all("SELECT id FROM users WHERE id=?", [compte])).toEqual([{ id: compte }]);
    expect(existsSync(join(bac(), "work", "secret.txt"))).toBe(true);
    expect(instantanes()).toEqual(["pgarde"]);
    expect(misDeCote()).toEqual([]);
  });

  it("avec son bac : instantanés supprimés aussi", async () => {
    garnir();
    const r = await c.app.inject({
      method: "DELETE",
      url: `/api/admin/users/${compte}?delete_sandbox=true`,
      headers: c.entetes,
    });
    expect(r.statusCode).toBe(200);
    expect(instantanes()).toEqual([]);
    expect(existsSync(bac())).toBe(false);
  });

  it("renommage impossible : suppression refusée, compte et dossier intacts", async () => {
    garnir();
    chmodSync(join(tmp, "sb"), 0o500);
    const r = await supprimer();
    chmodSync(join(tmp, "sb"), 0o700);
    expect(r.statusCode).toBe(502);
    expect(await c.t.base.all("SELECT id FROM users WHERE id=?", [compte])).toEqual([{ id: compte }]);
    expect(existsSync(join(bac(), "work", "secret.txt"))).toBe(true);
  });

  it("bac d'un hôte distant : renommé par l'hôte avant la suppression du compte", async () => {
    garnir();
    const hote = await hoteDistant();
    hote.traitements.set("/api/internal/sandbox/set-aside", (_req, rep) => {
      rep.writeHead(200, { "content-type": "application/json" });
      rep.end(JSON.stringify({ ok: true, renamed: true }));
    });
    const r = await supprimer();
    expect(r.statusCode).toBe(200);
    expect(hote.requetes.map((q) => [q.methode, q.url, q.identite?.username])).toEqual([
      ["POST", "/api/internal/sandbox/set-aside", "pgarde"],
      ["POST", "/api/internal/account/purge", "pgarde"],
    ]);
    expect(await c.t.base.all("SELECT id FROM users WHERE id=?", [compte])).toEqual([]);
    expect(existsSync(bac())).toBe(false);
  });

  it("hôte distant qui refuse le renommage : suppression refusée, compte gardé, dossier local remis en place", async () => {
    garnir();
    const hote = await hoteDistant();
    hote.traitements.set("/api/internal/sandbox/set-aside", (_req, rep) => {
      rep.writeHead(502, { "content-type": "application/json" });
      rep.end(JSON.stringify({ detail: "refus" }));
    });
    const r = await supprimer();
    expect(r.statusCode).toBe(502);
    expect(await c.t.base.all("SELECT id FROM users WHERE id=?", [compte])).toEqual([{ id: compte }]);
    expect(existsSync(join(bac(), "work", "secret.txt"))).toBe(true);
    expect(misDeCote()).toEqual([]);
  });
});
