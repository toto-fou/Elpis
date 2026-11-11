// SPDX-License-Identifier: MIT
/** packages/securite/test/chiffrement.test.ts — Fernet et clé maître rejouent `cryptography` et encryption.py. */
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";

import { urlsafeB64Decode } from "../src/base64";
import {
  ATTENTE_ECRITURE_S,
  coerceToFernetKey,
  configurerChiffrement,
  decrypt,
  deriveFernetKey,
  encrypt,
  EncryptionUnavailable,
  encryptFromParts,
  encryptionKeyPath,
  Fernet,
  InvalidToken,
  loadOrCreateKey,
} from "../src/chiffrement";
import { brancherJournal } from "../src/ports";
import { attendu, capturerJournal, essai, vecteurs } from "./aides";

const dossiers: string[] = [];

function dossierTemporaire(): string {
  const d = mkdtempSync(join(tmpdir(), "elpis-securite-"));
  dossiers.push(d);
  return d;
}

afterAll(() => {
  for (const d of dossiers) rmSync(d, { recursive: true, force: true });
});

afterEach(() => {
  brancherJournal(null);
});

describe("chiffrement non configuré", () => {
  it("encrypt et decrypt refusent tant que la source de la clé n'est pas posée", () => {
    expect(() => encrypt("x")).toThrow(/non configuré/);
    expect(() => decrypt("x")).toThrow(/non configuré/);
  });
});

describe("vecteurs Fernet de cryptography (IV et heure imposés)", () => {
  for (const [i, cas] of vecteurs.fernet.jetons.entries()) {
    it(`${i} : ${cas.clair_hex.length / 2} octets, heure ${cas.heure}`, () => {
      const clair = Buffer.from(cas.clair_hex, "hex");
      expect(encryptFromParts(cas.cle, clair, BigInt(cas.heure), Buffer.from(cas.iv, "hex"))).toBe(cas.jeton);
      expect(new Fernet(cas.cle).decrypt(cas.jeton).toString("hex")).toBe(cas.clair_hex);
      configurerChiffrement({ cleEnv: cas.cle, fichierCle: "/inexistant/.encryption_key" });
      const journal = capturerJournal();
      expect(decrypt(cas.jeton)).toBe(cas.clair ?? "");
      expect(journal).toHaveLength(cas.clair === null ? 1 : 0);
    });
  }
});

describe("jetons altérés : mêmes refus que Python, au niveau Fernet et du module", () => {
  for (const cas of vecteurs.fernet.alteres) {
    it(cas.nom, () => {
      expect(essai(() => new Fernet(cas.cle).decrypt(cas.jeton).toString("hex"))).toEqual(attendu(cas));
      configurerChiffrement({ cleEnv: cas.cle, fichierCle: "/inexistant/.encryption_key" });
      const journal = capturerJournal();
      expect(decrypt(cas.jeton)).toBe(cas.module.clair);
      expect(journal).toEqual(cas.module.journal);
    });
  }
});

describe("durée de vie (decrypt_at_time)", () => {
  for (const cas of vecteurs.fernet.ttl) {
    it(cas.nom, () => {
      const ttl = cas.ttl === null ? null : BigInt(cas.ttl);
      const obtenu = essai(() =>
        new Fernet(cas.cle).decryptAtTime(cas.jeton, ttl, BigInt(cas.maintenant)).toString("hex"),
      );
      expect(obtenu).toEqual(attendu(cas));
    });
  }

  it("decrypt sans ttl ne regarde pas l'heure ; avec ttl, elle compte", () => {
    const cle = Fernet.generateKey();
    const ancien = new Fernet(cle).encryptAtTime(Buffer.from("x"), 1000);
    expect(new Fernet(cle).decrypt(ancien).toString()).toBe("x");
    expect(() => new Fernet(cle).decrypt(ancien, 60)).toThrow(InvalidToken);
    const futur = new Fernet(cle).encryptAtTime(Buffer.from("y"), Math.floor(Date.now() / 1000) + 3600);
    expect(() => new Fernet(cle).decrypt(futur, 7200)).toThrow(InvalidToken);
    expect(new Fernet(cle).decrypt(new Fernet(cle).encrypt(Buffer.from("z")), 60).toString()).toBe("z");
  });

  it("refuse une heure hors de 0..2^64-1 ou non entière, comme to_bytes(8)", () => {
    const f = new Fernet(Fernet.generateKey());
    expect(essai(() => f.encryptAtTime(Buffer.from("x"), -1))).toEqual({ erreur: "OverflowError" });
    expect(essai(() => f.encryptAtTime(Buffer.from("x"), 2n ** 64n))).toEqual({ erreur: "OverflowError" });
    expect(essai(() => f.encryptAtTime(Buffer.from("x"), 1.5))).toEqual({ erreur: "TypeError" });
    expect(essai(() => encryptFromParts(Fernet.generateKey(), Buffer.from("x"), 0, Buffer.alloc(8)))).toEqual(
      {
        erreur: "ValueError",
      },
    );
  });
});

describe("clés : dérivation et acceptation telle quelle", () => {
  for (const [i, cas] of vecteurs.fernet.derivation.entries()) {
    it(`dérive ${i} ${JSON.stringify(cas.entree).slice(0, 30)}`, () => {
      expect(essai(() => deriveFernetKey(cas.entree))).toEqual(attendu(cas));
    });
  }

  for (const [i, cas] of vecteurs.fernet.coercition.entries()) {
    it(`accepte ou dérive ${i} ${JSON.stringify(cas.entree).slice(0, 30)}`, () => {
      expect(essai(() => coerceToFernetKey(cas.entree))).toEqual(attendu(cas));
      if (cas.effective !== null) {
        expect(urlsafeB64Decode(coerceToFernetKey(cas.entree)).toString("hex")).toBe(cas.effective);
      }
    });
  }

  it("une clé générée fait 44 caractères base64url avec son `=`", () => {
    const cle = Fernet.generateKey();
    expect(cle).toMatch(/^[A-Za-z0-9_-]{43}=$/);
    expect(coerceToFernetKey(cle)).toBe(cle);
  });

  it("refuse une clé de mauvaise taille avec le message de cryptography", () => {
    expect(() => new Fernet("QUJD")).toThrow("Fernet key must be 32 url-safe base64-encoded bytes.");
    expect(() => new Fernet("A".repeat(43))).toThrow("Fernet key must be 32 url-safe base64-encoded bytes.");
    expect(() => new Fernet("clé")).toThrow(/ASCII/);
  });
});

describe("chemin de la clé à côté de la base", () => {
  for (const cas of vecteurs.chemins_cle) {
    it(JSON.stringify(cas.entree), () => {
      expect(encryptionKeyPath(cas.entree)).toBe(cas.sortie);
    });
  }
});

/** Écarts voulus : jamais de clé dérivée d'un non-texte. */
const REFUS_TS = new Set([
  "env_vide_config_entier",
  "config_vrai",
  "config_liste",
  "config_dict",
  "config_flottant",
]);

describe("source de la clé : env, config.json, fichier (vecteurs de _load_or_create_key)", () => {
  it("chaque écart voulu désigne un vecteur existant", () => {
    const noms = new Set(vecteurs.source_cle.map((c) => c.nom));
    for (const nom of REFUS_TS) expect(noms.has(nom)).toBe(true);
  });

  for (const cas of vecteurs.source_cle) {
    it(cas.nom, () => {
      const fichierCle = join(dossierTemporaire(), "base", ".encryption_key");
      if (cas.fichier === "$parent_fichier") {
        writeFileSync(dirname(fichierCle), "un fichier, pas un dossier");
      } else if (cas.fichier !== null) {
        mkdirSync(dirname(fichierCle), { recursive: true });
        writeFileSync(fichierCle, cas.fichier_octets ? Buffer.from(cas.fichier, "hex") : cas.fichier);
      }
      const avant = existsSync(fichierCle) ? readFileSync(fichierCle) : null;
      const journal = capturerJournal();
      const source = {
        cleEnv: cas.env,
        ...(cas.config === "$absent" ? {} : { cleConfig: cas.config }),
        fichierCle,
      };
      const obtenu = essai(() => loadOrCreateKey(source));
      const niveaux = journal.map(([niveau]) => niveau);
      if (REFUS_TS.has(cas.nom)) {
        expect(obtenu).toEqual({ sortie: null });
        expect(niveaux).toEqual(["CRITICAL"]);
        expect(existsSync(fichierCle) ? readFileSync(fichierCle) : null).toEqual(avant);
        return;
      }
      if (cas.erreur !== undefined) {
        expect(obtenu).toEqual({ erreur: cas.erreur });
        return;
      }
      if (cas.journal !== undefined) expect(niveaux).toEqual(cas.journal);
      if (!cas.genere) {
        expect(obtenu).toEqual({ sortie: cas.cle ?? null });
        return;
      }
      const cle = obtenu.sortie as string;
      expect(cle).toHaveLength(cas.longueur ?? 0);
      expect(readFileSync(fichierCle, "utf-8") === cle).toBe(cas.fichier_apres_egal_cle);
      expect("0o" + (statSync(fichierCle).mode & 0o777).toString(8)).toBe(cas.mode);
      expect(niveaux).toEqual(["WARNING"]);
      expect(() => new Fernet(cle)).not.toThrow();
      expect(loadOrCreateKey({ fichierCle })).toBe(cle);
    });
  }

  it("le message critique reprend celui de Python", () => {
    const fichierCle = join(dossierTemporaire(), "base", ".encryption_key");
    writeFileSync(dirname(fichierCle), "x");
    const journal = capturerJournal();
    expect(loadOrCreateKey({ fichierCle })).toBeNull();
    expect(journal).toHaveLength(1);
    expect(journal[0]?.[1]).toMatch(
      /^\[encryption\] Impossible de créer .* pour persister la clé de chiffrement \(/,
    );
    expect(journal[0]?.[1]).toMatch(/Définir APP_ENCRYPTION_KEY dans l'environnement\.$/);
  });
});

describe("fichier de clé existant : jamais régénéré ni remplacé", () => {
  it.skipIf(process.getuid?.() === 0)(
    "illisible (chmod 000) : CRITICAL, chiffrement indisponible, intact",
    () => {
      const fichierCle = join(dossierTemporaire(), ".encryption_key");
      const cle = Fernet.generateKey();
      writeFileSync(fichierCle, cle, { mode: 0o600 });
      chmodSync(fichierCle, 0o000);
      try {
        const journal = capturerJournal();
        expect(loadOrCreateKey({ fichierCle })).toBeNull();
        expect(journal.map(([niveau]) => niveau)).toEqual(["CRITICAL"]);
        expect(journal[0]?.[1]).toMatch(/illisible .* laissé intact, chiffrement indisponible/);
        configurerChiffrement({ fichierCle });
        expect(() => encrypt("x")).toThrow(EncryptionUnavailable);
        expect(decrypt("gAAAAA")).toBe("");
      } finally {
        chmodSync(fichierCle, 0o600);
      }
      expect(readFileSync(fichierCle, "utf-8")).toBe(cle);
      expect(readdirSync(dirname(fichierCle))).toEqual([".encryption_key"]);
    },
  );

  it("journal branché sans fatal : le refus passe en ERROR, jamais en silence", () => {
    const fichierCle = join(dossierTemporaire(), ".encryption_key");
    writeFileSync(fichierCle, "");
    const erreurs: string[] = [];
    const muet = (): void => undefined;
    brancherJournal(() => ({
      debug: muet,
      info: muet,
      warn: muet,
      error: (m: unknown) => erreurs.push(String(m)),
    }));
    configurerChiffrement({ fichierCle });
    expect(() => encrypt("x")).toThrow(EncryptionUnavailable);
    expect(erreurs).toHaveLength(1);
    expect(erreurs[0]).toMatch(/vide : laissé intact/);
  });

  it("vide : relu 1 s sous le verrou, puis refusé (CRITICAL) et laissé vide", () => {
    const fichierCle = join(dossierTemporaire(), ".encryption_key");
    writeFileSync(fichierCle, "");
    const journal = capturerJournal();
    configurerChiffrement({ fichierCle });
    const debut = performance.now();
    expect(() => encrypt("x")).toThrow(EncryptionUnavailable);
    expect(performance.now() - debut).toBeGreaterThanOrEqual(ATTENTE_ECRITURE_S * 1000 - 50);
    expect(journal.map(([niveau]) => niveau)).toEqual(["CRITICAL"]);
    expect(journal[0]?.[1]).toMatch(/vide : laissé intact/);
    expect(readFileSync(fichierCle, "utf-8")).toBe("");
  });

  it("vide, puis rempli par un autre processus avant 1 s : la clé du disque est lue", async () => {
    const fichierCle = join(dossierTemporaire(), ".encryption_key");
    writeFileSync(fichierCle, "");
    const cle = Fernet.generateKey();
    const code = `process.stdout.write("pret"); setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(fichierCle)}, ${JSON.stringify(cle)}), 50);`;
    const enfant = spawn(process.execPath, ["-e", code]);
    const fin = new Promise((r) => enfant.on("close", r));
    await new Promise((r) => enfant.stdout.once("data", r));
    const journal = capturerJournal();
    expect(loadOrCreateKey({ fichierCle })).toBe(cle);
    expect(journal).toEqual([]);
    await fin;
  });

  it.skipIf(process.getuid?.() === 0)(
    "vide dans un dossier en lecture seule (verrou impossible) : refusé comme vide, laissé intact",
    () => {
      const dossier = dossierTemporaire();
      const fichierCle = join(dossier, ".encryption_key");
      writeFileSync(fichierCle, "");
      chmodSync(dossier, 0o500);
      try {
        const journal = capturerJournal();
        expect(loadOrCreateKey({ fichierCle })).toBeNull();
        expect(journal.map(([niveau]) => niveau)).toEqual(["CRITICAL"]);
        expect(journal[0]?.[1]).toMatch(/vide : laissé intact/);
      } finally {
        chmodSync(dossier, 0o700);
      }
      expect(readdirSync(dossier)).toEqual([".encryption_key"]);
      expect(readFileSync(fichierCle, "utf-8")).toBe("");
    },
  );

  it("un chemin relatif est refusé (il dépendrait du dossier courant), sauf si l'env donne la clé", () => {
    const journal = capturerJournal();
    expect(loadOrCreateKey({ fichierCle: "user_db/.encryption_key" })).toBeNull();
    expect(journal.map(([niveau]) => niveau)).toEqual(["CRITICAL"]);
    expect(loadOrCreateKey({ cleEnv: "k", fichierCle: "relatif" })).toBe(deriveFernetKey("k"));
  });

  it("une clé de config.json non textuelle est refusée au lieu d'être dérivée de son str()", () => {
    const fichierCle = join(dossierTemporaire(), ".encryption_key");
    const journal = capturerJournal();
    for (const valeur of [12345, 2.0, true, ["a"], { k: "v" }]) {
      expect(loadOrCreateKey({ cleConfig: valeur, fichierCle })).toBeNull();
    }
    expect(journal.map(([niveau]) => niveau)).toEqual(Array(5).fill("CRITICAL"));
    expect(existsSync(fichierCle)).toBe(false);
    expect(loadOrCreateKey({ cleEnv: "k", cleConfig: 12345, fichierCle })).toBe(deriveFernetKey("k"));
    expect(loadOrCreateKey({ cleConfig: " k ", fichierCle })).toBe(deriveFernetKey("k"));
  });

  it("chaque création est journalisée, une relecture non, et aucun temporaire ne reste", () => {
    const fichierCle = join(dossierTemporaire(), "neuf", ".encryption_key");
    const journal = capturerJournal();
    const cle = loadOrCreateKey({ fichierCle });
    expect(journal).toEqual([
      [
        "WARNING",
        `[encryption] Nouvelle clé de chiffrement créée dans ${fichierCle} : la sauvegarder avec la base.`,
      ],
    ]);
    expect(loadOrCreateKey({ fichierCle })).toBe(cle);
    expect(journal).toHaveLength(1);
    expect(readdirSync(dirname(fichierCle))).toEqual([".encryption_key"]);
  });

  it("deux clés générées diffèrent, deux créations aussi", () => {
    capturerJournal();
    expect(Fernet.generateKey()).not.toBe(Fernet.generateKey());
    const a = loadOrCreateKey({ fichierCle: join(dossierTemporaire(), ".encryption_key") });
    const b = loadOrCreateKey({ fichierCle: join(dossierTemporaire(), ".encryption_key") });
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}=$/);
    expect(a).not.toBe(b);
  });
});

const RACINE = fileURLToPath(new URL("../../..", import.meta.url));
const MODULE = fileURLToPath(new URL("../src/chiffrement.ts", import.meta.url));

function processusCle(fichierCle: string, depart: number): Promise<{ cle: string; journal: string }> {
  const code = `
    const { loadOrCreateKey } = await import(${JSON.stringify(MODULE)});
    while (Date.now() < ${depart}) {}
    process.stdout.write(String(loadOrCreateKey({ fichierCle: ${JSON.stringify(fichierCle)} })));`;
  return new Promise((resoudre, rejeter) => {
    const enfant = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code], {
      cwd: RACINE,
    });
    let sortie = "";
    let erreurs = "";
    enfant.stdout.on("data", (d: Buffer) => (sortie += d.toString()));
    enfant.stderr.on("data", (d: Buffer) => (erreurs += d.toString()));
    enfant.on("error", rejeter);
    enfant.on("close", (code) =>
      code === 0 ? resoudre({ cle: sortie, journal: erreurs }) : rejeter(new Error(erreurs)),
    );
  });
}

describe("création concurrente (temporaire puis link, à la place du flock)", () => {
  it("six process lancés ensemble : même clé, celle du disque, créée une seule fois", async () => {
    const fichierCle = join(dossierTemporaire(), "base", ".encryption_key");
    const depart = Date.now() + 4000;
    const resultats = await Promise.all(Array.from({ length: 6 }, () => processusCle(fichierCle, depart)));
    const cles = new Set(resultats.map((r) => r.cle));
    expect(cles.size).toBe(1);
    expect([...cles][0]).toMatch(/^[A-Za-z0-9_-]{43}=$/);
    expect(readFileSync(fichierCle, "utf-8")).toBe(resultats[0]?.cle);
    expect(statSync(fichierCle).mode & 0o777).toBe(0o600);
    expect(resultats.filter((r) => r.journal.includes("Nouvelle clé de chiffrement créée"))).toHaveLength(1);
    expect(readdirSync(dirname(fichierCle))).toEqual([".encryption_key"]);
  }, 30_000);
});

describe("encrypt / decrypt du module", () => {
  let fichierCle = "";

  beforeEach(() => {
    fichierCle = join(dossierTemporaire(), "user_db", ".encryption_key");
  });

  it("chiffre au repos et relit ce qu'il a chiffré (clé dérivée de l'env, comme les tests Python)", () => {
    configurerChiffrement({ cleEnv: "unit-test-master-key", fichierCle });
    const jeton = encrypt("sk-ant-secret-été");
    expect(jeton).not.toContain("sk-ant");
    expect(jeton).toMatch(/^gAAAAA[A-Za-z0-9_-]+=*$/);
    expect(decrypt(jeton)).toBe("sk-ant-secret-été");
    expect(new Fernet(deriveFernetKey("unit-test-master-key")).decrypt(jeton).toString()).toBe(
      "sk-ant-secret-été",
    );
    expect(encrypt("x")).not.toBe(encrypt("x"));
  });

  it("chiffre « vide » pour null et rend « » sur un jeton absent, avec l'avertissement", () => {
    configurerChiffrement({ cleEnv: "k", fichierCle });
    expect(decrypt(encrypt(null))).toBe("");
    const journal = capturerJournal();
    expect(decrypt(null)).toBe("");
    expect(journal).toEqual([["WARNING", "[encryption] token Fernet invalide (clé tournée ?)"]]);
  });

  it("une clé tournée rend « » au lieu de lever", () => {
    configurerChiffrement({ cleEnv: "ancienne", fichierCle });
    const jeton = encrypt("secret");
    configurerChiffrement({ cleEnv: "nouvelle", fichierCle });
    const journal = capturerJournal();
    expect(decrypt(jeton)).toBe("");
    expect(journal).toHaveLength(1);
  });

  it("sans env ni config, crée le fichier de clé 0600 (journalisé) et le réutilise", () => {
    configurerChiffrement({ fichierCle });
    const journal = capturerJournal();
    const jeton = encrypt("persistant");
    expect(journal.map(([niveau]) => niveau)).toEqual(["WARNING"]);
    const cle = readFileSync(fichierCle, "utf-8");
    expect(statSync(fichierCle).mode & 0o777).toBe(0o600);
    configurerChiffrement({ fichierCle });
    expect(decrypt(jeton)).toBe("persistant");
    expect(new Fernet(cle).decrypt(jeton).toString()).toBe("persistant");
  });

  it("sans clé : encrypt lève EncryptionUnavailable, decrypt rend « » sans bruit, échec mémorisé", () => {
    const parent = join(dossierTemporaire(), "user_db");
    writeFileSync(parent, "pas un dossier");
    configurerChiffrement({ fichierCle: join(parent, ".encryption_key") });
    const journal = capturerJournal();
    expect(() => encrypt("x")).toThrow(EncryptionUnavailable);
    expect(() => encrypt("x")).toThrow("Clé de chiffrement indisponible — définir APP_ENCRYPTION_KEY.");
    expect(decrypt("gAAAAA")).toBe("");
    expect(journal.map(([niveau]) => niveau)).toEqual(["CRITICAL"]);
    rmSync(parent);
    expect(() => encrypt("x")).toThrow(EncryptionUnavailable);
  });

  it("une demi-paire dans le clair lève comme str.encode('utf-8')", () => {
    configurerChiffrement({ cleEnv: "k", fichierCle });
    expect(essai(() => encrypt("a\ud800"))).toEqual({ erreur: "ValueError" });
  });
});
