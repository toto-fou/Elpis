// SPDX-License-Identifier: MIT
/** apps/toolhost/test/comptes-separes.test.ts — un compte par service (`ELPIS_GROUPE_DONNEES`, ici le groupe principal de ce compte) : cache d'aperçus, verrous Office et verrous d'écriture à l'hôte d'outils seul, racine des bacs lisible du groupe sans qu'il l'écrive, compagnons des sessions navigateur au groupe ; certificat du bac en 0644 quel que soit l'umask. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { racinePrivee } from "@elpis/bac";
import { prendreVerrouEcriture } from "@elpis/fichiers";
import { getPwSessionOwner, pwOwnerPath, registerPwSessionOwner } from "@elpis/navigateur";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { poserCertificat } from "../src/mcp/browser/bac";
import { cacheRoot } from "../src/office/apercu";
import { dossierVerrous, releaseLock, surchargerDossierVerrous, tryLock } from "../src/office/conversion";

const GID = String(process.getgid?.() ?? 0);
let dossier = "";

const mode = (p: string): number => statSync(p).mode & 0o7777;

beforeEach(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-comptes-hote-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  surchargerDossierVerrous(null);
  rmSync(dossier, { recursive: true, force: true });
});

describe("sous le groupe des données", () => {
  beforeEach(() => {
    vi.stubEnv("ELPIS_GROUPE_DONNEES", GID);
  });

  it("cache d'aperçus : racine ouverte au groupe resserrée en 0700, créée en 0700 ; dossier des verrous en 0700", async () => {
    const partagee = path.join(dossier, "cache");
    mkdirSync(partagee);
    chmodSync(partagee, 0o2770);
    vi.stubEnv("APP_OFFICE_CACHE_DIR", partagee);
    expect(cacheRoot()).toBe(partagee);
    expect(mode(partagee)).toBe(0o700);
    vi.stubEnv("APP_OFFICE_CACHE_DIR", path.join(dossier, "neuve"));
    expect(mode(cacheRoot())).toBe(0o700);
    surchargerDossierVerrous(path.join(dossier, "verrous"));
    releaseLock(await tryLock("essai"));
    expect(mode(path.join(dossier, "verrous"))).toBe(0o700);
  });

  it("verrous Office : dans le dossier d'exécution privé de l'unité, jamais dans celui qu'elle partage", () => {
    vi.stubEnv("ELPIS_OFFICE_LOCK_DIR", "");
    vi.stubEnv("ELPIS_RUNTIME_DIR", path.join(dossier, "partage"));
    vi.stubEnv("RUNTIME_DIRECTORY", `${path.join(dossier, "prive")}:${path.join(dossier, "autre")}`);
    expect(dossierVerrous()).toBe(path.join(dossier, "prive", "office_locks"));
    vi.stubEnv("RUNTIME_DIRECTORY", "");
    expect(dossierVerrous()).toBe(path.join(dossier, "partage", "office_locks"));
  });

  it("dossier des verrous Office d'un autre compte : refus aussitôt (jamais une attente), détail au journal", async () => {
    const autre = path.join(dossier, "verrous-autre");
    mkdirSync(autre);
    chmodSync(autre, 0o2770);
    surchargerDossierVerrous(autre);
    vi.spyOn(process, "geteuid").mockReturnValue((process.geteuid?.() ?? 0) + 1);
    await expect(tryLock("essai")).rejects.toMatchObject({ code: "failed" });
    expect(mode(autre)).toBe(0o2770);
  });

  it("cache d'aperçus d'un autre compte, ou lien à sa place : refusé", () => {
    vi.spyOn(process, "geteuid").mockReturnValue((process.geteuid?.() ?? 0) + 1);
    const autre = path.join(dossier, "autre");
    mkdirSync(autre, { mode: 0o700 });
    vi.stubEnv("APP_OFFICE_CACHE_DIR", autre);
    expect(() => cacheRoot()).toThrow("Cache d'aperçu non sûr");
    vi.restoreAllMocks();
    symlinkSync(autre, path.join(dossier, "lien"));
    vi.stubEnv("APP_OFFICE_CACHE_DIR", path.join(dossier, "lien"));
    expect(() => cacheRoot()).toThrow("Cache d'aperçu non sûr");
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

  it("verrous d'écriture en 0700 ; racine des bacs lisible du groupe sans qu'il l'écrive (0750, setgid gardé)", async () => {
    const bacs = path.join(dossier, "bacs");
    vi.stubEnv("APP_SANDBOX_DIR", bacs);
    const v = await prendreVerrouEcriture(path.join(bacs, "alice", "f.txt"), { delaiS: 1 });
    v.rendre();
    expect(mode(path.join(bacs, ".write_locks"))).toBe(0o700);
    chmodSync(bacs, 0o775);
    racinePrivee(bacs);
    expect(mode(bacs)).toBe(0o750);
    chmodSync(bacs, 0o2770);
    racinePrivee(bacs);
    expect(mode(bacs)).toBe(0o2750);
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
