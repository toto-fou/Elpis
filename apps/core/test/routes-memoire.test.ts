// SPDX-License-Identifier: MIT
/** apps/core/test/routes-memoire.test.ts — routes de la mémoire et de la mémoire AX rejouées contre les routeurs Python (vecteurs) sur SQLite et PostgreSQL, fonctions AX, gardes et écarts assumés. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { getUsernameById } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { pyJsonDumps, stMtimePy } from "@elpis/commun";
import { invalidateConfigCache, reinitialiserCaches, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base, Valeur } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { upsertChat } from "../src/chats/stockage";
import { composer } from "../src/composition";
import { creerFamilleAx } from "../src/familles/ax";
import { creerFamilleMemoire } from "../src/familles/memoire";
import {
  getSiteStats,
  getTreeJson,
  listSitesWithStats,
  normalizeUrl,
  renderFullDomForPrompt,
  renderSelector,
} from "@elpis/navigateur";
import {
  comptesMemoire,
  indexSessions,
  installerComptesMemoire,
  installerIndexSessions,
  memoryJournal,
} from "../src/memoire";
import { sessionIndexMessage } from "../src/memoire/sessions";
import { partiesRelatives, rglobTrie } from "../src/skills/chemins";
import { appTest, journalMuet } from "./aides";

type Contenu = string | { lien: string };
/** [compte, méthode, chemin, corps, statut TS si écart, statut PostgreSQL si la réponse est propre à SQLite]. */
type Etape = [string, string, string, unknown, (number | null)?, number?];

const V = JSON.parse(readFileSync(new URL("./vecteurs/routes-memoire.json", import.meta.url), "utf-8")) as {
  comptes: [string, number][];
  config: Record<string, unknown>;
  chats: [string, string, string][];
  fichiers: Record<string, Contenu>;
  ax: Record<string, Record<string, unknown>[]>;
  etapes: Etape[];
  configs: Record<string, unknown>[];
  urls: string[];
  selecteurs: [string, string, number, number][];
  ids: Record<string, number>;
  reponses: { statut: number; corps: string }[];
  fonctions: {
    normalize: [string, string][][];
    selecteurs: string[];
    mtimes: [string, number][];
    rendus: [string, number, string, string][];
    arbres: [string, string][];
    stats: [string, string, string][];
    listes: [string, string][];
  };
  fichiers_finaux: [string, string][];
};

const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);
const T0 = 1_800_000_000;
const SECRETS = (V.ax["ax_credentials"] ?? []).map((c) => String(c["password"]));

function sansDates(corps: string): string {
  return corps.replace(/"last_modified":-?[0-9][0-9.eE+-]*/g, '"last_modified":"<mtime>"');
}

/** Écarts voulus aux vecteurs Python, dont toutes les lignes d'identifiants sont d'anciennes clés sans origine : champ `cred_origin` nul, aucun indice au modèle (jamais remplies). */
const sansOrigineNulle = (json: string): string => json.replace(/"cred_origin": ?null, ?/g, "");
const sansIndice = (rendu: string): string => rendu.replace(/^CREDENTIALS KNOWN: .*\n/gm, "");
/** Écart voulu (coffre « Secrets ») : les identifiants d'un site viennent du coffre du compte qui consulte, plus d'`ax_credentials` ; ces vecteurs n'ont aucun secret. */
const sansIdentifiantsAx = (json: string): string =>
  json
    .replace(/"has_credentials": ?true/gu, (m) => m.replace("true", "false"))
    .replace(/"cred_username": ?"(?:[^"\\]|\\.)*"/gu, (m) => m.replace(/"(?:[^"\\]|\\.)*"$/u, "null"))
    .replace(/"cred_use_count": ?\d+/gu, (m) => m.replace(/\d+$/u, "0"))
    .replace(/"cred_last_ok": ?-?\d[\d.eE+-]*/gu, (m) => m.replace(/-?\d[\d.eE+-]*$/u, "null"));

function ecrireFichiers(racine: string, fichiers: Readonly<Record<string, Contenu>>): void {
  for (const [rel, contenu] of Object.entries(fichiers)) {
    const p = join(racine, rel);
    mkdirSync(dirname(p), { recursive: true });
    if (contenu === "<dir>") mkdirSync(p, { recursive: true });
    else if (typeof contenu === "object") symlinkSync(contenu.lien, p);
    else writeFileSync(p, contenu, "utf8");
  }
}

async function arbreFinal(racine: string): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for (const p of await rglobTrie(racine, () => true)) {
    const rel = (partiesRelatives(p, racine) ?? []).join("/");
    const s = await lstat(p);
    if (s.isSymbolicLink()) out.push([rel, `lien:${await readlink(p)}`]);
    else if (s.isDirectory()) out.push([rel, "<dir>"]);
    else out.push([rel, await readFile(p, "utf8")]);
  }
  return out;
}

/** Comptes, chats et mémoire AX des vecteurs, aux mêmes ids que le Python. */
async function peupler(base: Base): Promise<void> {
  for (const [nom, admin] of V.comptes)
    await base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES(?,?,?,?,?)",
      [nom, "s", "h", 0, admin],
    );
  for (const [nom, id, titre] of V.chats) await upsertChat(base, V.ids[nom] ?? 0, id, titre, [], 1.0);
  for (const [table, lignes] of Object.entries(V.ax))
    for (const ligne of lignes) {
      const cols = Object.keys(ligne);
      await base.run(
        `INSERT INTO ${table}(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")})`,
        cols.map((k) => ligne[k] as Valeur),
      );
    }
}

function appMemoire(base: Base): Promise<FastifyInstance> {
  return appTest({
    familles: [creerFamilleMemoire({ base }), creerFamilleAx({ base })],
    gardes: {
      session: async (req) => {
        const id = Number(req.headers["x-uid"]);
        req.utilisateur = { id, username: await getUsernameById(base, id) };
      },
    },
  });
}

describe("mémoire AX : fonctions pures (vecteurs)", () => {
  it("`st_mtime` de CPython depuis les nanosecondes, avant 1970 compris", () => {
    for (const [ns, attendu] of V.fonctions.mtimes) expect(stMtimePy(BigInt(ns)), ns).toBe(attendu);
  });

  it("sélecteurs rendus pour le modèle : taux, stratégies, blancs", () => {
    V.selecteurs.forEach(([strategy, value, success_count, failure_count], i) => {
      expect(renderSelector({ strategy, value, success_count, failure_count })).toBe(
        V.fonctions.selecteurs[i],
      );
    });
  });

  it("URL normalisées selon la config (alias de port, IP privées, toute IPv4, config invalide)", () => {
    const d = mkdtempSync(join(tmpdir(), "elpis-ax-url-"));
    const restaurer = surchargerConfig({ CONFIG_JSON_PATH: join(d, "config.json") });
    try {
      V.configs.forEach((cfg, i) => {
        writeFileSync(join(d, "config.json"), JSON.stringify(cfg));
        invalidateConfigCache();
        V.urls.forEach((u, j) => {
          expect(normalizeUrl(u), `${JSON.stringify(cfg)} ${u}`).toEqual(V.fonctions.normalize[i]?.[j]);
        });
      });
    } finally {
      restaurer();
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe.each(MOTEURS)("routes de la mémoire et de la mémoire AX (%s)", (moteur) => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let racine: string;
  let restaurer: () => void;
  let remettreJournal: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    await peupler(t.base);
    racine = mkdtempSync(join(tmpdir(), "elpis-memoire-routes-"));
    ecrireFichiers(join(racine, "memoire"), V.fichiers);
    writeFileSync(join(racine, "config.json"), JSON.stringify(V.config));
    restaurer = surchargerConfig({
      MEMORY_DIR: join(racine, "memoire"),
      CONFIG_JSON_PATH: join(racine, "config.json"),
      MEMORY_MD_CHAR_LIMIT: 2200,
      USER_MD_CHAR_LIMIT: 1375,
    });
    reinitialiserCaches();
    let n = 0xa1;
    remettreJournal = memoryJournal.reglerJournalPourTests({
      jeton: () => (n++).toString(16).padStart(8, "0"),
    });
    app = await appMemoire(t.base);
  });

  afterAll(async () => {
    vi.useRealTimers();
    remettreJournal();
    restaurer();
    reinitialiserCaches();
    await app.close();
    await t.fermer();
    rmSync(racine, { recursive: true, force: true });
  });

  it("fonctions AX sur la base des vecteurs : arbres, rendus tronqués, statistiques par propriétaire", async () => {
    const b = t.base;
    for (const [s, m, o, attendu] of V.fonctions.rendus)
      expect(await renderFullDomForPrompt(b, s, m, o), `${s} ${m} ${o}`).toBe(sansIndice(attendu));
    for (const [s, attendu] of V.fonctions.arbres)
      expect(pyJsonDumps(await getTreeJson(b, s), { ensureAscii: false }), s).toBe(attendu);
    for (const [s, o, attendu] of V.fonctions.stats)
      expect(
        sansOrigineNulle(pyJsonDumps(await getSiteStats(b, s), { ensureAscii: false })),
        `${s} ${o}`,
      ).toBe(sansIdentifiantsAx(attendu));
    for (const [o, attendu] of V.fonctions.listes)
      expect(sansOrigineNulle(pyJsonDumps(await listSitesWithStats(b), { ensureAscii: false })), o).toBe(
        sansIdentifiantsAx(attendu),
      );
  });

  it("rejoue les étapes et rend les mêmes réponses, au texte près (vecteurs)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    for (const [i, [nom, methode, chemin, corps, statutTs, statutPg]] of V.etapes.entries()) {
      vi.setSystemTime((T0 + 10 * i) * 1000);
      const entetes: Record<string, string> = { "x-uid": String(V.ids[nom]) };
      let payload: Buffer | undefined;
      if (typeof corps === "string" && corps.startsWith("<<"))
        payload = Buffer.from(corps.slice(2, -2), "utf8");
      else if (corps !== null) payload = Buffer.from(JSON.stringify(corps), "utf8");
      if (payload !== undefined) entetes["content-type"] = "application/json";
      const r = await app.inject({
        method: methode as "GET",
        url: chemin,
        headers: entetes,
        ...(payload ? { payload } : {}),
      });
      const attendu = V.reponses[i];
      if (statutTs !== undefined && statutTs !== null) {
        expect(r.statusCode, `étape ${i} (écart E19) : ${methode} ${chemin}`).toBe(statutTs);
        continue;
      }
      if (moteur === "postgres" && statutPg !== undefined) {
        expect(r.statusCode, `étape ${i} (postgres) : ${methode} ${chemin}`).toBe(statutPg);
        continue;
      }
      expect(
        { statut: r.statusCode, corps: sansOrigineNulle(sansDates(r.body.replaceAll(racine, "<R>"))) },
        `étape ${i} : ${methode} ${chemin}`,
      ).toEqual(
        chemin.startsWith("/api/ax/") && attendu
          ? { ...attendu, corps: sansIdentifiantsAx(attendu.corps) }
          : attendu,
      );
      for (const secret of SECRETS) expect(r.body).not.toContain(secret);
    }
    vi.useRealTimers();
  });

  it("dossier mémoire final identique au Python : magasins, journal, audit, liens et migrations", async () => {
    expect(await arbreFinal(join(racine, "memoire"))).toEqual(V.fichiers_finaux);
  });
});

describe("gardes, index des sessions et écarts assumés", () => {
  let t: BaseDeTest;
  let app: FastifyInstance;
  let racine: string;
  let restaurer: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await peupler(t.base);
    racine = mkdtempSync(join(tmpdir(), "elpis-memoire-gardes-"));
    restaurer = surchargerConfig({
      MEMORY_DIR: join(racine, "m"),
      CONFIG_JSON_PATH: join(racine, "absent.json"),
    });
    reinitialiserCaches();
    app = await appMemoire(t.base);
  });

  afterAll(async () => {
    restaurer();
    reinitialiserCaches();
    await app.close();
    await t.fermer();
    rmSync(racine, { recursive: true, force: true });
  });

  it("une session absente refuse avant toute validation (écart E15), un compte disparu donne 500", async () => {
    const anonyme = await appTest({
      familles: [creerFamilleMemoire({ base: t.base }), creerFamilleAx({ base: t.base })],
      gardes: { session: () => undefined },
    });
    try {
      for (const [m, u] of [
        ["GET", "/api/memory/state"],
        ["PUT", "/api/memory/state/inconnu"],
        ["GET", "/api/memory/ops/zz"],
        ["GET", "/api/ax/sites"],
        ["DELETE", "/api/ax/all?confirm=WIPE"],
      ] as const)
        expect((await anonyme.inject({ method: m, url: u })).json()).toEqual({ detail: "not logged in" });
    } finally {
      await anonyme.close();
    }
    const r = await app.inject({ method: "GET", url: "/api/memory/state", headers: { "x-uid": "999" } });
    expect([r.statusCode, r.json()]).toEqual([
      500,
      { detail: "user record missing for authenticated session" },
    ]);
  });

  it("rôle exigé avant la validation du corps : un compte simple reçoit 403 et non 422", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/ax/bulk-delete",
      headers: { "x-uid": String(V.ids["bob"]), "content-type": "application/json" },
      payload: "{",
    });
    expect([r.statusCode, r.json()]).toEqual([403, { detail: "Admin or moderator required" }]);
  });

  it("composer pose les ports de la mémoire au démarrage : id du compte, index des sessions", async () => {
    installerComptesMemoire(null);
    installerIndexSessions(null);
    const audit = mkdtempSync(join(tmpdir(), "elpis-audit-memoire-"));
    const remettre = process.env["ELPIS_AUDIT_DIR"];
    process.env["ELPIS_AUDIT_DIR"] = audit;
    try {
      const dep: DependancesAuth & DependancesJetons = {
        base: t.base,
        config: () => ({}),
        attributsCookie: () => ({ cookie_name: "s", same_site: "lax", https_only: false, max_age: 60 }),
        secret: () => "secret-de-test",
        jetonService: () => "",
      };
      await composer("main", t.base, journalMuet, dep);
      expect(await comptesMemoire().idUtilisateur("bob")).toBe(V.ids["bob"]);
      expect(await comptesMemoire().idUtilisateur("inconnu")).toBeNull();
      await indexSessions().indexerMessage({
        user_id: 4,
        app: "agentic",
        session_id: "s9",
        scope_key: "k",
        role: "assistant",
        content: "via le port",
        ts: 1,
      });
      expect(
        await t.base.get("SELECT app, scope_key FROM session_messages WHERE content = ?", ["via le port"]),
      ).toEqual({ app: "agentic", scope_key: "k" });
    } finally {
      if (remettre === undefined) delete process.env["ELPIS_AUDIT_DIR"];
      else process.env["ELPIS_AUDIT_DIR"] = remettre;
      oublierConfigurationAudit();
      rmSync(audit, { recursive: true, force: true });
    }
  });

  it("index des sessions : contenu nettoyé, défauts de Python, contenu vide ignoré, échec rendu 0", async () => {
    const id = await sessionIndexMessage(t.base, {
      user_id: 3,
      app: "",
      session_id: "s1",
      role: "",
      content: "  bonjour  ",
      ts: 12.5,
    });
    expect(id).toBeGreaterThan(0);
    expect(
      await t.base.get(
        "SELECT user_id, app, session_id, scope_key, role, content, ts FROM session_messages WHERE id = ?",
        [id],
      ),
    ).toEqual({
      user_id: 3,
      app: "chat",
      session_id: "s1",
      scope_key: "",
      role: "user",
      content: "bonjour",
      ts: 12.5,
    });
    expect(await sessionIndexMessage(t.base, { user_id: 3, content: "   " })).toBe(0);
    expect(await sessionIndexMessage(t.base, { user_id: null, content: "x" })).toBe(0);
    const enPanne = { insertId: () => Promise.reject(new Error("base fermée")) } as unknown as Base;
    expect(await sessionIndexMessage(enPanne, { user_id: 1, content: "x" })).toBe(0);
  });
});
