// SPDX-License-Identifier: MIT
/** packages/config/test/donnees-deplacees.test.ts — défauts des dossiers de données (MCP perso, skills perso, skins) : ceux du Python en installation standard, voisins de la base quand l'instance est déplacée ; env et config.json toujours prioritaires. */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { calculerReglages } from "../src/reglages";

let tmp: string;
let racine: string;

beforeEach(() => {
  tmp = realpathSync(mkdtempSync(path.join(tmpdir(), "elpis-donnees-")));
  racine = path.join(tmp, "racine");
  mkdirSync(racine);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function calculer(env: Record<string, string>, config?: Record<string, unknown>) {
  const cheminConfig = path.join(tmp, "config.json");
  if (config !== undefined) writeFileSync(cheminConfig, JSON.stringify(config));
  const { reglages } = calculerReglages(
    { APP_CONFIG_PATH: cheminConfig, ...env },
    config ?? {},
    racine,
    cheminConfig,
  );
  return reglages;
}

function dossiers(r: ReturnType<typeof calculer>): Record<string, string> {
  return { mcp: r.MCP_SERVERS_DIR, skills: r.USER_SKILLS_DIR, skins: r.SKINS_DIR };
}

describe("dossiers de données par défaut", () => {
  it("installation standard (base sous <racine>/user_db) : défauts du Python, rien créé près de la base", () => {
    const r = calculer({});
    expect(dossiers(r)).toEqual({
      mcp: path.join(tmp, "mcp_custom_servers"),
      skills: path.join(racine, "user_skills"),
      skins: path.join(racine, "user_skins"),
    });
    expect(existsSync(path.join(racine, "user_db", "mcp_custom_servers"))).toBe(false);
  });

  it("<racine>/user_db lien vers un autre dossier : toujours l'installation standard", () => {
    mkdirSync(path.join(tmp, "ailleurs"));
    symlinkSync(path.join(tmp, "ailleurs"), path.join(racine, "user_db"));
    const r = calculer({});
    expect(dossiers(r)).toEqual({
      mcp: path.join(tmp, "mcp_custom_servers"),
      skills: path.join(racine, "user_skills"),
      skins: path.join(racine, "user_skins"),
    });
  });

  it("<racine>/user_db/app.db lien vers un fichier ailleurs : toujours l'installation standard (on regarde le chemin écrit, pas la cible)", () => {
    mkdirSync(path.join(tmp, "ailleurs"));
    writeFileSync(path.join(tmp, "ailleurs", "app.db"), "");
    mkdirSync(path.join(racine, "user_db"));
    symlinkSync(path.join(tmp, "ailleurs", "app.db"), path.join(racine, "user_db", "app.db"));
    for (const env of [{}, { APP_DB_PATH: path.join(racine, "user_db", "app.db") }] as Record<
      string,
      string
    >[]) {
      expect(dossiers(calculer(env)).skills).toBe(path.join(racine, "user_skills"));
    }
  });

  it("base déplacée par APP_DB_PATH : les trois dossiers suivent le dossier de la base, le dossier MCP y est créé et rien n'est créé hors des données", () => {
    const base = path.join(tmp, "donnees", "db");
    const r = calculer({ APP_DB_PATH: path.join(base, "app.db") });
    expect(dossiers(r)).toEqual({
      mcp: path.join(base, "mcp_custom_servers"),
      skills: path.join(base, "user_skills"),
      skins: path.join(base, "user_skins"),
    });
    expect(existsSync(path.join(base, "mcp_custom_servers"))).toBe(true);
    expect(existsSync(path.join(tmp, "mcp_custom_servers"))).toBe(false);
    expect(existsSync(path.join(racine, "user_skills"))).toBe(false);
  });

  it("base déplacée par app.db_path (relatif à la racine) dans config.json", () => {
    const r = calculer({}, { app: { db_path: "donnees/app.db" } });
    const base = path.join(racine, "donnees");
    expect(dossiers(r)).toEqual({
      mcp: path.join(base, "mcp_custom_servers"),
      skills: path.join(base, "user_skills"),
      skins: path.join(base, "user_skins"),
    });
  });

  it("base déplacée mais données déjà dans les dossiers du Python : conservées tant que le voisin de la base n'existe pas", () => {
    const base = path.join(tmp, "donnees");
    const env = { APP_DB_PATH: path.join(base, "app.db") };
    mkdirSync(path.join(racine, "user_skills"));
    writeFileSync(path.join(racine, "user_skills", "alice"), "");
    mkdirSync(path.join(racine, "user_skins"));
    mkdirSync(path.join(tmp, "mcp_custom_servers"));
    writeFileSync(path.join(tmp, "mcp_custom_servers", "srv"), "");
    expect(dossiers(calculer(env))).toEqual({
      mcp: path.join(tmp, "mcp_custom_servers"),
      skills: path.join(racine, "user_skills"),
      skins: path.join(base, "user_skins"),
    });
    mkdirSync(path.join(base, "user_skills"), { recursive: true });
    expect(dossiers(calculer(env)).skills).toBe(path.join(base, "user_skills"));
  });

  it("réglage explicite égal au défaut du Python sur une base déplacée : respecté", () => {
    const r = calculer(
      { APP_DB_PATH: path.join(tmp, "donnees", "app.db") },
      { skins: { dir: "user_skins" }, skills: { user_dir: "user_skills" } },
    );
    expect(r.SKINS_DIR).toBe(path.join(racine, "user_skins"));
    expect(r.USER_SKILLS_DIR).toBe(path.join(racine, "user_skills"));
  });

  it("env et config.json restent prioritaires, un par un, même sur une base déplacée", () => {
    const base = path.join(tmp, "donnees");
    const r = calculer(
      { APP_DB_PATH: path.join(base, "app.db"), MCP_SERVERS_DIR: path.join(tmp, "mes-mcp") },
      { skills: { user_dir: "mes-skills" }, skins: { dir: path.join(tmp, "mes-skins") } },
    );
    expect(dossiers(r)).toEqual({
      mcp: path.join(tmp, "mes-mcp"),
      skills: path.join(racine, "mes-skills"),
      skins: path.join(tmp, "mes-skins"),
    });
    const env = calculer(
      {
        APP_DB_PATH: path.join(base, "app.db"),
        APP_USER_SKILLS_DIR: path.join(tmp, "s"),
        APP_SKINS_DIR: "peaux",
      },
      { mcp: { servers_dir: path.join(tmp, "m") } },
    );
    expect(dossiers(env)).toEqual({
      mcp: path.join(tmp, "m"),
      skills: path.join(tmp, "s"),
      skins: path.join(racine, "peaux"),
    });
  });
});
