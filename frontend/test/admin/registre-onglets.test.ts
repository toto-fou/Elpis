// SPDX-License-Identifier: MIT
/** frontend/test/admin/registre-onglets.test.ts — registre de la console : pages et onglets, alias, chargeurs par onglet, aucune page orpheline. */
import { describe, expect, it } from "vitest";

import { ARBRE_DEPLIE } from "../../src/features/admin/arbre";
import { heureLocale, isoUtc } from "../../src/features/admin/horodatage";
import { chargeursDe, NAV_ADMIN } from "../../src/features/admin/registre";

const noms = (p: string, o: string): string[] => chargeursDe(NAV_ADMIN.pages[p], o).map((c) => c[0]);

describe("registre : pages et onglets", () => {
  it("Supervision = Métriques, Rapport, Activité, Journaux ; Journalisation entre Données et Entretien", () => {
    const sup = NAV_ADMIN.entries.find((e) => e.id === "supervision");
    expect(sup?.pages.map((p) => p.id)).toEqual(["dashboard", "report", "activity", "logs"]);
    const sys = NAV_ADMIN.entries.find((e) => e.id === "system");
    const ids = sys?.pages.map((p) => p.id) ?? [];
    expect(ids.indexOf("audit-logging")).toBe(ids.indexOf("data") + 1);
    expect(ids.indexOf("upkeep")).toBe(ids.indexOf("audit-logging") + 1);
    expect(NAV_ADMIN.pages["audit-logging"]?.role).toBe("admin");
    expect(NAV_ADMIN.pageForPath("security.audit.retention_days")).toBe("audit-logging");
  });

  it("aucune page orpheline : chaque page est dans l'arbre, une seule fois", () => {
    const dansArbre = ARBRE_DEPLIE.flatMap((g) => g.pages);
    expect([...dansArbre].sort()).toEqual(Object.keys(NAV_ADMIN.pages).sort());
    expect(new Set(dansArbre).size).toBe(dansArbre.length);
  });

  it("alias : chaque ancien identifiant mène à une page (et un onglet) qui existe", () => {
    for (const [ancien, cible] of Object.entries(NAV_ADMIN.aliases)) {
      const lien = NAV_ADMIN.resolveLien(ancien);
      expect(lien, ancien).not.toBeNull();
      const [page, onglet] = cible.split("/");
      expect(lien?.page, ancien).toBe(page);
      if (onglet) expect(NAV_ADMIN.pages[page ?? ""]?.onglets.map((o) => o.id)).toContain(onglet);
    }
    expect(NAV_ADMIN.resolveLien("#audit")).toEqual({ page: "logs", onglet: "security" });
    expect(NAV_ADMIN.resolveLien("runs")).toEqual({ page: "activity", onglet: "runs" });
    expect(NAV_ADMIN.resolveLien("observability")?.page).toBe("activity");
    expect(NAV_ADMIN.resolveLien("rien")).toBeNull();
  });

  it("chargeurs par onglet : seul l'onglet affiché charge", () => {
    expect(noms("activity", "runs")).toEqual(["loadAdminRuns"]);
    expect(noms("activity", "tool-calls")).toEqual(["loadToolCalls"]);
    expect(noms("logs", "technical")).toEqual(["loadRecentLogs"]);
    expect(noms("logs", "security")).toEqual(["loadJournalSecurite"]);
    expect(noms("dashboard", "")).toEqual(["loadAdminStats"]);
    expect(noms("audit-logging", "")).toEqual(["loadAuditStatus"]);
  });

  it("rôles : Sécurité réservé aux admins, le reste ouvert au modérateur", () => {
    expect(NAV_ADMIN.roleDe("logs", "security")).toBe("admin");
    expect(NAV_ADMIN.roleDe("logs", "technical")).toBe("staff");
    expect(NAV_ADMIN.roleDe("logs")).toBe("staff");
    expect(NAV_ADMIN.roleDe("activity", "runs")).toBe("staff");
    expect(NAV_ADMIN.roleDe("audit-logging")).toBe("admin");
  });
});

describe("horodatage", () => {
  it("heure locale et ISO UTC à partir d'un ts en secondes", () => {
    expect(isoUtc(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
    expect(heureLocale(1_700_000_000)).toMatch(/2023/);
    expect([heureLocale(0), heureLocale(null), heureLocale("x"), isoUtc(undefined)]).toEqual([
      "",
      "",
      "",
      "",
    ]);
  });
});
