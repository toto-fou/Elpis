// SPDX-License-Identifier: MIT
/** frontend/test/chat/jobs/outils-jobs.ts — fabriques communes aux tests des tâches de fond : job, réponse de liste, réveil, réponses fetch. */
import type { ReponseJobs, ResumeJob, ResumeReveil } from "@elpis/contracts";

export const json = (corps: unknown, statut = 200): Response =>
  new Response(JSON.stringify(corps), { status: statut, headers: { "content-type": "application/json" } });

export function job(surcharges: Partial<ResumeJob> = {}): ResumeJob {
  return {
    id: "j-3f2a1c9e",
    chat_id: "c1",
    chat_title: "Tests de l'API",
    label: "pytest",
    command: "pytest -q",
    state: "running",
    wake_on: ["exit", "match:FAILED"],
    wake: true,
    pid: 4242,
    exit_code: null,
    signal: null,
    created_at: 1000,
    started_at: 1000,
    ended_at: null,
    last_line: "41 passed",
    log: "/work/.bg/job-j-3f2a1c9e.log",
    pending_events: 0,
    ...surcharges,
  };
}

export function reponse(surcharges: Partial<ReponseJobs> = {}): ReponseJobs {
  return {
    jobs: [job()],
    active_total: 1,
    max_per_chat: 3,
    max_per_user: 5,
    wake_queue: [],
    wake_running: [],
    wake_disabled: false,
    ...surcharges,
  };
}

export const REVEIL: ResumeReveil = {
  summary: "pytest terminé, code 1, 10 min 03 s",
  events: [
    {
      job_id: "j-3f2a1c9e",
      label: "pytest",
      trigger: "exit",
      state: "exited",
      exit_code: 1,
      signal: null,
      duration_s: 603,
    },
  ],
  depth: 1,
};
