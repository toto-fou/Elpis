// SPDX-License-Identifier: MIT
/** apps/core/test/jobs/service.test.ts — réveilleur des tâches de fond (horloge et boucle simulées, tour réel, faux hôte d'outils) : enregistrement, événements forgés, livraisons et réveils (JB-01, JB-07 à JB-11, JB-17, JB-20), file par compte, plafond, quotas, redémarrage. */
import "../moteur-environnement";

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Dict } from "@elpis/commun";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deleteChat, enforceRecentChatsCap, getChat, upsertChat } from "../../src/chats/stockage";
import { installerServiceJobs } from "../../src/jobs/branchements";
import { enAttente, listerJobs } from "../../src/jobs/magasin";
import { ServiceJobs } from "../../src/jobs/service";
import { runTurn } from "../../src/tour/execution";
import { expandHistoryForLlm, normalizeClientMessages } from "../../src/tour/historique";
import { runDir } from "../../src/tour/journal-run";
import { ouvrirTour } from "../../src/tour/ouverture";
import {
  compteJobsWake,
  corps,
  creerBanc,
  creerChat,
  ev,
  lancerJob,
  notificationsEnBase,
  reveils,
  tourActif,
} from "./aides";
import type { Banc } from "./aides";

let b: Banc;

beforeEach(async () => {
  b = await creerBanc();
  await creerChat(b, 1, "c1", "Projet");
});

afterEach(async () => {
  await b.fermer();
});

const contenuDernier = (tour: Dict[] | undefined): string => String(tour?.at(-1)?.["content"] ?? "");

function lignesJournal(): Dict[] {
  const out: Dict[] = [];
  const parcourir = (d: string): void => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (n.isDirectory()) parcourir(join(d, n.name));
      else if (n.name.endsWith(".jsonl"))
        for (const l of readFileSync(join(d, n.name), "utf-8").split("\n"))
          if (l) out.push((JSON.parse(l) as { e: Dict }).e);
    }
  };
  parcourir(runDir());
  return out;
}

describe("enregistrement d'un job", () => {
  it("not_available_here : conversation absente, aucun tour actif, sous-agent, routine, conversation éphémère", async () => {
    const refus = async (uid: number, chatId: string, avant?: () => () => void): Promise<unknown> => {
      const fin = avant?.();
      try {
        return (await b.service.enregistrer(uid, corps(chatId), ""))["error"];
      } finally {
        fin?.();
      }
    };
    expect(await refus(1, "c1")).toBe("not_available_here");
    expect(await refus(1, "inconnu", () => tourActif(1, "inconnu"))).toBe("not_available_here");
    expect(await refus(1, "c1#task-ab12", () => tourActif(1, "c1#task-ab12"))).toBe("not_available_here");
    expect(await refus(1, "routine:3:run:9", () => tourActif(1, "routine:3:run:9"))).toBe(
      "not_available_here",
    );
    expect(await refus(1, "c1", () => tourActif(1, "c1", 0, { ephemeral: true }))).toBe("not_available_here");
    expect(await refus(2, "c1", () => tourActif(2, "c1"))).toBe("not_available_here");
    expect(await listerJobs(b.t.base, 1, null)).toEqual([]);
  });

  it("JB-10 : 4ᵉ job simultané refusé `limit_exceeded` avec la liste des actifs ; limite du compte ; instantané gardé sans adresse", async () => {
    const fin = tourActif(1, "c1", 2);
    const premiers = [];
    for (const label of ["a", "b", "c"])
      premiers.push(await b.service.enregistrer(1, corps("c1", { label }), "h1"));
    expect(premiers.map((r) => [r["ok"], r["active_jobs"], r["max_jobs"], r["depth"]])).toEqual([
      [true, 1, 3, 2],
      [true, 2, 3, 2],
      [true, 3, 3, 2],
    ]);
    const r = await b.service.enregistrer(1, corps("c1", { label: "d" }), "h1");
    expect(r).toMatchObject({ ok: false, error: "limit_exceeded", max_jobs: 3 });
    expect((r["active"] as Dict[]).map((j) => j["label"])).toEqual(["a", "b", "c"]);
    fin();
    const jobs = await listerJobs(b.t.base, 1, "c1");
    expect(jobs[0]?.turn).toMatchObject({ model: "m", active_mcp_servers: [{ id: "srv1" }], depth: 2 });
    expect(jobs[0]?.wakeOn).toEqual(["exit"]);
    for (const c of ["c2", "c3"]) await creerChat(b, 1, c);
    const fin2 = tourActif(1, "c2");
    expect((await b.service.enregistrer(1, corps("c2"), ""))["ok"]).toBe(true);
    expect((await b.service.enregistrer(1, corps("c2"), ""))["ok"]).toBe(true);
    const refus = await b.service.enregistrer(1, corps("c2"), "");
    expect(refus).toMatchObject({ ok: false, error: "limit_exceeded", max_jobs: 5 });
    expect(refus["active"]).toHaveLength(5);
    fin2();
    expect(b.publications.filter((p) => p["type"] === "chat_job")).toHaveLength(5);
  });

  it("libellé par défaut, `exit` toujours armé, lancement confirmé puis `failed`", async () => {
    const fin = tourActif(1, "c1");
    const r = await b.service.enregistrer(
      1,
      corps("c1", {
        label: "",
        command: "python -m http.server 8000 --bind 0.0.0.0",
        wake_on: ["port:8000"],
      }),
      "",
    );
    fin();
    const id = String(r["job_id"]);
    expect(id).toMatch(/^j-[0-9a-f]{8}$/u);
    const [job] = await listerJobs(b.t.base, 1, "c1");
    expect([job?.label, job?.wakeOn, job?.state]).toEqual([
      "python -m http.server 8000 --bind 0.0.0.",
      ["exit", "port:8000"],
      "starting",
    ]);
    expect(await b.service.poserEtat(1, id, "running", 77, "")).toEqual({ ok: true });
    expect(await b.service.poserEtat(2, id, "running", 77, "")).toMatchObject({ error: "job_not_found" });
    expect(await b.service.poserEtat(1, id, "failed", null, "boom")).toEqual({ ok: true });
    const [fini] = await listerJobs(b.t.base, 1, "c1");
    expect([fini?.state, fini?.pid, fini?.lastLine]).toEqual(["failed", 77, "boom"]);
    const etats = b.publications
      .filter((p) => p["type"] === "chat_job")
      .map((p) => (p["data"] as Dict)["job"] as Dict);
    expect(etats.map((j) => j["state"])).toEqual(["starting", "running", "failed"]);
    expect(etats[0]?.["log"]).toBe(`/work/.bg/job-${id}.log`);
  });
});

describe("événements reçus", () => {
  it("événements forgés refusés : autre compte, id mal formé, seq non croissant ; doublon acquitté sans réinsertion ; seq 0 synthétique", async () => {
    const id = await lancerJob(b, 1, "c1");
    const e1 = ev(id, {
      trigger: "match",
      spec: "match:ready",
      state: "running",
      exit_code: null,
      still_running: true,
    });
    expect(await b.service.recevoir(1, [e1], 0)).toEqual({
      ok: true,
      acked_seq: e1["seq"],
      accepted: 1,
      rejected: 0,
    });
    expect(await b.service.recevoir(1, [e1], 0)).toMatchObject({ accepted: 0, rejected: 0 });
    expect(await b.service.recevoir(2, [ev(id)], 0)).toMatchObject({ accepted: 0, rejected: 1 });
    expect(await b.service.recevoir(1, [{ ...ev(id), job_id: "../x" }, "pas un objet"], 0)).toMatchObject({
      accepted: 0,
      rejected: 2,
    });
    expect(await b.service.recevoir(1, [{ ...ev(id), seq: Number(e1["seq"]) - 1 }], 0)).toMatchObject({
      accepted: 0,
      rejected: 1,
    });
    expect(await b.service.recevoir(1, [{ ...ev(id), trigger: "pirate" }], 0)).toMatchObject({ rejected: 1 });
    const perdu = { ...ev(id, { trigger: "lost", state: "lost", exit_code: null }), seq: 0, synthetic: true };
    expect(await b.service.recevoir(1, [{ ...perdu, synthetic: false }], 0)).toMatchObject({ rejected: 1 });
    expect(await b.service.recevoir(1, [perdu], 0)).toMatchObject({ accepted: 1 });
    expect(await b.service.recevoir(1, [{ ...perdu, seq: 0 }], 0)).toMatchObject({
      accepted: 0,
      rejected: 0,
    });
    const [job] = await listerJobs(b.t.base, 1, "c1");
    expect(job?.state).toBe("lost");
    expect((await enAttente(b.t.base, 1, "c1")).map((e) => e.kind)).toEqual(["match", "lost"]);
  });

  it("charges tronquées à `event_max_bytes`, état terminal sans retour arrière", async () => {
    const id = await lancerJob(b, 1, "c1");
    await b.service.recevoir(1, [ev(id, { exit_code: 1, tail: Array(40).fill("x".repeat(900)) })], 0);
    await b.service.recevoir(
      1,
      [ev(id, { trigger: "idle", spec: "idle:60", state: "running", still_running: true })],
      0,
    );
    const [job] = await listerJobs(b.t.base, 1, "c1");
    expect([job?.state, job?.exitCode]).toEqual(["exited", 1]);
    const lignes = await b.t.base.all("SELECT payload_json FROM shell_job_events ORDER BY id");
    expect(lignes.every((l) => Buffer.byteLength(String(l["payload_json"])) <= 3072)).toBe(true);
  });

  it("numérotation de l'agent repartie plus bas (journal d'événements perdu) : la fin d'un job actif passe et réveille ; rejouée, écartée", async () => {
    const id = await lancerJob(b, 1, "c1");
    const vieux = ev(id, {
      seq: 50,
      trigger: "match",
      spec: "match:x",
      state: "running",
      still_running: true,
    });
    await b.service.recevoir(1, [vieux], 50);
    const fin = ev(id, { seq: 3 });
    expect(await b.service.recevoir(1, [fin], 3)).toMatchObject({ acked_seq: 3, accepted: 1, rejected: 0 });
    expect((await listerJobs(b.t.base, 1, "c1"))[0]).toMatchObject({ state: "exited", lastSeq: 51 });
    expect(await b.service.recevoir(1, [fin], 3)).toMatchObject({ accepted: 0 });
    expect(
      await b.service.recevoir(1, [ev(id, { seq: 4, trigger: "match", state: "running" })], 4),
    ).toMatchObject({
      accepted: 0,
      rejected: 1,
    });
    await b.horloge.avancer(3, b.service);
    expect(contenuDernier(b.tours[0])).toContain('trigger="exit"');
  });

  it("lancement non confirmé (core injoignable) : un événement `running` de l'agent fait passer le job `running`, qui reste actif et arrêtable ; la confirmation tardive pose le pid", async () => {
    const fin = tourActif(1, "c1");
    const r = await b.service.enregistrer(1, corps("c1", { wake_on: ["exit", "match:ready"] }), "local");
    fin();
    const id = String(r["job_id"]);
    const pret = ev(id, {
      trigger: "match",
      spec: "match:ready",
      state: "running",
      exit_code: null,
      still_running: true,
    });
    await b.service.recevoir(1, [pret], 0);
    expect((await listerJobs(b.t.base, 1, "c1"))[0]).toMatchObject({ state: "running", pid: null });
    expect(b.publications.filter((p) => p["type"] === "chat_job").at(-1)?.["data"]).toMatchObject({
      active: 1,
    });
    await b.horloge.avancer(901, b.service);
    expect((await listerJobs(b.t.base, 1, "c1"))[0]?.state).toBe("running");
    await b.service.poserEtat(1, id, "running", 4242, "");
    expect((await listerJobs(b.t.base, 1, "c1"))[0]).toMatchObject({ state: "running", pid: 4242 });
    expect(await b.service.arreterJobs(1, { chatId: "c1" })).toMatchObject({ stopped: [id] });
  });
});

describe("réveil d'une conversation", () => {
  it("JB-01 : exit → réveil en moins de 5 s : tour serveur, message `job_wake` persisté, run_started, chat_wake, sans notification", async () => {
    const id = await lancerJob(b, 1, "c1");
    await b.service.recevoir(1, [ev(id, { exit_code: 1, duration_s: 603.2, tail: ["FAILED test_api"] })], 0);
    await b.horloge.avancer(1.9, b.service);
    expect(b.tours).toHaveLength(0);
    await b.horloge.avancer(0.2, b.service);
    expect(b.tours).toHaveLength(1);
    const texte = contenuDernier(b.tours[0]);
    expect(b.tours[0]?.at(-1)?.["role"]).toBe("user");
    expect(
      texte.startsWith(
        "[Automatic wake-up, chain depth 1/5: background job event(s). The user did not write this message.]\n",
      ),
    ).toBe(true);
    expect(texte).toContain(
      `<job_event id="${id}" label="pytest" trigger="exit" state="exited" exit_code="1" duration="10m03s">`,
    );
    expect(texte).toContain("resume_note: If green, commit.");
    expect(texte).toContain("FAILED test_api");
    const chat = await getChat(b.t.base, 1, "c1");
    const messages = chat?.["messages"] as Dict[];
    const reveil = messages.find((m) => m["origin"] === "job_wake");
    expect(reveil).toMatchObject({ role: "user", content: texte });
    expect(reveil?.["wake"]).toMatchObject({ summary: "pytest terminé, code 1, 10 min 03 s", depth: 1 });
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: "Repris." });
    expect(reveils(b).map((d) => d["status"])).toEqual(["queued", "started", "done"]);
    expect(reveils(b, "started")[0]?.["run_id"]).toMatch(/^[0-9a-f]{16}$/u);
    expect(reveils(b, "done")[0]).toMatchObject({ user_id: 1, chat_id: "c1", chat_title: "Projet" });
    const debut = lignesJournal().find((l) => l["type"] === "run_started");
    expect(debut).toMatchObject({ origin: "job_wake", wake: { depth: 1 } });
    expect(await notificationsEnBase(b)).toEqual([]);
    expect(await enAttente(b.t.base, 1, "c1")).toEqual([]);
    await b.horloge.avancer(30, b.service);
    expect(b.tours).toHaveLength(1);
  });

  it("JB-09 : trois jobs qui finissent à 1 s d'intervalle → un seul réveil qui regroupe les trois événements", async () => {
    const ids = [await lancerJob(b, 1, "c1"), await lancerJob(b, 1, "c1"), await lancerJob(b, 1, "c1")];
    for (const id of ids) {
      await b.service.recevoir(1, [ev(id)], 0);
      await b.horloge.avancer(1, b.service);
    }
    expect(b.tours).toHaveLength(0);
    await b.horloge.avancer(2, b.service);
    expect(b.tours).toHaveLength(1);
    expect(contenuDernier(b.tours[0]).match(/<job_event /gu)).toHaveLength(3);
    await b.horloge.avancer(20, b.service);
    expect(b.tours).toHaveLength(1);
  });

  it("JB-09 : événements en rafale continue → réveil au plus tard 10 s après le premier", async () => {
    const id = await lancerJob(b, 1, "c1");
    for (let i = 0; i < 12; i++) {
      await b.service.recevoir(
        1,
        [ev(id, { trigger: "regex", spec: "regex:x", state: "running", still_running: true })],
        0,
      );
      await b.horloge.avancer(1, b.service);
      if (i === 9) expect(b.tours).toHaveLength(1);
    }
  });

  it("JB-07 : événement pendant un tour actif → livré au prochain résultat d'outil, aucun tour ajouté ; fin sans autre outil → réveil réarmé", async () => {
    const id = await lancerJob(b, 1, "c1");
    const fin = tourActif(1, "c1");
    await b.service.recevoir(1, [ev(id)], 0);
    await b.horloge.avancer(5, b.service);
    expect(b.tours).toHaveLength(0);
    expect(b.service.enAttente(1, "c1")).toBe(true);
    const suffixe = await b.service.prendrePourResultat(1, "c1");
    expect(suffixe?.startsWith(`<job_event id="${id}"`)).toBe(true);
    expect(suffixe).not.toContain("Automatic wake-up");
    expect(b.service.enAttente(1, "c1")).toBe(false);
    expect(await b.service.prendrePourResultat(1, "c1")).toBeNull();
    b.service.finTour(1, "c1", "run-c1", { message: true, reponse: true, suffixe: false });
    fin();
    await b.horloge.avancer(5, b.service);
    expect(b.tours).toHaveLength(0);
    const id2 = await lancerJob(b, 1, "c1");
    const fin2 = tourActif(1, "c1");
    await b.service.recevoir(1, [ev(id2)], 0);
    await b.horloge.avancer(5, b.service);
    expect(b.tours).toHaveLength(0);
    fin2();
    await b.horloge.avancer(0.1, b.service);
    expect(b.tours).toHaveLength(1);
  });

  it("livraison d'un tour qui n'a rien persisté : événements rendus, sans réveil immédiat, joints au message suivant (ni perte)", async () => {
    const id = await lancerJob(b, 1, "c1");
    const fin = tourActif(1, "c1");
    await b.service.recevoir(1, [ev(id)], 0);
    expect(await b.service.prendrePourResultat(1, "c1")).not.toBeNull();
    b.service.finTour(1, "c1", "run-c1", { message: false, reponse: false, suffixe: false });
    fin();
    await b.horloge.avancer(5, b.service);
    expect(b.tours).toHaveLength(0);
    expect((await enAttente(b.t.base, 1, "c1")).map((e) => e.jobId)).toEqual([id]);
    expect(await b.service.prendrePourMessage(1, "c1", "r2")).toContain(id);
  });

  it("JB-08 : l'utilisateur écrit → réveil différé, événement joint au message envoyé (`llm_user_suffix` rejoué à l'identique), ni perte ni doublon", async () => {
    const id = await lancerJob(b, 1, "c1");
    await b.service.saisie(1, "c1");
    await b.service.recevoir(1, [ev(id, { exit_code: 2 })], 0);
    await b.horloge.avancer(15, b.service);
    expect(b.tours).toHaveLength(0);
    const chat = await getChat(b.t.base, 1, "c1");
    const messages = [...(chat?.["messages"] as Dict[]), { role: "user", content: "Où en est-on ?" }];
    const tour = await ouvrirTour({ base: b.t.base }, 1, { chat_id: "c1", messages });
    expect(tour.plan.jobSuffix).toContain(`exit_code="2"`);
    for await (const e of runTurn(
      { base: b.t.base },
      tour.plan,
      tour.res,
      tour.base,
      new AbortController().signal,
    ))
      void e;
    expect(b.tours).toHaveLength(1);
    const vu = contenuDernier(b.tours[0]);
    expect(vu.startsWith("Où en est-on ?\n\n<job_event ")).toBe(true);
    const apres = await getChat(b.t.base, 1, "c1");
    const suffixes = apres?.["llm_user_suffixes"] as Dict;
    expect(Object.values(suffixes)).toEqual([tour.plan.jobSuffix]);
    const [persistes] = normalizeClientMessages([
      ...(apres?.["messages"] as Dict[]),
      { role: "user", content: "Et ensuite ?" },
    ]);
    const rejoue = expandHistoryForLlm(persistes, { userSuffixes: suffixes });
    expect(rejoue.filter((m) => m["role"] === "user").at(-2)?.["content"]).toBe(vu);
    expect(await enAttente(b.t.base, 1, "c1")).toEqual([]);
    await b.horloge.avancer(30, b.service);
    expect(b.tours).toHaveLength(1);
  });

  it("JB-11 : job lancé à la limite de chaîne → enregistré sans réveil (`chain_limit`), consigné `max_depth`, joint au réveil suivant", async () => {
    const fin = tourActif(1, "c1", 5);
    const r = await b.service.enregistrer(1, corps("c1"), "local");
    fin();
    expect(r).toMatchObject({ ok: true, depth: 5, max_depth: 5, wake: false, chain_limit: true });
    const id = String(r["job_id"]);
    await b.service.poserEtat(1, id, "running", 4242, "");
    expect((await listerJobs(b.t.base, 1, "c1"))[0]?.wake).toBe(false);
    await b.service.recevoir(1, [ev(id)], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.tours).toHaveLength(0);
    expect(reveils(b, "skipped")[0]).toMatchObject({ reason: "max_depth", chat_id: "c1" });
    expect(await notificationsEnBase(b)).toEqual([]);
    expect(await enAttente(b.t.base, 1, "c1")).toHaveLength(1);
    await b.horloge.avancer(60, b.service);
    const id4 = await lancerJob(b, 1, "c1", { profondeur: 4 });
    await b.service.recevoir(1, [ev(id4)], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.tours).toHaveLength(1);
    const texte = contenuDernier(b.tours[0]);
    expect(texte.split("\n")[0]).toBe(
      "[Automatic wake-up, chain depth 5/5 (limit reached: a job you start now will not wake you): " +
        "background job event(s). The user did not write this message.]",
    );
    expect(texte).toContain(
      `<job_event id="${id}" label="pytest" trigger="exit" state="exited" exit_code="0" duration="3s" chain_depth="5">`,
    );
    expect(texte).toContain(
      `<job_event id="${id4}" label="pytest" trigger="exit" state="exited" exit_code="0" duration="3s" chain_depth="4">`,
    );
  });

  it("JB-11 : limite abaissée après le lancement → réveil écarté `max_depth`, événement gardé", async () => {
    const id = await lancerJob(b, 1, "c1", { profondeur: 3 });
    b.reglages = { ...b.reglages, max_depth: 3 };
    await b.service.recevoir(1, [ev(id)], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.tours).toHaveLength(0);
    expect(reveils(b, "skipped")[0]).toMatchObject({ reason: "max_depth", chat_id: "c1" });
    expect(await enAttente(b.t.base, 1, "c1")).toHaveLength(1);
  });

  it("JB-11 : chaque maillon lancé par un réveil compte un cran de plus ; la chaîne s'arrête à la limite ; un message de l'utilisateur la remet à 0", async () => {
    b.reglages = { ...b.reglages, max_depth: 2 };
    const vues: Dict[] = [];
    b.pendantTour = async () => {
      const r = await b.service.enregistrer(1, corps("c1"), "local");
      vues.push(r);
      await b.service.poserEtat(1, String(r["job_id"]), "running", 4242, "");
    };
    const id0 = await lancerJob(b, 1, "c1");
    await b.service.recevoir(1, [ev(id0)], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.tours).toHaveLength(1);
    expect(contenuDernier(b.tours[0]).split("\n")[0]).toContain("chain depth 1/2:");
    expect(vues[0]).toMatchObject({ ok: true, depth: 1, max_depth: 2, wake: true, chain_limit: false });
    await b.service.recevoir(1, [ev(String(vues[0]?.["job_id"]))], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.tours).toHaveLength(2);
    const second = contenuDernier(b.tours[1]);
    expect(second.split("\n")[0]).toContain("chain depth 2/2 (limit reached");
    expect(second).toContain('chain_depth="1"');
    expect(vues[1]).toMatchObject({ ok: true, depth: 2, max_depth: 2, wake: false, chain_limit: true });
    const id2 = String(vues[1]?.["job_id"]);
    await b.service.recevoir(1, [ev(id2)], 0);
    await b.horloge.avancer(30, b.service);
    expect(b.tours).toHaveLength(2);
    expect(reveils(b, "skipped").map((d) => d["reason"])).toEqual(["max_depth"]);
    const chat = await getChat(b.t.base, 1, "c1");
    const messages = [...(chat?.["messages"] as Dict[]), { role: "user", content: "Et alors ?" }];
    const tour = await ouvrirTour({ base: b.t.base }, 1, { chat_id: "c1", messages });
    expect(tour.plan.depth).toBe(0);
    expect(tour.plan.jobSuffix).toContain(`<job_event id="${id2}"`);
    expect(tour.plan.jobSuffix).toContain('chain_depth="2"');
    for await (const e of runTurn(
      { base: b.t.base },
      tour.plan,
      tour.res,
      tour.base,
      new AbortController().signal,
    ))
      void e;
    expect(b.tours).toHaveLength(3);
    expect(vues[2]).toMatchObject({ ok: true, depth: 0, max_depth: 2, wake: true, chain_limit: false });
  });

  it("JB-11 : profondeur 4 → réveil de profondeur 5 accepté, job relancé dans ce tour à profondeur 5", async () => {
    const id = await lancerJob(b, 1, "c1", { profondeur: 4 });
    await b.service.recevoir(1, [ev(id)], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.tours).toHaveLength(1);
    expect(reveils(b, "started")[0]?.["wake"]).toMatchObject({ depth: 5 });
  });

  it("JB-18 : résultat rendu par execute_shell → l'exit, arrivé avant OU après la marque, naît livré, aucun tour", async () => {
    const avant = await lancerJob(b, 1, "c1");
    await b.service.recevoir(1, [ev(avant, { exit_code: 0 })], 0);
    expect(await b.service.marquerLivre(1, avant)).toEqual({ ok: true, delivered: 1 });
    const apres = await lancerJob(b, 1, "c1");
    expect(await b.service.marquerLivre(1, apres)).toEqual({ ok: true, delivered: 0 });
    await b.service.recevoir(1, [ev(apres, { exit_code: 0 })], 0);
    await b.horloge.avancer(15, b.service);
    expect(b.tours).toHaveLength(0);
    expect(
      await b.t.base.all("SELECT job_id FROM shell_job_events WHERE delivered_at IS NULL ORDER BY job_id"),
    ).toEqual([]);
    expect(await b.service.marquerLivre(1, "j-00000000")).toMatchObject({
      ok: false,
      error: "job_not_found",
    });
  });

  it("JB-17 : « Ne pas me réveiller » → consigné sans notification, aucun tour ; défaut du compte ; job `wake=false`", async () => {
    expect(await b.service.poserReveil(1, "c1", true)).toBe(true);
    expect(await b.service.poserReveil(1, "absent", true)).toBe(false);
    const id = await lancerJob(b, 1, "c1");
    await b.service.recevoir(1, [ev(id)], 0);
    await b.horloge.avancer(5, b.service);
    expect(b.tours).toHaveLength(0);
    expect(reveils(b, "skipped").map((d) => d["reason"])).toEqual(["wake_disabled"]);
    expect(await notificationsEnBase(b)).toEqual([]);
    expect(await enAttente(b.t.base, 1, "c1")).toHaveLength(1);
    expect(await b.service.reveilCoupeDuChat(1, "c1")).toBe(true);
    await b.service.poserReveil(1, "c1", false);
    await b.horloge.avancer(1, b.service);
    expect(b.tours).toHaveLength(1);

    await creerChat(b, 1, "c2");
    await compteJobsWake(b, 1, false);
    expect(await b.service.reveilCoupeDuChat(1, "c2")).toBe(true);
    const id2 = await lancerJob(b, 1, "c2");
    await b.service.recevoir(1, [ev(id2)], 0);
    await b.horloge.avancer(5, b.service);
    expect(b.tours).toHaveLength(1);
    await compteJobsWake(b, 1, true);

    await creerChat(b, 1, "c3");
    const id3 = await lancerJob(b, 1, "c3", { wake: false });
    await b.service.recevoir(1, [ev(id3)], 0);
    await b.horloge.avancer(5, b.service);
    expect(b.tours).toHaveLength(1);
    expect(reveils(b, "skipped").map((d) => d["chat_id"])).toEqual(["c1", "c2", "c3"]);
  });

  it("`killed` : par l'agent livré d'office, par l'utilisateur sans réveil (joint au prochain message)", async () => {
    const id = await lancerJob(b, 1, "c1");
    const id2 = await lancerJob(b, 1, "c1");
    await b.service.recevoir(
      1,
      [ev(id, { trigger: "killed", state: "killed", by: "agent", exit_code: null })],
      0,
    );
    await b.service.recevoir(
      1,
      [ev(id2, { trigger: "killed", state: "killed", by: "user", exit_code: null })],
      0,
    );
    await b.horloge.avancer(5, b.service);
    expect(b.tours).toHaveLength(0);
    expect((await enAttente(b.t.base, 1, "c1")).map((e) => e.jobId)).toEqual([id2]);
  });

  it("file par compte : un seul réveil à la fois, ordre d'arrivée, sans notification", async () => {
    for (const c of ["c2", "c3"]) await creerChat(b, 1, c, `T-${c}`);
    const jobs = [await lancerJob(b, 1, "c1"), await lancerJob(b, 1, "c2"), await lancerJob(b, 1, "c3")];
    b.retenir = true;
    await b.service.recevoir(1, [ev(jobs[0]!)], 0);
    await b.horloge.avancer(2.5, b.service, false);
    for (let i = 0; i < 200 && b.tours.length < 1; i++) await new Promise((ok) => setTimeout(ok, 10));
    expect(b.tours).toHaveLength(1);
    await b.service.recevoir(1, [ev(jobs[2]!)], 0);
    await b.horloge.avancer(0.5, b.service, false);
    await b.service.recevoir(1, [ev(jobs[1]!)], 0);
    await b.horloge.avancer(10, b.service, false);
    expect(b.tours).toHaveLength(1);
    const liste = await b.service.liste(1, null);
    expect((liste["wake_queue"] as Dict[]).map((q) => q["chat_id"])).toEqual(["c3", "c2"]);
    expect((liste["wake_running"] as Dict[]).map((q) => q["chat_id"])).toEqual(["c1"]);
    expect(await notificationsEnBase(b)).toEqual([]);
    b.retenir = false;
    b.relacher();
    await b.horloge.avancer(1, b.service);
    expect(b.tours.map((t) => (/id="(j-[0-9a-f]{8})"/u.exec(contenuDernier(t)) ?? [])[1])).toEqual([
      jobs[0],
      jobs[2],
      jobs[1],
    ]);
    expect(reveils(b, "started").map((d) => d["chat_id"])).toEqual(["c1", "c3", "c2"]);
  });

  it("quota : 12 réveils par heure et par conversation, puis consigné", async () => {
    b.reglages = { ...b.reglages, wakes_per_hour: 2 };
    for (let i = 0; i < 3; i++) {
      const id = await lancerJob(b, 1, "c1");
      await b.service.recevoir(1, [ev(id)], 0);
      await b.horloge.avancer(3, b.service);
    }
    expect(b.tours).toHaveLength(2);
    expect(reveils(b, "skipped")[0]).toMatchObject({ reason: "quota" });
    await b.horloge.avancer(3600, b.service);
    const id = await lancerJob(b, 1, "c1");
    await b.service.recevoir(1, [ev(id)], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.tours).toHaveLength(3);
    expect(contenuDernier(b.tours[2]).match(/<job_event /gu)).toHaveLength(2);
  });

  it("409 : génération en cours au départ du réveil → réessai à la fin du tour", async () => {
    const id = await lancerJob(b, 1, "c1");
    await b.service.recevoir(1, [ev(id)], 0);
    const fin = tourActif(1, "c1");
    await b.horloge.avancer(40, b.service);
    expect(b.tours).toHaveLength(0);
    fin();
    await b.horloge.avancer(0.1, b.service);
    expect(b.tours).toHaveLength(1);
  });
});

describe("arrêts, suppression, plafond, redémarrage", () => {
  it("JB-20 : conversation supprimée avec job actif → job arrêté et purgé sur l'hôte, lignes effacées, aucun tour recréé", async () => {
    const id = await lancerJob(b, 1, "c1");
    await b.service.recevoir(
      1,
      [ev(id, { trigger: "port", spec: "port:8000", state: "running", still_running: true })],
      0,
    );
    expect(await deleteChat(b.t.base, 1, "c1")).toBe(true);
    await b.horloge.avancer(10, b.service);
    expect(b.appelsHote).toEqual([{ uid: 1, ids: [id], par: "core", purge: true }]);
    expect(await b.t.base.all("SELECT id FROM shell_jobs")).toEqual([]);
    expect(await b.t.base.all("SELECT id FROM shell_job_events")).toEqual([]);
    expect(b.tours).toHaveLength(0);
    expect(await getChat(b.t.base, 1, "c1")).toBeNull();
    expect(await b.service.recevoir(1, [ev(id)], 0)).toMatchObject({ accepted: 0, rejected: 1 });
  });

  it("JB-20 : hôte injoignable à la suppression → jobs détachés, hors des listes, purge réessayée par le balayage puis lignes effacées", async () => {
    const id = await lancerJob(b, 1, "c1");
    b.hoteEnPanne = true;
    expect(await deleteChat(b.t.base, 1, "c1")).toBe(true);
    await b.horloge.avancer(10, b.service);
    expect(await b.t.base.all("SELECT state, kill_by FROM shell_jobs")).toEqual([
      { state: "killed", kill_by: "chat_deleted" },
    ]);
    expect(await listerJobs(b.t.base, 1, null)).toEqual([]);
    expect(await b.service.recevoir(1, [ev(id)], 0)).toMatchObject({ accepted: 0, rejected: 1 });
    b.hoteEnPanne = false;
    await b.horloge.avancer(400, b.service);
    expect(b.appelsHote).toEqual([{ uid: 1, ids: [id], par: "core", purge: true }]);
    expect(await b.t.base.all("SELECT id FROM shell_jobs")).toEqual([]);
    expect(b.tours).toHaveLength(0);
  });

  it("`enforceRecentChatsCap` épargne les conversations à job actif", async () => {
    const id = await lancerJob(b, 1, "c1");
    for (let i = 0; i < 205; i++) await upsertChat(b.t.base, 1, `n${i}`, "x", [], 2000 + i);
    await enforceRecentChatsCap(b.t.base, 1);
    expect(await getChat(b.t.base, 1, "c1")).not.toBeNull();
    expect((await listerJobs(b.t.base, 1, "c1")).map((j) => j.id)).toEqual([id]);
  });

  it("arrêt depuis l'interface : `by: \"user\"` à l'hôte, introuvables rendus ; hôte injoignable → 502", async () => {
    const id = await lancerJob(b, 1, "c1");
    expect(await b.service.arreterJobs(1, { ids: [id, "j-00000000"] })).toEqual({
      ok: true,
      stopped: [id],
      not_found: ["j-00000000"],
    });
    expect(b.appelsHote).toEqual([{ uid: 1, ids: [id], par: "user", purge: false }]);
    expect(await b.service.arreterJobs(2, { tous: true })).toEqual({ ok: true, stopped: [], not_found: [] });
    b.hoteEnPanne = true;
    await expect(b.service.arreterJobs(1, { chatId: "c1" })).rejects.toMatchObject({ statusCode: 502 });
  });

  it('plafond `max_runtime_h` : arrêt `by: "core"`, l\'événement `killed` devient `max_runtime` et réveille ; rétention des jobs finis', async () => {
    b.reglages = { ...b.reglages, max_runtime_h: 1, retention_days: 1 };
    const id = await lancerJob(b, 1, "c1");
    await b.horloge.avancer(3600 + 400, b.service);
    expect(b.appelsHote).toEqual([{ uid: 1, ids: [id], par: "core", purge: false }]);
    await b.service.recevoir(
      1,
      [ev(id, { trigger: "killed", state: "killed", by: "core", exit_code: null })],
      0,
    );
    await b.horloge.avancer(3, b.service);
    expect(b.tours).toHaveLength(1);
    expect(contenuDernier(b.tours[0])).toContain('trigger="max_runtime"');
    await b.horloge.avancer(86400 + 400, b.service);
    expect(b.appelsHote.at(-1)).toEqual({ uid: 1, ids: [id], par: "core", purge: true });
    expect(await listerJobs(b.t.base, 1, null)).toEqual([]);
  });

  it("lancement jamais confirmé : `starting` → `failed` au balayage", async () => {
    const fin = tourActif(1, "c1");
    const r = await b.service.enregistrer(1, corps("c1"), "");
    fin();
    await b.horloge.avancer(301, b.service);
    expect((await listerJobs(b.t.base, 1, "c1"))[0]?.state).toBe("starting");
    await b.horloge.avancer(600, b.service);
    expect((await listerJobs(b.t.base, 1, "c1"))[0]).toMatchObject({ id: r["job_id"], state: "failed" });
  });

  it("marques de livraison uniques : un service recréé (compteurs remis à zéro) ne relivre aucun ancien événement", async () => {
    const id = await lancerJob(b, 1, "c1");
    await b.service.recevoir(1, [ev(id)], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.tours).toHaveLength(1);
    b.service.arreter();
    const neuf = new ServiceJobs({
      base: b.t.base,
      hote: { tuer: async () => [], veiller: async () => true },
      publier: (m) => void b.publications.push(m),
      horloge: b.horloge,
    });
    b.service = neuf;
    installerServiceJobs(neuf);
    await neuf.demarrer();
    const id2 = await lancerJob(b, 1, "c1");
    await neuf.recevoir(1, [ev(id2)], 0);
    await b.horloge.avancer(3, neuf);
    expect(b.tours).toHaveLength(2);
    expect(contenuDernier(b.tours[1])).toContain(id2);
    expect(contenuDernier(b.tours[1])).not.toContain(id);
    const marques = await b.t.base.all("SELECT delivered_in FROM shell_job_events ORDER BY id");
    expect(new Set(marques.map((m) => m["delivered_in"])).size).toBe(2);
  });

  it("redémarrage du core : événements non livrés relus au démarrage, réveil réarmé", async () => {
    const id = await lancerJob(b, 1, "c1");
    await b.service.recevoir(1, [ev(id)], 0);
    b.service.arreter();
    const neuf = new ServiceJobs({
      base: b.t.base,
      hote: { tuer: async () => [], veiller: async () => true },
      publier: (m) => void b.publications.push(m),
      horloge: b.horloge,
    });
    installerServiceJobs(neuf);
    await neuf.demarrer();
    expect(neuf.enAttente(1, "c1")).toBe(true);
    await b.horloge.avancer(1, neuf);
    expect(b.tours).toHaveLength(1);
    neuf.arreter();
  });
});

describe("reprise poussée par le core (veille confiée à l'hôte du compte)", () => {
  it("au démarrage puis toutes les 60 s, comptes à job actif seulement, avec le dernier seq acquitté ; panne journalisée puis réessayée", async () => {
    await b.horloge.avancer(0, b.service);
    expect(b.veilles).toEqual([]);
    await creerChat(b, 2, "c9");
    const id = await lancerJob(b, 1, "c1");
    const fini = await lancerJob(b, 2, "c9");
    await b.service.recevoir(2, [ev(fini)], 0);
    const e = ev(id, {
      trigger: "match",
      spec: "match:x",
      state: "running",
      exit_code: null,
      still_running: true,
    });
    await b.service.recevoir(1, [e], 0);
    b.service.arreter();
    const neuf = new ServiceJobs({
      base: b.t.base,
      hote: {
        tuer: async () => [],
        veiller: async (uid, ids, since) => {
          if (b.hoteEnPanne) throw new Error("hôte injoignable");
          b.veilles.push({ uid, ids: [...ids], since, t: b.horloge.t });
          return true;
        },
      },
      publier: () => undefined,
      horloge: b.horloge,
      reglages: () => b.reglages,
    });
    b.service = neuf;
    installerServiceJobs(neuf);
    const t0 = b.horloge.t;
    await neuf.demarrer();
    await b.horloge.avancer(0, neuf);
    expect(b.veilles).toEqual([{ uid: 1, ids: [id], since: e["seq"], t: t0 }]);
    await b.horloge.avancer(59, neuf);
    expect(b.veilles).toHaveLength(1);
    await b.horloge.avancer(1, neuf);
    expect(b.veilles.map((v) => v.t - t0)).toEqual([0, 60]);
    b.hoteEnPanne = true;
    await b.horloge.avancer(60, neuf);
    expect(b.veilles).toHaveLength(2);
    b.hoteEnPanne = false;
    await b.horloge.avancer(60, neuf);
    expect(b.veilles.map((v) => v.t - t0)).toEqual([0, 60, 180]);
    await neuf.recevoir(1, [ev(id)], 0);
    await b.horloge.avancer(60, neuf);
    expect(b.veilles).toHaveLength(3);
  });
});

describe("liste de l'utilisateur", () => {
  it("`GET /api/jobs` : jobs avec titre, journal et événements en attente ; file et réveils en cours ; `wake_disabled` effectif", async () => {
    await creerChat(b, 1, "c2", "Autre");
    const id = await lancerJob(b, 1, "c1");
    b.horloge.t += 1;
    await lancerJob(b, 1, "c2");
    await b.service.saisie(1, "c1");
    await b.service.recevoir(1, [ev(id, { tail: ["fin"] })], 0);
    const l = await b.service.liste(1, "c1");
    expect(l).toMatchObject({
      max_per_chat: 3,
      max_per_user: 5,
      wake_queue: [],
      wake_running: [],
      wake_disabled: false,
    });
    expect(l["jobs"]).toEqual([
      expect.objectContaining({
        id,
        chat_id: "c1",
        chat_title: "Projet",
        state: "exited",
        exit_code: 0,
        last_line: "fin",
        log: `/work/.bg/job-${id}.log`,
        pending_events: 1,
      }),
    ]);
    const tous = await b.service.liste(1, null);
    expect((tous["jobs"] as Dict[]).map((j) => j["chat_title"])).toEqual(["Autre", "Projet"]);
    expect(tous).not.toHaveProperty("wake_disabled");
    expect((await b.service.liste(2, null))["jobs"]).toEqual([]);
  });

  it("`active_total` : jobs actifs du compte, rendus aussi dans la liste d'une conversation qui n'en a aucun", async () => {
    await creerChat(b, 1, "c2", "Autre");
    await lancerJob(b, 1, "c1");
    await lancerJob(b, 1, "c1");
    expect(await b.service.liste(1, "c2")).toMatchObject({ jobs: [], active_total: 2 });
    expect((await b.service.liste(1, null))["active_total"]).toBe(2);
    expect((await b.service.liste(2, null))["active_total"]).toBe(0);
  });

  it("saisie en cours : conversation inconnue ou d'un autre compte ignorée, saisie expirée oubliée", async () => {
    for (let i = 0; i < 50; i++) await b.service.saisie(1, `inconnue-${i}`);
    await b.service.saisie(2, "c1");
    expect(b.service.saisiesSuivies()).toBe(0);
    await b.service.saisie(1, "c1");
    expect(b.service.saisiesSuivies()).toBe(1);
    const id = await lancerJob(b, 1, "c1");
    await b.horloge.avancer(21, b.service);
    await b.service.recevoir(1, [ev(id)], 0);
    await b.horloge.avancer(3, b.service);
    expect(b.tours).toHaveLength(1);
    expect(b.service.saisiesSuivies()).toBe(0);
  });
});
