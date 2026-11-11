// SPDX-License-Identifier: MIT
/** packages/auth/test/oauth.test.ts — autorisation OAuth des clients MCP rejouée contre mcp/oauth.py (vecteurs), sur SQLite et PostgreSQL. */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { ErreurPython, pyJsonLoads } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createUser } from "../src/comptes";
import {
  authenticateClient,
  checkResource,
  deleteClient,
  ErreurOAuth,
  estBoucleLocale,
  estClientCimd,
  exchangeCode,
  famillesDePortee,
  getClient,
  issueCode,
  listClients,
  listGrants,
  pkceOk,
  politiqueOauth,
  redirectionCorrespond,
  redirectionPermise,
  refresh,
  registerClient,
  resolveClient,
  resourceBase,
  resourceFamily,
  revokeGrant,
  revokeToken,
  scopesSupported,
  validerMetadonnees,
  verifyAccessToken,
} from "../src/oauth";
import type { ClientOAuth, DependancesOAuth } from "../src/oauth";

type Resultat = {
  resultat?: unknown;
  erreur?: unknown;
  exception?: string;
  telechargements?: [string, string][];
  etat: Record<string, unknown[][]>;
};

const V = pyJsonLoads(readFileSync(new URL("./vecteurs/oauth.json", import.meta.url), "utf-8"), {
  mode: "natif",
}) as {
  politiques: { config: unknown; politique: unknown; scopes: string[]; portees: Record<string, string[]> }[];
  ressources: {
    r: string;
    ok?: [string, string | null];
    erreur?: [string, string];
    famille: string | null;
  }[];
  redirections: { uri: string; ok: boolean; boucle: boolean }[];
  correspondances: { demandee: string; enregistrees: string[]; ok: boolean }[];
  metadonnees: { meta: unknown; ok?: Record<string, unknown>; erreur?: [string, string] }[];
  pkce: { v: string; c: string; ok?: boolean; exception?: string }[];
  cimd: Record<string, boolean>;
  base: Record<string, string>;
  scenario: [string, Record<string, unknown>][];
  resultats: Resultat[];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const POL = {
  enabled: true,
  dcr_enabled: true,
  access_ttl_s: 3600,
  refresh_days: 30,
  families: ["fs", "shell", "git"],
};

function erreurDe(f: () => unknown): unknown {
  try {
    return { ok: f() };
  } catch (e) {
    if (e instanceof ErreurOAuth) return { erreur: [e.error, e.description] };
    throw e;
  }
}

describe("règles OAuth (vecteurs)", () => {
  it("politique, portées, ressources, redirections, métadonnées, PKCE, CIMD", () => {
    for (const c of V.politiques) {
      const pol = politiqueOauth(c.config);
      expect(pol, JSON.stringify(c.config)).toEqual(c.politique);
      expect(scopesSupported(pol)).toEqual(c.scopes);
      for (const [s, attendu] of Object.entries(c.portees))
        expect(famillesDePortee(s === "None" ? null : s, pol), s).toEqual(attendu);
    }
    for (const c of V.ressources) {
      const obtenu = erreurDe(() => checkResource(c.r, "https://app.lan/", POL));
      expect({ ...(obtenu as object), famille: resourceFamily(c.r) }, c.r).toEqual(
        c.ok ? { ok: c.ok, famille: c.famille } : { erreur: c.erreur, famille: c.famille },
      );
    }
    for (const c of V.redirections)
      expect([redirectionPermise(c.uri), estBoucleLocale(c.uri)], c.uri).toEqual([c.ok, c.boucle]);
    for (const c of V.correspondances)
      expect(redirectionCorrespond(c.demandee, c.enregistrees), c.demandee).toBe(c.ok);
    for (const c of V.metadonnees) {
      const obtenu = erreurDe(() => validerMetadonnees(c.meta));
      expect(obtenu, JSON.stringify(c.meta)).toEqual(c.ok ? { ok: c.ok } : { erreur: c.erreur });
    }
    for (const c of V.pkce) {
      if (c.exception) expect(() => pkceOk(c.v, c.c)).toThrow(ErreurPython);
      else expect(pkceOk(c.v, c.c), c.v).toBe(c.ok);
    }
    for (const [u, attendu] of Object.entries(V.cimd)) expect(estClientCimd(u), u).toBe(attendu);
    for (const [u, attendu] of Object.entries(V.base)) expect(resourceBase(u), u).toBe(attendu);
  });
});

describe.each(MOTEURS)("stockage OAuth (%s)", (moteur) => {
  let t: BaseDeTest;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 1 });
    await createUser(t.base, "bob", "mdp-bob", { isAdmin: 0 });
  });

  afterAll(async () => t?.fermer());

  it("scénario rejoué : résultats et tables identiques à mcp/oauth.py", async () => {
    let horloge = 1_800_000_000;
    let compteur = 0;
    let plafond = 1000;
    let config: unknown = {};
    const dns: Record<string, string[]> = {};
    let document: { corps?: string; erreur?: string } = {
      erreur: "Document de client injoignable depuis ce serveur.",
    };
    let telechargements: [string, string][] = [];
    const dep: DependancesOAuth = {
      base: t.base,
      config: () => config,
      maintenant: () => horloge,
      jetonUrl: (n) => `U${String(++compteur).padStart(3, "0")}`.padEnd(Math.ceil((4 * n) / 3), "u"),
      jetonHex: (n) => `H${String(++compteur).padStart(3, "0")}`.padEnd(2 * n, "0"),
      resoudre: async (hote) => {
        const ips = dns[hote];
        if (ips === undefined) throw new Error("Name or service not known");
        return ips;
      },
      telecharger: async (url, ip) => {
        telechargements.push([url, ip]);
        if (document.erreur !== undefined) throw new ErreurOAuth("invalid_client", document.erreur);
        return Buffer.from(document.corps ?? "");
      },
    };
    const valeurs: Record<string, string[]> = { c: [], s: [], code: [], acces: [], rafr: [] };
    const remplacer = (v: unknown): unknown => {
      if (typeof v === "string")
        return Object.entries(valeurs).reduce(
          (s, [k, l]) =>
            l
              .reduce((s2, x, i) => s2.replaceAll(`{${k}:${i}}`, x), s)
              .replaceAll(`{${k}:-1}`, l.at(-1) ?? `{${k}:-1}`),
          v,
        );
      if (Array.isArray(v)) return v.map(remplacer);
      if (v !== null && typeof v === "object")
        return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remplacer(x)]));
      return v;
    };
    const clientDe = async (id: string): Promise<ClientOAuth> =>
      (await getClient(t.base, id)) ?? ({ client_id: id } as ClientOAuth);
    const etat = async (): Promise<Record<string, unknown[][]>> => {
      const out: Record<string, unknown[][]> = {};
      for (const table of ["oauth_clients", "oauth_codes", "oauth_tokens"]) {
        const lignes = (await t.base.all(`SELECT * FROM ${table}`)).map((l) =>
          Object.values(l).map((x) => x),
        );
        out[table] = lignes.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      }
      return out;
    };
    for (const [i, [nom, brut]] of V.scenario.entries()) {
      const kw = remplacer(brut) as Record<string, unknown>;
      const obtenu: Partial<Resultat> = {};
      telechargements = [];
      try {
        let r: unknown = null;
        if (nom === "dns") Object.assign(dns, kw["hotes"]);
        else if (nom === "document") document = kw as typeof document;
        else if (nom === "politique") config = kw["config"];
        else if (nom === "supprimer_compte")
          await t.base.run("DELETE FROM users WHERE id=?", [kw["user_id"] as number]);
        else if (nom === "avancer") horloge += kw["s"] as number;
        else if (nom === "plafond") plafond = kw["n"] as number;
        else if (nom === "register_client") {
          const out = (await registerClient(dep, kw["meta"], "dcr", plafond)) as Record<string, string>;
          valeurs["c"]?.push(out["client_id"] ?? "");
          valeurs["s"]?.push(out["client_secret"] ?? "");
          r = out;
        } else if (nom === "issue_code") {
          let defi = kw["code_challenge"] as string;
          if (defi.startsWith("PKCE:")) defi = createHash("sha256").update(defi.slice(5)).digest("base64url");
          r = await issueCode(dep, {
            client_id: kw["client_id"] as string,
            user_id: kw["user_id"] as number,
            redirect_uri: kw["redirect_uri"] as string,
            code_challenge: defi,
            resource: kw["resource"] as string,
            families: kw["families"] as string[],
          });
          valeurs["code"]?.push(r as string);
        } else if (nom === "exchange_code" || nom === "refresh") {
          const client = await clientDe(kw["client"] as string);
          const out = (
            nom === "exchange_code"
              ? await exchangeCode(dep, {
                  code: kw["code"],
                  client,
                  redirectUri: kw["redirect_uri"],
                  codeVerifier: kw["code_verifier"],
                  resource: kw["resource"],
                  appUrl: "https://app.lan",
                })
              : await refresh(dep, {
                  refreshToken: kw["refresh_token"],
                  client,
                  scope: kw["scope"],
                  resource: kw["resource"],
                  appUrl: "https://app.lan",
                })
          ) as Record<string, string>;
          valeurs["acces"]?.push(out["access_token"] ?? "");
          valeurs["rafr"]?.push(out["refresh_token"] ?? "");
          r = out;
        } else if (nom === "get_client") r = await getClient(t.base, kw["client_id"]);
        else if (nom === "authenticate_client")
          r = await authenticateClient(t.base, kw["client_id"], kw["secret"]);
        else if (nom === "resolve_client") r = await resolveClient(dep, kw["client_id"]);
        else if (nom === "verify_access_token") r = await verifyAccessToken(dep, kw["token"]);
        else if (nom === "list_grants") r = await listGrants(t.base, kw["user_id"] as number, horloge);
        else if (nom === "revoke_token") {
          // Python rend None ; le TS rend en plus le jeton révoqué, pour le journal de sécurité.
          await revokeToken(dep, kw["token"], kw["client_id"]);
          r = null;
        } else if (nom === "revoke_grant")
          r = await revokeGrant(t.base, kw["user_id"] as number, kw["grant_id"] as string, horloge);
        else if (nom === "list_clients") r = await listClients(t.base, horloge);
        else if (nom === "delete_client") r = await deleteClient(t.base, kw["client_id"] as string);
        else throw new Error(`opération inconnue : ${nom}`);
        obtenu.resultat = JSON.parse(JSON.stringify(r)) as unknown;
      } catch (e) {
        if (!(e instanceof ErreurOAuth)) throw e;
        obtenu.erreur = { error: e.error, description: e.description, status: e.status };
      }
      if (telechargements.length > 0) obtenu.telechargements = telechargements;
      const attendu = V.resultats[i] as Resultat;
      const etatAttendu = Object.fromEntries(
        Object.entries(attendu.etat).map(([k, l]) => [
          k,
          [...l].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
        ]),
      );
      const { etat: _e, ...sansEtat } = attendu;
      expect(obtenu, `étape ${i} : ${nom}`).toEqual(sansEtat);
      expect(await etat(), `étape ${i} : ${nom} (tables)`).toEqual(etatAttendu);
    }
  });
});
