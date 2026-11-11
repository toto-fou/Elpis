// SPDX-License-Identifier: MIT
/** frontend/test/chat/jobs/client.test.ts — client des tâches de fond : routes, corps, validation par les schémas du contrat, erreurs. */
import { describe, expect, it } from "vitest";

import {
  arreterJobs,
  chargerJobs,
  reglerReveil,
  signalerSaisie,
} from "../../../src/features/chat/jobs/client";
import { job, json, reponse } from "./outils-jobs";

function faux(rep: Response | null) {
  const appels: { url: string; init?: Record<string, unknown> }[] = [];
  const f = (url: string, init?: Record<string, unknown>): Promise<Response | null> => {
    appels.push({ url, init });
    return Promise.resolve(rep);
  };
  return { f, appels };
}

describe("client des tâches de fond", () => {
  it("liste d'une conversation : chat_id encodé, réponse validée", async () => {
    const { f, appels } = faux(json(reponse({ jobs: [job()] })));
    const r = await chargerJobs(f, "c 1");
    expect(appels[0]?.url).toBe("/api/jobs?chat_id=c%201");
    expect(r?.jobs[0]?.id).toBe("j-3f2a1c9e");
  });

  it("liste du compte : scope=all", async () => {
    const { f, appels } = faux(json(reponse({ wake_disabled: undefined })));
    await chargerJobs(f, null);
    expect(appels[0]?.url).toBe("/api/jobs?scope=all");
  });

  it("réponse hors contrat, statut d'erreur ou réseau absent : nul, jamais accepté", async () => {
    expect(await chargerJobs(faux(json({ jobs: "non" })).f, "c1")).toBeNull();
    expect(
      await chargerJobs(faux(json(reponse({ jobs: [{ ...job(), state: "dormant" } as never] }))).f, "c1"),
    ).toBeNull();
    expect(await chargerJobs(faux(json({}, 500)).f, "c1")).toBeNull();
    expect(await chargerJobs(faux(null).f, "c1")).toBeNull();
    expect(await chargerJobs(faux(new Response("pas du json")).f, "c1")).toBeNull();
  });

  it("JB-12 : arrêt de jobs nommés en POST JSON, réponse validée", async () => {
    const { f, appels } = faux(json({ ok: true, stopped: ["j-3f2a1c9e"], not_found: [] }));
    const r = await arreterJobs(f, { ids: ["j-3f2a1c9e"] });
    expect(appels[0]?.url).toBe("/api/jobs/stop");
    expect(appels[0]?.init?.method).toBe("POST");
    expect(JSON.parse(String(appels[0]?.init?.body))).toEqual({ ids: ["j-3f2a1c9e"] });
    expect(r?.stopped).toEqual(["j-3f2a1c9e"]);
    expect(await arreterJobs(faux(json({ ok: false })).f, { all: true })).toBeNull();
  });

  it("JB-17 : interrupteur en PUT, valeur effective rendue", async () => {
    const { f, appels } = faux(json({ ok: true, wake_disabled: true }));
    expect(await reglerReveil(f, "c1", true)).toBe(true);
    expect(appels[0]?.url).toBe("/api/saved/chats/c1/wake");
    expect(appels[0]?.init?.method).toBe("PUT");
    expect(JSON.parse(String(appels[0]?.init?.body))).toEqual({ wake_disabled: true });
    expect(await reglerReveil(faux(json({}, 403)).f, "c1", true)).toBeNull();
  });

  it("JB-08 : ping de saisie en POST, vrai seulement si le serveur accepte", async () => {
    const { f, appels } = faux(json({ ok: true }));
    expect(await signalerSaisie(f, "c1")).toBe(true);
    expect(appels[0]?.url).toBe("/api/chat/c1/composing");
    expect(appels[0]?.init?.method).toBe("POST");
    expect(await signalerSaisie(faux(json({}, 404)).f, "c1")).toBe(false);
    expect(await signalerSaisie(faux(null).f, "c1")).toBe(false);
  });
});
