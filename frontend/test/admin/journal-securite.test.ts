// SPDX-License-Identifier: MIT
/** frontend/test/admin/journal-securite.test.ts — Journaux › Sécurité : chargeur et curseur, filtres en paramètres, marqueurs masqués, export POST, vérification (quatre statuts), aucun appel en modérateur. */
import type { EvenementJournal, VerificationJournal } from "@elpis/contracts";
import * as Vue from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  actionEffective,
  filtresVides,
  joursDeLaPeriode,
  parametresRecherche,
} from "../../src/features/admin/journal-securite";
import {
  anomaliesBornees,
  anomaliesDe,
  cellulesBandeau,
  motifsNonVerifie,
  resumeDetails,
} from "../../src/features/admin/journal-securite-affichage";
import { ecrirePeriode } from "../../src/features/admin/periode";
import { json } from "../aides";
import { MAINTENANT, etatJournal, evenement, monter, page, verification } from "./journal-securite-aide";

const evenementsDe = (urls: string[]) => urls.filter((u) => u.startsWith("/api/admin/audit/events"));
const params = (url: string) => new URL(url, "http://x").searchParams;

afterEach(() => vi.unstubAllGlobals());

describe("paramètres de recherche", () => {
  it("filtres → paramètres : action saisie avant catégorie, marqueurs exclus par défaut", () => {
    const f = {
      ...filtresVides(),
      cat: "auth.",
      compte: " zoe ",
      resultat: "failure",
      ip: "10.0.",
      service: "main",
      texte: "x",
    };
    const qs = parametresRecherche({ du: "2026-11-01", au: "2026-11-07", filtres: f, marqueurs: false });
    expect(Object.fromEntries(qs)).toEqual({
      from: "2026-11-01",
      to: "2026-11-07",
      action: "auth.",
      user: "zoe",
      outcome: "failure",
      ip: "10.0.",
      service: "main",
      q: "x",
      limit: "50",
      exclude_markers: "1",
    });
    expect(actionEffective({ ...f, action: "admin.user.role" })).toBe("admin.user.role");
    const avec = parametresRecherche({
      du: "a",
      au: "b",
      filtres: filtresVides(),
      marqueurs: true,
      curseur: "c1",
    });
    expect(avec.has("exclude_markers")).toBe(false);
    expect(avec.get("cursor")).toBe("c1");
  });

  it("export : ni pagination ni filtre de marqueurs", () => {
    const qs = parametresRecherche({
      du: "a",
      au: "b",
      filtres: filtresVides(),
      marqueurs: false,
      export: true,
    });
    expect([...qs.keys()]).toEqual(["from", "to"]);
  });

  it("période en dates : contrôle des jours, de l'ordre et de la durée", () => {
    const p = { plage: "dates" as const, heures: 24, du: "2026-11-01", au: "2026-11-07" };
    expect(joursDeLaPeriode(p, MAINTENANT)).toEqual({ du: "2026-11-01", au: "2026-11-07" });
    expect(joursDeLaPeriode({ ...p, du: "2026-13-01" }, MAINTENANT)).toHaveProperty("erreur");
    expect(joursDeLaPeriode({ ...p, du: "2026-11-08" }, MAINTENANT)).toHaveProperty("erreur");
    expect(joursDeLaPeriode({ ...p, du: "2025-01-01" }, MAINTENANT, 366)).toHaveProperty("erreur");
  });
});

describe("chargeur et curseur", () => {
  it("lit la page et l'état, sans marqueurs par défaut ; la case les affiche (plus de paramètre)", async () => {
    const urls: string[] = [];
    const { A } = monter((url) => {
      urls.push(url);
      if (url === "/api/admin/audit/status") return json(etatJournal());
      return json(page([evenement(1), evenement(2)]));
    });
    await A.loadJournalSecurite();
    expect(A.secuLignes.value.map((l: EvenementJournal) => l.seq)).toEqual([1, 2]);
    expect(A.secuEtat.value?.kid).toBe("k1");
    expect(params(evenementsDe(urls)[0] ?? "").get("exclude_markers")).toBe("1");
    urls.length = 0;
    await A.secuBasculerMarqueurs(true);
    expect(params(evenementsDe(urls)[0] ?? "").has("exclude_markers")).toBe(false);
  });

  it("suit le curseur quand le budget coupe la page ; « résultats partiels » après 8 requêtes", async () => {
    const urls: string[] = [];
    let sansFin = false;
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/audit/events")) return json(etatJournal());
      urls.push(url);
      const n = urls.length;
      const derniere = !sansFin && n === 2;
      return json(
        page([evenement(n)], { cursor: derniere ? null : `c${n}`, budget_reached: !derniere, unreadable: 1 }),
      );
    });
    await A.loadJournalSecurite();
    expect(A.secuLignes.value.map((l: EvenementJournal) => l.seq)).toEqual([1, 2]);
    const u2 = params(urls[1] ?? "");
    expect([u2.get("cursor"), u2.get("limit")]).toEqual(["c1", "49"]);
    expect([A.secuPartiel.value, A.secuIllisibles.value, A.secuSuivant.value]).toEqual([false, 2, null]);
    urls.length = 0;
    sansFin = true;
    await A.loadJournalSecurite();
    expect([urls.length, A.secuLignes.value.length, A.secuPartiel.value, A.secuSuivant.value]).toEqual([
      8,
      8,
      true,
      "c8",
    ]);
  });

  it("lecture passée sous le début de la période : pas partiel, pas de suite", async () => {
    let n = 0;
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/audit/events")) return json(etatJournal());
      n += 1;
      return json(
        page([evenement(n)], { cursor: `c${n}`, budget_reached: true, last_ts: MAINTENANT - 48 * 3600 }),
      );
    });
    await A.loadJournalSecurite();
    expect([n, A.secuLignes.value.length, A.secuPartiel.value, A.secuSuivant.value]).toEqual([
      1,
      1,
      false,
      null,
    ]);
  });

  it("lignes plus anciennes que la période écartées ; requête de suite en échec : lignes gardées, partiel", async () => {
    let n = 0;
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/audit/events")) return json(etatJournal());
      n += 1;
      if (n === 2 || n === 3) return new Response("{}", { status: 429, headers: { "Retry-After": "0" } });
      return json(
        page([evenement(n), evenement(100_000, { ts: MAINTENANT - 30 * 3600 })].slice(0, n === 1 ? 1 : 2), {
          cursor: "c1",
          budget_reached: true,
          last_ts: MAINTENANT - 10,
        }),
      );
    });
    await A.loadJournalSecurite();
    expect([n, A.secuLignes.value.length, A.secuPartiel.value, A.secuEchec.value]).toEqual([
      3,
      1,
      true,
      true,
    ]);
    n = 10;
    await A.loadJournalSecurite();
    expect(A.secuLignes.value.map((l: EvenementJournal) => l.seq)).toEqual([11]);
    expect(A.secuSuivant.value).toBeNull();
  });

  it("« Plus ancien » remplace la page par la suite, « Plus récent » revient à la page précédente", async () => {
    const urls: string[] = [];
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/audit/events")) return json(etatJournal());
      urls.push(url);
      const c = params(url).get("cursor");
      if (c === null) return json(page([evenement(1)], { cursor: "c1" }));
      if (c === "c1") return json(page([evenement(2)], { cursor: "c2" }));
      return json(page([evenement(3)]));
    });
    await A.loadJournalSecurite();
    await A.secuPlusAncien();
    await A.secuPlusAncien();
    expect([
      A.secuNumeroPage.value,
      A.secuLignes.value.map((l: EvenementJournal) => l.seq),
      A.secuSuivant.value,
    ]).toEqual([2, [3], null]);
    await A.secuPlusRecent();
    expect([A.secuNumeroPage.value, A.secuLignes.value.map((l: EvenementJournal) => l.seq)]).toEqual([
      1,
      [2],
    ]);
    await A.secuPlusRecent();
    expect(params(urls.at(-1) ?? "").has("cursor")).toBe(false);
    expect(A.secuLignes.value.map((l: EvenementJournal) => l.seq)).toEqual([1]);
  });

  it("un filtre appliqué revient à la première page avec ses paramètres ; catégorie et action s'excluent", async () => {
    const urls: string[] = [];
    const { A } = monter((url) => {
      urls.push(url);
      return url.startsWith("/api/admin/audit/events")
        ? json(page([evenement(1)], { cursor: "c1" }))
        : json(etatJournal());
    });
    await A.loadJournalSecurite();
    await A.secuPlusAncien();
    urls.length = 0;
    A.secuFiltres.value.compte = "zoe";
    await A.secuChoisirCategorie("admin.");
    expect(A.secuNumeroPage.value).toBe(0);
    const u = params(evenementsDe(urls)[0] ?? "");
    expect([u.get("action"), u.get("user"), u.has("cursor")]).toEqual(["admin.", "zoe", false]);
    await A.secuSaisirAction("auth.login");
    expect(A.secuFiltres.value.cat).toBe("");
    await A.secuEffacer();
    expect(params(evenementsDe(urls).at(-1) ?? "").has("action")).toBe(false);
  });

  it("un changement de filtre ou de période : une requête events, aucune requête status", async () => {
    const urls: string[] = [];
    const { A } = monter((url) => {
      urls.push(url);
      return url.startsWith("/api/admin/audit/events") ? json(page([evenement(1)])) : json(etatJournal());
    });
    await A.loadJournalSecurite();
    expect(urls.filter((u) => u === "/api/admin/audit/status")).toHaveLength(1);
    urls.length = 0;
    await A.secuChoisirCategorie("admin.");
    await A.secuChoisirResultat("failure");
    await A.secuEffacer();
    expect(evenementsDe(urls)).toHaveLength(3);
    expect(urls.filter((u) => u === "/api/admin/audit/status")).toHaveLength(0);
  });

  it("modérateur : aucun appel aux routes du journal de sécurité", async () => {
    const urls: string[] = [];
    const { A } = monter(
      (url) => {
        urls.push(url);
        return json({});
      },
      { username: "mo", role: "moderator", is_admin: 2 },
    );
    await A.loadJournalSecurite();
    await A.loadJournalEtat();
    await A.verifierIntegrite();
    A.secuExportDu.value = "2026-11-01";
    A.secuExportAu.value = "2026-11-02";
    await A.lancerExport();
    expect(urls.filter((u) => u.startsWith("/api/admin/audit"))).toEqual([]);
  });
});

describe("relecture de J1", () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const enTete = (init?: RequestInit): string | undefined =>
    (init?.headers as Record<string, string> | undefined)?.["X-Elpis-Console"];

  it("en-tête de console sur chaque requête de recherche", async () => {
    const entetes: (string | undefined)[] = [];
    const { A } = monter((url, init) => {
      if (url.startsWith("/api/admin/audit/events")) entetes.push(enTete(init));
      return url.startsWith("/api/admin/audit/events") ? json(page([evenement(1)])) : json(etatJournal());
    });
    await A.loadJournalSecurite();
    expect(entetes).toEqual(["1"]);
  });

  it("première lecture sur la période choisie ailleurs (30 j) : from à J-30", async () => {
    const urls: string[] = [];
    const { A } = monter((url) => {
      urls.push(url);
      return url.startsWith("/api/admin/audit/events") ? json(page([evenement(1)])) : json(etatJournal());
    });
    ecrirePeriode(720);
    try {
      await A.loadJournalSecurite();
      const u = params(evenementsDe(urls)[0] ?? "");
      expect(u.get("from")).toBe(new Date((MAINTENANT - 720 * 3600) * 1000).toISOString().slice(0, 10));
      expect(A.secuHeures.value).toBe(720);
    } finally {
      ecrirePeriode(24);
    }
  });

  it("filtres figés pour toute la page : une frappe en cours de lecture ne change pas les requêtes de suite", async () => {
    const urls: string[] = [];
    let liberer: (() => void) | null = null;
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/audit/events")) return json(etatJournal());
      urls.push(url);
      const n = urls.length;
      const r = json(page([evenement(n)], { cursor: n < 3 ? `c${n}` : null, budget_reached: n < 3 }));
      if (n !== 1) return r;
      return new Promise<Response>((fin) => {
        liberer = () => fin(r);
      });
    });
    const lecture = A.loadJournalSecurite();
    await flush();
    A.secuFiltres.value.compte = "zoe";
    A.secuMarqueurs.value = true;
    (liberer as unknown as () => void)();
    await lecture;
    expect(urls).toHaveLength(3);
    for (const u of urls) {
      const q = params(u);
      expect([q.has("user"), q.get("exclude_markers")]).toEqual([false, "1"]);
    }
  });

  it("« Plus ancien » en échec : page, curseurs et rangs inchangés ; « Réessayer » relance la page affichée (page > 0)", async () => {
    const urls: string[] = [];
    let echouer = false;
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/audit/events")) return json(etatJournal());
      urls.push(url);
      const c = params(url).get("cursor");
      if (echouer && c === "c2") return json({ detail: "x" }, 500);
      if (c === "c1") return json(page([evenement(3), evenement(4)], { cursor: "c2" }));
      return json(page([evenement(1), evenement(2)], { cursor: "c1" }));
    });
    await A.loadJournalSecurite();
    await A.secuPlusAncien();
    echouer = true;
    await A.secuPlusAncien();
    expect([A.secuNumeroPage.value, A.secuEchec.value]).toEqual([1, true]);
    expect(A.secuLignes.value.map((l: EvenementJournal) => l.seq)).toEqual([3, 4]);
    expect(A.secuRangsPages.value).toEqual([0, 2]);
    echouer = false;
    urls.length = 0;
    await A.secuReessayer();
    expect(params(urls[0] ?? "").get("cursor")).toBe("c1");
    expect([A.secuEchec.value, A.secuNumeroPage.value]).toEqual([false, 1]);
  });

  it("nouvelle recherche dont la première page échoue : plus d'anciennes lignes, ni « Plus ancien », ni rang décalé", async () => {
    const urls: string[] = [];
    let echouer = false;
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/audit/events")) return json(etatJournal());
      urls.push(url);
      if (echouer) return json({ detail: "x" }, 500);
      return json(page([evenement(1), evenement(2)], { cursor: params(url).has("cursor") ? "c2" : "c1" }));
    });
    await A.loadJournalSecurite();
    await A.secuPlusAncien();
    expect(A.secuNumeroPage.value).toBe(1);
    echouer = true;
    await A.secuChoisirResultat("failure");
    expect([
      A.secuLignes.value.length,
      A.secuSuivant.value,
      A.secuNumeroPage.value,
      A.secuEchec.value,
    ]).toEqual([0, null, 0, true]);
    expect(A.secuRangsPages.value).toEqual([0]);
    urls.length = 0;
    echouer = false;
    await A.secuReessayer();
    expect(params(urls[0] ?? "").has("cursor")).toBe(false);
    expect(params(urls[0] ?? "").get("outcome")).toBe("failure");
  });

  it("rang des lignes d'après les lignes réellement affichées (page partielle)", async () => {
    let n = 0;
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/audit/events")) return json(etatJournal());
      n += 1;
      return json(page([evenement(n)], { cursor: `c${n}`, budget_reached: true }));
    });
    await A.loadJournalSecurite();
    expect(A.secuLignes.value).toHaveLength(8);
    await A.secuPlusAncien();
    expect([A.secuNumeroPage.value, A.secuRangsPages.value]).toEqual([1, [0, 8]]);
  });

  it("erreur de dates : une lecture en vol n'écrit plus et « Plus ancien » est désactivé", async () => {
    let liberer: (() => void) | null = null;
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/audit/events")) return json(etatJournal());
      return new Promise<Response>((fin) => {
        liberer = () => fin(json(page([evenement(1)], { cursor: "c1" })));
      });
    });
    const lecture = A.loadJournalSecurite();
    await flush();
    A.secuPlage.value = "dates";
    A.secuDu.value = "2026-11-09";
    A.secuAu.value = "2026-11-01";
    await A.secuChoisirDates();
    (liberer as unknown as () => void)();
    await lecture;
    expect([A.secuLignes.value.length, A.secuSuivant.value, A.secuChargement.value]).toEqual([
      0,
      null,
      false,
    ]);
    expect(A.secuErreurDates.value).toContain("suit");
  });

  it("429 : un seul nouvel essai après Retry-After", async () => {
    let n = 0;
    let toujours = false;
    const { A } = monter((url) => {
      if (!url.startsWith("/api/admin/audit/events")) return json(etatJournal());
      n += 1;
      if (toujours || n === 1) return new Response("{}", { status: 429, headers: { "Retry-After": "0" } });
      return json(page([evenement(1)]));
    });
    await A.loadJournalSecurite();
    expect([n, A.secuLignes.value.length, A.secuEchec.value]).toEqual([2, 1, false]);
    n = 0;
    toujours = true;
    await A.loadJournalSecurite();
    expect([n, A.secuEchec.value]).toEqual([2, true]);
  });
});

describe("rechargement hors de l'onglet Sécurité", () => {
  it("Actualiser ou changer la période d'Appels d'outils (même modérateur) n'appelle jamais le journal de sécurité", async () => {
    const urls: string[] = [];
    const { A } = monter(
      (url) => {
        urls.push(url);
        return json({ totals: { n: 0 }, per_tool: [], items: [] });
      },
      { username: "mo", role: "moderator", is_admin: 2 },
    );
    A.adminTab.value = "logs";
    A.rechargerPage();
    A.setObsScope(168);
    await Vue.nextTick();
    expect(urls.filter((u) => u.startsWith("/api/admin/audit"))).toEqual([]);
  });
});

describe("vérification", () => {
  it("POST sur la période ; les quatre statuts sont rendus tels quels", async () => {
    const corps: unknown[] = [];
    let statut: VerificationJournal["status"] = "intact";
    const { A } = monter((url, init) => {
      if (url !== "/api/admin/audit/verify") return json({});
      corps.push(JSON.parse(String(init?.body)));
      expect(init?.method).toBe("POST");
      return json(verification({ status: statut, intact: statut === "intact" }));
    });
    A.secuPlage.value = "dates";
    A.secuDu.value = "2026-11-01";
    A.secuAu.value = "2026-11-07";
    for (const s of ["intact", "anomalies", "non_verifie", "vide"] as const) {
      statut = s;
      const attente = A.verifierIntegrite();
      expect(A.secuVerification.value).toEqual({ statut: "en_cours" });
      await attente;
      expect(A.secuVerification.value).toMatchObject({ statut: "resultat", resultat: { status: s } });
    }
    expect(corps[0]).toEqual({ from: "2026-11-01", to: "2026-11-07" });
  });

  it("429 : message clair ; une seule vérification à la fois côté client", async () => {
    let n = 0;
    const { A } = monter((url) => {
      if (url !== "/api/admin/audit/verify") return json({});
      n += 1;
      return json({ detail: "Une vérification est déjà en cours." }, 429);
    });
    const a = A.verifierIntegrite();
    await A.verifierIntegrite();
    await a;
    expect(n).toBe(1);
    expect(A.secuVerification.value).toMatchObject({ statut: "erreur" });
    A.fermerVerification();
    expect(A.secuVerification.value).toBeNull();
  });

  it("anomalies listées et motifs du statut « non vérifié »", () => {
    const v = verification({
      status: "anomalies",
      invalid_signatures: [{ file: "audit-2026-11-05.jsonl", line: 3 }],
      gaps: [
        {
          file: "audit-2026-11-04.jsonl",
          line: 9,
          host: "h",
          service: "main",
          boot: "abcdef0123",
          from: 10,
          to: 14,
          kind: "milieu",
        },
      ],
      uncertain_ends: [
        {
          host: "h",
          service: "toolhost",
          boot: "ffff0000",
          last_ts: MAINTENANT,
          reason: "silence_fin_periode",
        },
      ],
    });
    expect(anomaliesDe(v).map((a) => a.type)).toEqual([
      "Signature invalide",
      "Numéros manquants",
      "Fin incertaine",
    ]);
    expect(anomaliesDe(v)[1]?.texte).toContain("5 lignes");
    const nv = verification({
      status: "non_verifie",
      unsigned: 2,
      key_available: false,
      reasons: [{ kind: "fin_ancienne", host: null, service: null, last_ts: null, text: "Fin ancienne." }],
    });
    expect(motifsNonVerifie(nv)).toHaveLength(3);
  });
});

describe("export", () => {
  it("POST avec les filtres de la liste, marqueurs compris ; un blob est téléchargé", async () => {
    const appels: { url: string; methode?: string }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      appels.push({ url, ...(init?.method ? { methode: init.method } : {}) });
      return Promise.resolve(
        new Response("a,b\n", { headers: { "content-disposition": 'attachment; filename="x.csv"' } }),
      );
    });
    URL.createObjectURL = vi.fn(() => "blob:x");
    URL.revokeObjectURL = vi.fn();
    const { A } = monter(() => json({}));
    A.secuFiltres.value.compte = "zoe";
    A.secuExportFormat.value = "csv";
    A.ouvrirExport();
    A.secuExportDu.value = "2026-11-01";
    A.secuExportAu.value = "2026-11-07";
    await A.lancerExport();
    expect(A.secuExportOuvert.value).toBe(false);
    expect(appels).toHaveLength(1);
    expect(appels[0]?.methode).toBe("POST");
    const u = params(appels[0]?.url ?? "");
    expect(Object.fromEntries(u)).toEqual({
      from: "2026-11-01",
      to: "2026-11-07",
      user: "zoe",
      format: "csv",
    });
    expect(A.transferModal.value.done).toBe(true);
  });

  it("429 et 503 : messages clairs dans la modale de transfert", async () => {
    let statut = 429;
    vi.stubGlobal("fetch", () => Promise.resolve(json({ detail: "brut" }, statut)));
    const { A } = monter(() => json({}));
    A.secuExportDu.value = "2026-11-01";
    A.secuExportAu.value = "2026-11-07";
    await A.lancerExport();
    expect(A.transferModal.value.error).toContain("Deux exports sont déjà en cours");
    statut = 503;
    await A.lancerExport();
    expect(A.transferModal.value.error).toContain("n'a pas pu être écrite");
  });

  it("plus de 366 jours ou dates invalides : refusé avant tout appel", async () => {
    const fetchEspion = vi.fn();
    vi.stubGlobal("fetch", fetchEspion);
    const { A } = monter(() => json({}));
    A.secuExportOuvert.value = true;
    A.secuExportDu.value = "2025-01-01";
    A.secuExportAu.value = "2026-11-07";
    await A.lancerExport();
    expect(A.secuExportErreur.value).toContain("366");
    expect(A.secuExportOuvert.value).toBe(true);
    expect(fetchEspion).not.toHaveBeenCalled();
  });
});

describe("affichage", () => {
  it("anomalies bornées : 20 par catégorie, « et X autres »", () => {
    const v = verification({
      status: "anomalies",
      invalid_signatures: Array.from({ length: 100 }, (_, i) => ({
        file: "audit-2026-11-05.jsonl",
        line: i + 1,
      })),
      unreadable: [{ file: "audit-2026-11-05.jsonl", line: 500 }],
      totals: { ...verification().totals, invalid_signatures: 130, unreadable: 1 },
    });
    const b = anomaliesBornees(v);
    expect(b.lignes.filter((a) => a.type === "Signature invalide")).toHaveLength(20);
    expect(b.lignes.filter((a) => a.type === "Ligne illisible")).toHaveLength(1);
    expect(b.autres).toBe(80 + 30);
  });

  it("anomalies bornées : les lignes v0 tardives comptent parmi les autres", () => {
    const v = verification({ status: "anomalies", totals: { ...verification().totals, late_v0: 4 } });
    expect(anomaliesBornees(v)).toEqual({ lignes: [], autres: 4 });
  });

  it("bandeau : tailles en Kio/Gio et jour du plus ancien fichier", () => {
    const par = Object.fromEntries(
      cellulesBandeau(
        etatJournal({
          bytes: 2048,
          disk: { free_bytes: 50 * 1024 ** 3, total_bytes: 60 * 1024 ** 3, days_left: 400 },
        }),
      ).map((c) => [c.cle, c]),
    );
    expect(par["conservation"]?.detail).toBe("Depuis le 01/10/2026 · 2 Kio");
    expect(par["disque"]?.valeur).toBe("50 Gio libres");
  });

  it("bandeau : centralisation attendue et absente, gel, disque presque plein", () => {
    const cells = cellulesBandeau(
      etatJournal({
        forwarding: {
          expected: true,
          agent: null,
          active: null,
          rule: null,
          collector: null,
          transport: null,
          queue: null,
          certificates: [],
        },
        retention: { ...etatJournal().retention, hold: true, hold_reason: "enquête" },
        disk: { free_bytes: 1024, total_bytes: 2048, days_left: 3 },
        clock_synchronized: false,
      }),
    );
    const par = Object.fromEntries(cells.map((c) => [c.cle, c]));
    expect(par["centralisation"]?.etat).toBe("down");
    expect(par["gel"]).toMatchObject({ etat: "info", detail: "enquête" });
    expect(par["disque"]?.etat).toBe("down");
    expect(par["horloge"]?.etat).toBe("warn");
  });

  it("résumé de ligne : champs techniques écartés, rafale signalée", () => {
    const e = evenement(1, {
      details: { path: "a", user_agent: "x", repeated: 4, window_s: 60, n: 2, z: 3, y: 4 },
    });
    expect(resumeDetails(e)).toBe("+4 en 60 s · path=a · n=2 · z=3");
  });
});
