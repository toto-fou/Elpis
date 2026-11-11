// SPDX-License-Identifier: MIT
/** apps/toolhost/test/desktop-sandbox.test.ts — `desktop_run_automation` sans `code` dans l'hôte : `automations/<slug>.py` lu par l'agent du bac du compte (profil réseau effectif, 4 Mio, UTF-8 strict) puis poussé à l'agent bureau ; compte inconnu, panne ou octets invalides = « script vide » comme le Python. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { definirFabriqueAgent, resetUserSandboxCache } from "@elpis/bac";
import type { AgentBac, BacPourAgent } from "@elpis/bac";
import { outilDesktopExpose } from "@elpis/bureau";
import type { Dict } from "@elpis/commun";
import { invalidateConfigCache, reloadDesktopConfigFromDisk, surchargerConfig } from "@elpis/config";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { FauxLan } from "../../core/test/faux-lan";
import type { ReponseScriptee } from "../../core/test/faux-lan";
import { brancherBureau } from "../src/mcp/desktop";
import type { ClientRappel } from "../src/rappel";
import { journalMuet } from "./aides";

const SCRIPT = "from elpis_auto import *\nprint('depuis la sandbox é')\n";
const ok = (champs: Dict = {}): ReponseScriptee => ({ statut: 200, json: { ok: true, ...champs } });

describe("desktop_run_automation sans code : script lu dans la sandbox du compte", () => {
  let dossier: string;
  let lan: FauxLan;
  const restaurer: (() => void)[] = [];
  const lectures: {
    uid: number;
    nom: string;
    profil: string | null;
    chemin: string;
    max: number | undefined;
  }[] = [];
  let contenu: Buffer | Error = Buffer.from(SCRIPT);

  beforeAll(async () => {
    dossier = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-desktop-bac-")));
    lan = await FauxLan.demarrer();
    mkdirSync(path.join(dossier, "bacs"));
    writeFileSync(
      path.join(dossier, "config.json"),
      JSON.stringify({
        desktop: { targets: [{ name: "vm1", os: "windows", agent_url: `${lan.url}/a`, default: true }] },
      }),
    );
    vi.stubEnv("DESKTOP_SCREENS_DIR", path.join(dossier, "ecrans"));
    vi.stubEnv("DESKTOP_ACTIVE_PATH", path.join(dossier, "actif.json"));
    restaurer.push(
      surchargerConfig({
        CONFIG_JSON_PATH: path.join(dossier, "config.json"),
        SANDBOX_DIR: path.join(dossier, "bacs"),
      }),
    );
    invalidateConfigCache();
    reloadDesktopConfigFromDisk(true);
    definirFabriqueAgent(
      (bac: BacPourAgent) =>
        ({
          read: async (chemin: string, o: { maxBytes?: number }) => {
            const b = bac as unknown as { userId: number; username: string; networkProfileId: string | null };
            lectures.push({
              uid: b.userId,
              nom: b.username,
              profil: b.networkProfileId,
              chemin,
              max: o.maxBytes,
            });
            if (contenu instanceof Error) throw contenu;
            return { data: contenu, stat: {} };
          },
        }) as unknown as AgentBac,
    );
    const rappel = {
      identityForUsername: async (username: string) =>
        username === "inconnu" ? null : { user_id: 7, username, network_profile_id: "web", is_admin: false },
      creerNotification: async () => true,
      ancre: async () => null,
      noterAncre: async () => true,
    } as unknown as ClientRappel;
    brancherBureau(rappel, journalMuet);
  });

  afterEach(() => {
    lectures.length = 0;
    lan.vues.length = 0;
    contenu = Buffer.from(SCRIPT);
  });

  afterAll(async () => {
    definirFabriqueAgent(null);
    resetUserSandboxCache();
    await lan.arreter();
    for (const r of restaurer.reverse()) r();
    invalidateConfigCache();
    vi.unstubAllEnvs();
    rmSync(dossier, { recursive: true, force: true });
  });

  const lancer = (username: string): Promise<Dict> =>
    (outilDesktopExpose("desktop_run_automation")?.gerer(username, { name: "Démo Paie", targets: "vm1" }) ??
      Promise.reject(new Error("outil absent"))) as Promise<Dict>;

  it("script de la sandbox (bac du compte, profil effectif, 4 Mio) poussé à l'agent bureau", async () => {
    lan.reponses = [
      ok(),
      ok({ run_id: "r1" }),
      ok({ running: false, code: 0, summary: "fini", report_dir: "" }),
    ];
    const r = await lancer("alice");
    expect(lectures).toEqual([
      { uid: 7, nom: "alice", profil: "web", chemin: "automations/demo-paie.py", max: 4 << 20 },
    ]);
    expect(r).toMatchObject({ ok: true });
    const corps = lan.vues.map((v) => Buffer.from(v.corps, "base64").toString("utf-8")).join("\n");
    expect(corps).toContain("depuis la sandbox");
  });

  it("compte inconnu, panne de l'agent, octets non UTF-8 : « script vide » (no_code), rien envoyé à l'agent bureau", async () => {
    for (const [compte, lu] of [
      ["inconnu", Buffer.from(SCRIPT)],
      ["alice", Object.assign(new Error("absent"), { name: "AgentError", code: "not_found" })],
      ["alice", Buffer.from([0x70, 0xff, 0x0a])],
    ] as const) {
      contenu = lu;
      const r = await lancer(compte);
      expect(r).toMatchObject({ ok: false, error: "no_code" });
    }
    expect(lectures.map((l) => l.nom)).toEqual(["alice", "alice"]);
    expect(lan.vues).toEqual([]);
  });
});
