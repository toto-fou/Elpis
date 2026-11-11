// SPDX-License-Identifier: MIT
/** frontend/test/admin/activite.test.ts — Activité › Appels d'outils et Exécutions : requêtes (pagination, recherche, tri, filtres), en-têtes aria-sort, pied « 1-50 sur N », lien run_id. */
import * as Vue from "vue";
import { createApp, defineComponent, h, reactive, ref } from "vue";
import type { App } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import OngletAppelsOutils from "../../src/components/admin/OngletAppelsOutils.vue";
import OngletExecutions from "../../src/components/admin/OngletExecutions.vue";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";
import { setupAdmin } from "../../src/features/admin/console";
import { setupAdminRuns } from "../../src/features/admin/executions";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { estIdExecution } from "../../src/features/admin/libelles-activite";
import { ecrirePeriode, lirePeriode } from "../../src/features/admin/periode";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json, vider } from "../aides";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  vi.useRealTimers();
});

const ERREUR = {
  ts: 1_780_000_000,
  run_id: "subagent-ab12cd34ef56gh",
  user_id: 3,
  pipeline_id: null,
  node_id: "n1",
  member_id: null,
  tool_name: "shell",
  server_name: "srv",
  status: "error",
  duration_ms: 45,
  error_short: "exit 1",
};
const SYNTHESE = {
  totals: { n: 10, total_ms: 10, n_error: 4, n_blocked: 2, n_timeout: 1 },
  per_tool: [
    { tool_name: "shell", n: 6, total_ms: 6, n_failed: 4, avg_ms: 1 },
    { tool_name: "git", n: 4, total_ms: 4, n_failed: 3, avg_ms: 1 },
  ],
  hours: 24,
};

function monter(role = "admin", total = 1284, erreur: Record<string, unknown> = ERREUR) {
  const vus: string[] = [];
  const fetch = (url: string): Promise<Response> => {
    vus.push(url);
    if (url.includes("tool-summary")) return Promise.resolve(json(SYNTHESE));
    if (url.includes("tool-failures"))
      return Promise.resolve(json({ items: [erreur], total, offset: 0, limit: 50, hours: 24 }));
    if (url.startsWith("/api/admin/runs/accounts")) return Promise.resolve(json({ hours: 24, items: [] }));
    return Promise.resolve(json({ items: [], total: 0, offset: 0, limit: 50 }));
  };
  const refs: RefsAdmin = { user: ref({ username: "root", role, is_admin: 1 }), isAdminView: ref(true) };
  const ctx: CtxAdmin = {
    showToast: () => undefined,
    fetchAuth: (u) => fetch(u),
    openConfirm: () => Promise.resolve(true),
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const http = new ClientHttp(new GestionnaireSession(), fetch);
  const A = setupAdmin(Vue, refs, ctx, http);
  const R = setupAdminRuns(http);
  const showRunDetails = vi.fn();
  const goAdminOnglet = vi.fn(() => Promise.resolve(true));
  const adm = reactive({
    ...A,
    ...R,
    goAdminOnglet,
    showRunDetails,
    user: { username: "root", role },
  }) as unknown as DomaineAdmin;
  return { adm, vus, showRunDetails, goAdminOnglet };
}

function afficher(adm: DomaineAdmin, composant: typeof OngletAppelsOutils): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(defineComponent({ setup: () => () => h(composant) }));
  app.provide(CLE_ADMIN, adm);
  app.mount(hote);
  return hote;
}

describe("Appels d'outils : chargeur", () => {
  it("fenêtre de 50, tri par défaut absent, filtres et recherche dans les paramètres", async () => {
    const { adm, vus } = monter();
    await adm.loadToolCalls();
    const premier = new URL(vus.find((u) => u.includes("tool-failures")) ?? "", "http://x");
    expect(Object.fromEntries(premier.searchParams)).toEqual({ hours: "24", limit: "50", offset: "0" });
    expect(adm.outilsTotal).toBe(1284);
    adm.filtrerOutils({ statut: "blocked", outil: "git" });
    await vider();
    const u = new URL(vus.filter((x) => x.includes("tool-failures")).at(-1) ?? "", "http://x");
    expect([u.searchParams.get("status"), u.searchParams.get("tool"), u.searchParams.get("offset")]).toEqual([
      "blocked",
      "git",
      "0",
    ]);
    adm.effacerFiltresOutils();
    await vider();
    expect(vus.filter((x) => x.includes("tool-failures")).at(-1)).not.toContain("status=");
  });

  it("pagination, tri (sens inversé au second clic) et recherche à 300 ms", async () => {
    vi.useFakeTimers();
    const { adm, vus } = monter();
    await adm.loadToolCalls();
    const dernier = (): URL =>
      new URL(vus.filter((x) => x.includes("tool-failures")).at(-1) ?? "", "http://x");
    adm.setOutilsPage(3);
    await vi.advanceTimersByTimeAsync(0);
    expect(dernier().searchParams.get("offset")).toBe("100");
    adm.trierOutils("tool_name");
    await vi.advanceTimersByTimeAsync(0);
    expect([dernier().searchParams.get("sort"), dernier().searchParams.get("dir")]).toEqual([
      "tool_name",
      "asc",
    ]);
    expect(adm.outilsPage).toBe(1);
    adm.trierOutils("tool_name");
    await vi.advanceTimersByTimeAsync(0);
    expect(dernier().searchParams.get("dir")).toBe("desc");
    const n = vus.length;
    adm.rechercherOutils("100% _");
    await vi.advanceTimersByTimeAsync(299);
    expect(vus.length).toBe(n);
    await vi.advanceTimersByTimeAsync(2);
    expect(dernier().searchParams.get("q")).toBe("100% _");
  });
});

describe("Appels d'outils : cache serveur", () => {
  it("la synthèse ne demande fresh=1 que sur Actualiser, pas à l'entrée ni au changement de période", async () => {
    const { adm, vus } = monter();
    const synthese = (): string[] => vus.filter((u) => u.includes("tool-summary"));
    await adm.loadToolCalls();
    expect(synthese().at(-1)).not.toContain("fresh=1");
    adm.rechargerPage(true);
    await vider();
    expect(synthese().at(-1)).toContain("&fresh=1");
    adm.setObsScope(168);
    await vider();
    expect(synthese().at(-1)).not.toContain("fresh=1");
  });
});

describe("Appels d'outils : page", () => {
  it("pied « 1-50 sur 1 284 », aria-sort, date locale avec ISO UTC en infobulle", async () => {
    const { adm } = monter();
    await adm.loadToolCalls();
    const hote = afficher(adm, OngletAppelsOutils);
    await vider();
    const pied = hote.querySelector(".sup-pied")?.textContent?.replace(/\s+/gu, " ") ?? "";
    expect(pied).toContain("1-1 sur 1 284");
    expect(pied).toContain("Page 1 sur 26");
    const tri = [...hote.querySelectorAll("th[aria-sort]")].map((t) => [
      t.textContent?.trim(),
      t.getAttribute("aria-sort"),
    ]);
    expect(tri).toEqual([["Quand", "descending"]]);
    const t = hote.querySelector("td.sup-quand time");
    expect(t?.getAttribute("title")).toBe("2026-05-28T20:26:40.000Z");
    expect(hote.querySelector(".sup-etat")?.textContent).toBe("erreur");
  });

  it("clic sur un en-tête : tri demandé ; Suivant : page 2 ; Précédent désactivé en page 1", async () => {
    const { adm, vus } = monter();
    await adm.loadToolCalls();
    const hote = afficher(adm, OngletAppelsOutils);
    await vider();
    const boutons = [...hote.querySelectorAll<HTMLButtonElement>(".sup-pied button")];
    expect(boutons[0]?.disabled).toBe(true);
    boutons[1]?.click();
    await vider();
    expect(vus.filter((u) => u.includes("tool-failures")).at(-1)).toContain("offset=50");
    const entete = [...hote.querySelectorAll<HTMLButtonElement>("th .sup-tri")].find((b) =>
      b.textContent?.includes("Durée"),
    );
    entete?.click();
    await vider();
    expect(vus.filter((u) => u.includes("tool-failures")).at(-1)).toContain("sort=duration_ms&dir=desc");
    expect(hote.querySelector("th[aria-sort]")?.textContent).toContain("Durée");
  });

  it("puce de statut et clic sur un outil du top filtrent les erreurs", async () => {
    const { adm, vus } = monter();
    await adm.loadToolCalls();
    const hote = afficher(adm, OngletAppelsOutils);
    await vider();
    [...hote.querySelectorAll<HTMLButtonElement>(".sup-puces .adm-chip")][2]?.click();
    await vider();
    expect(vus.filter((u) => u.includes("tool-failures")).at(-1)).toContain("status=blocked");
    hote.querySelector<HTMLElement>("tr.sup-ligne")?.click();
    await vider();
    expect(vus.filter((u) => u.includes("tool-failures")).at(-1)).toContain("tool=shell");
    expect(adm.outilsFiltre.outil).toBe("shell");
  });

  it("run_id cliquable : filtre exact, onglet ouvert une fois, chronologie pour un admin", async () => {
    ecrirePeriode(24);
    const { adm, showRunDetails, goAdminOnglet, vus } = monter("admin");
    await adm.loadToolCalls();
    const hote = afficher(adm, OngletAppelsOutils);
    await vider();
    const lien = hote.querySelector<HTMLAnchorElement>("a.sup-lien-run");
    expect(lien?.getAttribute("href")).toBe("#activity/runs");
    const avant = vus.length;
    lien?.click();
    expect(adm.admRunsFilter).toMatchObject({ runId: ERREUR.run_id, q: "", kind: "" });
    expect(goAdminOnglet).toHaveBeenCalledTimes(1);
    expect(goAdminOnglet).toHaveBeenCalledWith("activity", "runs");
    expect(showRunDetails).toHaveBeenCalledWith(ERREUR.run_id, [ERREUR.run_id], { admin: true });
    // Le serveur lit un run_id sans tenir compte de la période : elle ne bouge pas, et aucune requête ne part d'ici.
    expect(lirePeriode()).toBe(24);
    expect(vus.length).toBe(avant);
  });

  it("run_id de repli (« chat », identifiant de chat) : texte simple, pas de lien", async () => {
    const { adm, goAdminOnglet } = monter("admin", 1, { ...ERREUR, run_id: "chat" });
    await adm.loadToolCalls();
    const hote = afficher(adm, OngletAppelsOutils);
    await vider();
    expect(hote.querySelector("a.sup-lien-run")).toBeNull();
    expect(hote.textContent).toContain("chat");
    expect(estIdExecution("chat")).toBe(false);
    expect(estIdExecution("chat-ab12")).toBe(true);
    expect(goAdminOnglet).not.toHaveBeenCalled();
  });

  it("synthèse en échec puis page : l'erreur reste signalée et Réessayer relance la synthèse", async () => {
    const vus: string[] = [];
    let synthese = 503;
    const fetch = (url: string): Promise<Response> => {
      vus.push(url);
      if (url.includes("tool-summary")) return Promise.resolve(json(SYNTHESE, synthese));
      return Promise.resolve(json({ items: [ERREUR], total: 200, offset: 0, limit: 50, hours: 24 }));
    };
    const refs: RefsAdmin = {
      user: ref({ username: "root", role: "admin", is_admin: 1 }),
      isAdminView: ref(true),
    };
    const ctx: CtxAdmin = {
      showToast: () => undefined,
      fetchAuth: (u) => fetch(u),
      openConfirm: () => Promise.resolve(true),
      openChoice: () => Promise.resolve("save"),
      nextTick: () => Vue.nextTick(),
      loadPublicConfig: () => undefined,
      systemAlert: ref(""),
    };
    const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetch));
    await A.loadToolCalls();
    expect(A.obsEchec.value).toBe(true);
    await A.loadErreursOutils();
    expect(A.obsEchec.value).toBe(true);
    synthese = 200;
    const avant = vus.filter((u) => u.includes("tool-summary")).length;
    await A.loadToolCalls();
    expect(A.obsEchec.value).toBe(false);
    expect(vus.filter((u) => u.includes("tool-summary")).length).toBe(avant + 1);
    await A.loadErreursOutils();
    expect(A.obsEchec.value).toBe(false);
  });

  it("Top outils limité à 50 lignes avec « et N autres » ; la liste des outils garde tout", async () => {
    const { adm } = monter();
    await adm.loadToolCalls();
    adm.obsSummary = {
      totals: { n: 1 },
      per_tool: Array.from({ length: 120 }, (_, i) => ({
        tool_name: `outil_${String(i).padStart(3, "0")}`,
        n: 1,
        total_ms: 1,
        n_failed: 0,
        avg_ms: 1,
      })),
    };
    const hote = afficher(adm, OngletAppelsOutils);
    await vider();
    expect(hote.querySelectorAll("tr.sup-ligne")).toHaveLength(50);
    expect(hote.textContent).toContain("et 70 autres outils");
    expect(hote.querySelectorAll("select[aria-label=Outil] option")).toHaveLength(121);
  });

  it("cellule Serveur cliquable : pose le filtre de serveur, retirable par sa pastille", async () => {
    const { adm, vus } = monter();
    await adm.loadToolCalls();
    const hote = afficher(adm, OngletAppelsOutils);
    await vider();
    const resume = vus.filter((u) => u.includes("tool-summary")).length;
    hote.querySelector<HTMLButtonElement>("td button.sup-lien-run")?.click();
    await vider();
    expect(adm.outilsFiltre.serveur).toBe("srv");
    expect(vus.filter((u) => u.includes("tool-failures")).at(-1)).toContain("server=srv");
    // Le filtre ne relance pas la synthèse par outil.
    expect(vus.filter((u) => u.includes("tool-summary")).length).toBe(resume);
    hote.querySelector<HTMLButtonElement>("button[aria-label='Retirer le filtre de serveur']")?.click();
    await vider();
    expect(adm.outilsFiltre.serveur).toBe("");
  });

  it("requêtes par action : synthèse à l'entrée et à l'actualisation, erreurs seules pour page, tri, filtre, recherche", async () => {
    vi.useFakeTimers();
    const { adm, vus } = monter();
    const synthese = (): number => vus.filter((u) => u.includes("tool-summary")).length;
    const erreurs = (): number => vus.filter((u) => u.includes("tool-failures")).length;
    await adm.loadToolCalls();
    expect([synthese(), erreurs()]).toEqual([1, 1]);
    adm.setOutilsPage(2);
    adm.trierOutils("status");
    adm.filtrerOutils({ statut: "error" });
    adm.rechercherOutils("x");
    await vi.advanceTimersByTimeAsync(400);
    expect([synthese(), erreurs()]).toEqual([1, 5]);
    await adm.loadToolCalls();
    expect([synthese(), erreurs()]).toEqual([2, 6]);
  });

  it("run_id cliquable pour un modérateur : pas de chronologie (réservée aux admins)", async () => {
    const { adm, showRunDetails, goAdminOnglet } = monter("moderator");
    await adm.loadToolCalls();
    const hote = afficher(adm, OngletAppelsOutils);
    await vider();
    hote.querySelector<HTMLAnchorElement>("a.sup-lien-run")?.click();
    expect(goAdminOnglet).toHaveBeenCalledWith("activity", "runs");
    expect(showRunDetails).not.toHaveBeenCalled();
  });

  it("échec sans donnée : message et Réessayer ; liste vide filtrée : message dédié", async () => {
    const { adm } = monter();
    adm.obsEchec = true;
    const hote = afficher(adm, OngletAppelsOutils);
    await vider();
    expect(hote.textContent).toContain("Erreurs d'outils indisponibles");
    expect(hote.textContent).toContain("Réessayer");
    adm.obsEchec = false;
    adm.obsDerniereMaj = Date.now();
    adm.obsFailures = [];
    await vider();
    expect(hote.querySelector(".sup-liste td.adm-empty")?.textContent?.trim()).toBe(
      "Aucune erreur sur la fenêtre choisie.",
    );
    adm.outilsFiltre = { statut: "blocked", outil: "", serveur: "", q: "" };
    await vider();
    expect(hote.querySelector(".sup-liste td.adm-empty")?.textContent?.trim()).toBe(
      "Aucune erreur pour ces filtres sur la période.",
    );
  });
});

describe("Exécutions : page", () => {
  it("en-têtes triables avec aria-sort, pied de pagination, recherche transmise au serveur", async () => {
    vi.useFakeTimers();
    const { adm, vus } = monter();
    await adm.loadAdminRuns();
    const hote = afficher(adm, OngletExecutions);
    await vi.advanceTimersByTimeAsync(0);
    expect(hote.querySelector("th[aria-sort]")?.textContent).toContain("Début");
    expect(hote.querySelector(".sup-pied")?.textContent).toContain("0 sur 0");
    const champ = hote.querySelector<HTMLInputElement>("input[type=search]");
    expect(champ).not.toBeNull();
    champ!.value = "alice";
    champ!.dispatchEvent(new Event("input"));
    await vi.advanceTimersByTimeAsync(301);
    expect(vus.filter((u) => u.startsWith("/api/admin/runs?")).at(-1)).toContain("q=alice");
    [...hote.querySelectorAll<HTMLButtonElement>("th .sup-tri")]
      .find((b) => b.textContent?.includes("Compte"))
      ?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(vus.filter((u) => u.startsWith("/api/admin/runs?")).at(-1)).toContain("sort=username&dir=asc");
  });
});
