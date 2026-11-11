// SPDX-License-Identifier: MIT
/** apps/core/test/admin-vue.test.ts — vue d'ensemble, journaux récents et terminaux rejoués contre admin/overview.py, logs.py et system.py (vecteurs). */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { createUser, ligneUtilisateur } from "@elpis/auth";
import { ErreurPython, HttpError, pyJsonDumps } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Valeur } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  alertesPourModerateur,
  collecter,
  court,
  faitsParDefaut,
  formatOctets,
  garde,
  portJoignable,
  svc,
} from "../src/admin/vue";
import type { Faits, Sondes } from "../src/admin/vue";
import { creerFamilleAdminVue } from "../src/familles/admin-vue";
import { appTest, journalMuet } from "./aides";

type Valeurs = Dict | Dict[];

interface Scenario {
  sondes: Record<keyof Sondes, Valeurs>;
  faits: { kpis: Dict; sauvegarde: Dict; securite: Dict; attente: string[] };
}

interface EtapeRoute {
  compte?: string;
  u?: string;
  avancer?: number;
  journal?: unknown[];
  fichier?: string;
}

const V = JSON.parse(readFileSync(new URL("./vecteurs/admin-vue.json", import.meta.url), "utf-8")) as {
  t0: number;
  comptes: [string, number][];
  scenarios: Scenario[];
  courts: string[];
  octets: number[];
  courts_sortie: string[];
  octets_sortie: string[];
  etapes_faits: { sql?: [string, Valeur[]]; config?: unknown; faits?: boolean }[];
  etapes_routes: EtapeRoute[];
  ids: Record<string, number>;
  collectes: string[];
  faits: (Record<string, string | { erreur: string }> | null)[];
  routes: ({ statut: number; corps: string; cache: string | null; sondes: number } | null)[];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

function sondesDe(sc: Scenario, compteur?: { n: number }): Sondes {
  const sonde = (cle: keyof Sondes) => async (): Promise<Valeurs> => {
    if (cle === "llm" && compteur) compteur.n += 1;
    const v = sc.sondes[cle];
    if (!Array.isArray(v) && Object.hasOwn(v, "leve")) throw new Error(String(v["leve"]));
    return JSON.parse(JSON.stringify(v)) as Valeurs;
  };
  return {
    llm: sonde("llm"),
    connecteurs: sonde("connecteurs"),
    compression: sonde("compression"),
    rag: sonde("rag"),
    vision: sonde("vision"),
    voix: sonde("voix"),
    images: sonde("images"),
    mcp: sonde("mcp"),
    bac: sonde("bac"),
    base: sonde("base"),
  };
}

function faitsDe(sc: Scenario): Faits {
  return {
    kpis: async () => ({ ...sc.faits.kpis }),
    sauvegarde: async () => ({ ...sc.faits.sauvegarde }),
    securite: async () => ({ ...sc.faits.securite }),
    enAttente: async () => [...sc.faits.attente],
  };
}

describe("vue d'ensemble : aides et assemblage", () => {
  it("adresses courtes et tailles comme `_short` et `_fmt_bytes` (vecteurs)", () => {
    expect(V.courts.map((u) => court(u))).toEqual(V.courts_sortie);
    expect(V.octets.map((n) => formatOctets(n))).toEqual(V.octets_sortie);
  });

  it("assemble alertes, services hérités et installation comme `_collect` (vecteurs)", async () => {
    for (const [i, sc] of V.scenarios.entries()) {
      const vue = await collecter(sondesDe(sc), faitsDe(sc), journalMuet, () => V.t0);
      expect(pyJsonDumps(vue, { ensureAscii: false }), `scénario ${i}`).toBe(V.collectes[i]);
    }
  });

  it("alertes du journal : toutes mènent à Système › Journalisation ; un modérateur n'en voit que le titre", async () => {
    const sc = V.scenarios[0] as Scenario;
    const alertesJournal = [
      { id: "audit-write", level: "danger", title: "Écritures en échec", detail: "x" },
      { id: "audit-disk", level: "danger", title: "Disque", detail: "y" },
      { id: "audit-hold", level: "info", title: "Gel", detail: "z" },
    ];
    const vue = await collecter(
      sondesDe(sc),
      { ...faitsDe(sc), journalSecurite: async () => alertesJournal },
      journalMuet,
      () => V.t0,
    );
    const cibles = Object.fromEntries(
      (vue["alerts"] as Dict[]).filter((a) => String(a["id"]).startsWith("audit-")).map((a) => [a["id"], a]),
    );
    expect(cibles["audit-write"]).toMatchObject({ page: "audit-logging", action: "page", level: "danger" });
    expect(cibles["audit-disk"]).toMatchObject({ page: "audit-logging", action: "page" });
    expect(cibles["audit-hold"]).toMatchObject({ page: "audit-logging", level: "info" });
    const modo = alertesPourModerateur(vue["alerts"] as Dict[]).filter((a) =>
      String(a["id"]).startsWith("audit-"),
    );
    expect(modo.map((a) => [a["title"], a["detail"], a["action"]])).toEqual([
      ["Écritures en échec", "", ""],
      ["Disque", "", ""],
      ["Gel", "", ""],
    ]);
    const autre = alertesPourModerateur([{ id: "https", title: "t", detail: "d", action: "page" }]);
    expect(autre).toEqual([{ id: "https", title: "t", detail: "d", action: "" }]);
  });

  it("une sonde trop lente rend sa ligne de repli « Sonde sans réponse »", async () => {
    const lente = (): Promise<Dict> => new Promise((r) => setTimeout(() => r(svc("x", "x", "", "ok")), 200));
    expect(await garde(lente, svc("rag", "RAG", "", "unknown", "", "rag"), journalMuet, 0.05)).toEqual(
      svc("rag", "RAG", "", "unknown", "Sonde sans réponse", "rag"),
    );
  });

  it("port joignable : vrai sur un port en écoute, faux sur un port fermé", async () => {
    const serveur = createServer((so) => so.end());
    await new Promise<void>((r) => serveur.listen(0, "127.0.0.1", r));
    const { port } = serveur.address() as AddressInfo;
    try {
      expect(await portJoignable(`http://127.0.0.1:${port}/v1`)).toBe(true);
      expect(await portJoignable(`127.0.0.1:${port}`)).toBe(true);
      expect(await portJoignable("http://127.0.0.1:1/")).toBe(false);
      expect(await portJoignable("http://[::1/")).toBe(false);
    } finally {
      serveur.close();
    }
  });
});

describe.each(MOTEURS)("vue d'ensemble : faits relus et routes (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let dossier: string;
  let restaurer: () => void;
  let horloge = V.t0;
  const compteur = { n: 0 };
  let alertesJournal: { id: string; level: string; title: string; detail: string }[] = [];

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    for (const [nom, admin] of V.comptes)
      await createUser(t.base, nom, `mdp-${nom}`, { isAdmin: admin, maintenant: V.t0 });
    dossier = mkdtempSync(join(tmpdir(), "elpis-admin-vue-"));
    restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(dossier, "config.json") });
    invalidateConfigCache();
    const sc = V.scenarios[1] as Scenario;
    const role = async (req: FastifyRequest, roles: number[], message: string): Promise<void> => {
      const uid = req.headers["x-uid"];
      if (!uid) throw new HttpError(401, "not logged in");
      const ligne = await ligneUtilisateur(t.base, Number(uid));
      req.utilisateur = { id: Number(uid), username: ligne ? String(ligne.username) : null };
      if (!ligne || !roles.includes(Number(ligne.is_admin))) throw new HttpError(403, message);
    };
    app = await appTest({
      mode: "admin",
      familles: [
        creerFamilleAdminVue({
          base: t.base,
          journal: journalMuet,
          racine: dossier,
          sondes: sondesDe(sc, compteur),
          faits: { ...faitsDe(sc), journalSecurite: async () => alertesJournal },
          cheminsRedemarrage: () => ["llama.port", "z.a"],
          journalRecent: () => [
            { id: 1.0, message: "12:00:00 - INFO - m", level: "INFO" },
            { id: 2.5, message: "x", level: "WARNING" },
          ],
          maintenant: () => horloge,
        }),
      ],
      gardes: {
        admin: (req) => role(req, [1], "Admin required"),
        staff: (req) => role(req, [1, 2], "Staff required"),
      },
    });
  });

  afterAll(async () => {
    try {
      await app?.close();
    } finally {
      restaurer?.();
      invalidateConfigCache();
      await t?.fermer();
      if (dossier) rmSync(dossier, { recursive: true, force: true });
    }
  });

  it("chiffres de 24 h, dernière sauvegarde et faits de sécurité relus en base et dans config.json (vecteurs)", async () => {
    const faits = faitsParDefaut({
      base: t.base,
      journal: journalMuet,
      maintenant: () => V.t0,
      enAttente: async () => [],
    });
    for (const [i, e] of V.etapes_faits.entries()) {
      if (e.sql) await t.base.run(e.sql[0], e.sql[1]);
      else if (e.config !== undefined) {
        writeFileSync(join(dossier, "config.json"), JSON.stringify(e.config));
        invalidateConfigCache();
      } else {
        const obtenu: Record<string, string | { erreur: string }> = {};
        for (const [cle, f] of [
          ["kpis", faits.kpis],
          ["sauvegarde", faits.sauvegarde],
          ["securite", faits.securite],
        ] as const) {
          try {
            obtenu[cle] = pyJsonDumps(await f(), { ensureAscii: false });
          } catch (x) {
            if (!(x instanceof ErreurPython)) throw x;
            obtenu[cle] = { erreur: x.type };
          }
        }
        expect(obtenu, `étape ${i}`).toEqual(V.faits[i]);
      }
    }
  });

  it("rejoue les routes : rôles, cache partagé de 15 s, rafraîchissement admin, journaux filtrés, terminaux (vecteurs)", async () => {
    const journal = join(dossier, "user_db", "logs", "app.log.jsonl");
    for (const [i, e] of V.etapes_routes.entries()) {
      if (e.avancer !== undefined) {
        horloge += e.avancer;
        continue;
      }
      if (e.journal) {
        mkdirSync(dirname(journal), { recursive: true });
        writeFileSync(`${journal}${e.fichier ?? ""}`, e.journal.map((x) => `${String(x)}\n`).join(""));
        continue;
      }
      const avant = compteur.n;
      const r = await app.inject({
        method: "GET",
        url: e.u ?? "",
        headers: e.compte ? { "x-uid": String(V.ids[e.compte]) } : {},
      });
      const cache = r.headers["cache-control"];
      expect(
        {
          statut: r.statusCode,
          corps: r.body.replace(`"worker_pid":${process.pid}`, '"worker_pid":0'),
          cache: cache === undefined ? null : String(cache),
          sondes: compteur.n - avant,
        },
        `étape ${i} : ${JSON.stringify(e)}`,
      ).toEqual(V.routes[i]);
    }
  });

  it("alertes du journal sur GET /api/admin/overview : détail présent pour un admin, vide pour un modérateur", async () => {
    horloge += 1000;
    alertesJournal = [
      { id: "audit-hold", level: "info", title: "Gel actif", detail: "Enquête n° 12 · /var/lib/x" },
    ];
    try {
      const alertes = async (uid: number): Promise<Dict[]> => {
        const r = await app.inject({
          method: "GET",
          url: "/api/admin/overview",
          headers: { "x-uid": String(uid) },
        });
        expect(r.statusCode).toBe(200);
        return (r.json() as { alerts: Dict[] }).alerts.filter((a) => a["id"] === "audit-hold");
      };
      const admin = await alertes(V.ids["alice"] as number);
      expect(admin).toHaveLength(1);
      expect(admin[0]).toMatchObject({
        detail: "Enquête n° 12 · /var/lib/x",
        action: "page",
        page: "audit-logging",
      });
      horloge += 1000;
      const modo = await alertes(V.ids["carol"] as number);
      expect(modo).toHaveLength(1);
      expect(modo[0]).toMatchObject({ title: "Gel actif", detail: "", action: "" });
    } finally {
      alertesJournal = [];
      horloge += 1000;
    }
  });
});
