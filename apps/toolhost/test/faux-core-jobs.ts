// SPDX-License-Identifier: MIT
/** apps/toolhost/test/faux-core-jobs.ts — faux core des tests de shell_job : routes internes /api/internal/jobs* (enregistrement, limites, état, événements dédoublonnés, liste), enveloppe d'identité vérifiée, pannes simulées. */
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { IncomingMessage, Server } from "node:http";
import type { AddressInfo } from "node:net";

import type { Dict } from "@elpis/commun";
import { IDENTITY_HEADER, verify } from "@elpis/securite";

import { SVC } from "./aides";

const TERMINAUX = new Set(["exited", "killed", "lost", "failed"]);

export interface JobFaux {
  job_id: string;
  user_id: number;
  chat_id: string;
  call_id: string;
  label: string;
  command: string;
  cwd: string;
  wake_on: string[];
  resume_note: string;
  wake: boolean;
  state: string;
  pid: number | null;
  exit_code: number | null;
  signal: string | null;
  last_seq: number;
}

export interface EvenementRecu {
  readonly user_id: number;
  readonly event: Dict;
  /** Heure de réception (secondes). */
  readonly recu: number;
}

export class FauxCore {
  readonly jobs = new Map<string, JobFaux>();
  readonly evenements: EvenementRecu[] = [];
  readonly lots: Dict[] = [];
  readonly etats: Dict[] = [];
  readonly appels: string[] = [];
  /** Jobs marqués livrés par `execute_shell` (`POST /api/internal/jobs/delivered`). */
  readonly livres = new Set<string>();
  /** Réponses 503 aux lots d'événements (core injoignable). */
  panneEvenements = false;
  /** Refus imposé à l'enregistrement (`not_available_here`…). */
  refus: Dict | null = null;
  maxParChat = 3;
  /** Profondeur de la chaîne de réveils du tour en cours et limite (`max_depth`). */
  profondeur = 0;
  maxProfondeur = 5;
  url = "";
  private serveur: Server | null = null;

  async demarrer(): Promise<void> {
    const s = createServer((req, res) => {
      let corps = "";
      req.on("data", (m: Buffer) => (corps += m.toString()));
      req.on("end", () => {
        const [statut, rendu] = this.traiter(req, corps);
        res.writeHead(statut, { "content-type": "application/json" }).end(JSON.stringify(rendu));
      });
    });
    await new Promise<void>((fin) => s.listen(0, "127.0.0.1", fin));
    this.serveur = s;
    this.url = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  async fermer(): Promise<void> {
    const s = this.serveur;
    if (s === null) return;
    s.closeAllConnections();
    await new Promise((fin) => s.close(fin));
  }

  actifs(chatId: string | null, uid: number): JobFaux[] {
    return [...this.jobs.values()].filter(
      (j) => j.user_id === uid && (chatId === null || j.chat_id === chatId) && !TERMINAUX.has(j.state),
    );
  }

  /** Événements reçus pour un job, dans l'ordre d'arrivée. */
  duJob(jobId: string): Dict[] {
    return this.evenements.filter((e) => e.event["job_id"] === jobId).map((e) => e.event);
  }

  /** Attend qu'un événement satisfasse `f` (10 s au plus). */
  async attendre(f: (e: Dict) => boolean, ms = 10_000): Promise<EvenementRecu> {
    const fin = Date.now() + ms;
    for (;;) {
      const e = this.evenements.find((x) => f(x.event));
      if (e !== undefined) return e;
      if (Date.now() > fin) throw new Error("événement attendu non reçu par le faux core");
      await new Promise((ok) => setTimeout(ok, 25));
    }
  }

  private traiter(req: IncomingMessage, corps: string): [number, unknown] {
    const chemin = (req.url ?? "").split("?")[0] ?? "";
    this.appels.push(`${req.method} ${chemin}`);
    if (req.headers.authorization !== `Bearer ${SVC}`) return [401, { detail: "jeton" }];
    const brut = req.headers[IDENTITY_HEADER.toLowerCase()];
    const ident = verify(Array.isArray(brut) ? brut[0] : brut, SVC);
    if (ident === null || ident.user_id <= 0) return [401, { detail: "enveloppe" }];
    const uid = ident.user_id;
    const d = (corps ? JSON.parse(corps) : {}) as Dict;
    if (req.method === "POST" && chemin === "/api/internal/jobs") return [200, this.enregistrer(uid, d)];
    if (req.method === "POST" && chemin === "/api/internal/jobs/state") {
      this.etats.push(d);
      const j = this.jobs.get(String(d["job_id"]));
      if (j === undefined || j.user_id !== uid) return [200, { ok: false, error: "job_not_found" }];
      if (j.state === "starting") {
        j.state = String(d["state"]);
        j.pid = typeof d["pid"] === "number" ? d["pid"] : null;
      }
      return [200, { ok: true }];
    }
    if (req.method === "POST" && chemin === "/api/internal/jobs/delivered") {
      const j = this.jobs.get(String(d["job_id"]));
      if (j === undefined || j.user_id !== uid) return [200, { ok: false, error: "job_not_found" }];
      this.livres.add(j.job_id);
      return [200, { ok: true, delivered: 1 }];
    }
    if (req.method === "POST" && chemin === "/api/internal/jobs/events") {
      if (this.panneEvenements) return [503, { detail: "indisponible" }];
      this.lots.push(d);
      return [200, this.recevoir(uid, d)];
    }
    if (req.method === "GET" && chemin === "/api/internal/jobs") {
      const chat = new URL(req.url ?? "", "http://x").searchParams.get("chat_id");
      const jobs = [...this.jobs.values()].filter((j) => j.user_id === uid && (!chat || j.chat_id === chat));
      return [
        200,
        {
          jobs: jobs.map((j) => ({ ...j })),
          active_jobs: this.actifs(chat, uid).length,
          max_jobs: this.maxParChat,
        },
      ];
    }
    return [404, { detail: "Not Found" }];
  }

  private enregistrer(uid: number, d: Dict): Dict {
    if (this.refus !== null) return this.refus;
    const chat = String(d["chat_id"]);
    const actifs = this.actifs(chat, uid);
    if (actifs.length >= this.maxParChat)
      return {
        ok: false,
        error: "limit_exceeded",
        message: `Too many background jobs (${actifs.length}/${this.maxParChat} in this conversation): wait for one to end or kill one.`,
        active: actifs.map((j) => ({ job_id: j.job_id, label: j.label, state: j.state, started_at: 1 })),
        max_jobs: this.maxParChat,
      };
    const id = `j-${randomBytes(4).toString("hex")}`;
    const limite = d["wake"] !== false && this.profondeur >= this.maxProfondeur;
    this.jobs.set(id, {
      job_id: id,
      user_id: uid,
      chat_id: chat,
      call_id: String(d["call_id"] ?? ""),
      label: String(d["label"] ?? ""),
      command: String(d["command"] ?? ""),
      cwd: String(d["cwd"] ?? ""),
      wake_on: (d["wake_on"] as string[]) ?? [],
      resume_note: String(d["resume_note"] ?? ""),
      wake: d["wake"] !== false && !limite,
      state: "starting",
      pid: null,
      exit_code: null,
      signal: null,
      last_seq: 0,
    });
    return {
      ok: true,
      job_id: id,
      active_jobs: actifs.length + 1,
      max_jobs: this.maxParChat,
      depth: this.profondeur,
      max_depth: this.maxProfondeur,
      wake: d["wake"] !== false && !limite,
      chain_limit: limite,
    };
  }

  private recevoir(uid: number, d: Dict): Dict {
    let acquitte = Number(d["last_seq"] ?? 0);
    let acceptes = 0;
    let refuses = 0;
    for (const e of (d["events"] as Dict[]) ?? []) {
      const seq = Number(e["seq"]);
      acquitte = Math.max(acquitte, seq);
      const j = this.jobs.get(String(e["job_id"]));
      if (j === undefined || j.user_id !== uid) {
        refuses++;
        continue;
      }
      if (seq === 0) {
        if (TERMINAUX.has(j.state)) continue;
      } else if (this.evenements.some((x) => x.event["job_id"] === j.job_id && x.event["seq"] === seq))
        continue;
      else if (seq <= j.last_seq) {
        refuses++;
        continue;
      }
      this.evenements.push({ user_id: uid, event: e, recu: Date.now() / 1000 });
      acceptes++;
      j.last_seq = Math.max(j.last_seq, seq);
      if (!TERMINAUX.has(j.state) && TERMINAUX.has(String(e["state"]))) {
        j.state = String(e["state"]);
        j.exit_code = typeof e["exit_code"] === "number" ? e["exit_code"] : null;
        j.signal = typeof e["signal"] === "string" ? e["signal"] : null;
      }
    }
    return { ok: true, acked_seq: acquitte, accepted: acceptes, rejected: refuses };
  }
}
