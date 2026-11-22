// SPDX-License-Identifier: MIT
/** packages/bac/test/protections.test.ts — protections d'un profil ouvert (métadonnées, réseau local, hôte) : lecture, empreintes et étiquettes, plages refusées, domaines épinglés, options de `docker run` et conteneur périmé quand la machine change. */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { adresseIpOuNul, reseauPy } from "@elpis/commun";
import type { AdresseIp, Reseau } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import type { HoteMachine } from "@elpis/securite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  adressesEpinglables,
  agentEmpreinte,
  definirFabriqueAgent,
  domainesEpingles,
  domainesPerimes,
  etiquetteDomaines,
  etiquetteNetcfg,
  ExecError,
  netcfgHash,
  PLAGES_LOCALES,
  PLAGES_METADONNEES,
  plagesRefusees,
  profilReseauDepuis,
  protectionsDe,
  reglagesBac,
  reglagesMontages,
  reglagesNavigateurBac,
  RUN_SPEC,
  sandboxAdminConfigDepuis,
  UserSandbox,
} from "../src/index";
import type { ProfilReseau } from "../src/index";
import { profilFiltre } from "../src/durcissement";
import { empreinteDemarrage } from "../src/montages";
import { dossierTemporaire, FauxCli } from "./aides";
import type { Regle } from "./aides";

const ip = (t: string): AdresseIp => adresseIpOuNul(t) as AdresseIp;
const machine = (adresses: string[], diffusions?: string[]): HoteMachine => ({
  adresses: adresses.map(ip),
  reseaux: [],
  ...(diffusions ? { diffusions: diffusions.map(ip) } : {}),
});
// Navigateur absent pour ces tests : son étiquette ne dépend pas d'un service construit dans l'arbre.
beforeAll(() => {
  reglagesNavigateurBac.playwright = "/nonexistent/ms-playwright";
});
afterAll(() => {
  reglagesNavigateurBac.playwright = null;
});

const MACHINE_A = machine(["127.0.0.1", "::1", "2001:db8::7", "192.0.2.7", "172.17.0.1"], ["192.0.2.255"]);
const MACHINE_B = machine(["127.0.0.1", "192.0.2.8", "172.17.0.1"], ["192.0.2.255"]);
const sha12 = (t: string): string => createHash("sha256").update(t, "utf8").digest("hex").slice(0, 12);
const ouvert = (extra: Record<string, unknown> = {}): ProfilReseau =>
  profilReseauDepuis({ id: "ouvert", name: "O", mode: "bridge", ...extra }, () => undefined);

describe("lecture et protections appliquées", () => {
  it.each([[true], [1], ["oui"], [[1]]])("case cochée %j : lue vraie", (v) => {
    const p = ouvert({ block_metadata: v, block_lan: v, block_host: v });
    expect([p.block_metadata, p.block_lan, p.block_host]).toEqual([true, true, true]);
  });

  it.each([[false], [0], [""], [null], [[]], [{}]])("case non cochée %j : lue fausse", (v) => {
    const p = ouvert({ block_metadata: v, block_lan: v, block_host: v });
    expect([p.block_metadata, p.block_lan, p.block_host]).toEqual([false, false, false]);
  });

  it("champs absents : fausses ; profil isolé de repli : fausses", () => {
    const p = ouvert();
    expect([p.block_metadata, p.block_lan, p.block_host]).toEqual([false, false, false]);
    expect(protectionsDe(p)).toEqual([]);
  });

  it("protectionsDe : dans l'ordre métadonnées, réseau local, hôte, seulement pour un profil ouvert", () => {
    expect(protectionsDe(ouvert({ block_host: true, block_metadata: true }))).toEqual(["metadata", "host"]);
    expect(protectionsDe(ouvert({ block_lan: true }))).toEqual(["lan"]);
    expect(protectionsDe(ouvert({ block_metadata: 1, block_lan: 1, block_host: 1 }))).toEqual([
      "metadata",
      "lan",
      "host",
    ]);
    for (const mode of ["none", "allowlist_ip"])
      expect(
        protectionsDe({ mode: mode as never, block_metadata: true, block_lan: true, block_host: true }),
      ).toEqual([]);
  });

  it("profilFiltre : un profil ouvert protégé est filtré, un profil fermé coché ne l'est pas", () => {
    expect(profilFiltre(ouvert())).toBe(false);
    expect(profilFiltre(ouvert({ block_lan: true }))).toBe(true);
    expect(profilFiltre({ mode: "none", block_metadata: true, block_lan: true, block_host: true })).toBe(
      false,
    );
    expect(
      profilFiltre({ mode: "allowlist_ip", block_metadata: false, block_lan: false, block_host: false }),
    ).toBe(true);
  });
});

describe("empreinte et étiquette du réseau", () => {
  it("sans protection, l'empreinte ne change pas, cases décochées ou profil fermé coché", () => {
    const nu = netcfgHash(ouvert());
    expect(nu).toMatch(/^[0-9a-f]{12}$/u);
    expect(netcfgHash(ouvert({ block_lan: false }))).toBe(nu);
    const fermes = [
      { id: "a", name: "A", mode: "none", block_host: true },
      { id: "b", name: "B", mode: "allowlist_ip", ips: ["10.0.0.5"], block_host: true },
    ];
    for (const f of fermes) {
      const sans = { ...f, block_host: false };
      expect(netcfgHash(profilReseauDepuis(f, () => undefined))).toBe(
        netcfgHash(profilReseauDepuis(sans, () => undefined)),
      );
    }
  });

  it("cochées, les protections entrent dans l'empreinte, chaque combinaison à part", () => {
    const hashs = [
      ouvert(),
      ouvert({ block_metadata: true }),
      ouvert({ block_lan: true }),
      ouvert({ block_host: true }),
      ouvert({ block_metadata: true, block_host: true }),
      ouvert({ block_metadata: true, block_lan: true, block_host: true }),
    ].map(netcfgHash);
    expect(new Set(hashs).size).toBe(hashs.length);
  });

  it("étiquette : l'empreinte seule sans protection, avec protection suivie de celle des plages refusées", () => {
    const nu = ouvert();
    expect(etiquetteNetcfg(nu, ["10.0.0.0/8"])).toBe(netcfgHash(nu));
    const p = ouvert({ block_host: true });
    const plages = ["192.0.2.7/32", "224.0.0.0/4"];
    expect(etiquetteNetcfg(p, plages)).toBe(`${netcfgHash(p)}-${sha12(plages.join(" "))}`);
    expect(etiquetteNetcfg(p, plages)).toBe(etiquetteNetcfg(p, [...plages]));
    expect(etiquetteNetcfg(p, ["192.0.2.8/32", "224.0.0.0/4"])).not.toBe(etiquetteNetcfg(p, plages));
    expect(etiquetteNetcfg(p, [])).toBe(`${netcfgHash(p)}-${sha12("")}`);
  });
});

describe("domaines épinglés à la création", () => {
  it("étiquette : JSON compact, domaines et adresses triés, domaine sans adresse omis", () => {
    expect(
      etiquetteDomaines({
        "pypi.org": ["192.0.2.9", "192.0.2.10"],
        "a.example": ["198.51.100.1"],
        "vide.test": [],
      }),
    ).toBe('{"a.example":["198.51.100.1"],"pypi.org":["192.0.2.10","192.0.2.9"]}');
    expect(etiquetteDomaines({})).toBe("{}");
  });

  it("lecture : l'étiquette relue donne les adresses ; absente, illisible ou de mauvaise forme : null", () => {
    const e = etiquetteDomaines({ "a.example": ["198.51.100.1", "198.51.100.2"] });
    expect(domainesEpingles(e)).toEqual({ "a.example": ["198.51.100.1", "198.51.100.2"] });
    expect(domainesEpingles("{}")).toEqual({});
    for (const mauvais of [
      "",
      "<no value>",
      "[boum",
      "null",
      "[]",
      '"x"',
      "5",
      '{"a":"b"}',
      '{"a":[1]}',
      '{"a":null}',
    ])
      expect(domainesEpingles(mauvais), mauvais).toBeNull();
  });

  it("périmé seulement si aucune adresse épinglée d'un domaine n'est rendue", () => {
    const epingles = { "a.example": ["198.51.100.1", "198.51.100.2"], "b.example": ["203.0.113.5"] };
    expect(domainesPerimes(epingles, { "a.example": ["198.51.100.2", "198.51.100.9"] })).toEqual([]);
    expect(
      domainesPerimes(epingles, { "a.example": ["198.51.100.9"], "b.example": ["203.0.113.5"] }),
    ).toEqual(["a.example"]);
    expect(
      domainesPerimes(epingles, { "a.example": ["198.51.100.9"], "b.example": ["203.0.113.9"] }),
    ).toEqual(["a.example", "b.example"]);
  });

  it("domaine non épinglé à la création qui se résout à présent : périmé", () => {
    expect(domainesPerimes({}, { "c.example": ["198.51.100.7"] })).toEqual(["c.example"]);
    expect(domainesPerimes({ "c.example": [] }, { "c.example": ["198.51.100.7"] })).toEqual(["c.example"]);
  });

  it("sans réponse (null) ou irrésoluble ([]) : jamais périmé", () => {
    const epingles = { "a.example": ["198.51.100.1"] };
    expect(domainesPerimes(epingles, { "a.example": null, "c.example": null })).toEqual([]);
    expect(domainesPerimes(epingles, { "a.example": [], "c.example": [] })).toEqual([]);
    expect(domainesPerimes({}, {})).toEqual([]);
  });
});

describe("adressesEpinglables : adresses d'un domaine de liste blanche", () => {
  const h: HoteMachine = {
    ...machine(["192.0.2.7", "172.17.0.1"]),
    reseaux: [reseauPy("172.18.0.0/16") as Reseau],
  };

  it("boucle, lien local, non spécifiée, multidiffusion, métadonnées, machine et ses conteneurs : écartées ; LAN et internet : gardés", () => {
    const ecartees = [
      "127.0.0.1",
      "169.254.169.254",
      "0.0.0.0",
      "224.0.0.1",
      "100.100.100.200",
      "168.63.129.16",
      "192.0.2.7",
      "172.17.0.1",
      "172.18.0.5",
    ];
    const gardees = ["10.1.2.3", "192.168.50.4", "198.51.100.1"];
    expect(adressesEpinglables([...ecartees, ...gardees], [], h)).toEqual({ gardees, ecartees });
  });

  it("adresse couverte par les adresses listées du profil : gardée, même locale ; liste non lue ignorée", () => {
    expect(
      adressesEpinglables(["169.254.169.254", "192.0.2.7"], ["169.254.169.254", "192.0.2.0/24"], h),
    ).toEqual({
      gardees: ["169.254.169.254", "192.0.2.7"],
      ecartees: [],
    });
    expect(adressesEpinglables(["127.0.0.1"], [42, null, "pas une adresse"], h).ecartees).toEqual([
      "127.0.0.1",
    ]);
  });

  it("machine illisible : seules les adresses listées sont gardées ; adresse illisible écartée", () => {
    expect(adressesEpinglables(["198.51.100.1", "10.0.0.9"], ["10.0.0.0/24"], null)).toEqual({
      gardees: ["10.0.0.9"],
      ecartees: ["198.51.100.1"],
    });
    expect(adressesEpinglables(["x"], [], h)).toEqual({ gardees: [], ecartees: ["x"] });
  });
});

describe("plagesRefusees", () => {
  const jamais = (): Promise<HoteMachine> => Promise.reject(new Error("machine lue pour rien"));

  it("aucune protection : aucune plage, la machine n'est pas lue", async () => {
    expect(await plagesRefusees([], jamais)).toEqual([]);
  });

  it("métadonnées : lien local et adresses des principaux clouds, triées", async () => {
    const r = await plagesRefusees(["metadata"], jamais);
    expect(r).toEqual([...PLAGES_METADONNEES].sort());
    expect(r).toEqual(expect.arrayContaining(["169.254.0.0/16", "100.100.100.200/32", "168.63.129.16/32"]));
  });

  it("réseau local : privées, partagées, lien local, multidiffusion et réservées", async () => {
    const r = await plagesRefusees(["lan"], jamais);
    expect(r).toEqual([...PLAGES_LOCALES].sort());
    expect(r).toEqual(
      expect.arrayContaining([
        "10.0.0.0/8",
        "172.16.0.0/12",
        "192.168.0.0/16",
        "100.64.0.0/10",
        "240.0.0.0/4",
      ]),
    );
  });

  it("métadonnées et réseau local ensemble : sans doublon", async () => {
    const r = await plagesRefusees(["metadata", "lan"], jamais);
    expect(r.filter((p) => p === "169.254.0.0/16")).toHaveLength(1);
    expect(r).toEqual([...new Set([...PLAGES_METADONNEES, ...PLAGES_LOCALES])].sort());
  });

  it("hôte : adresses IPv4 hors boucle, diffusions des sous-réseaux, diffusion générale et multidiffusion", async () => {
    const r = await plagesRefusees(["host"], async () => MACHINE_A);
    expect(r).toEqual([
      "172.17.0.1/32",
      "192.0.2.255/32",
      "192.0.2.7/32",
      "224.0.0.0/4",
      "255.255.255.255/32",
    ]);
  });

  it("hôte sans relevé de diffusions : les adresses et les diffusions générales seulement", async () => {
    const r = await plagesRefusees(["host"], async () => machine(["10.0.0.5"]));
    expect(r).toEqual(["10.0.0.5/32", "224.0.0.0/4", "255.255.255.255/32"]);
  });

  it("hôte : la boucle (diffusion comprise), l'IPv6 et les diffusions IPv6 ne comptent pas ; aucune IPv4 : erreur", async () => {
    await expect(
      plagesRefusees(["host"], async () => machine(["127.0.0.1", "::1", "2001:db8::7"])),
    ).rejects.toThrow("aucune adresse IPv4 de la machine relevée");
    await expect(plagesRefusees(["host"], async () => machine([]))).rejects.toThrow("aucune adresse IPv4");
    const r = await plagesRefusees(["host"], async () =>
      machine(["10.0.0.5"], ["2001:db8::ffff", "10.0.0.255", "127.255.255.255"]),
    );
    expect(r).toContain("10.0.0.255/32");
    expect(r.some((p) => p.includes(":") || p.startsWith("127."))).toBe(false);
  });

  it("hôte : une erreur de lecture de la machine se propage", async () => {
    await expect(plagesRefusees(["host"], () => Promise.reject(new Error("illisible")))).rejects.toThrow(
      "illisible",
    );
  });

  it("les trois ensemble : union triée par point de code, sans doublon", async () => {
    const r = await plagesRefusees(["metadata", "lan", "host"], async () => MACHINE_A);
    expect(r).toEqual([...r].sort());
    expect(new Set(r).size).toBe(r.length);
    expect(r).toEqual(expect.arrayContaining(["192.0.2.7/32", "10.0.0.0/8", "168.63.129.16/32"]));
  });
});

const PROFILS = [
  { id: "isolated", name: "Isolé", mode: "none" },
  { id: "libre", name: "Libre", mode: "bridge" },
  { id: "garde", name: "Gardé", mode: "bridge", block_metadata: true, block_host: true },
  {
    id: "liste",
    name: "Liste",
    mode: "allowlist_ip",
    ips: ["10.0.0.0/24"],
    domains: ["a.example", "b.example"],
  },
];

describe("docker run et conteneur d'un profil protégé", () => {
  let tmp: string;
  let nettoyer: () => void;
  let restaurer: () => void;
  let travail: string;
  let attente: number;

  beforeEach(() => {
    [tmp, nettoyer] = dossierTemporaire("elpis-bac-protections-");
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

  function bacDe(
    profil: string,
    mach: () => Promise<HoteMachine> = async () => MACHINE_A,
    regles: Regle[] = [],
    executors: Record<string, unknown> = {},
  ) {
    const cli = new FauxCli(regles);
    const cfg = sandboxAdminConfigDepuis({ network_profiles: PROFILS, ...executors }, () => undefined);
    const sb = new UserSandbox(1, "alice", travail, cfg, profil, {
      cli,
      resoudreDomaines: async () => ({ "a.example": ["198.51.100.1"] }),
      machine: mach,
    });
    return { sb, cli };
  }
  const apres = (argv: string[], v: string): string | undefined => argv[argv.indexOf(v) + 1];
  const valeurs = (argv: string[], opt: string): string[] => argv.filter((_, i) => argv[i - 1] === opt);

  /** Règles d'un conteneur en marche créé avec ces plages (`elpis.netcfg` = empreinte et plages). */
  function reglesPour(sb: UserSandbox, plages: string[]): Regle[] {
    const netcfg = `${etiquetteNetcfg(sb.networkProfile, plages)}|${RUN_SPEC}|${sb.cfg.image}|${agentEmpreinte()}|${empreinteDemarrage()}|${sb.durci(sb.networkProfile) ? "1" : "0"}|${sb.utilisateurExec()}\n`;
    return [
      {
        motif: ["container", "inspect"],
        out: `abc|/elpis-sb-alice|true|${sb.cfg.image}|2026-10-10T00:00:00Z\n`,
      },
      { motif: ["~.Mounts"], out: `${travail}\n` },
      { motif: ["~elpis.netcfg"], out: netcfg },
    ];
  }
  const PLAGES_A = [
    "172.17.0.1/32",
    "192.0.2.255/32",
    "192.0.2.7/32",
    "224.0.0.0/4",
    "255.255.255.255/32",
    "169.254.0.0/16",
  ].sort();
  const plagesDe = (sb: UserSandbox, m: HoteMachine): Promise<string[]> =>
    plagesRefusees(protectionsDe(sb.networkProfile), async () => m);

  it("profil ouvert protégé : mode liste de refus, NET_ADMIN, plages, sans sudo, étiquette avec l'empreinte des plages", () => {
    const { sb } = bacDe("garde");
    const refusees = PLAGES_A;
    const argv = sb.buildRunArgs(sb.networkProfile, null, refusees);
    expect(valeurs(argv, "-e")).toEqual(
      expect.arrayContaining(["ELPIS_NET_MODE=blocklist", `ELPIS_BLOCKED=${refusees.join(" ")}`]),
    );
    expect(argv).toContain("NET_ADMIN");
    expect(argv).toContain("--read-only");
    expect(apres(argv, "--security-opt")).toBe("no-new-privileges:true");
    expect(argv).toContain("elpis.durci=1");
    expect(argv).toContain(`elpis.netcfg=${etiquetteNetcfg(sb.networkProfile, refusees)}`);
    expect(argv.some((a) => a.startsWith("ELPIS_ALLOWLIST"))).toBe(false);
    expect(argv.some((a) => a.startsWith("elpis.resolved"))).toBe(false);
    expect(apres(argv, "--network")).toBe("elpis-sandbox");
  });

  it("profil ouvert sans protection : ni mode liste de refus ni durcissement, étiquette = empreinte", () => {
    const { sb } = bacDe("libre");
    const argv = sb.buildRunArgs(sb.networkProfile, null, ["10.0.0.0/8"]);
    expect(argv.some((a) => a.startsWith("ELPIS_NET_MODE") || a.startsWith("ELPIS_BLOCKED"))).toBe(false);
    expect(argv).not.toContain("--read-only");
    expect(argv).toContain("elpis.durci=0");
    expect(argv).toContain(`elpis.netcfg=${netcfgHash(sb.networkProfile)}`);
  });

  it("liste blanche avec domaines : adresses épinglées dans l'étiquette elpis.resolved, mode inchangé", () => {
    const { sb } = bacDe("liste");
    const argv = sb.buildRunArgs(sb.networkProfile, { "a.example": ["198.51.100.1"] });
    expect(argv).toContain("ELPIS_NET_MODE=allowlist");
    expect(argv).toContain('elpis.resolved={"a.example":["198.51.100.1"]}');
    expect(argv).toContain(`elpis.netcfg=${netcfgHash(sb.networkProfile)}`);
    expect(argv.some((a) => a.startsWith("ELPIS_BLOCKED"))).toBe(false);
    const sans = sb.buildRunArgs(sb.networkProfile, null);
    expect(sans).toContain("elpis.resolved={}");
  });

  it("liste blanche sans domaine : pas d'étiquette elpis.resolved", () => {
    const { sb } = bacDe("lan", undefined, [], {
      network_profiles: [{ id: "lan", name: "LAN", mode: "allowlist_ip", ips: ["10.0.0.0/24"] }],
    });
    expect(sb.buildRunArgs(sb.networkProfile, {}).some((a) => a.startsWith("elpis.resolved"))).toBe(false);
  });

  it("création : les plages de la machine sont posées dans le conteneur", async () => {
    const { sb, cli } = bacDe("garde");
    await sb.ensureRunning();
    const run = cli.appels.find((a) => a[0] === "run") as string[];
    expect(run).toBeDefined();
    const bloque = valeurs(run, "-e").find((v) => v.startsWith("ELPIS_BLOCKED=")) ?? "";
    expect(bloque.slice("ELPIS_BLOCKED=".length).split(" ")).toEqual(await plagesDe(sb, MACHINE_A));
    expect(run).toContain(
      `elpis.netcfg=${etiquetteNetcfg(sb.networkProfile, await plagesDe(sb, MACHINE_A))}`,
    );
  });

  it("création en liste blanche : adresses locales, de la machine ou de métadonnées d'un domaine non épinglées, sauf couvertes par la liste", async () => {
    const cli = new FauxCli();
    const cfg = sandboxAdminConfigDepuis({ network_profiles: PROFILS }, () => undefined);
    const sb = new UserSandbox(1, "alice", travail, cfg, "liste", {
      cli,
      resoudreDomaines: async () => ({
        "a.example": ["169.254.169.254", "198.51.100.1", "10.0.0.9"],
        "b.example": ["127.0.0.1", "192.0.2.7"],
      }),
      machine: async () => MACHINE_A,
    });
    await sb.ensureRunning();
    const run = cli.appels.find((a) => a[0] === "run") as string[];
    expect(run).toBeDefined();
    expect(run).toContain('elpis.resolved={"a.example":["10.0.0.9","198.51.100.1"]}');
    const liste = valeurs(run, "-e").find((v) => v.startsWith("ELPIS_ALLOWLIST=")) ?? "";
    expect(liste.split(/[= ]/u)).toEqual(expect.arrayContaining(["198.51.100.1", "10.0.0.9"]));
    for (const x of ["169.254.169.254", "127.0.0.1", "192.0.2.7"]) expect(liste, x).not.toContain(x);
  });

  it("création : machine illisible ou sans IPv4, refus sobre sans conteneur lancé", async () => {
    for (const mach of [
      () => Promise.reject(new Error("/proc illisible : secret-interne")),
      async () => machine(["127.0.0.1"]),
    ]) {
      const { sb, cli } = bacDe("garde", mach);
      const e = await sb.ensureRunning().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ExecError);
      expect((e as Error).message).toBe("La sandbox ne peut pas démarrer. Demandez à votre administrateur.");
      expect(cli.appels.some((a) => a[0] === "run")).toBe(false);
    }
  });

  it("création d'un profil protégé sans hôte (métadonnées seules) : la machine n'est pas lue", async () => {
    const { sb, cli } = bacDe("m", () => Promise.reject(new Error("machine lue pour rien")), [], {
      network_profiles: [{ id: "m", name: "M", mode: "bridge", block_metadata: true }],
    });
    await sb.ensureRunning();
    const run = cli.appels.find((a) => a[0] === "run") as string[];
    expect(valeurs(run, "-e")).toContain(`ELPIS_BLOCKED=${[...PLAGES_METADONNEES].sort().join(" ")}`);
  });

  it("conteneur à jour : plages inchangées", async () => {
    const base = bacDe("garde");
    const plages = await plagesDe(base.sb, MACHINE_A);
    const { sb } = bacDe("garde", async () => MACHINE_A, reglesPour(base.sb, plages));
    expect(await sb.configMatches()).toBe(true);
  });

  it("une adresse nouvelle sur la machine : périmé ; une adresse disparue : gardé, il refuse déjà tout ce qu'il faut ; liste posée illisible : périmé", async () => {
    const base = bacDe("garde");
    const plages = await plagesDe(base.sb, MACHINE_A);
    const env: Regle = { motif: ["~.Config.Env"], out: `PATH=/usr/bin\nELPIS_BLOCKED=${plages.join(" ")}\n` };
    const moins = machine(["127.0.0.1", "192.0.2.7"], ["192.0.2.255"]);
    expect(
      await bacDe("garde", async () => MACHINE_B, [...reglesPour(base.sb, plages), env]).sb.configMatches(),
    ).toBe(false);
    expect(
      await bacDe("garde", async () => moins, [...reglesPour(base.sb, plages), env]).sb.configMatches(),
    ).toBe(true);
    expect(
      await bacDe("garde", async () => moins, [
        ...reglesPour(base.sb, plages),
        { ...env, rc: 1 },
      ]).sb.configMatches(),
    ).toBe(false);
  });

  it("machine illisible : jamais à jour, un conteneur durci est recréé", async () => {
    const base = bacDe("garde");
    const plages = await plagesDe(base.sb, MACHINE_A);
    const { sb } = bacDe("garde", () => Promise.reject(new Error("illisible")), reglesPour(base.sb, plages));
    expect(await sb.configMatches()).toBe(false);
  });

  it("conteneur d'avant la protection (empreinte seule) : périmé ; profil sans protection : étiquette inchangée à jour", async () => {
    const base = bacDe("garde");
    const ancien = reglesPour(base.sb, []).map((r) =>
      r.motif.includes("~elpis.netcfg")
        ? { ...r, out: (r.out ?? "").replace(/^[^|]*/u, netcfgHash(base.sb.networkProfile)) }
        : r,
    );
    expect(await bacDe("garde", undefined, ancien).sb.configMatches()).toBe(false);
    const libre = bacDe("libre");
    const reglesLibre = reglesPour(libre.sb, []);
    expect(
      await bacDe("libre", () => Promise.reject(new Error("pas lue")), reglesLibre).sb.configMatches(),
    ).toBe(true);
  });

  it("en marche et vérifié : une adresse de la machine qui change fait tout revérifier au prochain usage", async () => {
    let courante = MACHINE_A;
    const base = bacDe("garde");
    const plages = await plagesDe(base.sb, MACHINE_A);
    const { sb, cli } = bacDe("garde", async () => courante, [
      ...reglesPour(base.sb, plages),
      { motif: ["~HostConfig.Privileged"], out: 'false\n["NET_ADMIN"]\n["no-new-privileges:true"]\n' },
    ]);
    const lectures = (): number => cli.appels.filter((a) => a.join(" ").includes("elpis.netcfg")).length;
    await sb.ensureRunning();
    const avant = lectures();
    expect(avant).toBeGreaterThan(0);
    await sb.ensureRunning();
    expect(lectures()).toBe(avant);
    courante = MACHINE_B;
    await sb.ensureRunning().catch(() => undefined);
    expect(lectures()).toBeGreaterThan(avant);
  });
});
