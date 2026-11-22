// SPDX-License-Identifier: MIT
/** packages/bac/test/arbre-bac.test.ts — arbre d'un bac vu de l'hôte d'outils : dossier de l'agent en 01707 rechmodé seulement s'il le faut et qu'il est à ce compte, vidé des entrées d'un autre UID (création et redémarrage), montages refusés avec un compte par service si un lien ou un autre compte peut changer l'arbre (création, redémarrage, purge, sans rien retirer ni créer), purges de bacs mis de côté sur leur propre conteneur, utilisateur des entrées comparé, marqueurs lus et écrits sans suivre de lien. */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { brancherJournal, journalStderr } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { dossierAgentPret, exigerMontagesSurs, ExecError, viderDossierAgent } from "../src/conteneur";
import {
  agentEmpreinte,
  definirFabriqueAgent,
  netcfgHash,
  reglagesBac,
  reglagesMontages,
  reglagesNavigateurBac,
  RUN_SPEC,
  sandboxAdminConfigDepuis,
  UserSandbox,
} from "../src/index";
import type { EtatBac } from "../src/index";
import { empreinteDemarrage } from "../src/montages";
import { ecrireMarqueur, lireMarqueur } from "../src/travail";
import { dossierTemporaire, FauxCli } from "./aides";
import type { Regle } from "./aides";

const espions = vi.hoisted(() => ({ chmod: vi.fn(), refus: { actif: false }, etrangers: new Set<string>() }));

/** chmodSync et fchmodSync tracés ; « autre compte » simulé : ils lèvent EPERM, comme pour un dossier qui n'est pas à ce compte ; lstatSync voit les entrées nommées dans `etrangers` à un autre compte. */
vi.mock("node:fs", async (importOriginal) => {
  const reel = await importOriginal<Record<string, unknown>>();
  const enveloppe =
    (nom: string) =>
    (cible: unknown, mode: number): void => {
      espions.chmod(nom, mode);
      if (espions.refus.actif) throw Object.assign(new Error(`EPERM: ${nom}`), { code: "EPERM" });
      (reel[nom] as (c: unknown, m: number) => void)(cible, mode);
    };
  const chmodSync = enveloppe("chmodSync");
  const fchmodSync = enveloppe("fchmodSync");
  const lstatSync = (cible: unknown, ...r: unknown[]): unknown => {
    const st = (reel["lstatSync"] as (...a: unknown[]) => object)(cible, ...r);
    const nom = String(cible).slice(String(cible).lastIndexOf("/") + 1);
    return espions.etrangers.has(nom)
      ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: 4242 })
      : st;
  };
  return {
    ...reel,
    default: { ...(reel["default"] as object), chmodSync, fchmodSync, lstatSync },
    chmodSync,
    fchmodSync,
    lstatSync,
  };
});

const DEMARRAGE_IMPOSSIBLE = "La sandbox ne peut pas démarrer. Demandez à votre administrateur.";
let tmp = "";
let nettoyer: () => void = () => undefined;
let avertis: string[] = [];

const mode = (p: string): number => statSync(p).mode & 0o7777;
/** Le processus se voit sous un autre compte que celui des dossiers de l'essai, qui ne se laissent plus rechmoder. */
const autreCompte = (): void => {
  const moi = process.geteuid?.() ?? 0;
  vi.spyOn(process, "geteuid").mockReturnValue(moi + 1);
  espions.refus.actif = true;
};

beforeEach(() => {
  [tmp, nettoyer] = dossierTemporaire("elpis-bac-arbre-");
  avertis = [];
  espions.chmod.mockClear();
  espions.refus.actif = false;
  espions.etrangers.clear();
  brancherJournal((d) => ({ ...journalStderr(d), warn: (...a: unknown[]) => avertis.push(a.join(" ")) }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  espions.refus.actif = false;
  brancherJournal(null);
  nettoyer();
});

describe("dossierAgentPret", () => {
  it("absent : créé en 01707 (fermé au groupe, ouvert au compte des bacs)", () => {
    const d = path.join(tmp, ".elpis-agent");
    dossierAgentPret(d);
    expect(mode(d)).toBe(0o1707);
  });

  it("déjà en 01707, à un autre compte : aucun chmod tenté", () => {
    const d = path.join(tmp, ".elpis-agent");
    mkdirSync(d);
    chmodSync(d, 0o1707);
    espions.chmod.mockClear();
    autreCompte();
    dossierAgentPret(d);
    expect(espions.chmod).not.toHaveBeenCalled();
    expect([mode(d), avertis]).toEqual([0o1707, []]);
  });

  it("à ce compte, en 0700, 0777 ou 01777 : remis en 01707", () => {
    const d = path.join(tmp, ".elpis-agent");
    mkdirSync(d);
    for (const m of [0o700, 0o777, 0o1777]) {
      chmodSync(d, m);
      espions.chmod.mockClear();
      dossierAgentPret(d);
      expect([mode(d), espions.chmod.mock.calls]).toEqual([0o1707, [["fchmodSync", 0o1707]]]);
    }
  });

  it("à un autre compte, pas en 01707 : refus sobre, installateur à relancer au journal, aucun chmod tenté", () => {
    const d = path.join(tmp, ".elpis-agent");
    mkdirSync(d);
    chmodSync(d, 0o777);
    espions.chmod.mockClear();
    autreCompte();
    expect(() => dossierAgentPret(d)).toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    expect(espions.chmod).not.toHaveBeenCalled();
    expect(mode(d)).toBe(0o777);
    expect(avertis).toHaveLength(1);
    expect(avertis[0]).toContain(`${d} en 0777 au lieu de 1707`);
    expect(avertis[0]).toContain("relancez sudo ./elpis service install");
  });

  it("lien à la place du dossier : refus sobre, sa cible intacte, détail au journal", () => {
    const cible = path.join(tmp, "ailleurs");
    mkdirSync(cible);
    chmodSync(cible, 0o700);
    const d = path.join(tmp, ".elpis-agent");
    symlinkSync(cible, d);
    espions.chmod.mockClear();
    expect(() => dossierAgentPret(d)).toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    expect(espions.chmod).not.toHaveBeenCalled();
    expect(mode(cible)).toBe(0o700);
    expect(avertis.at(-1)).toContain("relancez sudo ./elpis service install");
  });

  it("UID des entrées changé : verrou, sockets et config git d'un autre compte retirés sans suivre de lien, le reste gardé", () => {
    const d = path.join(tmp, ".elpis-agent");
    mkdirSync(path.join(d, "x.sock"), { recursive: true });
    chmodSync(d, 0o1707);
    const cible = path.join(tmp, "cible");
    writeFileSync(cible, "intact");
    for (const f of ["agent.lock", "agent.sock", "gitconfig", "browser-ca.crt", "notes"])
      writeFileSync(path.join(d, f), "x");
    symlinkSync(cible, path.join(d, "y.sock"));
    espions.chmod.mockClear();
    const moi = process.geteuid?.() ?? 0;
    viderDossierAgent(d, 10001);
    expect(readdirSync(d).sort()).toHaveLength(7);
    vi.spyOn(process, "geteuid").mockReturnValue(moi + 1);
    viderDossierAgent(d, moi);
    expect(readdirSync(d).sort()).toHaveLength(7);
    viderDossierAgent(d, 10001);
    expect(readdirSync(d).sort()).toEqual(["browser-ca.crt", "notes", "x.sock"]);
    expect([readFileSync(cible, "utf8"), mode(d), espions.chmod.mock.calls.length]).toEqual([
      "intact",
      0o1707,
      0,
    ]);
  });
});

describe("exigerMontagesSurs", () => {
  let S = "";
  let P = "";

  /** Arbre d'un compte tel que l'installation le laisse : `<S>` et `<P>` en 2750, /work, dossier de l'agent, relais. */
  beforeEach(() => {
    S = path.join(tmp, "bacs");
    P = path.join(S, "alice");
    for (const d of [path.join(P, "work"), path.join(P, ".elpis-agent"), path.join(S, ".elpis-relay")])
      mkdirSync(d, { recursive: true });
    for (const d of [S, P]) chmodSync(d, 0o2750);
    vi.stubEnv("ELPIS_GROUPE_DONNEES", String(process.getgid?.() ?? 0));
  });

  const refuse = (): string => {
    expect(() => exigerMontagesSurs(path.join(P, "work"), S)).toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    expect(avertis.at(-1)).toContain("relancez sudo ./elpis service install");
    return avertis.at(-1) ?? "";
  };

  it("arbre de ce compte, sans lien : montages permis", () => {
    exigerMontagesSurs(path.join(P, "work"), S);
    expect(avertis).toEqual([]);
  });

  it("racine ou dossier du compte inscriptibles par le groupe ou les autres : refusé", () => {
    for (const [d, m] of [
      [S, 0o2770],
      [P, 0o2770],
      [P, 0o2757],
    ] as const) {
      chmodSync(d, m);
      expect(refuse()).toContain("modifiable par un autre compte");
      chmodSync(d, 0o2750);
    }
  });

  it("dossier du compte à un autre compte : refusé", () => {
    vi.spyOn(process, "geteuid").mockReturnValue((process.geteuid?.() ?? 0) + 1);
    if (statSync(P).uid !== 0) expect(refuse()).toContain("modifiable par un autre compte");
  });

  it("lien à la place du dossier du compte, de /work, du dossier de l'agent ou du relais : refusé", () => {
    const ailleurs = path.join(tmp, "ailleurs");
    mkdirSync(ailleurs);
    for (const d of [path.join(P, "work"), path.join(P, ".elpis-agent"), path.join(S, ".elpis-relay"), P]) {
      const garde = `${d}.garde`;
      renameSync(d, garde);
      symlinkSync(ailleurs, d);
      expect(refuse()).toContain("lien ou entrée inattendue");
      unlinkSync(d);
      renameSync(garde, d);
    }
    exigerMontagesSurs(path.join(P, "work"), S);
  });

  it("dossier d'un compte en lien vers celui d'un autre : refusé, le dossier monté doit être l'entrée au nom du compte", () => {
    mkdirSync(path.join(S, "bob", "work"), { recursive: true });
    mkdirSync(path.join(S, "bob", ".elpis-agent"));
    chmodSync(path.join(S, "bob"), 0o2750);
    symlinkSync(path.join(S, "bob"), path.join(S, "carol"));
    const resolu = path.join(S, "bob", "work");
    exigerMontagesSurs(resolu, S, "bob");
    expect(() => exigerMontagesSurs(resolu, S, "carol")).toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    expect(avertis.at(-1)).toContain("lien ou entrée inattendue");
    unlinkSync(path.join(S, "carol"));
    mkdirSync(path.join(S, "carol"));
    expect(() => exigerMontagesSurs(resolu, S, "carol")).toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    expect(avertis.at(-1)).toContain(`${S}/carol n'est pas ${S}/bob`);
  });

  it("/work hors de `<S>/<compte>/work` : refusé ; compte unique : aucun contrôle", () => {
    mkdirSync(path.join(tmp, "autre", "work"), { recursive: true });
    expect(() => exigerMontagesSurs(path.join(tmp, "autre", "work"), S)).toThrow(
      new ExecError(DEMARRAGE_IMPOSSIBLE),
    );
    expect(avertis.at(-1)).toContain("hors de");
    vi.unstubAllEnvs();
    symlinkSync(path.join(tmp, "ailleurs-absent"), path.join(S, "lien"));
    exigerMontagesSurs(path.join(S, "lien", "work"), S);
  });
});

describe("conteneur d'un compte, un compte par service", () => {
  const PROFILS = [{ id: "isolated", name: "Isolé", mode: "none", ips: [] }];
  const ARRETE = { exists: true, running: false, container_name: "elpis-sb-alice" } as EtatBac;
  const ABSENT = { exists: false, running: false, container_name: "elpis-sb-alice" } as EtatBac;
  let S = "";
  let travail = "";
  let restaurer: () => void = () => undefined;

  /** Arbre posé par l'installation (`<S>` et dossiers de comptes en 2750), agent factice, docker scripté. */
  beforeEach(() => {
    S = path.join(tmp, "sb");
    travail = path.join(S, "alice", "work");
    for (const d of ["alice/work", "alice/.elpis-agent", "bob/work", "bob/.elpis-agent", ".elpis-relay"])
      mkdirSync(path.join(S, d), { recursive: true });
    for (const d of [S, path.join(S, "alice"), path.join(S, "bob")]) chmodSync(d, 0o2750);
    for (const d of ["alice/.elpis-agent", "bob/.elpis-agent"]) chmodSync(path.join(S, d), 0o1707);
    mkdirSync(path.join(tmp, "agent"));
    writeFileSync(path.join(tmp, "agent", "demarrage.sh"), "#!/bin/sh\n");
    reglagesMontages.agentDir = path.join(tmp, "agent");
    reglagesNavigateurBac.playwright = "/nonexistent/ms-playwright";
    restaurer = surchargerConfig({ SANDBOX_DIR: S });
    vi.stubEnv("SANDBOX_READINESS_CACHE", "0");
    vi.stubEnv("ELPIS_GROUPE_DONNEES", String(process.getgid?.() ?? 0));
    reglagesBac.attenteCreationMs = 0;
    definirFabriqueAgent(() => ({
      hello: async () => ({}),
      archive: () => Promise.reject(new Error("inutile")),
      extract: () => Promise.reject(new Error("inutile")),
    }));
  });

  afterEach(() => {
    definirFabriqueAgent(null);
    reglagesMontages.agentDir = null;
    reglagesNavigateurBac.playwright = null;
    reglagesBac.attenteCreationMs = 800;
    restaurer();
  });

  /** Bac de `nom` sur `chemin`, conteneur arrêté par un signal (143) aux options à jour (utilisateur des entrées `exec` s'il est dit), /work monté sur `source`. */
  function bac(
    source: string,
    nom = "alice",
    chemin = travail,
    uid = 1,
    autres: Regle[] = [],
    exec?: string,
  ) {
    const cfg = sandboxAdminConfigDepuis({ network_profiles: PROFILS }, () => undefined);
    const temoin = new UserSandbox(uid, nom, chemin, cfg, "isolated", { cli: new FauxCli() });
    const netcfg = `${netcfgHash(temoin.networkProfile)}|${RUN_SPEC}|${cfg.image}|${agentEmpreinte()}|${empreinteDemarrage()}|0|${exec ?? temoin.utilisateurExec()}\n`;
    const cli = new FauxCli([
      ...autres,
      { motif: ["~ExitCode"], out: "143|false" },
      { motif: ["~elpis.netcfg"], out: netcfg },
      { motif: ["~.Mounts"], out: `${source}\n` },
    ]);
    return {
      sb: new UserSandbox(uid, nom, chemin, cfg, "isolated", { cli, resoudreDomaines: async () => ({}) }),
      cli,
    };
  }
  const appels = (cli: FauxCli, verbe: string): unknown[][] => cli.appels.filter((a) => a[0] === verbe);

  /** `<S>/alice/work` remplacé par un lien vers un dossier hors de l'arbre. */
  function travailEnLien(): string {
    const ailleurs = path.join(tmp, "ailleurs");
    mkdirSync(ailleurs);
    renameSync(travail, `${travail}.garde`);
    symlinkSync(ailleurs, travail);
    return ailleurs;
  }

  it("conteneur arrêté sur son arbre et son /work : redémarré tel quel", async () => {
    const { sb, cli } = bac(travail);
    await sb.ensureRunningLocked(ARRETE);
    expect([appels(cli, "start").length, appels(cli, "rm").length, appels(cli, "run").length]).toEqual([
      1, 0, 0,
    ]);
  });

  it("conteneur arrêté, /work remplacé par un lien : refusé sans être redémarré ni retiré (sa couche gardée)", async () => {
    travailEnLien();
    const { sb, cli } = bac(travail);
    await expect(sb.ensureRunningLocked(ARRETE)).rejects.toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    expect([appels(cli, "start"), appels(cli, "run"), appels(cli, "rm")]).toEqual([[], [], []]);
    expect(avertis.join("\n")).toContain("relancez sudo ./elpis service install");
  });

  it("conteneur en marche monté ailleurs, arbre refusé : rien retiré, montage jamais tenu pour vérifié", async () => {
    travailEnLien();
    const { sb, cli } = bac(path.join(S, "bob", "work"));
    cli.suspendre = (args) =>
      args[0] === "container" && args[1] === "inspect"
        ? Promise.resolve([
            0,
            Buffer.from("abc|/elpis-sb-alice|true|elpis/sandbox:1.8.0|x\n"),
            Buffer.alloc(0),
          ])
        : null;
    await expect(sb.ensureRunning()).rejects.toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    expect([appels(cli, "rm"), appels(cli, "run"), sb.mountVerified]).toEqual([[], [], false]);
  });

  it("conteneur arrêté en échec, dossier de l'agent refusé : refus avant de rien retirer", async () => {
    chmodSync(path.join(S, "alice", ".elpis-agent"), 0o777);
    const { sb, cli } = bac(travail, "alice", travail, 1, [{ motif: ["~ExitCode"], out: "1|false" }]);
    espions.refus.actif = true;
    await expect(sb.ensureRunningLocked(ARRETE)).rejects.toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    expect([appels(cli, "rm"), appels(cli, "run")]).toEqual([[], []]);
  });

  it("options périmées (étiquette d'utilisateur absente), recréation reportée faute d'image : aucune étape root dans le conteneur", async () => {
    const cfg = sandboxAdminConfigDepuis({ network_profiles: PROFILS }, () => undefined);
    const temoin = new UserSandbox(1, "alice", travail, cfg, "isolated", { cli: new FauxCli() });
    const cli = new FauxCli([
      { motif: ["container", "inspect"], out: "abc|/elpis-sb-alice|true|elpis/sandbox:1.8.0|x\n" },
      { motif: ["~.Mounts"], out: `${travail}\n` },
      {
        motif: ["~elpis.netcfg"],
        out: `${netcfgHash(temoin.networkProfile)}|${RUN_SPEC}|${cfg.image}|${agentEmpreinte()}|${empreinteDemarrage()}|0|\n`,
      },
      { motif: ["image", "inspect"], rc: 1 },
    ]);
    const sb = new UserSandbox(1, "alice", travail, cfg, "isolated", {
      cli,
      chargerImage: async (image: string) => ({
        status: "not_found",
        image,
        started_at: null,
        finished_at: null,
        archive_path: null,
        error: "archive introuvable",
        progress_msg: "x",
      }),
    });
    await sb.ensureRunning();
    expect(sb.recreationReportee).not.toBe("");
    expect(cli.appels.filter((a) => a[0] === "exec" && a.includes("0:0"))).toEqual([]);
    expect(avertis.join("\n")).toContain("étape root écartée");
  });

  it("conteneur arrêté : verrou et sockets d'un autre UID retirés avant docker start", async () => {
    const agent = path.join(S, "alice", ".elpis-agent");
    for (const f of ["agent.lock", "agent.sock", "browser-ca.crt"]) writeFileSync(path.join(agent, f), "");
    for (const f of ["agent.lock", "agent.sock"]) espions.etrangers.add(f);
    const { sb, cli } = bac(travail);
    let auDemarrage: string[] = [];
    cli.suspendre = (args) => {
      if (args[0] === "start") auDemarrage = readdirSync(agent).sort();
      return null;
    };
    await sb.ensureRunningLocked(ARRETE);
    expect([appels(cli, "start").length, appels(cli, "rm").length, auDemarrage]).toEqual([
      1,
      0,
      ["browser-ca.crt"],
    ]);
  });

  it("utilisateur des entrées en étiquette : changé (ou étiquette absente), le conteneur arrêté est recréé, jamais redémarré", async () => {
    const { sb } = bac(travail);
    expect(sb.buildRunArgs(sb.networkProfile, {})).toContain(`elpis.exec=${sb.utilisateurExec()}`);
    expect(await sb.configMatches()).toBe(true);
    for (const exec of ["0:0", ""]) {
      const autre = bac(travail, "alice", travail, 1, [], exec);
      expect(await autre.sb.configMatches()).toBe(false);
      await autre.sb.ensureRunningLocked(ARRETE);
      expect([
        appels(autre.cli, "start").length,
        appels(autre.cli, "rm").length,
        appels(autre.cli, "run").length,
      ]).toEqual([0, 1, 1]);
    }
  });

  it("conteneur arrêté monté sur un autre dossier ou sur un dossier disparu : recréé sur le sien, jamais redémarré", async () => {
    for (const source of [path.join(S, "bob", "work"), path.join(S, "disparu", "work"), ""]) {
      const { sb, cli } = bac(source);
      await sb.ensureRunningLocked(ARRETE);
      expect([appels(cli, "start").length, appels(cli, "rm").length, appels(cli, "run").length]).toEqual([
        0, 1, 1,
      ]);
      expect(appels(cli, "run")[0]).toContain(`${travail}:/work:rw`);
    }
  });

  it("création sur un /work en lien ou un dossier de compte en lien vers un autre : refusée avant de rien créer, aucun docker run", async () => {
    const lien = bac(travail);
    travailEnLien();
    rmSync(path.join(S, "alice", ".elpis-agent"), { recursive: true });
    await expect(lien.sb.ensureRunningLocked(ABSENT)).rejects.toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    expect([appels(lien.cli, "run"), existsSync(path.join(S, "alice", ".elpis-agent"))]).toEqual([[], false]);
    symlinkSync(path.join(S, "bob"), path.join(S, "carol"));
    writeFileSync(path.join(S, "bob", ".elpis-agent", "agent.lock"), "");
    espions.etrangers.add("agent.lock");
    const autre = bac(path.join(S, "bob", "work"), "carol", path.join(S, "bob", "work"), 2);
    await expect(autre.sb.ensureRunningLocked(ABSENT)).rejects.toThrow(new ExecError(DEMARRAGE_IMPOSSIBLE));
    const agentDeBob = existsSync(path.join(S, "bob", ".elpis-agent", "agent.lock"));
    expect([appels(autre.cli, "run"), agentDeBob]).toEqual([[], true]);
    const misDeCote = path.join(S, ".supprime-2-7");
    mkdirSync(path.join(misDeCote, "work"), { recursive: true });
    chmodSync(misDeCote, 0o2750);
    const garde = bac(path.join(misDeCote, "work"), "carol", path.join(misDeCote, "work"), 2);
    await garde.sb.ensureRunningLocked(ABSENT);
    expect(appels(garde.cli, "run")).toHaveLength(1);
  });

  it("création : verrou et sockets de l'agent laissés par un autre UID retirés une fois les montages vérifiés, le reste gardé", async () => {
    const agent = path.join(S, "alice", ".elpis-agent");
    for (const f of ["agent.lock", "agent.sock", "browser-ca.crt"]) writeFileSync(path.join(agent, f), "");
    for (const f of ["agent.lock", "agent.sock", "browser-ca.crt"]) espions.etrangers.add(f);
    const { sb, cli } = bac(travail);
    await sb.ensureRunningLocked(ABSENT);
    expect([appels(cli, "run").length, readdirSync(agent)]).toEqual([1, ["browser-ca.crt"]]);
  });

  /** Docker à état pour `cli` : conteneur présent ou non (retiré par rm, créé par run), /work monté sur `monte` puis sur le /work de la création. */
  function aEtat(cli: FauxCli, monte: string, present = true): { monte: string } {
    const etat = { monte };
    cli.suspendre = (args) => {
      if (args[0] === "rm") present = false;
      if (args[0] === "run") {
        present = true;
        const v = args[args.indexOf("-v") + 1];
        etat.monte = String(v).slice(0, String(v).indexOf(":/work"));
      }
      if (args[0] === "inspect" && String(args[2]).includes(".Mounts"))
        return Promise.resolve([0, Buffer.from(`${etat.monte}\n`), Buffer.alloc(0)]);
      if (args[0] !== "container" || args[1] !== "inspect") return null;
      const ligne = `abc|/${String(args[2])}|true|elpis/sandbox:1.8.0|2026-10-10T00:00:00Z\n`;
      return Promise.resolve(
        present ? [0, Buffer.from(ligne), Buffer.alloc(0)] : [1, Buffer.alloc(0), Buffer.alloc(0)],
      );
    };
    return etat;
  }

  it("purge d'un bac mis de côté pendant qu'un compte du même nom est en marche : son propre conteneur, jamais celui du compte", async () => {
    const misDeCote = path.join(S, ".supprime-2-7");
    mkdirSync(path.join(misDeCote, "work"), { recursive: true });
    chmodSync(misDeCote, 0o2750);
    const { sb, cli } = bac(path.join(misDeCote, "work"), "alice", path.join(misDeCote, "work"), 2);
    aEtat(cli, "", false);
    await sb.purge();
    const noms = cli.appels.flatMap((a) =>
      a.filter((x) => typeof x === "string" && x.startsWith("elpis-sb-")),
    );
    expect([...new Set(noms)]).toEqual(["elpis-sb-.supprime-2-7"]);
    expect(appels(cli, "run")[0]).toContain("elpis.username=.supprime-2-7");
    expect(cli.appels.some((a) => a.includes("find"))).toBe(true);
  });

  it("purge : /work qui ne monte plus le bac juste avant le vidage (conteneur recréé entre-temps) : rien vidé", async () => {
    const { sb, cli } = bac(travail);
    const etat = aEtat(cli, travail);
    const avant = cli.suspendre;
    cli.suspendre = (args) => {
      if (args.includes("pkill")) etat.monte = path.join(S, "bob", "work");
      return avant?.(args) ?? null;
    };
    await expect(sb.purge()).rejects.toThrow("/work ne monte pas");
    expect(cli.appels.some((a) => a.includes("find"))).toBe(false);
  });

  it("purge par une instance déjà vérifiée d'un conteneur en marche monté sur un autre dossier : recréé sur le sien avant d'être vidé", async () => {
    const { sb, cli } = bac(path.join(S, "bob", "work"), "alice", path.join(S, "alice", "work"));
    sb.mountVerified = true;
    aEtat(cli, path.join(S, "bob", "work"));
    await sb.purge();
    const verbes = cli.appels.map((a) =>
      a[0] === "exec" ? a.find((x) => x === "find" || x === "pkill") : a[0],
    );
    expect(verbes.filter((v) => ["rm", "run", "pkill", "find"].includes(String(v)))).toEqual([
      "rm",
      "run",
      "pkill",
      "find",
      "rm",
    ]);
    expect(appels(cli, "run")[0]).toContain(`${travail}:/work:rw`);
    expect(existsSync(path.join(S, "bob", "work"))).toBe(true);
  });
});

describe("marqueurs de P", () => {
  it("lus et écrits sans suivre de lien ; fichier spécial ou lien : absent pour la lecture, refusé pour l'écriture", () => {
    const m = path.join(tmp, ".work-modes-v1");
    expect(lireMarqueur(m)).toBeNull();
    ecrireMarqueur(m, "10001:10001");
    expect(lireMarqueur(m)?.toString("utf8")).toBe("10001:10001");
    ecrireMarqueur(m, "1");
    expect(readFileSync(m, "utf8")).toBe("1");
    const cible = path.join(tmp, "cible");
    writeFileSync(cible, "intact");
    const lien = path.join(tmp, ".work-migrated");
    symlinkSync(cible, lien);
    expect(lireMarqueur(lien)).toBeNull();
    expect(() => ecrireMarqueur(lien, "1")).toThrow();
    const fifo = path.join(tmp, "fifo");
    execFileSync("mkfifo", [fifo]);
    expect(lireMarqueur(fifo)).toBeNull();
    expect(() => ecrireMarqueur(fifo, "1")).toThrow();
    expect(readFileSync(cible, "utf8")).toBe("intact");
  });
});
