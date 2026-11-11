// SPDX-License-Identifier: MIT
/** packages/bac/test/vecteurs.test.ts — vecteurs du vrai Python (migration-kit/vecteurs/bac.py) : `docker run`, privdrop, capture bornée, et scénarios de cycle de vie rejoués sur le même faux docker (appels, résultats, état). */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { surchargerConfig } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  bwrap,
  CAPABILITIES,
  candidateTarPaths,
  CaptureBornee,
  configuredImage,
  DEFAULT_IMAGE,
  definirFabriqueAgent,
  ExecError,
  mib,
  netcfgHash,
  privdrop,
  profilReseauDepuis,
  reglagesBac,
  reglagesMontages,
  resolveNetworkProfileIdReglages,
  RUN_SPEC,
  sandboxAdminConfigDepuis,
  UserSandbox,
  agentEmpreinte,
} from "../src/index";
import type { EtatBac, ImageLoadState, ImageLoadStatus } from "../src/index";
import { ENVELOPPE_EXEC } from "../src/conteneur";
import { racineDepot } from "@elpis/config";
import { dossierTemporaire, FauxCli } from "./aides";
import type { Regle } from "./aides";

interface Scenario {
  nom: string;
  methode: string;
  executors: Record<string, unknown>;
  profil: string | null;
  resolus: Record<string, string[]>;
  st: EtatBac | null;
  args: {
    cmd?: string[];
    workdir?: string;
    env?: Record<string, string>;
    stdin?: string;
    timeout_s?: number;
    replace?: boolean;
  };
  chargement: ImageLoadStatus | null;
  marqueur_avant: string | null;
  regles: Regle[];
  processus: [number, string, string] | null;
  appels: unknown[][];
  lances: string[][];
  agent: string[];
  stdin: [string, boolean] | null;
  resultat: { valeur: unknown } | { erreur: string; message: string; logs: string | null };
  etat: Record<string, unknown>;
}

/** Écart voulu au Python (harnais SH-10) : l'enveloppe des exec tue aussi le reste du groupe et les descendants marqués à l'échéance. */
const ENVELOPPE_PYTHON = JSON.stringify('umask 0022; t="$1"; shift; exec timeout -k 5 "$t" "$@"').slice(
  1,
  -1,
);
const BRUT = readFileSync(new URL("./vecteurs/bac.json", import.meta.url), "utf-8");
const ENVELOPPES_REMPLACEES = BRUT.split(ENVELOPPE_PYTHON).length - 1;
const V = JSON.parse(
  BRUT.replaceAll(ENVELOPPE_PYTHON, () => JSON.stringify(ENVELOPPE_EXEC).slice(1, -1)),
) as {
  agent: string;
  agent_empreinte: string;
  capabilities: string[];
  bwrap_base: string[];
  run_spec: string;
  default_image: string;
  run_args: {
    executors: unknown;
    profil: string | null;
    resolus: Record<string, string[]> | null;
    uid: number;
    nom: string;
    chemin: string;
    conteneur: string;
    profil_effectif: string;
    image: string;
    argv: string[];
  }[];
  netcfg: { profil: Record<string, unknown>; hash: string }[];
  images: { valeur: unknown; image: string }[];
  archives: { image: string; chemins: string[] }[];
  privdrop: {
    exec_user: string;
    argv: string[] | null;
    sonde: string[] | null;
    resolu: [string, string[]][];
  }[];
  mib: ({ texte: string; mib: number | null } | { texte: string; erreur: string; message: string })[];
  captures: { cap: number; morceaux: string[]; valeur: string; omis: number }[];
  profil_reglages: { reglages: unknown; profil: string }[];
  scenarios: Scenario[];
};

const muet = (): void => undefined;

beforeAll(() => {
  reglagesMontages.agentDir = V.agent;
  vi.stubEnv("SANDBOX_READINESS_CACHE", "0");
});

afterAll(() => {
  reglagesMontages.agentDir = null;
  vi.unstubAllEnvs();
});

describe("constantes", () => {
  it("options communes de la prison bwrap", () => {
    expect(bwrap.baseArgv()).toEqual(V.bwrap_base);
  });

  it("capacités, version des options, image livrée, empreinte de l'agent", () => {
    expect([CAPABILITIES, RUN_SPEC, DEFAULT_IMAGE, agentEmpreinte()]).toEqual([
      V.capabilities,
      V.run_spec,
      V.default_image,
      V.agent_empreinte,
    ]);
  });
});

describe("_build_run_args", () => {
  it.each(V.run_args.map((c) => [`${c.nom || "(vide)"} ${c.profil ?? "-"}`, c] as const))("%s", (_n, c) => {
    const cfg = sandboxAdminConfigDepuis(c.executors, muet);
    const sb = new UserSandbox(c.uid, c.nom, c.chemin, cfg, c.profil, { cli: new FauxCli() });
    expect([sb.containerName, sb.networkProfile.id, cfg.image]).toEqual([
      c.conteneur,
      c.profil_effectif,
      c.image,
    ]);
    expect(sb.buildRunArgs(sb.networkProfile, c.resolus)).toEqual(c.argv);
  });
});

describe("empreintes, images, archives, profil des réglages", () => {
  it("netcfg_hash", () => {
    for (const c of V.netcfg)
      expect(netcfgHash(profilReseauDepuis(c.profil, muet)), String(c.profil["id"])).toBe(c.hash);
  });
  it("configured_image", () => {
    for (const c of V.images) expect(configuredImage(c.valeur), JSON.stringify(c.valeur)).toBe(c.image);
  });
  it("_candidate_tar_paths", () => {
    for (const c of V.archives)
      expect(candidateTarPaths(c.image).map((p) => p.replace(racineDepot(), "{racine}"))).toEqual(c.chemins);
  });
  it("resolve_network_profile_id", () => {
    for (const c of V.profil_reglages) expect(resolveNetworkProfileIdReglages(c.reglages)).toBe(c.profil);
  });
});

describe("privdrop", () => {
  it.each(V.privdrop.map((c) => [JSON.stringify(c.exec_user), c] as const))("%s", (_n, c) => {
    privdrop.oublierSondes();
    expect(privdrop.privdropArgv(c.exec_user)).toEqual(c.argv);
    expect(privdrop.probeArgv("c", c.exec_user)).toEqual(c.sonde);
    const avant = privdrop.resolve("c", c.exec_user);
    privdrop.remember("c", c.exec_user, true);
    const oui = privdrop.resolve("c", c.exec_user);
    privdrop.remember("c", c.exec_user, false);
    expect([avant, oui, privdrop.resolve("c", c.exec_user)]).toEqual(c.resolu);
    privdrop.oublierSondes();
  });
});

describe("_mib et _BoundedCapture", () => {
  it("_mib", () => {
    for (const c of V.mib) {
      if ("erreur" in c) {
        expect(() => mib(c.texte), c.texte).toThrow(c.message);
        continue;
      }
      const v = mib(c.texte);
      if (c.mib === null) expect(v, c.texte).toBeNull();
      else expect(v, c.texte).toBeCloseTo(c.mib, 12);
    }
  });
  it("capture bornée : tête, queue, milieu compté", () => {
    for (const c of V.captures) {
      const b = new CaptureBornee(c.cap);
      for (const m of c.morceaux) b.add(Buffer.from(m, "hex"));
      expect([b.value().toString("hex"), b.dropped]).toEqual([c.valeur, c.omis]);
    }
  });
});

/** Mode Unix en texte `oct()` de Python. */
function oct(mode: number): string {
  return `0o${(mode & 0o777).toString(8)}`;
}

async function jouer(sc: Scenario, sb: UserSandbox, cli: FauxCli): Promise<unknown> {
  const a = sc.args;
  switch (sc.methode) {
    case "_ensure_running_locked":
      return sb.ensureRunningLocked(sc.st as EtatBac);
    case "_config_matches":
      return sb.configMatches();
    case "container_ip":
      return sb.containerIp();
    case "daemon_reachable":
      return sb.daemonReachable();
    case "start_agent":
      await sb.startAgent(a.replace ?? false);
      return null;
    case "exec": {
      if (sc.processus) cli.processus = { rc: sc.processus[0], out: sc.processus[1], err: sc.processus[2] };
      const r = await sb.exec(a.cmd ?? [], {
        ...(a.workdir ? { workdirInContainer: a.workdir } : {}),
        ...(a.env ? { env: a.env } : {}),
        ...(a.timeout_s ? { timeoutS: a.timeout_s } : {}),
        ...(a.stdin !== undefined ? { stdin: Buffer.from(a.stdin) } : {}),
      });
      return {
        returncode: r.returncode,
        stdout: r.stdout.toString("latin1"),
        stderr: r.stderr.toString("latin1"),
        timed_out: r.timed_out,
        executor_tag: r.executor_tag,
        container_id: r.container_id,
      };
    }
    case "stop":
    case "destroy":
    case "purge":
      await sb[sc.methode]();
      return null;
    case "restart":
      return sb.restart();
    case "ensure_running":
      return sb.ensureRunning();
    case "status":
      return sb.status();
    case "stats":
      return sb.stats();
  }
  throw new Error(`méthode inconnue : ${sc.methode}`);
}

describe("scénarios de cycle de vie (faux docker)", () => {
  it("écart SH-10 déclaré : l'enveloppe Python des exec remplacée dans les vecteurs", () => {
    expect(ENVELOPPES_REMPLACEES).toBeGreaterThan(0);
  });

  it.each(V.scenarios.map((s) => [s.nom, s] as const))("%s", async (_n, sc) => {
    const [tmp, nettoyer] = dossierTemporaire("elpis-bac-vecteurs-");
    const racine = path.join(tmp, "sb");
    const travail = path.join(racine, "alice", "work");
    mkdirSync(travail, { recursive: true });
    if (sc.marqueur_avant)
      writeFileSync(path.join(racine, "alice", ".work-modes-v1"), sc.marqueur_avant, "utf-8");
    const restaurer = surchargerConfig({ SANDBOX_DIR: racine });
    const attente = reglagesBac.attenteCreationMs;
    reglagesBac.attenteCreationMs = 0;
    const agent: string[] = [];
    definirFabriqueAgent(() => ({
      hello: async () => {
        agent.push("hello");
        return {};
      },
      archive: () => Promise.reject(new Error("inutile")),
      extract: () => Promise.reject(new Error("inutile")),
    }));
    privdrop.oublierSondes();
    try {
      const regles = JSON.parse(JSON.stringify(sc.regles).replaceAll("{racine}", racine)) as Regle[];
      const cli = new FauxCli(regles);
      const sb = new UserSandbox(
        1,
        "alice",
        travail,
        sandboxAdminConfigDepuis(sc.executors, muet),
        sc.profil,
        {
          cli,
          resoudreDomaines: async () => ({ ...sc.resolus }),
          chargerImage: async (image: string, o: { blocking?: boolean }): Promise<ImageLoadState> => {
            cli.appels.push(["<charger>", image, o.blocking ?? false]);
            const status = sc.chargement ?? "loaded";
            return {
              status,
              image,
              started_at: null,
              finished_at: null,
              archive_path: null,
              error: status !== "loaded" ? "archive introuvable" : null,
              progress_msg: status === "loading" ? "Chargement de l'image (612 MB)…" : "x",
            };
          },
        },
      );
      let resultat: unknown;
      try {
        resultat = { valeur: (await jouer(sc, sb, cli)) ?? null };
      } catch (e) {
        resultat = {
          erreur: (e as Error).name,
          message: (e as Error).message,
          logs: e instanceof ExecError ? e.containerLogs : null,
        };
      }
      const remplacer = (v: unknown): unknown => JSON.parse(JSON.stringify(v).replaceAll(racine, "{racine}"));
      const marqueur = path.join(racine, "alice", ".work-modes-v1");
      const dossierAgent = path.join(racine, "alice", ".elpis-agent");
      expect(remplacer(cli.appels)).toEqual(sc.appels);
      expect(remplacer(cli.lances)).toEqual(sc.lances);
      expect(remplacer(resultat)).toEqual(sc.resultat);
      expect(agent).toEqual(sc.agent);
      const entree = cli.entrees[0];
      expect(entree ? [entree.recu.toString("latin1"), entree.ferme] : null).toEqual(sc.stdin);
      expect({
        montage: sb.mountVerified,
        config: sb.configVerified,
        droits: sb.modesVerified,
        reportee: sb.recreationReportee,
        reessai: sb.configRetryAt > 0,
        privdrop: privdrop.cached(sb.containerName, sb.cfg.exec_user || "10001:10001"),
        marqueur: existsSync(marqueur) ? readFileSync(marqueur, "utf-8") : null,
        dossier_agent: existsSync(dossierAgent) ? oct(statSync(dossierAgent).mode) : null,
        dossier_relais: existsSync(path.join(racine, ".elpis-relay")),
        racine_privee: (statSync(racine).mode & 0o777) === 0o700,
      }).toEqual(sc.etat);
    } finally {
      definirFabriqueAgent(null);
      reglagesBac.attenteCreationMs = attente;
      restaurer();
      nettoyer();
    }
  });
});
