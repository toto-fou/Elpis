// SPDX-License-Identifier: MIT
/** packages/bac/test/durcissement.test.ts — durcissement du bac : PATH du conteneur et des étapes root, entrée directe du compte, profil filtré, aucun retrait de privilèges par `setpriv`. */
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";

import { surchargerConfig } from "@elpis/config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as bac from "../src/index";
import {
  agentEmpreinte,
  CAPABILITIES,
  arreterBacsPerimes,
  balayerPartsOrphelines,
  definirFabriqueAgent,
  ExecError,
  MONTAGES_NAVIGATEUR,
  netcfgHash,
  configBacDepuis,
  profilReseauDepuis,
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
  utilisateurDurci,
} from "../src/durcissement";
import { empreinteDemarrage, SCRIPT_DEMARRAGE } from "../src/montages";
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
  const netcfg = `${netcfgHash(sb.networkProfile)}|${RUN_SPEC}|${sb.cfg.image}|${agentEmpreinte()}|${empreinteDemarrage()}|${sb.durci(sb.networkProfile) ? "1" : "0"}\n`;
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

  it("version des options de lancement : 11", () => {
    expect(RUN_SPEC).toBe("11");
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
      expect(argv).toContain(`elpis.spec=${RUN_SPEC}`);
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

describe("docker run : mémoire, vidage mémoire et journal bornés", () => {
  it.each(["isolated", "open", "lan"])(
    "profil %s : swap = mémoire, aucun core dump, journal json-file de 2 x 1 Mo",
    (profil) => {
      const { sb } = bacDe(profil);
      const argv = sb.buildRunArgs(sb.networkProfile, {});
      const apres = (v: string, n = 1): string | undefined => argv[argv.indexOf(v) + n];
      expect(apres("--memory")).toBe(`${sb.cfg.memory_mb}m`);
      expect(apres("--memory-swap")).toBe(apres("--memory"));
      expect(apres("--ulimit")).toBe("core=0:0");
      expect(argv.slice(argv.indexOf("--log-driver"), argv.indexOf("--log-driver") + 6)).toEqual([
        "--log-driver",
        "json-file",
        "--log-opt",
        "max-size=1m",
        "--log-opt",
        "max-file=2",
      ]);
    },
  );

  it("la limite du réglage suit : --memory-swap reprend memory_mb", () => {
    const cfg = sandboxAdminConfigDepuis({ limits: { memory_mb: 512 } }, () => undefined);
    const sb = new UserSandbox(1, "alice", travail, cfg, null, { cli: new FauxCli() });
    const argv = sb.buildRunArgs(sb.networkProfile, {});
    expect(argv.slice(argv.indexOf("--memory"), argv.indexOf("--memory") + 4)).toEqual([
      "--memory",
      "512m",
      "--memory-swap",
      "512m",
    ]);
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

  it("exec_user 0:0 et root:root : l'utilisateur de l'image dans un conteneur durci, tels quels sinon", async () => {
    const utilisateur = (lances: readonly (readonly string[])[]): string | undefined => {
      const a = lances.find((x) => x[1] === "exec" && x.includes("id"));
      return a?.[a.indexOf("--user") + 1];
    };
    for (const u of ["0:0", "root:root"]) {
      const net = bacEnMarche("lan", { exec_user: u });
      net.cli.entree = [0, Buffer.from(NET_AVEC_GAIN), Buffer.alloc(0)];
      expect((await net.sb.exec(["id"])).returncode).toBe(0);
      expect(utilisateur(net.cli.lances)).toBe("10001:10001");
      const libre = bacEnMarche("isolated", { exec_user: u });
      libre.cli.entree = [0, Buffer.from(SANS), Buffer.alloc(0)];
      expect((await libre.sb.exec(["id"])).returncode).toBe(0);
      expect(utilisateur(libre.cli.lances)).toBe(u);
    }
  });

  it("utilisateur d'un conteneur durci : un UID ordinaire gardé, root ou un nom remplacés par celui de l'image", () => {
    expect(["10002:10002", "0:0", "00:0", "root:root", "1000"].map(utilisateurDurci)).toEqual([
      "10002:10002",
      "10001:10001",
      "10001:10001",
      "10001:10001",
      "10001:10001",
    ]);
  });

  it("inspection des options illisible : conteneur durci recréé, ouvert gardé mais relu plus tard", async () => {
    const regles: Regle[] = [
      { motif: ["~ExitCode"], out: "0|false" },
      { motif: ["~elpis.netcfg"], rc: 1, err: "délai" },
    ];
    for (const [profil, recree] of [
      ["lan", true],
      ["isolated", false],
    ] as const) {
      const cli = new FauxCli(regles);
      const cfg = sandboxAdminConfigDepuis({ network_profiles: PROFILS }, () => undefined);
      const sb = new UserSandbox(1, "alice", travail, cfg, profil, {
        cli,
        resoudreDomaines: async () => ({}),
      });
      expect(await sb.configMatches(), profil).toBe(!recree);
      if (!recree) {
        await sb.ensureRunning().catch(() => undefined);
        expect(sb.configVerified, profil).toBe(false);
      }
    }
  });

  it("profil changé : options relues et entrées revérifiées au prochain usage", () => {
    const sb = bacEnMarche("isolated").sb;
    sb.configVerified = true;
    sb.oublierVerifications();
    expect([sb.configVerified, sb.configRetryAt]).toEqual([false, 0]);
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

  it("arrête seulement : spec périmée ET de cette instance, sans rien inspecter", async () => {
    const { journal } = fauxDocker({
      ps:
        `elpis-sb-vieux1\t6\nelpis-sb-vieux2\t\nelpis-sb-vieux3\t5\nelpis-sb-vieux4\t6\n` +
        `elpis-sb-vieux5\t6\nelpis-sb-neuf\t${RUN_SPEC}\nelpis-sb-autre\t6\n`,
      montages: ["vieux1", "vieux2", "vieux3", "vieux4", "vieux5", "neuf"]
        .map((n) => `/elpis-sb-${n}|${bacs()}/${n}/work`)
        .concat([`/elpis-sb-autre|/srv/autre/bacs/a/work`])
        .join("\n"),
      entrees: {},
    });
    const arretes = await arreterBacsPerimes(bacs());
    const vieux = [
      "elpis-sb-vieux1",
      "elpis-sb-vieux2",
      "elpis-sb-vieux3",
      "elpis-sb-vieux4",
      "elpis-sb-vieux5",
    ];
    expect(arretes.sort()).toEqual(vieux);
    const l = lignes(journal);
    expect(l.filter((x) => x.startsWith("stop")).sort()).toEqual(vieux.map((n) => `stop -t 5 ${n}`));
    expect(l.some((x) => x.includes("HostConfig"))).toBe(false);
    expect(l.some((x) => x.includes("stop") && (x.includes("neuf") || x.includes("autre")))).toBe(false);
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

describe("lot 2 : script de démarrage, étiquette elpis.entry, filtre réseau", () => {
  const profilsDns = [
    ...PROFILS,
    {
      id: "web",
      name: "Web",
      mode: "allowlist_ip",
      ips: ["10.0.0.5"],
      domains: ["absent.lan"],
      dns: ["9.9.9.9", "10.0.0.5"],
      ports: [443],
    },
    { id: "dnsseul", name: "D", mode: "allowlist_ip", dns: ["9.9.9.9"] },
  ];
  function argvDe(profil: string, resolus: Record<string, string[]> = {}): string[] {
    const cfg = sandboxAdminConfigDepuis({ network_profiles: profilsDns }, () => undefined);
    const sb = new UserSandbox(1, "alice", travail, cfg, profil, { cli: new FauxCli() });
    return sb.buildRunArgs(sb.networkProfile, resolus);
  }

  it.each(["isolated", "open", "lan"])(
    "profil %s : entrypoint /bin/sh juste après --no-healthcheck",
    (profil) => {
      const argv = argvDe(profil);
      expect(argv.slice(argv.indexOf("--no-healthcheck"), argv.indexOf("--no-healthcheck") + 3)).toEqual([
        "--no-healthcheck",
        "--entrypoint",
        "/bin/sh",
      ]);
    },
  );

  it("étiquette elpis.entry juste après elpis.agent, valeur = empreinte du script", () => {
    const argv = argvDe("isolated");
    const i = argv.findIndex((a) => a.startsWith("elpis.agent="));
    expect(argv.slice(i + 1, i + 3)).toEqual(["--label", `elpis.entry=${empreinteDemarrage()}`]);
    expect(empreinteDemarrage()).toMatch(/^[0-9a-f]{12}$/u);
  });

  it("l'empreinte suit le CONTENU du script et lève si le fichier manque", () => {
    const f = path.join(tmp, "agent", "demarrage.sh");
    const avant = empreinteDemarrage();
    expect(avant).toBe(createHash("sha256").update("#!/bin/sh\n").digest("hex").slice(0, 12));
    writeFileSync(f, "#!/bin/sh\nexit 1\n");
    expect(empreinteDemarrage()).not.toBe(avant);
    writeFileSync(f, "#!/bin/sh\n");
    expect(empreinteDemarrage()).toBe(avant);
    rmSync(f);
    expect(() => empreinteDemarrage()).toThrow();
  });

  it.each([
    ["isolated", false],
    ["open", false],
    ["lan", true],
  ])("profil %s : ELPIS_NET_MODE=allowlist seulement en liste blanche (%s)", (profil, attendu) => {
    const argv = argvDe(profil);
    expect(argv.includes("ELPIS_NET_MODE=allowlist")).toBe(attendu);
    if (attendu)
      expect(argv.slice(argv.indexOf("NET_ADMIN") - 1, argv.indexOf("NET_ADMIN") + 3)).toEqual([
        "--cap-add",
        "NET_ADMIN",
        "-e",
        "ELPIS_NET_MODE=allowlist",
      ]);
    else expect(argv).not.toContain("NET_ADMIN");
  });

  it("résolveurs : dans ELPIS_DNS et --dns, jamais ajoutés à ELPIS_ALLOWLIST (sauf s'ils y sont déjà par leurs ips)", () => {
    const argv = argvDe("web");
    expect(argv).toContain("ELPIS_ALLOWLIST=10.0.0.5");
    expect(argv).toContain("ELPIS_DNS=9.9.9.9 10.0.0.5");
    expect(argv.filter((a) => a === "--dns")).toHaveLength(2);
  });

  it("seulement des domaines non résolus ou des résolveurs : ELPIS_ALLOWLIST= vide", () => {
    expect(argvDe("dnsseul")).toContain("ELPIS_ALLOWLIST=");
    expect(argvDe("dnsseul")).toContain("ELPIS_DNS=9.9.9.9");
    expect(argvDe("dnsseul").some((a) => a.startsWith("ELPIS_ALLOWLIST=9"))).toBe(false);
  });

  it.each(["isolated", "open", "lan", "web"])(
    "profil %s : l'argv finit par l'image, le script de démarrage, sleep infinity",
    (profil) => {
      const argv = argvDe(profil);
      expect(argv.slice(-4)).toEqual([
        expect.stringMatching(/^elpis\/sandbox:/u),
        SCRIPT_DEMARRAGE,
        "sleep",
        "infinity",
      ]);
      expect(SCRIPT_DEMARRAGE).toBe("/opt/elpis/agent/demarrage.sh");
    },
  );

  describe("configMatches et étiquette elpis.entry", () => {
    function bacAvec(entree: string, durci = "0", profil = "isolated") {
      const base = bacDe(profil);
      const netcfg = `${netcfgHash(base.sb.networkProfile)}|${RUN_SPEC}|${base.sb.cfg.image}|${agentEmpreinte()}|${entree}|${durci}\n`;
      return bacDe(profil, {}, [{ motif: ["~elpis.netcfg"], out: netcfg }]);
    }
    it("étiquette à jour : conforme ; différente ou vide : recréation", async () => {
      expect(await bacAvec(empreinteDemarrage()).sb.configMatches()).toBe(true);
      expect(await bacAvec("0123456789ab").sb.configMatches()).toBe(false);
      expect(await bacAvec("").sb.configMatches()).toBe(false);
    });

    it("étiquette elpis.durci : 1 attendu pour un profil filtré, 0 sinon", async () => {
      const e = empreinteDemarrage();
      expect(await bacAvec(e, "1", "lan").sb.configMatches()).toBe(true);
      expect(await bacAvec(e, "0", "lan").sb.configMatches()).toBe(false);
      expect(await bacAvec(e, "", "lan").sb.configMatches()).toBe(false);
      expect(await bacAvec(e, "0", "open").sb.configMatches()).toBe(true);
      expect(await bacAvec(e, "1", "open").sb.configMatches()).toBe(false);
      expect(await bacAvec(e, "1").sb.configMatches()).toBe(false);
    });

    it("le format d'inspection lit l'étiquette elpis.entry après elpis.agent", async () => {
      const { sb, cli } = bacAvec(empreinteDemarrage());
      await sb.configMatches();
      expect(String((cli.appels[0] ?? [])[2])).toContain(
        'elpis.agent"}}|{{index .Config.Labels "elpis.entry"}}|{{index .Config.Labels "elpis.durci"}}',
      );
    });
  });
});

describe("lot 2 bis : script de démarrage illisible, reconfiguration, profils", () => {
  const SOBRE = "La sandbox ne peut pas démarrer. Demandez à votre administrateur.";

  it("script manquant : ExecError sobre (sans chemin) de buildRunArgs et de configMatches", async () => {
    const { sb } = bacEnMarche("isolated");
    rmSync(path.join(tmp, "agent", "demarrage.sh"));
    expect(() => sb.buildRunArgs(sb.networkProfile, {})).toThrow(SOBRE);
    expect(() => sb.buildRunArgs(sb.networkProfile, {})).toThrow(ExecError);
    await expect(sb.configMatches()).rejects.toThrow(SOBRE);
    await expect(sb.configMatches()).rejects.toBeInstanceOf(ExecError);
    try {
      sb.buildRunArgs(sb.networkProfile, {});
    } catch (e) {
      expect((e as Error).message).not.toContain(tmp);
    }
  });

  it("reconcileConfig rejeté par une erreur autre qu'une annulation : configVerified revient à faux", async () => {
    const { sb } = bacEnMarche("isolated");
    rmSync(path.join(tmp, "agent", "demarrage.sh"));
    sb.mountVerified = true;
    sb.modesVerified = true;
    await expect(sb.ensureRunning()).rejects.toThrow(SOBRE);
    expect(sb.configVerified).toBe(false);
  });

  const web = (p: Record<string, unknown>) =>
    profilReseauDepuis({ id: "web", name: "W", mode: "allowlist_ip", ...p }, (m) => avis.push(m));
  let avis: string[] = [];
  beforeEach(() => {
    avis = [];
  });

  it.each([[[0]], [[70000]], [["443/tcp"]], [[0, 70000]]])(
    "ports demandés %j sans aucun valide : profil fermé (ips et domaines vidés), un avertissement",
    (ports) => {
      const p = web({ ips: ["10.0.0.5"], domains: ["pypi.org"], dns: ["9.9.9.9"], ports });
      expect([p.ips, p.domains, p.ports, p.dns]).toEqual([[], [], [], ["9.9.9.9"]]);
      expect(avis.filter((a) => a.includes("aucun port valide"))).toEqual([
        "profil réseau 'web' : aucun port valide, aucune destination gardée",
      ]);
    },
  );

  it("un port valide parmi d'autres : seul l'invalide est retiré, destinations gardées", () => {
    const p = web({ ips: ["10.0.0.5"], domains: ["pypi.org"], ports: [443, 70000] });
    expect([p.ips, p.domains, p.ports]).toEqual([["10.0.0.5"], ["pypi.org"], [443]]);
    expect(avis).toEqual([]);
  });

  it("aucun port demandé : toutes les destinations gardées, pas d'avertissement", () => {
    const p = web({ ips: ["10.0.0.5"], domains: ["pypi.org"] });
    expect([p.ips, p.domains, p.ports]).toEqual([["10.0.0.5"], ["pypi.org"], []]);
    expect(avis).toEqual([]);
  });

  it("profil migré (legacy) : mode inconnu → none, entrées IPv6 ou douteuses retirées, forme canonique", () => {
    const legacy = (cfg: Record<string, unknown>) => {
      const avertis: string[] = [];
      const c = configBacDepuis({ network_mode: "bridge", ...cfg }, (m) => avertis.push(m));
      return { p: c.network_profiles.find((x) => x.id === "legacy"), avertis };
    };
    expect(legacy({ network_mode: "n'importe quoi" }).p?.mode).toBe("none");
    expect(legacy({ network_mode: "allowlist_ip" }).p?.mode).toBe("allowlist_ip");
    const { p, avertis } = legacy({
      network_mode: "allowlist_ip",
      network_allowlist: ["10.0.0.7/24", "fe80::1", "-j", "1.2.3.4/32"],
    });
    expect(p?.ips).toEqual(["10.0.0.0/24", "1.2.3.4"]);
    expect(avertis.filter((a) => a.includes("ignoré"))).toHaveLength(2);
  });
});

describe("conteneur durci (profil filtré)", () => {
  const argvDe = (profil: string, executors: Record<string, unknown> = {}): string[] => {
    const cfg = sandboxAdminConfigDepuis({ network_profiles: PROFILS, ...executors }, () => undefined);
    const sb = new UserSandbox(1, "alice", travail, cfg, profil, { cli: new FauxCli() });
    return sb.buildRunArgs(sb.networkProfile, {});
  };
  const caps = (argv: string[]): string[] => argv.filter((a, i) => argv[i - 1] === "--cap-add");
  const tmpfs = (argv: string[]): string[] => argv.filter((a, i) => argv[i - 1] === "--tmpfs");

  it("liste blanche : sept capacités et NET_ADMIN, racine en lecture seule, tmpfs, étiquette elpis.durci=1", () => {
    const argv = argvDe("lan");
    expect(caps(argv)).toEqual([
      "CHOWN",
      "DAC_OVERRIDE",
      "FOWNER",
      "SETUID",
      "SETGID",
      "SETPCAP",
      "KILL",
      "NET_ADMIN",
    ]);
    for (const absente of ["FSETID", "AUDIT_WRITE", "NET_BIND_SERVICE"]) expect(argv).not.toContain(absente);
    expect(argv).toContain("--read-only");
    expect(tmpfs(argv)).toEqual([
      "/tmp:rw,exec,nosuid,nodev,size=1024m,mode=1777",
      "/var/tmp:rw,nosuid,nodev,size=64m,mode=1777",
      "/home/elpis:rw,nosuid,nodev,size=64m,mode=0700,uid=10001,gid=10001",
      "/run:rw,size=10m,mode=755",
    ]);
    expect(argv).toContain("elpis.durci=1");
    expect(argv).toContain("no-new-privileges:true");
  });

  it("/tmp : la moitié de la mémoire du bac, au moins 64 Mo", () => {
    const petit = argvDe("lan", { limits: { memory_mb: 100 } });
    expect(tmpfs(petit)[0]).toBe("/tmp:rw,exec,nosuid,nodev,size=64m,mode=1777");
    const grand = argvDe("lan", { limits: { memory_mb: 4096 } });
    expect(tmpfs(grand)[0]).toBe("/tmp:rw,exec,nosuid,nodev,size=2048m,mode=1777");
  });

  it.each(["isolated", "open"])("profil %s : dix capacités, racine inscriptible, elpis.durci=0", (profil) => {
    const argv = argvDe(profil);
    expect(caps(argv)).toEqual(CAPABILITIES);
    expect(caps(argv)).toHaveLength(10);
    expect(argv).not.toContain("--read-only");
    expect(tmpfs(argv)).toEqual(["/run:rw,size=10m,mode=755"]);
    expect(argv).toContain("elpis.durci=0");
  });

  it("garde d'entrée : jamais d'entrée du compte en root dans un conteneur sans gain de privilèges", () => {
    const sansReseau = 'false\nnull\n["no-new-privileges:true"]';
    expect(entreePermise(sansReseau, "10001:10001")).toBe(true);
    for (const u of ["0:0", "root:root", "00:1", ":1", "10001"])
      expect(entreePermise(sansReseau, u)).toBe(false);
    expect(entreePermise(sansReseau, null)).toBe(true);
    // sans no-new-privileges et sans réseau : toujours permis, comme avant
    expect(entreePermise(SANS, "0:0")).toBe(true);
  });
});
