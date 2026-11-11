// SPDX-License-Identifier: MIT
/** apps/core/test/admin/suppression-bac-docker.test.ts — essai réel (ELPIS_INTEROP_DOCKER=1) : la console composée supprime le bac d'un compte dont /work appartient à l'UID du conteneur, et détruit le conteneur d'un profil réseau imposé. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getUserSandbox, reglagesBac, resetUserSandboxCache, WORK_SUBDIR } from "@elpis/bac";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { oublierConfigurationAudit } from "@elpis/securite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { oublierHotes } from "../../src/relais/hotes";
import { ouvrirConsole } from "./aides-bac";
import type { ConsoleDeTest } from "./aides-bac";

const ACTIF = process.env["ELPIS_INTEROP_DOCKER"] === "1";
const LABEL = "elpis.lot=portbac";

function docker(...args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("docker", args, { encoding: "utf-8", timeout: 120_000 });
  return { status: r.status, stdout: r.stdout };
}

describe.skipIf(!ACTIF)("pilote du bac de la console (docker réel)", () => {
  const suffixe = Math.random().toString(16).slice(2, 8);
  const noms = [`pbac${suffixe}`, `pbacp${suffixe}`];
  let tmp = "";
  let c: ConsoleDeTest;
  let restaurer: () => void = () => undefined;
  const manifesteAvant = process.env["APP_MCP_MANIFEST"];

  /** Conteneur réel du compte démarré, fichiers écrits dans /work par l'UID du conteneur (refusés à l'hôte). */
  async function bacReel(nom: string): Promise<string> {
    const travail = join(tmp, "sb", nom, WORK_SUBDIR);
    await getUserSandbox(c.ids.get(nom) ?? 0, nom, travail).ensureRunning();
    resetUserSandboxCache();
    const ecrit = docker(
      "exec",
      "-u",
      "10001:10001",
      `elpis-sb-${nom}`,
      "sh",
      "-c",
      "mkdir -p /work/a/b && echo x > /work/a/b/f",
    );
    expect(ecrit.status).toBe(0);
    return travail;
  }

  beforeAll(async () => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "elpis-portbac-docker-")));
    const config = join(tmp, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        executors: {
          extra_run_args: ["--label", LABEL],
          network_profiles: [
            { id: "isolated", name: "Isolé", mode: "none", ips: [] },
            { id: "web", name: "Web", mode: "bridge" },
          ],
        },
      }),
    );
    vi.stubEnv("SANDBOX_READINESS_CACHE", "0");
    vi.stubEnv("ELPIS_AUDIT_DIR", join(tmp, "audit"));
    oublierConfigurationAudit();
    restaurer = surchargerConfig({ SANDBOX_DIR: join(tmp, "sb"), CONFIG_JSON_PATH: config });
    invalidateConfigCache();
    process.env["APP_MCP_MANIFEST"] = join(tmp, "absent.json");
    oublierHotes();
    c = await ouvrirConsole(noms);
  });

  afterAll(async () => {
    for (const nom of noms) {
      const travail = join(tmp, "sb", nom, WORK_SUBDIR);
      if (existsSync(travail)) await getUserSandbox(c.ids.get(nom) ?? 0, nom, travail).purge();
      if (docker("inspect", `elpis-sb-${nom}`).status === 0) docker("rm", "-f", `elpis-sb-${nom}`);
    }
    await c.fermer();
    resetUserSandboxCache();
    reglagesBac.attenteCreationMs = 800;
    restaurer();
    vi.unstubAllEnvs();
    if (manifesteAvant === undefined) delete process.env["APP_MCP_MANIFEST"];
    else process.env["APP_MCP_MANIFEST"] = manifesteAvant;
    oublierHotes();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("delete_sandbox=true : /work à l'UID du conteneur vidé par son root, P supprimé, conteneur retiré", async () => {
    const [nom = ""] = noms;
    const travail = await bacReel(nom);
    expect(
      docker("inspect", "-f", '{{index .Config.Labels "elpis.lot"}}', `elpis-sb-${nom}`).stdout.trim(),
    ).toBe("portbac");
    const r = await c.app.inject({
      method: "DELETE",
      url: `/api/admin/users/${c.ids.get(nom)}?delete_sandbox=true`,
      headers: c.entetes,
    });
    expect([r.statusCode, r.json()]).toEqual([200, { ok: true, sandbox_deleted: true }]);
    expect(existsSync(travail)).toBe(false);
    expect(existsSync(join(tmp, "sb", nom))).toBe(false);
    expect(docker("inspect", `elpis-sb-${nom}`).status).not.toBe(0);
  }, 180_000);

  it("profil réseau imposé : conteneur en marche détruit tout de suite", async () => {
    const nom = noms[1] ?? "";
    await bacReel(nom);
    const r = await c.app.inject({
      method: "POST",
      url: `/api/admin/users/${c.ids.get(nom)}/network-profile`,
      headers: { ...c.entetes, "content-type": "application/json" },
      payload: JSON.stringify({ profile_id: "web" }),
    });
    expect(r.json()).toMatchObject({ ok: true, network_profile_id: "web", container_destroyed: true });
    expect(docker("inspect", `elpis-sb-${nom}`).status).not.toBe(0);
  }, 180_000);
});
