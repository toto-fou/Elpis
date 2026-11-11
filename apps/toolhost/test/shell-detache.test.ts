// SPDX-License-Identifier: MIT
/** apps/toolhost/test/shell-detache.test.ts — execute_shell(on_timeout="detach_and_wake") (JB-18) de bout en bout : vrai agent Python (sans conteneur), faux core joint par le vrai client de rappel, client MCP en mémoire. */
import { readFileSync } from "node:fs";

import type { Dict } from "@elpis/commun";
import { AgentClient, AgentError } from "@elpis/fichiers";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BacTest, dossierTemporaire } from "../../../packages/fichiers/test/aides";
import { reglagesDetache } from "../src/mcp/shell/jobs/detache";
import { reglagesShellJob } from "../src/mcp/shell/jobs/outil";
import type { AppuisJobs } from "../src/mcp/shell/jobs/outil";
import { reglagesVeille, VeilleurJobs } from "../src/mcp/shell/jobs/veilleur";
import { outilsShell } from "../src/mcp/shell/outil";
import type { AppuisShell } from "../src/mcp/shell/outil";
import { ClientRappel } from "../src/rappel";
import { journalMuet, SVC } from "./aides";
import { FauxCore } from "./faux-core-jobs";

const UID = 42;
const META = { username: "alice", user_id: String(UID), chat_id: "c-1", call_id: "k1" };
const REGLAGES_DETACHE = { ...reglagesDetache };
const REGLAGES_VEILLE = { ...reglagesVeille };
const REGLAGES_JOB = { ...reglagesShellJob };

let racine = "";
let nettoyer: () => void = () => undefined;
let test: BacTest;
let agent: AgentClient;
let core: FauxCore;
let rappel: ClientRappel;
let veilleur: VeilleurJobs;
const audits: Dict[] = [];
const groupes: number[] = [];
const fermetures: (() => Promise<void>)[] = [];

beforeEach(async () => {
  [racine, nettoyer] = dossierTemporaire("elpis-test-jobs-");
  test = new BacTest(racine, "alice");
  agent = new AgentClient(test);
  core = new FauxCore();
  await core.demarrer();
  rappel = new ClientRappel({ appUrl: core.url, jeton: SVC, journal: journalMuet });
  Object.assign(reglagesVeille, {
    repriseMinMs: 50,
    repriseMaxMs: 200,
    arretConfirmeMs: 100,
    confirmationS: 0,
  });
  Object.assign(reglagesShellJob, { repriseEtatMs: 50, graceKillS: 1 });
  Object.assign(reglagesDetache, { sondeMs: 50 });
  veilleur = nouveauVeilleur();
  audits.length = 0;
});

afterEach(async () => {
  veilleur.arreter();
  await veilleur.calme();
  for (const f of fermetures.splice(0)) await f();
  for (const pid of groupes.splice(0))
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // groupe déjà fini
    }
  Object.assign(reglagesVeille, REGLAGES_VEILLE);
  Object.assign(reglagesShellJob, REGLAGES_JOB);
  Object.assign(reglagesDetache, REGLAGES_DETACHE);
  await test.arreter();
  await core.fermer();
  nettoyer();
});

function nouveauVeilleur(): VeilleurJobs {
  return new VeilleurJobs({ agent: async () => agent, relais: rappel, journal: null });
}

function appuisJobs(): AppuisJobs {
  return {
    racine: async () => test.sandboxPath,
    userIdFor: async () => UID,
    stats: (_u, _r, rels) => agent.stat(rels),
    bac: async () => ({ containerName: "elpis-sb-alice", agent }),
    rappel,
    veilleur: () => veilleur,
    auditer: (o) => audits.push({ ...o }),
  };
}

const lances: string[][] = [];

/** Client MCP en mémoire sur la famille shell : bac et agent de test, exécuteur historique doublé (chemin `kill`). */
async function client(): Promise<Client> {
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  const appuis: AppuisShell = {
    racine: async () => test.sandboxPath,
    stats: (_u, _r, rels) => agent.stat(rels),
    userIdFor: async () => UID,
    releve: () => ({ debut: async () => undefined, fin: async () => undefined, attacher: (r) => r }),
    executer: async (o) => {
      lances.push([...o.tokens]);
      return o.timeoutS <= 1
        ? {
            ok: false,
            error: "timeout",
            returncode: 124,
            stdout: "",
            stderr: "",
            cmd: o.tokens,
            cwd: "/work",
          }
        : { ok: true, returncode: 0, stdout: "legacy", stderr: "", cmd: o.tokens, cwd: "/work" };
    },
    plancherDebord: () => 1_000_000,
    jobs: appuisJobs(),
  };
  serveur.enregistrerFamille("shell", outilsShell(appuis));
  const cnx = await ouvrirEnMemoire(serveur, { famille: "shell" });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(cnx.transport);
  fermetures.push(() => cnx.fermer());
  return c;
}

async function shell(c: Client, args: Dict, meta: Dict = META): Promise<Dict> {
  const rep = (await c.callTool({ name: "execute_shell", arguments: args, _meta: meta })) as Dict;
  const sc = rep["structuredContent"] as Dict | undefined;
  const texte = ((rep["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}";
  const r = (sc?.["result"] as Dict | undefined) ?? (JSON.parse(texte) as Dict);
  if (typeof r["pid"] === "number") groupes.push(r["pid"]);
  return r;
}

function vivant(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

async function jusqua(f: () => boolean, ms = 10_000): Promise<void> {
  const fin = Date.now() + ms;
  while (!f()) {
    if (Date.now() > fin) throw new Error("condition non atteinte");
    await new Promise((ok) => setTimeout(ok, 25));
  }
}

const DETACHE = { on_timeout: "detach_and_wake" };

describe("execute_shell(on_timeout)", () => {
  it("JB-18 : commande courte → résultat normal fusionné, marqué livré dès le résultat, job terminé, aucun job actif", async () => {
    const c = await client();
    const r = await shell(c, {
      command: "echo sortie; echo erreur >&2; exit 3",
      timeout_sec: 20,
      ...DETACHE,
    });
    expect(r["ok"]).toBe(false);
    expect(r["returncode"]).toBe(3);
    expect(r["merged_output"]).toBe(true);
    expect(String(r["stdout"])).toContain("sortie");
    expect(String(r["stdout"])).toContain("erreur");
    expect(r["stderr"]).toBe("");
    expect(r["cmd"]).toBe("echo sortie; echo erreur >&2; exit 3");
    expect(r["detached"]).toBeUndefined();
    expect(core.jobs.size).toBe(1);
    const id = [...core.jobs.keys()][0] ?? "";
    expect(core.livres.has(id)).toBe(true);
    await core.attendre((x) => x["job_id"] === id && x["trigger"] === "exit");
    const j = core.jobs.get(id);
    expect(j?.state).toBe("exited");
    expect(j?.exit_code).toBe(3);
    expect(core.livres.has(j?.job_id ?? "")).toBe(true);
    expect(core.actifs("c-1", UID)).toHaveLength(0);
    expect(lances).toHaveLength(0);
  });

  it("JB-18 : commande longue → detached avec job_id, non tuée, événement exit relayé à la fin, non marquée livrée", async () => {
    const c = await client();
    const marqueur = `${racine}/fin.txt`;
    const r = await shell(c, { command: `sleep 3; echo fini > ${marqueur}`, timeout_sec: 1, ...DETACHE });
    expect(r["ok"]).toBe(true);
    expect(r["detached"]).toBe(true);
    expect(r["job_id"]).toMatch(/^j-[0-9a-f]{8}$/u);
    expect(r["wake_on"]).toEqual(["exit"]);
    expect(String(r["hint"])).toContain("end your turn");
    expect(String(r["hint"])).toContain("Do not poll");
    expect(r["log"]).toBe(`/work/.bg/job-${String(r["job_id"])}.log`);
    const pid = r["pid"] as number;
    groupes.push(pid);
    expect(vivant(pid)).toBe(true);
    const jobId = String(r["job_id"]);
    expect(core.jobs.get(jobId)?.wake).toBe(true);
    const e = await core.attendre((x) => x["job_id"] === jobId && x["trigger"] === "exit");
    expect(e.event["exit_code"]).toBe(0);
    expect(readFileSync(marqueur, "utf-8")).toBe("fini\n");
    expect(core.livres.has(jobId)).toBe(false);
  });

  it("Stop pendant l'attente : la sonde s'arrête, le job n'est pas marqué livré, son exit est relayé (réveil ordinaire)", async () => {
    const c = await client();
    const ctl = new AbortController();
    const appel = c.callTool(
      {
        name: "execute_shell",
        arguments: { command: "sleep 1.5", timeout_sec: 30, ...DETACHE },
        _meta: META,
      },
      undefined,
      { signal: ctl.signal },
    );
    await jusqua(() => core.jobs.size === 1);
    ctl.abort();
    await expect(appel).rejects.toThrow();
    const id = [...core.jobs.keys()][0] ?? "";
    await core.attendre((x) => x["job_id"] === id && x["trigger"] === "exit");
    await new Promise((ok) => setTimeout(ok, 400));
    expect(core.livres.has(id)).toBe(false);
  });

  it("réponse du lancement perdue (délai) : l'agent connaît le job → suivi tel quel, jamais relancé ni exécuté en synchrone", async () => {
    const vrai = agent.jobsStart.bind(agent);
    agent.jobsStart = async (o) => {
      await vrai(o);
      throw new AgentError("timeout", "agent muet : ReadTimeout");
    };
    const avant = lances.length;
    const c = await client();
    const passages = `${racine}/passages.txt`;
    const r = await shell(c, { command: `echo x >> ${passages}; sleep 2`, timeout_sec: 1, ...DETACHE });
    expect(r).toMatchObject({ ok: true, detached: true });
    expect(r["on_timeout_fallback"]).toBeUndefined();
    expect(lances.length).toBe(avant);
    const id = String(r["job_id"]);
    expect(core.jobs.get(id)?.state).toBe("running");
    await core.attendre((x) => x["job_id"] === id && x["trigger"] === "exit");
    expect(readFileSync(passages, "utf-8")).toBe("x\n");
  });

  it("lancement incertain (agent muet, fiche illisible) : `launch_unconfirmed`, ni repli synchrone ni échec posé, la veille tranche", async () => {
    Object.assign(reglagesVeille, { attenteS: 1 });
    agent.jobsStart = async () => {
      throw new AgentError("timeout", "agent muet : ReadTimeout");
    };
    agent.jobsStatus = async () => {
      throw new AgentError("transport", "ReadError: socket fermée");
    };
    const avant = lances.length;
    const c = await client();
    const r = await shell(c, { command: "sleep 5", timeout_sec: 1, ...DETACHE });
    expect(r).toMatchObject({ ok: false, error: "launch_unconfirmed" });
    expect(String(r["fix"])).toContain("Do not start it again");
    expect(lances.length).toBe(avant);
    const id = String(r["job_id"]);
    expect(core.etats.some((e) => e["job_id"] === id && e["state"] === "failed")).toBe(false);
    await core.attendre((x) => x["job_id"] === id && x["trigger"] === "lost");
  });

  it("JB-11 : commande détachée à la limite de chaîne → job sans réveil, avertissement, l'indication ne promet aucun réveil", async () => {
    const c = await client();
    core.profondeur = 5;
    const r = await shell(c, { command: "sleep 3", timeout_sec: 1, ...DETACHE });
    expect(r).toMatchObject({
      ok: true,
      detached: true,
      chain_depth: 5,
      max_chain_depth: 5,
      warning: "wake chain limit reached (5/5): this job will not wake you; hand back to the user",
    });
    expect(String(r["hint"])).toContain("it will not wake you (wake chain limit)");
    expect(String(r["hint"])).not.toContain("you will be woken");
    expect(core.jobs.get(String(r["job_id"]))?.wake).toBe(false);
  });

  it("kill par défaut inchangé : exécuteur historique, aucun job enregistré, aucun champ ajouté", async () => {
    const c = await client();
    const r = await shell(c, { command: "echo x", timeout_sec: 5 });
    expect(r["stdout"]).toBe("legacy");
    expect(r["merged_output"]).toBeUndefined();
    expect(r["on_timeout_fallback"]).toBeUndefined();
    const k = await shell(c, { command: "sleep 9", timeout_sec: 1, on_timeout: "kill" });
    expect(k["returncode"]).toBe(124);
    expect(String(k["fix"])).toContain('on_timeout="detach_and_wake"');
    expect(core.jobs.size).toBe(0);
    expect(lances).toHaveLength(2);
  });

  it("repli quand le core refuse (sous-agent, routine, limite) : comportement kill et raison dans on_timeout_fallback", async () => {
    const c = await client();
    core.refus = {
      ok: false,
      error: "not_available_here",
      message: "Background jobs need a saved conversation.",
    };
    const r = await shell(c, { command: "sleep 9", timeout_sec: 1, ...DETACHE });
    expect(r["returncode"]).toBe(124);
    expect(String(r["on_timeout_fallback"])).toContain("not_available_here");
    core.refus = { ok: false, error: "limit_exceeded", message: "Too many background jobs (3/3)." };
    const l = await shell(c, { command: "echo x", timeout_sec: 5, ...DETACHE });
    expect(l["stdout"]).toBe("legacy");
    expect(String(l["on_timeout_fallback"])).toContain("limit_exceeded");
    expect(core.jobs.size).toBe(0);
  });

  it("repli sans conversation, avec stdin ou save_stdout, ou sans registre de jobs", async () => {
    const c = await client();
    const sans = await shell(
      c,
      { command: "echo x", ...DETACHE },
      { username: "alice", user_id: String(UID) },
    );
    expect(String(sans["on_timeout_fallback"])).toContain("not_available_here");
    const avec = await shell(c, { command: "cat", stdin: "a", ...DETACHE });
    expect(String(avec["on_timeout_fallback"])).toContain("stdin");
    const sauve = await shell(c, { command: "echo x", save_stdout: "o.txt", ...DETACHE });
    expect(String(sauve["on_timeout_fallback"])).toContain("save_stdout");
    expect(core.jobs.size).toBe(0);
  });

  it("limite du core atteinte par trois jobs : le quatrième appel se replie, les jobs vivants restent", async () => {
    const c = await client();
    const d = [];
    for (let i = 0; i < 3; i++) d.push(await shell(c, { command: "sleep 30", timeout_sec: 1, ...DETACHE }));
    expect(d.every((x) => x["detached"] === true)).toBe(true);
    const q = await shell(c, { command: "echo x", timeout_sec: 5, ...DETACHE });
    expect(String(q["on_timeout_fallback"])).toContain("limit_exceeded");
    for (const x of d) expect(vivant(x["pid"] as number)).toBe(true);
    await jusqua(() => core.actifs("c-1", UID).length === 3);
  });

  it("strict : set -euo pipefail devant la commande du job", async () => {
    const c = await client();
    const r = await shell(c, { command: "false; echo apres", strict: true, timeout_sec: 20, ...DETACHE });
    expect(r["returncode"]).toBe(1);
    expect(String(r["stdout"])).not.toContain("apres");
  });

  it("sortie plus grande que le plafond : queue gardée, journal complet indiqué", async () => {
    const c = await client();
    const r = await shell(c, { command: "seq 1 8000", timeout_sec: 20, ...DETACHE });
    expect(r["truncated"]).toBe(true);
    expect(String(r["stdout"])).toContain("8000");
    expect(String(r["saved_to"])).toMatch(/^\/work\/\.bg\/job-j-[0-9a-f]{8}\.log$/u);
  });
});
