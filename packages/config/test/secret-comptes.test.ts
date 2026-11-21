// SPDX-License-Identifier: MIT
/** packages/config/test/secret-comptes.test.ts — secret de session et comptes des services : l'hôte d'outils ne touche jamais au fichier, un fichier illisible pour ce compte n'est jamais remplacé, le groupe de clé posé par l'installation est gardé. */
import { DOSSIER_TEST } from "./environnement";

import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { calculerReglages } from "../src/reglages";

const RACINE = realpathSync(path.resolve(import.meta.dirname, "..", "..", ".."));
const FORT = `fort-${"a".repeat(64)}`;
const ROOT = process.geteuid?.() === 0;

afterAll(() => {
  rmSync(DOSSIER_TEST, { recursive: true, force: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

function dossier(): string {
  return realpathSync(mkdtempSync(path.join(DOSSIER_TEST, "secret-comptes-")));
}

/** Réglages d'un démarrage avec la base dans `base`, et ce qu'il écrit sur stderr. */
function demarrer(base: string, env: Record<string, string> = {}) {
  let erreurs = "";
  const espion = vi.spyOn(process.stderr, "write").mockImplementation(((morceau: string) => {
    erreurs += morceau;
    return true;
  }) as typeof process.stderr.write);
  try {
    const env2 = { APP_DB_PATH: path.join(base, "app.db"), MCP_SERVERS_DIR: path.join(base, "mcp"), ...env };
    const { reglages } = calculerReglages(env2, {}, RACINE, path.join(base, "config.json"));
    return { secret: reglages.SESSION_SECRET, erreurs };
  } finally {
    espion.mockRestore();
  }
}

const fichierSecret = (base: string): string => path.join(base, ".session_secret");
/** Fichiers du dossier de la base, hors du dossier des serveurs MCP que le calcul crée. */
const contenu = (base: string): string[] => readdirSync(base).filter((n) => n !== "mcp");

describe("hôte d'outils (APP_SERVICE=toolhost)", () => {
  it("ne crée jamais le fichier", () => {
    const base = dossier();
    const { secret, erreurs } = demarrer(base, { APP_SERVICE: "toolhost" });
    expect(secret).toMatch(/^EPHEMERAL_[0-9a-f]{32}$/);
    expect(erreurs).toBe("");
    expect(contenu(base)).toEqual([]);
  });

  it("ne lit, ne resserre ni ne remplace un fichier existant, même élargi ou trop court", () => {
    const base = dossier();
    writeFileSync(fichierSecret(base), `${FORT}\n`);
    chmodSync(fichierSecret(base), 0o664);
    expect(demarrer(base, { APP_SERVICE: "toolhost" }).secret).toMatch(/^EPHEMERAL_/);
    expect(statSync(fichierSecret(base)).mode & 0o777).toBe(0o664);
    writeFileSync(fichierSecret(base), "court");
    demarrer(base, { APP_SERVICE: "toolhost" });
    expect(readFileSync(fichierSecret(base), "utf8")).toBe("court");
    expect(contenu(base)).toEqual([".session_secret"]);
  });

  it("l'environnement et config.json passent toujours avant", () => {
    const { secret } = demarrer(dossier(), { APP_SERVICE: "toolhost", APP_SESSION_SECRET: FORT });
    expect(secret).toBe(FORT);
  });
});

describe.skipIf(ROOT)("fichier illisible pour ce compte (autre compte de service)", () => {
  it("jamais remplacé ni verrouillé ; alerte critique pour main et la console seulement", () => {
    const base = dossier();
    writeFileSync(fichierSecret(base), FORT);
    chmodSync(fichierSecret(base), 0o000);
    try {
      const cli = demarrer(base);
      expect(cli.secret).toMatch(/^EPHEMERAL_/);
      expect(cli.erreurs).toBe("");
      const main = demarrer(base, { APP_MODE: "main" });
      expect(main.secret).toMatch(/^EPHEMERAL_/);
      expect(main.erreurs).toContain("SESSION_SECRET illisible pour ce compte");
      expect(contenu(base)).toEqual([".session_secret"]);
    } finally {
      chmodSync(fichierSecret(base), 0o600);
    }
    expect(readFileSync(fichierSecret(base), "utf8")).toBe(FORT);
  });
});

describe("groupe des données", () => {
  it("créé en 0600 (jamais lisible par le groupe des données) ; existant : seuls les droits des autres retirés", () => {
    vi.stubEnv("ELPIS_GROUPE_DONNEES", String(process.getgid?.() ?? 0));
    const neuf = dossier();
    expect(demarrer(neuf).secret).toMatch(/^ELPIS_[0-9a-f]{64}$/);
    expect(statSync(fichierSecret(neuf)).mode & 0o777).toBe(0o600);
    const base = dossier();
    writeFileSync(fichierSecret(base), FORT);
    chmodSync(fichierSecret(base), 0o644);
    const { secret, erreurs } = demarrer(base);
    expect(secret).toBe(FORT);
    expect(statSync(fichierSecret(base)).mode & 0o777).toBe(0o640);
    expect(erreurs).toContain("remis en 0640");
    chmodSync(fichierSecret(base), 0o640);
    expect(demarrer(base).erreurs).toBe("");
    expect(existsSync(`${fichierSecret(base)}.lock`)).toBe(false);
  });
});
