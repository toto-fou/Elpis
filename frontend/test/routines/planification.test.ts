// SPDX-License-Identifier: MIT
/** frontend/test/routines/planification.test.ts — constructeur de planification : cron ⇄ état, bornes, repli en cron brut. */
import { describe, expect, it } from "vitest";

import {
  borner,
  cronDepuisPlanification,
  cronEnTexte,
  planificationDepuisCron,
  planificationParDefaut,
  resumerPlanification,
} from "../../src/features/routines/planification";

describe("planification", () => {
  it("construit les cinq champs de chaque fréquence", () => {
    const base = planificationParDefaut();
    expect(cronDepuisPlanification(base)).toBe("0 9 * * *");
    expect(cronDepuisPlanification({ ...base, freq: "none" })).toBe("");
    expect(cronDepuisPlanification({ ...base, freq: "minutes", everyMinutes: 90 })).toBe("*/59 * * * *");
    expect(cronDepuisPlanification({ ...base, freq: "hourly", atMinute: 15 })).toBe("15 * * * *");
    expect(cronDepuisPlanification({ ...base, freq: "weekly", weekdays: [5, 1], time: "07:30" })).toBe(
      "30 7 * * 1,5",
    );
    expect(cronDepuisPlanification({ ...base, freq: "monthly", dayOfMonth: 40 })).toBe("0 9 31 * *");
    expect(cronDepuisPlanification({ ...base, freq: "custom", custom: " 1 2 3 4 5 " })).toBe("1 2 3 4 5");
  });

  it("relit les expressions représentables et replie le reste en cron brut", () => {
    expect(planificationDepuisCron("")).toMatchObject({ freq: "none" });
    expect(planificationDepuisCron("*/10 * * * *")).toMatchObject({ freq: "minutes", everyMinutes: 10 });
    expect(planificationDepuisCron("5 * * * *")).toMatchObject({ freq: "hourly", atMinute: 5 });
    expect(planificationDepuisCron("30 8 * * *")).toMatchObject({ freq: "daily", time: "08:30" });
    expect(planificationDepuisCron("0 9 * * 1,3,5")).toMatchObject({ freq: "weekly", weekdays: [1, 3, 5] });
    expect(planificationDepuisCron("0 9 15 * *")).toMatchObject({ freq: "monthly", dayOfMonth: 15 });
    expect(planificationDepuisCron("0 9 * * 1-5")).toMatchObject({ freq: "custom", custom: "0 9 * * 1-5" });
    expect(planificationDepuisCron("0 9 * *")).toMatchObject({ freq: "custom" });
  });

  it("résume ce que le cron enregistré fera réellement", () => {
    expect(cronEnTexte("*/90 * * * *")).toBe("Toutes les 59 minute(s)");
    expect(resumerPlanification({ ...planificationParDefaut(), freq: "minutes", everyMinutes: 90 })).toBe(
      "Toutes les 59 minute(s)",
    );
    expect(cronEnTexte("0 9 * * 1,3")).toBe("Chaque lundi, mercredi à 09:00");
    expect(cronEnTexte("")).toBe("Aucune planification (manuel / webhook)");
  });

  it("borne les entiers saisis", () => {
    expect(borner("abc", 0, 500, 0)).toBe(0);
    expect(borner("700", 0, 500, 0)).toBe(500);
    expect(borner(-3, 0, 500, 0)).toBe(0);
  });
});
