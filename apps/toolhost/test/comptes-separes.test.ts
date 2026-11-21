// SPDX-License-Identifier: MIT
/** apps/toolhost/test/comptes-separes.test.ts — un compte par service (`ELPIS_GROUPE_DONNEES`, ici le groupe principal de ce compte) : cache d'aperçus, verrous Office, compagnons des sessions navigateur, verrous d'écriture et racine des bacs ouverts au groupe ; certificat du bac en 0644 quel que soit l'umask. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { racinePrivee } from "@elpis/bac";
import { prendreVerrouEcriture } from "@elpis/fichiers";
import { getPwSessionOwner, pwOwnerPath, registerPwSessionOwner } from "@elpis/navigateur";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { poserCertificat } from "../src/mcp/browser/bac";
import { cacheRoot } from "../src/office/apercu";
import { releaseLock, surchargerDossierVerrous, tryLock } from "../src/office/conversion";

const GID = String(process.getgid?.() ?? 0);
let dossier = "";

const mode = (p: string): number => statSync(p).mode & 0o7777;

beforeEach(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-comptes-hote-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  surchargerDossierVerrous(null);
  rmSync(dossier, { recursive: true, force: true });
});

describe("sous le groupe des données", () => {
  beforeEach(() => {
    vi.stubEnv("ELPIS_GROUPE_DONNEES", GID);
  });

  it("cache d'aperçus : racine du groupe acceptée telle quelle, créée en 0770 ; dossier des verrous en 0770", async () => {
    const partagee = path.join(dossier, "cache");
    mkdirSync(partagee);
    chmodSync(partagee, 0o770);
    vi.stubEnv("APP_OFFICE_CACHE_DIR", partagee);
    expect(cacheRoot()).toBe(partagee);
    expect(mode(partagee)).toBe(0o770);
    chmodSync(partagee, 0o775);
    expect(cacheRoot()).toBe(partagee);
    expect(mode(partagee)).toBe(0o770);
    vi.stubEnv("APP_OFFICE_CACHE_DIR", path.join(dossier, "neuve"));
    expect(mode(cacheRoot())).toBe(0o770);
    surchargerDossierVerrous(path.join(dossier, "verrous"));
    releaseLock(await tryLock("essai"));
    expect(mode(path.join(dossier, "verrous"))).toBe(0o770);
  });

  it("compagnons des sessions navigateur : dossier du groupe accepté (écrits et relus)", async () => {
    const d = path.join(dossier, "pw");
    mkdirSync(d);
    chmodSync(d, 0o770);
    vi.stubEnv("PW_OWNERS_DIR", d);
    await registerPwSessionOwner("abcdef0123", "alice");
    expect(readFileSync(pwOwnerPath("abcdef0123") ?? "", "utf8")).toBe("alice");
    expect(await getPwSessionOwner("abcdef0123")).toBe("alice");
  });

  it("verrous d'écriture et racine des bacs en 0770 (main y élague)", async () => {
    const bacs = path.join(dossier, "bacs");
    vi.stubEnv("APP_SANDBOX_DIR", bacs);
    const v = await prendreVerrouEcriture(path.join(bacs, "alice", "f.txt"), { delaiS: 1 });
    v.rendre();
    expect(mode(path.join(bacs, ".write_locks"))).toBe(0o770);
    chmodSync(bacs, 0o775);
    racinePrivee(bacs);
    expect(mode(bacs)).toBe(0o770);
  });
});

describe("compte unique : modes d'aujourd'hui", () => {
  it("racine du cache et des bacs ouvertes au groupe resserrées en 0700, compagnons ignorés", async () => {
    const racine = path.join(dossier, "cache");
    mkdirSync(racine);
    chmodSync(racine, 0o770);
    vi.stubEnv("APP_OFFICE_CACHE_DIR", racine);
    cacheRoot();
    expect(mode(racine)).toBe(0o700);
    const bacs = path.join(dossier, "bacs");
    mkdirSync(bacs, { mode: 0o775 });
    chmodSync(bacs, 0o775);
    racinePrivee(bacs);
    expect(mode(bacs)).toBe(0o700);
    const d = path.join(dossier, "pw");
    mkdirSync(d);
    chmodSync(d, 0o770);
    vi.stubEnv("PW_OWNERS_DIR", d);
    await registerPwSessionOwner("abcdef0124", "bob");
    expect(() => statSync(pwOwnerPath("abcdef0124") ?? "")).toThrow();
  });
});

describe("chemins lus par le compte des bacs", () => {
  it("certificat de l'autorité en 0644 quel que soit l'umask de l'unité", () => {
    const ca = path.join(dossier, "browser-ca.crt");
    const avant = process.umask(0o077);
    try {
      poserCertificat(ca, "PEM\n");
    } finally {
      process.umask(avant);
    }
    expect(mode(ca)).toBe(0o644);
  });
});
