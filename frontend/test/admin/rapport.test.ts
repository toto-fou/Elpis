// SPDX-License-Identifier: MIT
/** frontend/test/admin/rapport.test.ts — console › Rapport : chargement du jour, historique, envoi automatique, valeurs d'indicateurs. */
import { createApp, defineComponent, h, nextTick, reactive } from "vue";
import type { App } from "vue";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import PageRapport from "../../src/components/admin/PageRapport.vue";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";

import { elementsGraphiques, setupAdminRapport } from "../../src/features/admin/rapport";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { fetchManuel, json } from "../aides";
import GraphiqueRapport from "../../src/components/admin/GraphiqueRapport.vue";

const RAPPORT = {
  date: "2026-06-21",
  generated_at: 1782000000,
  scope_hours: 24,
  widgets: { a: { value: 12, unit: "ms" }, b: { error: "x" }, c: { value: null }, d: { value: 3 } },
  titles: { a: "Latence" },
  sections: [
    { id: "kpi", label: "Indicateurs", widgets: ["a", "b", "c", "d"] },
    { id: "charts", label: "Graphiques", widgets: [] },
  ],
};

function monter(route: (u: string, o?: RequestInit) => Response) {
  const vus: Array<[string, string]> = [];
  const toasts: string[] = [];
  const fetch = (u: string, o?: RequestInit): Promise<Response> => {
    vus.push([u, o?.method ?? "GET"]);
    return Promise.resolve(route(u, o));
  };
  const R = setupAdminRapport(
    { showToast: (m) => toasts.push(m) },
    new ClientHttp(new GestionnaireSession(), fetch),
  );
  return { R, vus, toasts };
}

describe("setupAdminRapport", () => {
  it("charge rapport, historique et état automatique ; valeurs, titres et sections", async () => {
    const { R, vus } = monter((u) => {
      if (u.endsWith("/list?limit=30"))
        return json({ reports: [{ date: "2026-06-20", created_at: 1781900000 }] });
      if (u.endsWith("/auto")) return json({ enabled: false });
      return json(RAPPORT);
    });
    await R.loadDailyReport("2026-06-21");
    expect(vus[0]![0]).toBe("/api/admin/report/daily?date=2026-06-21");
    expect(R.reportHistory.value).toHaveLength(1);
    expect(R.dailyDigestAuto.value).toBe(false);
    expect([
      R.reportVal("a"),
      R.reportVal("b"),
      R.reportVal("c"),
      R.reportVal("d"),
      R.reportVal("z"),
    ]).toEqual(["12 ms", "—", "—", "3", "—"]);
    expect(R.reportTitle("a")).toBe("Latence");
    expect(R.reportTitle("z")).toBe("z");
    expect(R.reportValueSections.value).toEqual([
      { id: "kpi", label: "Indicateurs", widgets: ["a", "b", "c", "d"] },
    ]);
  });

  it("bascule automatique : toast selon l'état renvoyé ; refus : échec", async () => {
    const ok = monter(() => json({ ok: true, enabled: true }));
    await ok.R.setDailyDigestAuto(1);
    expect(ok.toasts).toEqual(["Rapport quotidien automatique activé"]);
    const ko = monter(() => json({ detail: "non" }, 403));
    await ko.R.setDailyDigestAuto(true);
    expect(ko.toasts).toEqual(["Échec de la mise à jour"]);
  });

  it("génération : toast puis rechargement ; occupation levée", async () => {
    const { R, toasts, vus } = monter((u) => (u.endsWith("/auto") ? json({ enabled: true }) : json({})));
    await R.generateDailyReport();
    expect(toasts).toEqual(["Rapport généré et notifié aux admins"]);
    expect(vus.some((v) => v[0] === "/api/admin/report/daily")).toBe(true);
    expect(R.dailyReportGenerating.value).toBe(false);
  });
});

/** Attend qu'une condition soit vraie (1 s au plus), sinon laisse les assertions échouer. */
const attendre = async (cond: () => boolean = () => true): Promise<void> => {
  for (let i = 0; i < 100; i++) {
    await nextTick();
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
};

/** Répond aux appels annexes (liste, automatique) tant que `fini` n'est pas résolu. */
async function pomper(
  appels: { url: string; repondre(r: Response): void }[],
  fini: Promise<unknown>,
): Promise<void> {
  let ok = false;
  void fini.then(() => {
    ok = true;
  });
  const vus = new Set<unknown>();
  while (!ok) {
    for (const a of appels) {
      if (vus.has(a) || a.url.includes("?date=")) continue;
      vus.add(a);
      a.repondre(json(a.url.includes("/list") ? { reports: [] } : { enabled: true }));
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("états du rapport", () => {
  it("échec 503 : raison conservée, puis Réessayer recharge le même jour et efface l'erreur", async () => {
    let ok = false;
    const { R, vus } = monter((u) => {
      if (u.endsWith("/auto")) return json({ enabled: true });
      if (u.includes("/list")) return json({ reports: [] });
      return ok ? json(RAPPORT) : json({ detail: "base occupée" }, 503);
    });
    await R.loadDailyReport("2026-06-20");
    expect(R.dailyReport.value).toBeNull();
    expect(R.dailyReportError.value).toBe("base occupée (HTTP 503)");
    ok = true;
    await R.retryDailyReport();
    expect(vus.filter((v) => v[0].startsWith("/api/admin/report/daily?date=2026-06-20"))).toHaveLength(2);
    expect(R.dailyReportError.value).toBeNull();
    expect(R.dailyReport.value?.date).toBe("2026-06-21");
  });

  it("choix des graphiques : mémorisé, relu à la création, stockage en échec toléré", () => {
    localStorage.removeItem("elpis_rapport_graphiques");
    const a = monter(() => json({}));
    expect(a.R.reportCharts.value).toBe(true);
    a.R.setReportCharts(false);
    expect(localStorage.getItem("elpis_rapport_graphiques")).toBe("0");
    expect(monter(() => json({})).R.reportCharts.value).toBe(false);
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new Error("plein");
    };
    try {
      a.R.setReportCharts(true);
      expect(a.R.reportCharts.value).toBe(true);
    } finally {
      Storage.prototype.setItem = orig;
      localStorage.removeItem("elpis_rapport_graphiques");
    }
  });

  it("séries : seulement celles du rapport, tableaux à part, erreurs ignorées", () => {
    const r = {
      ...RAPPORT,
      sections: [{ id: "charts", label: "Graphiques", widgets: ["s", "t", "e", "v"] }],
      titles: { s: "Série" },
      widgets: {
        s: { labels: ["a", "b"], datasets: [{ data: [1, "2"] }] },
        t: { columns: [{ key: "k", label: "K" }], rows: [{ k: 1 }] },
        e: { error: "x" },
        v: {},
      },
    };
    const { series, tableaux } = elementsGraphiques(r);
    expect(series).toMatchObject([{ id: "s", titre: "Série", datasets: [{ data: [1, 2] }] }]);
    expect(tableaux).toHaveLength(1);
    expect(elementsGraphiques(null)).toEqual({ series: [], tableaux: [] });
  });
});

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

async function monterPage(role: string, route: (u: string) => Response) {
  const { R } = monter(route);
  const adm = reactive({ adminTab: "report", user: { username: "u", role }, ...R });
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(defineComponent({ render: () => h(PageRapport) }));
  app.provide(CLE_ADMIN, adm as unknown as DomaineAdmin);
  app.mount(hote);
  return { R, hote };
}

describe("PageRapport", () => {
  const route = (u: string): Response =>
    u.endsWith("/auto")
      ? json({ enabled: true })
      : u.includes("/list")
        ? json({ reports: [] })
        : json(RAPPORT);

  it("« Générer » et l'envoi automatique masqués à un modérateur, visibles à un admin", async () => {
    const mod = await monterPage("moderator", route);
    await mod.R.loadDailyReport();
    await attendre(() => !!mod.hote.textContent?.includes("Imprimer"));
    expect(mod.hote.textContent).not.toContain("Générer");
    expect(mod.hote.textContent).not.toContain("Envoi automatique");
    expect(mod.hote.textContent).toContain("Imprimer");
    app?.unmount();
    document.body.innerHTML = "";
    const adm = await monterPage("admin", route);
    await adm.R.loadDailyReport();
    await attendre(() => !!adm.hote.textContent?.includes("Générer"));
    expect(adm.hote.textContent).toContain("Générer");
  });

  it("chargement (aria-busy), erreur avec Réessayer, puis rapport", async () => {
    let ok = false;
    const { R, hote } = await monterPage("admin", (u) =>
      u.endsWith("/auto")
        ? json({ enabled: true })
        : u.includes("/list")
          ? json({ reports: [] })
          : ok
            ? json(RAPPORT)
            : json({}, 503),
    );
    const p = R.loadDailyReport();
    await nextTick();
    expect(hote.querySelector("[aria-busy='true']")).not.toBeNull();
    await p;
    await attendre(() => !!hote.textContent?.includes("Rapport indisponible"));
    expect(hote.textContent).toContain("Rapport indisponible");
    expect(hote.textContent).toContain("rapport du jour");
    ok = true;
    const bouton = [...hote.querySelectorAll("button")].find((b) => b.textContent?.includes("Réessayer"));
    bouton?.click();
    await attendre(() => !!hote.textContent?.includes("Indicateurs"));
    expect(hote.textContent).not.toContain("Rapport indisponible");
    expect(hote.textContent).toContain("Indicateurs");
  });

  it("aperçu A4 : Imprimer l'ouvre, Fermer (clic) le ferme et rend le focus à Imprimer", async () => {
    const { R, hote } = await monterPage("admin", route);
    await R.loadDailyReport();
    await attendre(() => !!hote.textContent?.includes("Indicateurs"));
    const imprimer = hote.querySelector<HTMLButtonElement>("#rap-imprimer")!;
    imprimer.focus();
    imprimer.click();
    await attendre(() => !!document.body.querySelector(".rap-feuille"));
    expect(document.body.querySelector(".rap-feuille")).not.toBeNull();
    expect(document.activeElement?.textContent).toContain("Imprimer");
    const fermer = [...document.body.querySelectorAll<HTMLButtonElement>(".rap-barre button")].find((b) =>
      b.textContent?.includes("Fermer"),
    );
    fermer?.click();
    await attendre(() => !document.body.querySelector(".rap-feuille"));
    expect(document.body.querySelector(".rap-feuille")).toBeNull();
    expect(document.activeElement).toBe(imprimer);
  });

  it("aperçu : Échap fonctionne même après un clic sur la feuille ; l'écouteur est retiré", async () => {
    const { R, hote } = await monterPage("admin", route);
    await R.loadDailyReport();
    await attendre(() => !!hote.textContent?.includes("Indicateurs"));
    R.openReportPreview();
    await attendre(() => !!document.body.querySelector(".rap-feuille"));
    document.body.querySelector<HTMLElement>(".rap-feuille")?.click();
    (document.body as HTMLElement).focus();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await attendre(() => !document.body.querySelector(".rap-feuille"));
    expect(R.reportPreview.value).toBe(false);
    // Ouverture puis fermeture à un tour d'écart : l'écouteur est bien posé, puis bien retiré.
    const retire = vi.spyOn(document, "removeEventListener");
    R.openReportPreview();
    await attendre(() => !!document.body.querySelector(".rap-feuille"));
    R.closeReportPreview();
    await attendre(() => !document.body.querySelector(".rap-feuille"));
    expect(retire.mock.calls.filter(([type]) => type === "keydown").length).toBeGreaterThan(0);
    retire.mockRestore();
    R.openReportPreview();
    await attendre(() => !!document.body.querySelector(".rap-feuille"));
    R.closeReportPreview();
    await attendre(() => !document.body.querySelector(".rap-feuille"));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await attendre();
    expect(R.reportPreview.value).toBe(false);
  });

  it("aperçu : Tab boucle dans la couche", async () => {
    const { R, hote } = await monterPage("admin", route);
    await R.loadDailyReport();
    await attendre(() => !!hote.textContent?.includes("Indicateurs"));
    R.openReportPreview();
    await attendre(() => !!document.body.querySelector(".rap-feuille"));
    const boutons = [...document.body.querySelectorAll<HTMLButtonElement>(".rap-barre button")];
    for (const b of boutons) Object.defineProperty(b, "offsetParent", { get: () => document.body });
    const dernier = boutons[boutons.length - 1]!;
    dernier.focus();
    const e = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    dernier.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(boutons[0]);
  });

  it("aperçu : fermé quand on quitte l'onglet Rapport", async () => {
    const { R, hote } = await monterPage("admin", route);
    await R.loadDailyReport();
    await attendre(() => !!hote.textContent?.includes("Indicateurs"));
    R.openReportPreview();
    await attendre(() => !!document.body.querySelector(".rap-feuille"));
    app?.unmount();
    app = null;
    expect(R.reportPreview.value).toBe(false);
  });

  it("feuille : mention « pas de données de série » et graphiques empilés avec légende", async () => {
    const { R, hote } = await monterPage("admin", route);
    await R.loadDailyReport();
    await attendre(() => !!hote.textContent?.includes("Indicateurs"));
    R.openReportPreview();
    await attendre(() => !!document.body.querySelector(".rap-feuille"));
    expect(document.body.querySelector(".rap-feuille__note")?.textContent).toContain(
      "Pas de données de série",
    );
  });

  it("changement de jour : contenu atténué et aria-busy pendant le chargement", async () => {
    const { fetch, appels } = fetchManuel();
    const R = setupAdminRapport({}, new ClientHttp(new GestionnaireSession(), fetch));
    const adm = reactive({ adminTab: "report", user: { username: "u", role: "admin" }, ...R });
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp(defineComponent({ render: () => h(PageRapport) }));
    app.provide(CLE_ADMIN, adm as unknown as DomaineAdmin);
    app.mount(hote);
    adm.dailyReport = RAPPORT as never;
    const p = R.loadDailyReport("2026-06-20");
    await attendre(() => !!hote.querySelector(".rap-attenue"));
    expect(hote.querySelector(".rap-attenue")?.getAttribute("aria-busy")).toBe("true");
    appels.find((a) => a.url.includes("?date="))!.repondre(json({ detail: "x" }, 404));
    await pomper(appels, p);
  });
});

describe("course entre chargements", () => {
  it("une réponse lente du jour A n'écrase ni le rapport ni l'état de chargement du jour B", async () => {
    const { fetch, appels } = fetchManuel();
    const R = setupAdminRapport({}, new ClientHttp(new GestionnaireSession(), fetch));
    const pA = R.loadDailyReport("2026-06-01");
    const pB = R.loadDailyReport("2026-06-02");
    const req = (j: string) => appels.find((a) => a.url.includes(j))!;
    req("2026-06-02").repondre(json({ ...RAPPORT, date: "2026-06-02" }));
    await pomper(appels, pB);
    expect(R.dailyReportLoading.value).toBe(false);
    req("2026-06-01").repondre(json({ detail: "lent" }, 503));
    await pA;
    expect(R.dailyReport.value?.date).toBe("2026-06-02");
    expect(R.dailyReportError.value).toBeNull();
    expect(R.reportDay.value).toBe("2026-06-02");
  });

  it("le jour B en cours garde le chargement actif quand A se termine", async () => {
    const { fetch, appels } = fetchManuel();
    const R = setupAdminRapport({}, new ClientHttp(new GestionnaireSession(), fetch));
    const pA = R.loadDailyReport("2026-06-01");
    const pB = R.loadDailyReport("2026-06-02");
    appels.find((a) => a.url.includes("2026-06-01"))!.repondre(json(RAPPORT));
    await pA;
    expect(R.dailyReportLoading.value).toBe(true);
    appels.find((a) => a.url.includes("2026-06-02"))!.repondre(json({ ...RAPPORT, date: "2026-06-02" }));
    await pomper(appels, pB);
    expect(R.dailyReportLoading.value).toBe(false);
  });
});

describe("graphiques sur les vrais identifiants", () => {
  const jeux = (...l: string[]) => l.map((label) => ({ label, data: [1, 2] }));
  const r = {
    ...RAPPORT,
    sections: [
      {
        id: "charts",
        label: "Graphiques",
        widgets: [
          "usage_timeline",
          "usage_by_model",
          "latency_percentiles",
          "active_users_day",
          "tools_usage",
          "usage_thinking_timeline",
        ],
      },
    ],
    titles: {},
    widgets: {
      usage_timeline: {
        labels: ["a", "b"],
        datasets: jeux("1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"),
      },
      usage_by_model: {
        labels: ["m1", "m2"],
        datasets: jeux("Cache", "Entrée utile", "Réflexion", "Réponse"),
      },
      latency_percentiles: {
        labels: ["P50", "P75", "P95", "P99"],
        datasets: [{ label: "s", data: [1, 2, 3, 4] }],
      },
      active_users_day: { labels: ["a", "b"], datasets: [{ label: "n", data: [1, 2] }] },
      tools_usage: { labels: ["x", "y"], datasets: [{ label: "n", data: [3, 4] }] },
      usage_thinking_timeline: { labels: ["a", "b"], datasets: jeux("Réflexion", "Réponse") },
    },
  };
  const { series } = elementsGraphiques(r);
  const par = (id: string) => series.find((s) => s.id === id)!;

  it("formes explicites et jeux conservés ; au-delà de 8 jeux, « Autres »", () => {
    expect(par("usage_by_model")).toMatchObject({ type: "bar", empile: true });
    expect(par("usage_by_model").datasets.map((d) => d.label)).toEqual([
      "Cache",
      "Entrée utile",
      "Réflexion",
      "Réponse",
    ]);
    expect(par("usage_timeline").datasets).toHaveLength(8);
    expect(par("usage_timeline").datasets[7]).toEqual({ label: "Autres", data: [4, 8] });
    expect(par("latency_percentiles")).toMatchObject({ type: "bar", empile: false });
    expect(par("active_users_day")).toMatchObject({ type: "line", empile: false });
    expect(par("tools_usage")).toMatchObject({ type: "bar", empile: false });
  });

  it("composant : barres empilées (échelle sur la somme), légende, <title> avec valeur, tous les libellés", async () => {
    const hote = document.createElement("div");
    document.body.appendChild(hote);
    app = createApp(
      defineComponent({
        render: () =>
          h(
            "div",
            series.map((s) => h(GraphiqueRapport, { serie: s })),
          ),
      }),
    );
    app.mount(hote);
    const svgs = hote.querySelectorAll("svg");
    const modele = svgs[1]!;
    expect(modele.querySelectorAll("rect")).toHaveLength(8);
    expect(modele.querySelector("rect title")?.textContent).toContain("m1 · Cache : 1");
    expect(
      [...hote.querySelectorAll(".rap-legende")[1]!.querySelectorAll("li")].map((l) => l.textContent?.trim()),
    ).toEqual(["Cache", "Entrée utile", "Réflexion", "Réponse"]);
    const labels = [...svgs[2]!.querySelectorAll(".rap-graphe__axe text")].map((t) => t.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(["P50", "P75", "P95", "P99"]));
  });
});

describe("feuille imprimée : CSS", () => {
  const css = readFileSync(resolve(__dirname, "../../css/style.css"), "utf8");

  it("légende dessinée par une bordure, couleurs forcées à l'impression, huit gris distincts", () => {
    expect(css).toMatch(/\.rap-legende i \{[^}]*border: 0\.3rem solid currentColor/u);
    expect(css).not.toMatch(/\.rap-legende i \{[^}]*background: currentColor/u);
    expect(css).toMatch(/\.rap-feuille \{ -webkit-print-color-adjust: exact; print-color-adjust: exact;/u);
    const gris = [...css.matchAll(/\.rap-feuille \.rap-c(\d) \{ color: (#[0-9a-f]{6}); \}/gu)].map(
      (m) => m[2],
    );
    expect(gris).toHaveLength(8);
    expect(new Set(gris).size).toBe(8);
    const clair = (h: string): number =>
      parseInt(h.slice(1, 3), 16) + parseInt(h.slice(3, 5), 16) + parseInt(h.slice(5, 7), 16);
    const tries = gris.map((g) => clair(g as string)).sort((a, b) => a - b);
    for (let i = 1; i < tries.length; i++) expect(tries[i]! - tries[i - 1]!).toBeGreaterThanOrEqual(30);
  });
});
