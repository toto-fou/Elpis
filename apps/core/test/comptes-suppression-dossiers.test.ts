// SPDX-License-Identifier: MIT
/** apps/core/test/comptes-suppression-dossiers.test.ts — suppression d'un compte : identifiants de sites, skills, miroir, mémoire et cache des graphiques rangés par nom effacés, jamais ceux d'un compte restant ni le /work. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteUserFull } from "../src/comptes/suppression";

let t: BaseDeTest;
let dossier = "";
let restaurer: (() => void) | null = null;
let cacheAvant: string | undefined;

const sandbox = (): string => join(dossier, "sandboxes");
const skills = (): string => join(dossier, "user_skills");
const charts = (): string => join(dossier, "charts");

/** Compte inséré tel quel (nom ancien compris, que la validation refuserait aujourd'hui), avec ses dossiers rangés par `sur`. */
async function compte(nom: string, sur: string): Promise<number> {
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin, must_change_pwd) VALUES (?, 's', 'h', 0, 0, 0)",
    [nom],
  );
  await t.base.run(
    "INSERT INTO ax_credentials (owner, site, username, password, last_ok, use_count) VALUES (?, 'https://site.test', 'u', 'p', 0, 1)",
    [nom],
  );
  for (const d of [
    join(skills(), sur, "s1"),
    join(sandbox(), sur, "skills", "s1"),
    join(sandbox(), sur, "memory"),
    join(sandbox(), sur, "work"),
    join(charts(), sur),
  ])
    mkdirSync(d, { recursive: true, mode: 0o700 });
  writeFileSync(join(sandbox(), sur, "memory", "MEMORY.md"), "m");
  writeFileSync(join(sandbox(), sur, "work", "garde.txt"), "w");
  writeFileSync(join(charts(), sur, "abc.html"), "c");
  const r = await t.base.get("SELECT id FROM users WHERE username=?", [nom]);
  return Number(r?.["id"]);
}

const present = (sur: string): Record<string, boolean> => ({
  skills: existsSync(join(skills(), sur)),
  miroir: existsSync(join(sandbox(), sur, "skills")),
  memoire: existsSync(join(sandbox(), sur, "memory")),
  work: existsSync(join(sandbox(), sur, "work", "garde.txt")),
  charts: existsSync(join(charts(), sur)),
});

const identifiants = async (): Promise<string[]> =>
  (await t.base.all<{ owner: string }>("SELECT owner FROM ax_credentials ORDER BY owner")).map(
    (r) => r.owner,
  );

const TOUT = { skills: true, miroir: true, memoire: true, work: true, charts: true };

beforeEach(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  dossier = mkdtempSync(join(tmpdir(), "elpis-suppression-"));
  mkdirSync(charts(), { mode: 0o700 });
  restaurer = surchargerConfig({
    DB_PATH: join(dossier, "user_db", "app.db"),
    SANDBOX_DIR: sandbox(),
    MEMORY_DIR: sandbox(),
    USER_SKILLS_DIR: skills(),
  });
  cacheAvant = process.env["CHART_CACHE_DIR"];
  process.env["CHART_CACHE_DIR"] = charts();
});

afterEach(async () => {
  try {
    await t.fermer();
  } finally {
    restaurer?.();
    if (cacheAvant === undefined) delete process.env["CHART_CACHE_DIR"];
    else process.env["CHART_CACHE_DIR"] = cacheAvant;
    rmSync(dossier, { recursive: true, force: true });
  }
});

describe("suppression d'un compte : données rangées par nom", () => {
  it("skills, miroir, mémoire, cache et identifiants du compte effacés ; /work et l'autre compte intacts", async () => {
    const alice = await compte("alice", "alice");
    await compte("bob", "bob");
    expect(await deleteUserFull(t.base, alice)).toBe(true);
    expect(present("alice")).toEqual({
      skills: false,
      miroir: false,
      memoire: false,
      work: true,
      charts: false,
    });
    expect(present("bob")).toEqual(TOUT);
    expect(await identifiants()).toEqual(["bob"]);
  });

  it("lien à la place d'un dossier : le lien est retiré, sa cible jamais suivie", async () => {
    const alice = await compte("alice", "alice");
    const cible = join(dossier, "cible");
    mkdirSync(cible);
    writeFileSync(join(cible, "f"), "x");
    symlinkSync(cible, join(sandbox(), "alice", ".memory"));
    rmSync(join(charts(), "alice"), { recursive: true });
    symlinkSync(cible, join(charts(), "alice"));
    await deleteUserFull(t.base, alice);
    expect(existsSync(join(sandbox(), "alice", ".memory"))).toBe(false);
    expect(existsSync(join(charts(), "alice"))).toBe(false);
    expect(existsSync(join(cible, "f"))).toBe(true);
  });

  it("dossiers partagés avec un compte restant (même nom sûr) ou repliés sur « guest » : rien d'effacé hors base", async () => {
    const carol = await compte("car.ol", "carol");
    await compte("carol", "carol");
    await deleteUserFull(t.base, carol);
    expect(present("carol")).toEqual(TOUT);
    expect(await identifiants()).toEqual(["carol"]);

    const ancien = await compte("éé", "guest");
    await deleteUserFull(t.base, ancien);
    expect(present("guest")).toEqual(TOUT);

    await compte("éé", "guest");
    const invite = await compte("guest", "guest");
    await deleteUserFull(t.base, invite);
    expect(present("guest")).toEqual(TOUT);
    expect(await identifiants()).toEqual(["carol", "éé"]);
  });
});
