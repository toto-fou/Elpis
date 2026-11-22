// SPDX-License-Identifier: MIT
/** packages/securite/test/chiffrement-explicite.test.ts — `APP_ENCRYPTION_KEY_PATH` : fichier explicite lu seulement, jamais créé, avant config.json (alors ignoré, signalé). */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { coerceToFernetKey, Fernet, loadOrCreateKey } from "../src/chiffrement";
import { capturerJournal } from "./aides";

const dossiers: string[] = [];

function dossier(): string {
  const d = mkdtempSync(join(tmpdir(), "elpis-cle-explicite-"));
  dossiers.push(d);
  return d;
}

afterAll(() => {
  for (const d of dossiers) rmSync(d, { recursive: true, force: true });
});

describe("clé héritée : fichier explicite", () => {
  it("lit le fichier explicite sans rien créer, même à côté de la base", () => {
    const d = dossier();
    const cle = Fernet.generateKey();
    const explicite = join(d, "encryption.key");
    writeFileSync(explicite, `${cle}\n`);
    const fichierCle = join(d, "user_db", ".encryption_key");
    expect(loadOrCreateKey({ fichierCle, fichierExplicite: explicite })).toBe(cle);
    expect(existsSync(join(d, "user_db"))).toBe(false);
    expect(readdirSync(d)).toEqual(["encryption.key"]);
  });

  it("un fichier absent donne CRITICAL nommant la variable, sans création", () => {
    const d = dossier();
    const journal = capturerJournal();
    const explicite = join(d, "absente", "encryption.key");
    expect(
      loadOrCreateKey({ fichierCle: join(d, ".encryption_key"), fichierExplicite: explicite }),
    ).toBeNull();
    expect(journal.map(([n]) => n)).toEqual(["CRITICAL"]);
    expect(journal[0]?.[1]).toContain("APP_ENCRYPTION_KEY_PATH");
    expect(readdirSync(d)).toEqual([]);
  });

  it("un fichier vide ou un chemin relatif donne CRITICAL, fichier intact", () => {
    const d = dossier();
    const vide = join(d, "vide.key");
    writeFileSync(vide, "  \n");
    const journal = capturerJournal();
    expect(loadOrCreateKey({ fichierCle: join(d, "x"), fichierExplicite: vide })).toBeNull();
    expect(loadOrCreateKey({ fichierCle: join(d, "x"), fichierExplicite: "relatif.key" })).toBeNull();
    expect(
      journal.filter(([n, m]) => n === "CRITICAL" && (m ?? "").includes("APP_ENCRYPTION_KEY_PATH")),
    ).toHaveLength(2);
    expect(readdirSync(d)).toEqual(["vide.key"]);
  });

  it("précédence : valeur d'environnement, puis fichier explicite (config.json ignoré, signalé une fois), puis config.json", () => {
    const d = dossier();
    const cle = Fernet.generateKey();
    const explicite = join(d, "encryption.key");
    writeFileSync(explicite, cle);
    const fichierCle = join(d, ".encryption_key");
    expect(
      loadOrCreateKey({
        cleEnv: "valeur-env",
        cleConfig: "valeur-json",
        fichierCle,
        fichierExplicite: explicite,
      }),
    ).toBe(coerceToFernetKey("valeur-env"));
    const journal = capturerJournal();
    expect(loadOrCreateKey({ cleConfig: "valeur-json", fichierCle, fichierExplicite: explicite })).toBe(cle);
    expect(loadOrCreateKey({ cleConfig: 42, fichierCle, fichierExplicite: explicite })).toBe(cle);
    expect(
      journal.filter(([, m]) => (m ?? "").includes("app.encryption_key de config.json ignorée")),
    ).toHaveLength(1);
    expect(loadOrCreateKey({ cleConfig: "valeur-json", fichierCle, fichierExplicite: "" })).toBe(
      coerceToFernetKey("valeur-json"),
    );
  });

  it("sans variable, le fichier près de la base est créé comme avant", () => {
    const d = dossier();
    const fichierCle = join(d, "user_db", ".encryption_key");
    const cle = loadOrCreateKey({ fichierCle, fichierExplicite: "" });
    expect(cle).toBeTruthy();
    expect(existsSync(fichierCle)).toBe(true);
  });
});
