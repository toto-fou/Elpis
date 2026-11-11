// SPDX-License-Identifier: MIT
/** apps/core/test/admin/admin-llm.test.ts — `/api/admin` du moteur LLM rejoué contre le routeur admin Python (vecteurs) sur SQLite et PostgreSQL : connecteurs partagés, liste blanche, capacités, mode d'ordonnancement, trafic ; gardes, verrou de config.json et secrets. */
import "../llm/environnement-fournisseurs";

import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import { config, invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base, Valeur } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerChiffrement, configurerCoffre, oublierConfigurationAudit } from "@elpis/securite";
import { avecVerrou, cheminVerrou } from "@elpis/verrous";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { composer } from "../../src/composition";
import { LLAMA_CAPABILITIES, probeState } from "../../src/llm/capacites";
import { closeLlmClient } from "../../src/llm/client-http";
import { cloudProviderTypes, getSharedSecret } from "../../src/llm/connecteurs";
import { invalidate as oublierCaps } from "../../src/llm/fournisseurs/llama-capacites";
import { closeAdminClient } from "../../src/llm/llama-http";
import { installerOrdonnanceur } from "../../src/llm/ordonnanceur/process";
import { appTest, journalMuet, lignesAuditRecentes, lignesJournal } from "../aides";
import { FauxServeur } from "../llm/faux-serveur";

type Dict = Record<string, unknown>;
/** [compte, méthode, chemin, corps (JSON ou <<texte brut>>), statut TS si écart E19]. */
type Etape = [string, string, string, unknown, number?];

const TEXTE_V = readFileSync(new URL("../vecteurs/admin-llm.json", import.meta.url), "utf-8");
/** Corps des étapes relus sans perte (`2.0` reste un flottant), réécrits comme `json.dumps`. */
const CORPS = (pyJsonLoads(TEXTE_V) as { etapes: Etape[] }).etapes.map((e) => e[3]);
const V = JSON.parse(TEXTE_V) as {
  comptes: [string, number][];
  config_texte: string;
  faux: Record<string, [number, unknown]>;
  appels: Dict[];
  politiques: Dict[];
  etapes: Etape[];
  ids: Record<string, number>;
  reponses: { statut: number; corps: string; entetes: Record<string, string> }[];
  config_finale: string;
  politiques_finales: unknown[][];
  connecteurs: Dict[];
  cles: [number, string, string][];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const T = 1_791_331_200;
const T0 = 1_800_000_000.5;
const SECRET = "secret-de-test";
const CAPS_INITIALES = { ...LLAMA_CAPABILITIES };
const CLES_FACTICES = ["sk-factice-admin", "sk-factice-nouvelle"];
const ROUTES: readonly [string, string, "admin" | "staff"][] = [
  ["GET", "/api/admin/llm/connectors", "admin"],
  ["POST", "/api/admin/llm/connectors", "admin"],
  ["PUT", "/api/admin/llm/connectors/:cid", "admin"],
  ["DELETE", "/api/admin/llm/connectors/:cid", "admin"],
  ["POST", "/api/admin/llm/connectors/:cid/test", "admin"],
  ["GET", "/api/admin/llm/allowed-providers", "admin"],
  ["PUT", "/api/admin/llm/allowed-providers", "admin"],
  ["GET", "/api/admin/llm/engine", "admin"],
  ["POST", "/api/admin/llm/engine/test", "admin"],
  ["GET", "/api/admin/llm-capabilities", "staff"],
  ["POST", "/api/admin/llm-capabilities/probe", "admin"],
  ["POST", "/api/admin/llm-scheduling-mode", "admin"],
  ["GET", "/api/admin/llm-traffic", "admin"],
  ["GET", "/api/admin/llm-traffic/:call_id([0-9]+)", "admin"],
  ["DELETE", "/api/admin/llm-traffic", "admin"],
];

let dossier: string;
const envAvant = {
  ELPIS_AUDIT_DIR: process.env["ELPIS_AUDIT_DIR"],
  ELPIS_ENGINE_ACCESS_DIR: process.env["ELPIS_ENGINE_ACCESS_DIR"],
};

beforeAll(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-admin-llm-"));
  process.env["ELPIS_AUDIT_DIR"] = path.join(dossier, "audit");
  process.env["ELPIS_ENGINE_ACCESS_DIR"] = path.join(dossier, "acces");
  oublierConfigurationAudit();
  configurerChiffrement({ cleEnv: "cle-maitre-des-vecteurs", fichierCle: path.join(dossier, ".k") });
  configurerCoffre({
    cleEnv: randomBytes(32).toString("base64"),
    systeme: path.join(dossier, "absente.key"),
    repli: path.join(dossier, ".vault.key"),
  });
});

afterAll(() => {
  for (const [nom, valeur] of Object.entries(envAvant)) {
    if (valeur === undefined) delete process.env[nom];
    else process.env[nom] = valeur;
  }
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
});

function cookie(uid: number): string {
  return `mcpwebui_session=${signerSession({ user_id: uid, _login_ts: T - 10 }, SECRET, T)}`;
}

/** Capacités de la sonde remises à l'état d'un process qui démarre. */
function capacitesANeuf(): void {
  for (const cle of Object.keys(LLAMA_CAPABILITIES)) Reflect.deleteProperty(LLAMA_CAPABILITIES, cle);
  Object.assign(LLAMA_CAPABILITIES, CAPS_INITIALES);
  probeState.ts = 0;
  probeState.inflight = false;
  oublierCaps();
}

function empreinte(texte: string): string {
  return createHash("sha256").update(texte, "utf8").digest("hex").slice(0, 16);
}

async function peupler(base: Base): Promise<void> {
  for (const [nom, admin] of V.comptes)
    await base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, 's', 'h', 0, ?)",
      [nom, admin],
    );
  for (const [table, lignes] of [
    ["llm_calls", V.appels],
    ["llm_engine_policies", V.politiques],
  ] as const)
    for (const ligne of lignes) {
      const cols = Object.keys(ligne);
      await base.run(
        `INSERT INTO ${table}(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})`,
        cols.map((k) => ligne[k] as Valeur),
      );
    }
}

describe.each(MOTEURS)("famille /api/admin du moteur LLM (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let faux: FauxServeur;
  let configJson: string;
  let restaurer: () => void;

  async function monter(mode: "main" | "admin"): Promise<FastifyInstance> {
    const dep: DependancesAuth & DependancesJetons = {
      base: t.base,
      config: () => ({}),
      attributsCookie: () => ({
        cookie_name: "mcpwebui_session",
        same_site: "lax",
        https_only: false,
        max_age: 86400,
      }),
      secret: () => SECRET,
      jetonService: () => "",
      maintenant: () => T,
    };
    const c = await composer(mode, t.base, journalMuet, dep, dossier);
    return appTest({ ...c, mode });
  }

  function appel(uid: number, method: string, url: string, corps?: unknown): Promise<LightMyRequestResponse> {
    const entetes: Record<string, string> = { cookie: cookie(uid) };
    let payload: Buffer | undefined;
    if (typeof corps === "string" && corps.startsWith("<<"))
      payload = Buffer.from(corps.slice(2, -2), "utf8");
    else if (corps !== undefined && corps !== null)
      payload = Buffer.from(pyJsonDumps(corps, { ensureAscii: false }).replaceAll("{llm}", faux.url), "utf8");
    if (payload !== undefined) entetes["content-type"] = "application/json";
    // Écart voulu : les lectures tracées de la console exigent son en-tête (jamais envoyé par la référence Python).
    if (method === "GET" && url.startsWith("/api/admin/llm-traffic/")) entetes["x-elpis-console"] = "1";
    return app.inject({ method: method as "GET", url, headers: entetes, ...(payload ? { payload } : {}) });
  }

  beforeEach(async () => {
    process.env["ELPIS_AUDIT_DIR"] = path.join(dossier, `audit-${moteur}-${Date.now()}`);
    oublierConfigurationAudit();
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    await peupler(t.base);
    faux = await FauxServeur.demarrer();
    for (const [chemin, [statut, corps]] of Object.entries(V.faux)) faux.json(`GET ${chemin}`, corps, statut);
    configJson = path.join(dossier, `config-${moteur}.json`);
    writeFileSync(configJson, V.config_texte, "utf-8");
    restaurer = surchargerConfig({
      LLAMA_URL: `${faux.url}/v1/chat/completions`,
      LLAMA_PROVIDER_TYPE: "llamacpp",
      LLM_SCHEDULING_MODE: "auto",
      LLM_DEBUG_ENABLED: true,
      LLM_DEBUG_MAX_ENTRIES: 500,
      CONFIG_JSON_PATH: configJson,
    });
    invalidateConfigCache();
    capacitesANeuf();
    installerOrdonnanceur(null);
    app = await monter("admin");
  });

  afterEach(async () => {
    vi.useRealTimers();
    await app.close();
    restaurer();
    capacitesANeuf();
    installerOrdonnanceur(null);
    await closeLlmClient();
    await closeAdminClient();
    await faux.arreter();
    await t.fermer();
  });

  it("inventaire : 13 routes du process admin (et la sonde du moteur, propre au TS), gardes du Python (admin, staff pour les capacités), rien dans main ; anonyme = 401", async () => {
    const inventaire = JSON.parse(
      readFileSync(new URL("../../../../migration-kit/routes.inventory.json", import.meta.url), "utf-8"),
    ) as { routes: { methodes: string[]; chemin: string; process: string[]; module: string }[] };
    const modules = [
      "shared_infra/routes/admin/llm_connectors.py",
      "shared_infra/routes/admin/llm.py",
      "shared_infra/routes/admin/llm_traffic.py",
    ];
    const attendues = inventaire.routes.filter((r) => modules.includes(r.module));
    expect(attendues).toHaveLength(13);
    const montees = app.elpis.routes.filter((r) => r.famille === "admin-llm");
    expect(montees.map((r) => [r.methodes[0], r.chemin, r.acces])).toEqual(ROUTES);
    for (const r of attendues) {
      const chemin = r.chemin.replace("{cid}", ":cid").replace("{call_id:int}", ":call_id([0-9]+)");
      expect(
        montees.some((m) => m.chemin === chemin && m.methodes[0] === r.methodes[0]),
        `${r.methodes[0]} ${r.chemin}`,
      ).toBe(true);
      expect(r.process).toEqual(["admin"]);
    }
    for (const [methode, chemin] of ROUTES) {
      const url = chemin.replace(":cid", "abc").replace(":call_id([0-9]+)", "1");
      const r = await app.inject({
        method: methode as "GET",
        url,
        ...(methode === "GET" ? {} : { payload: {} }),
      });
      expect([r.statusCode, r.json()], `${methode} ${url}`).toEqual([401, { detail: "not logged in" }]);
    }
    const main = await monter("main");
    expect(main.elpis.routes.filter((r) => r.famille === "admin-llm")).toEqual([]);
    await main.close();
  });

  /** Écart voulu (0.1.0) : liste blanche absente ou vide = aucun type cloud ouvert aux comptes non admin (le Python les ouvrait tous). */
  /** Écart voulu (coffre) : une clé enregistrée est dans le coffre (`key_scheme` `vault`) et chaque vue dit `key_error`. */
  function ecartCoffre<R>(reponse: R): R {
    const r = reponse as { corps?: unknown };
    return typeof r.corps === "string"
      ? ({
          ...r,
          corps: r.corps
            .replaceAll('"key_scheme":"fernet"', '"key_scheme":"vault"')
            .replace(/"has_key":(true|false),/gu, '"has_key":$1,"key_error":null,'),
        } as R)
      : reponse;
  }

  function ecartCloudFerme<R>(reponse: R): R {
    const tous = `"allowed":${JSON.stringify(cloudProviderTypes())},`;
    const r = reponse as { corps?: unknown };
    return typeof r.corps === "string" && r.corps.startsWith(`{${tous}`)
      ? ({ ...r, corps: r.corps.replace(tous, '"allowed":[],') } as R)
      : reponse;
  }

  it("rejoue les étapes et rend les mêmes réponses, au texte près (vecteurs)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [i, [nom, methode, chemin, , statutTs]] of V.etapes.entries()) {
      vi.setSystemTime(Math.round((T0 + 10 * i) * 1000));
      const r = await appel(V.ids[nom] ?? 0, methode, chemin, CORPS[i]);
      if (statutTs !== undefined && statutTs !== null) {
        expect(r.statusCode, `étape ${i} (écart E19) : ${methode} ${chemin}`).toBe(statutTs);
        continue;
      }
      const entetes: Record<string, string> = {};
      const cc = r.headers["cache-control"];
      if (typeof cc === "string") entetes["cache-control"] = cc;
      expect(
        { statut: r.statusCode, corps: r.body.replaceAll(faux.url, "{llm}"), entetes },
        `étape ${i} : ${methode} ${chemin}`,
      ).toEqual(ecartCoffre(ecartCloudFerme(V.reponses[i])));
      for (const cle of CLES_FACTICES) expect(r.body).not.toContain(cle);
    }
    const audit = lignesAuditRecentes({ limit: 200, actionPrefix: "llm." }).map((l) => pyJsonDumps(l));
    vi.useRealTimers();
    expect(readFileSync(configJson, "utf-8")).toBe(V.config_finale);
    const lignes = await t.base.all(
      "SELECT id, scope, owner_user_id, provider_type, wire, label, base_url, key_scheme, default_model, models_json, " +
        "enabled, context_window, max_models, max_concurrency, created_at, updated_at FROM llm_connectors ORDER BY id",
    );
    const coffre = (sch: unknown): unknown => (sch === "fernet" ? "vault" : sch);
    expect(
      lignes.map((l) => ({ ...l, base_url: String(l["base_url"]).replaceAll(faux.url, "{llm}") })),
    ).toEqual(V.connecteurs.map((c) => ({ ...c, key_scheme: coffre(c["key_scheme"]) })));
    const cles = await t.base.valeurs<[number, string, string]>(
      "SELECT id, api_key_enc, key_scheme FROM llm_connectors ORDER BY id",
    );
    const claires = await Promise.all(
      cles.map(async ([id, , sch]) => [
        id,
        sch,
        empreinte(String((await getSharedSecret(t.base, id))?.["api_key"])),
      ]),
    );
    expect(cles.every(([, enc]) => enc === "")).toBe(true);
    expect(claires).toEqual(V.cles.map(([id, sch, h]) => [id, coffre(sch), h]));
    expect(audit).toHaveLength(9);
    expect(
      audit.some((l) => l.includes("llm.connector.delete") && l.includes('"access_lists_purged": 2')),
    ).toBe(true);
    expect(
      await t.base.valeurs(
        "SELECT principal_type, principal_id, engine_keys, can_manage_models, updated_at FROM llm_engine_policies " +
          "ORDER BY principal_type, principal_id",
      ),
    ).toEqual(V.politiques_finales);
    for (const cle of CLES_FACTICES) expect(audit.join("\n")).not.toContain(cle);
  });

  it("liste blanche : une section `llm` qui n'est pas un objet = 500, config.json intact ; l'écriture attend le verrou de config.json", async () => {
    writeFileSync(configJson, '{"llm": [1]}');
    invalidateConfigCache();
    const r = await appel(1, "PUT", "/api/admin/llm/allowed-providers", { allowed: ["openai"] });
    expect(r.statusCode).toBe(500);
    expect(readFileSync(configJson, "utf-8")).toBe('{"llm": [1]}');
    writeFileSync(configJson, "{}");
    invalidateConfigCache();
    let libere = false;
    const tenu = avecVerrou(cheminVerrou(config.CONFIG_JSON_PATH), {}, async () => {
      await new Promise((ok) => setTimeout(ok, 300));
      libere = true;
    });
    await new Promise((ok) => setTimeout(ok, 50));
    const ecrit = await appel(1, "PUT", "/api/admin/llm/allowed-providers", { allowed: ["groq"] });
    expect([ecrit.statusCode, libere]).toEqual([200, true]);
    await tenu;
    expect(JSON.parse(readFileSync(configJson, "utf-8"))).toEqual({
      llm: { allowed_provider_types: ["groq"] },
    });
  });

  it("mode d'ordonnancement : config.json impossible à écrire = avertissement, réglage appliqué au process quand même", async () => {
    restaurer();
    restaurer = surchargerConfig({
      LLM_SCHEDULING_MODE: "auto",
      CONFIG_JSON_PATH: path.join(configJson, "sous-un-fichier", "config.json"),
    });
    lignesJournal.length = 0;
    const r = await appel(1, "POST", "/api/admin/llm-scheduling-mode", { mode: "classic" });
    expect([r.statusCode, r.json()]).toEqual([
      200,
      { configured_mode: "classic", effective_mode: "classic" },
    ]);
    expect(config.LLM_SCHEDULING_MODE).toBe("classic");
    expect(lignesJournal.some((l) => l.includes("[admin] persist scheduling_mode échoué"))).toBe(true);
  });
});
