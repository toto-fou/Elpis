// SPDX-License-Identifier: MIT
/** packages/auth/test/defaut.test.ts — dépendances de production : attributs du cookie figés au démarrage, config relue à chaud. */
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { surchargerConfig } from "@elpis/config";
import type { Base } from "@elpis/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dependancesParDefaut } from "../src/index";

let dossier: string;
let fichier: string;
let restaurer: () => void;

function ecrire(session: Record<string, unknown>, mtime: number): void {
  writeFileSync(fichier, JSON.stringify({ security: { session } }));
  const t = new Date(mtime);
  utimesSync(fichier, t, t);
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-auth-"));
  fichier = join(dossier, "config.json");
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: fichier, LOCAL_MCP_TOKEN: "jeton-local" });
});

afterEach(() => {
  restaurer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("dependancesParDefaut", () => {
  it("fige les attributs du cookie mais relit la config de session", () => {
    ecrire({ cookie_name: "premier", idle_timeout_sec: 60 }, 1_000_000);
    const dep = dependancesParDefaut({} as Base);
    ecrire({ cookie_name: "second", idle_timeout_sec: 120 }, 2_000_000);
    expect(dep.attributsCookie().cookie_name).toBe("premier");
    expect(dep.config()).toEqual({ security: { session: { cookie_name: "second", idle_timeout_sec: 120 } } });
    expect(dep.jetonService()).toBe("jeton-local");
  });
});
