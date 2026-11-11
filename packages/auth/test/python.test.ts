// SPDX-License-Identifier: MIT
/** packages/auth/test/python.test.ts — CSRF, requête locale, session, require_user_id, flux, cookie et jeton de service rejouent les décisions du Python. */
import { readFileSync } from "node:fs";

import { HttpError } from "@elpis/commun";
import { ErreurOperation } from "@elpis/db";
import type { Executeur } from "@elpis/db";
import type { FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { valeurCookie } from "../src/cookie";
import { estInterSite } from "../src/csrf";
import { exigerJetonService, exigerUtilisateur } from "../src/garde";
import {
  analyserMandataires,
  estMandataireDeConfiance,
  ipClient,
  mandatairesDuJournal,
} from "../src/ip-client";
import { estLocalDirect } from "../src/local";
import { fluxEncoreValide, Session, validerSession } from "../src/session";
import type { LigneUtilisateur } from "../src/session";

interface Vecteurs {
  maintenant: number;
  csrf: { entetes: Record<string, string>; http: boolean; ws: boolean }[];
  local: { pair: string | null; entetes: Record<string, string>; local: boolean }[];
  session: {
    config: object;
    session: Record<string, unknown>;
    ligne: LigneUtilisateur | null;
    valide: boolean;
    apres: object;
  }[];
  require: {
    session: Record<string, unknown>;
    ligne: LigneUtilisateur | null;
    chemin: string;
    uid?: number;
    username?: string | null;
    statut?: number;
    detail?: string;
  }[];
  flux: { login_ts: unknown; ligne: number[] | null; panne: boolean; sid: string | null; valide: boolean }[];
  cookies: { entete: string; valeur: string | null }[];
  service: {
    jeton: string;
    authorization: string | null;
    ok?: boolean;
    statut?: number;
    detail?: string;
    entetes?: Record<string, string>;
  }[];
  ip_client: {
    reseaux: { spec: string; reseaux: string[]; hotes: Record<string, boolean> }[];
    resolutions: { spec: string; pair: string | null; xff: string | null; ip: string }[];
  };
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/auth.json", import.meta.url), "utf-8")) as Vecteurs;
const T = V.maintenant;

function baseFictive(ligne: LigneUtilisateur | null): Executeur {
  return {
    get: async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("revoked_sessions")) return params?.[0] === "revoque" ? { un: 1 } : undefined;
      return ligne ?? undefined;
    },
  } as unknown as Executeur;
}

describe("CSRF (is_cross_site, ws_is_cross_site)", () => {
  it.each(V.csrf.map((c) => [JSON.stringify(c.entetes), c] as const))("%s", (_n, c) => {
    const e = Object.fromEntries(Object.entries(c.entetes).map(([k, v]) => [k.toLowerCase(), v]));
    expect(estInterSite(e, "h:8000")).toBe(c.http);
    expect(estInterSite(e, "h:8000")).toBe(c.ws);
  });
});

describe("requête locale directe", () => {
  it.each(V.local.map((c) => [`${String(c.pair)} ${JSON.stringify(c.entetes)}`, c] as const))(
    "%s",
    (_n, c) => {
      const e = Object.fromEntries(Object.entries(c.entetes).map(([k, v]) => [k.toLowerCase(), v]));
      expect(estLocalDirect(c.pair ?? undefined, e)).toBe(c.local);
    },
  );

  it("adresse IPv4 transposée en IPv6 par Node", () => {
    expect(estLocalDirect("::ffff:127.0.0.1", {})).toBe(true);
    expect(estLocalDirect("::ffff:10.0.0.1", {})).toBe(false);
  });
});

describe("portes de validité de session", () => {
  it.each(V.session.map((c, i) => [i, c] as const))("cas %i", async (_i, c) => {
    const s = new Session(c.session);
    const r = await validerSession(s, 7, {
      config: () => ({ security: { session: c.config } }),
      utilisateur: async () => c.ligne,
      revoquee: async (sid) => sid === "revoque",
      maintenant: () => T,
    });
    expect(r.valide).toBe(c.valide);
    expect(s.contenu()).toEqual(c.apres);
  });
});

describe("require_user_id", () => {
  it.each(V.require.map((c, i) => [i, c] as const))("cas %i", async (_i, c) => {
    const requete = {
      session: new Session(c.session),
      url: c.chemin,
      headers: {},
    } as unknown as FastifyRequest;
    const dep = {
      base: baseFictive(c.ligne),
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => "s",
      jetonService: () => "",
      maintenant: () => T,
    };
    if (c.statut) {
      const e = await exigerUtilisateur(requete, dep).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(HttpError);
      expect([(e as HttpError).statusCode, (e as HttpError).detail]).toEqual([c.statut, c.detail]);
    } else {
      expect(await exigerUtilisateur(requete, dep)).toBe(c.uid);
      expect(requete.utilisateur?.username ?? null).toBe(c.username ?? null);
    }
  });
});

describe("revalidation d'un flux", () => {
  it.each(V.flux.map((c, i) => [i, c] as const))("cas %i", async (_i, c) => {
    const v = await fluxEncoreValide(7, c.login_ts, c.sid, {
      config: () => ({}),
      revoquee: async (sid) => sid === "revoque",
      maintenant: () => T,
      sessionMinTs: async () => {
        if (c.panne) throw new Error("base verrouillée");
        return c.ligne ? (c.ligne[0] ?? null) : undefined;
      },
    });
    expect(v).toBe(c.valide);
  });
});

describe("cookie_parser de Starlette", () => {
  it.each(V.cookies.map((c) => [JSON.stringify(c.entete), c] as const))("%s", (_n, c) => {
    expect(valeurCookie(c.entete, "mcpwebui_session") ?? null).toBe(c.valeur);
  });
});

describe("require_service_token", () => {
  it.each(
    V.service.map((c) => [`${JSON.stringify(c.jeton)} ${JSON.stringify(c.authorization)}`, c] as const),
  )("%s", (_n, c) => {
    const requete = {
      headers: c.authorization === null ? {} : { authorization: c.authorization },
    } as unknown as FastifyRequest;
    if (c.ok) {
      expect(() => exigerJetonService(requete, c.jeton)).not.toThrow();
      return;
    }
    const e = (() => {
      try {
        exigerJetonService(requete, c.jeton);
      } catch (x) {
        return x;
      }
      return null;
    })();
    expect(e).toBeInstanceOf(HttpError);
    const h = e as HttpError;
    expect([h.statusCode, h.detail, h.entetes ?? {}]).toEqual([c.statut, c.detail, c.entetes]);
  });
});

describe("pannes pendant les portes de session", () => {
  const dep = (utilisateur: () => Promise<LigneUtilisateur | null>, revoquee: () => Promise<boolean>) => ({
    config: () => ({}),
    utilisateur,
    revoquee,
    maintenant: () => T,
  });
  const session = () => new Session({ user_id: 7, _login_ts: T - 10, _sid: "s" });
  const ligne: LigneUtilisateur = { session_min_ts: 0, must_change_pwd: 0, username: "u" };

  it("compte illisible : refus et session vidée (fail-closed)", async () => {
    const s = session();
    const r = await validerSession(
      s,
      7,
      dep(
        () => Promise.reject(new ErreurOperation("database is locked")),
        async () => false,
      ),
    );
    expect([r.valide, s.vide]).toEqual([false, true]);
  });

  it("session_min_ts illisible : refus, pas d'erreur 500", async () => {
    const s = session();
    const r = await validerSession(
      s,
      7,
      dep(
        async () => ({ ...ligne, session_min_ts: "x" as unknown as number }),
        async () => false,
      ),
    );
    expect([r.valide, s.vide]).toEqual([false, true]);
  });

  it("table des révocations absente : tolérée ; autre panne : refus", async () => {
    const absente = await validerSession(
      session(),
      7,
      dep(
        async () => ligne,
        () => Promise.reject(new ErreurOperation("no such table: revoked_sessions")),
      ),
    );
    expect(absente.valide).toBe(true);
    const s = session();
    const verrou = await validerSession(
      s,
      7,
      dep(
        async () => ligne,
        () => Promise.reject(new ErreurOperation("database is locked")),
      ),
    );
    expect([verrou.valide, s.vide]).toEqual([false, true]);
  });

  it("_login_ts ou _last_activity_ts non numériques : refus", async () => {
    for (const contenu of [
      { _login_ts: "123" },
      { _login_ts: [1] },
      { _login_ts: T - 10, _last_activity_ts: "x" },
    ]) {
      const s = new Session(contenu);
      const r = await validerSession(s, 7, {
        ...dep(
          async () => ligne,
          async () => false,
        ),
        config: () => ({ security: { session: { idle_timeout_sec: 600 } } }),
      });
      expect(r.valide).toBe(false);
    }
  });

  it("flux : révocation illisible = flux gardé (fail-open)", async () => {
    const v = await fluxEncoreValide(7, T - 10, "s", {
      config: () => ({}),
      revoquee: () => Promise.reject(new Error("base verrouillée")),
      maintenant: () => T,
      sessionMinTs: async () => 0,
    });
    expect(v).toBe(true);
  });
});

describe("mandataires de confiance (_parse_trusted_proxies, _is_trusted_proxy)", () => {
  it.each(V.ip_client.reseaux.map((c) => [JSON.stringify(c.spec), c] as const))("%s", (_n, c) => {
    const reseaux = analyserMandataires(c.spec);
    expect(reseaux).toHaveLength(c.reseaux.length);
    const obtenu = Object.fromEntries(
      Object.keys(c.hotes).map((h) => [h, estMandataireDeConfiance(h, reseaux)]),
    );
    expect(obtenu).toEqual(c.hotes);
  });

  it("ACCESS_LOG_TRUSTED_PROXIES : boucle locale par défaut, vide = aucun mandataire", () => {
    expect(estMandataireDeConfiance("127.0.0.9", mandatairesDuJournal({}))).toBe(true);
    expect(mandatairesDuJournal({ ACCESS_LOG_TRUSTED_PROXIES: "" })).toEqual([]);
  });
});

describe("_resolve_client_ip", () => {
  it.each(
    V.ip_client.resolutions.map((c) => [`${c.spec} ${String(c.pair)} ${JSON.stringify(c.xff)}`, c] as const),
  )("%s", (_n, c) => {
    const entetes = c.xff === null ? {} : { "x-forwarded-for": c.xff };
    expect(ipClient(c.pair, entetes, analyserMandataires(c.spec))).toBe(c.ip);
  });
});
