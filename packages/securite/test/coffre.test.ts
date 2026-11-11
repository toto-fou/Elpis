// SPDX-License-Identifier: MIT
/** packages/securite/test/coffre.test.ts — coffre « Secrets » : AES-256-GCM (forme v1, nonce aléatoire, AAD, kid), refus levés (jamais ""), précédence de la clé (env, fichier, repli), repli 0600 créé une fois sous verrou, jamais remplacé. */
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chargerCleCoffre,
  chiffrerSecret,
  cleCoffre,
  CleCoffreIndisponible,
  configurerCoffre,
  dechiffrerSecret,
  etatCleCoffre,
  kidCoffre,
  kidDe,
  lireCleCoffre,
  octetsCleCoffre,
  SecretIndechiffrable,
  validerCleCoffre,
} from "../src/coffre";
import type { ReglagesCoffre } from "../src/coffre";
import { brancherJournal } from "../src/ports";
import { capturerJournal } from "./aides";

let dossier: string;
let r: ReglagesCoffre;

const kidAttendu = (octets: Buffer): string => createHash("sha256").update(octets).digest("hex").slice(0, 8);

function erreur(f: () => unknown): unknown {
  try {
    f();
  } catch (e) {
    return e;
  }
  throw new Error("aucune erreur levée");
}

beforeEach(() => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-coffre-"));
  r = { systeme: join(dossier, "etc-vault.key"), repli: join(dossier, "user_db", ".vault.key") };
  configurerCoffre(r);
});

afterEach(() => {
  brancherJournal(null);
  rmSync(dossier, { recursive: true, force: true });
});

describe("chiffrement AES-256-GCM", () => {
  it("forme v1.<kid>.<nonce>.<chiffré‖tag>, nonce aléatoire, aller-retour, kid = sha256(clé)[:8]", () => {
    const octets = randomBytes(32);
    configurerCoffre({ ...r, cleEnv: octets.toString("base64") });
    const a = chiffrerSecret("mot de passe é€", "vault|v1|7|web-login|intranet");
    const b = chiffrerSecret("mot de passe é€", "vault|v1|7|web-login|intranet");
    expect(a).toMatch(/^v1\.[0-9a-f]{8}\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/u);
    expect(a).not.toBe(b);
    expect(a.split(".")[2]).not.toBe(b.split(".")[2]);
    expect(kidDe(a)).toBe(kidAttendu(octets));
    expect(kidCoffre()).toBe(kidAttendu(octets));
    expect(dechiffrerSecret(a, "vault|v1|7|web-login|intranet")).toBe("mot de passe é€");
    expect(dechiffrerSecret(b, "vault|v1|7|web-login|intranet")).toBe("mot de passe é€");
  });

  it("AAD différente, chiffré ou tag altéré, forme fausse, autre clé : SecretIndechiffrable, jamais une chaîne vide", () => {
    configurerCoffre({ ...r, cleEnv: randomBytes(32).toString("base64") });
    const enc = chiffrerSecret("s3cret", "vault|v1|1|token|a");
    const e1 = erreur(() => dechiffrerSecret(enc, "vault|v1|1|token|b"));
    expect(e1).toBeInstanceOf(SecretIndechiffrable);
    expect((e1 as SecretIndechiffrable).motif).toBe("integrite");
    const [v, kid, nonce, corps] = enc.split(".") as [string, string, string, string];
    const altere = Buffer.from(corps, "base64url");
    altere[0] = (altere[0] ?? 0) ^ 1;
    expect(
      erreur(() =>
        dechiffrerSecret(`${v}.${kid}.${nonce}.${altere.toString("base64url")}`, "vault|v1|1|token|a"),
      ),
    ).toBeInstanceOf(SecretIndechiffrable);
    const tag = Buffer.from(corps, "base64url");
    tag[tag.length - 1] = (tag[tag.length - 1] ?? 0) ^ 1;
    expect(
      erreur(() =>
        dechiffrerSecret(`${v}.${kid}.${nonce}.${tag.toString("base64url")}`, "vault|v1|1|token|a"),
      ),
    ).toBeInstanceOf(SecretIndechiffrable);
    for (const faux of [
      "",
      "v2.abcdef01.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA",
      `${v}.${kid}.${nonce}`,
      `${enc}=`,
      "gAAAAAB",
    ]) {
      const e = erreur(() => dechiffrerSecret(faux, "vault|v1|1|token|a"));
      expect(e, faux).toBeInstanceOf(SecretIndechiffrable);
      expect((e as SecretIndechiffrable).motif).toBe("forme");
    }
    configurerCoffre({ ...r, cleEnv: randomBytes(32).toString("base64") });
    const autre = erreur(() => dechiffrerSecret(enc, "vault|v1|1|token|a"));
    expect((autre as SecretIndechiffrable).motif).toBe("cle");
    expect((autre as SecretIndechiffrable).kid).toBe(kid);
  });

  it("déchiffrement avec des clés données (rekey) ; texte mal formé refusé au chiffrement", () => {
    writeFileSync(join(dossier, "ancienne.key"), `${randomBytes(32).toString("hex")}\n`);
    const ancienne = lireCleCoffre(join(dossier, "ancienne.key"));
    const enc = chiffrerSecret("x", "aad", ancienne);
    expect(dechiffrerSecret(enc, "aad", [ancienne])).toBe("x");
    expect(() => chiffrerSecret("\uD800", "aad", ancienne)).toThrow(TypeError);
  });
});

describe("clé du coffre : validateur unique", () => {
  it("base64 canonique (44 caractères, comme `base64`) ou 64 chiffres hexadécimaux ; 32 octets ; jamais dégénérée", () => {
    const o = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37 + 11) % 256));
    for (const t of [
      o.toString("base64"),
      ` ${o.toString("base64")}\n`,
      o.toString("hex"),
      o.toString("hex").toUpperCase(),
    ])
      expect(octetsCleCoffre(t)?.equals(o), t).toBe(true);
    expect(validerCleCoffre(o.toString("base64"))).toMatchObject({ kid: kidAttendu(o) });
    for (const t of [
      o.toString("base64").replace(/=$/u, ""),
      o.toString("base64url"),
      randomBytes(31).toString("base64"),
      randomBytes(33).toString("base64"),
      "",
      "x".repeat(44),
      `${o.toString("base64").slice(0, 20)} ${o.toString("base64").slice(20)}`,
    ])
      expect(octetsCleCoffre(t), t).toBeNull();
    for (const degeneree of [Buffer.alloc(32), Buffer.alloc(32, 0xab)]) {
      expect(validerCleCoffre(degeneree.toString("base64"))).toEqual({
        motif: "clé dégénérée (un seul octet répété)",
      });
      expect(octetsCleCoffre(degeneree.toString("hex"))).toBeNull();
    }
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const b64 = o.toString("base64");
    const dernier = alphabet.indexOf(b64.at(-2) ?? "A");
    const nonCanonique = `${b64.slice(0, -2)}${alphabet[dernier + 1] ?? "B"}=`;
    expect(octetsCleCoffre(nonCanonique)).toBeNull();
  });
});

describe("clé du coffre : précédence et repli", () => {
  it("ELPIS_VAULT_KEY l'emporte sur le fichier système, qui l'emporte sur le repli", () => {
    const env = randomBytes(32);
    const sys = randomBytes(32);
    writeFileSync(r.systeme as string, `${sys.toString("base64")}\n`);
    configurerCoffre({ ...r, cleEnv: env.toString("base64") });
    expect(cleCoffre()?.source).toBe("env");
    expect(kidCoffre()).toBe(kidAttendu(env));
    configurerCoffre(r);
    expect(cleCoffre()).toMatchObject({ source: "fichier", chemin: r.systeme, kid: kidAttendu(sys) });
    expect(existsSync(r.repli)).toBe(false);
  });

  it("ELPIS_VAULT_KEY invalide, ELPIS_VAULT_KEY_PATH absent ou fichier invalide : refus, jamais de repli", () => {
    configurerCoffre({ ...r, cleEnv: "trop-court" });
    expect(() => cleCoffre({ creer: true })).toThrow(CleCoffreIndisponible);
    configurerCoffre({ ...r, fichier: join(dossier, "absente.key") });
    expect(() => cleCoffre({ creer: true })).toThrow(/ELPIS_VAULT_KEY_PATH/u);
    writeFileSync(r.systeme as string, "pas une clé\n");
    configurerCoffre(r);
    expect(() => chargerCleCoffre()).toThrow(CleCoffreIndisponible);
    expect(existsSync(r.repli)).toBe(false);
  });

  it.skipIf(process.getuid?.() === 0)("fichier système illisible (droits) : refus, sans repli", () => {
    writeFileSync(r.systeme as string, `${randomBytes(32).toString("base64")}\n`);
    chmodSync(r.systeme as string, 0o000);
    expect(() => cleCoffre({ creer: true })).toThrow(/illisible/u);
    expect(existsSync(r.repli)).toBe(false);
    expect(etatCleCoffre(r).erreur).toMatch(/illisible/u);
  });

  it("repli : rien n'est créé pour lire ni pour chiffrer ; posé 0600 par chargerCleCoffre, puis relu ; signalé au journal", () => {
    const journal = capturerJournal();
    expect(cleCoffre()).toBeNull();
    expect(kidCoffre()).toBeNull();
    expect(etatCleCoffre(r)).toEqual({ source: "absente", chemin: null, kid: null, erreur: null });
    expect(() => dechiffrerSecret("v1.abcdef01.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA", "a")).toThrow(
      SecretIndechiffrable,
    );
    expect(() => chiffrerSecret("valeur", "aad")).toThrow(CleCoffreIndisponible);
    expect(existsSync(r.repli)).toBe(false);
    chargerCleCoffre();
    const enc = chiffrerSecret("valeur", "aad");
    expect(statSync(r.repli).mode & 0o777).toBe(0o600);
    const octets = octetsCleCoffre(readFileSync(r.repli, "latin1"));
    expect(octets).not.toBeNull();
    expect(kidDe(enc)).toBe(kidAttendu(octets as Buffer));
    configurerCoffre(r);
    expect(cleCoffre()).toMatchObject({ source: "repli", chemin: r.repli });
    expect(dechiffrerSecret(enc, "aad")).toBe("valeur");
    expect(etatCleCoffre(r).source).toBe("repli");
    expect(journal.some(([, l]) => l?.includes("clé de repli"))).toBe(true);
  });

  it("repli vide ou invalide : jamais remplacé, refus", () => {
    const dossierRepli = join(dossier, "user_db");
    rmSync(dossierRepli, { recursive: true, force: true });
    chargerCleCoffre();
    writeFileSync(r.repli, "");
    configurerCoffre(r);
    expect(() => chargerCleCoffre()).toThrow(/vide/u);
    expect(readFileSync(r.repli, "utf8")).toBe("");
    writeFileSync(r.repli, "abc\n");
    configurerCoffre(r);
    expect(() => chargerCleCoffre()).toThrow(/invalide/u);
    expect(readFileSync(r.repli, "utf8")).toBe("abc\n");
  });

  it.skipIf(process.getuid?.() === 0)(
    "repli impossible à créer (dossier en lecture seule) : CleCoffreIndisponible, jamais une autre erreur",
    () => {
      const parent = join(dossier, "ferme");
      mkdirSync(parent, { mode: 0o500 });
      configurerCoffre({ ...r, repli: join(parent, "user_db", ".vault.key") });
      try {
        const e = erreur(() => chargerCleCoffre());
        expect(e).toBeInstanceOf(CleCoffreIndisponible);
        expect(String((e as Error).message)).toMatch(/impossible à créer \(EACCES\)/u);
      } finally {
        chmodSync(parent, 0o700);
      }
    },
  );
});
