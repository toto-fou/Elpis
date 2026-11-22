// SPDX-License-Identifier: MIT
/** packages/bac/test/navigateur.test.ts — navigateur dans le bac de chaque compte : montages et étiquette quand le navigateur est installé, recréation sur changement, démarrage détaché à l'environnement passé par un fichier 0600 retiré ensuite, arrêt. */
import { mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BROWSER_DATA,
  empreinteNavigateur,
  MONTAGES_NAVIGATEUR,
  montagesNavigateur,
  PATH_COMPTE,
  reglagesNavigateurBac,
  sandboxAdminConfigDepuis,
  SCRIPT_NAVIGATEUR,
  UserSandbox,
} from "../src/index";
import { ENTREE_ROOT, RUN_SPEC, UTILISATEUR_IMAGE } from "../src/durcissement";
import { empreinteDemarrage } from "../src/montages";
import { dossierTemporaire, FauxCli } from "./aides";

const [tmp, nettoyer] = dossierTemporaire("bac-nav-");

beforeAll(() => {
  for (const d of [
    "service/node_modules",
    "service/cookies",
    "service/test",
    "service/src",
    "service/dist",
    "node/bin",
    "pw",
  ])
    mkdirSync(path.join(tmp, d), { recursive: true });
  writeFileSync(path.join(tmp, "node/bin/node"), "");
  for (const f of [
    "dist/main.mjs",
    "dist/main.mjs.map",
    "src/main.ts",
    "server.js",
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

afterAll(() => {
  Object.assign(reglagesNavigateurBac, { service: null, node: null, playwright: null });
  nettoyer();
});

describe("conteneur du bac", () => {
  it("montages en lecture seule et étiquette elpis.browser", () => {
    const sb = new UserSandbox(1, "alice", path.join(tmp, "a", "work"), sandboxAdminConfigDepuis({}), null, {
      cli: new FauxCli(),
    });
    const bac = sb.buildRunArgs(sb.networkProfile);
    for (const dst of [
      MONTAGES_NAVIGATEUR.bundle,
      MONTAGES_NAVIGATEUR.modules,
      MONTAGES_NAVIGATEUR.node,
      MONTAGES_NAVIGATEUR.playwright,
    ])
      expect(bac).toContain(bac.find((x) => x.endsWith(`:${dst}:ro`)));
    expect(bac).toContain(`elpis.browser=${empreinteNavigateur()}`);
    expect(empreinteNavigateur()).toMatch(/^[0-9a-f]{12}$/u);
    expect(bac.slice(-4)).toEqual([
      "elpis/sandbox:1.8.0",
      "/opt/elpis/agent/demarrage.sh",
      "sleep",
      "infinity",
    ]);
  });

  it("seul le bundle du service est monté : ni ses sources, ni ses données, ni ses jetons, ni ses autres dossiers ; un bundle remplacé change l'empreinte", () => {
    const m = (montagesNavigateur() ?? []).filter((x) => x !== "-v");
    const service = m
      .filter((x) => x.includes(`:${MONTAGES_NAVIGATEUR.service}/`))
      .map((x) => x.split(":")[1]);
    expect(service.sort()).toEqual(
      ["dist/main.mjs", "node_modules"].map((f) => `${MONTAGES_NAVIGATEUR.service}/${f}`),
    );
    expect(m.some((x) => x.split(":")[1] === MONTAGES_NAVIGATEUR.service)).toBe(false);
    expect(m.join(" ")).not.toMatch(/cookies|\.token|package|\/test|\/src|server\.js|\.map/u);
    const avant = empreinteNavigateur();
    const f = path.join(tmp, "service", "dist", "main.mjs");
    writeFileSync(`${f}.neuf`, "y");
    renameSync(`${f}.neuf`, f);
    expect(empreinteNavigateur()).not.toBe(avant);
  });

  it("navigateur non installé (sans cache Playwright) : ni montage ni étiquette", () => {
    reglagesNavigateurBac.playwright = path.join(tmp, "absent");
    try {
      expect(montagesNavigateur()).toBeNull();
      expect(empreinteNavigateur()).toBe("");
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
      expect(sb.buildRunArgs(sb.networkProfile).join(" ")).not.toMatch(
        /\/opt\/elpis\/(browser-service|node|ms-playwright)|elpis\.browser/u,
      );
    } finally {
      reglagesNavigateurBac.playwright = path.join(tmp, "pw");
    }
  });

  it("étiquette absente ou ancienne : recréation ; à jour, ou navigateur non installé (étiquette non lue) : conteneur gardé", async () => {
    const cli = (nav: string): FauxCli =>
      new FauxCli([
        {
          motif: ["inspect", "~elpis.browser"],
          out: `|${RUN_SPEC}|elpis/sandbox:1.8.0||${empreinteDemarrage()}|0|${UTILISATEUR_IMAGE}|${nav}\n`,
        },
        {
          motif: ["inspect"],
          out: `|${RUN_SPEC}|elpis/sandbox:1.8.0||${empreinteDemarrage()}|0|${UTILISATEUR_IMAGE}\n`,
        },
      ]);
    const sb = (nav: string): UserSandbox =>
      new UserSandbox(1, "alice", path.join(tmp, "a", "work"), sandboxAdminConfigDepuis({}), null, {
        cli: cli(nav),
      });
    expect(await sb("<no value>").configMatches()).toBe(false);
    expect(await sb("0123456789ab").configMatches()).toBe(false);
    expect(await sb(empreinteNavigateur()).configMatches()).toBe(true);
    reglagesNavigateurBac.playwright = path.join(tmp, "absent");
    try {
      const s = sb("<no value>");
      expect(await s.configMatches()).toBe(true);
      expect(((s.cli as FauxCli).appels[0] ?? []).join(" ")).not.toContain("elpis.browser");
    } finally {
      reglagesNavigateurBac.playwright = path.join(tmp, "pw");
    }
  });

  it("démarrage détaché sous exec_user, environnement par -e NOM et l'environnement du CLI, ni argument ni fichier", async () => {
    const cli = new FauxCli();
    mkdirSync(path.join(tmp, "a"), { recursive: true });
    const sb = new UserSandbox(1, "alice", path.join(tmp, "a", "work"), sandboxAdminConfigDepuis({}), null, {
      cli,
    });
    await sb.startNavigateur({ BROWSER_SERVICE_TOKEN: "tok-123", BROWSER_IDLE_EXIT_S: "900\n" });
    const args = cli.appels.at(-1) as string[];
    expect(args.slice(0, 3)).toEqual(["exec", "-d", "--user"]);
    expect(args.slice(3, 10)).toEqual([
      "10001:10001",
      "-e",
      `PATH=${PATH_COMPTE}`,
      "-e",
      "BROWSER_SERVICE_TOKEN",
      "-e",
      "BROWSER_IDLE_EXIT_S",
    ]);
    expect(args).toContain(SCRIPT_NAVIGATEUR);
    expect(args.join(" ")).not.toContain("tok-123");
    expect(args).not.toContain("--env-file");
    expect(cli.envs.at(-1)).toEqual({ BROWSER_SERVICE_TOKEN: "tok-123", BROWSER_IDLE_EXIT_S: "900" });
    expect(readdirSync(path.join(tmp, "a"))).toEqual([]);
    await sb.stopNavigateur();
    expect((cli.appels.at(-1) as string[]).slice(0, 8)).toEqual(["exec", ...ENTREE_ROOT, sb.containerName]);
    expect((cli.appels.at(-1) as string[]).join(" ")).toContain(
      `pkill -TERM -f ${MONTAGES_NAVIGATEUR.bundle}`,
    );
  });

  it("démarrage du service : un dossier temporaire par service dans /work, ceux des services disparus retirés, avant la base NSS", () => {
    const menage = SCRIPT_NAVIGATEUR.indexOf(
      'for t in "$D"/tmp/*; do [ -d "$t" ] && [ ! -d "/proc/${t##*/}" ] && rm -rf "$t"; done',
    );
    const i = SCRIPT_NAVIGATEUR.indexOf('export TMPDIR="$D/tmp/$$"; mkdir -p "$TMPDIR" || exit 1');
    expect(menage).toBeGreaterThan(-1);
    expect(i).toBeGreaterThan(menage);
    expect(i).toBeLessThan(SCRIPT_NAVIGATEUR.indexOf("certutil"));
    expect(SCRIPT_NAVIGATEUR).toContain(`D=${BROWSER_DATA}`);
  });
});
