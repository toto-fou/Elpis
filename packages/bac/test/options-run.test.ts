// SPDX-License-Identifier: MIT
/** packages/bac/test/options-run.test.ts — options `docker run` ajoutées par l'administrateur : forme rendue, options et variables permises, montages en lecture seule sur /mnt/<nom>, motifs de refus sans valeur de variable, limites de taille. */
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { configBacDepuis, sandboxAdminConfigDepuis, UserSandbox } from "../src/index";
import { argsRunPermis, verifierMontages } from "../src/options-run";
import { dossierTemporaire, FauxCli } from "./aides";

/** /srv utilisable pour un essai sur le vrai disque : présent, à root, non modifiable par un autre compte, sous une racine de même. */
const SRV_SUR = ["/", "/srv"].every((d) => {
  try {
    const s = statSync(d);
    return s.isDirectory() && s.uid === 0 && (s.mode & 0o022) === 0;
  } catch {
    return false;
  }
});

let tmp: string;
let nettoyer: () => void;

beforeEach(() => {
  [tmp, nettoyer] = dossierTemporaire("elpis-options-run-");
});

afterEach(() => nettoyer());

const garde = (...args: string[]): string[] => argsRunPermis(args).gardes;
const refus = (...args: string[]): string[] => argsRunPermis(args).refus;

describe("options simples : forme rendue --option=valeur", () => {
  it.each([
    [["--shm-size=2g"], ["--shm-size=2g"]],
    [["--shm-size", "2g"], ["--shm-size=2g"]],
    [["--cpu-shares", "512"], ["--cpu-shares=512"]],
    [["--cpuset-cpus=0-1"], ["--cpuset-cpus=0-1"]],
    [["--add-host", "mon.hote:192.0.2.7"], ["--add-host=mon.hote:192.0.2.7"]],
    [["--gpus", "all"], ["--gpus=all"]],
    [["--dns", "192.0.2.53"], ["--dns=192.0.2.53"]],
    [["--dns-search=exemple.test"], ["--dns-search=exemple.test"]],
    [["--dns-option", "ndots:2"], ["--dns-option=ndots:2"]],
    [["--storage-opt", "size=5G"], ["--storage-opt=size=5G"]],
    [["--hostname", "bac"], ["--hostname=bac"]],
  ])("%j : %j", (args, attendu) => {
    expect(argsRunPermis(args)).toEqual({ gardes: attendu, refus: [] });
  });

  it("alias courts : -c, -h, -e, -l et -v rendus sous leur option longue", () => {
    expect(garde("-c", "512")).toEqual(["--cpu-shares=512"]);
    expect(garde("-c512")).toEqual(["--cpu-shares=512"]);
    expect(garde("-c=512")).toEqual(["--cpu-shares=512"]);
    expect(garde("-h", "bac")).toEqual(["--hostname=bac"]);
    expect(garde("-e", "A=1")).toEqual(["--env=A=1"]);
    expect(garde("-eA=1")).toEqual(["--env=A=1"]);
    expect(garde("-l", "equipe=a")).toEqual(["--label=equipe=a"]);
  });

  it("arguments vides ignorés, espaces retirés, ordre gardé", () => {
    expect(argsRunPermis(["", "  ", "  --shm-size  ", " 1g ", "--hostname=b"])).toEqual({
      gardes: ["--shm-size=1g", "--hostname=b"],
      refus: [],
    });
  });

  it("valeur manquante ou suivie d'une autre option : refusée, l'option suivante est jugée à part", () => {
    expect(refus("--shm-size")).toEqual(["--shm-size (valeur manquante)"]);
    const r = argsRunPermis(["--shm-size", "--hostname=b"]);
    expect(r.gardes).toEqual(["--hostname=b"]);
    expect(r.refus).toEqual(["--shm-size (valeur manquante)"]);
  });

  it.each([
    ["--privileged"],
    ["--network=host"],
    ["--net=host"],
    ["--pid=host"],
    ["--ipc=host"],
    ["--user=0:0"],
    ["--userns=host"],
    ["--security-opt=seccomp=unconfined"],
    ["--device=/dev/sda"],
    ["--read-only=false"],
    ["--entrypoint=/bin/sh"],
    ["--restart=always"],
    ["--init"],
    ["--runtime=runc"],
    ["--memory=999g"],
    ["--pids-limit=-1"],
    ["--sysctl=net.ipv4.ip_forward=1"],
    ["--volumes-from=autre"],
    ["--tmpfs=/data"],
    ["--name=autre"],
  ])("option hors liste %s : refusée", (option) => {
    const r = argsRunPermis([option]);
    expect(r.gardes).toEqual([]);
    expect(r.refus).toHaveLength(1);
    expect(r.refus[0]).toContain("option non permise");
  });

  it("--cap-add refusé sous toutes ses formes", () => {
    for (const args of [["--cap-add=NET_ADMIN"], ["--cap-add", "SYS_ADMIN"], ["--cap-add=ALL"]]) {
      const r = argsRunPermis(args);
      expect(r.gardes).toEqual([]);
      expect(r.refus).toHaveLength(1);
      expect(r.refus[0]).toContain("--cap-add");
    }
  });
});

describe("--ulimit : fichiers, pile et mémoire verrouillée seulement", () => {
  it.each([["nofile=4096:8192"], ["stack=8388608"], ["memlock=-1"], ["NOFILE=1024"], [" nofile=64"]])(
    "%s permis",
    (valeur) => {
      expect(garde("--ulimit", valeur.trim())).toEqual([`--ulimit=${valeur.trim()}`]);
      expect(garde(`--ulimit=${valeur.trim()}`)).toEqual([`--ulimit=${valeur.trim()}`]);
    },
  );

  it.each([
    ["core=-1"],
    ["rtprio=99"],
    ["nproc=512"],
    ["cpu=1"],
    ["nice=-20"],
    ["fsize=1"],
    ["as=1"],
    ["data=1"],
    ["x"],
  ])("%s refusé", (valeur) => {
    const r = argsRunPermis(["--ulimit", valeur]);
    expect(r.gardes).toEqual([]);
    expect(r.refus).toEqual([`--ulimit ${valeur} (limite non permise (nofile, stack ou memlock))`]);
  });
});

describe("variables d'environnement", () => {
  it.each([["MA_VARIABLE=1"], ["_x=a=b"], ["Proxy=http://192.0.2.1:3128"], ["PATHS=1"], ["HOMEDIR=1"]])(
    "%s permise",
    (valeur) => {
      expect(garde("--env", valeur)).toEqual([`--env=${valeur}`]);
      expect(garde(`--env=${valeur}`)).toEqual([`--env=${valeur}`]);
    },
  );

  it.each([
    "PATH",
    "HOME",
    "ENV",
    "BASH_ENV",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_AUDIT",
    "ELPIS_NET_MODE",
    "ELPIS_BLOCKED",
    "XTABLES_LIBDIR",
    "IPTABLES_LIBDIR",
    "IP6TABLES_X",
    "GCONV_PATH",
    "LOCPATH",
    "NLSPATH",
    "GLIBC_TUNABLES",
    "MALLOC_CHECK_",
    "MALLOC_PERTURB_",
  ])("variable réservée %s : refusée, sans la casse, nommée sans sa valeur", (nom) => {
    for (const variante of [nom, nom.toLowerCase(), nom[0] + nom.slice(1).toLowerCase()]) {
      const r = argsRunPermis(["--env", `${variante}=valeur-secrete-42`]);
      expect(r.gardes, variante).toEqual([]);
      expect(r.refus, variante).toEqual([`--env ${variante} (variable réservée ou mal formée)`]);
      expect(JSON.stringify(r)).not.toContain("valeur-secrete-42");
    }
  });

  it("variable mal formée : sans valeur, nom invalide", () => {
    for (const valeur of ["SANS_EGAL", "=1", "1A=1", "A-B=1", "A B=1", ""]) {
      const r = argsRunPermis(["--env", valeur]);
      expect(r.gardes, valeur).toEqual([]);
      expect(r.refus, valeur).toHaveLength(1);
    }
  });

  it("un refus ne montre pas la valeur d'une variable permise qui suit un nom mal formé", () => {
    const r = argsRunPermis(["--env=mot de passe=hunter2"]);
    expect(JSON.stringify(r)).not.toContain("hunter2");
  });
});

describe("étiquettes", () => {
  it("étiquettes libres permises, tout l'espace elpis. réservé", () => {
    expect(garde("--label", "equipe=a")).toEqual(["--label=equipe=a"]);
    expect(garde("--label=equipe")).toEqual(["--label=equipe"]);
    expect(garde("--label", "Elpis.x=1")).toEqual(["--label=Elpis.x=1"]);
    for (const v of ["elpis.durci=0", "elpis.spec=1", "elpis.netcfg=x", "elpis.resolved=[]", "elpis.autre"]) {
      for (const args of [["--label", v], [`--label=${v}`], ["-l", v]]) {
        const r = argsRunPermis(args);
        expect(r.gardes, v).toEqual([]);
        expect(r.refus, v).toHaveLength(1);
        expect(r.refus[0]).toContain("étiquette réservée");
      }
    }
  });
});

describe("montages : lecture seule sur /mnt/<nom>, jugés sur leur forme, sans toucher au disque", () => {
  const rendu = (cible: string, source = "/data/partage"): string =>
    `--mount=type=bind,source=${source},target=${cible},readonly`;

  it("--volume source:/mnt/<nom>:ro rendu en --mount, la source telle que saisie (vérifiée sur le disque à la création)", () => {
    expect(argsRunPermis(["--volume", "/data/partage:/mnt/donnees:ro"])).toEqual({
      gardes: [rendu("/mnt/donnees")],
      refus: [],
    });
    expect(garde("-v", "/data/partage:/mnt/a.b_c-d:ro")).toEqual([rendu("/mnt/a.b_c-d")]);
    expect(garde("--volume=/data/partage:/mnt/x:ro")).toEqual([rendu("/mnt/x")]);
    expect(garde("--volume", "/data/partage/:/mnt/x:ro")).toEqual([rendu("/mnt/x")]);
  });

  it("--mount : alias de champs et formes de lecture seule", () => {
    for (const valeur of [
      "type=bind,source=/data/partage,target=/mnt/x,readonly",
      "type=bind,src=/data/partage,dst=/mnt/x,ro",
      "type=bind,source=/data/partage,destination=/mnt/x,readonly=true",
      "TYPE=bind,SOURCE=/data/partage,TARGET=/mnt/x,RO=1",
      "target=/mnt/x,type=bind,readonly=,source=/data/partage",
    ]) {
      expect(garde("--mount", valeur), valeur).toEqual([rendu("/mnt/x")]);
      expect(garde(`--mount=${valeur}`), valeur).toEqual([rendu("/mnt/x")]);
    }
  });

  it("lecture seule exigée : rw, absente ou fausse refusées", () => {
    for (const args of [
      ["--volume", "/data/partage:/mnt/x"],
      ["--volume", "/data/partage:/mnt/x:rw"],
      ["--volume", "/data/partage:/mnt/x:ro,z"],
      ["--mount", "type=bind,source=/data/partage,target=/mnt/x"],
      ["--mount", "type=bind,source=/data/partage,target=/mnt/x,readonly=false"],
      ["--mount", "type=bind,source=/data/partage,target=/mnt/x,ro=0"],
    ]) {
      const r = argsRunPermis(args);
      expect(r.gardes, args.join(" ")).toEqual([]);
      expect(r.refus, args.join(" ")).toHaveLength(1);
    }
    expect(refus("--volume", "/data/partage:/mnt/x:rw")).toEqual([
      "--volume /data/partage:/mnt/x:rw (montage en lecture seule seulement)",
    ]);
  });

  it("destination : un dossier direct de /mnt seulement", () => {
    for (const cible of [
      "/data",
      "/mnt",
      "/mnt/",
      "/mnt/a/b",
      "/mnt/..",
      "/mnt/.",
      "/mnt/a b",
      "/mnt/é",
      "/work/x",
      "/",
      "mnt/x",
      "/mnt/x/",
    ]) {
      for (const args of [
        ["--volume", `/data/partage:${cible}:ro`],
        ["--mount", `type=bind,source=/data/partage,target=${cible},ro`],
      ]) {
        const r = argsRunPermis(args);
        expect(r.gardes, `${args[0]} ${cible}`).toEqual([]);
        expect(r.refus, `${args[0]} ${cible}`).toHaveLength(1);
      }
    }
  });

  it("volume nommé, source relative ou forme inattendue : refusés", () => {
    for (const v of [
      "donnees:/mnt/x:ro",
      "./data:/mnt/x:ro",
      "data:/mnt/x:ro",
      "/data/partage:/mnt/x",
      "/data/partage",
      ":/mnt/x:ro",
      "/data/partage:/mnt/x:ro:z",
    ]) {
      const r = argsRunPermis(["--volume", v]);
      expect(r.gardes, v).toEqual([]);
      expect(r.refus, v).toHaveLength(1);
    }
  });

  it("champs de --mount répétés sous un alias, guillemets, type autre ou champ inconnu : refusés", () => {
    for (const v of [
      "type=bind,source=/data/partage,src=/data/partage,target=/mnt/x,ro",
      "type=bind,source=/data/partage,target=/mnt/x,dst=/mnt/y,ro",
      "type=bind,source=/data/partage,target=/mnt/x,ro,readonly",
      "type=bind,type=bind,source=/data/partage,target=/mnt/x,ro",
      'type=bind,source="/data/partage",target=/mnt/x,ro',
      "type=bind,source='/data/partage',target=/mnt/x,ro",
      'type=bind,"source=/etc",source=/data/partage,target=/mnt/x,ro',
      "type=volume,source=donnees,target=/mnt/x,ro",
      "type=tmpfs,target=/mnt/x",
      "source=/data/partage,target=/mnt/x,ro",
      "type=bind,source=/data/partage,target=/mnt/x,ro,bind-propagation=shared",
      "type=bind,source=/data/partage,target=/mnt/x,ro,bind-nonrecursive",
    ]) {
      const r = argsRunPermis(["--mount", v]);
      expect(r.gardes, v).toEqual([]);
      expect(r.refus, v).toHaveLength(1);
    }
  });

  it("source : chemin absolu de caractères sûrs seulement (Docker lit --mount en CSV), sans . ni ..", () => {
    for (const s of [
      "/data/a,source=/",
      "/data/a b",
      "/data/a=b",
      '/data/a"b',
      "/data/é",
      "/data/./x",
      "/data/../etc",
      "/data//x/..",
    ]) {
      const r = argsRunPermis(["--volume", `${s}:/mnt/x:ro`]);
      expect(r.gardes, s).toEqual([]);
      expect(r.refus, s).toHaveLength(1);
    }
    expect(refus("--volume", "/data/a=b:/mnt/x:ro")[0]).toContain("lettres, chiffres");
  });

  it("racine, dossiers système, dossiers temporaires ou des comptes, et dossiers qui en contiennent un : refusés", () => {
    for (const s of [
      "/",
      "/etc",
      "/etc/ssh",
      "/root",
      "/home",
      "/home/x",
      "/boot",
      "/proc",
      "/sys",
      "/dev",
      "/run",
      "/var",
      "/var/log",
      "/usr",
      "/usr/share",
      "/bin",
      "/sbin",
      "/lib",
      "/lib64",
      "/opt",
      "/opt/x",
      "/tmp",
      "/tmp/x",
      "/snap",
      tmp,
    ]) {
      for (const args of [
        ["--volume", `${s}:/mnt/x:ro`],
        ["--mount", `type=bind,source=${s},target=/mnt/x,ro`],
      ]) {
        const r = argsRunPermis(args);
        expect(r.gardes, s).toEqual([]);
        expect(r.refus, s).toHaveLength(1);
      }
    }
  });
});

describe.skipIf(!SRV_SUR)("montages vérifiés sur le vrai disque", () => {
  it("/srv (root, non modifiable par un autre compte) : gardé, rendu sur son chemin résolu", async () => {
    const montage = (source: string): string => `--mount=type=bind,source=${source},target=/mnt/x,readonly`;
    expect(await verifierMontages([montage("/srv")])).toEqual({
      args: [montage(realpathSync("/srv"))],
      refus: [],
    });
  });
});

describe("limites de taille et de nombre", () => {
  it("argument de plus de 200 caractères, ou avec un retour à la ligne ou NUL : refusé, nommé sans sa valeur", () => {
    const long = `--hostname=${"a".repeat(190)}`;
    expect(long.length).toBeGreaterThan(200);
    const r = argsRunPermis([long]);
    expect(r.gardes).toEqual([]);
    expect(r.refus).toEqual(["--hostname (argument invalide : une ligne, 200 caractères au plus)"]);
    expect(argsRunPermis([`--env=SECRET=${"s".repeat(200)}`]).refus).toEqual([
      "--env (argument invalide : une ligne, 200 caractères au plus)",
    ]);
    for (const a of ["--hostname=a\nb", "--hostname=a\rb", "--hostname=a\0b"]) {
      const s = argsRunPermis([a]);
      expect(s.gardes, JSON.stringify(a)).toEqual([]);
      expect(s.refus, JSON.stringify(a)).toHaveLength(1);
      expect(s.refus[0]).toContain("argument invalide");
    }
    expect(garde(`--hostname=${"a".repeat(189)}`)).toHaveLength(1);
  });

  it("valeur séparée trop longue ou multiligne : non consommée, jugée à part", () => {
    const r = argsRunPermis(["--shm-size", "x".repeat(201)]);
    expect(r.gardes).toEqual([]);
    expect(r.refus).toHaveLength(2);
    expect(r.refus[0]).toBe("--shm-size (valeur manquante)");
  });

  it("32 options au plus : la 33e est refusée", () => {
    const trente_trois = Array.from({ length: 33 }, (_, i) => `--add-host=h${i}:192.0.2.1`);
    const r = argsRunPermis(trente_trois);
    expect(r.gardes).toHaveLength(32);
    expect(r.refus).toHaveLength(1);
    expect(r.refus[0]).toContain("trop d'options (32 au plus)");
    expect(argsRunPermis(trente_trois.slice(0, 32)).refus).toEqual([]);
  });

  it("les options refusées ne comptent pas dans les 32", () => {
    const args = [
      ...Array.from({ length: 10 }, () => "--privileged"),
      ...Array.from({ length: 32 }, (_, i) => `--add-host=h${i}:192.0.2.1`),
    ];
    const r = argsRunPermis(args);
    expect(r.gardes).toHaveLength(32);
    expect(r.refus).toHaveLength(10);
  });

  it("un refus est tronqué à 80 caractères avant le motif", () => {
    const r = argsRunPermis([`--privileged=${"x".repeat(150)}`]);
    expect(r.refus).toEqual([`--privileged ${"x".repeat(67)} (option non permise)`]);
  });
});

describe("lecture de config.json et docker run", () => {
  it("options hors liste retirées et signalées une par une, les permises gardées dans l'ordre", () => {
    const avis: string[] = [];
    const cfg = configBacDepuis(
      { extra_run_args: ["--shm-size=1g", "--privileged", "--env", "LD_PRELOAD=/x.so", "--hostname=b"] },
      (m) => avis.push(m),
    );
    expect(cfg.extra_run_args).toEqual(["--shm-size=1g", "--hostname=b"]);
    expect(avis).toEqual([
      "executors.extra_run_args : --privileged (option non permise) ignoré",
      "executors.extra_run_args : --env LD_PRELOAD (variable réservée ou mal formée) ignoré",
    ]);
    expect(JSON.stringify(avis)).not.toContain("/x.so");
  });

  it("liste vide, absente ou de blancs : aucune option, aucun avertissement", () => {
    for (const brut of [
      {},
      { extra_run_args: [] },
      { extra_run_args: ["", "  "] },
      { extra_run_args: null },
    ]) {
      const avis: string[] = [];
      expect(configBacDepuis(brut, (m) => avis.push(m)).extra_run_args).toEqual([]);
      expect(avis).toEqual([]);
    }
  });

  it("docker run : les options gardées arrivent sous la forme vérifiée, juste avant l'image", () => {
    const cfg = sandboxAdminConfigDepuis(
      { extra_run_args: ["--shm-size", "2g", "-e", "A=1", "--cap-add=NET_ADMIN"] },
      () => undefined,
    );
    const sb = new UserSandbox(1, "alice", path.join(tmp, "work"), cfg, null, { cli: new FauxCli() });
    const argv = sb.buildRunArgs(sb.networkProfile, {});
    const i = argv.indexOf("--shm-size=2g");
    expect(argv.slice(i, i + 2)).toEqual(["--shm-size=2g", "--env=A=1"]);
    expect(argv[i + 2]).toBe(cfg.image);
    expect(argv).not.toContain("--cap-add=NET_ADMIN");
  });
});
