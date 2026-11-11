// SPDX-License-Identifier: MIT
/** apps/core/test/code/routes-code.test.ts — famille `/api/code` rejouée contre la vraie app FastAPI (réponses, bus, tables), inventaire et gardes, flux SSE, long-poll ; SQLite et PostgreSQL. */
import { createHash } from "node:crypto";
import { connect } from "node:net";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { creerGardes, creerJeton, installerAuth, signerSession } from "@elpis/auth";
import type { DependancesAuth, DependancesJetons } from "@elpis/auth";
import { pyJsonDumps, pyJsonLoads, reprFlottant } from "@elpis/commun";
import { configView, invalidateConfigCache, surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { oublierConfigurationAudit } from "@elpis/securite";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { PipelineEvents } from "../../src/evenements";
import type { Message } from "../../src/evenements/systeme";
import { creerFamilleCode, rendreEvenementCode } from "../../src/familles/code";
import type { Aleatoire, BusCode } from "../../src/familles/code";
import { appTest } from "../aides";

type Dict = Record<string, unknown>;
type Etape = {
  t?: unknown;
  u?: string;
  m?: string;
  p?: string;
  c?: unknown;
  h?: Record<string, string>;
  hote?: string;
  capture?: string | Record<string, string>;
  config?: unknown;
};
type Reponse = {
  statut?: number;
  corps?: string | { sha256: string; taille: number };
  type?: string;
  bus?: [number, string | null][];
  config?: boolean;
  allow?: string | null;
  longueur?: string | null;
};

const V = pyJsonLoads(readFileSync(new URL("../vecteurs/code-page.json", import.meta.url), "utf-8")) as {
  T0: unknown;
  comptes: [string, number][];
  etapes: Etape[];
  ids: Record<string, number>;
  valeurs: Record<string, string>;
  reponses: Reponse[];
  tables: Record<string, unknown[][]>;
  fonctions: { rendus: { entree: Dict; valeur?: unknown; erreur?: string }[]; rendu_nan: { valeur: string } };
};
const T0 = Number(V.T0);
const T = 1_791_331_200;
const SECRET = "secret-de-test-code";
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

let dossier: string;
const auditAvant = process.env["ELPIS_AUDIT_DIR"];

beforeAll(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-code-"));
  process.env["ELPIS_AUDIT_DIR"] = path.join(dossier, "audit");
  oublierConfigurationAudit();
});

afterAll(() => {
  if (auditAvant === undefined) delete process.env["ELPIS_AUDIT_DIR"];
  else process.env["ELPIS_AUDIT_DIR"] = auditAvant;
  oublierConfigurationAudit();
  rmSync(dossier, { recursive: true, force: true });
});

/** Mêmes tirages que les `secrets` simulés du générateur Python (un compteur par taille). */
function aleatoireDeTest(): Aleatoire {
  const compteurs = new Map<number, number>();
  let tirages = 0;
  return {
    jeton: (n) => {
      const k = (compteurs.get(n) ?? 0) + 1;
      compteurs.set(n, k);
      const longueur = Math.ceil((4 * n) / 3);
      return (`j${n}-${k}-` + "A".repeat(longueur)).slice(0, longueur);
    },
    choix: (alphabet) => {
      tirages += 1;
      return alphabet.charAt((7 * tirages + 3) % alphabet.length);
    },
  };
}

class BusEnregistreur implements BusCode {
  readonly publies: [number, Message][] = [];
  private readonly vrai = new PipelineEvents({ attenteMs: 50 });

  broadcastToUser(userId: number, message: Message): void {
    this.publies.push([userId, message]);
    this.vrai.broadcastToUser(userId, message);
  }

  listen(userId: number, options?: Parameters<PipelineEvents["listen"]>[1]) {
    return this.vrai.listen(userId, options);
  }
}

interface Montage {
  t: BaseDeTest;
  app: FastAPI;
  bus: BusEnregistreur;
  horloge: { t: number };
  restaurer: () => void;
  config: string;
  auth: DependancesAuth & DependancesJetons;
}
type FastAPI = FastifyInstance;

async function monter(
  moteur: "sqlite" | "postgres",
  arret?: AbortSignal,
  limiteCorps?: number,
): Promise<Montage> {
  const t = ouvrirBaseDeTest(moteur);
  await initialiserBase(t.base);
  for (const [nom, admin] of V.comptes)
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES (?, 's', 'h', 0, ?)",
      [nom, admin],
    );
  const config = path.join(dossier, `config-${moteur}-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(config, "{}");
  const restaurer = surchargerConfig({ CONFIG_JSON_PATH: config });
  const auth: DependancesAuth & DependancesJetons = {
    base: t.base,
    config: () => configView(),
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
  const horloge = { t: T0 };
  const bus = new BusEnregistreur();
  const famille = creerFamilleCode({
    base: t.base,
    auth,
    bus,
    maintenant: () => horloge.t,
    aleatoire: aleatoireDeTest(),
    arret,
  });
  const app = await appTest({
    familles: [famille],
    gardes: creerGardes(auth),
    extensions: [(a) => installerAuth(a, auth)],
    ...(limiteCorps === undefined ? {} : { limiteCorps }),
  });
  return { t, app, bus, horloge, restaurer, config, auth };
}

function cookie(uid: number): string {
  return `mcpwebui_session=${signerSession({ user_id: uid, _login_ts: T - 10 }, SECRET, T)}`;
}

function typeSansCharset(type: string | undefined): string | undefined {
  return type === "application/json; charset=utf-8" ? "application/json" : type;
}

/** Étapes où le banc Python (routeur seul) répond 500 sur un OverflowError que le filet global de `create_app()` rend en 400. */
const FILET_GLOBAL = new Set([164, 179]);
const HORS_BORNES = '{"detail":"Paramètre hors bornes."}';

describe("rendu du flux (_render_code_event) rejoué", () => {
  it.each(V.fonctions.rendus.map((c, i) => [i, c] as const))("rendu %i", (_i, c) => {
    expect(rendreEvenementCode(c.entree as Message)).toBe(c.valeur ?? null);
  });

  it("type non hachable : TypeError natif, le bus saute le message et le flux continue (`_frame`)", async () => {
    expect(() => rendreEvenementCode({ type: ["x"] })).toThrow(TypeError);
    const bus = new PipelineEvents({ attenteMs: 20 });
    const fin = new AbortController();
    const flux = bus.listen(1, { render: rendreEvenementCode, signal: fin.signal });
    const premier = flux.next();
    bus.broadcastToUser(1, { type: { a: 1 } });
    bus.broadcastToUser(1, { type: "code.event", data: { type: "ok" } });
    expect((await premier).value).toBe('{"type": "ok"}');
    expect(bus.stats().errors).toBe(1);
    fin.abort();
    await flux.return(undefined);
  });

  it("NaN rendu comme json.dumps (allow_nan)", () => {
    expect(rendreEvenementCode({ type: "code.event", data: { v: NaN } })).toBe(V.fonctions.rendu_nan.valeur);
  });
});

describe("différentiel contre la vraie app FastAPI (SQLite)", () => {
  let m: Montage;

  beforeEach(async () => {
    m = await monter("sqlite");
  });

  afterEach(async () => {
    await m.app.close();
    m.restaurer();
    await m.t.fermer();
  });

  it("202 étapes : statut, corps, type, bus, puis tables code_*", async () => {
    const ts = new Map<string, string>();
    const remplacer = (texte: string): string => {
      let s = texte;
      for (const nom of [...ts.keys()].sort((a, b) => b.length - a.length))
        s = s.split("$" + nom).join(ts.get(nom) ?? "");
      return s;
    };
    const versPython = (texte: string): string => {
      let s = texte;
      for (const [nom, v] of ts) s = s.split(v).join(V.valeurs[nom] ?? v);
      return s;
    };
    const ecarts: string[] = [];
    for (const [i, e] of V.etapes.entries()) {
      const attendu = V.reponses[i] as Reponse;
      m.horloge.t = T0 + Number(e.t ?? 0);
      if (e.config !== undefined) {
        writeFileSync(m.config, pyJsonDumps(e.config));
        invalidateConfigCache();
        continue;
      }
      const entetes: Record<string, string> = { host: e.hote ?? "lan.test:8000" };
      if (e.u) entetes["cookie"] = cookie(V.ids[e.u] as number);
      for (const [k, v] of Object.entries(e.h ?? {})) entetes[k] = remplacer(v);
      let charge: Buffer | undefined;
      if (e.c !== undefined) {
        const c = e.c;
        charge = Buffer.from(
          typeof c === "string" && c.startsWith("<<")
            ? c.slice(2, -2)
            : remplacer(pyJsonDumps(c, { ensureAscii: false })),
          "utf-8",
        );
        entetes["content-type"] = "application/json";
      }
      const avant = m.bus.publies.length;
      const r = await m.app.inject({
        method: e.m as "GET",
        url: remplacer(e.p ?? ""),
        headers: entetes,
        ...(charge === undefined ? {} : { payload: charge }),
      });
      if (e.capture && r.statusCode === 200) {
        const d = r.json<Dict>();
        const champs = typeof e.capture === "string" ? { [e.capture]: "token" } : e.capture;
        for (const [nom, champ] of Object.entries(champs)) ts.set(nom, String(d[champ]));
      }
      const corps =
        typeof attendu.corps === "object"
          ? { sha256: createHash("sha256").update(r.rawPayload).digest("hex"), taille: r.rawPayload.length }
          : versPython(r.body);
      const bus = m.bus.publies.slice(avant).map(([uid, msg]) => {
        const rendu = rendreEvenementCode(msg);
        return [uid, rendu === null ? null : versPython(rendu)];
      });
      const obtenu = {
        statut: r.statusCode,
        corps,
        type: typeSansCharset(r.headers["content-type"] as string),
        bus,
        ...(e.m === "HEAD"
          ? {
              allow: (r.headers["allow"] as string | undefined) ?? null,
              longueur: (r.headers["content-length"] as string | undefined) ?? null,
            }
          : {}),
      };
      const filet = FILET_GLOBAL.has(i);
      const voulu = {
        statut: filet ? 400 : attendu.statut,
        corps: filet ? HORS_BORNES : attendu.corps,
        type: filet ? "application/json" : attendu.type,
        bus: attendu.bus,
        ...(e.m === "HEAD" ? { allow: attendu.allow, longueur: attendu.longueur } : {}),
      };
      if (pyJsonDumps(obtenu) !== pyJsonDumps(voulu))
        ecarts.push(
          `${i} ${e.m} ${e.p}\n  attendu ${pyJsonDumps(voulu).slice(0, 600)}\n  obtenu  ${pyJsonDumps(obtenu).slice(0, 600)}`,
        );
    }
    expect(ecarts).toEqual([]);
    const reels: Record<string, string[]> = {
      code_sessions: ["updated_at"],
      code_messages: ["created"],
      code_parts: ["ts"],
      code_clients: ["last_seen"],
      code_commands: ["created_at"],
      code_notes: ["created"],
      code_permissions: ["created"],
      code_questions: ["created"],
      code_pairings: ["created_at", "expires_at"],
      code_meta: [],
    };
    const colonnes: Record<string, string[]> = {
      code_sessions: ["user_id", "id", "info", "client_id", "busy", "updated_at", "last_model", "preview"],
      code_messages: ["user_id", "session_id", "id", "info", "created"],
      code_parts: ["user_id", "session_id", "message_id", "id", "part", "ts"],
      code_clients: ["user_id", "client_id", "last_seen", "plugin_version", "directory", "bye"],
      code_commands: ["id", "user_id", "session_id", "kind", "payload", "created_at", "target"],
      code_meta: ["user_id", "key", "value"],
      code_notes: ["user_id", "session_id", "id", "kind", "label", "detail", "created"],
      code_permissions: ["user_id", "session_id", "id", "info", "created"],
      code_questions: ["user_id", "session_id", "id", "info", "created"],
      code_pairings: ["id", "code", "created_at", "expires_at", "confirmed_uid", "token"],
    };
    for (const [table, cols] of Object.entries(colonnes)) {
      const lignes = (
        await m.t.base.valeurs(`SELECT ${cols.map((c) => `"${c}"`).join(", ")} FROM ${table}`)
      ).map((l) =>
        l.map((v, k) => {
          const brut = typeof v === "string" ? versPython(v) : v;
          return reels[table]?.includes(cols[k] ?? "") && brut !== null ? reprFlottant(Number(brut)) : brut;
        }),
      );
      const tries = lignes.map((l) => pyJsonDumps(l)).sort();
      expect(tries, table).toEqual((V.tables[table] ?? []).map((l) => pyJsonDumps(l)).sort());
    }
  }, 60_000);
});

describe.each(MOTEURS)("famille /api/code (%s)", (moteur) => {
  let m: Montage;
  let arret: AbortController;

  beforeEach(async () => {
    arret = new AbortController();
    m = await monter(moteur, arret.signal);
    m.horloge.t = Date.now() / 1000;
  });

  afterEach(async () => {
    arret.abort();
    await m.app.close();
    m.restaurer();
    await m.t.fermer();
  });

  async function jeton(uid: number): Promise<string> {
    const r = await m.app.inject({
      method: "POST",
      url: "/api/code/token",
      headers: { cookie: cookie(uid) },
    });
    return r.json<{ token: string }>().token;
  }

  it("inventaire : 33 routes de main, gardes comme le Python ; désactivée = 404 avant la garde", async () => {
    const inventaire = JSON.parse(
      readFileSync(new URL("../../../../migration-kit/routes.inventory.json", import.meta.url), "utf-8"),
    ) as { routes: { methodes: string[]; chemin: string; process: string[]; publique: boolean | null }[] };
    const attendues = inventaire.routes.filter((r) => r.chemin.startsWith("/api/code/"));
    expect(attendues).toHaveLength(33);
    const montees = m.app.elpis.routes.filter((r) => r.famille === "code");
    expect(montees).toHaveLength(33);
    for (const r of attendues) {
      const chemin = r.chemin.replace(/\{(\w+)\}/g, ":$1");
      const monte = montees.find((x) => x.chemin === chemin && x.methodes.includes(r.methodes[0] as "GET"));
      expect([r.process, monte?.acces], chemin).toEqual([["main"], r.publique ? "public" : "session"]);
    }
    writeFileSync(m.config, JSON.stringify({ features: { opencode: false } }));
    invalidateConfigCache();
    for (const r of attendues) {
      const url = r.chemin.replace(/\{(\w+)\}/g, "x");
      const rep = await m.app.inject({ method: r.methodes[0] as "GET", url });
      expect([rep.statusCode, rep.json()], url).toEqual([
        404,
        { detail: "OpenCode est désactivé par l'administrateur." },
      ]);
    }
  });

  it("long-poll : une commande posée pendant l'attente est rendue sans attendre la fin, l'arrêt rend la main", async () => {
    const tok = await jeton(1);
    const H = { "x-elpis-token": tok };
    await m.app.inject({
      method: "POST",
      url: "/api/code/ingest",
      headers: H,
      payload: {
        client: "c1",
        plugin: 15,
        events: [{ type: "session.created", properties: { info: { id: "s1" } } }],
      },
    });
    const debut = Date.now();
    const tirage = m.app.inject({ method: "GET", url: "/api/code/pull?client=c1&wait=5", headers: H });
    await new Promise((r) => setTimeout(r, 300));
    m.horloge.t = Date.now() / 1000;
    const prompt = await m.app.inject({
      method: "POST",
      url: "/api/code/sessions/s1/prompt",
      headers: { cookie: cookie(1) },
      payload: { text: "vite" },
    });
    expect(prompt.statusCode).toBe(200);
    const r = await tirage;
    expect(r.json<{ commands: Dict[] }>().commands.map((c) => c["text"])).toEqual(["vite"]);
    expect(Date.now() - debut).toBeLessThan(3000);
    const attente = m.app.inject({ method: "GET", url: "/api/code/pull?client=c1&wait=25", headers: H });
    await new Promise((res) => setTimeout(res, 100));
    arret.abort();
    const fin = await attente;
    expect(fin.json<{ commands: unknown[] }>().commands).toEqual([]);
  });

  it("flux SSE : events du compte seulement, enveloppe code.event et contrôle `__control`", async () => {
    const tok = await jeton(1);
    await m.app.listen({ port: 0, host: "127.0.0.1" });
    const adresse = m.app.server.address() as { port: number };
    const controle = new AbortController();
    const reponse = await fetch(`http://127.0.0.1:${adresse.port}/api/code/stream`, {
      headers: { cookie: cookie(1) },
      signal: controle.signal,
    });
    expect(reponse.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    const lecteur = (reponse.body as ReadableStream<Uint8Array>).getReader();
    const recu: string[] = [];
    const lire = (async () => {
      const dec = new TextDecoder();
      for (;;) {
        const { value, done } = await lecteur.read();
        if (done) return;
        recu.push(dec.decode(value));
        if (recu.join("").includes("__control")) return;
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    await m.app.inject({
      method: "POST",
      url: "/api/code/ingest",
      headers: { "x-elpis-token": await jeton(2) },
      payload: { type: "session.created", properties: { info: { id: "autre" } } },
    });
    await m.app.inject({
      method: "POST",
      url: "/api/code/ingest",
      headers: { "x-elpis-token": tok, "content-type": "application/json" },
      payload:
        '{"client": "c1", "events": [{"type": "session.created", "properties": {"info": {"id": "s1", "n": 1.0}}}]}',
    });
    m.bus.broadcastToUser(1, { type: "worker_recycling" });
    await lire;
    controle.abort();
    const texte = recu.join("");
    expect(texte).toContain(
      'data: {"type": "session.created", "properties": {"info": {"id": "s1", "n": 1.0}}}\r\n\r\n',
    );
    expect(texte).toContain('data: {"__control": {"type": "worker_recycling"}}\r\n\r\n');
    expect(texte).not.toContain("autre");
  });

  it("jeton vérifié avant le corps (401, jamais 413) ; 413 une fois authentifié ; corps de pair/start jamais lu", async () => {
    await m.app.close();
    m.restaurer();
    await m.t.fermer();
    m = await monter(moteur, arret.signal, 64);
    const gros = JSON.stringify({ events: [], bourrage: "x".repeat(500) });
    const anonyme = await m.app.inject({
      method: "POST",
      url: "/api/code/ingest",
      headers: { "content-type": "application/json" },
      payload: gros,
    });
    expect([anonyme.statusCode, anonyme.json()]).toEqual([401, { detail: "Token elpis-remote invalide." }]);
    const bye = await m.app.inject({ method: "POST", url: "/api/code/bye", payload: gros });
    expect(bye.statusCode).toBe(401);
    const tok = await jeton(1);
    const authentifie = await m.app.inject({
      method: "POST",
      url: "/api/code/ingest",
      headers: { "x-elpis-token": tok, "content-type": "application/json" },
      payload: gros,
    });
    expect(authentifie.statusCode).toBe(413);
    await m.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (m.app.server.address() as AddressInfo).port;
    const enMorceaux = (chemin: string, entetes: string): Promise<string> =>
      new Promise((fini) => {
        const s = connect(port, "127.0.0.1", () =>
          s.write(
            `POST ${chemin} HTTP/1.1\r\nHost: lan.test\r\ncontent-type: application/json\r\n${entetes}` +
              `Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n` +
              `${Buffer.byteLength(gros).toString(16)}\r\n${gros}\r\n0\r\n\r\n`,
          ),
        );
        let d = "";
        s.on("data", (c: Buffer) => (d += c.toString("utf-8")));
        s.on("end", () => fini(d));
      });
    expect(await enMorceaux("/api/code/pair/start", "")).toMatch(/^HTTP\/1\.1 200 [^]*"code":/u);
    expect(await enMorceaux("/api/code/bye", `x-elpis-token: ${tok}\r\n`)).toMatch(/^HTTP\/1\.1 413 /u);
  });

  it("deux sondages simultanés d'un appairage confirmé : un seul jeton livré", async () => {
    const debut = (await m.app.inject({ method: "POST", url: "/api/code/pair/start" })).json<Dict>();
    const conf = await m.app.inject({
      method: "POST",
      url: "/api/code/pair/confirm",
      headers: { cookie: cookie(1) },
      payload: { code: debut["code"] },
    });
    expect(conf.json()).toEqual({ ok: true });
    const url = `/api/code/pair/poll?id=${String(debut["id"])}`;
    const reponses = await Promise.all([1, 2, 3].map(() => m.app.inject({ method: "GET", url })));
    const statuts = reponses.map((r) => r.statusCode).sort();
    expect(statuts).toEqual([200, 404, 404]);
    const livre = reponses.find((r) => r.statusCode === 200)?.json<Dict>();
    expect(livre?.["status"]).toBe("ok");
    expect(String(livre?.["token"])).toMatch(/^pcr_/);
  });

  it("demandes d'appairage simultanées d'une même adresse : trois au plus (limite atomique)", async () => {
    const reponses = await Promise.all(
      Array.from({ length: 8 }, () => m.app.inject({ method: "POST", url: "/api/code/pair/start" })),
    );
    expect(reponses.map((r) => r.statusCode).sort()).toEqual([200, 200, 200, 429, 429, 429, 429, 429]);
    const n = await m.t.base.get<{ n: unknown }>("SELECT COUNT(*) AS n FROM code_pairings");
    expect(Number(n?.n)).toBe(3);
  });

  it("essais de code simultanés d'un compte : dix échecs comptés, la suite refusée (compteur atomique)", async () => {
    const essai = () =>
      m.app.inject({
        method: "POST",
        url: "/api/code/pair/confirm",
        headers: { cookie: cookie(1) },
        payload: { code: "ZZZ-ZZZ" },
      });
    const reponses = await Promise.all(Array.from({ length: 16 }, essai));
    const statuts = reponses.map((r) => r.statusCode);
    expect(statuts.filter((s) => s === 404)).toHaveLength(10);
    expect(statuts.filter((s) => s === 429)).toHaveLength(6);
    const meta = await m.t.base.get<{ value: string }>(
      `SELECT value FROM code_meta WHERE user_id=1 AND "key"='pair_fail'`,
    );
    expect((JSON.parse(meta?.value ?? "{}") as { n?: number }).n).toBe(10);
    expect((await essai()).statusCode).toBe(429);
  });

  it("jeton d'outils refusé ; en-tête en double : le premier est gardé comme Starlette", async () => {
    const [outils] = await creerJeton(m.auth, 1, "tools", "", ["git"]);
    const refus = await m.app.inject({
      method: "GET",
      url: "/api/code/hello",
      headers: { "x-elpis-token": outils },
    });
    expect(refus.statusCode).toBe(401);
    const tok = await jeton(1);
    await m.app.listen({ port: 0, host: "127.0.0.1" });
    const port = (m.app.server.address() as AddressInfo).port;
    const brut = (premier: string, second: string): Promise<string> =>
      new Promise((fini) => {
        const s = connect(port, "127.0.0.1", () =>
          s.write(
            `GET /api/code/hello HTTP/1.1\r\nHost: lan.test\r\nx-elpis-token: ${premier}\r\n` +
              `x-elpis-token: ${second}\r\nConnection: close\r\n\r\n`,
          ),
        );
        let d = "";
        s.on("data", (c: Buffer) => (d += c.toString("utf-8")));
        s.on("end", () => fini(d));
      });
    expect(await brut(tok, "pcr_faux_faux_faux_faux_faux")).toContain('{"ok":true,"user":"alice"}');
    expect(await brut("pcr_faux_faux_faux_faux_faux", tok)).toContain("HTTP/1.1 401");
  });

  it("jeton : compte supprimé = 401", async () => {
    const tok = await jeton(2);
    expect(
      (
        await m.app.inject({ method: "GET", url: "/api/code/hello", headers: { "x-elpis-token": tok } })
      ).json(),
    ).toEqual({
      ok: true,
      user: "bob",
    });
    await m.t.base.run("DELETE FROM users WHERE id=2");
    const r = await m.app.inject({
      method: "GET",
      url: "/api/code/hello",
      headers: { "x-elpis-token": tok },
    });
    expect([r.statusCode, r.json()]).toEqual([401, { detail: "Token elpis-remote invalide." }]);
  });
});
