// SPDX-License-Identifier: MIT
/** frontend/test/admin/journalisation.test.ts — console › Système › Journalisation : chargement, erreur, conservation par la barre, gel et levée à confirmation tapée, test 429, alertes visibles sans « Ouvrir » pour un modérateur. */
import * as Vue from "vue";
import { createApp, defineComponent, h, nextTick, reactive, ref } from "vue";
import type { App, Component } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import PageApercu from "../../src/components/admin/PageApercu.vue";
import PageJournalisation from "../../src/components/admin/PageJournalisation.vue";
import { oublierBrouillons } from "../../src/features/admin/brouillons";
import { setupAdmin } from "../../src/features/admin/console";
import { CLE_ADMIN } from "../../src/features/admin/domaine";
import type { DomaineAdmin } from "../../src/features/admin/domaine";
import { octets, pluriel } from "../../src/features/admin/formats";
import { enMois } from "../../src/features/admin/journalisation";
import { chargementDe, reinitialiserSuiviChargement } from "../../src/features/admin/suivi-chargement";
import type { CtxAdmin, RefsAdmin } from "../../src/features/admin/types";
import { GestionnaireSession } from "../../src/features/auth/session";
import { ClientHttp } from "../../src/platform/http/client";
import { json, vider } from "../aides";

const REGLAGES = {
  retention_days: 365,
  hold: false,
  hold_reason: "",
  forwarding_expected: false,
  out_of_bounds: false,
  invalid: false,
  from_witness: false,
  bounds: { min: 180, max: 1095, default: 365 },
};

const ETAT = {
  directory: "/var/lib/elpis/audit",
  fallback_directory: false,
  mode: "2750",
  group_id: 990,
  world_readable: false,
  signed: true,
  kid: "k1",
  files: 400,
  bytes: 123456789,
  oldest: "2025-10-01",
  newest: "2026-11-07",
  daily_avg_bytes: 300000,
  disk: { free_bytes: 26 * 1024 ** 3, total_bytes: 100 * 1024 ** 3, days_left: 80 },
  clock_synchronized: true,
  forwarding: {
    collector: "logs.example.lan:6514",
    transport: "TCP + TLS (x509/name)",
    queue: { type: "LinkedList", file: "elpis-fwd", max_disk: "1g" },
    expected: true,
    agent: "rsyslog",
    active: true,
    rule: "/etc/rsyslog.d/60-elpis.conf",
    certificates: [
      {
        path: "/etc/elpis/client.pem",
        role: "client",
        readable: true,
        expires_at: "2026-12-01T00:00:00.000Z",
        days_left: 24,
      },
    ],
  },
  retention: {
    retention_days: 365,
    hold: false,
    hold_reason: "",
    forwarding_expected: false,
    out_of_bounds: false,
    invalid: false,
    from_witness: false,
    eligible_files: 0,
  },
  write_failures: { count: 0, last_error: null },
  writers: [
    {
      host: "h",
      service: "main",
      boot: "abcdef0123456789",
      last_ts: 1_762_500_000,
      last_action: "audit.writer.heartbeat",
      failures: 0,
      stopped: false,
    },
  ],
  alerts: [],
  generated_at: 1_762_500_100,
};

type Reponse = Response | (() => Response);
let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
  reinitialiserSuiviChargement();
  oublierBrouillons();
});

function monter(role = "admin") {
  const appels: string[] = [];
  const corps: Record<string, unknown[]> = {};
  const reponses: Record<string, Reponse[]> = {};
  const mots: string[] = [];
  let accepter = true;
  const fetchFaux = (url: string, init?: RequestInit): Promise<Response> => {
    const cle = (init?.method ?? "GET") + " " + url;
    appels.push(cle);
    if (init?.body) (corps[cle] ??= []).push(JSON.parse(String(init.body)));
    const file = reponses[cle];
    const r = file && file.length > 1 ? file.shift() : file?.[0];
    if (r) return Promise.resolve(typeof r === "function" ? r() : r);
    if (cle === "GET /api/admin/audit/status") return Promise.resolve(json(ETAT));
    return Promise.resolve(json({}, 404));
  };
  const refs: RefsAdmin = {
    user: ref({ id: 1, username: "root", role, is_admin: role === "admin" ? 1 : 0 }),
    isAdminView: ref(true),
  };
  const ctx: CtxAdmin = {
    showToast: () => undefined,
    fetchAuth: (url, options) => fetchFaux(url, options),
    openConfirm: () => Promise.resolve(true),
    openTypedConfirm: (_t, _x, mot) => {
      mots.push(mot);
      return Promise.resolve(accepter);
    },
    openChoice: () => Promise.resolve("save"),
    nextTick: () => Vue.nextTick(),
    loadPublicConfig: () => undefined,
    systemAlert: ref(""),
  };
  const A = setupAdmin(Vue, refs, ctx, new ClientHttp(new GestionnaireSession(), fetchFaux));
  A.adminTab.value = "audit-logging";
  return {
    A,
    appels,
    corps,
    mots,
    reponses,
    refuser: () => {
      accepter = false;
    },
  };
}

function afficher(A: ReturnType<typeof monter>["A"], page: Component = PageJournalisation) {
  const adm = reactive({ ...A }) as unknown as DomaineAdmin;
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp(defineComponent({ setup: () => () => h(page) }));
  app.provide(CLE_ADMIN, adm);
  app.mount(hote);
  return hote;
}

const bouton = (hote: HTMLElement, id: string): HTMLButtonElement =>
  hote.querySelector<HTMLButtonElement>(`#${id}`) as HTMLButtonElement;

describe("Journalisation : formats", () => {
  it("accords, tailles et durées", () => {
    expect(pluriel(0, "fichier")).toBe("0 fichier");
    expect(pluriel(1, "fichier")).toBe("1 fichier");
    expect(pluriel(2, "fichier")).toBe("2 fichiers");
    expect(octets(26 * 1024 ** 3)).toBe("26 Gio");
    expect(enMois(365)).toBe("1 an");
    expect(enMois(730)).toBe("2 ans");
    expect(enMois(180)).toBe("≈ 6 mois");
  });
});

describe("Journalisation : chargement", () => {
  it("squelettes tant que rien n'est lu, puis la page", async () => {
    const { A } = monter();
    const hote = afficher(A);
    expect(hote.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(hote.querySelector("#jnl-duree")).toBeNull();
    await A.loadAuditStatus();
    await vider();
    expect(hote.querySelector('[aria-busy="true"]')).toBeNull();
    expect((hote.querySelector("#jnl-duree") as HTMLInputElement).value).toBe("365");
    expect(hote.textContent).toContain("/etc/rsyslog.d/60-elpis.conf");
    expect(hote.textContent).toContain("Expire le");
    expect(A.adminDirtyCount.value).toBe(0);
  });

  it("l'entrée sur la page : une requête status, aucune requête settings", async () => {
    const { A, appels } = monter();
    await A.loadAuditStatus();
    expect(appels.filter((a) => a.includes("/api/admin/audit/"))).toEqual(["GET /api/admin/audit/status"]);
    expect(A.auditReglages.value).toMatchObject({ retention_days: 365, hold: false, invalid: false });
    expect(A.auditReglages.value?.bounds).toEqual({ min: 180, max: 1095, default: 365 });
  });

  it("un échec est suivi avec « Réessayer » et la page reste en squelette", async () => {
    const { A, reponses } = monter();
    reponses["GET /api/admin/audit/status"] = [json({}, 500), json(ETAT)];
    const hote = afficher(A);
    await A.loadAuditStatus();
    await vider();
    expect(hote.querySelector('[aria-busy="true"]')).not.toBeNull();
    const [echec] = chargementDe(["loadAuditStatus"]).echecs;
    expect(echec?.nom).toBe("loadAuditStatus");
    await echec?.reessayer();
    await vider();
    expect(hote.querySelector("#jnl-duree")).not.toBeNull();
    expect(chargementDe(["loadAuditStatus"]).echecs).toEqual([]);
  });
});

describe("Journalisation : conservation par la barre", () => {
  it("la modification est comptée, enregistrée par PUT, puis propre", async () => {
    const { A, corps, reponses } = monter();
    reponses["PUT /api/admin/audit/settings"] = [json({ ...REGLAGES, retention_days: 730 })];
    await A.loadAuditStatus();
    A.auditForm.value!.retention_days = 730;
    expect(A.adminDirtyCount.value).toBe(1);
    expect(A.adminPageSavable.value).toBe(true);
    expect(await A.saveAdminPage()).toBe(true);
    expect(corps["PUT /api/admin/audit/settings"]).toEqual([{ retention_days: 730 }]);
    expect(A.adminDirtyCount.value).toBe(0);
  });

  it("un 400 du serveur reste affiché en ligne et la barre reste ouverte", async () => {
    const { A, reponses } = monter();
    reponses["PUT /api/admin/audit/settings"] = [json({ detail: "Durée refusée par le serveur." }, 400)];
    const hote = afficher(A);
    await A.loadAuditStatus();
    await vider();
    A.auditForm.value!.forwarding_expected = true;
    expect(await A.saveAdminPage()).toBe(false);
    await vider();
    expect(hote.textContent).toContain("Durée refusée par le serveur.");
    expect(A.adminDirtyCount.value).toBe(1);
  });

  it("une durée hors bornes n'est pas envoyée", async () => {
    const { A, appels } = monter();
    await A.loadAuditStatus();
    A.auditForm.value!.retention_days = 100;
    await nextTick();
    expect(await A.saveAuditSettings()).toBe(false);
    expect(appels.some((a) => a.startsWith("PUT"))).toBe(false);
    expect(A.auditSaveErreur.value).toContain("180");
  });
});

describe("Journalisation : gel de la purge", () => {
  it("le motif est obligatoire : bouton inactif sous 5 caractères", async () => {
    const { A } = monter();
    const hote = afficher(A);
    await A.loadAuditStatus();
    await vider();
    expect(bouton(hote, "jnl-geler").disabled).toBe(true);
    A.auditMotif.value = "abc";
    await vider();
    expect(bouton(hote, "jnl-geler").disabled).toBe(true);
    A.auditMotif.value = "enquête 2026-15";
    await vider();
    expect(bouton(hote, "jnl-geler").disabled).toBe(false);
  });

  it("geler demande GELER puis écrit hold et le motif", async () => {
    const { A, corps, mots, reponses } = monter();
    reponses["PUT /api/admin/audit/settings"] = [
      json({ ...REGLAGES, hold: true, hold_reason: "enquête 2026-15" }),
    ];
    await A.loadAuditStatus();
    A.auditMotif.value = "  enquête 2026-15 ";
    expect(await A.geler()).toBe(true);
    expect(mots).toEqual(["GELER"]);
    expect(corps["PUT /api/admin/audit/settings"]).toEqual([{ hold: true, hold_reason: "enquête 2026-15" }]);
    expect(A.auditMotif.value).toBe("");
  });

  it("confirmation refusée : rien n'est envoyé et le motif est gardé", async () => {
    const { A, appels, mots, refuser } = monter();
    await A.loadAuditStatus();
    A.auditMotif.value = "enquête 2026-15";
    refuser();
    expect(await A.geler()).toBe(false);
    expect(mots).toEqual(["GELER"]);
    expect(appels.some((a) => a.startsWith("PUT"))).toBe(false);
    expect(A.auditMotif.value).toBe("enquête 2026-15");
  });

  it("le motif en cours de saisie est un brouillon hors barre", async () => {
    const { A } = monter();
    await A.loadAuditStatus();
    expect(A.adminBrouillons.value).toEqual([]);
    A.auditMotif.value = "motif en cours";
    expect(A.adminBrouillons.value.map((b) => b.id)).toEqual(["audit-gel"]);
  });

  it("lever demande LEVER puis écrit hold:false ; une erreur du serveur reste en ligne", async () => {
    const { A, corps, mots, reponses } = monter();
    reponses["GET /api/admin/audit/status"] = [
      json({ ...ETAT, retention: { ...ETAT.retention, hold: true, hold_reason: "x motif" } }),
      json(ETAT),
    ];
    reponses["PUT /api/admin/audit/settings"] = [json({ detail: "Gel impossible." }, 400), json(REGLAGES)];
    const hote = afficher(A);
    await A.loadAuditStatus();
    await vider();
    expect(hote.textContent).toContain("Gel actif");
    expect(bouton(hote, "jnl-geler")).toBeNull();
    expect(await A.leverGel()).toBe(false);
    await vider();
    expect(hote.textContent).toContain("Gel impossible.");
    expect(bouton(hote, "jnl-lever")).not.toBeNull();
    expect(await A.leverGel()).toBe(true);
    await vider();
    expect(hote.textContent).not.toContain("Gel actif");
    expect(bouton(hote, "jnl-geler")).not.toBeNull();
    expect(mots).toEqual(["LEVER", "LEVER"]);
    expect(corps["PUT /api/admin/audit/settings"]).toEqual([{ hold: false }, { hold: false }]);
  });
});

describe("Journalisation : état après geler / lever", () => {
  it("la carte reste sur l'état du PUT après Geler, même si l'état relu est VRAIMENT périmé", async () => {
    const { A, reponses } = monter();
    reponses["PUT /api/admin/audit/settings"] = [
      json({ ...REGLAGES, hold: true, hold_reason: "enquête 2026" }),
    ];
    reponses["GET /api/admin/audit/status"] = [json(ETAT)];
    const hote = afficher(A);
    await A.loadAuditStatus();
    await vider();
    expect(hote.textContent).not.toContain("Gel actif");
    A.auditMotif.value = "enquête 2026";
    await A.geler();
    await vider();
    expect(hote.textContent).toContain("Gel actif");
    expect(hote.textContent).toContain("enquête 2026");
    expect(bouton(hote, "jnl-geler")).toBeNull();
  });
});

describe("Journalisation : centralisation et purge", () => {
  it("collecteur, transport et file affichés ; encadré d'aide quand aucune règle n'est trouvée", async () => {
    const { A, reponses } = monter();
    const hote = afficher(A);
    await A.loadAuditStatus();
    await vider();
    expect(hote.textContent).toContain("logs.example.lan:6514");
    expect(hote.textContent).toContain("TCP + TLS (x509/name)");
    expect(hote.textContent).toContain("elpis-fwd");
    expect(hote.textContent).toContain("1g au plus");
    expect(hote.textContent).not.toContain("Mettre en place l'envoi");
    reponses["GET /api/admin/audit/status"] = [
      json({
        ...ETAT,
        forwarding: { ...ETAT.forwarding, rule: null, collector: null, transport: null, queue: null },
      }),
    ];
    await A.loadAuditStatus();
    await vider();
    expect(hote.textContent).toContain("Mettre en place l'envoi");
    expect(hote.textContent).toContain("deploy/rsyslog/60-elpis.conf.example");
  });

  it("agent d'état inconnu avec centralisation attendue : purge dite suspendue", async () => {
    const { A, reponses } = monter();
    reponses["GET /api/admin/audit/status"] = [
      json({ ...ETAT, forwarding: { ...ETAT.forwarding, active: null } }),
    ];
    const hote = afficher(A);
    await A.loadAuditStatus();
    await vider();
    expect(hote.textContent).toContain("Suspendue");
    expect(hote.textContent).not.toContain("Cette nuit");
  });

  it("zéro jour : « aujourd'hui » pour le certificat ; échecs au pluriel correct", async () => {
    const { A, reponses } = monter();
    reponses["GET /api/admin/audit/status"] = [
      json({
        ...ETAT,
        forwarding: {
          ...ETAT.forwarding,
          certificates: [{ ...ETAT.forwarding.certificates[0], days_left: 0 }],
        },
        writers: [{ ...ETAT.writers[0], failures: 1 }],
      }),
    ];
    const hote = afficher(A);
    await A.loadAuditStatus();
    await vider();
    expect(hote.textContent).toContain("aujourd'hui");
    expect(hote.textContent).toContain("1 échec");
    expect(hote.textContent).not.toContain("échec(s)");
  });
});

describe("Journalisation : état de la conservation", () => {
  it("durée illisible : mention et bouton « Réécrire dans config.json » qui envoie les deux valeurs", async () => {
    const { A, corps, reponses } = monter();
    reponses["GET /api/admin/audit/status"] = [
      json({ ...ETAT, retention: { ...ETAT.retention, invalid: true } }),
    ];
    reponses["PUT /api/admin/audit/settings"] = [json(REGLAGES)];
    const hote = afficher(A);
    await A.loadAuditStatus();
    await vider();
    expect(hote.textContent).toContain("Durée illisible dans config.json : purge suspendue.");
    expect(hote.textContent).toContain("Suspendue : durée illisible");
    bouton(hote, "jnl-reecrire").click();
    await vider();
    expect(corps["PUT /api/admin/audit/settings"]).toEqual([
      { retention_days: 365, forwarding_expected: false },
    ]);
    expect(hote.textContent).not.toContain("Durée illisible dans config.json");
  });

  it("réglages repris du témoin : mention et bouton de réécriture", async () => {
    const { A, reponses } = monter();
    reponses["GET /api/admin/audit/status"] = [
      json({ ...ETAT, retention: { ...ETAT.retention, from_witness: true } }),
    ];
    const hote = afficher(A);
    await A.loadAuditStatus();
    await vider();
    expect(hote.textContent).toContain("reprises du témoin");
    expect(bouton(hote, "jnl-reecrire")).not.toBeNull();
  });

  it("l'avertissement de suppression ne vaut que pour une durée plus courte, durée + 1 fichiers gardés", async () => {
    const { A } = monter();
    await A.loadAuditStatus();
    expect(A.auditSupprimes.value).toBe(0);
    A.auditForm.value!.retention_days = 730;
    expect(A.auditSupprimes.value).toBe(0);
    A.auditForm.value!.retention_days = 200;
    expect(A.auditSupprimes.value).toBe(400 - 201);
  });

  it("un rechargement ne remplace pas une saisie en cours ; Annuler la remplace et efface l'erreur", async () => {
    const { A } = monter();
    await A.loadAuditStatus();
    A.auditForm.value!.retention_days = 500;
    await A.loadAuditStatus();
    expect(A.auditForm.value!.retention_days).toBe(500);
    A.auditSaveErreur.value = "erreur";
    await A.discardAdminPage(true);
    expect(A.auditForm.value!.retention_days).toBe(365);
    expect(A.auditSaveErreur.value).toBe("");
    expect(A.adminDirtyCount.value).toBe(0);
  });

  it("« Rétablir » un champ du store audit remet sa valeur", async () => {
    const { A } = monter();
    await A.loadAuditStatus();
    A.auditForm.value!.retention_days = 500;
    A.auditForm.value!.forwarding_expected = true;
    const lignes = A.adminPageChanges.value;
    expect(lignes.map((l) => l.path).sort()).toEqual(["forwarding_expected", "retention_days"]);
    A.revertAdminChange(lignes.find((l) => l.path === "retention_days")!);
    expect(A.auditForm.value!.retention_days).toBe(365);
    expect(A.adminDirtyCount.value).toBe(1);
  });

  it("gel enregistré depuis la confirmation de sortie avec un motif trop court : erreur dite", async () => {
    const { A } = monter();
    await A.loadAuditStatus();
    A.auditMotif.value = "abc";
    const [b] = A.adminBrouillons.value;
    expect(await b?.enregistrer()).toBe(false);
    expect(A.auditGelErreur.value).toContain("5 caractères");
  });
});

describe("Journalisation : durée illisible ou hors bornes", () => {
  it("durée illisible : la barre inclut toujours retention_days avec la centralisation", async () => {
    const { A, corps, reponses } = monter();
    reponses["GET /api/admin/audit/status"] = [
      json({ ...ETAT, retention: { ...ETAT.retention, invalid: true } }),
    ];
    reponses["PUT /api/admin/audit/settings"] = [json({ ...REGLAGES, forwarding_expected: true })];
    await A.loadAuditStatus();
    A.auditForm.value!.forwarding_expected = true;
    expect(await A.saveAdminPage()).toBe(true);
    expect(corps["PUT /api/admin/audit/settings"]).toEqual([
      { retention_days: 365, forwarding_expected: true },
    ]);
  });

  it("hors bornes : texte sans nombre, valeur bornée proposée, « Réécrire » l'enregistre", async () => {
    const { A, corps, reponses } = monter();
    reponses["GET /api/admin/audit/status"] = [
      json({ ...ETAT, retention: { ...ETAT.retention, retention_days: 2000, out_of_bounds: true } }),
    ];
    reponses["PUT /api/admin/audit/settings"] = [json(REGLAGES)];
    const hote = afficher(A);
    await A.loadAuditStatus();
    await vider();
    expect(hote.textContent).toContain("hors des bornes");
    expect(hote.textContent).not.toContain("2000");
    expect((hote.querySelector("#jnl-duree") as HTMLInputElement).value).toBe("1095");
    expect(bouton(hote, "jnl-reecrire").disabled).toBe(false);
    bouton(hote, "jnl-reecrire").click();
    await vider();
    expect(corps["PUT /api/admin/audit/settings"]).toEqual([
      { retention_days: 1095, forwarding_expected: false },
    ]);
  });
});

describe("Journalisation : événement de test", () => {
  it("affiche le nonce, puis refuse un second essai immédiat", async () => {
    vi.useFakeTimers();
    try {
      const { A, appels, reponses } = monter();
      reponses["POST /api/admin/audit/test"] = [
        json({ ok: true, nonce: "7f3a9c21e4b05d18", ts: 1_762_500_000 }),
      ];
      await A.ecrireTestAudit();
      expect(A.auditTest.value?.nonce).toBe("7f3a9c21e4b05d18");
      expect(A.auditTestAttente.value).toBe(true);
      await A.ecrireTestAudit();
      expect(appels.filter((a) => a.startsWith("POST")).length).toBe(1);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(A.auditTestAttente.value).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("un 429 du serveur est affiché et le bouton reste inactif 10 s", async () => {
    vi.useFakeTimers();
    try {
      const { A, reponses } = monter();
      reponses["POST /api/admin/audit/test"] = [
        json({ detail: "Un événement de test vient d'être écrit, réessayez dans quelques secondes." }, 429),
      ];
      await A.ecrireTestAudit();
      expect(A.auditTestErreur.value).toContain("réessayez");
      expect(A.auditTest.value).toBeNull();
      expect(A.auditTestAttente.value).toBe(true);
      await vi.advanceTimersByTimeAsync(10_001);
      expect(A.auditTestAttente.value).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Alertes du journal pour un modérateur", () => {
  it("l'alerte est visible mais « Ouvrir » reste masqué (pages réservées aux admins)", () => {
    const staff = monter("staff");
    expect(staff.A.adminCanOpen("audit-logging")).toBe(false);
    expect(staff.A.adminCanOpen("logs/security")).toBe(false);
    expect(staff.A.adminCanOpen("logs")).toBe(true);
    const admin = monter("admin");
    expect(admin.A.adminCanOpen("audit-logging")).toBe(true);
    expect(admin.A.adminCanOpen("logs/security")).toBe(true);
  });
});

describe("Vue d'ensemble : alertes du journal", () => {
  const alertes = (action: string, detail: string) => [
    {
      id: "audit-hold",
      level: "info",
      title: "Gel de la purge du journal actif",
      detail,
      page: "audit-logging",
      action,
    },
    {
      id: "audit-write",
      level: "danger",
      title: "Écritures en échec",
      detail,
      page: "audit-logging",
      action,
    },
  ];
  function apercu(role: "admin" | "staff", liste: ReturnType<typeof alertes>) {
    const { A } = monter(role);
    A.adminTab.value = "overview";
    A.overview.value = {
      role: role === "admin" ? "admin" : "moderator",
      alerts: liste,
      services: [],
      kpis: { users: 0, turns: 0, tokens: 0, tool_calls: 0, tool_failures: 0 },
      backup: {},
      install: [],
    } as never;
    const hote = afficher(A, PageApercu);
    return { hote, A };
  }

  it("modérateur : alerte visible, titre seul, aucun bouton « Ouvrir »", async () => {
    const { hote } = apercu("staff", alertes("page", ""));
    await vider();
    expect(hote.textContent).toContain("Gel de la purge du journal actif");
    expect(hote.textContent).toContain("Écritures en échec");
    expect(hote.querySelector('button[aria-label^="Ouvrir"]')).toBeNull();
  });

  it("admin : bouton « Ouvrir » présent, la page cible est ouvrable", async () => {
    const { hote, A } = apercu("admin", alertes("page", "motif"));
    await vider();
    expect(hote.querySelectorAll('button[aria-label^="Ouvrir"]').length).toBe(2);
    expect(hote.textContent).toContain("motif");
    expect(A.adminCanOpen("audit-logging")).toBe(true);
  });
});
