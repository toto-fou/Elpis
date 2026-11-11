// SPDX-License-Identifier: MIT
/** apps/core/test/observabilite/journaux.test.ts — journal commun (write_event, log_event, relecture) et lignes d'accès HTTP rejoués contre le Python (vecteurs) ; descripteur gardé, rotation d'un autre process, copie des journaux du process. */
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { analyserMandataires, Session } from "@elpis/auth";
import { ErreurPython, HttpError, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { lireEvenementsRecents } from "../../src/admin/journaux";
import { ecrivainJournalCommun, ligneJournal } from "../../src/evenements/journal-commun";
import type { LigneJournal } from "../../src/evenements/systeme";
import { journal } from "../../src/journal";
import {
  brancherHistoriqueJournal,
  configurerJournalProcess,
  ecrivainDuProcess,
  journalAcces,
  logEvent,
  oublierJournalProcess,
  reprErreur,
} from "../../src/observabilite/journal-acces";
import type { DefinitionRoute } from "../../src/routes";
import { appTest } from "../aides";

type Kw = Record<string, unknown>;

const TEXTE = readFileSync(new URL("../vecteurs/observabilite-journaux.json", import.meta.url), "utf8");
const { entrees: E } = pyJsonLoads(TEXTE) as {
  entrees: {
    evenements: [string, unknown, string, string, Kw | null, boolean][];
    explicites: [string, string, string, boolean, Kw][];
    requetes: [string, string, string, Record<string, string>][];
    lectures: [number, string[] | null, string[] | null, string[] | null, number | null][];
  };
};
const { sorties: S } = JSON.parse(TEXTE) as {
  sorties: {
    evenements: string[];
    requetes: { statut: number; lignes: string[] }[];
    fichiers: { courant: string; tourne: string };
    lectures: string[];
  };
};

const dossiers: string[] = [];

function dossier(): string {
  const d = mkdtempSync(path.join(tmpdir(), "elpis-journaux-"));
  dossiers.push(d);
  return d;
}

function horloge(t: number): void {
  vi.setSystemTime(Math.round(t * 1000));
}

/** Le pid et la durée d'une requête ne se rejouent pas : ramenés aux valeurs du vecteur. */
function normaliser(ligne: string): string {
  const rec = pyJsonLoads(ligne) as Kw;
  rec["pid"] = 4242;
  if (typeof rec["message"] === "string") rec["message"] = rec["message"].replace(/\(\d+ms\)/u, "(0ms)");
  const extras = rec["extras"] as Kw | undefined;
  if (extras && "duration_ms" in extras) extras["duration_ms"] = 0;
  return pyJsonDumps(rec, { ensureAscii: false });
}

afterEach(() => {
  vi.useRealTimers();
  oublierJournalProcess();
});

afterAll(() => {
  for (const d of dossiers.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("journal commun rejoué contre le Python", () => {
  it("write_event puis log_event : lignes identiques hors pid ; ligne de démarrage du service", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const chemin = path.join(dossier(), "user_db", "logs", "app.log.jsonl");
    horloge(1_799_999_999);
    const ecrire = configurerJournalProcess("main", chemin);
    expect(configurerJournalProcess("main", chemin)).toBe(ecrire);
    let t = 1_800_000_000;
    for (const [niveau, categorie, message, logger, extras, live] of E.evenements) {
      horloge(t);
      ecrire({ level: niveau, category: categorie, message, logger, extras, live });
      t += 0.25;
    }
    horloge(t);
    for (const [categorie, niveau, message, live, extras] of E.explicites)
      logEvent(categorie, niveau, message, { live, extras });
    const lignes = readFileSync(chemin, "utf8").split("\n");
    expect(lignes.pop()).toBe("");
    expect(normaliser(lignes.shift() as string)).toBe(
      '{"ts": 1799999999.0, "service": "main", "level": "INFO", "category": "system", ' +
        `"message": "Service 'main' starting (pid=${process.pid})", "logger": "access_logging", "pid": 4242}`,
    );
    expect(lignes.map(normaliser)).toEqual(S.evenements);
  });

  it("read_recent_events (lireEvenementsRecents de la console) relit les lignes écrites : filtres, limite, `.1`", async () => {
    const chemin = path.join(dossier(), "app.log.jsonl");
    writeFileSync(chemin, S.fichiers.courant);
    writeFileSync(`${chemin}.1`, S.fichiers.tourne);
    for (const [i, [limite, services, niveaux, categories, depuis]] of E.lectures.entries()) {
      const obtenu = await lireEvenementsRecents(chemin, {
        limit: limite,
        services,
        levels: niveaux,
        categories,
        sinceTs: depuis,
      });
      expect(pyJsonDumps(obtenu, { ensureAscii: false }), `lecture ${i}`).toBe(S.lectures[i]);
    }
  });
});

class ErreurNommee extends Error {
  constructor(nom: string, message: string) {
    super(message);
    this.name = nom;
  }
}

function routes(service: "main" | "admin"): DefinitionRoute[] {
  const r = (
    methode: "GET" | "POST",
    chemin: string,
    traiter: DefinitionRoute["traiter"],
  ): DefinitionRoute => ({
    methode,
    chemin,
    processus: [service],
    acces: "public",
    traiter,
  });
  return [
    r("GET", "/api/ok", async () => ({ ok: true })),
    ...(service === "admin" ? [r("GET", "/api/admin/stats", async () => ({}))] : []),
    r("GET", "/api/me-lite", async () => ({})),
    r("POST", "/api/login-lite", async (req) => {
      req.session.set("user_id", 7);
      return {};
    }),
    r("POST", "/api/logout-lite", async (req) => {
      req.session.vider();
      return {};
    }),
    r("GET", "/api/boom", async () => {
      throw new ErreurNommee("RuntimeError", "boom");
    }),
    r("GET", "/api/vide", async () => {
      throw new ErreurPython("ValueError", "");
    }),
    r("GET", "/api/interdit", async () => {
      throw new HttpError(403, "Forbidden");
    }),
  ];
}

async function appJournalisee(
  service: "main" | "admin",
  lignes: string[],
  mandataires = "127.0.0.0/8,::1",
): Promise<FastifyInstance> {
  const ecrire = (entree: LigneJournal): void => void lignes.push(ligneJournal(entree, service));
  return appTest({
    mode: service,
    familles: [{ nom: "essai", routes: routes(service) }],
    extensions: [
      journalAcces({ service, mandataires: analyserMandataires(mandataires), ecrire: () => ecrire }),
      (app) => {
        app.decorateRequest("session", null as unknown as Session);
        app.addHook("onRequest", async (requete) => {
          const uid = requete.headers["x-uid"];
          requete.session = new Session(typeof uid === "string" ? { user_id: uid } : {});
        });
      },
    ],
  });
}

describe("lignes d'accès rejouées contre RequestLoggingMiddleware", () => {
  let apps: Partial<Record<"main" | "admin", FastifyInstance>> = {};
  const lignes: string[] = [];

  beforeAll(async () => {
    apps = { main: await appJournalisee("main", lignes), admin: await appJournalisee("admin", lignes) };
  });

  afterAll(async () => {
    for (const app of Object.values(apps)) await app.close();
  });

  it.each(E.requetes.map((r, i) => [`${r[0]} ${r[1]} ${r[2]}`, r, i] as const))(
    "%s",
    async (_n, requete, i) => {
      const [service, methode, url, entetes] = requete;
      const attendu = S.requetes[i] as { statut: number; lignes: string[] };
      lignes.length = 0;
      vi.useFakeTimers({ toFake: ["Date"] });
      horloge(1_800_000_001.25);
      const r = await (apps[service as "main" | "admin"] as FastifyInstance).inject({
        method: methode as "GET",
        url,
        headers: entetes,
      });
      expect(r.statusCode).toBe(attendu.statut);
      expect(lignes.map(normaliser)).toEqual(attendu.lignes);
    },
  );
});

describe("IP de la ligne d'accès", () => {
  it("celle du journal de sécurité : entrée invalide écartée, frontal de confiance lu de droite à gauche", async () => {
    const lignes: string[] = [];
    const app = await appJournalisee("main", lignes, "127.0.0.0/8,::1,10.0.0.2");
    try {
      const ip = async (remoteAddress: string, xff: string): Promise<unknown> => {
        lignes.length = 0;
        await app.inject({
          method: "GET",
          url: "/api/ok",
          remoteAddress,
          headers: { "x-forwarded-for": xff },
        });
        return (JSON.parse(lignes[0] ?? "{}") as { extras?: { ip?: unknown } }).extras?.ip;
      };
      expect(await ip("127.0.0.1", "pas-une-ip")).toBe("127.0.0.1");
      expect(await ip("10.0.0.2", "6.6.6.6, 10.0.0.50")).toBe("10.0.0.50");
    } finally {
      await app.close();
    }
  });
});

describe("descripteur gardé et copie des journaux du process", () => {
  const fdsOuverts = (): number => readdirSync("/proc/self/fd").length;

  it("rotation par un autre process : les lignes suivantes vont au nouveau fichier après la revalidation", () => {
    const chemin = path.join(dossier(), "logs", "app.log.jsonl");
    const ecrire = ecrivainJournalCommun(chemin, "main");
    const ligne = (message: string): LigneJournal => ({
      level: "INFO",
      category: "app",
      message,
      logger: "l",
    });
    ecrire(ligne("avant"));
    renameSync(chemin, `${chemin}.1`);
    for (let i = 2; i <= 256; i++) ecrire(ligne(`n${i}`));
    expect(readFileSync(chemin, "utf8")).toBe("");
    ecrire(ligne("après"));
    expect(readFileSync(`${chemin}.1`, "utf8").split("\n")).toHaveLength(257);
    expect(readFileSync(chemin, "utf8")).toContain('"message": "après"');
    ecrire.fermer();
  });

  it("dossier supprimé en vie : recréé à la réouverture ; fermer() rend le descripteur", () => {
    const racine = dossier();
    const chemin = path.join(racine, "logs", "app.log.jsonl");
    const avant = fdsOuverts();
    const ecrire = ecrivainJournalCommun(chemin, "admin");
    ecrire({ level: "INFO", category: "app", message: "un", logger: "l" });
    expect(fdsOuverts()).toBe(avant + 1);
    rmSync(path.join(racine, "logs"), { recursive: true, force: true });
    for (let i = 0; i < 256; i++) ecrire({ level: "INFO", category: "app", message: `n${i}`, logger: "l" });
    ecrire({ level: "INFO", category: "app", message: "revenu", logger: "l" });
    expect(readFileSync(chemin, "utf8")).toContain('"message": "revenu"');
    ecrire.fermer();
    expect(fdsOuverts()).toBe(avant);
    ecrire({ level: "INFO", category: "app", message: "après la fermeture", logger: "l" });
    expect(fdsOuverts()).toBe(avant);
    expect(readFileSync(chemin, "utf8")).not.toContain("après la fermeture");
  });

  it("FileEventHandler : chaque ligne du journal du process, ERROR/CRITICAL en `system`, l'historique du bus aussi", () => {
    const chemin = path.join(dossier(), "app.log.jsonl");
    configurerJournalProcess("admin", chemin);
    const historique: string[] = [];
    brancherHistoriqueJournal((niveau, message) => void historique.push(`${niveau} ${message}`));
    journal("metrics").warn("avertissement");
    journal("metrics").error("panne");
    journal("metrics").debug("détail");
    const recs = readFileSync(chemin, "utf8")
      .trim()
      .split("\n")
      .map((l) => pyJsonLoads(l, { mode: "natif" }) as Kw);
    expect(recs.map((r) => [r["level"], r["category"], r["message"], r["logger"], r["service"]])).toEqual([
      ["INFO", "system", `Service 'admin' starting (pid=${process.pid})`, "access_logging", "admin"],
      ["WARNING", "app", "[metrics] avertissement", "uvicorn.error", "admin"],
      ["ERROR", "system", "[metrics] panne", "uvicorn.error", "admin"],
    ]);
    expect(historique).toEqual(["WARNING [metrics] avertissement", "ERROR [metrics] panne"]);
    expect(ecrivainDuProcess(chemin)).not.toBeNull();
    expect(ecrivainDuProcess(path.join(chemin, "autre"))).toBeNull();
  });

  it("jeton d'aperçu masqué au fichier commun comme à l'historique du bus, reste du chemin gardé", () => {
    const chemin = path.join(dossier(), "app.log.jsonl");
    configurerJournalProcess("main", chemin);
    const historique: string[] = [];
    brancherHistoriqueJournal((niveau, message) => void historique.push(`${niveau} ${message}`));
    journal("relais").warn(
      "hôte h1 injoignable (http://h1:8090/api/sandbox/pvs/2-1792783291-abcdef/8080/a.js)",
    );
    logEvent("http", "INFO", "GET /api/sandbox/pv/7-1792783291-0123/index.html → 200", {
      extras: { path: "/api/sandbox/pv/7-1792783291-0123/x", imbrique: { url: "/api/sandbox/pvs/9-1-f/1/" } },
    });
    logEvent("http", "INFO", "GET /api/sandbox/files/list → 200");
    const texte = readFileSync(chemin, "utf8");
    expect(texte).not.toMatch(/2-1792783291-abcdef|7-1792783291-0123|9-1-f/u);
    const recs = texte
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => pyJsonLoads(l, { mode: "natif" }) as Kw);
    expect(recs.map((r) => [r["message"], r["extras"]])).toEqual([
      ["[relais] hôte h1 injoignable (http://h1:8090/api/sandbox/pvs/<jeton>/8080/a.js)", undefined],
      [
        "GET /api/sandbox/pv/<jeton>/index.html → 200",
        { path: "/api/sandbox/pv/<jeton>/x", imbrique: { url: "/api/sandbox/pvs/<jeton>/1/" } },
      ],
      ["GET /api/sandbox/files/list → 200", undefined],
    ]);
    expect(historique).toEqual([
      "WARNING [relais] hôte h1 injoignable (http://h1:8090/api/sandbox/pvs/<jeton>/8080/a.js)",
    ]);
  });

  it("repr(exc) et extras non sérialisables", () => {
    expect(reprErreur(new ErreurPython("ValueError", "x'y"))).toBe(`ValueError("x'y")`);
    expect(reprErreur(new TypeError(""))).toBe("TypeError()");
    expect(reprErreur("texte")).toBe("'texte'");
    const ligne = ligneJournal(
      { level: "INFO", category: "app", message: "m", logger: "l", extras: { f: () => 1, ok: 1 } },
      "main",
    );
    expect(pyJsonLoads(ligne, { mode: "natif" })).toMatchObject({ extras: { f: "() => 1", ok: 1 } });
  });
});
