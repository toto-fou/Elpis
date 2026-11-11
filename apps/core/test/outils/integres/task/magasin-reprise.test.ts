// SPDX-License-Identifier: MIT
/** apps/core/test/outils/integres/task/magasin-reprise.test.ts — store disque de reprise des sous-agents : chemins (oracle Python), écriture 0600 et mtime calée, plafond, TTL, fichier illisible, ramasse-miettes. */
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as R from "../../../../src/outils/integres/task/magasin-reprise";

let racine = "";
let dossier = "";

beforeEach(() => {
  racine = mkdtempSync(path.join(tmpdir(), "elpis-reprise-"));
  dossier = path.join(racine, "store");
  process.env["ELPIS_TASK_RESUME_DIR"] = dossier;
});

afterEach(() => {
  delete process.env["ELPIS_TASK_RESUME_DIR"];
  rmSync(racine, { recursive: true, force: true });
});

describe("store de reprise des sous-agents", () => {
  it("chemins : compte haché, child_id assaini en points de code et borné à 64 (oracle Python)", () => {
    const nom = (u: string, c: string): string => path.basename(R.cheminEnregistrement(u, c));
    expect(nom("alice", "t1-ab12")).toBe("2bd806c97f0e00af-t1-ab12.json");
    expect(nom("bob é", "../etc/passwd")).toBe("cc169bc9ba0df7d8-___etc_passwd.json");
    expect(nom("x", "é😀".repeat(40))).toBe("2d711642b726b044-" + "_".repeat(64) + ".json");
    expect(nom("", "")).toBe("e3b0c44298fc1c14-_.json");
    expect(nom("u", "a".repeat(70))).toBe("0bfe935e70c321c7-" + "a".repeat(64) + ".json");
    expect(path.dirname(R.cheminEnregistrement("a", "b"))).toBe(dossier);
  });

  it("dossier : ELPIS_TASK_RESUME_DIR, sinon ELPIS_RUNTIME_DIR/task_resume, sinon /tmp", () => {
    process.env["ELPIS_TASK_RESUME_DIR"] = "  ";
    process.env["ELPIS_RUNTIME_DIR"] = "/srv/run";
    expect(R.storeDir()).toBe("/srv/run/task_resume");
    delete process.env["ELPIS_RUNTIME_DIR"];
    expect(R.storeDir()).toBe("/tmp/elpis_task_resume");
  });

  it("put puis get : JSON 0600 dans un dossier 0700, mtime calée sur ts (peekTs), relu tel quel", () => {
    const ts = Date.now() / 1000 - 10;
    const rec = { ts, history: [{ role: "user", content: "é" }], n: 1 };
    expect(R.put("alice", "t1-a", rec)).toBe(true);
    const p = R.cheminEnregistrement("alice", "t1-a");
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(statSync(dossier).mode & 0o777).toBe(0o700);
    expect(readdirSync(dossier)).toEqual([path.basename(p)]);
    expect(Math.abs(R.peekTs("alice", "t1-a")! - ts)).toBeLessThan(1e-3);
    expect(R.get("alice", "t1-a", 3600)).toEqual(rec);
    expect(R.get("bob", "t1-a", 3600)).toBeNull();
    expect(R.peekTs("bob", "t1-a")).toBeNull();
  });

  it("au-delà du plafond rien n'est écrit ; un record non sérialisable non plus", () => {
    expect(R.put("alice", "gros", { ts: 1, blob: "x".repeat(R.MAX_BYTES) })).toBe(false);
    const rond: Record<string, unknown> = { ts: 1 };
    rond["moi"] = rond;
    expect(R.put("alice", "rond", rond)).toBe(false);
    expect(readdirSync(dossier)).toEqual([]);
  });

  it("get retire un record périmé ou illisible, garde un non-objet", () => {
    R.put("alice", "vieux", { ts: Date.now() / 1000 - 100 });
    expect(R.get("alice", "vieux", 50)).toBeNull();
    expect(R.peekTs("alice", "vieux")).toBeNull();
    writeFileSync(R.cheminEnregistrement("alice", "casse"), "{pas du json");
    expect(R.get("alice", "casse", 50)).toBeNull();
    expect(R.peekTs("alice", "casse")).toBeNull();
    writeFileSync(
      R.cheminEnregistrement("alice", "octets"),
      Buffer.from([0x7b, 0x22, 0x74, 0x73, 0x22, 0x3a, 0xff, 0x7d]),
    );
    expect(R.get("alice", "octets", 50)).toBeNull();
    expect(R.peekTs("alice", "octets")).toBeNull();
    writeFileSync(R.cheminEnregistrement("alice", "liste"), "[1]");
    expect(R.get("alice", "liste", 50)).toBeNull();
    expect(R.peekTs("alice", "liste")).not.toBeNull();
  });

  it("prune : TTL sur la mtime, puis cap en retirant les plus anciens ; dossier absent sans erreur", () => {
    const maintenant = 1_000_000;
    const ages: Record<string, number> = { a: 10, b: 500, c: 30, d: 20, e: 40 };
    for (const [c, age] of Object.entries(ages)) {
      R.put("u", c, { ts: maintenant - age });
      utimesSync(R.cheminEnregistrement("u", c), maintenant - age, maintenant - age);
    }
    writeFileSync(path.join(dossier, "autre.tmp"), "x");
    R.prune(100, 0, maintenant);
    expect(readdirSync(dossier)).toHaveLength(5);
    expect(R.peekTs("u", "b")).toBeNull();
    R.prune(100, 2, maintenant);
    const restants = readdirSync(dossier).sort();
    expect(restants).toEqual(
      [
        "autre.tmp",
        path.basename(R.cheminEnregistrement("u", "a")),
        path.basename(R.cheminEnregistrement("u", "d")),
      ].sort(),
    );
    R.prune(100, 0, maintenant);
    expect(readdirSync(dossier)).toHaveLength(3);
    process.env["ELPIS_TASK_RESUME_DIR"] = path.join(dossier, "absent");
    expect(() => R.prune(1, 1)).not.toThrow();
  });
});
