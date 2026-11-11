// SPDX-License-Identifier: MIT
/** frontend/test/admin/transferts.test.ts — les téléchargements de la console (métriques, sauvegarde) portent l'en-tête de la console ; l'export d'une exécution passe par un fetch avec cet en-tête. */
import * as Vue from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { creerTransferts } from "../../src/features/admin/transferts";
import type { BaseAdmin } from "../../src/features/admin/etat";
import { setupRunDetails } from "../../src/features/chat/details-run";

afterEach(() => vi.unstubAllGlobals());

function reponseCsv(): Response {
  return new Response("a,b\n1,2\n", {
    status: 200,
    headers: { "content-disposition": 'attachment; filename="m.csv"' },
  });
}

describe("downloadWithModal", () => {
  it("envoie l'en-tête de la console sur l'export des métriques et sur la sauvegarde", async () => {
    const fetchSimule = vi.fn(async () => reponseCsv());
    vi.stubGlobal("fetch", fetchSimule);
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }));
    const base = { vue: Vue, ctx: { showToast: () => {}, openConfirm: async () => true } };
    const t = creerTransferts(base as unknown as BaseAdmin);
    await t.exportMetrics(3);
    await t.downloadBackup("db");
    const appels = fetchSimule.mock.calls as unknown as [string, RequestInit][];
    expect(appels.map(([url]) => url)).toEqual([
      "/api/admin/export-metrics?days=3",
      "/api/admin/backup?scope=db",
    ]);
    for (const [, init] of appels) expect(init.headers).toEqual({ "X-Elpis-Console": "1" });
  });
});

describe("export d'une exécution depuis la console", () => {
  function monter(reponse: Response | null) {
    const fetchAuth = vi.fn(async () => reponse);
    const d = setupRunDetails(null, { fetchAuth });
    d.runDetails.value = {
      runId: "r1",
      ids: ["r1"],
      admin: true,
      loading: false,
      error: "",
      data: null,
      open: {},
    };
    return { d, fetchAuth };
  }

  it("télécharge par fetch avec l'en-tête puis enregistre le fichier", async () => {
    const creer = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: creer, revokeObjectURL: () => {} }));
    const { d, fetchAuth } = monter(new Response("{}", { status: 200 }));
    await d.exporterRun("r1");
    expect(fetchAuth).toHaveBeenCalledWith(
      "/api/admin/runs/r1/export",
      { headers: { "X-Elpis-Console": "1" } },
      true,
    );
    expect(creer).toHaveBeenCalledOnce();
    expect(d.runDetails.value?.exportError).toBe("");
  });

  it("affiche le refus du serveur sans rien enregistrer", async () => {
    const creer = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: creer, revokeObjectURL: () => {} }));
    const refus = new Response(JSON.stringify({ detail: "Lecture refusée : requête sans l'en-tête." }), {
      status: 403,
    });
    const { d } = monter(refus);
    await d.exporterRun("r1");
    expect(d.runDetails.value?.exportError).toContain("Lecture refusée");
    expect(creer).not.toHaveBeenCalled();
  });

  it("réseau ou session perdue : message d'erreur", async () => {
    const { d } = monter(null);
    await d.exporterRun("r1");
    expect(d.runDetails.value?.exportError).toContain("Export impossible");
  });
});
