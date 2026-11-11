// SPDX-License-Identifier: MIT
/** apps/core/test/routines/composition.test.ts — montage des routines dans la composition : planificateur et routes dans main seul, démarré et arrêté par le cycle de vie sans minuterie résiduelle. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierConfigurationAudit } from "@elpis/securite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { composer } from "../../src/composition";
import { CycleDeVie } from "../../src/cycle";
import { installerCrochetJournal } from "../../src/journal";
import { installerPublicationNotifications } from "../../src/notifications/envoi";
import { installerMeneur, meneur } from "../../src/routines/meneur";
import { installerPlanificateur, planificateurDuProcess } from "../../src/routines/planificateur";
import { appTest, journalMuet } from "../aides";

/** Routes de B1-24 sous session (`routes.inventory.json` : main seul) ; la livraison webhook est publique. */
const ROUTES_ROUTINES = [
  "GET /api/routines",
  "POST /api/routines",
  "GET /api/routines/:routine_id",
  "PUT /api/routines/:routine_id",
  "DELETE /api/routines/:routine_id",
  "POST /api/routines/:routine_id/enable",
  "POST /api/routines/:routine_id/disable",
  "POST /api/routines/:routine_id/run-now",
  "GET /api/routines/:routine_id/runs",
  "POST /api/routines/:routine_id/runs/:run_id/stop",
  "POST /api/routines/:routine_id/webhook/rotate",
  "POST /api/routines/:routine_id/webhook/disable",
  "POST /api/routines/:routine_id/webhook/filter",
];

let t: BaseDeTest;
let dossier: string;
const avant = { cron: process.env["CRON_LOCK_PATH"], audit: process.env["ELPIS_AUDIT_DIR"] };

function dep(base: BaseDeTest["base"]): DependancesAuth & DependancesJetons {
  return {
    base,
    config: () => ({}),
    attributsCookie: () => ({
      cookie_name: "mcpwebui_session",
      same_site: "lax",
      https_only: false,
      max_age: 86400,
    }),
    secret: () => "secret-de-test",
    jetonService: () => "",
    maintenant: () => 1_791_331_200,
  };
}

beforeEach(async () => {
  dossier = mkdtempSync(join(tmpdir(), "elpis-routines-composition-"));
  process.env["CRON_LOCK_PATH"] = join(dossier, "cron.lock");
  process.env["ELPIS_AUDIT_DIR"] = join(dossier, "audit");
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
});

afterEach(async () => {
  installerMeneur(null);
  installerPlanificateur(null);
  installerCrochetJournal(null);
  installerPublicationNotifications(null);
  oublierConfigurationAudit();
  for (const [cle, valeur] of [
    ["CRON_LOCK_PATH", avant.cron],
    ["ELPIS_AUDIT_DIR", avant.audit],
  ] as const)
    if (valeur === undefined) delete process.env[cle];
    else process.env[cle] = valeur;
  await t.fermer();
  rmSync(dossier, { recursive: true, force: true });
});

describe("routines dans la composition", () => {
  it("main : planificateur et leader installés, démarrés au cycle, arrêtés sans retenir le process", async () => {
    const lignes: string[] = [];
    const cycle = new CycleDeVie(journalMuet);
    await composer("main", t.base, journalMuet, dep(t.base), undefined, { cycle });
    installerCrochetJournal((_niveau, message) => void lignes.push(message));
    const p = planificateurDuProcess();
    expect([p !== null, meneur() !== null]).toEqual([true, true]);
    await cycle.demarrer("main");
    expect(lignes.some((l) => l.includes("[ROUTINES] scheduler démarré"))).toBe(true);
    const debut = performance.now();
    await cycle.executerArrets(2000, 2000);
    expect(performance.now() - debut).toBeLessThan(1500);
    expect([p?.nombreRunsActifs(), p?.schedulerAlive(), meneur()?.tenu]).toEqual([0, false, false]);
  });

  it("admin : ni planificateur ni leader", async () => {
    await composer("admin", t.base, journalMuet, dep(t.base), undefined, {
      cycle: new CycleDeVie(journalMuet),
    });
    expect([planificateurDuProcess(), meneur()]).toEqual([null, null]);
  });

  it("routes des routines (session) et du webhook (publique) montées dans main seul", async () => {
    for (const mode of ["main", "admin"] as const) {
      const c = await composer(mode, t.base, journalMuet, dep(t.base), undefined, {
        cycle: new CycleDeVie(journalMuet),
      });
      const app = await appTest({ ...c, mode });
      const montees = new Map(
        app.elpis.routes.flatMap((r) => r.methodes.map((m) => [`${m} ${r.chemin}`, r.acces])),
      );
      for (const route of ROUTES_ROUTINES)
        expect(montees.get(route), `${mode} : ${route}`).toBe(mode === "main" ? "session" : undefined);
      expect(montees.get("POST /api/webhooks/routines/:routine_id"), mode).toBe(
        mode === "main" ? "public" : undefined,
      );
      await app.close();
      installerMeneur(null);
      installerPlanificateur(null);
    }
  });
});
