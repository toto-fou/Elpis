// SPDX-License-Identifier: MIT
/** apps/core/test/composition.test.ts — composition du core : authentification installée, gardes branchées, anciens jetons convertis au démarrage, bus d'événements, relais, page Code et CLI montés selon le process. */
import { createUser, creerJeton, signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { invalidateConfigCache, racineDepot, surchargerConfig } from "@elpis/config";
import { auditEvent, jetonInterne, oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";

import {
  brancherNettoyageNavigateursEnfants,
  composer,
  configurerAuditDuCore,
  convertirJetonsAuDemarrage,
  serviceDuProcess,
} from "../src/composition";
import { remplacerBase } from "../src/base";
import { getChat, upsertChat } from "../src/chats/stockage";
import { registerChatTask, unregisterChatTask, viderEtatPourTests } from "../src/tour/etat";
import { CycleDeVie } from "../src/cycle";
import { urlMainInterne } from "../src/evenements";
import { cheminJournalCommun } from "../src/evenements/journal-commun";
import { installerCrochetJournal } from "../src/journal";
import { configurerJournalProcess, oublierJournalProcess } from "../src/observabilite/journal-acces";
import { images, installerDiffusion, installerImages } from "../src/llm/ports";
import { traitementImages } from "../src/images/ports";
import { installerRelaisModeles } from "../src/llm/cache-modeles";
import { annulerRechargement } from "../src/ops/redemarrage";
import { AUCUN_HOTE, PREVIEW_PREFIXES, RELAY_PREFIXES } from "../src/relais";
import { oublierHotes } from "../src/relais/hotes";
import { FileAttente } from "../src/evenements/file";
import type { ElementSysteme } from "../src/evenements/systeme";
import { installerPublicationNotifications, pousserNotification } from "../src/notifications/envoi";
import type { Famille } from "../src/routes";
import { appTest, journalMuet, lignesAuditRecentes, lignesJournal } from "./aides";
import { FauxToolhost, JETON } from "./relais/aides";

let t: BaseDeTest;
let dep: DependancesAuth & DependancesJetons;
let auditIsole: string;
const auditAvant = process.env["ELPIS_AUDIT_DIR"];

beforeAll(() => {
  auditIsole = mkdtempSync(join(tmpdir(), "elpis-audit-composition-"));
  process.env["ELPIS_AUDIT_DIR"] = auditIsole;
});

afterAll(() => {
  if (auditAvant === undefined) delete process.env["ELPIS_AUDIT_DIR"];
  else process.env["ELPIS_AUDIT_DIR"] = auditAvant;
  oublierConfigurationAudit();
  rmSync(auditIsole, { recursive: true, force: true });
});
const T = 1_791_331_200;

/** Routes de B1-25 et leurs process (`routes.inventory.json`) ; les sondes sont interrogées avec une session. */
const ROUTES_B125: readonly (readonly [string, readonly string[]])[] = [
  ["GET /api/notifications", ["main"]],
  ["GET /api/notifications/unread-count", ["main"]],
  ["PATCH /api/notifications/:notif_id/read", ["main"]],
  ["PATCH /api/notifications/:notif_id/unread", ["main"]],
  ["POST /api/notifications/read-all", ["main"]],
  ["DELETE /api/notifications/:notif_id", ["main"]],
  ["POST /api/notifications/clear", ["main"]],
  ["GET /api/skins", ["main", "admin"]],
  ["GET /api/skins/:skin_id/skin.css", ["main", "admin"]],
  ["GET /api/skins/:skin_id/editeur.css", ["main", "admin"]],
  ["GET /api/skins/:skin_id/assets/:name", ["main", "admin"]],
  ["GET /api/skins/perso", ["main"]],
  ["POST /api/skins/perso", ["main"]],
  ["POST /api/skins/perso/verifier", ["main"]],
  ["DELETE /api/skins/perso/:skin_id", ["main"]],
  ["GET /api/skins/perso/:skin_id/skin.css", ["main"]],
  ["GET /api/charts/:chart_id", ["main"]],
];
/** Routes de B1-33a (console : comptes, groupes, clients OAuth), process admin seul. */
const ROUTES_B133A: readonly string[] = [
  "DELETE /api/admin/users/:target_id",
  "POST /api/admin/users/new",
  "POST /api/admin/users/:target_id/role",
  "POST /api/admin/reset-password",
  "GET /api/admin/users-with-groups",
  "PUT /api/admin/users/:target_id/desktop-targets",
  "GET /api/admin/llm/engine-options",
  "GET /api/admin/users/:target_id/llm-access",
  "PUT /api/admin/users/:target_id/llm-access",
  "POST /api/admin/users/:target_id/sandbox-quota",
  "POST /api/admin/users/:target_id/network-profile",
  "GET /api/admin/users/:target_id/access",
  "POST /api/admin/users/:target_id/access/revoke",
  "GET /api/admin/groups",
  "POST /api/admin/groups",
  "PUT /api/admin/groups/:group_id",
  "DELETE /api/admin/groups/:group_id",
  "PUT /api/admin/users/:target_id/groups",
  "GET /api/admin/groups/:group_id/llm-access",
  "PUT /api/admin/groups/:group_id/llm-access",
  "GET /api/admin/oauth/clients",
  "DELETE /api/admin/oauth/clients",
  "GET /api/admin/security/sessions",
  "POST /api/admin/security/sessions/revoke-all",
  "POST /api/admin/security/sessions/revoke-user/:user_id",
  "POST /api/admin/security/sessions/clear-user-revocation/:user_id",
  "GET /api/admin/security/https",
  "POST /api/admin/security/https",
  "POST /api/admin/security/listen",
  "POST /api/admin/compression-config",
  "GET /api/admin/config-file",
  "POST /api/admin/config-file",
  "PATCH /api/admin/config",
  "GET /api/admin/terminal/stats",
];
/** Routes de B1-33a réservées au personnel (administrateur ou modérateur). */
const ROUTES_B133A_STAFF: readonly string[] = [
  "GET /api/admin/compression-config",
  "GET /api/admin/overview",
  "GET /api/admin/restart-status",
  "GET /api/admin/logs/recent",
];
const SONDES_B125: readonly (readonly [string, readonly string[]])[] = [
  ["/api/notifications/unread-count", ["main"]],
  ["/api/skins", ["main", "admin"]],
];

const familleTest: Famille = {
  nom: "test",
  routes: [
    {
      methode: "GET",
      chemin: "/api/test/moi",
      processus: ["main"],
      acces: "session",
      traiter: (req) => ({ id: req.utilisateur?.id }),
    },
    {
      methode: "POST",
      chemin: "/api/test/ecrire",
      processus: ["main"],
      acces: "session",
      traiter: () => ({ ok: true }),
    },
  ],
};

beforeEach(async () => {
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  await t.base.run(
    "INSERT INTO users(username, pass_salt, pass_hash, created_at) VALUES ('alice', 's', 'h', 0)",
  );
  dep = {
    base: t.base,
    config: () => ({}),
    attributsCookie: () => ({
      cookie_name: "mcpwebui_session",
      same_site: "lax",
      https_only: false,
      max_age: 86400,
    }),
    secret: () => "secret-de-test",
    jetonService: () => "",
    maintenant: () => T,
  };
  lignesJournal.length = 0;
});

afterEach(async () => {
  installerCrochetJournal(null);
  installerDiffusion(null);
  installerRelaisModeles(null);
  await t.fermer();
});

function routesDe(app: FastifyInstance, famille: string): string[] {
  return app.elpis.routes
    .filter((r) => r.famille === famille)
    .map((r) => `${r.methodes.join(",")} ${r.chemin} ${r.acces}`);
}

describe("composition du core", () => {
  it("session, garde et CSRF actifs sur les routes montées", async () => {
    const c = await composer("main", t.base, journalMuet, dep);
    const app = await appTest({ ...c, familles: [...c.familles, familleTest] });
    expect((await app.inject({ method: "GET", url: "/api/test/moi" })).json()).toEqual({
      detail: "not logged in",
    });
    const cookie = `mcpwebui_session=${signerSession({ user_id: 1, _login_ts: T - 10 }, "secret-de-test", T)}`;
    const r = await app.inject({ method: "GET", url: "/api/test/moi", headers: { cookie } });
    expect(r.json()).toEqual({ id: 1 });
    expect(r.headers.vary).toBe("Cookie");
    const csrf = await app.inject({
      method: "POST",
      url: "/api/test/ecrire",
      headers: { cookie, origin: "http://ailleurs", host: "localhost" },
    });
    expect([csrf.statusCode, csrf.json()]).toEqual([403, { detail: "Requête cross-site refusée." }]);
    expect(app.elpis.routes.some((m) => m.chemin === "/api/test/moi" && m.acces === "session")).toBe(true);
    await app.close();
  });

  it("save-messages : la garde « run en cours » est branchée, la sauvegarde du front n'écrase pas le tour", async () => {
    const c = await composer("main", t.base, journalMuet, dep);
    const app = await appTest({ ...c, mode: "main" });
    const cookie = `mcpwebui_session=${signerSession({ user_id: 1, _login_ts: T - 10 }, "secret-de-test", T)}`;
    await upsertChat(t.base, 1, "c1", "T", [{ role: "user", content: "q" }], 100);
    const sauver = () =>
      app.inject({
        method: "PUT",
        url: "/api/saved/chats/c1/save-messages",
        headers: { cookie },
        payload: { messages: [{ role: "user", content: "question plus longue" }] },
      });
    try {
      registerChatTask(1, new AbortController(), "c1");
      expect((await sauver()).json()).toEqual({ ok: true, skipped: "generation_running" });
      expect((await getChat(t.base, 1, "c1"))?.["messages"]).toEqual([{ role: "user", content: "q" }]);
      unregisterChatTask(1, "c1");
      expect((await sauver()).json()).toEqual({ ok: true });
    } finally {
      viderEtatPourTests();
      await app.close();
    }
  });

  it("routes de B1-25 montées dans les process de l'inventaire, sous la garde de session", async () => {
    const cookie = `mcpwebui_session=${signerSession({ user_id: 1, _login_ts: T - 10 }, "secret-de-test", T)}`;
    for (const mode of ["main", "admin"] as const) {
      const c = await composer(mode, t.base, journalMuet, dep);
      const app = await appTest({ ...c, mode });
      const montees = new Map(
        app.elpis.routes.flatMap((r) => r.methodes.map((m) => [`${m} ${r.chemin}`, r.acces])),
      );
      for (const [route, processus] of ROUTES_B125)
        expect(montees.get(route), `${mode} : ${route}`).toBe(
          processus.includes(mode) ? "session" : undefined,
        );
      for (const [url, processus] of SONDES_B125) {
        const r = await app.inject({ method: "GET", url, headers: { cookie } });
        expect(r.statusCode, `${mode} : GET ${url}`).toBe(processus.includes(mode) ? 200 : 404);
      }
      await app.close();
    }
  });

  it("console B1-33a : routes montées dans le seul process admin, sous la garde administrateur", async () => {
    const cookie = `mcpwebui_session=${signerSession({ user_id: 1, _login_ts: T - 10 }, "secret-de-test", T)}`;
    for (const mode of ["main", "admin"] as const) {
      const c = await composer(mode, t.base, journalMuet, dep);
      const app = await appTest({ ...c, mode });
      const montees = new Map(
        app.elpis.routes.flatMap((r) => r.methodes.map((m) => [`${m} ${r.chemin}`, r.acces])),
      );
      for (const route of ROUTES_B133A)
        expect(montees.get(route), `${mode} : ${route}`).toBe(mode === "admin" ? "admin" : undefined);
      for (const route of ROUTES_B133A_STAFF)
        expect(montees.get(route), `${mode} : ${route}`).toBe(mode === "admin" ? "staff" : undefined);
      const r = await app.inject({ method: "GET", url: "/api/admin/groups", headers: { cookie } });
      expect([r.statusCode, r.json()], mode).toEqual(
        mode === "admin" ? [403, { detail: "Admin required" }] : [404, { detail: "Not Found" }],
      );
      if (mode === "admin") {
        await t.base.run("UPDATE users SET is_admin=1 WHERE id=1");
        const ok = await app.inject({ method: "GET", url: "/api/admin/groups", headers: { cookie } });
        expect([ok.statusCode, ok.json()]).toEqual([200, { groups: [] }]);
        const terminaux = await app.inject({
          method: "GET",
          url: "/api/admin/terminal/stats",
          headers: { cookie },
        });
        expect(terminaux.json()).toEqual({
          worker_pid: process.pid,
          count: 0,
          idle_timeout_sec: 1800,
          max_sessions_per_user: 4,
          sessions: [],
        });
        const journaux = await app.inject({
          method: "GET",
          url: "/api/admin/logs/recent?limit=1",
          headers: { cookie },
        });
        expect([journaux.statusCode, journaux.json().filters_applied.limit]).toEqual([200, 1]);
        const redemarrage = await app.inject({
          method: "GET",
          url: "/api/admin/restart-status",
          headers: { cookie },
        });
        expect(redemarrage.statusCode).toBe(200);
        expect(redemarrage.json().pending).toEqual([]);
        expect(Array.isArray(redemarrage.json().paths)).toBe(true);
      }
      await app.close();
    }
  });

  it("console Sécurité : changer l'écoute redémarre main puis recharge l'admin", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-composition-ecoute-"));
    const recus: string[] = [];
    const main = createServer((req, rep) => {
      recus.push(`${req.method} ${req.url}`);
      rep.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => main.listen(0, "127.0.0.1", r));
    const avant = process.env["MAIN_INTERNAL_URL"];
    process.env["MAIN_INTERNAL_URL"] = `http://127.0.0.1:${(main.address() as AddressInfo).port}`;
    writeFileSync(join(dossier, "config.json"), "{}");
    const restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    try {
      await t.base.run("UPDATE users SET is_admin=1 WHERE id=1");
      const c = await composer("admin", t.base, journalMuet, dep, dossier, {
        cycle: new CycleDeVie(journalMuet),
      });
      const app = await appTest({ ...c, mode: "admin" });
      const cookie = `mcpwebui_session=${signerSession({ user_id: 1, _login_ts: T - 10 }, "secret-de-test", T)}`;
      const r = await app.inject({
        method: "POST",
        url: "/api/admin/security/listen",
        headers: { cookie },
        payload: { listen: "lan" },
      });
      expect([r.statusCode, r.json()]).toEqual([200, { ok: true, listen: "lan", main_restarted: true }]);
      expect(recus).toContain("POST /api/admin/internal/restart-self");
      await app.close();
    } finally {
      annulerRechargement();
      restaurer();
      invalidateConfigCache();
      if (avant === undefined) delete process.env["MAIN_INTERNAL_URL"];
      else process.env["MAIN_INTERNAL_URL"] = avant;
      await new Promise((r) => main.close(r));
      rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("routes de B1-32 (métriques, observabilité, usage) : toutes celles de l'inventaire, dans ses process, sous leur garde", async () => {
    const inventaire = JSON.parse(
      readFileSync(join(racineDepot(), "migration-kit", "routes.inventory.json"), "utf8"),
    ) as { routes: { methodes: string[]; chemin: string; module: string; process: string[] }[] };
    const modules = [
      "shared_infra/routes/admin/metrics.py",
      "shared_infra/routes/admin/observability.py",
      "shared_infra/observability/routes_usage.py",
    ];
    const attendues = inventaire.routes.filter((r) => modules.includes(r.module));
    expect(attendues).toHaveLength(15);
    const ACCES: Readonly<Record<string, string>> = {
      "GET /api/usage/me": "session",
      "GET /api/admin/metrics/prometheus": "public",
      "GET /api/admin/metrics/scrape-token": "admin",
      "POST /api/admin/metrics/scrape-token": "admin",
      "POST /api/admin/metrics/purge": "admin",
      "POST /api/admin/report/daily/generate": "admin",
      "POST /api/admin/report/daily/auto": "admin",
      // Écart voulu : journal de sécurité réservé aux admins (ANSSI R27).
      "GET /api/admin/observability/audit-recent": "admin",
    };
    for (const mode of ["main", "admin"] as const) {
      const c = await composer(mode, t.base, journalMuet, dep);
      const app = await appTest({ ...c, mode });
      const montees = new Map(
        app.elpis.routes.flatMap((r) => r.methodes.map((m) => [`${m} ${r.chemin}`, r.acces])),
      );
      for (const r of attendues)
        for (const m of r.methodes) {
          const cle = `${m} ${r.chemin}`;
          expect(montees.get(cle), `${mode} : ${cle}`).toBe(
            r.process.includes(mode) ? (ACCES[cle] ?? "staff") : undefined,
          );
        }
      await app.close();
    }
  });

  it("traitement des pixels branché au démarrage (main et admin) : la vision réduit ses captures", async () => {
    for (const mode of ["main", "admin"] as const) {
      installerImages(null);
      await composer(mode, t.base, journalMuet, dep);
      expect(images(), mode).toBe(traitementImages);
    }
  });

  it("notifications : publication live branchée sur le bus du process", async () => {
    const c = await composer("main", t.base, journalMuet, dep);
    const file = new FileAttente<ElementSysteme>();
    c.evenements.systemEvents.clients.set(file, { staff: false, uid: 1 });
    try {
      expect(await pousserNotification(t.base, 1, "routine_ok", "Fini")).not.toBeNull();
      expect(String(file.retirer())).toContain('"type": "notification"');
    } finally {
      installerPublicationNotifications(null);
    }
  });

  it("anciens jetons opencode convertis au démarrage, journalisés", async () => {
    await t.base.exec("CREATE TABLE code_remote_tokens(user_id INTEGER, token TEXT, created_at REAL)");
    await t.base.run("INSERT INTO code_remote_tokens VALUES (1, ?, 5)", [`pcr_${"a".repeat(40)}`]);
    await composer("main", t.base, journalMuet, dep);
    expect(await t.base.all("SELECT kind, hint FROM tool_tokens")).toEqual([
      { kind: "opencode", hint: "aaaa" },
    ]);
    expect(lignesJournal.join("\n")).toContain(
      "[tokens] 1 ancien(s) jeton(s) opencode converti(s) en empreinte",
    );
  });

  it("une conversion en échec est journalisée sans bloquer le démarrage", async () => {
    const enPanne = { ecriture: () => Promise.reject(new Error("base verrouillée")) } as unknown as Base;
    await expect(convertirJetonsAuDemarrage(enPanne, journalMuet)).resolves.toBeUndefined();
    expect(lignesJournal.join("\n")).toContain("[tokens] conversion des anciens jetons impossible");
  });

  it("audit du process : APP_SERVICE prioritaire, sinon le mode ; clé illisible journalisée", () => {
    const d = mkdtempSync(join(tmpdir(), "elpis-audit-core-"));
    try {
      configurerAuditDuCore("admin", journalMuet, {
        ELPIS_AUDIT_DIR: d,
        ELPIS_AUDIT_KEY_PATH: join(d, "absente"),
      });
      auditEvent({ userId: 1, username: "a", action: "x" });
      expect(lignesAuditRecentes()[0]).toMatchObject({ service: "admin", action: "x" });
      configurerAuditDuCore("main", journalMuet, {
        APP_SERVICE: "Main",
        ELPIS_AUDIT_DIR: d,
        ELPIS_AUDIT_KEY_PATH: join(d, "absente"),
      });
      auditEvent({ userId: 1, username: "a", action: "y" });
      expect(lignesAuditRecentes()[0]).toMatchObject({ service: "main", action: "y" });
      mkdirSync(join(d, "cle"));
      configurerAuditDuCore("main", journalMuet, {
        ELPIS_AUDIT_DIR: d,
        ELPIS_AUDIT_KEY_PATH: join(d, "cle"),
      });
      expect(lignesJournal.join("\n")).toContain("[audit] configuration impossible");
    } finally {
      oublierConfigurationAudit();
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("bus d'événements : flux sur main et admin, canal interne dans main seul, empreinte au démarrage ; journal du process dans l'historique, logs diffusés dans le journal commun", async () => {
    const racine = mkdtempSync(join(tmpdir(), "elpis-composition-bus-"));
    const cycle = new CycleDeVie(journalMuet);
    try {
      const admin = await composer("admin", t.base, journalMuet, dep, racine);
      const main = await composer("main", t.base, journalMuet, dep, racine, { cycle });
      const appAdmin = await appTest({ ...admin, mode: "admin" });
      const appMain = await appTest(main);
      expect(routesDe(appMain, "evenements")).toEqual([
        "GET /api/system-events session",
        "GET /api/internal/events interne",
        "POST /api/internal/events interne",
        "GET /api/internal/status interne",
      ]);
      expect(routesDe(appAdmin, "evenements")).toEqual(["GET /api/system-events session"]);
      expect([main.evenements.mode, main.evenements.versMain, admin.evenements.mode]).toEqual([
        "main",
        undefined,
        "admin",
      ]);
      expect([admin.evenements.versMain?.url, admin.evenements.abonnement?.connecte]).toEqual([
        urlMainInterne(),
        false,
      ]);
      await cycle.demarrer("main");
      const statut = await appMain.inject({
        method: "GET",
        url: "/api/internal/status",
        headers: { authorization: `Bearer ${jetonInterne("secret-de-test")}` },
      });
      expect(statut.json()).toMatchObject({ mode: "main", pid: process.pid, pending: expect.any(Array) });

      journalMuet.child({ domaine: "essai" }).warn("ligne témoin");
      expect(main.evenements.systemEvents.getRecentLogs().at(-1)).toEqual({
        id: expect.any(Number),
        message: expect.stringMatching(/^\d\d:\d\d:\d\d - WARNING - \[essai\] ligne témoin$/),
        level: "WARNING",
      });
      main.evenements.systemEvents.broadcast({ type: "log", message: "[LLM] essai", level: "info" });
      const derniere = readFileSync(cheminJournalCommun(racine), "utf8").trimEnd().split("\n").at(-1);
      expect(JSON.parse(derniere ?? "null")).toMatchObject({
        service: serviceDuProcess("main"),
        level: "INFO",
        category: "app",
        message: "[LLM] essai",
        logger: "system_events",
      });
      await cycle.executerArrets();
      await appMain.close();
      await appAdmin.close();
    } finally {
      rmSync(racine, { recursive: true, force: true });
    }
  });

  it("journal du process configuré : ligne de démarrage, écrivain partagé avec le bus, une ligne d'accès par requête", async () => {
    const racine = mkdtempSync(join(tmpdir(), "elpis-composition-acces-"));
    const cycle = new CycleDeVie(journalMuet);
    try {
      configurerJournalProcess("main", cheminJournalCommun(racine));
      const main = await composer("main", t.base, journalMuet, dep, racine, { cycle });
      const appMain = await appTest(main);
      await appMain.inject({ method: "GET", url: "/api/inexistant?jeton=secret" });
      await appMain.inject({ method: "GET", url: "/api/health" });
      main.evenements.systemEvents.broadcast({ type: "log", message: "[LLM] essai", level: "info" });
      const lignes = readFileSync(cheminJournalCommun(racine), "utf8")
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lignes[0]).toMatchObject({ category: "system", logger: "access_logging" });
      expect(lignes.filter((l) => l["logger"] === "http")).toEqual([
        expect.objectContaining({
          level: "WARNING",
          category: "http",
          message: expect.stringMatching(/^GET \/api\/inexistant → 404 \(\d+ms\) uid=- ip=127\.0\.0\.1$/u),
        }),
      ]);
      expect(lignes.at(-1)).toMatchObject({ message: "[LLM] essai", logger: "system_events" });
      await cycle.executerArrets();
      await appMain.close();
    } finally {
      oublierJournalProcess();
      rmSync(racine, { recursive: true, force: true });
    }
  });

  it("relais dans main seulement : préfixes relayés montés, jeton d'aperçu servi sans hôte d'outils, terminaux relayés fermés à la révocation", async () => {
    const vide = mkdtempSync(join(tmpdir(), "elpis-composition-relais-"));
    const manifesteAvant = process.env["APP_MCP_MANIFEST"];
    process.env["APP_MCP_MANIFEST"] = join(vide, "absent.json");
    try {
      const main = await composer("main", t.base, journalMuet, dep, vide);
      const admin = await composer("admin", t.base, journalMuet, dep, vide);
      const appMain = await appTest(main);
      const appAdmin = await appTest({ ...admin, mode: "admin" });
      const relayes = [...RELAY_PREFIXES, ...PREVIEW_PREFIXES].map((p) => `${p}*`);
      const montes = appMain.elpis.routes.filter((r) => r.famille === "relais");
      expect([...new Set(montes.map((r) => r.chemin))].sort()).toEqual([...relayes].sort());
      expect(routesDe(appMain, "jeton-apercu")).toEqual([
        "GET /api/sandbox/preview-token session",
        "HEAD,POST,PUT,PATCH,DELETE,OPTIONS /api/sandbox/preview-token public",
      ]);
      expect(
        appAdmin.elpis.routes.filter(
          (r) => r.chemin.startsWith("/api/sandbox/") || relayes.includes(r.chemin),
        ),
      ).toEqual([]);

      const cookie = `mcpwebui_session=${signerSession({ user_id: 1, _login_ts: T - 10 }, "secret-de-test", T)}`;
      const jeton = await appMain.inject({
        method: "GET",
        url: "/api/sandbox/preview-token",
        headers: { cookie },
      });
      expect([jeton.statusCode, jeton.headers["cache-control"]]).toEqual([
        200,
        "no-cache, no-store, must-revalidate",
      ]);
      expect(jeton.json()).toEqual({
        token: expect.stringMatching(/^1-\d+-[0-9a-f]{32}$/),
        expires: expect.any(Number),
      });
      const relaye = await appMain.inject({ method: "GET", url: "/api/sandbox/me", headers: { cookie } });
      expect([relaye.statusCode, relaye.json()]).toEqual([503, { detail: AUCUN_HOTE }]);
      const dansAdmin = await appAdmin.inject({
        method: "GET",
        url: "/api/sandbox/preview-token",
        headers: { cookie },
      });
      expect(dansAdmin.statusCode).toBe(404);

      expect(await main.evenements.revoquer(1)).toEqual({ uid: 1, systeme: 0, pipeline: 0, terminaux: 0 });
      expect(await main.evenements.revoquer(null)).toEqual({
        uid: null,
        systeme: 0,
        pipeline: 0,
        terminaux: -1,
      });
      await appMain.close();
      await appAdmin.close();
    } finally {
      if (manifesteAvant === undefined) delete process.env["APP_MCP_MANIFEST"];
      else process.env["APP_MCP_MANIFEST"] = manifesteAvant;
      rmSync(vide, { recursive: true, force: true });
    }
  });

  it("login (main et admin) : session d'historique ouverte sur l'hôte du compte avant la réponse ; login réussi même si l'hôte la refuse", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-composition-historique-"));
    const hote = await new FauxToolhost().demarrer();
    const manifesteAvant = process.env["APP_MCP_MANIFEST"];
    process.env["APP_MCP_MANIFEST"] = join(dossier, "mcp.json");
    writeFileSync(
      join(dossier, "mcp.json"),
      JSON.stringify({ mcpServers: {}, sandboxHosts: { main: { url: hote.url, token: JETON } } }),
    );
    oublierHotes();
    remplacerBase(t.base);
    await createUser(t.base, "zoe", "mdp-de-zoe", { maintenant: T });
    let statut = 200;
    hote.traitements.set("/internal/file-history/session", (_req, res, vue) => {
      setTimeout(() => {
        res.writeHead(statut, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, id: `h-${vue.identite?.username}` }));
      }, 150);
    });
    const login = (app: FastifyInstance) =>
      app.inject({
        method: "POST",
        url: "/api/login-lite",
        payload: { username: "zoe", password: "mdp-de-zoe" },
      });
    try {
      for (const mode of ["main", "admin"] as const) {
        const c = await composer(mode, t.base, journalMuet, dep, dossier);
        const app = await appTest({ ...c, mode });
        const avant = hote.requetes.length;
        const debut = performance.now();
        expect((await login(app)).statusCode, mode).toBe(200);
        expect(performance.now() - debut, mode).toBeGreaterThanOrEqual(140);
        expect(
          hote.requetes.slice(avant).map((v) => [v.methode, v.url, v.identite?.username]),
          mode,
        ).toEqual([["POST", "/internal/file-history/session", "zoe"]]);
        statut = 404;
        expect((await login(app)).statusCode, mode).toBe(200);
        expect(hote.requetes.length - avant, mode).toBe(2);
        statut = 200;
        await app.close();
      }
    } finally {
      remplacerBase(undefined);
      if (manifesteAvant === undefined) delete process.env["APP_MCP_MANIFEST"];
      else process.env["APP_MCP_MANIFEST"] = manifesteAvant;
      oublierHotes();
      await hote.arreter();
      rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("voix, RAG intégré et bureau dans main seulement ; publics : archive, installeurs et vision des scripts", async () => {
    for (const mode of ["main", "admin"] as const) {
      const c = await composer(mode, t.base, journalMuet, dep);
      const app = await appTest({ ...c, mode });
      expect([...routesDe(app, "voix"), ...routesDe(app, "rag"), ...routesDe(app, "bureau")], mode).toEqual(
        mode === "main"
          ? [
              "GET /api/voice/status session",
              "POST /api/voice/transcribe session",
              "POST /api/voice/speak session",
              "GET /api/rag/etat session",
              "GET /api/rag/collections session",
              "POST /api/rag/collections session",
              "GET /api/rag/collections/:collection_id session",
              "PATCH /api/rag/collections/:collection_id session",
              "DELETE /api/rag/collections/:collection_id session",
              "PUT /api/rag/collections/:collection_id/publication session",
              "GET /api/rag/groupes-publication session",
              "PUT /api/rag/collections/:collection_id/masquage session",
              "GET /api/rag/collections/:collection_id/documents session",
              "POST /api/rag/collections/:collection_id/documents session",
              "GET /api/rag/collections/:collection_id/documents/:doc_id session",
              "POST /api/rag/collections/:collection_id/import-sandbox session",
              "DELETE /api/rag/collections/:collection_id/documents/:doc_id session",
              "POST /api/rag/collections/:collection_id/vider session",
              "POST /api/rag/collections/:collection_id/reindexer session",
              "GET /api/rag/travaux session",
              "POST /api/rag/travaux/:job_id/suspendre session",
              "POST /api/rag/travaux/:job_id/reprendre session",
              "POST /api/rag/travaux/:job_id/annuler session",
              "POST /api/rag/collections/:collection_id/recherche session",
              "GET /api/rag/collections/:collection_id/documents/:doc_id/passages session",
              "GET /api/rag/collections/:collection_id/documents/:doc_id/pages/:n session",
              "POST /api/rag/collections/:collection_id/documents/:doc_id/localiser session",
              "GET /api/rag/collections/:collection_id/documents/:doc_id/original session",
              "GET /api/rag/collections/:collection_id/documents/:doc_id/decoupage session",
              "PUT /api/rag/collections/:collection_id/documents/:doc_id/decoupage session",
              "POST /api/rag/collections/:collection_id/documents/:doc_id/apercu-decoupage session",
              "GET /api/rag/collections/:collection_id/documents/:doc_id/passages/liste session",
              "PUT /api/saved/chats/:chat_id/rag session",
              "GET /api/desktop/targets session",
              "GET /api/desktop/active-target session",
              "POST /api/desktop/active-target session",
              "GET /api/desktop/monitors session",
              "POST /api/desktop/select-monitor session",
              "POST /api/desktop/capture session",
              "POST /api/desktop/read session",
              "POST /api/desktop/act session",
              "POST /api/desktop/launch session",
              "POST /api/desktop/wait-window session",
              "GET /api/desktop/agent-bundle public",
              "POST /api/desktop/run-automation session",
              "GET /api/desktop/run-automation/status session",
              "POST /api/desktop/run-automation/stop session",
              "GET /api/desktop/run-file session",
              "POST /api/desktop/run-automation-matrix session",
              "POST /api/desktop/locate public",
              "POST /api/desktop/automation-bundle session",
              "GET /api/desktop/install.sh public",
              "GET /api/desktop/install.ps1 public",
              "GET /agent public",
              "GET /agent.ps1 public",
            ]
          : [],
      );
      await app.close();
    }
  });

  it("page Code et CLI dans main seulement ; le flux de la page Code écoute le bus du process, fermé à la révocation", async () => {
    const dossier = mkdtempSync(join(tmpdir(), "elpis-composition-code-"));
    writeFileSync(join(dossier, "config.json"), "{}");
    const restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    try {
      for (const mode of ["main", "admin"] as const) {
        const c = await composer(mode, t.base, journalMuet, dep);
        const app = await appTest({ ...c, mode });
        expect([routesDe(app, "code").length, routesDe(app, "cli").length], mode).toEqual(
          mode === "main" ? [33, 8] : [0, 0],
        );
        await app.close();
      }
      const c = await composer("main", t.base, journalMuet, dep);
      const app = await appTest(c);
      await app.listen({ port: 0, host: "127.0.0.1" });
      const { port } = app.server.address() as { port: number };
      const cookie = `mcpwebui_session=${signerSession({ user_id: 1, _login_ts: T - 10 }, "secret-de-test", T)}`;
      const flux = await fetch(`http://127.0.0.1:${port}/api/code/stream`, { headers: { cookie } });
      expect(flux.status).toBe(200);
      for (let i = 0; i < 100 && c.evenements.pipelineEvents.snapshotQueues(1).length === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      const [jeton] = await creerJeton(dep, 1, "opencode", "cli");
      const bye = await app.inject({
        method: "POST",
        url: "/api/code/bye",
        headers: { "x-elpis-token": jeton },
        payload: { client: "c1" },
      });
      expect(bye.json()).toEqual({ ok: true });
      expect(await c.evenements.revoquer(1)).toEqual({ uid: 1, systeme: 0, pipeline: 1, terminaux: 0 });
      const texte = await flux.text();
      expect(texte).toContain(
        'data: {"type": "client.disconnected", "properties": {"client": "c1"}}\r\n\r\n',
      );
      expect(texte.endsWith('data: {"__control": {"type": "session_expired"}}\r\n\r\n')).toBe(true);
      await app.close();
    } finally {
      restaurer();
      invalidateConfigCache();
      rmSync(dossier, { recursive: true, force: true });
    }
  });
});

describe("nettoyage des navigateurs des sous-agents au démarrage", () => {
  it("branché par défaut en main seul, coupé par BROWSER_CHILD_CLEANUP=0 (les tests ne touchent jamais un service réel)", () => {
    const appels: { nom: string; options: unknown }[] = [];
    const cycle = {
      auDemarrage: (nom: string, _f: unknown, options: unknown) => appels.push({ nom, options }),
    } as unknown as CycleDeVie;
    brancherNettoyageNavigateursEnfants(cycle, journalMuet, {});
    expect(appels).toEqual([
      {
        nom: "sessions de navigateur des sous-agents du process précédent",
        options: { modes: ["main"], arrierePlan: true },
      },
    ]);
    for (const v of ["0", "false", "no", ""])
      brancherNettoyageNavigateursEnfants(cycle, journalMuet, { BROWSER_CHILD_CLEANUP: v });
    expect(appels).toHaveLength(1);
    expect(process.env["BROWSER_CHILD_CLEANUP"]).toBe("0");
  });
});
