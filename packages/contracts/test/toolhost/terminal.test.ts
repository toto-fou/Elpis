// SPDX-License-Identifier: MIT
/** packages/contracts/test/toolhost/terminal.test.ts — contrats des routes du terminal du bac rejoués contre l'hôte d'outils réel (vrai PTY, faux docker) : frappe, taille, arrêt, sessions nommées. */
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { privdrop } from "@elpis/bac";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { configTest } from "../../../../apps/toolhost/test/aides";
import { creerFauxDockerTerminal } from "../../../../apps/toolhost/test/terminal-aides";
import { appelerHote, hoteTest, routesDuDomaine, verifierToolhost } from "./aides";
import type { HoteTest } from "./aides";

const couvertes = new Set<string>();
let dossier = "";
let t: BaseDeTest;
let h: HoteTest;
let restaurer: () => void = () => undefined;

async function ok(methode: string, url: string, corps?: unknown) {
  const r = await appelerHote(h, methode, url, corps);
  return { statut: r.statut, corps: verifierToolhost(methode, url, r, couvertes) as Record<string, unknown> };
}

describe("contrats REST : terminal du bac (hôte d'outils réel, faux docker)", () => {
  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-ct-terminal-")));
    const docker = creerFauxDockerTerminal(path.join(dossier, "docker"));
    vi.stubEnv("PATH", `${docker.bin}${path.delimiter}${process.env["PATH"] ?? ""}`);
    writeFileSync(path.join(dossier, "config.json"), "{}");
    restaurer = surchargerConfig({
      SANDBOX_DIR: path.join(dossier, "sb"),
      CONFIG_JSON_PATH: path.join(dossier, "config.json"),
    });
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    h = await hoteTest(configTest(), { base: t.base });
  });

  afterEach(() => {
    h.composition.terminaux.tuerTout();
  });

  afterAll(async () => {
    await h?.fermer();
    await t?.fermer();
    restaurer();
    vi.unstubAllEnvs();
    privdrop.oublierSondes();
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it("frappe, taille et arrêt du terminal par défaut", async () => {
    expect((await ok("POST", "/api/terminal/input", { data: "echo ok\n" })).corps).toEqual({ ok: true });
    expect((await ok("POST", "/api/terminal/input", { data: "" })).corps).toEqual({ ok: true });
    expect((await ok("POST", "/api/terminal/resize", { rows: 30, cols: 100 })).corps).toEqual({ ok: true });
    expect((await ok("POST", "/api/terminal/resize", { rows: "x" })).statut).toBe(400);
    expect((await ok("POST", "/api/terminal/kill")).corps).toEqual({ ok: true });
  });

  it("sessions nommées : liste, création, renommage, suppression", async () => {
    expect((await ok("GET", "/api/terminal/sessions")).corps["sessions"]).toEqual([]);
    const creee = (await ok("POST", "/api/terminal/sessions", {})).corps["session"] as {
      id: string;
      name: string;
    };
    expect(creee.name).toBe("Terminal 1");
    await ok("POST", "/api/terminal/sessions", { name: "déploiement" });
    expect((await ok("GET", "/api/terminal/sessions")).corps["sessions"]).toHaveLength(2);
    await ok("PATCH", `/api/terminal/sessions/${creee.id}`, { name: "  logs  " });
    expect((await ok("PATCH", "/api/terminal/sessions/t_inconnu", { name: "x" })).statut).toBe(404);
    await ok("DELETE", `/api/terminal/sessions/${creee.id}`);
    expect((await ok("DELETE", `/api/terminal/sessions/${creee.id}`)).statut).toBe(404);
  });

  it("toutes les routes du domaine ont été interrogées", () => {
    const attendues = routesDuDomaine("bac-terminal");
    expect([...couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
