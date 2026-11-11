// SPDX-License-Identifier: MIT
/** apps/core/test/journal-securite/catalogue-cli.test.ts — journal de sécurité des commandes `./elpis` : ligne après coup, outcome selon le code de sortie, code jamais modifié. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { oublierConfigurationAudit } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { avecAuditCli } from "../../src/exploitation/journal-cli";

describe("avecAuditCli", () => {
  let dossier: string;
  let env: NodeJS.ProcessEnv;

  const lignes = (): Record<string, unknown>[] =>
    readdirSync(join(dossier, "audit"))
      .flatMap((f) => readFileSync(join(dossier, "audit", f), "utf8").split("\n"))
      .filter((l) => l.startsWith('{"v":'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  beforeEach(() => {
    dossier = mkdtempSync(join(tmpdir(), "elpis-cat-cli-"));
    env = { ELPIS_AUDIT_DIR: join(dossier, "audit"), ELPIS_AUDIT_KEY_PATH: join(dossier, "sans-cle") };
    mkdirSync(join(dossier, "audit"));
    oublierConfigurationAudit();
  });

  afterEach(() => {
    oublierConfigurationAudit();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("écrit service cli, os_user et outcome success pour un code 0, entre marqueurs de l'écrivain", async () => {
    const code = await avecAuditCli(
      "cli.backup",
      async (retenir) => {
        retenir({ scope: "db" });
        return 0;
      },
      { env, racine: dossier, utilisateurOs: "exploitant" },
    );
    expect(code).toBe(0);
    const l = lignes();
    expect(l.map((x) => x["action"])).toEqual(["audit.writer.start", "cli.backup", "audit.writer.stop"]);
    expect(l[1]).toMatchObject({
      service: "cli",
      outcome: "success",
      user_id: null,
      username: null,
      ip: null,
      details: { scope: "db", os_user: "exploitant" },
    });
  });

  it("outcome failure pour un code non nul, code rendu tel quel", async () => {
    const code = await avecAuditCli(
      "cli.audit.verify",
      async (retenir) => {
        retenir({ from: null, to: "2026-01-02", intact: false });
        return 1;
      },
      { env, racine: dossier, utilisateurOs: "x" },
    );
    expect(code).toBe(1);
    expect(lignes().find((x) => x["action"] === "cli.audit.verify")).toMatchObject({
      outcome: "failure",
      details: { from: null, to: "2026-01-02", intact: false },
    });
  });

  it("sans détails retenus (aide, erreur d'arguments, sous-commande sans effet), rien n'est écrit", async () => {
    expect(await avecAuditCli("cli.db.use", async () => 2, { env, racine: dossier })).toBe(2);
    expect(lignes()).toEqual([]);
  });

  it("action donnée par la commande après analyse de ses arguments ; sans action, rien", async () => {
    const code = await avecAuditCli(
      null,
      async (retenir) => {
        retenir({ backend: "sqlite" }, "cli.db.use");
        return 2;
      },
      { env, racine: dossier, utilisateurOs: "x" },
    );
    expect(code).toBe(2);
    expect(lignes().find((x) => x["action"] === "cli.db.use")).toMatchObject({ outcome: "failure" });
    const avant = lignes().length;
    await avecAuditCli(null, async (retenir) => (retenir({ x: 1 }), 0), { env, racine: dossier });
    expect(lignes()).toHaveLength(avant);
  });

  it("dossier du journal absent : rien n'est créé (une commande en root le rendrait inutilisable), message sur stderr", async () => {
    const absent = { ...env, ELPIS_AUDIT_DIR: join(dossier, "logs", "audit") };
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const code = await avecAuditCli(
        "cli.backup",
        async (retenir) => {
          retenir({ scope: "db" });
          return 0;
        },
        { env: absent, racine: dossier },
      );
      expect(code).toBe(0);
      expect(String(stderr.mock.calls[0]?.[0])).toMatch(
        /journal de sécurité : .*absent, ligne cli\.backup non écrite/u,
      );
    } finally {
      stderr.mockRestore();
    }
    expect(existsSync(join(dossier, "logs"))).toBe(false);
  });

  it("une erreur de la commande remonte et laisse quand même la ligne, en échec", async () => {
    await expect(
      avecAuditCli(
        "cli.db.transfer",
        async (retenir) => {
          retenir({ to_backend: "postgres", dry_run: true });
          throw new Error("boum");
        },
        { env, racine: dossier, utilisateurOs: "x" },
      ),
    ).rejects.toThrow("boum");
    expect(lignes().find((x) => x["action"] === "cli.db.transfer")).toMatchObject({ outcome: "failure" });
  });

  it("un audit qui échoue ne change pas le code de sortie", async () => {
    writeFileSync(join(dossier, "fichier"), "x");
    const impossible = { ...env, ELPIS_AUDIT_DIR: join(dossier, "fichier", "audit") };
    const code = await avecAuditCli(
      "cli.backup",
      async (retenir) => {
        retenir({ scope: "full" });
        return 0;
      },
      { env: impossible, racine: dossier },
    );
    expect(code).toBe(0);
  });
});
