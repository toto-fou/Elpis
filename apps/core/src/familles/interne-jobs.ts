// SPDX-License-Identifier: MIT
/** apps/core/src/familles/interne-jobs.ts — `/api/internal/jobs*` appelées par l'hôte d'outils (jeton de service, enveloppe signée du compte) : enregistrement d'un job, lancement, événements, listes ; la reprise est poussée par le core (`ServiceJobs.veiller`). */
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { entrees, py } from "@elpis/http";

import { compterActifs, listerJobs } from "../jobs/magasin";
import { reglagesJobs } from "../jobs/reglages";
import type { ServiceJobs } from "../jobs/service";
import { sandboxHostFor } from "../relais/hotes";
import type { Famille } from "../routes";
import { compteSigne } from "./interne-toolhost";

export interface DependancesInterneJobs {
  readonly auth: DependancesAuth & DependancesJetons;
  readonly service: ServiceJobs;
}

const ENREGISTREMENT = py.model({
  chat_id: py.str({ min_length: 1, max_length: 200 }),
  call_id: py.str({ max_length: 200 }).defaut(""),
  label: py.str({ max_length: 200 }).defaut(""),
  command: py.str({ min_length: 1, max_length: 100_000 }),
  cwd: py.str({ max_length: 4096 }).defaut(""),
  wake_on: py.list(py.str({ min_length: 1, max_length: 300 }), { max_length: 7 }).defaut([]),
  resume_note: py.str({ max_length: 600 }).defaut(""),
  wake: py.bool().defaut(true),
});
const LANCEMENT = py.model({
  job_id: py.str({ min_length: 1, max_length: 32 }),
  state: py.literal("running", "failed"),
  pid: py.optional(py.int()).defaut(null),
  error: py.str({ max_length: 2000 }).defaut(""),
});
const LIVRAISON = py.model({ job_id: py.str({ min_length: 1, max_length: 32 }) });
const EVENEMENTS = py.model({
  events: py.list(py.any(), { max_length: 500 }),
  last_seq: py.int({ ge: 0 }).defaut(0),
});

export function creerFamilleInterneJobs(dep: DependancesInterneJobs): Famille {
  const base = dep.auth.base;
  const s = dep.service;
  return {
    nom: "interne-jobs",
    routes: [
      {
        methode: "POST",
        chemin: "/api/internal/jobs",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { uid } = await compteSigne(dep, req);
          const c = entrees(req, { body: ENREGISTREMENT }).body;
          const hote = (await sandboxHostFor(uid, false).catch(() => null))?.id ?? "";
          return s.enregistrer(uid, c, hote);
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/jobs/state",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { uid } = await compteSigne(dep, req);
          const c = entrees(req, { body: LANCEMENT }).body;
          return s.poserEtat(uid, c.job_id, c.state, c.pid, c.error);
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/jobs/delivered",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { uid } = await compteSigne(dep, req);
          const c = entrees(req, { body: LIVRAISON }).body;
          return s.marquerLivre(uid, c.job_id);
        },
      },
      {
        methode: "POST",
        chemin: "/api/internal/jobs/events",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { uid } = await compteSigne(dep, req);
          const c = entrees(req, { body: EVENEMENTS }).body;
          return s.recevoir(uid, c.events, c.last_seq);
        },
      },
      {
        methode: "GET",
        chemin: "/api/internal/jobs",
        processus: ["main"],
        acces: "service",
        traiter: async (req) => {
          const { uid } = await compteSigne(dep, req);
          const q = entrees(req, { query: { chat_id: py.str({ max_length: 200 }).defaut("") } }).query;
          const chatId = q.chat_id || null;
          const r = reglagesJobs();
          const jobs = await listerJobs(base, uid, chatId);
          return {
            jobs: jobs.map((j) => ({
              job_id: j.id,
              chat_id: j.chatId,
              label: j.label,
              command: j.command,
              state: j.state,
              wake_on: j.wakeOn,
              wake: j.wake,
              pid: j.pid,
              exit_code: j.exitCode,
              signal: j.signal,
              created_at: j.createdAt,
              started_at: j.startedAt,
              ended_at: j.endedAt,
            })),
            active_jobs: await compterActifs(base, uid, chatId),
            max_jobs: chatId === null ? r.max_per_user : r.max_per_chat,
          };
        },
      },
    ],
  };
}
