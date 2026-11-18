// SPDX-License-Identifier: MIT
/** packages/bac/test/durcissement.test.ts — durcissement du bac : PATH du conteneur et des étapes root, entrée directe du compte, profil filtré, aucun retrait de privilèges par `setpriv`. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { surchargerConfig } from "@elpis/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as bac from "../src/index";
import {
  agentEmpreinte,
  arreterBacsPerimes,
  balayerPartsOrphelines,
  definirFabriqueAgent,
  ExecError,
  MONTAGES_NAVIGATEUR,
  netcfgHash,
  PATH_COMPTE,
  reglagesBac,
  reglagesMontages,
  reglagesNavigateurBac,
  RUN_SPEC,
  sandboxAdminConfigDepuis,
  UserSandbox,
} from "../src/index";
import {
  ENTREE_ROOT,
  entreePermise,
  FORMAT_ENTREE,
  lireEntree,
  PATH_SYSTEME,
  profilFiltre,
} from "../src/durcissement";
import { dossierTemporaire, FauxCli } from "./aides";
import type { Regle } from "./aides";
import type { EtatBac, ImageLoadState } from "../src/index";

const PROFILS = [
  { id: "isolated", name: "Isolé", mode: "none", ips: [] },
  { id: "open", name: "Ouvert", mode: "bridge" },
  { id: "lan", name: "LAN", mode: "allowlist_ip", ips: ["10.0.0.0/24"] },
];
const SYSTEME = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const ROOT = ["-u", "0:0", "-e", `PATH=${SYSTEME}`, "-w", "/"];
const CONTENEUR = "elpis-sb-alice";

let tmp: string;
let nettoyer: () => void;
let restaurer: () => void;
let travail: string;
let attente: number;

beforeAll(() => {
  reglagesMontages.agentDir = "/opt/app/shared_infra/sandbox/agent";
  reglagesNavigateurBac.playwright = "/nonexistent/ms-playwright";
});

afterAll(() => {
  reglagesMontages.agentDir = null;
  reglagesNavigateurBac.playwright = null;
});

beforeEach(() => {
  [tmp, nettoyer] = dossierTemporaire("elpis-bac-dur-");
  travail = path.join(tmp, "sb", "alice", "work");
  mkdirSync(travail, { recursive: true });
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
  restaurer();
  vi.unstubAllEnvs();
  nettoyer();
});

function bacDe(profil: string | null, executors: Record<string, unknown> = {}, regles: Regle[] = []) {
  const cli = new FauxCli(regles);
  const cfg = sandboxAdminConfigDepuis({ network_profiles: PROFILS, ...executors }, () => undefined);
  const sb = new UserSandbox(1, "alice", travail, cfg, profil, { cli, resoudreDomaines: async () => ({}) });
  return { sb, cli };
}

/** Règles d'un conteneur en marche, monté sur `travail`, à jour pour le profil de `sb`. */
function reglesAJour(sb: UserSandbox, extra: Regle[] = []): Regle[] {
  const netcfg = `${netcfgHash(sb.networkProfile)}|${RUN_SPEC}|${sb.cfg.image}|${agentEmpreinte()}\n`;
  return [
    {
      motif: ["container", "inspect"],
      out: `abc123|/${CONTENEUR}|true|${sb.cfg.image}|2026-10-10T00:00:00Z\n`,
    },
    { motif: ["~.Mounts"], out: `${travail}\n` },
    { motif: ["~elpis.netcfg"], out: netcfg },
    ...extra,
  ];
}

function bacEnMarche(profil: string | null, executors: Record<string, unknown> = {}, extra: Regle[] = []) {
  const sansRegle = bacDe(profil, executors);
  return bacDe(profil, executors, reglesAJour(sansRegle.sb, extra));
}

const pos = (a: readonly unknown[], v: string): number => a.indexOf(v);

describe("constantes", () => {
  it("PATH du système sans dossier de /work, PATH du compte et entrée root", () => {
    expect(PATH_SYSTEME).toBe(SYSTEME);
    expect(PATH_COMPTE).toBe(`/work/.python-user/bin:/work/.local/bin:/work/.npm-global/bin:${SYSTEME}`);
    expect(ENTREE_ROOT).toEqual(ROOT);
    expect(PATH_SYSTEME).not.toContain("/work");
  });

  it("profil filtré : liste blanche IP seule", () => {
    expect(["none", "bridge", "allowlist_ip"].map((mode) => profilFiltre({ mode: mode as never }))).toEqual([
      false,
      false,
      true,
    ]);
  });

  it("plus d'export privdrop", () => {
    expect("privdrop" in bac).toBe(false);
  });

  it("version des options de lancement : 7", () => {
    expect(RUN_SPEC).toBe("7");
  });
});

describe("docker run", () => {
  it.each(["isolated", "open", "lan"])(
    "profil %s : --no-healthcheck, PATH du système, jamais /work",
    (profil) => {
      const { sb } = bacDe(profil);
      const argv = sb.buildRunArgs(sb.networkProfile, {});
      expect(argv[pos(argv, "--init") + 1]).toBe("--no-healthcheck");
      const i = argv.findIndex((a, k) => a === "-e" && argv[k + 1]?.startsWith("PATH="));
      expect(argv[i + 1]).toBe(`PATH=${SYSTEME}`);
      expect(argv[i + 2]).toBe("-e");
      expect(argv[i + 3]).toBe("HOME=/work");
      expect(argv.filter((a) => a.startsWith("PATH="))).toEqual([`PATH=${SYSTEME}`]);
      expect(argv.find((a) => a.startsWith("PATH="))).not.toContain("/work");
      expect(argv).toContain("elpis.spec=7");
    },
  );

  it.each([
    ["isolated", "false"],
    ["open", "false"],
    ["lan", "true"],
  ])("profil %s : no-new-privileges:%s", (profil, valeur) => {
    const { sb } = bacDe(profil);
    const argv = sb.buildRunArgs(sb.networkProfile, {});
    expect(argv[pos(argv, "--security-opt") + 1]).toBe(`no-new-privileges:${valeur}`);
    expect(argv.filter((a) => a.startsWith("no-new-privileges"))).toHaveLength(1);
  });
});

describe("exec : entrée directe sous l'UID du compte", () => {
  it("--user 10001:10001, ni setpriv ni 0:0, PATH du compte par défaut", async () => {
    const { sb, cli } = bacEnMarche(null);
    await sb.exec(["echo", "hi"]);
    const argv = cli.lances[0] as string[];
    expect(argv.slice(1, 5)).toEqual(["exec", "--user", "10001:10001", "--workdir"]);
    expect(argv).not.toContain("setpriv");
    expect(argv).not.toContain("0:0");
    expect(argv.filter((a) => a.startsWith("PATH="))).toEqual([`PATH=${PATH_COMPTE}`]);
    expect(argv[pos(argv, CONTENEUR) + 1]).toBe("sh");
    expect(JSON.stringify(cli.appels)).not.toContain("setpriv");
  });

  it("PATH de l'appelant gardé tel quel, avant les valeurs GIT_CONFIG par défaut", async () => {
    const { sb, cli } = bacEnMarche(null);
    await sb.exec(["env"], { env: { B: "2", PATH: "/work/x/bin:/usr/bin" } });
    const argv = cli.lances[0] as string[];
    expect(argv.filter((a) => a.startsWith("PATH="))).toEqual(["PATH=/work/x/bin:/usr/bin"]);
    const env = argv.slice(pos(argv, "--workdir") + 2, pos(argv, CONTENEUR));
    expect(env).toEqual([
      "-e",
      "B=2",
      "-e",
      "PATH=/work/x/bin:/usr/bin",
      "-e",
      "GIT_CONFIG_COUNT=1",
      "-e",
      "GIT_CONFIG_KEY_0=safe.directory",
      "-e",
      "GIT_CONFIG_VALUE_0=*",
    ]);
  });

  it("exec_user du compte repris tel quel", async () => {
    const { sb, cli } = bacEnMarche(null, { exec_user: "2000:3000" });
    await sb.exec(["id"]);
    expect((cli.lances[0] as string[]).slice(2, 4)).toEqual(["--user", "2000:3000"]);
  });

  it("tuerExec (abandon) sous l'UID du compte, sans étape root", async () => {
    const { sb, cli } = bacEnMarche(null);
    const stop = new AbortController();
    const base = cli.lancer.bind(cli);
    // Processus qui ne finit qu'une fois tué : l'abandon passe par tuerExec.
    cli.lancer = (args, o) => {
      base(args, o);
      let fin: (rc: number) => void = () => undefined;
      return {
        stdin: null,
        stdout: Readable.from([]),
        stderr: Readable.from([]),
        fin: new Promise<number>((ok) => (fin = ok)),
        tuer: () => fin(-9),
      };
    };
    const p = sb.exec(["sleep", "9"], { signal: stop.signal });
    await vi.waitFor(() => expect(cli.lances).toHaveLength(1));
    stop.abort(new Error("annulé"));
    await p.catch(() => undefined);
    const tuer = cli.appels.find((a) => a.includes("tuer-exec")) as string[];
    expect(tuer.slice(0, 3)).toEqual(["exec", "--user", "10001:10001"]);
    expect(tuer).not.toContain("setpriv");
  });

  it("profil filtré avec recréation reportée : ExecError ; profil sans réseau : la commande part", async () => {
    const lan = bacEnMarche("lan");
    lan.sb.recreationReportee = "Recréation reportée";
    lan.sb.configVerified = true;
    await expect(lan.sb.exec(["id"])).rejects.toThrow(ExecError);
    await expect(lan.sb.exec(["id"])).rejects.toThrow("Recréation reportée");
    expect(lan.cli.lances).toEqual([]);

    const aucun = bacEnMarche("isolated");
    aucun.sb.recreationReportee = "Recréation reportée";
    aucun.sb.configVerified = true;
    const r = await aucun.sb.exec(["id"]);
    expect(r.returncode).toBe(0);
    expect(aucun.cli.lances).toHaveLength(1);
  });
});

describe("agent et navigateur : sous exec_user, PATH du compte", () => {
  it("startAgent", async () => {
    const { sb, cli } = bacDe(null);
    await sb.startAgent();
    const argv = cli.appels.at(-1) as unknown[];
    expect(argv.slice(0, 6)).toEqual(["exec", "-d", "--user", "10001:10001", "-e", `PATH=${PATH_COMPTE}`]);
    expect(argv[6]).toBe(CONTENEUR);
    expect(argv[7]).toBe("python3");
    expect(JSON.stringify(argv)).not.toContain("setpriv");
  });

  it("startNavigateur", async () => {
    const { sb, cli } = bacDe(null);
    await sb.startNavigateur({ A: "1" });
    const argv = cli.appels.at(-1) as unknown[];
    expect(argv.slice(0, 6)).toEqual(["exec", "-d", "--user", "10001:10001", "-e", `PATH=${PATH_COMPTE}`]);
    expect(argv[6]).toBe("--env-file");
    expect(JSON.stringify(argv)).not.toContain("setpriv");
  });
});

describe("étapes root de l'hôte : exec -u 0:0 -e PATH=<système> -w /", () => {
  it("droits de /work (réconciliation au démarrage)", async () => {
    const { sb, cli } = bacEnMarche(null);
    await sb.ensureRunning();
    const etape = cli.appels.find((a) => a.includes("sh") && a.includes("--")) as unknown[];
    expect(etape.slice(0, 9)).toEqual(["exec", ...ROOT, CONTENEUR, "sh"]);
    expect(etape.slice(-4, -1)).toEqual(["--", "10001:10001", "1"]);
  });

  it("purge : pkill puis find", async () => {
    const { sb, cli } = bacEnMarche(null);
    await sb.purge();
    const pkill = cli.appels.find((a) => a.includes("pkill")) as unknown[];
    const find = cli.appels.find((a) => a.includes("find")) as unknown[];
    expect(pkill.slice(0, 12)).toEqual(["exec", ...ROOT, CONTENEUR, "pkill", "-KILL", "-U", "10001"]);
    expect(find.slice(0, 9)).toEqual(["exec", ...ROOT, CONTENEUR, "find"]);
    expect(find).toContain("-delete");
  });

  it("agent remplacé : pkill de l'ancien serveur, puis lancement sous le compte", async () => {
    const { sb, cli } = bacDe(null);
    await sb.startAgent(true);
    const pkill = cli.appels.find((a) => a.includes("pkill")) as unknown[];
    expect(pkill.slice(0, 8)).toEqual(["exec", ...ROOT, CONTENEUR]);
    expect(pkill.slice(8, 11)).toEqual(["pkill", "-KILL", "-f"]);
    const lance = cli.appels.find((a) => a[1] === "-d") as unknown[];
    expect(lance.slice(0, 4)).toEqual(["exec", "-d", "--user", "10001:10001"]);
  });

  it("arrêt du navigateur", async () => {
    const { sb, cli } = bacDe(null);
    await sb.stopNavigateur();
    const pkill = cli.appels.find((a) => a.includes("pkill")) as unknown[];
    expect(pkill.slice(0, 11)).toEqual(["exec", ...ROOT, CONTENEUR, "pkill", "-TERM", "-f"]);
    expect(pkill[11]).toBe(MONTAGES_NAVIGATEUR.bundle);
  });

  it("balayage des parts orphelines", async () => {
    const bin = path.join(tmp, "bin");
    mkdirSync(bin);
    const journal = path.join(tmp, "appels");
    writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/sh\necho "$@" >> "${journal}"\ncase "$1" in\n  ps) echo ${CONTENEUR} ;;\n  inspect) echo "/${CONTENEUR}|${travail}" ;;\nesac\n`,
    );
    chmodSync(path.join(bin, "docker"), 0o755);
    vi.stubEnv("PATH", bin);
    await balayerPartsOrphelines(undefined, path.join(tmp, "sb"));
    const exec = readFileSync(journal, "utf8")
      .split("\n")
      .find((l) => l.startsWith("exec"));
    expect(exec).toContain(`exec ${ROOT.join(" ")} ${CONTENEUR} find /work`);
  });
});

describe("configMatches : inspection en échec", () => {
  const echec: Regle[] = [{ motif: ["~elpis.netcfg"], rc: 1 }];

  it("profil filtré : faux (le conteneur est recréé)", async () => {
    const { sb } = bacDe("lan", {}, echec);
    expect(await sb.configMatches()).toBe(false);
  });

  it.each(["isolated", "open"])("profil %s : vrai (incertitude)", async (profil) => {
    const { sb } = bacDe(profil, {}, echec);
    expect(await sb.configMatches()).toBe(true);
  });
});

const A_RELANCER = "La sandbox doit être relancée. Si le problème persiste, demandez à votre administrateur.";
const SANS = 'false\nnull\n["no-new-privileges:false"]\n';
const NET_SANS_GAIN = 'false\n["NET_ADMIN"]\n["no-new-privileges:false"]\n';
const NET_AVEC_GAIN = 'false\n["NET_ADMIN"]\n["no-new-privileges:true"]\n';

describe("lireEntree et entreePermise", () => {
  it.each([
    ["aucune capacité", "false\nnull\nnull", { reseau: false, sansGain: false }],
    [
      "NET_ADMIN, :true",
      'false\n["NET_ADMIN"]\n["no-new-privileges:true"]',
      { reseau: true, sansGain: true },
    ],
    ["NET_ADMIN, nue", 'false\n["NET_ADMIN"]\n["no-new-privileges"]', { reseau: true, sansGain: true }],
    [
      "NET_ADMIN, =true",
      'false\n["NET_ADMIN"]\n["no-new-privileges=true"]',
      { reseau: true, sansGain: true },
    ],
    [
      "NET_ADMIN, :false",
      'false\n["NET_ADMIN"]\n["no-new-privileges:false"]',
      { reseau: true, sansGain: false },
    ],
    ["NET_ADMIN, sans option", 'false\n["NET_ADMIN"]\nnull', { reseau: true, sansGain: false }],
    [
      "la dernière option l'emporte (refus)",
      'false\n["NET_ADMIN"]\n["no-new-privileges:true","no-new-privileges:false"]',
      { reseau: true, sansGain: false },
    ],
    [
      "la dernière option l'emporte (accord)",
      'false\n["NET_ADMIN"]\n["no-new-privileges:false","no-new-privileges:true"]',
      { reseau: true, sansGain: true },
    ],
    ["CAP_NET_ADMIN", 'false\n["cap_net_admin"]\n[]', { reseau: true, sansGain: false }],
    ["ALL", 'false\n["ALL"]\n[]', { reseau: true, sansGain: false }],
    ["privilégié", 'true\nnull\n["no-new-privileges:true"]', { reseau: true, sansGain: true }],
    [
      "autre capacité",
      'false\n["CHOWN","NET_BIND_SERVICE"]\n["seccomp=x"]',
      { reseau: false, sansGain: false },
    ],
  ])("%s", (_nom, sortie, attendu) => {
    expect(lireEntree(sortie)).toEqual(attendu);
  });

  it.each([
    ["vide", ""],
    ["deux lignes", "false\nnull"],
    ["quatre lignes", "false\nnull\nnull\nnull"],
    ["pas du JSON", "false\nnull\n[boum"],
    ["première ligne non booléenne", '"false"\nnull\nnull'],
  ])("illisible (%s) : null, entrée refusée", (_nom, sortie) => {
    expect(lireEntree(sortie)).toBeNull();
    expect(entreePermise(sortie, "10001:10001")).toBe(false);
    expect(entreePermise(sortie, null)).toBe(false);
  });

  it("exec_user sur un conteneur au réseau modifiable : UID numérique non nul seulement", () => {
    const filtre = NET_AVEC_GAIN;
    const verdicts = ["10001:10001", "0:0", "root:root", "00:1", ":1", "10001", "1:1", "0010:5"].map((u) =>
      entreePermise(filtre, u),
    );
    expect(verdicts).toEqual([true, false, false, false, false, false, true, true]);
  });

  it("conteneur sans réseau modifiable : tous les exec_user passent", () => {
    for (const u of ["10001:10001", "0:0", "root:root", ":1"]) expect(entreePermise(SANS, u)).toBe(true);
  });

  it("étape root de l'hôte (exec_user null) : exige no-new-privileges si le réseau est modifiable", () => {
    expect([
      entreePermise(NET_AVEC_GAIN, null),
      entreePermise(NET_SANS_GAIN, null),
      entreePermise(SANS, null),
    ]).toEqual([true, false, true]);
  });
});

describe("garde de l'entrée du conteneur", () => {
  const inspections = (cli: FauxCli): unknown[][] => cli.appels.filter((a) => a.includes(FORMAT_ENTREE));
  const racines = (cli: FauxCli): unknown[][] => cli.appels.filter((a) => a[0] === "exec" && a[1] === "-u");

  function bacRefuse(entree: string, executors: Record<string, unknown> = {}) {
    const r = bacEnMarche("lan", executors);
    r.cli.entree = [0, Buffer.from(entree), Buffer.alloc(0)];
    return r;
  }

  it("startAgent, startNavigateur, exec, purge : refus, aucun exec n'atteint docker", async () => {
    for (const appel of [
      (sb: UserSandbox) => sb.startAgent(),
      (sb: UserSandbox) => sb.startAgent(true),
      (sb: UserSandbox) => sb.startNavigateur({ A: "1" }),
      (sb: UserSandbox) => sb.exec(["id"]),
      (sb: UserSandbox) => sb.purge(),
    ]) {
      const { sb, cli } = bacRefuse(NET_SANS_GAIN);
      await expect(appel(sb)).rejects.toThrow(A_RELANCER);
      await expect(appel(sb)).rejects.toBeInstanceOf(ExecError);
      expect(cli.appels.filter((a) => a[0] === "exec")).toEqual([]);
      expect(cli.lances).toEqual([]);
    }
  });

  it("stopNavigateur : retour silencieux, aucun pkill", async () => {
    const { sb, cli } = bacRefuse(NET_SANS_GAIN);
    await expect(sb.stopNavigateur()).resolves.toBeUndefined();
    expect(cli.appels.filter((a) => a.includes("pkill"))).toEqual([]);
  });

  it("réconciliation des droits : refus journalisé, le sh root ne part pas", async () => {
    const { sb, cli } = bacRefuse(NET_SANS_GAIN);
    await sb.ensureRunning();
    expect(racines(cli)).toEqual([]);
    expect(inspections(cli)).toHaveLength(1);
  });

  it("inspection en échec ou illisible : refus", async () => {
    const { sb, cli } = bacEnMarche("isolated");
    cli.entree = [1, Buffer.alloc(0), Buffer.from("boum")];
    await expect(sb.exec(["id"])).rejects.toThrow(A_RELANCER);
    cli.entree = [0, Buffer.alloc(0), Buffer.alloc(0)];
    await expect(sb.exec(["id"])).rejects.toThrow(A_RELANCER);
  });

  it("verdict demandé une fois pour deux exec, puis de nouveau après stop() et destroy()", async () => {
    const { sb, cli } = bacEnMarche("isolated");
    await sb.exec(["id"]);
    await sb.exec(["id"]);
    // une fois pour l'étape root (droits), une fois pour le compte
    expect(inspections(cli)).toHaveLength(2);
    await sb.stop();
    await sb.exec(["id"]);
    expect(inspections(cli)).toHaveLength(3);
    await sb.destroy();
    await sb.exec(["id"]);
    expect(inspections(cli)).toHaveLength(4);
  });

  it("exec_user 0:0 et root:root : refusés avec no-new-privileges:true, acceptés sans NET_ADMIN", async () => {
    for (const u of ["0:0", "root:root"]) {
      const net = bacEnMarche("lan", { exec_user: u });
      net.cli.entree = [0, Buffer.from(NET_AVEC_GAIN), Buffer.alloc(0)];
      await expect(net.sb.exec(["id"])).rejects.toThrow(A_RELANCER);
      const libre = bacEnMarche("isolated", { exec_user: u });
      libre.cli.entree = [0, Buffer.from(SANS), Buffer.alloc(0)];
      expect((await libre.sb.exec(["id"])).returncode).toBe(0);
    }
  });

  describe("recréation reportée (image absente)", () => {
    const stale: Regle[] = [
      { motif: ["~ExitCode"], out: "0|false" },
      { motif: ["~elpis.netcfg"], out: "x|5|elpis/sandbox:1.6.0" },
      { motif: ["image", "inspect"], rc: 1 },
    ];
    function bacPerime(profil: string) {
      const cli = new FauxCli(stale);
      const cfg = sandboxAdminConfigDepuis({ network_profiles: PROFILS }, () => undefined);
      const sb = new UserSandbox(1, "alice", travail, cfg, profil, {
        cli,
        resoudreDomaines: async () => ({}),
        chargerImage: async (image: string): Promise<ImageLoadState> => ({
          status: "not_found",
          image,
          started_at: null,
          finished_at: null,
          archive_path: null,
          error: "archive introuvable",
          progress_msg: "x",
        }),
      });
      return { sb, cli };
    }
    const arrete: EtatBac = { exists: true, running: false, container_name: CONTENEUR } as EtatBac;

    it("profil filtré : refus avec le texte de la recréation reportée, jamais de docker start", async () => {
      const { sb, cli } = bacPerime("lan");
      await expect(sb.ensureRunningLocked(arrete)).rejects.toThrow("absente");
      expect(sb.recreationReportee).toContain("absente");
      expect(cli.appels.filter((a) => a[0] === "start")).toEqual([]);
    });

    it.each(["isolated", "open"])("profil %s : le conteneur démarre comme avant", async (profil) => {
      const { sb, cli } = bacPerime(profil);
      await sb.ensureRunningLocked(arrete);
      expect(cli.appels.filter((a) => a[0] === "start")).toHaveLength(1);
    });

    it("ensureRunning d'un conteneur en marche périmé : refus sur profil filtré, avant les droits", async () => {
      const { sb, cli } = bacPerime("lan");
      cli.entree = [0, Buffer.from(NET_AVEC_GAIN), Buffer.alloc(0)];
      const regles: Regle[] = [
        { motif: ["container", "inspect"], out: `abc|/${CONTENEUR}|true|elpis/sandbox:1.6.0|d\n` },
        { motif: ["~.Mounts"], out: `${travail}\n` },
        ...stale,
      ];
      const r = new FauxCli(regles);
      const cfg = sandboxAdminConfigDepuis({ network_profiles: PROFILS }, () => undefined);
      const sb2 = new UserSandbox(1, "alice", travail, cfg, "lan", {
        cli: r,
        resoudreDomaines: async () => ({}),
        chargerImage: async (image: string): Promise<ImageLoadState> => ({
          status: "not_found",
          image,
          started_at: null,
          finished_at: null,
          archive_path: null,
          error: "x",
          progress_msg: "x",
        }),
      });
      await expect(sb2.ensureRunning()).rejects.toThrow("absente");
      expect(racines(r)).toEqual([]);
      expect(sb).toBeDefined();
    });
  });
});

describe("arreterBacsPerimes et balayage : docker simulé", () => {
  /** Faux `docker` : ps rend `ps`, inspect de l'entrée rend la réponse du conteneur, stop est noté. */
  function fauxDocker(opts: {
    ps: string;
    montages: string;
    entrees: Record<string, string>;
    psRc?: number;
  }): { journal: string } {
    const bin = path.join(tmp, "bin");
    mkdirSync(bin, { recursive: true });
    const journal = path.join(tmp, "appels");
    writeFileSync(path.join(tmp, "ps.out"), opts.ps);
    writeFileSync(path.join(tmp, "montages.out"), opts.montages);
    let cas = "";
    for (const [nom, rep] of Object.entries(opts.entrees)) {
      writeFileSync(path.join(tmp, `entree-${nom}`), rep);
      cas += `    *${nom}) cat "${path.join(tmp, `entree-${nom}`)}" ;;\n`;
    }
    writeFileSync(
      path.join(bin, "docker"),
      `#!/bin/sh
cat() { while IFS= read -r l || [ -n "$l" ]; do printf '%s\\n' "$l"; done < "$1"; }
echo "$@" >> "${journal}"
case "$1" in
  ps) cat "${path.join(tmp, "ps.out")}"; exit ${opts.psRc ?? 0} ;;
  inspect) case "$*" in
    *HostConfig.Privileged*) case "$*" in
${cas}      *) exit 1 ;; esac ;;
    *) cat "${path.join(tmp, "montages.out")}" ;;
  esac ;;
  stop) exit 0 ;;
esac
`,
    );
    chmodSync(path.join(bin, "docker"), 0o755);
    vi.stubEnv("PATH", bin);
    return { journal };
  }
  const bacs = (): string => path.join(tmp, "sb");
  const lignes = (journal: string): string[] => readFileSync(journal, "utf8").split("\n").filter(Boolean);

  it("arrête seulement : spec périmée ET de cette instance ET (illisible OU réseau modifiable sans gain)", async () => {
    const { journal } = fauxDocker({
      ps:
        `elpis-sb-vieux1\t6\nelpis-sb-vieux2\t\nelpis-sb-vieux3\t5\nelpis-sb-vieux4\t6\n` +
        `elpis-sb-vieux5\t6\nelpis-sb-neuf\t7\nelpis-sb-autre\t6\n`,
      montages: ["vieux1", "vieux2", "vieux3", "vieux4", "vieux5", "neuf"]
        .map((n) => `/elpis-sb-${n}|${bacs()}/${n}/work`)
        .concat([`/elpis-sb-autre|/srv/autre/bacs/a/work`])
        .join("\n"),
      entrees: {
        vieux1: NET_SANS_GAIN, // arrêté : réseau sans gain
        vieux2: "", // arrêté : illisible
        vieux3: NET_AVEC_GAIN, // gardé : no-new-privileges
        vieux4: SANS, // gardé : pas de NET_ADMIN
        vieux5: "pas du json", // arrêté : illisible
        neuf: NET_SANS_GAIN,
        autre: NET_SANS_GAIN,
      },
    });
    const arretes = await arreterBacsPerimes(bacs());
    expect(arretes.sort()).toEqual(["elpis-sb-vieux1", "elpis-sb-vieux2", "elpis-sb-vieux5"]);
    const l = lignes(journal);
    expect(l.filter((x) => x.startsWith("stop")).sort()).toEqual([
      "stop -t 5 elpis-sb-vieux1",
      "stop -t 5 elpis-sb-vieux2",
      "stop -t 5 elpis-sb-vieux5",
    ]);
    expect(l.some((x) => x.includes("neuf") && x.includes("HostConfig"))).toBe(false);
    expect(l.some((x) => x.includes("autre") && x.includes("HostConfig"))).toBe(false);
  });

  it("docker absent ou ps en échec : liste vide", async () => {
    vi.stubEnv("PATH", path.join(tmp, "vide"));
    expect(await arreterBacsPerimes(bacs())).toEqual([]);
    fauxDocker({ ps: "elpis-sb-a\t6\n", montages: "", entrees: {}, psRc: 1 });
    expect(await arreterBacsPerimes(bacs())).toEqual([]);
  });

  it("balayage des parts orphelines : ps filtré sur la spec courante", async () => {
    const { journal } = fauxDocker({ ps: "", montages: "", entrees: {} });
    await balayerPartsOrphelines(undefined, bacs());
    expect(lignes(journal)[0]).toBe(
      `ps --filter label=elpis.user_id --filter label=elpis.spec=${RUN_SPEC} --format {{.Names}}`,
    );
  });
});
