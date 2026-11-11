// SPDX-License-Identifier: MIT
/** apps/core/test/securite-config-instance.test.ts — `GET /api/config` : une session ne reçoit que les sections publiques de config.json, sur tous les chemins de la route. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createUser, dependancesParDefaut, installerAuth } from "@elpis/auth";
import { getDesktopTargets, reloadDesktopConfigFromDisk, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { creerFamilleConfig } from "../src/familles/config";
import { appTest } from "./aides";

const JETON = "jeton-agent-tres-secret";
const URL_AGENT = "http://machine-cachee.lan:8765";
const SECRETS = [JETON, URL_AGENT, "cle-moteur-secrete", "secret-section-future", "secret-cle-future"];
const PUBLIC = {
  welcome: { type: "icon", icon: "ph-sparkle" },
  app_info: { name: "Elpis LAN" },
  login_page: { title: "Bienvenue" },
};
const INSTANCE = {
  ...PUBLIC,
  desktop: { targets: [{ name: "poste-1", agent_url: URL_AGENT, agent_token: JETON, access: "all" }] },
  llama: { url: "http://gpu.lan", api_key: "cle-moteur-secrete" },
  section_future: { liste: [{ valeur: "secret-section-future" }] },
  cle_future: "secret-cle-future",
};

describe("GET /api/config : sections d'instance rendues à un compte", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let restaurer: () => void;
  let bob = 0;
  let admin = 0;
  const instance = (): string => join(dossier, "config.json");
  const fichierDe = (uid: number): string => join(dossier, "user_db", "configs", `${uid}.json`);
  const appeler = async (uid: number, methode: "GET" | "PUT" = "GET", charge?: unknown) => {
    const r = await app.inject({
      method: methode,
      url: "/api/config",
      headers: {
        "x-uid": String(uid),
        ...(charge === undefined ? {} : { "content-type": "application/json" }),
      },
      payload: charge === undefined ? undefined : JSON.stringify(charge),
    });
    expect(r.statusCode).toBe(200);
    return r;
  };
  const verifierSansSecret = (texte: string): void => {
    for (const secret of SECRETS) expect(texte, secret).not.toContain(secret);
  };
  const configRendue = async (uid: number): Promise<unknown> => {
    const r = await appeler(uid);
    verifierSansSecret(r.body);
    return (r.json() as { config: unknown }).config;
  };

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    bob = await createUser(t.base, "bob", "mdp-de-bob", { isAdmin: 0 });
    admin = await createUser(t.base, "alice", "mdp-d-alice", { isAdmin: 1 });
    dossier = mkdtempSync(join(tmpdir(), "elpis-config-instance-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: instance() });
    const auth = dependancesParDefaut(t.base);
    app = await appTest({
      familles: [
        creerFamilleConfig({
          auth,
          racine: dossier,
          uidSession: async (req) => Number(req.headers["x-uid"]),
        }),
      ],
      extensions: [(a) => installerAuth(a, auth)],
    });
  });

  beforeEach(() => {
    rmSync(join(dossier, "user_db"), { recursive: true, force: true });
    mkdirSync(join(dossier, "user_db", "configs"), { recursive: true });
    writeFileSync(instance(), JSON.stringify(INSTANCE));
  });

  afterAll(async () => {
    restaurer();
    await app.close();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  it("premier accès : seules les sections publiques sont rendues et recopiées", async () => {
    expect(await configRendue(bob)).toEqual(PUBLIC);
    const copie = readFileSync(fichierDe(bob), "utf-8");
    verifierSansSecret(copie);
    expect(JSON.parse(copie)).toEqual(PUBLIC);
  });

  it("fichier du compte vidé par PUT : le repli ne rend que les sections publiques", async () => {
    await appeler(bob, "PUT", { config: {} });
    expect(await configRendue(bob)).toEqual(PUBLIC);
  });

  it("fichier du compte qui n'est pas un objet : même repli", async () => {
    writeFileSync(fichierDe(bob), "[1, 2]");
    expect(await configRendue(bob)).toEqual(PUBLIC);
  });

  it("copie écrite par une version antérieure : ni rendue ni gardée sur le disque", async () => {
    const attendu = { ...PUBLIC, app_info: { name: "Perso" } };
    writeFileSync(fichierDe(bob), JSON.stringify({ ...INSTANCE, app_info: { name: "Perso" } }));
    expect(await configRendue(bob)).toEqual(attendu);
    const copie = readFileSync(fichierDe(bob), "utf-8");
    verifierSansSecret(copie);
    expect(JSON.parse(copie)).toEqual(attendu);
  });

  it("copie sans aucune section publique : nettoyée, puis repli sur l'instance", async () => {
    writeFileSync(fichierDe(bob), JSON.stringify({ desktop: INSTANCE.desktop }));
    expect(await configRendue(bob)).toEqual(PUBLIC);
    expect(JSON.parse(readFileSync(fichierDe(bob), "utf-8"))).toEqual({});
  });

  it("section écrite par PUT hors liste : ni rendue, ni gardée à la lecture suivante", async () => {
    await appeler(bob, "PUT", { config: { desktop: INSTANCE.desktop, welcome: { type: "image" } } });
    expect(await configRendue(bob)).toEqual({ welcome: { type: "image" } });
    expect(JSON.parse(readFileSync(fichierDe(bob), "utf-8"))).toEqual({ welcome: { type: "image" } });
  });

  it("config.json absent : aucune section, réponse conforme", async () => {
    rmSync(instance());
    expect(await configRendue(bob)).toEqual({});
  });

  it("même règle pour un administrateur sur cette route", async () => {
    expect(await configRendue(admin)).toEqual(PUBLIC);
  });

  it("les machines de bureau viennent de config.json, jamais du fichier du compte", async () => {
    writeFileSync(
      fichierDe(bob),
      JSON.stringify({
        desktop: { targets: [{ name: "pirate", agent_url: "http://x.lan", agent_token: "y" }] },
      }),
    );
    await configRendue(bob);
    reloadDesktopConfigFromDisk(true);
    expect(getDesktopTargets(false).map((c) => [c.name, c.agent_url, c.agent_token])).toEqual([
      ["poste-1", URL_AGENT, JETON],
    ]);
  });
});
