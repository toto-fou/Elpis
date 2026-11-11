// SPDX-License-Identifier: MIT
/** packages/config/test/secret.test.ts — secret de session : précédence, fichier 0600 créé en exclusif, avertissements. */
import { DOSSIER_TEST } from "./environnement";

import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import { calculerReglages, WEAK_SESSION_SECRETS } from "../src/reglages";

const RACINE = realpathSync(path.resolve(import.meta.dirname, "..", "..", ".."));
const FORT = `fort-${"a".repeat(64)}`;

afterAll(() => {
  rmSync(DOSSIER_TEST, { recursive: true, force: true });
});

function dossier(): string {
  return realpathSync(mkdtempSync(path.join(DOSSIER_TEST, "secret-")));
}

/** Réglages d'un démarrage avec la base dans `base`, et ce qu'il écrit sur stderr. */
function demarrer(base: string, env: Record<string, string> = {}, brut: Record<string, unknown> = {}) {
  let erreurs = "";
  const espion = vi.spyOn(process.stderr, "write").mockImplementation(((morceau: string) => {
    erreurs += morceau;
    return true;
  }) as typeof process.stderr.write);
  try {
    const env2 = { APP_DB_PATH: path.join(base, "app.db"), MCP_SERVERS_DIR: path.join(base, "mcp"), ...env };
    const { reglages } = calculerReglages(env2, brut, RACINE, path.join(base, "config.json"));
    return { secret: reglages.SESSION_SECRET, erreurs };
  } finally {
    espion.mockRestore();
  }
}

const fichierSecret = (base: string): string => path.join(base, ".session_secret");

describe("précédence du secret de session", () => {
  it("env > config.json > fichier près de la base", () => {
    const base = dossier();
    writeFileSync(fichierSecret(base), FORT, { mode: 0o600 });
    const config = { app: { session_secret: "secret-de-config-propre-et-assez-long-0123" } };
    expect(demarrer(base, { APP_SESSION_SECRET: `env-${FORT}` }, config).secret).toBe(`env-${FORT}`);
    expect(demarrer(base, {}, config).secret).toBe("secret-de-config-propre-et-assez-long-0123");
    expect(demarrer(base).secret).toBe(FORT);
  });

  it("une env vide ou blanche vaut absente", () => {
    const base = dossier();
    writeFileSync(fichierSecret(base), FORT, { mode: 0o600 });
    expect(demarrer(base, { APP_SESSION_SECRET: "  " }).secret).toBe(FORT);
  });

  it("les valeurs d'exemple publiées sont ignorées au profit du fichier", () => {
    for (const faible of [...WEAK_SESSION_SECRETS, " ChangeMe "]) {
      const base = dossier();
      writeFileSync(fichierSecret(base), FORT, { mode: 0o600 });
      expect(demarrer(base, {}, { app: { session_secret: faible } }).secret, faible).toBe(FORT);
    }
  });

  it("un secret propre à l'opérateur, même court, est gardé (avec un avertissement)", () => {
    const { secret, erreurs } = demarrer(dossier(), {}, { app: { session_secret: "court-mais-a-moi" } });
    expect(secret).toBe("court-mais-a-moi");
    expect(erreurs).toContain("SESSION_SECRET FAIBLE/PAR DÉFAUT (source=config.json, len=16)");
  });
});

describe("fichier .session_secret", () => {
  it("créé en 0600 s'il manque, puis relu tel quel au démarrage suivant", () => {
    const base = path.join(dossier(), "sous", "dossier");
    const premier = demarrer(base);
    expect(premier.secret).toMatch(/^ELPIS_[0-9a-f]{64}$/);
    expect(readFileSync(fichierSecret(base), "utf-8")).toBe(premier.secret);
    expect(statSync(fichierSecret(base)).mode & 0o777).toBe(0o600);
    expect(demarrer(base).secret).toBe(premier.secret);
    expect(premier.erreurs).toBe("");
  });

  it("un fichier élargi est remis en 0600, avec un avertissement", () => {
    const base = dossier();
    writeFileSync(fichierSecret(base), `${FORT}\n`);
    chmodSync(fichierSecret(base), 0o664);
    const { secret, erreurs } = demarrer(base);
    expect(secret).toBe(FORT);
    expect(statSync(fichierSecret(base)).mode & 0o777).toBe(0o600);
    expect(erreurs).toContain("était en 664 (lisible hors propriétaire) — remis en 0600");
  });

  it("un fichier trop court (< 40 caractères) est remplacé", () => {
    const base = dossier();
    writeFileSync(fichierSecret(base), "trop-court", { mode: 0o644 });
    const { secret } = demarrer(base);
    expect(secret).toMatch(/^ELPIS_[0-9a-f]{64}$/);
    expect(readFileSync(fichierSecret(base), "utf-8")).toBe(secret);
    expect(statSync(fichierSecret(base)).mode & 0o777).toBe(0o600);
  });

  it("dossier impossible à créer : secret éphémère et alerte critique", () => {
    const fichier = path.join(dossier(), "pas-un-dossier");
    writeFileSync(fichier, "x");
    const { secret, erreurs } = demarrer(path.join(fichier, "sous"));
    expect(secret).toMatch(/^EPHEMERAL_[0-9a-f]{32}$/);
    expect(erreurs).toContain("Impossible de créer");
    expect(erreurs).toContain("[CRITICAL] Elpis SESSION_SECRET est ÉPHÉMÈRE");
  });

  it("plusieurs process qui démarrent ensemble partagent le même secret", async () => {
    const base = dossier();
    const script = path.join(base, "demarrer.mts");
    const module = path.join(RACINE, "packages", "config", "src", "reglages.ts");
    writeFileSync(
      script,
      `import { calculerReglages } from ${JSON.stringify(module)};\n` +
        `const { reglages } = calculerReglages({ APP_DB_PATH: process.argv[2], MCP_SERVERS_DIR: ${JSON.stringify(path.join(base, "mcp"))} }, {}, ${JSON.stringify(RACINE)}, "/absent/config.json");\n` +
        "process.stdout.write(reglages.SESSION_SECRET);\n",
    );
    const lancer = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const enfant = spawn(process.execPath, ["--import", "tsx", script, path.join(base, "db", "app.db")], {
          cwd: RACINE,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let sortie = "";
        enfant.stdout.on("data", (morceau: Buffer) => (sortie += morceau.toString()));
        enfant.on("error", reject);
        enfant.on("close", (code) => (code === 0 ? resolve(sortie) : reject(new Error(`code ${code}`))));
      });
    const secrets = await Promise.all([lancer(), lancer(), lancer(), lancer()]);
    expect(new Set(secrets).size).toBe(1);
    expect(secrets[0]).toMatch(/^ELPIS_[0-9a-f]{64}$/);
    expect(readFileSync(path.join(base, "db", ".session_secret"), "utf-8")).toBe(secrets[0]);
  });
});

describe("avertissement de secret faible", () => {
  it("source env : texte de Python, longueur en points de code après strip", () => {
    const { secret, erreurs } = demarrer(dossier(), { APP_SESSION_SECRET: " court " });
    expect(secret).toBe(" court ");
    expect(erreurs).toContain("[CRITICAL] Elpis SESSION_SECRET FAIBLE/PAR DÉFAUT (source=env, len=5)");
    expect(erreurs).toContain("cookies de session FORGEABLES");
  });

  it("une valeur d'exemple passée par l'env est utilisée mais signalée", () => {
    const { secret, erreurs } = demarrer(dossier(), { APP_SESSION_SECRET: `ChangeMe${" ".repeat(40)}` });
    expect(secret).toBe(`ChangeMe${" ".repeat(40)}`);
    expect(erreurs).toContain("source=env, len=8");
  });

  it("32 points de code ou plus, hors valeurs d'exemple : aucun avertissement", () => {
    expect(demarrer(dossier(), { APP_SESSION_SECRET: "é".repeat(32) }).erreurs).toBe("");
    expect(demarrer(dossier(), { APP_SESSION_SECRET: "x".repeat(31) }).erreurs).toContain("len=31");
  });
});
