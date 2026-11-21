// SPDX-License-Identifier: MIT
/** apps/core/test/comptes-separes.test.ts — un compte par service (`ELPIS_GROUPE_DONNEES`, ici le groupe principal de ce compte) : base SQLite, verrous, journal de sécurité, magasin du RAG, cache d'aperçus, graphiques et mot de passe de base ouverts au groupe ; compte unique inchangé. */
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { durcirDroits } from "@elpis/db";
import { arreterAudit, auditEvent, configureAudit, ouvrirDossierSous } from "@elpis/securite";
import { VerrouFichier } from "@elpis/verrous";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { chartsDir, saveChartConfig } from "../src/graphiques/moteur/cache";
import { savePassword } from "../src/ops/bascule";
import { elaguerCacheOffice } from "../src/ops/balayages";
import { creerDossiersCollectionRag, modeFichierRag } from "../src/rag/magasin";
import { noterPurgeQdrant } from "../src/rag/qdrant";

const GID = process.getgid?.() ?? 0;
const AVEC_PROC_LOCKS = existsSync("/proc/locks");
let dossier = "";

const mode = (p: string): number => statSync(p).mode & 0o7777;

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-comptes-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dossier, { recursive: true, force: true });
});

describe("sous le groupe des données", () => {
  beforeEach(() => {
    vi.stubEnv("ELPIS_GROUPE_DONNEES", String(GID));
  });

  it("base SQLite et annexes en 0660 ; user_db laissé à l'installation (traversable par le RAG)", () => {
    const userDb = join(dossier, "user_db");
    mkdirSync(userDb, { mode: 0o771 });
    chmodSync(userDb, 0o771);
    const base = join(userDb, "app.db");
    expect(durcirDroits(base, dossier)).toEqual([]);
    expect(mode(base)).toBe(0o660);
    writeFileSync(`${base}-wal`, "");
    chmodSync(`${base}-wal`, 0o664);
    expect(durcirDroits(base, dossier)).toEqual([`${base}-wal`]);
    expect([mode(`${base}-wal`), mode(userDb)]).toEqual([0o660, 0o771]);
  });

  it("fichier de verrou lisible par les autres services (0660)", async () => {
    const p = join(dossier, "partage.lock");
    const v = new VerrouFichier(p);
    await v.acquerir();
    try {
      expect(mode(p)).toBe(0o660);
    } finally {
      await v.rendre();
    }
  });

  it("journal de sécurité : fichier du jour 0660 (les trois services y ajoutent), dossier créé 0770", () => {
    const audit = join(dossier, "audit");
    configureAudit({ auditDir: audit, hmacKeyPath: join(dossier, "absente") });
    const avant = process.umask(0o077);
    try {
      auditEvent({ userId: null, username: null, action: "a" });
    } finally {
      process.umask(avant);
      arreterAudit();
    }
    const [nom] = readdirSync(audit);
    expect([mode(audit), mode(join(audit, nom as string))]).toEqual([0o770, 0o660]);
  });

  it("magasin du RAG : dossiers 0770 et fichiers 0660 au groupe du magasin (main écrit, la console supprime), setgid hérité gardé", () => {
    const magasin = join(dossier, "rag");
    mkdirSync(magasin);
    chmodSync(magasin, 0o2770);
    vi.stubEnv("RAG_STORE_DIR", magasin);
    const collection = "0f8fad5b-d9cb-469f-a165-70867728950e";
    creerDossiersCollectionRag(7, collection);
    for (const rel of ["7", `7/${collection}`, `7/${collection}/sources`, `7/${collection}/pages`])
      expect([rel, mode(join(magasin, rel))]).toEqual([rel, 0o2770]);
    expect(modeFichierRag()).toBe(0o660);
    noterPurgeQdrant(`c.${collection}`);
    expect([mode(join(magasin, ".purges")), mode(join(magasin, ".purges", `c.${collection}`))]).toEqual([
      0o2770, 0o660,
    ]);
    const fd = ouvrirDossierSous(dossier, "a/b", { creer: true, modeDossier: 0o750 });
    closeSync(fd);
    expect(mode(join(dossier, "a", "b"))).toBe(0o750);
  });

  it.skipIf(!AVEC_PROC_LOCKS)("cache d'aperçus du groupe : élagué par main sans être rechmodé", async () => {
    const racine = join(dossier, "cache");
    mkdirSync(racine);
    chmodSync(racine, 0o770);
    vi.stubEnv("APP_OFFICE_CACHE_DIR", racine);
    vi.stubEnv("ELPIS_OFFICE_LOCK_DIR", join(dossier, "verrous"));
    const restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    try {
      const cle = join(racine, "u", "alice", "a".repeat(40));
      mkdirSync(cle, { recursive: true });
      writeFileSync(join(cle, "manifest.json"), "{}");
      utimesSync(join(cle, "manifest.json"), 1, 1);
      expect((await elaguerCacheOffice()).removed).toBe(1);
      expect(mode(racine)).toBe(0o770);
    } finally {
      restaurer();
      invalidateConfigCache();
    }
  });

  it("graphiques lisibles par l'hôte d'outils (0750/0640), mot de passe de base lisible par le groupe (0640)", () => {
    vi.stubEnv("CHART_CACHE_DIR", join(dossier, "graphiques"));
    const id = saveChartConfig({ series: [] }, "alice");
    const d = chartsDir("alice");
    expect([mode(join(dossier, "graphiques")), mode(d), mode(join(d, `${id}.json`))]).toEqual([
      0o750, 0o750, 0o640,
    ]);
    const restaurer = surchargerConfig({ DB_PATH: join(dossier, "app.db") });
    try {
      savePassword("x");
      expect(mode(join(dossier, ".db_password"))).toBe(0o640);
    } finally {
      restaurer();
    }
  });
});

describe("compte unique : modes d'aujourd'hui", () => {
  it("base 0600, verrou 0600, cache d'aperçus ouvert au groupe rechmodé en 0700, graphiques 0700/0600", async () => {
    const base = join(dossier, "user_db", "app.db");
    durcirDroits(base, dossier);
    expect([mode(base), mode(join(dossier, "user_db"))]).toEqual([0o600, 0o700]);
    const p = join(dossier, "seul.lock");
    const v = new VerrouFichier(p);
    await v.acquerir();
    expect(mode(p)).toBe(0o600);
    await v.rendre();
    const racine = join(dossier, "cache");
    mkdirSync(racine);
    chmodSync(racine, 0o770);
    vi.stubEnv("APP_OFFICE_CACHE_DIR", racine);
    vi.stubEnv("ELPIS_OFFICE_LOCK_DIR", join(dossier, "verrous"));
    const restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    try {
      await elaguerCacheOffice();
    } finally {
      restaurer();
      invalidateConfigCache();
    }
    if (AVEC_PROC_LOCKS) expect(mode(racine)).toBe(0o700);
    vi.stubEnv("CHART_CACHE_DIR", join(dossier, "graphiques"));
    const id = saveChartConfig({ series: [] }, "bob");
    expect([mode(chartsDir("bob")), mode(join(chartsDir("bob"), `${id}.json`))]).toEqual([0o700, 0o600]);
  });
});
