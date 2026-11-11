// SPDX-License-Identifier: MIT
/** packages/securite/test/mots-de-passe.test.ts — PBKDF2 (format versionné, format historique du Python), empreintes, compare_digest ; file de hachage. */
import { pbkdf2Sync } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import {
  bytesFromHex,
  compareDigest,
  egauxEnTempsConstant,
  hachageAJour,
  hashPassword,
  maxWorkers,
  PASSWORD_ITERATIONS,
  runPasswordOp,
  shutdownPasswordPool,
  tokenDigest,
  tokenHex,
  tokenUrlsafe,
  verifyPassword,
} from "../src/mots-de-passe";
import { attendu, essai, essaiAsync, vecteurs } from "./aides";

function octetsOuTexte(v: string | { hex: string }): string | Buffer {
  return typeof v === "string" ? v : Buffer.from(v.hex, "hex");
}

function pause(ms: number): Promise<void> {
  return new Promise((resoudre) => setTimeout(resoudre, ms));
}

afterEach(() => {
  shutdownPasswordPool();
});

describe("vecteurs Python de _hash_password (format historique : 150 000 itérations, empreinte seule)", () => {
  it("nouveaux hachages à 600 000 itérations (écart voulu au Python d'avant)", () => {
    expect(PASSWORD_ITERATIONS).toBe(600_000);
  });

  for (const [i, cas] of vecteurs.mots_de_passe.entries()) {
    it(`${i} sel ${JSON.stringify(cas.sel)} : empreinte historique toujours vérifiée, à rehacher ; erreurs du Python gardées`, async () => {
      if (cas.sortie === undefined) {
        expect(await essaiAsync(() => hashPassword(cas.mot_de_passe, cas.sel))).toEqual(attendu(cas));
        expect(await essaiAsync(() => verifyPassword(cas.mot_de_passe, cas.sel, "00"))).toEqual(attendu(cas));
        return;
      }
      expect(await verifyPassword(cas.mot_de_passe, cas.sel, cas.sortie)).toBe(true);
      expect(hachageAJour(cas.sortie)).toBe(false);
    });
  }
});

describe("hachage versionné pbkdf2_sha256$itérations$sel$empreinte", () => {
  const sel = "00112233445566778899aabbccddeeff";

  it("forme, empreinte de PBKDF2-HMAC-SHA256 (600 000 itérations, 32 octets), à jour ; vérifié avec le sel qu'il porte", async () => {
    const h = await hashPassword("s3cr3t!", sel);
    const empreinte = pbkdf2Sync("s3cr3t!", Buffer.from(sel, "hex"), 600_000, 32, "sha256").toString("hex");
    expect(h).toBe(`pbkdf2_sha256$600000$${sel}$${empreinte}`);
    expect(hachageAJour(h)).toBe(true);
    expect(await verifyPassword("s3cr3t!", "ffff", h)).toBe(true);
    expect(await verifyPassword("s3cr3t", sel, h)).toBe(false);
  });

  it("moins d'itérations que le courant : vérifié mais à rehacher ; formes illisibles : refusées sans lever", async () => {
    const faible = pbkdf2Sync("pass", Buffer.from(sel, "hex"), 1_000, 32, "sha256").toString("hex");
    const ancien = `pbkdf2_sha256$1000$${sel}$${faible}`;
    expect(await verifyPassword("pass", "", ancien)).toBe(true);
    expect(hachageAJour(ancien)).toBe(false);
    for (const stocke of [
      `pbkdf2_sha256$0$${sel}$${faible}`,
      `pbkdf2_sha256$01000$${sel}$${faible}`,
      `pbkdf2_sha256$1e3$${sel}$${faible}`,
      `pbkdf2_sha256$1000$zz$${faible}`,
      `pbkdf2_sha256$1000$${sel}$${faible.toUpperCase()}`,
      `pbkdf2_sha256$1000$${sel}`,
      `md5$1000$${sel}$${faible}`,
    ]) {
      expect(await verifyPassword("pass", sel, stocke), stocke).toBe(false);
      expect(hachageAJour(stocke), stocke).toBe(false);
    }
  });

  it("comparaison à temps constant : longueurs différentes refusées sans lever", () => {
    expect(egauxEnTempsConstant(Buffer.from("abc"), Buffer.from("abc"))).toBe(true);
    expect(egauxEnTempsConstant(Buffer.from("abc"), Buffer.from("abd"))).toBe(false);
    expect(egauxEnTempsConstant(Buffer.from("abc"), Buffer.from("abcd"))).toBe(false);
    expect(egauxEnTempsConstant(Buffer.alloc(0), Buffer.from("a"))).toBe(false);
  });
});

describe("verifyPassword (le calcul de verify_user)", () => {
  const sel = "00112233445566778899aabbccddeeff";
  const empreinte =
    vecteurs.mots_de_passe.find((c) => c.mot_de_passe === "s3cr3t!" && c.sel === sel)?.sortie ?? "";

  it("accepte le bon mot de passe, refuse les autres", async () => {
    expect(await verifyPassword("s3cr3t!", sel, empreinte)).toBe(true);
    expect(await verifyPassword("s3cr3t", sel, empreinte)).toBe(false);
    expect(await verifyPassword("s3cr3t!", sel, empreinte.toUpperCase())).toBe(false);
    expect(await verifyPassword("s3cr3t!", sel, empreinte.slice(1))).toBe(false);
  });

  it("une empreinte stockée non ASCII lève, comme compare_digest sur deux str", async () => {
    expect(await essaiAsync(() => verifyPassword("s3cr3t!", sel, "é"))).toEqual({ erreur: "TypeError" });
  });

  it("un sel illisible lève (ValueError de bytes.fromhex)", async () => {
    expect(await essaiAsync(() => verifyPassword("x", "zz", empreinte))).toEqual({ erreur: "ValueError" });
  });
});

describe("bytes.fromhex, compare_digest et tokens.digest", () => {
  for (const cas of vecteurs.hex) {
    it(`fromhex ${JSON.stringify(cas.entree)}`, () => {
      expect(essai(() => bytesFromHex(cas.entree).toString("hex"))).toEqual(attendu(cas));
    });
  }

  for (const cas of vecteurs.compare_digest) {
    it(`compare_digest ${JSON.stringify(cas.a)} ${JSON.stringify(cas.b)}`, () => {
      expect(essai(() => compareDigest(octetsOuTexte(cas.a), octetsOuTexte(cas.b)))).toEqual(attendu(cas));
    });
  }

  for (const cas of vecteurs.empreintes_jetons) {
    it(`digest ${JSON.stringify(cas.entree)}`, () => {
      expect(essai(() => tokenDigest(cas.entree))).toEqual(attendu(cas));
    });
  }
});

describe("secrets.token_hex / token_urlsafe", () => {
  it("ont la forme de Python (sel de 16 octets, jeton pcr_ de 30 octets)", () => {
    expect(tokenHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(tokenHex()).toMatch(/^[0-9a-f]{64}$/);
    expect(tokenUrlsafe(30)).toMatch(/^[A-Za-z0-9_-]{40}$/);
    expect(tokenUrlsafe(18)).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect(tokenUrlsafe()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHex(16)).not.toBe(tokenHex(16));
  });
});

describe("file de hachage (passwd.py)", () => {
  for (const cas of vecteurs.pwhash_threads) {
    it(`APP_PWHASH_THREADS=${JSON.stringify(cas.entree)} → ${cas.sortie} (pool libuv large)`, () => {
      const env = {
        UV_THREADPOOL_SIZE: "64",
        ...(cas.entree === null ? {} : { APP_PWHASH_THREADS: cas.entree }),
      };
      expect(maxWorkers(env)).toBe(cas.sortie);
    });
  }

  it.each([
    [{}, 1],
    [{ APP_PWHASH_THREADS: "16" }, 3],
    [{ APP_PWHASH_THREADS: "3" }, 3],
    [{ APP_PWHASH_THREADS: "16", UV_THREADPOOL_SIZE: "8" }, 7],
    [{ APP_PWHASH_THREADS: "16", UV_THREADPOOL_SIZE: " 12abc" }, 11],
    [{ APP_PWHASH_THREADS: "16", UV_THREADPOOL_SIZE: "2" }, 1],
    [{ APP_PWHASH_THREADS: "16", UV_THREADPOOL_SIZE: "1" }, 1],
    [{ APP_PWHASH_THREADS: "16", UV_THREADPOOL_SIZE: "0" }, 1],
    [{ APP_PWHASH_THREADS: "16", UV_THREADPOOL_SIZE: "" }, 1],
    [{ APP_PWHASH_THREADS: "16", UV_THREADPOOL_SIZE: "abc" }, 1],
    [{ APP_PWHASH_THREADS: "16", UV_THREADPOOL_SIZE: "-2" }, 16],
  ])("plafond UV_THREADPOOL_SIZE − 1 (pool libuv lu comme atoi, 4 par défaut) : %o → %i", (env, attendu) => {
    expect(maxWorkers(env)).toBe(attendu);
  });

  it("la boucle d'événements continue de tourner pendant un hachage", async () => {
    let battements = 0;
    const minuterie = setInterval(() => battements++, 2);
    await hashPassword("s3cr3t!", "00112233445566778899aabbccddeeff");
    clearInterval(minuterie);
    expect(battements).toBeGreaterThan(5);
  });

  it("une seule opération à la fois par défaut : une rafale attend son tour", async () => {
    const env = process.env["APP_PWHASH_THREADS"];
    delete process.env["APP_PWHASH_THREADS"];
    try {
      let enCours = 0;
      let maximum = 0;
      const operation = async (): Promise<void> => {
        maximum = Math.max(maximum, ++enCours);
        await pause(30);
        enCours--;
      };
      await Promise.all([1, 2, 3, 4].map(() => runPasswordOp(operation)));
      expect(maximum).toBe(1);
    } finally {
      if (env !== undefined) process.env["APP_PWHASH_THREADS"] = env;
    }
  });

  it("élargie (APP_PWHASH_THREADS=2), deux opérations se recouvrent", async () => {
    const env = process.env["APP_PWHASH_THREADS"];
    process.env["APP_PWHASH_THREADS"] = "2";
    try {
      const t0 = performance.now();
      await Promise.all([runPasswordOp(() => pause(250)), runPasswordOp(() => pause(250))]);
      expect(performance.now() - t0).toBeLessThan(450);
    } finally {
      if (env === undefined) delete process.env["APP_PWHASH_THREADS"];
      else process.env["APP_PWHASH_THREADS"] = env;
    }
  });

  it("valeur et exception traversent la file telles quelles, et la place est rendue", async () => {
    expect(await runPasswordOp(() => 2 + 3)).toBe(5);
    await expect(
      runPasswordOp(() => {
        throw new RangeError("motif exact");
      }),
    ).rejects.toThrow(new RangeError("motif exact"));
    await expect(runPasswordOp(() => Promise.reject(new Error("rejet")))).rejects.toThrow("rejet");
    expect(await runPasswordOp(async () => "après")).toBe("après");
  });
});
