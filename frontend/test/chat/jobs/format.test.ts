// SPDX-License-Identifier: MIT
/** frontend/test/chat/jobs/format.test.ts — libellés français : durée, déclencheurs armés, raisons d'écart. */
import { describe, expect, it } from "vitest";

import { toolIconFor } from "../../../src/features/chat/coeur/formats";
import { texteEtape } from "../../../src/features/chat/outils/verbes";
import { dureeFr, issueJob, libelleArme, libelleJob } from "../../../src/features/chat/jobs/format";

describe("format des tâches de fond", () => {
  it("durées lisibles", () => {
    expect(dureeFr(42.9)).toBe("42 s");
    expect(dureeFr(603)).toBe("10 min 03 s");
    expect(dureeFr(3720)).toBe("1 h 02 min");
    expect(dureeFr(null)).toBe("");
    expect(dureeFr(-1)).toBe("");
  });

  it("issue d'un job : code ≠ 0 ou signal = échec, code 0 = terminé", () => {
    const j = (state: string, exit_code: number | null, signal: string | null = null) =>
      ({ state, exit_code, signal }) as Parameters<typeof issueJob>[0];
    expect(issueJob(j("running", null))).toBe("actif");
    expect([issueJob(j("exited", 0)), libelleJob(j("exited", 0))]).toEqual(["reussi", "terminé"]);
    expect([issueJob(j("exited", 1)), libelleJob(j("exited", 1))]).toEqual(["echec", "échec, code 1"]);
    expect(libelleJob(j("exited", null, "SIGKILL"))).toBe("échec (SIGKILL)");
    expect([issueJob(j("killed", null, "SIGTERM")), libelleJob(j("killed", null))]).toEqual([
      "arrete",
      "arrêté",
    ]);
    expect([issueJob(j("lost", null)), issueJob(j("failed", null))]).toEqual(["perdu", "echec"]);
  });

  it("issue d'un sous-agent en fond : fini et `done` = terminé, sinon son état ; perdu au redémarrage", () => {
    const fin = (state: string, status?: string) =>
      ({
        state: "exited",
        exit_code: null,
        signal: null,
        kind: "agent",
        agent: { child_id: "t1", agent: "explore", state, ...(status ? { status } : {}) },
      }) as const;
    expect([issueJob(fin("completed", "done")), libelleJob(fin("completed", "done"))]).toEqual([
      "reussi",
      "terminé",
    ]);
    expect([issueJob(fin("completed", "partial")), libelleJob(fin("completed", "partial"))]).toEqual([
      "echec",
      "terminé (partiel)",
    ]);
    expect(libelleJob(fin("timeout", "timeout"))).toBe("délai dépassé");
    expect(libelleJob({ ...fin("lost"), state: "lost" })).toBe("interrompu (redémarrage)");
  });

  it("déclencheurs armés", () => {
    expect(libelleArme("exit")).toBe("fin du programme");
    expect(libelleArme("match:Compiled: ok")).toBe("texte « Compiled: ok »");
    expect(libelleArme("regex:^E\\d+")).toBe("motif /^E\\d+/");
    expect(libelleArme("port:8080")).toBe("port 8080");
    expect(libelleArme("file:out/a.txt")).toBe("fichier out/a.txt");
    expect(libelleArme("idle:30")).toBe("silence 30 s");
    expect(libelleArme("timeout:600")).toBe("après 600 s");
  });

  it("la carte de l'outil shell_job a l'icône minuteur, pas celle du terminal", () => {
    expect(toolIconFor("shell_job")).toBe("ph-timer");
    expect(toolIconFor("task_wait")).toBe("ph-hourglass-medium");
    expect(toolIconFor("task_send")).toBe("ph-chat-circle-text");
    expect(texteEtape({ name: "task_send", args: { task_id: "t1-aa" } })).toBe("Écrit à l'agent");
    expect(texteEtape({ name: "task_status", args: { task_id: "t1-aa" } })).toBe("Regarde où en est l'agent");
    expect(toolIconFor("execute_shell")).toBe("ph-terminal");
  });
});
