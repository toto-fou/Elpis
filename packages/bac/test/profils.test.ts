// SPDX-License-Identifier: MIT
/** packages/bac/test/profils.test.ts — profils réseau lus dans config.json à chaque appel, avertissements une seule fois par processus. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { brancherJournal, journalStderr } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { chargerConfigBac, oublierSignalements, profilParId } from "../src/index";

let dossier = "";
let restaurer: () => void = () => undefined;
let avertis: string[][] = [];

function ecrireConfig(executors: unknown): void {
  writeFileSync(join(dossier, "config.json"), JSON.stringify({ executors }), "utf-8");
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-profils-"));
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
  oublierSignalements();
  avertis = [];
  brancherJournal((domaine) => ({
    ...journalStderr(domaine),
    warn: (...args: unknown[]) => avertis.push(args.map(String)),
  }));
});

afterEach(() => {
  restaurer();
  brancherJournal(null);
  rmSync(dossier, { recursive: true, force: true });
});

describe("chargerConfigBac (load_admin_config)", () => {
  it("relit config.json à chaque appel ; un profil ignoré n'est signalé qu'une fois par processus", () => {
    ecrireConfig({
      network_profiles: [
        { id: "Lan", name: "L" },
        { id: "web", name: "Web", domains: ["a_b.com"] },
      ],
    });
    for (let i = 0; i < 3; i++) {
      expect(chargerConfigBac().network_profiles.map((p) => p.id)).toEqual(["isolated", "web"]);
    }
    expect(avertis.map((a) => a.join(" "))).toEqual([
      "profil réseau ignoré : identifiant de profil invalide : 'Lan'",
      "profil réseau 'web' : domaine 'a_b.com' ignoré (invalide)",
    ]);
    ecrireConfig({ network_profiles: [{ id: "lan", name: "LAN", mode: "bridge" }] });
    const cfg = chargerConfigBac();
    expect([profilParId(cfg, "lan").mode, profilParId(cfg, "Lan").id]).toEqual(["bridge", "isolated"]);
  });

  it("config.json absent ou sans section executors : le seul profil isolé", () => {
    expect(chargerConfigBac().network_profiles.map((p) => p.id)).toEqual(["isolated"]);
    writeFileSync(join(dossier, "config.json"), "{}", "utf-8");
    expect(profilParId(chargerConfigBac(), "web").name).toBe("Isolé total");
  });
});
