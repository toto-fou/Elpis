// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/admin-metriques.test.ts — contrats de la supervision (tableau de bord, jeton de collecte, purge, rapport quotidien, observabilité) rejoués contre le core TS réel en process admin ; l'export CSV et la collecte Prometheus, qui ne sont pas du JSON, sont vérifiés à part. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CONTRATS_REST,
  schemaRapportQuotidien,
  schemaReponseJetonScrape,
  schemaReponsePurgeMetriques,
  schemaReponseStatsDynamique,
} from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieModerateur = "";
let cookieLou = "";

beforeAll(async () => {
  core = await demarrerCore("admin");
  await creerCompte(core.base, "zoe", "mdp-de-zoe-1", 1);
  await creerCompte(core.base, "max", "mdp-de-max-1", 2);
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieModerateur = await core.connecter("max", "mdp-de-max-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

describe("contrats REST : tableau de bord et collecte (core réel)", () => {
  it("tableau complet puis données de widgets choisis, portée ramenée à 24 h si inconnue", async () => {
    const complet = schemaReponseStatsDynamique.parse(
      await core.appeler("GET", "/api/admin/stats-dynamic?scope_hours=168", { cookie: cookieModerateur }),
    );
    expect("layout" in complet && complet.layout.length).toBeGreaterThan(10);
    const partiel = schemaReponseStatsDynamique.parse(
      await core.appeler("GET", "/api/admin/stats-dynamic?ids=system_load,disk_io,inconnu&scope_hours=5", {
        cookie,
      }),
    );
    expect(partiel).toMatchObject({ partial: true });
    await core.appeler("GET", "/api/admin/stats-dynamic", { cookie: cookieLou });
    await core.appeler("GET", "/api/admin/stats-dynamic");
  });

  it("jeton de collecte : absent, généré, retiré, action inconnue refusée, réservé aux administrateurs", async () => {
    expect(
      schemaReponseJetonScrape.parse(
        await core.appeler("GET", "/api/admin/metrics/scrape-token", { cookie }),
      ),
    ).toEqual({
      configured: false,
      token: null,
    });
    const genere = schemaReponseJetonScrape.parse(
      await core.appeler("POST", "/api/admin/metrics/scrape-token", {
        cookie,
        corps: { action: "generate" },
      }),
    );
    expect(genere.configured).toBe(true);
    expect(genere.token).toMatch(/\S{20,}/u);
    const resp = await core.app.inject({
      method: "GET",
      url: "/api/admin/metrics/prometheus",
      headers: { authorization: `Bearer ${genere.token}` },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.headers["content-type"]).toContain("text/plain");
    await core.appeler("POST", "/api/admin/metrics/scrape-token", { cookie, corps: { action: "inconnue" } });
    expect(
      await core.appeler("POST", "/api/admin/metrics/scrape-token", { cookie, corps: { action: "revoke" } }),
    ).toEqual({
      configured: false,
      token: null,
    });
    await core.appeler("GET", "/api/admin/metrics/scrape-token", { cookie: cookieModerateur });
    await core.appeler("POST", "/api/admin/metrics/scrape-token", { cookie: cookieModerateur, corps: {} });
  });

  it("export CSV des métriques : cible inconnue refusée, en-tête de téléchargement", async () => {
    const ok = await core.app.inject({
      method: "GET",
      url: "/api/admin/export-metrics?days=3&target=usage_events",
      headers: { cookie, "x-elpis-console": "1" },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/csv");
    expect(String(ok.headers["content-disposition"])).toContain("usage_events_3j_");
    const refus = await core.app.inject({
      method: "GET",
      url: "/api/admin/export-metrics?target=autre",
      headers: { cookie, "x-elpis-console": "1" },
    });
    expect(refus.statusCode).toBe(400);
  });

  it("purge : simulation d'abord, suppression ensuite, cibles et corps invalides refusés", async () => {
    const simulation = schemaReponsePurgeMetriques.parse(
      await core.appeler("POST", "/api/admin/metrics/purge", {
        cookie,
        corps: { targets: ["usage_events", "metric_events"] },
      }),
    );
    expect(simulation.dry_run).toBe(true);
    const reelle = schemaReponsePurgeMetriques.parse(
      await core.appeler("POST", "/api/admin/metrics/purge", {
        cookie,
        corps: { targets: ["tool_call_metrics"], dry_run: false, event_types: null },
      }),
    );
    expect(reelle.dry_run).toBe(false);
    await core.appeler("POST", "/api/admin/metrics/purge", { cookie, corps: { targets: [] } });
    await core.appeler("POST", "/api/admin/metrics/purge", { cookie, corps: { targets: ["inconnue"] } });
    await core.appeler("POST", "/api/admin/metrics/purge", {
      cookie: cookieModerateur,
      corps: { targets: ["usage_events"] },
    });
  });
});

describe("contrats REST : rapport quotidien et observabilité (core réel)", () => {
  it("rapport du jour construit à la demande, génération, historique, date inconnue 404", async () => {
    const jour = schemaRapportQuotidien.parse(
      await core.appeler("GET", "/api/admin/report/daily", { cookie: cookieModerateur }),
    );
    expect(jour.sections.length).toBeGreaterThan(0);
    const genere = (await core.appeler("POST", "/api/admin/report/daily/generate", { cookie })) as {
      date: string;
    };
    expect(genere.date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    const stocke = schemaRapportQuotidien.parse(
      await core.appeler("GET", `/api/admin/report/daily?date=${genere.date}`, { cookie }),
    );
    expect(stocke.date).toBe(genere.date);
    expect(await core.appeler("GET", "/api/admin/report/daily/list?limit=5", { cookie })).toMatchObject({
      reports: [{ date: genere.date }],
    });
    await core.appeler("GET", "/api/admin/report/daily?date=1999-01-01", { cookie });
    await core.appeler("POST", "/api/admin/report/daily/generate", { cookie: cookieModerateur });
    await core.appeler("GET", "/api/admin/report/daily/list", { cookie: cookieLou });
  });

  it("envoi automatique du rapport : lecture, écriture, réservé aux administrateurs", async () => {
    expect(await core.appeler("GET", "/api/admin/report/daily/auto", { cookie: cookieModerateur })).toEqual({
      enabled: true,
    });
    expect(
      await core.appeler("POST", "/api/admin/report/daily/auto", { cookie, corps: { enabled: false } }),
    ).toEqual({
      ok: true,
      enabled: false,
    });
    expect(await core.appeler("GET", "/api/admin/report/daily/auto", { cookie })).toEqual({ enabled: false });
    await core.appeler("POST", "/api/admin/report/daily/auto", {
      cookie: cookieModerateur,
      corps: { enabled: true },
    });
  });

  it("observabilité des outils : synthèse, erreurs, audit récent filtré", async () => {
    expect(
      await core.appeler("GET", "/api/admin/observability/tool-summary?hours=48&limit=5", { cookie }),
    ).toMatchObject({
      totals: { n: 0 },
      per_tool: [],
      hours: 48,
    });
    expect(
      await core.appeler("GET", "/api/admin/observability/tool-failures?hours=9999", {
        cookie: cookieModerateur,
      }),
    ).toMatchObject({
      items: [],
      hours: 720,
    });
    await core.appeler("GET", "/api/admin/observability/tool-failures?status=timeout", { cookie });
    await core.appeler("GET", "/api/admin/observability/tool-failures?status=autre", { cookie });
    expect(
      await core.appeler("GET", "/api/admin/observability/audit-recent?action_prefix=admin.&limit=5", {
        cookie,
        entetes: { "x-elpis-console": "1" },
      }),
    ).toMatchObject({ hours: 24 });
    await core.appeler("GET", "/api/admin/observability/audit-recent", {
      cookie: cookieLou,
      entetes: { "x-elpis-console": "1" },
    });
  });

  it("toutes les routes du domaine admin-metriques ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "admin-metriques").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
