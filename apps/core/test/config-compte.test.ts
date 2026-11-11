// SPDX-License-Identifier: MIT
/** apps/core/test/config-compte.test.ts — `/api/config` rejoué contre le routeur Python (vecteurs) ; blanchiment des secrets, uid de session, portes de session réelles. */
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, installerAuth, Session, signerSession } from "@elpis/auth";
import type { DependancesAuth } from "@elpis/auth";
import { pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { creerFamilleConfig, redactSecrets, sessionUidAny, uidDeSession } from "../src/familles/config";
import { appTest } from "./aides";

const TEXTE = readFileSync(new URL("./vecteurs/config-compte.json", import.meta.url), "utf-8");
const V = JSON.parse(TEXTE) as {
  comptes: [string, number][];
  instance: string;
  sessions: Record<string, unknown>[];
  etapes: [string, string | null, unknown?][];
  ids: Record<string, number>;
  redactions: string[];
  uids: { uid: number | null; controle: number[] }[];
  reponses: ({ statut: number; corps: string; cache: string | null } | null)[];
  fichiers: Record<string, string>;
};
/** Écart voulu : `mcp.server_cmd` (elpis-tools) n'est plus dans la configuration par défaut, ni rendu ni recopié. */
function sansServerCmd(texte: string | undefined): string | undefined {
  return texte
    ?.replaceAll('"server_cmd":"server/local_mcp_server.py",', "")
    .replaceAll('"server_cmd": "server/local_mcp_server.py",\n    ', "");
}

const PY = pyJsonLoads(TEXTE) as {
  redactions_entrees: unknown[];
  etapes: [string, string | null, unknown?][];
};
const ENTREES = PY.redactions_entrees;
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

describe("blanchiment des secrets et uid de session (vecteurs)", () => {
  it("`_redact_secrets` : mêmes sorties, source jamais modifiée", () => {
    for (const [i, cfg] of ENTREES.entries()) {
      const avant = pyJsonDumps(cfg, { ensureAscii: false });
      expect(pyJsonDumps(redactSecrets(cfg), { ensureAscii: false }), `cas ${i}`).toBe(V.redactions[i]);
      expect(pyJsonDumps(cfg, { ensureAscii: false }), `cas ${i}`).toBe(avant);
    }
  });

  it("clés `user_id`, `uid`, `user` et `int()` de Python ; portes de validité appelées avec le même uid", () => {
    for (const [i, s] of V.sessions.entries()) {
      const uid = uidDeSession((cle) => s[cle]);
      expect(uid ?? null, `session ${i}`).toBe(V.uids[i]?.uid);
      expect(uid === null || uid === undefined ? [] : [uid], `session ${i}`).toEqual(V.uids[i]?.controle);
    }
  });
});

describe.each(MOTEURS)("/api/config (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let restaurer: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [nom, admin] of V.comptes) await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin });
    dossier = mkdtempSync(join(tmpdir(), "elpis-config-compte-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    const auth = dependancesParDefaut(t.base);
    app = await appTest({
      familles: [
        creerFamilleConfig({
          auth,
          racine: dossier,
          uidSession: async (req) =>
            req.headers["x-uid"] === undefined ? null : Number(req.headers["x-uid"]),
        }),
      ],
      extensions: [(a) => installerAuth(a, auth)],
    });
  });

  afterAll(async () => {
    restaurer();
    await app.close();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("rejoue les étapes : mêmes réponses au texte près, mêmes fichiers écrits (vecteurs)", async () => {
    const instance = join(dossier, "config.json");
    writeFileSync(instance, V.instance);
    for (const [i, [nom, methode, corps]] of PY.etapes.entries()) {
      if (nom === "<instance>") {
        if (methode === null) unlinkSync(instance);
        else writeFileSync(instance, methode);
        continue;
      }
      const entetes: Record<string, string> = {};
      if (nom !== "anonyme") entetes["x-uid"] = String(V.ids[nom]);
      let charge: string | undefined;
      if (typeof corps === "string" && corps.startsWith("<<")) charge = corps.slice(2, -2);
      else if (corps !== null && corps !== undefined) charge = pyJsonDumps(corps, { ensureAscii: false });
      if (charge !== undefined) entetes["content-type"] = "application/json";
      const r = await app.inject({
        method: methode as "GET" | "PUT",
        url: "/api/config",
        headers: entetes,
        payload: charge,
      });
      const attendu = V.reponses[i];
      expect(r.statusCode, `étape ${i}`).toBe(attendu?.statut);
      expect(r.body.replaceAll(dossier, "<R>"), `étape ${i}`).toBe(sansServerCmd(attendu?.corps));
      if (r.statusCode === 200 && methode === "GET")
        expect(r.headers["cache-control"], `étape ${i}`).toBe(attendu?.cache);
    }
    const dossierConfigs = join(dossier, "user_db", "configs");
    const fichiers = Object.fromEntries(
      readdirSync(dossierConfigs)
        .sort()
        .map((f) => [f, readFileSync(join(dossierConfigs, f), "utf-8")]),
    );
    expect(fichiers).toEqual(
      Object.fromEntries(Object.entries(V.fichiers).map(([f, texte]) => [f, sansServerCmd(texte)])),
    );
  });

  it("metrics.scrape_token n'est ni recopié dans le fichier du compte ni rendu, même déjà présent dans ce fichier", async () => {
    const instance = join(dossier, "config.json");
    const uid = Object.values(V.ids)[0] ?? 0;
    const fichier = join(dossier, "user_db", "configs", `${uid}.json`);
    const sauvegarde = readFileSync(instance, "utf-8");
    const avant = existsSync(fichier) ? readFileSync(fichier, "utf-8") : null;
    const lire = async (): Promise<string> =>
      (await app.inject({ method: "GET", url: "/api/config", headers: { "x-uid": String(uid) } })).body;
    try {
      writeFileSync(instance, JSON.stringify({ metrics: { scrape_token: "jeton-prometheus" } }));
      rmSync(fichier, { force: true });
      expect(await lire()).not.toContain("jeton-prometheus");
      expect(readFileSync(fichier, "utf-8")).not.toContain("jeton-prometheus");
      writeFileSync(fichier, JSON.stringify({ metrics: { scrape_token: "jeton-prometheus", x: 1 } }));
      const corps = await lire();
      expect(corps).not.toContain("jeton-prometheus");
      expect(pyJsonLoads(corps)).toMatchObject({ config: { metrics: { scrape_token: "", x: 1 } } });
    } finally {
      writeFileSync(instance, sauvegarde);
      if (avant === null) rmSync(fichier, { force: true });
      else writeFileSync(fichier, avant);
    }
  });
});

describe("`_session_uid_any` sur une vraie session", () => {
  let t: BaseDeTest;
  let auth: DependancesAuth;
  let uid: number;
  let dossier: string;
  let restaurer: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    uid = await createUser(t.base, "dora", "mdp-dora", { isAdmin: 0 });
    auth = { ...dependancesParDefaut(t.base), secret: () => "secret-de-test" };
    dossier = mkdtempSync(join(tmpdir(), "elpis-config-session-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
  });

  afterAll(async () => {
    restaurer();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("GET /api/config avec un vrai cookie : clés de la session dans l'ordre du cookie", async () => {
    const app = await appTest({
      familles: [creerFamilleConfig({ auth, racine: dossier })],
      extensions: [(a) => installerAuth(a, auth)],
    });
    try {
      const t0 = Date.now() / 1000;
      const session = { user_id: uid, _login_ts: t0 - 10, _sid: "sid-de-test", csrf: "x" };
      const cookie = `mcpwebui_session=${signerSession(session, "secret-de-test", t0)}`;
      const r = await app.inject({ method: "GET", url: "/api/config", headers: { cookie } });
      expect(r.statusCode).toBe(200);
      expect((r.json() as { session_keys: string[] }).session_keys).toEqual([
        "user_id",
        "_login_ts",
        "_sid",
        "csrf",
      ]);
      const sans = await app.inject({ method: "GET", url: "/api/config" });
      expect([sans.statusCode, sans.json()]).toEqual([401, { detail: "not logged in" }]);
    } finally {
      await app.close();
    }
  });

  const requete = (donnees: Record<string, unknown>, method = "GET"): FastifyRequest =>
    ({ session: new Session(donnees), method, url: "/api/config" }) as unknown as FastifyRequest;

  it("session valide, `uid` hérité, portes de validité, mot de passe à changer sur une écriture seulement", async () => {
    const maintenant = Date.now() / 1000;
    expect(await sessionUidAny(requete({ user_id: uid, _login_ts: maintenant }), auth)).toBe(uid);
    expect(await sessionUidAny(requete({ uid: String(uid), _login_ts: maintenant }), auth)).toBe(uid);
    expect(await sessionUidAny(requete({ user_id: uid }), auth)).toBeNull();
    expect(
      await sessionUidAny(requete({ user_id: uid, _login_ts: maintenant - 10 * 86400 }), auth),
    ).toBeNull();
    expect(await sessionUidAny(requete({ user_id: "x", uid, _login_ts: maintenant }), auth)).toBeNull();
    await t.base.run("UPDATE users SET must_change_pwd=1 WHERE id=?", [uid]);
    expect(await sessionUidAny(requete({ user_id: uid, _login_ts: maintenant }), auth)).toBe(uid);
    expect(await sessionUidAny(requete({ user_id: uid, _login_ts: maintenant }, "PUT"), auth)).toBeNull();
  });
});
