// SPDX-License-Identifier: MIT
/** apps/core/test/jobs/aides.ts — banc des tâches de fond : base SQLite, horloge simulée, boucle simulée (tour réel), faux hôte d'outils, publications relevées. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mergeUserSettings } from "@elpis/auth";
import type { Dict } from "@elpis/commun";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { brancherGardeUrl } from "@elpis/mcp";

import { upsertChat } from "../../src/chats/stockage";
import { installerServiceJobs } from "../../src/jobs/branchements";
import type { ParArret, PortHoteJobs } from "../../src/jobs/hote";
import { DEFAUTS_JOBS } from "../../src/jobs/reglages";
import type { ReglagesJobs } from "../../src/jobs/reglages";
import { ServiceJobs } from "../../src/jobs/service";
import type { CorpsEnregistrement, Horloge } from "../../src/jobs/service";
import { viderAdmissionPourTests } from "../../src/tour/admission";
import { registerChatTask, unregisterChatTask, viderEtatPourTests } from "../../src/tour/etat";
import { reglerExecutionPourTests } from "../../src/tour/execution";
import { reglerJournalPourTests } from "../../src/tour/journal-run";

/** Minuteries rangées par échéance, déclenchées par `avancer` (aucune attente réelle). */
export class HorlogeSimulee implements Horloge {
  t = 1_800_000_000;
  private n = 0;
  private taches: { due: number; id: number; f: () => void }[] = [];

  maintenant(): number {
    return this.t;
  }

  programmer(ms: number, f: () => void): () => void {
    const id = ++this.n;
    this.taches.push({ due: this.t + ms / 1000, id, f });
    return () => {
      this.taches = this.taches.filter((x) => x.id !== id);
    };
  }

  /** Avance de `s` secondes en déclenchant les échéances dans l'ordre, tâches du service attendues entre deux. */
  async avancer(s: number, service: ServiceJobs, avecTours = true): Promise<void> {
    const fin = this.t + s;
    for (;;) {
      await service.calme(avecTours);
      const prochaine = this.taches
        .filter((x) => x.due <= fin)
        .sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (prochaine === undefined) break;
      this.taches = this.taches.filter((x) => x !== prochaine);
      this.t = Math.max(this.t, prochaine.due);
      prochaine.f();
    }
    this.t = fin;
    await service.calme(avecTours);
  }
}

export interface AppelHote {
  uid: number;
  ids: string[];
  par: ParArret;
  purge: boolean;
}

export interface Banc {
  t: BaseDeTest;
  service: ServiceJobs;
  horloge: HorlogeSimulee;
  publications: Dict[];
  appelsHote: AppelHote[];
  /** Veilles confiées à l'hôte : compte, jobs, dernier seq acquitté, heure simulée. */
  veilles: { uid: number; ids: string[]; since: number; t: number }[];
  /** Messages vus par la boucle simulée, un tableau par tour. */
  tours: Dict[][];
  /** Serveurs MCP et outils refusés de chaque tour simulé. */
  outilsTours: { mcp: Dict[]; refuses: string[]; modele: string | null }[];
  /** Réglages en vigueur (modifiables par le test). */
  reglages: ReglagesJobs;
  hoteEnPanne: boolean;
  /** Tour simulé retenu jusqu'à `relacher()` (file par compte). */
  retenir: boolean;
  /** Appelé pendant chaque tour simulé (tour actif, instantané posé), ex. pour y lancer un job. */
  pendantTour: (() => Promise<void>) | null;
  relacher: () => void;
  fermer(): Promise<void>;
}

const MOTEUR = { kind: "ready" };

export async function creerBanc(): Promise<Banc> {
  brancherGardeUrl(async () => null);
  const dossier = mkdtempSync(join(tmpdir(), "elpis-jobs-"));
  reglerJournalPourTests({ dossier: join(dossier, "runs"), balayage: false });
  const t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  for (const nom of ["alice", "bob"])
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?, 's', 'h', 0, 0)",
      [nom],
    );
  const horloge = new HorlogeSimulee();
  const banc = {
    t,
    horloge,
    publications: [] as Dict[],
    appelsHote: [] as AppelHote[],
    veilles: [] as Banc["veilles"],
    tours: [] as Dict[][],
    outilsTours: [] as Banc["outilsTours"],
    reglages: { ...DEFAUTS_JOBS },
    hoteEnPanne: false,
    retenir: false,
    pendantTour: null,
    relacher: () => undefined,
  } as Banc;
  const hote: PortHoteJobs = {
    async tuer(uid, ids, par, purge) {
      if (banc.hoteEnPanne) throw new Error("hôte injoignable");
      banc.appelsHote.push({ uid, ids: [...ids], par, purge });
      return ids.map((id) => ({ job_id: id, killed_pids: [4242], state: "killed" }));
    },
    async veiller(uid, ids, since) {
      if (banc.hoteEnPanne) throw new Error("hôte injoignable");
      banc.veilles.push({ uid, ids: [...ids], since, t: horloge.t });
      return true;
    },
  };
  banc.service = new ServiceJobs({
    base: t.base,
    hote,
    publier: (m) => void banc.publications.push(m),
    horloge,
    reglages: () => banc.reglages,
  });
  installerServiceJobs(banc.service);
  reglerExecutionPourTests({
    etatFile: async () => ({ ...MOTEUR }),
    contexteModele: async () => 8192,
    admission: async (_o, fn) => fn(null),
    boucle: async (o) => {
      banc.tours.push(o.messages as Dict[]);
      banc.outilsTours.push({
        mcp: [...(o.mcpConfigs ?? [])] as Dict[],
        refuses: [...(o.denyToolNames ?? [])],
        modele: o.model ?? null,
      });
      await banc.pendantTour?.();
      if (banc.retenir) await new Promise<void>((ok) => (banc.relacher = ok));
      return ["Repris.", [], {}];
    },
    titre: async () => null,
  });
  await banc.service.demarrer();
  banc.fermer = async () => {
    banc.service.arreter();
    installerServiceJobs(null);
    reglerExecutionPourTests(null);
    reglerJournalPourTests(null);
    viderEtatPourTests();
    viderAdmissionPourTests();
    brancherGardeUrl(null);
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  };
  return banc;
}

export async function creerChat(b: Banc, uid: number, chatId: string, titre = "Projet"): Promise<void> {
  await upsertChat(
    b.t.base,
    uid,
    chatId,
    titre,
    [
      { role: "user", content: "Lance les tests" },
      { role: "assistant", content: "C'est parti." },
    ],
    1000,
  );
}

/** Tour de premier niveau actif sur la conversation (instantané du registre) ; rend sa fin. */
export function tourActif(uid: number, chatId: string, profondeur = 0, extra: Dict = {}): () => void {
  const c = new AbortController();
  registerChatTask(uid, c, chatId, {
    presenceLock: false,
    instantane: {
      run_id: `run-${chatId}`,
      model: "m",
      connector_id: null,
      active_mcp_servers: [{ id: "srv1", filter_categories: ["shell"] }],
      excluded_tools: [],
      sampling_override: null,
      plan_mode: false,
      depth: profondeur,
      ephemeral: false,
      ...extra,
    },
  });
  return () => unregisterChatTask(uid, chatId, c);
}

export function corps(chatId: string, o: Partial<CorpsEnregistrement> = {}): CorpsEnregistrement {
  return {
    chat_id: chatId,
    call_id: "call-1",
    label: "pytest",
    command: "pytest -q",
    cwd: "",
    wake_on: ["exit"],
    resume_note: "If green, commit.",
    wake: true,
    ...o,
  };
}

/** Job enregistré pendant un tour, lancé, tour fini ; rend son id. */
export async function lancerJob(
  b: Banc,
  uid: number,
  chatId: string,
  o: Partial<CorpsEnregistrement> & { profondeur?: number } = {},
): Promise<string> {
  const fin = tourActif(uid, chatId, o.profondeur ?? 0);
  const r = await b.service.enregistrer(uid, corps(chatId, o), "local");
  fin();
  if (r["ok"] !== true) throw new Error(`enregistrement refusé : ${JSON.stringify(r)}`);
  const id = String(r["job_id"]);
  await b.service.poserEtat(uid, id, "running", 4242, "");
  return id;
}

let seq = 0;

export function ev(jobId: string, o: Dict = {}): Dict {
  seq += 1;
  return {
    seq,
    job_id: jobId,
    ts: 1.5,
    trigger: "exit",
    spec: "exit",
    state: "exited",
    exit_code: 0,
    signal: null,
    duration_s: 3.2,
    line: null,
    context: null,
    tail: ["ok"],
    log_lines: 1,
    log_bytes: 3,
    by: null,
    still_running: false,
    ...o,
  };
}

export async function compteJobsWake(b: Banc, uid: number, valeur: boolean): Promise<void> {
  await mergeUserSettings(b.t.base, uid, (r) => void (r["jobs_wake"] = valeur));
}

/** Notifications enregistrées en base (les tâches de fond n'en émettent aucune). */
export async function notificationsEnBase(b: Banc): Promise<Dict[]> {
  return b.t.base.all("SELECT kind, title FROM notifications ORDER BY id");
}

export function reveils(b: Banc, statut?: string): Dict[] {
  return b.publications
    .filter((p) => p["type"] === "chat_wake")
    .map((p) => p["data"] as Dict)
    .filter((d) => statut === undefined || d["status"] === statut);
}
