// SPDX-License-Identifier: MIT
/** apps/core/test/jobs/routes-internes.test.ts — `/api/internal/jobs*` (SPEC §3) : jeton de service et enveloppe signée exigés, enregistrement refusé hors tour (`not_available_here`), lancement, événements du compte seul, listes ; plus de route de reprise (la veille est poussée par le core). */
import "../moteur-environnement";

import { creerGardes, dependancesParDefaut, installerAuth } from "@elpis/auth";
import type { Dict } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { creerIdentite, IDENTITY_HEADER, sign } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { creerFamilleInterneJobs } from "../../src/familles/interne-jobs";
import { appTest } from "../aides";
import { creerBanc, creerChat, ev, lancerJob, tourActif } from "./aides";
import type { Banc } from "./aides";

const SVC = "jeton-de-service-des-jobs";
let b: Banc;
let app: FastifyInstance;
let restaurer: () => void;

beforeEach(async () => {
  restaurer = surchargerConfig({ LOCAL_MCP_TOKEN: SVC });
  b = await creerBanc();
  await creerChat(b, 1, "c1");
  const auth = { ...dependancesParDefaut(b.t.base, () => SVC) };
  app = await appTest({
    familles: [creerFamilleInterneJobs({ auth, service: b.service })],
    gardes: creerGardes(auth),
    extensions: [(a) => installerAuth(a, auth)],
  });
});

afterEach(async () => {
  await app.close();
  await b.fermer();
  restaurer();
});

const enveloppe = (uid: number, nom: string, cle = SVC): string =>
  sign(creerIdentite({ user_id: uid, username: nom }), cle);

async function appel(
  methode: "GET" | "POST",
  url: string,
  corps?: unknown,
  identite: string | null = enveloppe(1, "alice"),
  jeton = SVC,
): Promise<{ statut: number; json: Dict }> {
  const r = await app.inject({
    method: methode,
    url,
    headers: {
      authorization: `Bearer ${jeton}`,
      ...(identite === null ? {} : { [IDENTITY_HEADER]: identite }),
      ...(corps === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(corps === undefined ? {} : { payload: JSON.stringify(corps) }),
  });
  return { statut: r.statusCode, json: r.json() };
}

const ENREGISTREMENT = {
  chat_id: "c1",
  call_id: "call-9",
  label: "serveur",
  command: "python -m http.server 8000",
  cwd: "app",
  wake_on: ["port:8000"],
  resume_note: "Query /health then stop it.",
  wake: true,
};

describe("routes internes des jobs", () => {
  it("jeton de service et enveloppe signée exigés ; compte de l'enveloppe relu en base", async () => {
    expect((await appel("POST", "/api/internal/jobs", ENREGISTREMENT, null)).statut).toBe(401);
    expect(
      (await appel("POST", "/api/internal/jobs", ENREGISTREMENT, enveloppe(1, "alice", "autre"))).statut,
    ).toBe(401);
    expect((await appel("POST", "/api/internal/jobs", ENREGISTREMENT, enveloppe(1, "bob"))).statut).toBe(403);
    expect(
      (await appel("GET", "/api/internal/jobs", undefined, enveloppe(1, "alice"), "mauvais")).statut,
    ).toBe(401);
    expect(
      (await appel("POST", "/api/internal/jobs", { ...ENREGISTREMENT, resume_note: "x".repeat(601) })).statut,
    ).toBe(422);
  });

  it("enregistrement : `not_available_here` sans tour de premier niveau, puis job, lancement, événements, listes ; pas de `/running`", async () => {
    expect((await appel("POST", "/api/internal/jobs", ENREGISTREMENT)).json).toMatchObject({
      ok: false,
      error: "not_available_here",
    });
    const fin = tourActif(1, "c1", 1);
    const r = await appel("POST", "/api/internal/jobs", ENREGISTREMENT);
    fin();
    expect(r.statut).toBe(200);
    expect(r.json).toMatchObject({ ok: true, active_jobs: 1, max_jobs: 3, depth: 1 });
    const id = String(r.json["job_id"]);
    expect(
      (await appel("POST", "/api/internal/jobs/state", { job_id: id, state: "running", pid: 99 })).json,
    ).toEqual({
      ok: true,
    });
    expect(
      (await appel("POST", "/api/internal/jobs/state", { job_id: id, state: "running" }, enveloppe(2, "bob")))
        .json,
    ).toMatchObject({ ok: false, error: "job_not_found" });
    const e1 = ev(id, {
      trigger: "port",
      spec: "port:8000",
      state: "running",
      exit_code: null,
      still_running: true,
    });
    expect(
      (
        await appel(
          "POST",
          "/api/internal/jobs/events",
          { events: [e1], last_seq: e1["seq"] },
          enveloppe(2, "bob"),
        )
      ).json,
    ).toEqual({ ok: true, acked_seq: e1["seq"], accepted: 0, rejected: 1 });
    expect(
      (await appel("POST", "/api/internal/jobs/events", { events: [e1], last_seq: e1["seq"] })).json,
    ).toEqual({
      ok: true,
      acked_seq: e1["seq"],
      accepted: 1,
      rejected: 0,
    });
    const liste = (await appel("GET", "/api/internal/jobs?chat_id=c1")).json;
    expect(liste).toMatchObject({ active_jobs: 1, max_jobs: 3 });
    expect(liste["jobs"]).toEqual([
      expect.objectContaining({
        job_id: id,
        chat_id: "c1",
        label: "serveur",
        command: "python -m http.server 8000",
        state: "running",
        wake_on: ["exit", "port:8000"],
        wake: true,
        pid: 99,
        exit_code: null,
      }),
    ]);
    expect(
      (await appel("POST", "/api/internal/jobs/delivered", { job_id: id }, enveloppe(2, "bob"))).json,
    ).toMatchObject({
      ok: false,
      error: "job_not_found",
    });
    expect((await appel("POST", "/api/internal/jobs/delivered", { job_id: id })).json).toEqual({
      ok: true,
      delivered: 1,
    });
    expect((await appel("POST", "/api/internal/jobs/delivered", { job_id: id })).json).toEqual({
      ok: true,
      delivered: 0,
    });
    expect((await appel("GET", "/api/internal/jobs")).json).toMatchObject({ active_jobs: 1, max_jobs: 5 });
    expect((await appel("GET", "/api/internal/jobs", undefined, enveloppe(2, "bob"))).json["jobs"]).toEqual(
      [],
    );
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/api/internal/jobs/running",
          headers: { authorization: `Bearer ${SVC}` },
        })
      ).statusCode,
    ).toBe(404);
  });

  it("active_jobs ne compte que les commandes, comme leur limite : un sous-agent en fond est listé, pas compté", async () => {
    const id = await lancerJob(b, 1, "c1");
    const fin = tourActif(1, "c1");
    const agent = await b.service.portTaches().inscrire(1, "c1", {
      callId: "call-t",
      label: "implement — x",
      max: 2,
      detail: { child_id: "t1-aa", agent: "implement", state: "running" },
    });
    fin();
    expect(agent.ok).toBe(true);
    const liste = (await appel("GET", "/api/internal/jobs?chat_id=c1")).json;
    expect(liste).toMatchObject({ active_jobs: 1, max_jobs: 3 });
    expect((liste["jobs"] as Dict[]).map((j) => j["job_id"])).toContain(id);
    expect(liste["jobs"]).toHaveLength(2);
    expect((await appel("GET", "/api/internal/jobs")).json).toMatchObject({ active_jobs: 1 });
  });
});
