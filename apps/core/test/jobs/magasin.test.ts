// SPDX-License-Identifier: MIT
/** apps/core/test/jobs/magasin.test.ts — SQL des tâches de fond sur SQLite et PostgreSQL : limites atomiques sous enregistrements concurrents (JB-10), prise atomique des non livrés (JB-08), dédoublonnage `(job_id, seq)`, suppression par conversation. */
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  chatsAvecJobActif,
  enAttente,
  enregistrerJob,
  insererEvenement,
  liberer,
  detacherJobsDesChats,
  lireJob,
  listerJobs,
  prendre,
  terminesAvant,
} from "../../src/jobs/magasin";
import type { DemandeJob } from "../../src/jobs/magasin";
import { assainirCharge } from "../../src/jobs/rendu";

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

function demande(uid: number, chatId: string, label: string): DemandeJob {
  return {
    uid,
    chatId,
    callId: "",
    label,
    command: "sleep 600",
    cwd: "",
    wakeOn: ["exit"],
    resumeNote: "",
    wake: true,
    depth: 0,
    turn: { model: "m" },
    host: "",
  };
}

describe.each(MOTEURS)("magasin des jobs (%s)", (moteur) => {
  let t: BaseDeTest;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const nom of ["alice", "bob"])
      await t.base.run(
        "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?, 's', 'h', 0, 0)",
        [nom],
      );
  });

  afterAll(async () => {
    await t.fermer();
  });

  it("JB-10 : limites atomiques sous enregistrements concurrents (3 par conversation, 5 par compte)", async () => {
    const limites = { parChat: 3, parCompte: 5 };
    const r = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        enregistrerJob(t.base, demande(1, "c1", `j${i}`), limites, 100 + i),
      ),
    );
    expect(r.filter((x) => x.ok)).toHaveLength(3);
    const refus = r.find((x) => !x.ok);
    expect(refus).toMatchObject({ ok: false, portee: "chat", max: 3 });
    const autres = await Promise.all(
      ["c2", "c2", "c3", "c3", "c3"].map((c, i) =>
        enregistrerJob(t.base, demande(1, c, `k${i}`), limites, 200 + i),
      ),
    );
    expect(autres.filter((x) => x.ok)).toHaveLength(2);
    expect(autres.find((x) => !x.ok)).toMatchObject({ portee: "user", max: 5 });
    const acceptes = autres.flatMap((x) => (x.ok ? [x.job.chatId] : []));
    expect(await chatsAvecJobActif(t.base, 1)).toEqual(new Set(["c1", ...acceptes]));
    expect((await enregistrerJob(t.base, demande(2, "c1", "b"), limites, 300)).ok).toBe(true);
  });

  it("JB-08 : prise atomique concurrente des non livrés, chaque événement une seule fois ; libération ; doublon `(job_id, seq)` ignoré", async () => {
    const e = await enregistrerJob(t.base, demande(2, "d1", "x"), { parChat: 3, parCompte: 5 }, 400);
    if (!e.ok) throw new Error("refus");
    for (let seq = 1; seq <= 20; seq++) {
      const charge = assainirCharge({ seq, trigger: "match", state: "running", tail: [] }, 3072)!;
      const job = (await lireJob(t.base, 2, e.job.id))!;
      expect(
        await t.base.ecriture((tx) => insererEvenement(tx, job, charge, "match", null, 500 + seq)),
      ).not.toBeNull();
    }
    const job = (await lireJob(t.base, 2, e.job.id))!;
    const doublon = assainirCharge({ seq: 3, trigger: "match", state: "running" }, 3072)!;
    expect(await t.base.ecriture((tx) => insererEvenement(tx, job, doublon, "match", null, 600))).toBeNull();
    expect(job.lastSeq).toBe(20);
    const prises = await Promise.all(
      Array.from({ length: 6 }, (_, i) => prendre(t.base, 2, "d1", `essai:${i}`, 700 + i)),
    );
    const ids = prises.flat().map((x) => x.id);
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(prises.filter((p) => p.length > 0)).toHaveLength(1);
    expect(await enAttente(t.base, 2, "d1")).toEqual([]);
    expect(await liberer(t.base, ids.slice(0, 5))).toBe(5);
    expect((await enAttente(t.base, 2, "d1")).map((x) => x.charge.seq)).toEqual([1, 2, 3, 4, 5]);
    const autre = await enregistrerJob(t.base, demande(2, "d2", "y"), { parChat: 3, parCompte: 5 }, 800);
    if (!autre.ok) throw new Error("refus");
    const charge = assainirCharge({ seq: 1, trigger: "exit", state: "exited" }, 3072)!;
    await t.base.ecriture((tx) => insererEvenement(tx, autre.job, charge, "exit", null, 801));
    expect((await prendre(t.base, 2, "d1", "meme-marque", 900)).map((x) => x.charge.seq)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect((await prendre(t.base, 2, "d2", "meme-marque", 901)).map((x) => x.jobId)).toEqual([autre.job.id]);
    expect((await detacherJobsDesChats(t.base, 2, ["d1"])).map((j) => [j.id, j.kind])).toEqual([
      [e.job.id, "shell"],
    ]);
    expect(await t.base.all("SELECT id FROM shell_job_events WHERE user_id=2 AND chat_id='d1'")).toEqual([]);
    expect(await lireJob(t.base, 2, e.job.id)).toBeNull();
    const restants = (await listerJobs(t.base, 2, null)).map((j) => j.id);
    expect(restants).toContain(autre.job.id);
    expect(restants).not.toContain(e.job.id);
    expect((await terminesAvant(t.base, 1)).map((j) => j.id)).toContain(e.job.id);
  });
});
