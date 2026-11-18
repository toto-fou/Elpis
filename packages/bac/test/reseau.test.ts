// SPDX-License-Identifier: MIT
/** packages/bac/test/reseau.test.ts — réseau Docker des bacs : options de run, création à la demande, refus d'un réseau sans coupure du trafic. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  definirFabriqueAgent,
  ExecError,
  PONT_BACS,
  RESEAU_BACS,
  reglagesBac,
  reglagesMontages,
  sandboxAdminConfigDepuis,
  UserSandbox,
} from "../src/index";
import { argvCreationReseau, DNS_DE_GARDE, FORMAT_RESEAU, RESEAU_CONFORME } from "../src/reseau";
import { dossierTemporaire, FauxCli } from "./aides";
import type { Regle } from "./aides";

const PROFILS = [
  { id: "isolated", name: "Isolé", mode: "none" },
  { id: "open", name: "Ouvert", mode: "bridge" },
  { id: "lan", name: "LAN", mode: "allowlist_ip", ips: ["10.0.0.0/24"] },
  { id: "dns", name: "DNS", mode: "allowlist_ip", ips: ["10.0.0.0/24"], dns: ["9.9.9.9", "1.1.1.1"] },
];
const FORMAT = FORMAT_RESEAU;
const CONFORME = `${RESEAU_CONFORME}\n`;

let tmp: string;
let nettoyer: () => void;
let restaurer: () => void;
let travail: string;
let attente: number;

beforeEach(() => {
  [tmp, nettoyer] = dossierTemporaire("elpis-bac-reseau-");
  travail = path.join(tmp, "sb", "alice", "work");
  mkdirSync(travail, { recursive: true });
  mkdirSync(path.join(tmp, "agent"));
  writeFileSync(path.join(tmp, "agent", "demarrage.sh"), "#!/bin/sh\n");
  reglagesMontages.agentDir = path.join(tmp, "agent");
  restaurer = surchargerConfig({ SANDBOX_DIR: path.join(tmp, "sb") });
  vi.stubEnv("SANDBOX_READINESS_CACHE", "0");
  attente = reglagesBac.attenteCreationMs;
  reglagesBac.attenteCreationMs = 0;
  definirFabriqueAgent(() => ({
    hello: async () => ({}),
    archive: () => Promise.reject(new Error("inutile")),
    extract: () => Promise.reject(new Error("inutile")),
  }));
});

afterEach(() => {
  definirFabriqueAgent(null);
  reglagesBac.attenteCreationMs = attente;
  reglagesMontages.agentDir = null;
  restaurer();
  vi.unstubAllEnvs();
  nettoyer();
});

function bac(profil: string, regles: Regle[] = []) {
  const cli = new FauxCli(regles);
  const cfg = sandboxAdminConfigDepuis({ network_profiles: PROFILS }, () => undefined);
  const sb = new UserSandbox(1, "alice", travail, cfg, profil, { cli, resoudreDomaines: async () => ({}) });
  return { sb, cli };
}

/** Règles d'un conteneur à créer : absent aux trois premières inspections, puis en marche. */
const CREATION: Regle[] = [
  { motif: ["container", "inspect"], rc: 1, fois: 3 },
  { motif: ["~State.Status"], out: "running|0" },
  {
    motif: ["container", "inspect"],
    out: "abc|/elpis-sb-alice|true|elpis/sandbox:1.8.0|2026-10-10T00:00:00Z\n",
  },
];
const reseaux = (cli: FauxCli): unknown[][] => cli.appels.filter((a) => a[0] === "network");
const lancements = (cli: FauxCli): unknown[][] => cli.appels.filter((a) => a[0] === "run");

describe("options de docker run", () => {
  const argvDe = (profil: string): string[] => {
    const { sb } = bac(profil);
    return sb.buildRunArgs(sb.networkProfile, {});
  };
  const apres = (argv: string[], v: string): string | undefined => argv[argv.indexOf(v) + 1];

  it.each(["open", "lan", "dns"])("profil %s : réseau des bacs", (profil) => {
    const argv = argvDe(profil);
    expect(apres(argv, "--network")).toBe(RESEAU_BACS);
    expect(argv.filter((a) => a === "--network")).toHaveLength(1);
  });

  it("profil isolé : aucun réseau", () => {
    const argv = argvDe("isolated");
    expect(apres(argv, "--network")).toBe("none");
    expect(argv).not.toContain("--dns");
  });

  it("liste blanche sans résolveur : résolveur de garde ; ouvert : aucun --dns", () => {
    expect(argvDe("lan").filter((a, i, t) => t[i - 1] === "--dns")).toEqual([DNS_DE_GARDE]);
    expect(DNS_DE_GARDE).toBe("192.0.2.1");
    expect(argvDe("open")).not.toContain("--dns");
  });

  it("liste blanche avec résolveurs : les siens, pas celui de garde", () => {
    const argv = argvDe("dns");
    expect(argv.filter((a, i, t) => t[i - 1] === "--dns")).toEqual(["9.9.9.9", "1.1.1.1"]);
    expect(argv).not.toContain(DNS_DE_GARDE);
  });

  it("argv de création du réseau", () => {
    expect(argvCreationReseau()).toEqual([
      "network",
      "create",
      "--driver",
      "bridge",
      "--ipv6=false",
      "--label",
      "elpis.role=sandbox",
      "-o",
      "com.docker.network.bridge.enable_icc=false",
      "-o",
      `com.docker.network.bridge.name=${PONT_BACS}`,
      "elpis-sandbox",
    ]);
  });
});

describe("création du réseau des bacs", () => {
  it("existant tel qu'Elpis le crée : gardé, aucune création", async () => {
    expect(RESEAU_CONFORME).toBe("bridge|false|false|br-elpis-sb");
    const { sb, cli } = bac("open", [{ motif: ["network", "inspect"], out: CONFORME }, ...CREATION]);
    await sb.ensureRunning();
    expect(reseaux(cli)).toEqual([["network", "inspect", RESEAU_BACS, "--format", FORMAT, 10]]);
    expect(lancements(cli)).toHaveLength(1);
  });

  it.each([
    "bridge|false|true|br-elpis-sb\n",
    "bridge|false|<no value>|br-elpis-sb\n",
    "bridge|true|false|br-elpis-sb\n",
    "macvlan|false|false|br-elpis-sb\n",
    "bridge|false|false|docker0\n",
    "false\n",
    "\n",
  ])("existant autrement (%j) : refus, ni création ni run", async (sortie) => {
    const { sb, cli } = bac("open", [{ motif: ["network", "inspect"], out: sortie }, ...CREATION]);
    const e = await sb.ensureRunning().catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ExecError);
    expect((e as Error).message).toBe(
      "Le réseau de la sandbox est indisponible. Demandez à votre administrateur.",
    );
    expect(reseaux(cli).every((a) => a[1] === "inspect")).toBe(true);
    expect(lancements(cli)).toEqual([]);
  });

  it("absent : créé avec les options attendues, puis le run", async () => {
    const { sb, cli } = bac("lan", [
      { motif: ["network", "inspect"], rc: 1, err: "No such network", fois: 1 },
      { motif: ["network", "inspect"], out: CONFORME },
      ...CREATION,
    ]);
    await sb.ensureRunning();
    expect(reseaux(cli)).toEqual([
      ["network", "inspect", RESEAU_BACS, "--format", FORMAT, 10],
      [...argvCreationReseau(), 20],
      ["network", "inspect", RESEAU_BACS, "--format", FORMAT, 10],
    ]);
    expect(lancements(cli)).toHaveLength(1);
    expect(cli.appels.findIndex((a) => a[0] === "run")).toBeGreaterThan(
      cli.appels.findIndex((a) => a[1] === "create"),
    );
  });

  it("création concurrente (« already exists ») : relu, gardé s'il est conforme, le run part", async () => {
    const { sb, cli } = bac("open", [
      { motif: ["network", "inspect"], rc: 1, fois: 1 },
      {
        motif: ["network", "create"],
        rc: 1,
        err: "Error response: network with name elpis-sandbox Already Exists",
      },
      { motif: ["network", "inspect"], out: CONFORME },
      ...CREATION,
    ]);
    await sb.ensureRunning();
    expect(lancements(cli)).toHaveLength(1);
  });

  it("« already exists » mais relu sans la coupure : refus, pas de run", async () => {
    const { sb, cli } = bac("open", [
      { motif: ["network", "inspect"], rc: 124, fois: 1 },
      { motif: ["network", "create"], rc: 1, err: "network with name elpis-sandbox already exists" },
      { motif: ["network", "inspect"], out: "bridge|false|true|br-elpis-sb\n" },
      ...CREATION,
    ]);
    await expect(sb.ensureRunning()).rejects.toThrow("Le réseau de la sandbox est indisponible.");
    expect(lancements(cli)).toEqual([]);
  });

  it("création refusée pour une autre raison : refus sobre, pas de run", async () => {
    const { sb, cli } = bac("open", [
      { motif: ["network", "inspect"], rc: 1 },
      { motif: ["network", "create"], rc: 1, err: "pool overlaps with other one on this address space" },
      ...CREATION,
    ]);
    await expect(sb.ensureRunning()).rejects.toThrow("Le réseau de la sandbox est indisponible.");
    expect(lancements(cli)).toEqual([]);
  });

  it("profil isolé : le réseau n'est pas touché", async () => {
    const { sb, cli } = bac("isolated", CREATION);
    await sb.ensureRunning();
    expect(reseaux(cli)).toEqual([]);
    expect(lancements(cli)).toHaveLength(1);
  });
});
