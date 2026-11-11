// SPDX-License-Identifier: MIT
/** packages/contracts/test/jobs.test.ts — contrats des tâches de fond : liste, arrêt, réveil (REST), événements `chat_job` et `chat_wake`, `run_started` d'un tour de réveil. */
import { describe, expect, it } from "vitest";

import {
  decoderEvenementSysteme,
  schemaChat,
  schemaEvenementFlux,
  schemaReponseArretJobs,
  schemaReponseJobs,
  schemaResumeJob,
  TYPES_EVENEMENTS_SYSTEME,
} from "../src";
import type { ResumeJob, ResumeReveil } from "../src";

const JOB: ResumeJob = {
  id: "j-3f2a1c9e",
  chat_id: "c1",
  chat_title: "Tests de l'API",
  label: "pytest",
  command: "pytest -q",
  state: "exited",
  wake_on: ["exit", "match:FAILED"],
  wake: true,
  pid: 4242,
  exit_code: 1,
  signal: null,
  created_at: 1_791_331_200,
  started_at: 1_791_331_200.5,
  ended_at: 1_791_331_803,
  last_line: "1 failed, 41 passed",
  log: "/work/.bg/job-j-3f2a1c9e.log",
  pending_events: 1,
};

const REVEIL: ResumeReveil = {
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

describe("REST des tâches de fond", () => {
  it("liste d'une conversation : jobs, limites, file de réveil du compte, interrupteur", () => {
    const r = {
      jobs: [JOB],
      active_total: 1,
      max_per_chat: 3,
      max_per_user: 5,
      wake_queue: [{ chat_id: "c2", chat_title: "Serveur", since: 1_791_331_900, events: 2 }],
      wake_running: [{ chat_id: "c3", chat_title: "Build", run_id: "r1", started_at: 1_791_331_950 }],
      wake_disabled: false,
    };
    expect(schemaReponseJobs.parse(r)).toEqual(r);
    expect(schemaReponseJobs.safeParse({ ...r, jobs: [{ ...JOB, state: "zombie" }] }).success).toBe(false);
  });

  it("JB-12 : arrêt, ids arrêtés et inconnus rendus", () => {
    expect(schemaReponseArretJobs.parse({ ok: true, stopped: ["j-1"], not_found: [] }).stopped).toEqual([
      "j-1",
    ]);
    expect(schemaResumeJob.safeParse({ ...JOB, pid: null, exit_code: null, ended_at: null }).success).toBe(
      true,
    );
  });

  it("JB-17 : « Ne pas me réveiller » facultatif dans la conversation (ancien core accepté)", () => {
    const chat = {
      id: "c1",
      title: "T",
      updated_at: 1,
      archived: false,
      messages: [],
      tools: null,
      plan_mode: false,
      todos: [],
      ctx_pruned_keys: [],
      ctx_usage: null,
      llm_user_suffixes: {},
    };
    expect(schemaChat.parse(chat).wake_disabled).toBeUndefined();
    expect(schemaChat.parse({ ...chat, wake_disabled: true }).wake_disabled).toBe(true);
  });
});

describe("événements système", () => {
  it("chat_job et chat_wake inscrits au registre et décodés", () => {
    expect(TYPES_EVENEMENTS_SYSTEME).toEqual(expect.arrayContaining(["chat_job", "chat_wake"]));
    const job = { type: "chat_job", data: { chat_id: "c1", job: JOB, active: 0, active_total: 2 } };
    expect(decoderEvenementSysteme(JSON.stringify(job))).toEqual({ statut: "ok", evenement: job });
    const reveil = {
      type: "chat_wake",
      data: { chat_id: "c1", chat_title: "T", status: "started", run_id: "r1", wake: REVEIL, queued: 2 },
    };
    expect(decoderEvenementSysteme(JSON.stringify(reveil))).toEqual({ statut: "ok", evenement: reveil });
  });

  it("JB-11, JB-17 : réveil écarté avec sa raison ; raison inconnue refusée", () => {
    const ecarte = {
      type: "chat_wake",
      data: { chat_id: "c1", chat_title: "T", status: "skipped", run_id: null, wake: REVEIL, queued: 0 },
    };
    for (const reason of ["wake_disabled", "max_depth", "quota", "chat_deleted"])
      expect(
        decoderEvenementSysteme(JSON.stringify({ ...ecarte, data: { ...ecarte.data, reason } })).statut,
      ).toBe("ok");
    expect(
      decoderEvenementSysteme(JSON.stringify({ ...ecarte, data: { ...ecarte.data, reason: "autre" } }))
        .statut,
    ).toBe("invalide");
  });
});

describe("run_started d'un tour de réveil", () => {
  const base = {
    type: "run_started",
    run_id: "r1",
    chat_id: "c1",
    engine_key: "builtin",
    model: "m",
    is_continue: false,
    base_count: 3,
    user_message: "[Automatic wake-up: background job event(s). The user did not write this message.]",
  };

  it("origine et résumé du réveil facultatifs ; origine inconnue refusée", () => {
    expect(schemaEvenementFlux.safeParse(base).success).toBe(true);
    expect(schemaEvenementFlux.safeParse({ ...base, origin: "job_wake", wake: REVEIL }).success).toBe(true);
    expect(schemaEvenementFlux.safeParse({ ...base, origin: "routine" }).success).toBe(false);
  });
});
