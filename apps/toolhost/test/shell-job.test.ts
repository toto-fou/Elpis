// SPDX-License-Identifier: MIT
/** apps/toolhost/test/shell-job.test.ts — outil shell_job, veilleur et routes internes de l'hôte de bout en bout : vrai agent Python (sans conteneur), faux core joint par le vrai client de rappel, client MCP en mémoire. */
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";

import type { Dict } from "@elpis/commun";
import { AgentClient } from "@elpis/fichiers";
import { ouvrirEnMemoire, ServeurOutils } from "@elpis/outils-mcp";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BacTest, dossierTemporaire, PYTHON } from "../../../packages/fichiers/test/aides";
import { creerAppToolhost } from "../src/app";
import { appuisParDefaut, outilsShell } from "../src/mcp/shell/outil";
import type { AppuisShell } from "../src/mcp/shell/outil";
import { quantificateursLibres, reglagesShellJob, verifierDeclencheurs } from "../src/mcp/shell/jobs/outil";
import type { AppuisJobs } from "../src/mcp/shell/jobs/outil";
import { creerFamilleJobs } from "../src/mcp/shell/jobs/routes";
import { reglagesVeille, VeilleurJobs } from "../src/mcp/shell/jobs/veilleur";
import { PontExec } from "../src/mcp/shell/pont";
import { ClientRappel } from "../src/rappel";
import { configTest, entetes, journalMuet, SVC } from "./aides";
import { FauxCore } from "./faux-core-jobs";

const UID = 42;
const COMPTE = { user_id: UID, username: "alice" };
const META = { username: "alice", user_id: String(UID), chat_id: "c-1", call_id: "k1" };
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

/** Client MCP en mémoire sur la famille shell (appuis de shell_job doublés sur le bac de test). */
async function client(): Promise<Client> {
  const serveur = new ServeurOutils({ limiteDebit: null, limiteConcurrence: null });
  const appuis: AppuisShell = { ...appuisParDefaut(new PontExec()), jobs: appuisJobs() };
  serveur.enregistrerFamille("shell", outilsShell(appuis));
  const cnx = await ouvrirEnMemoire(serveur, { famille: "shell" });
  const c = new Client({ name: "test", version: "1" });
  await c.connect(cnx.transport);
  fermetures.push(() => cnx.fermer());
  return c;
}

async function job(c: Client, args: Dict, meta: Dict = META): Promise<Dict> {
  const rep = (await c.callTool({ name: "shell_job", arguments: args, _meta: meta })) as Dict;
  const sc = rep["structuredContent"] as Dict | undefined;
  const texte = ((rep["content"] as Dict[])[0]?.["text"] as string | undefined) ?? "{}";
  return (sc?.["result"] as Dict | undefined) ?? (JSON.parse(texte) as Dict);
}

async function demarrer(c: Client, args: Dict): Promise<Dict> {
  const r = await job(c, { action: "start", ...args });
  if (typeof r["pid"] === "number") groupes.push(r["pid"]);
  return r;
}

/** Processus encore vivant (zombie compris comme mort). */
function vivant(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

async function portLibre(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const port = (s.address() as { port: number }).port;
  await new Promise((ok) => s.close(ok));
  return port;
}

async function jusqua(f: () => boolean, ms = 10_000): Promise<void> {
  const fin = Date.now() + ms;
  while (!f()) {
    if (Date.now() > fin) throw new Error("condition non atteinte");
    await new Promise((ok) => setTimeout(ok, 25));
  }
}

async function hoteRoutes(v: VeilleurJobs): Promise<FastifyInstance> {
  const app = await creerAppToolhost({
    tc: configTest(),
    familles: [creerFamilleJobs({ veilleur: () => v, agent: async () => agent })],
    journal: journalMuet,
  });
  fermetures.push(async () => {
    await app.close();
  });
  return app;
}

describe("validation de shell_job (sans agent)", () => {
  it("wake_on : exit en tête, grammaire, bornes, file: confiné (JB-19 côté hôte), regex gardée", () => {
    const r = "/srv/sb/alice/work";
    expect(verifierDeclencheurs(["port:8000", "exit", "file:out/../done.txt"], r)).toEqual([
      "exit",
      "port:8000",
      "file:done.txt",
    ]);
    const code = (f: () => unknown): string => {
      try {
        f();
      } catch (e) {
        return (e as { code: string }).code;
      }
      return "ok";
    };
    expect(code(() => verifierDeclencheurs(["file:../../etc/passwd"], r))).toBe("path_outside_sandbox");
    expect(code(() => verifierDeclencheurs(["file:/etc/passwd"], r))).toBe("path_outside_sandbox");
    expect(code(() => verifierDeclencheurs(["idle:5"], r))).toBe("invalid_argument");
    expect(code(() => verifierDeclencheurs(["port:70000"], r))).toBe("invalid_argument");
    expect(code(() => verifierDeclencheurs(["regex:(a+)+$"], r))).toBe("invalid_argument");
    expect(code(() => verifierDeclencheurs(["regex:a*b*c*"], r))).toBe("invalid_argument");
    expect(code(() => verifierDeclencheurs(["regex:(unclosed"], r))).toBe("invalid_argument");
    expect(code(() => verifierDeclencheurs(["match:" + "x".repeat(400)], r))).toBe("invalid_argument");
    expect(code(() => verifierDeclencheurs(["bogus"], r))).toBe("invalid_argument");
    expect(
      code(() => verifierDeclencheurs(["match:a", "match:b", "match:c", "match:d", "match:e", "match:f"], r)),
    ).toBe("ok");
    expect(
      code(() =>
        verifierDeclencheurs(
          ["match:a", "match:b", "match:c", "match:d", "match:e", "match:f", "idle:10"],
          r,
        ),
      ),
    ).toBe("invalid_argument");
  });

  it("N-19 : wake=false décrit tel qu'il agit (aucun tour démarré, événements joints au prochain résultat d'outil ou message)", () => {
    const def = outilsShell(appuisParDefaut(new PontExec())).find((o) => o.nom === "shell_job")!.definition;
    const description = String(def["description"]);
    const wake = String(
      ((def["inputSchema"] as Dict)["properties"] as Record<string, Dict>)["wake"]?.["description"],
    );
    for (const texte of [description, wake]) {
      expect(texte).toContain("attached to your next tool result or to the user's next message");
      expect(texte).not.toContain("never wake you");
    }
    expect(description).toContain("With ``wake=false`` no turn is ever started for the job");
    expect(wake).toBe(
      "start: false = never start a new turn for this job; its events are still delivered, attached to your next tool result or to the user's next message.",
    );
  });

  it("quantificateurs libres comptés comme l'agent : classes et échappements ignorés, *? compte pour un", () => {
    expect(quantificateursLibres("a*b+c{2,}d{1,3}")).toBe(3);
    expect(quantificateursLibres("[*+]\\*x*?")).toBe(1);
    expect(quantificateursLibres("[]*]")).toBe(0);
  });

  it("appuis réels : shell_job branché seulement avec un rappel actif qui porte les routes des jobs", () => {
    expect(appuisParDefaut(new PontExec()).jobs).toBeUndefined();
    expect(
      appuisParDefaut(
        new PontExec(),
        async () => "/w",
        new ClientRappel({ appUrl: "", jeton: "", journal: journalMuet }),
      ).jobs,
    ).toBeUndefined();
    const audit: Dict[] = [];
    const pont = new PontExec({ audit: (e) => audit.push(e as unknown as Dict) });
    const j = appuisParDefaut(pont, async () => "/w", rappel).jobs;
    expect(j).toBeDefined();
    j?.auditer({
      userId: 1,
      username: "u",
      command: "make test DB_PASS=hunter2",
      executor: "elpis-sb-u",
      jobId: "j-00000001",
    });
    // Commande masquée avant l'audit : ni le secret ni son empreinte n'y entrent.
    expect(audit[0]).toMatchObject({
      kind: "tools.shell_job",
      code: "make test DB_PASS=****",
      nodeId: "tools.shell_job",
      extra: { job_id: "j-00000001" },
    });
  });
});

describe("veilleur (agent simulé)", () => {
  const ev = (seq: number, jobId: string, trigger: string, state: string): Dict => ({
    seq,
    job_id: jobId,
    trigger,
    state,
    still_running: state === "running",
  });

  it("reset : curseur repris de l'agent ; lost réel écarté après un lost synthétisé ; jobs restants déclarés perdus à l'arrêt", async () => {
    const depuis: number[] = [];
    const reponses = [
      { events: [ev(1, "j-0000000a", "match", "running")], done: { last_seq: 1, running: 1, reset: true } },
      { events: [ev(2, "j-0000000b", "lost", "lost")], done: { last_seq: 2, running: 0, reset: false } },
      { events: [], done: { last_seq: 2, running: 0, reset: false } },
    ];
    const lots: Dict[][] = [];
    const v = new VeilleurJobs({
      agent: async () => ({
        jobsWatch: async (n: number) => {
          depuis.push(n);
          return reponses.shift() ?? { events: [], done: { last_seq: 2, running: 0, reset: false } };
        },
      }),
      relais: {
        evenementsJobs: async (_c, events) => {
          lots.push([...events]);
          return { ok: true };
        },
      },
    });
    expect(await v.declarerPerdus(COMPTE, ["j-0000000b"])).toBe(true);
    expect(v.veiller(COMPTE, ["j-0000000a", "pas-un-id"], 50)).toBe(true);
    expect(v.veiller(COMPTE, ["j-0000000a"], 99)).toBe(true);
    await v.calme();
    expect(depuis).toEqual([50, 1, 2]);
    expect(lots.map((l) => l.map((e) => [e["job_id"], e["seq"], e["trigger"]]))).toEqual([
      [["j-0000000b", 0, "lost"]],
      [["j-0000000a", 1, "match"]],
      [["j-0000000a", 0, "lost"]],
    ]);
    expect([v.enVeille(UID), v.curseur(UID)]).toEqual([false, 2]);
    v.arreter();
    expect(v.veiller(COMPTE, ["j-0000000a"])).toBe(false);
  });

  it("lot refusé pour de bon par le core (4xx : compte supprimé) : veille abandonnée après `essaisRefus` refus ; une panne (5xx) ne compte pas", async () => {
    Object.assign(reglagesVeille, { essaisRefus: 3 });
    const codes = [503, 403, 403, 503, 403, 403, 403];
    let essais = 0;
    const v = new VeilleurJobs({
      agent: async () => ({
        jobsWatch: async () => ({
          events: [ev(1, "j-0000000d", "exit", "exited")],
          done: { last_seq: 1, running: 0, reset: false },
        }),
      }),
      relais: {
        evenementsJobs: async (_c, _e, _s, statut) => {
          if (statut) statut.code = codes[essais] ?? 403;
          essais++;
          return null;
        },
      },
    });
    v.veiller(COMPTE, ["j-0000000d"]);
    await v.calme();
    expect([essais, v.enVeille(UID), v.curseur(UID)]).toEqual([7, false, null]);
  });

  it("un job confié pendant le tour de confirmation relance la veille au lieu de l'arrêter", async () => {
    let tours = 0;
    let v: VeilleurJobs | null = null;
    v = new VeilleurJobs({
      agent: async () => ({
        jobsWatch: async () => {
          tours++;
          if (tours === 2) v?.veiller(COMPTE, ["j-0000000c"]);
          const fin = tours >= 3 ? [ev(tours, "j-0000000c", "exit", "exited")] : [];
          return { events: tours === 3 ? fin : [], done: { last_seq: tours, running: 0, reset: false } };
        },
      }),
      relais: { evenementsJobs: async () => ({ ok: true }) },
    });
    v.veiller(COMPTE, []);
    await v.calme();
    expect(tours).toBe(4);
    expect(v.enVeille(UID)).toBe(false);
  });
});

describe.skipIf(!PYTHON)("shell_job : vrai agent, faux core", () => {
  it("JB-01 : start → enregistrement, lancement, état running, événement exit relayé en moins de 5 s", async () => {
    const c = await client();
    const r = await demarrer(c, {
      command: "sleep 0.5; echo fini; exit 1",
      resume_note: "fix it",
      wake_on: ["exit"],
    });
    expect(r).toMatchObject({ ok: true, state: "running", active_jobs: 1, max_jobs: 3, wake_on: ["exit"] });
    const id = String(r["job_id"]);
    expect(r["log"]).toBe(`/work/.bg/job-${id}.log`);
    expect(r["hint"]).toBe(
      "End your turn now: you will be woken automatically on exit. Do not poll or sleep.",
    );
    const enr = core.jobs.get(id)!;
    expect(enr).toMatchObject({
      chat_id: "c-1",
      call_id: "k1",
      label: "sleep 0.5; echo fini; exit 1",
      cwd: "",
      resume_note: "fix it",
      wake_on: ["exit"],
    });
    expect(core.etats[0]).toEqual({ job_id: id, state: "running", pid: r["pid"] });
    expect(audits).toEqual([
      {
        userId: UID,
        username: "alice",
        command: "sleep 0.5; echo fini; exit 1",
        executor: "elpis-sb-alice",
        jobId: id,
      },
    ]);
    const e = await core.attendre((x) => x["job_id"] === id && x["trigger"] === "exit");
    expect(e.event).toMatchObject({ state: "exited", exit_code: 1, tail: ["fini"] });
    expect(e.recu - Number(e.event["ts"])).toBeLessThan(5);
    expect(core.jobs.get(id)?.state).toBe("exited");
    await veilleur.calme();
    expect(veilleur.enVeille(UID)).toBe(false);
  });

  it("N-19 : wake=false → enregistré sans réveil, l'indication dit où arrivent ses événements", async () => {
    const c = await client();
    const r = await demarrer(c, { command: "true", wake: false });
    expect(core.jobs.get(String(r["job_id"]))?.wake).toBe(false);
    expect(r["hint"]).toBe(
      "This job will not start a new turn (wake=false): its events will be attached to your next tool result " +
        `or to the user's next message; shell_job(action="status") shows it at any time.`,
    );
  });

  it("JB-11 : profondeur de chaîne rendue dans un tour de réveil ; à la limite, job lancé sans réveil avec un avertissement", async () => {
    const c = await client();
    const premier = await demarrer(c, { command: "true" });
    expect(premier["chain_depth"]).toBeUndefined();
    expect(premier["max_chain_depth"]).toBeUndefined();
    core.profondeur = 4;
    const r = await demarrer(c, { command: "true" });
    expect(r).toMatchObject({ ok: true, chain_depth: 4, max_chain_depth: 5 });
    expect(r["warning"]).toBeUndefined();
    expect(String(r["hint"])).toContain("you will be woken automatically");
    core.profondeur = 5;
    const bout = await demarrer(c, { command: "true" });
    expect(bout).toMatchObject({
      ok: true,
      state: "running",
      chain_depth: 5,
      max_chain_depth: 5,
      warning: "wake chain limit reached (5/5): this job will not wake you; hand back to the user",
    });
    expect(bout["hint"]).toBe(
      "This job will not start a new turn (wake chain limit): its events will be attached to your next tool " +
        `result or to the user's next message; shell_job(action="status") shows it at any time.`,
    );
    expect(core.jobs.get(String(bout["job_id"]))?.wake).toBe(false);
    const def = outilsShell(appuisParDefaut(new PontExec())).find((o) => o.nom === "shell_job")!.definition;
    expect(String(def["description"])).toContain("a chain of 5 wake-ups without a user message");
    const ids = [premier, r, bout].map((x) => String(x["job_id"]));
    for (const id of ids) await core.attendre((x) => x["job_id"] === id && x["trigger"] === "exit");
    const journal = readFileSync(path.join(test.sandboxPath, ".bg", "jobs-events.ndjson"), "utf-8");
    const profondeurs = new Map(
      journal
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Dict)
        .map((e) => [e["job_id"], e["chain_depth"]]),
    );
    expect(ids.map((id) => profondeurs.get(id))).toEqual([0, 4, 5]);
  });

  it("E2E-03 simulé : start + port (JB-04) et match (JB-03), réveil sans attente, logs, kill (JB-12), aucun orphelin", async () => {
    const c = await client();
    const port = await portLibre();
    const r = await demarrer(c, {
      command: `python3 -u -m http.server ${port} --bind 127.0.0.1 & echo pret; wait`,
      label: "serveur",
      wake_on: [`port:${port}`, "match:pret"],
    });
    expect(r["wake_on"]).toEqual(["exit", `port:${port}`, "match:pret"]);
    const id = String(r["job_id"]);
    const reveil = await core.attendre((x) => x["job_id"] === id && x["trigger"] === "port");
    expect(reveil.event).toMatchObject({ spec: `port:${port}`, still_running: true, state: "running" });
    const ligne = await core.attendre((x) => x["job_id"] === id && x["trigger"] === "match");
    expect(ligne.event).toMatchObject({ spec: "match:pret", line: "pret", still_running: true });
    const logs = await job(c, { action: "logs", job_id: id });
    expect(logs).toMatchObject({ ok: true, job_id: id, log: `/work/.bg/job-${id}.log`, truncated: false });
    expect(logs["lines"]).toContain("pret");
    const k = await job(c, { action: "kill", job_id: id });
    expect(k).toMatchObject({ ok: true, job_id: id, state: "killed" });
    const tues = k["killed_pids"] as number[];
    expect(tues.length).toBeGreaterThanOrEqual(2);
    await jusqua(() => tues.every((p) => !vivant(p)));
    const fin = await core.attendre((x) => x["job_id"] === id && x["trigger"] === "killed");
    expect(fin.event["by"]).toBe("agent");
    expect(await job(c, { action: "kill", job_id: id })).toMatchObject({
      ok: false,
      error: "job_not_running",
      state: "killed",
    });
    await veilleur.calme();
    expect(veilleur.enVeille(UID)).toBe(false);
  });

  it("status, list et logs : registre du core et fiche de l'agent ; journal borné à 4 Ko ; grep ; propriété par conversation", async () => {
    const c = await client();
    const r = await demarrer(c, {
      command: "for i in $(seq 1 300); do echo \"ligne $i $(printf 'x%.0s' $(seq 1 40))\"; done",
      label: "bavard",
    });
    const id = String(r["job_id"]);
    await core.attendre((x) => x["job_id"] === id && x["trigger"] === "exit");
    const st = await job(c, { action: "status", job_id: id });
    expect(st).toMatchObject({ ok: true, active_jobs: 0, max_jobs: 3 });
    expect((st["jobs"] as Dict[])[0]).toMatchObject({
      job_id: id,
      label: "bavard",
      state: "exited",
      exit_code: 0,
      wake_on: ["exit"],
      fired: ["exit"],
      log: `/work/.bg/job-${id}.log`,
    });
    expect(String((st["jobs"] as Dict[])[0]?.["last_line"])).toMatch(/^ligne 300 /u);
    const queue = await job(c, { action: "logs", job_id: id });
    expect(queue).toMatchObject({ total_lines: 300, truncated: false });
    expect((queue["lines"] as string[]).length).toBe(40);
    expect((queue["lines"] as string[]).at(-1)).toMatch(/^ligne 300 /u);
    const long = await job(c, { action: "logs", job_id: id, tail: 200 });
    expect(long["truncated"]).toBe(true);
    expect(Buffer.byteLength((long["lines"] as string[]).join("\n"))).toBeLessThanOrEqual(4096);
    expect((long["lines"] as string[]).at(-1)).toMatch(/^ligne 300 /u);
    const cherche = await job(c, { action: "logs", job_id: id, grep: "ligne 29" });
    expect((cherche["matches"] as Dict[]).map((m) => m["line"])).toEqual([
      29,
      ...Array.from({ length: 10 }, (_, i) => 290 + i),
    ]);
    const autre = await job(c, { action: "status", job_id: id }, { ...META, chat_id: "c-2" });
    expect(autre).toMatchObject({ ok: false, error: "job_not_found" });
    expect(await job(c, { action: "logs", job_id: id }, { ...META, chat_id: "c-2" })).toMatchObject({
      error: "job_not_found",
    });
    expect(await job(c, { action: "kill", job_id: "j-zz" })).toMatchObject({ error: "invalid_argument" });
    const liste = await job(c, { action: "list" });
    expect((liste["jobs"] as Dict[]).map((j) => j["job_id"])).toEqual([id]);
  });

  it("JB-10 : 4ᵉ job refusé tel quel par le core (limit_exceeded + liste) ; not_available_here sans conversation ou par le core", async () => {
    const c = await client();
    for (let i = 0; i < 3; i++) await demarrer(c, { command: "sleep 30", label: `j${i}` });
    const r = await job(c, { action: "start", command: "sleep 30" });
    expect(r).toMatchObject({ ok: false, error: "limit_exceeded", max_jobs: 3 });
    expect((r["active"] as Dict[]).map((j) => j["label"])).toEqual(["j0", "j1", "j2"]);
    expect(String(r["fix"])).toContain("kill");
    expect(core.jobs.size).toBe(3);
    const sansChat = await job(c, { action: "start", command: "true" }, { username: "alice", user_id: "42" });
    expect(sansChat).toMatchObject({ ok: false, error: "not_available_here" });
    core.refus = {
      ok: false,
      error: "not_available_here",
      message: "Background jobs need a saved conversation.",
    };
    expect(await job(c, { action: "start", command: "true" }, { ...META, chat_id: "c-9" })).toEqual(
      core.refus,
    );
  });

  it("JB-19 des deux côtés : refus de l'hôte avant tout enregistrement, refus de l'agent (lien qui sort) traduit et job failed", async () => {
    const c = await client();
    expect(
      await job(c, { action: "start", command: "true", wake_on: ["file:../../etc/passwd"] }),
    ).toMatchObject({ ok: false, error: "path_outside_sandbox" });
    expect(await job(c, { action: "start", command: "true", cwd: "../x" })).toMatchObject({
      ok: false,
      error: "path_outside_sandbox",
    });
    expect(core.jobs.size).toBe(0);
    symlinkSync("/etc", path.join(test.sandboxPath, "lien"));
    const r = await job(c, { action: "start", command: "true", wake_on: ["file:lien/passwd"] });
    expect(r).toMatchObject({ ok: false, error: "path_outside_sandbox" });
    const [enr] = [...core.jobs.values()];
    expect(core.etats).toEqual([{ job_id: enr?.job_id, state: "failed", error: "outside_root" }]);
    expect(existsSync(path.join(test.sandboxPath, ".bg", `job-${enr?.job_id}.log`))).toBe(false);
  });

  it("JB-13 : conteneur arrêté → lost synthétisés relayés (seq 0), veille arrêtée", async () => {
    const c = await client();
    const r = await demarrer(c, { command: "sleep 60" });
    const id = String(r["job_id"]);
    await jusqua(() => veilleur.enVeille(UID));
    await new Promise((ok) => setTimeout(ok, 200));
    test.running = false;
    await test.arreter();
    const e = await core.attendre((x) => x["job_id"] === id && x["trigger"] === "lost");
    expect(e.event).toMatchObject({ seq: 0, synthetic: true, state: "lost", still_running: false });
    expect(core.jobs.get(id)?.state).toBe("lost");
    await veilleur.calme();
    expect(veilleur.enVeille(UID)).toBe(false);
    expect(test.demarrages).toBe(1);
  });

  it("core injoignable puis revenu : lot gardé, curseur avancé après l'acquittement seulement, aucune perte ni doublon", async () => {
    const c = await client();
    core.panneEvenements = true;
    const r = await demarrer(c, { command: "echo un; sleep 0.3; echo deux", wake_on: ["match:un"] });
    const id = String(r["job_id"]);
    await jusqua(() => core.appels.filter((a) => a === "POST /api/internal/jobs/events").length >= 3);
    expect(core.evenements).toEqual([]);
    expect(veilleur.curseur(UID)).toBe(0);
    core.panneEvenements = false;
    await core.attendre((x) => x["job_id"] === id && x["trigger"] === "exit");
    await veilleur.calme();
    expect(core.duJob(id).map((e) => [e["trigger"], e["seq"]])).toEqual([
      ["match", 1],
      ["exit", 2],
    ]);
    expect(core.lots.flatMap((l) => l["events"] as Dict[])).toHaveLength(2);
    expect(veilleur.curseur(UID)).toBe(2);
  });

  it("redémarrage de l'hôte : rien relu au démarrage, veille reprise quand le core pousse jobs/watch (idempotent)", async () => {
    const c = await client();
    const r = await demarrer(c, { command: "sleep 0.6; echo fini" });
    const id = String(r["job_id"]);
    veilleur.arreter();
    await veilleur.calme();
    await new Promise((ok) => setTimeout(ok, 1000));
    expect(core.duJob(id)).toEqual([]);
    veilleur = nouveauVeilleur();
    const app = await hoteRoutes(veilleur);
    const pousser = (): Promise<{ statusCode: number; json: () => Dict }> =>
      app.inject({
        method: "POST",
        url: "/api/internal/jobs/watch",
        headers: entetes(UID, "alice"),
        payload: { job_ids: [id], since_seq: 0 },
      }) as unknown as Promise<{ statusCode: number; json: () => Dict }>;
    const p = await pousser();
    expect([p.statusCode, p.json()]).toEqual([200, { ok: true, watching: true }]);
    expect((await pousser()).json()).toEqual({ ok: true, watching: true });
    const e = await core.attendre((x) => x["job_id"] === id && x["trigger"] === "exit");
    expect(e.event["tail"]).toEqual(["fini"]);
    expect(core.duJob(id)).toHaveLength(1);
    const sans = await app.inject({
      method: "POST",
      url: "/api/internal/jobs/watch",
      payload: { job_ids: [id] },
    });
    expect(sans.statusCode).toBe(401);
  });

  it("route d'arrêt du core : by user, purge des fichiers, job inconnu → lost, conteneur arrêté → 503 si purge", async () => {
    const c = await client();
    const a = String((await demarrer(c, { command: "sleep 30" }))["job_id"]);
    const app = await hoteRoutes(veilleur);
    const tuer = (corps: Dict): Promise<{ statusCode: number; json: () => Dict }> =>
      app.inject({
        method: "POST",
        url: "/api/internal/jobs/kill",
        headers: entetes(UID, "alice"),
        payload: corps,
      }) as unknown as Promise<{ statusCode: number; json: () => Dict }>;
    const r = await tuer({ job_ids: [a], by: "user", purge: false });
    expect(r.statusCode).toBe(200);
    expect(r.json()["results"]).toMatchObject([{ job_id: a, state: "killed" }]);
    const ev = await core.attendre((x) => x["job_id"] === a && x["trigger"] === "killed");
    expect(ev.event["by"]).toBe("user");
    const p = await tuer({ job_ids: [a], by: "core", purge: true });
    expect(p.json()).toMatchObject({ ok: true, results: [{ job_id: a, killed_pids: [] }] });
    expect(existsSync(path.join(test.sandboxPath, ".bg", `job-${a}.log`))).toBe(false);
    const inconnu = String((await demarrer(c, { command: "true" }))["job_id"]);
    await core.attendre((x) => x["job_id"] === inconnu && x["trigger"] === "exit");
    core.jobs.get(inconnu)!.state = "running";
    await tuer({ job_ids: [inconnu], by: "core", purge: true });
    const perdu = await tuer({ job_ids: [inconnu], by: "user", purge: false });
    expect(perdu.json()["results"]).toEqual([{ job_id: inconnu, killed_pids: [], state: "lost" }]);
    expect(core.duJob(inconnu).at(-1)).toMatchObject({ seq: 0, synthetic: true, trigger: "lost" });
    test.running = false;
    await test.arreter();
    const arrete = await tuer({ job_ids: [a], by: "core", purge: true });
    expect(arrete.statusCode).toBe(503);
    const sansPurge = await tuer({ job_ids: [a], by: "user", purge: false });
    expect(sansPurge.json()).toEqual({ ok: true, results: [{ job_id: a, killed_pids: [], state: "lost" }] });
  });
});
