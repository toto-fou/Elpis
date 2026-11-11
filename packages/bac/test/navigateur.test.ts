// SPDX-License-Identifier: MIT
/** packages/bac/test/navigateur.test.ts — navigateur dans le bac : bascule par compte (`browser.mode`, `browser.sandbox_users`), montages et étiquette en mode bac seulement, recréation sur changement, démarrage détaché à l'environnement passé par un fichier 0600 retiré ensuite, arrêt. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { surchargerConfig } from "@elpis/config";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  empreinteNavigateur,
  getUserSandbox,
  MONTAGES_NAVIGATEUR,
  montagesNavigateur,
  navigateurDansLeBac,
  privdrop,
  reglagesNavigateurBac,
  resetUserSandboxCache,
  sandboxAdminConfigDepuis,
  SCRIPT_NAVIGATEUR,
  UserSandbox,
} from "../src/index";
import { dossierTemporaire, FauxCli } from "./aides";

const [tmp, nettoyer] = dossierTemporaire("bac-nav-");
const cfg = path.join(tmp, "config.json");
let restaurer: () => void = () => undefined;

function config(browser: unknown): void {
  writeFileSync(cfg, JSON.stringify({ browser }));
  restaurer();
  restaurer = surchargerConfig({ CONFIG_JSON_PATH: cfg });
}

beforeAll(() => {
  for (const d of ["service/node_modules", "service/cookies", "service/test", "node/bin", "pw"])
    mkdirSync(path.join(tmp, d), { recursive: true });
  writeFileSync(path.join(tmp, "node/bin/node"), "");
  for (const f of [
    "server.js",
    "url_guard.js",
    "package.json",
    "package-lock.json",
    ".token",
    "cookies/state_x.json",
  ])
    writeFileSync(path.join(tmp, "service", f), "x");
  Object.assign(reglagesNavigateurBac, {
    service: path.join(tmp, "service"),
    node: path.join(tmp, "node"),
    playwright: path.join(tmp, "pw"),
  });
});

afterEach(() => resetUserSandboxCache());

afterAll(() => {
  restaurer();
  Object.assign(reglagesNavigateurBac, { service: null, node: null, playwright: null });
  nettoyer();
});

describe("bascule par compte", () => {
  it("central par défaut ; sandbox pour tous, ou pour les comptes nommés", () => {
    config({});
    expect(navigateurDansLeBac("alice")).toBe(false);
    config({ mode: "sandbox" });
    expect(navigateurDansLeBac("alice")).toBe(true);
    config({ mode: "sandbox", sandbox_users: ["bob"] });
    expect([navigateurDansLeBac("alice"), navigateurDansLeBac("bob")]).toEqual([false, true]);
    config({ mode: "sandbox", sandbox_users: ["*"] });
    expect(navigateurDansLeBac("alice")).toBe(true);
    config({ mode: "central", sandbox_users: ["alice"] });
    expect(navigateurDansLeBac("alice")).toBe(false);
  });

  it("le registre marque le bac et le fait revérifier quand la bascule change", () => {
    config({ mode: "sandbox", sandbox_users: ["alice"] });
    const a = getUserSandbox(1, "alice", path.join(tmp, "alice", "work"));
    expect(a.navigateur).toBe(true);
    a.configVerified = true;
    config({ mode: "central" });
    expect(getUserSandbox(1, "alice", path.join(tmp, "alice", "work"))).toBe(a);
    expect([a.navigateur, a.configVerified]).toEqual([false, false]);
  });
});

describe("conteneur en mode bac", () => {
  it("montages en lecture seule et étiquette elpis.browser, absents en mode central", () => {
    const sb = new UserSandbox(1, "alice", path.join(tmp, "a", "work"), sandboxAdminConfigDepuis({}), null, {
      cli: new FauxCli(),
    });
    const central = sb.buildRunArgs(sb.networkProfile);
    expect(central.join(" ")).not.toContain("/opt/elpis/browser-service");
    sb.navigateur = true;
    const bac = sb.buildRunArgs(sb.networkProfile);
    for (const dst of [
      `${MONTAGES_NAVIGATEUR.service}/server.js`,
      MONTAGES_NAVIGATEUR.modules,
      MONTAGES_NAVIGATEUR.node,
      MONTAGES_NAVIGATEUR.playwright,
    ])
      expect(bac).toContain(bac.find((x) => x.endsWith(`:${dst}:ro`)));
    expect(bac).toContain(`elpis.browser=${empreinteNavigateur()}`);
    expect(empreinteNavigateur()).toMatch(/^[0-9a-f]{12}$/u);
    expect(bac.slice(-3)).toEqual(central.slice(-3));
  });

  it("seul le code du service est monté : ni ses données, ni ses jetons, ni ses autres dossiers ; un fichier remplacé change l'empreinte", () => {
    const m = (montagesNavigateur() ?? []).filter((x) => x !== "-v");
    const service = m
      .filter((x) => x.includes(`:${MONTAGES_NAVIGATEUR.service}/`))
      .map((x) => x.split(":")[1]);
    expect(service.sort()).toEqual(
      ["node_modules", "package.json", "server.js", "url_guard.js"].map(
        (f) => `${MONTAGES_NAVIGATEUR.service}/${f}`,
      ),
    );
    expect(m.some((x) => x.split(":")[1] === MONTAGES_NAVIGATEUR.service)).toBe(false);
    expect(m.join(" ")).not.toMatch(/cookies|\.token|package-lock|\/test/u);
    const avant = empreinteNavigateur();
    const f = path.join(tmp, "service", "url_guard.js");
    writeFileSync(`${f}.neuf`, "y");
    renameSync(`${f}.neuf`, f);
    expect(empreinteNavigateur()).not.toBe(avant);
  });

  it("sans cache Playwright, le mode bac n'ajoute rien au conteneur", () => {
    reglagesNavigateurBac.playwright = path.join(tmp, "absent");
    try {
      expect(montagesNavigateur()).toBeNull();
      const sb = new UserSandbox(
        1,
        "alice",
        path.join(tmp, "a", "work"),
        sandboxAdminConfigDepuis({}),
        null,
        {
          cli: new FauxCli(),
        },
      );
      const central = sb.buildRunArgs(sb.networkProfile);
      sb.navigateur = true;
      expect(sb.buildRunArgs(sb.networkProfile)).toEqual(central);
    } finally {
      reglagesNavigateurBac.playwright = path.join(tmp, "pw");
    }
  });

  it("étiquette exigée en mode bac seulement (recréation), ignorée en mode central", async () => {
    const reponse = (nav: string): FauxCli =>
      new FauxCli([
        { motif: ["inspect", "~elpis.browser"], out: `|6|elpis/sandbox:1.8.0||${nav}\n` },
        { motif: ["inspect"], out: "|6|elpis/sandbox:1.8.0|\n" },
      ]);
    const sb = (cli: FauxCli, nav: boolean): UserSandbox => {
      const s = new UserSandbox(1, "alice", path.join(tmp, "a", "work"), sandboxAdminConfigDepuis({}), null, {
        cli,
      });
      s.navigateur = nav;
      return s;
    };
    expect(await sb(reponse(""), false).configMatches()).toBe(true);
    expect(await sb(reponse(""), true).configMatches()).toBe(false);
    expect(await sb(reponse(empreinteNavigateur()), true).configMatches()).toBe(true);
  });

  it("démarrage détaché sous exec_user, environnement par un fichier 0600 de l'hôte retiré ensuite, jamais en argument", async () => {
    const cli = new FauxCli();
    mkdirSync(path.join(tmp, "a"), { recursive: true });
    const sb = new UserSandbox(1, "alice", path.join(tmp, "a", "work"), sandboxAdminConfigDepuis({}), null, {
      cli,
    });
    privdrop.remember(sb.containerName, "10001:10001", true);
    let fichier = "";
    let contenu = "";
    cli.suspendre = (args) => {
      const i = args.indexOf("--env-file");
      if (i < 0) return null;
      fichier = args[i + 1] ?? "";
      contenu = readFileSync(fichier, "utf8");
      return Promise.resolve([0, Buffer.alloc(0), Buffer.alloc(0)]);
    };
    await sb.startNavigateur({ BROWSER_SERVICE_TOKEN: "tok-123", BROWSER_SANDBOX: "1" });
    const args = cli.appels.at(-1) as string[];
    expect(args.slice(0, 3)).toEqual(["exec", "-d", "--user"]);
    expect(args.join(" ")).toContain("10001");
    expect(args).toContain(SCRIPT_NAVIGATEUR);
    expect(args.join(" ")).not.toContain("tok-123");
    expect(contenu).toBe("BROWSER_SERVICE_TOKEN=tok-123\nBROWSER_SANDBOX=1\n");
    expect(path.dirname(fichier)).toBe(path.join(tmp, "a"));
    expect(existsSync(fichier)).toBe(false);
    await sb.stopNavigateur();
    expect((cli.appels.at(-1) as string[]).join(" ")).toContain(
      `pkill -TERM -f ${MONTAGES_NAVIGATEUR.service}/server.js`,
    );
  });
});
