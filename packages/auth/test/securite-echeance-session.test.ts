// SPDX-License-Identifier: MIT
/** packages/auth/test/securite-echeance-session.test.ts — une session ne revit jamais : échéance figée à l'ouverture, méthode de connexion relue, clés de prototype sans effet. */
import { describe, expect, it } from "vitest";

import { ouvrirSession } from "../src/ouverture";
import { fluxEncoreValide, metaSession, Session, validerSession } from "../src/session";
import type { DependancesSession, LigneUtilisateur } from "../src/session";
import { poserIdentite } from "./aides-session";

function deps(
  cfg: { max_age_sec?: number },
  t: { now: number },
  extra: Partial<DependancesSession> = {},
): DependancesSession {
  return {
    config: () => ({ security: { session: cfg } }),
    utilisateur: async () => ({ id: 1, is_admin: 0 }),
    revoquee: async () => false,
    maintenant: () => t.now,
    ...extra,
  };
}

function ouverte(maintenant: number, dureeMax: number, methode: "password" | "oidc:a" = "password"): Session {
  const s = new Session();
  ouvrirSession(s, { uid: 1, methode, maintenant, dureeMax });
  return s;
}

describe("échéance figée (_exp)", () => {
  it("est posée à l'ouverture et réservée", () => {
    const s = ouverte(1000, 500);
    expect(s.get("_exp")).toBe(1500);
    expect(() => s.set("_exp", 9e9)).toThrow(/reserved/u);
  });

  it("session refusée après _exp même si la durée de configuration a été allongée", async () => {
    const t = { now: 1000 };
    const s = ouverte(1000, 500);
    expect((await validerSession(s, 1, deps({ max_age_sec: 500 }, t))).valide).toBe(true);
    t.now = 1501;
    expect((await validerSession(ouverte(1000, 500), 1, deps({ max_age_sec: 10_000_000 }, t))).valide).toBe(
      false,
    );
  });

  it("durée de configuration raccourcie : s'applique tout de suite", async () => {
    const t = { now: 1300 };
    expect((await validerSession(ouverte(1000, 500), 1, deps({ max_age_sec: 200 }, t))).valide).toBe(false);
    expect((await validerSession(ouverte(1000, 500), 1, deps({ max_age_sec: 400 }, t))).valide).toBe(true);
  });

  it("session sans _exp (d'avant) : comportement actuel", async () => {
    const t = { now: 5000 };
    const s = new Session();
    poserIdentite(s, { user_id: 1, _login_ts: 1000 });
    expect((await validerSession(s, 1, deps({ max_age_sec: 10_000 }, t))).valide).toBe(true);
  });

  it("_exp illisible : session refusée", async () => {
    const s = ouverte(1000, 500);
    poserIdentite(s, { _exp: "demain" });
    expect((await validerSession(s, 1, deps({}, { now: 1001 }))).valide).toBe(false);
  });

  it("renouvelerSession ne prolonge pas _exp", async () => {
    const { renouvelerSession } = await import("../src/ouverture");
    const s = ouverte(1000, 500);
    renouvelerSession(s, 1400);
    expect(s.get("_exp")).toBe(1500);
  });

  it("flux refusé après _exp, gardé avant", async () => {
    const t = { now: 1400 };
    const d = {
      ...deps({ max_age_sec: 10_000_000 }, t),
      sessionMinTs: async () => ({ min: 0, suspended_at: 0, is_admin: 0 }),
    };
    const s = ouverte(1000, 500);
    const meta = metaSession(s);
    expect(await fluxEncoreValide(1, 1000, "x", d, meta)).toBe(true);
    t.now = 1501;
    expect(await fluxEncoreValide(1, 1000, "x", d, meta)).toBe(false);
  });
});

describe("méthode de connexion encore admise", () => {
  const admise = (refus: boolean) => async (_auth: unknown, _l: LigneUtilisateur) => !refus;

  it("validerSession : refus quand la méthode n'est plus admise, erreur = refus", async () => {
    const t = { now: 1100 };
    expect(
      (await validerSession(ouverte(1000, 500), 1, deps({}, t, { sessionAdmise: admise(false) }))).valide,
    ).toBe(true);
    expect(
      (await validerSession(ouverte(1000, 500), 1, deps({}, t, { sessionAdmise: admise(true) }))).valide,
    ).toBe(false);
    const panne = async () => {
      throw new Error("x");
    };
    expect((await validerSession(ouverte(1000, 500), 1, deps({}, t, { sessionAdmise: panne }))).valide).toBe(
      false,
    );
  });

  it("transmet _auth et la ligne du compte", async () => {
    const vus: unknown[] = [];
    const s = ouverte(1000, 500, "oidc:a");
    await validerSession(
      s,
      1,
      deps(
        {},
        { now: 1100 },
        {
          sessionAdmise: async (a, l) => {
            vus.push(a, l.is_admin);
            return true;
          },
        },
      ),
    );
    expect(vus).toEqual(["oidc:a", 0]);
  });

  it("flux : refus quand la méthode n'est plus admise, flux gardé sur erreur", async () => {
    const base = {
      ...deps({}, { now: 1100 }),
      sessionMinTs: async () => ({ min: 0, suspended_at: 0, is_admin: 1 }),
    };
    const meta = metaSession(ouverte(1000, 500, "oidc:a"));
    expect(await fluxEncoreValide(1, 1000, "x", { ...base, sessionAdmise: admise(true) }, meta)).toBe(false);
    expect(await fluxEncoreValide(1, 1000, "x", { ...base, sessionAdmise: admise(false) }, meta)).toBe(true);
    const panne = async () => {
      throw new Error("x");
    };
    expect(await fluxEncoreValide(1, 1000, "x", { ...base, sessionAdmise: panne }, meta)).toBe(true);
  });
});

describe("clés de prototype", () => {
  it("set refuse __proto__, constructor, prototype sans effet de lecture", () => {
    const s = new Session();
    for (const cle of ["__proto__", "constructor", "prototype"])
      expect(() => s.set(cle, { user_id: 42 })).toThrow();
    expect(s.get("user_id")).toBeUndefined();
    expect(s.get("__proto__")).toBeUndefined();
    expect(s.vide).toBe(true);
  });

  it("des données d'entrée portant ces clés sont écartées", () => {
    const brut = JSON.parse('{"__proto__": {"user_id": 42}, "constructor": 1, "a": 2}') as Record<
      string,
      unknown
    >;
    const s = new Session(brut);
    expect(s.get("user_id")).toBeUndefined();
    expect(s.contenu()).toEqual({ a: 2 });
  });
});
