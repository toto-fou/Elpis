// SPDX-License-Identifier: MIT
/** apps/core/test/oauth.test.ts — routes OAuth des clients MCP rejouées contre mcp/routes_oauth.py (vecteurs), sur SQLite et PostgreSQL. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut } from "@elpis/auth";
import { HttpError, quotePy } from "@elpis/commun";
import { configView, invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleOAuth } from "../src/familles/oauth";
import { appTest } from "./aides";

interface Etape {
  compte?: string;
  m?: string;
  u?: string;
  q?: [string, string][];
  form?: [string, string][];
  corps?: string;
  octets?: string;
  repete?: [string, number];
  type?: string;
  entetes?: Record<string, string>;
  basic?: string;
  config?: unknown;
  avancer?: number;
}

interface Reponse {
  statut: number;
  corps: string;
  entetes: Record<string, string>;
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/oauth.json", import.meta.url), "utf-8")) as {
  secret: string;
  comptes: [string, number][];
  entetes: string[];
  etapes: Etape[];
  ids: Record<string, number>;
  reponses: (Reponse | null)[];
  valeurs: Record<string, string[]>;
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const SECURITE = ["content-security-policy", "x-frame-options", "referrer-policy"];

function quotePlus(s: string): string {
  return s.includes(" ") ? quotePy(s, " ").replaceAll(" ", "+") : quotePy(s, "");
}

function urlencode(paires: [string, string][]): string {
  return paires.map(([k, v]) => `${quotePlus(k)}=${quotePlus(v)}`).join("&");
}

describe.each(MOTEURS)("routes OAuth (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let restaurer: () => void;
  let horloge = 1_800_000_000;
  let compteur = 0;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [nom, admin] of V.comptes) await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin });
    dossier = mkdtempSync(join(tmpdir(), "elpis-oauth-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    const auth = { ...dependancesParDefaut(t.base), secret: () => V.secret, maintenant: () => horloge };
    app = await appTest({
      familles: [
        creerFamilleOAuth({
          auth,
          oauth: {
            base: t.base,
            config: () => configView(),
            maintenant: () => horloge,
            jetonUrl: (n) => `U${String(++compteur).padStart(3, "0")}`.padEnd(Math.ceil((4 * n) / 3), "u"),
            jetonHex: (n) => `H${String(++compteur).padStart(3, "0")}`.padEnd(2 * n, "0"),
            resoudre: async () => {
              throw new Error("Name or service not known");
            },
          },
          compteConnecte: async (req) => (req.headers["x-uid"] ? Number(req.headers["x-uid"]) : null),
        }),
      ],
      gardes: {
        session: (req) => {
          if (!req.headers["x-uid"]) throw new HttpError(401, "not logged in");
          req.utilisateur = { id: Number(req.headers["x-uid"]), username: null };
        },
      },
    });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      restaurer?.();
      invalidateConfigCache();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("rejoue les étapes et rend les mêmes réponses, pages HTML comprises (vecteurs)", async () => {
    const valeurs: Record<string, string[]> = { c: [], s: [], req: [], code: [], acces: [], rafr: [], g: [] };
    const remplacer = (v: string): string =>
      Object.entries(valeurs).reduce(
        (s, [k, l]) => l.reduce((s2, x, i) => s2.replaceAll(`{${k}:${i}}`, x), s),
        v,
      );
    for (const [i, e] of V.etapes.entries()) {
      const attendu = V.reponses[i];
      if (e.avancer !== undefined) {
        horloge += e.avancer;
        continue;
      }
      if (e.config !== undefined) {
        writeFileSync(join(dossier, "config.json"), JSON.stringify(e.config));
        invalidateConfigCache();
        continue;
      }
      let url = remplacer(e.u ?? "");
      if (e.q) url += `?${urlencode(e.q.map(([k, v]) => [k, remplacer(v)]))}`;
      const entetes: Record<string, string> = { host: "testserver" };
      for (const [k, v] of Object.entries(e.entetes ?? {})) entetes[k] = remplacer(v);
      let payload: Buffer | undefined;
      if (e.form) {
        payload = Buffer.from(urlencode(e.form.map(([k, v]) => [k, remplacer(v)])));
        entetes["content-type"] = "application/x-www-form-urlencoded";
      } else if (e.corps !== undefined) payload = Buffer.from(remplacer(e.corps));
      else if (e.octets !== undefined) payload = Buffer.from(e.octets, "hex");
      else if (e.repete) payload = Buffer.from(e.repete[0].repeat(e.repete[1]));
      if (e.type) entetes["content-type"] = e.type;
      if (e.basic) entetes["authorization"] = `Basic ${Buffer.from(remplacer(e.basic)).toString("base64")}`;
      if (e.compte) entetes["x-uid"] = String(V.ids[e.compte]);
      const r = await app.inject({
        method: e.m as "GET",
        url,
        headers: entetes,
        ...(payload !== undefined ? { payload } : {}),
      });
      if (e.u === "/oauth/register" && r.statusCode === 201) {
        const j = r.json<Record<string, string>>();
        valeurs["c"]?.push(j["client_id"] ?? "");
        valeurs["s"]?.push(j["client_secret"] ?? "");
      } else if (e.u === "/oauth/authorize" && e.m === "GET" && r.statusCode === 200)
        valeurs["req"]?.push(/name="req" value="([^"]*)"/u.exec(r.body)?.[1] ?? "");
      else if (
        e.u === "/oauth/authorize" &&
        r.statusCode === 302 &&
        String(r.headers.location).includes("code=")
      )
        valeurs["code"]?.push(new URL(String(r.headers.location)).searchParams.get("code") ?? "");
      else if (e.u === "/oauth/token" && r.statusCode === 200) {
        valeurs["acces"]?.push(r.json<Record<string, string>>()["access_token"] ?? "");
        valeurs["rafr"]?.push(r.json<Record<string, string>>()["refresh_token"] ?? "");
      } else if (e.u === "/api/oauth/grants" && e.m === "GET" && r.statusCode === 200)
        valeurs["g"]?.push(...r.json<{ items: { grant_id: string }[] }>().items.map((x) => x.grant_id));
      const html = (attendu?.entetes["content-type"] ?? "").startsWith("text/html");
      const vus: Record<string, string> = {};
      for (const k of V.entetes) {
        const v = r.headers[k];
        if (v === undefined || (SECURITE.includes(k) && !html)) continue;
        vus[k] = k === "content-type" ? (String(v).split(";")[0] ?? "") : String(v);
      }
      const attendus = Object.fromEntries(
        Object.entries(attendu?.entetes ?? {})
          .filter(([k]) => !SECURITE.includes(k) || html)
          .map(([k, v]) => [k, k === "content-type" ? (v.split(";")[0] ?? "") : v]),
      );
      expect(
        { statut: r.statusCode, corps: r.body, entetes: vus },
        `étape ${i} : ${e.m ?? ""} ${e.u ?? ""}`,
      ).toEqual({ ...attendu, entetes: attendus });
    }
    expect(valeurs).toEqual(V.valeurs);
  });
});

/** Requête HTTP écrite à la main : en-têtes seuls, puis `corps` éventuel ; rend la ligne de statut et le corps de la réponse. */
function brut(port: number, entete: string, corps?: string): Promise<string> {
  return new Promise((fin, echec) => {
    const so = connect(port, "127.0.0.1", () => {
      so.write(entete);
      if (corps !== undefined) so.write(corps);
    });
    let recu = "";
    so.on("data", (m: Buffer) => {
      recu += m.toString();
      if (/\r\n\r\n[\s\S]*\}/u.test(recu)) so.destroy();
    });
    so.on("close", () => fin(recu.split("\r\n")[0] + " " + (recu.split("\r\n\r\n")[1] ?? "")));
    so.on("error", echec);
  });
}

describe("corps des routes OAuth borné avant lecture", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let restaurer: () => void;
  let port = 0;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    dossier = mkdtempSync(join(tmpdir(), "elpis-oauth-borne-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    app = await appTest({
      familles: [
        creerFamilleOAuth({
          auth: dependancesParDefaut(t.base),
          oauth: { base: t.base, config: () => configView() },
          compteConnecte: async () => null,
        }),
      ],
      gardes: {
        session: () => {
          throw new HttpError(401, "not logged in");
        },
      },
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    port = (app.server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    try {
      app?.server.closeAllConnections();
      await app?.close();
    } finally {
      restaurer?.();
      invalidateConfigCache();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("100 Mio annoncés : 413 sans attendre le corps ; flux découpé : coupé à 64 Kio ; OAuth coupée : 404 sans lecture", async () => {
    const tete = (longueur: string): string =>
      `POST /oauth/token HTTP/1.1\r\nHost: testserver\r\nContent-Type: application/x-www-form-urlencoded\r\n${longueur}\r\n\r\n`;
    expect(await brut(port, tete("Content-Length: 104857600"))).toBe(
      'HTTP/1.1 413 Payload Too Large {"detail":"Corps trop volumineux."}',
    );
    const morceau = "x".repeat(40 * 1024);
    const decoupe = `${(40 * 1024).toString(16)}\r\n${morceau}\r\n`.repeat(2) + "0\r\n\r\n";
    expect(await brut(port, tete("Transfer-Encoding: chunked"), decoupe)).toBe(
      'HTTP/1.1 413 Payload Too Large {"detail":"Corps trop volumineux."}',
    );
    writeFileSync(join(dossier, "config.json"), JSON.stringify({ mcp: { oauth: { enabled: false } } }));
    invalidateConfigCache();
    expect(await brut(port, tete("Content-Length: 104857600"))).toBe(
      'HTTP/1.1 404 Not Found {"detail":"Autorisation OAuth désactivée."}',
    );
  });
});
