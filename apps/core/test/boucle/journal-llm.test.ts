// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/journal-llm.test.ts — journal des appels LLM : lignes `llm_calls` identiques à celles du Python (vecteurs sur une vraie base), anneau borné, capture best-effort. */
import "../moteur-environnement";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { FlottantPy, pyJsonDumps, pyJsonLoads } from "@elpis/commun";
import type { Reglages } from "@elpis/config";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest, PG_DE_TEST } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";

import { remplacerBase } from "../../src/base";
import {
  captureLlmExchange,
  durationMsFromTimings,
  jsonBorne,
  recordLlmCall,
  uidPourNom,
  viderCacheUids,
} from "../../src/boucle/journal-llm";
import type { EchangeLlm } from "../../src/boucle/journal-llm";
import { installerContexteUsage } from "../../src/boucle/ports";
import { longueurPy, prefixePy } from "../../src/python";
import type { Dict } from "../../src/python";
import { lireVecteurs } from "../vecteurs-moteur";

interface Vecteurs {
  comptes: [number, string][];
  reglages: Partial<Reglages>;
  captures: { kwargs_json: string; ctx: number | null; reglages: Partial<Reglages>; lignes: Dict[] }[];
  durees: ({ timings: unknown } & ({ valeur: number | null } | { erreur: string }))[];
}

const V = lireVecteurs<Vecteurs>("boucle-journal");
const MOTEURS = PG_DE_TEST ? (["sqlite", "postgres"] as const) : (["sqlite"] as const);

/** Arguments nommés de `capture_llm_exchange` → champs de `captureLlmExchange`. */
function echange(kwargs: Dict): EchangeLlm {
  const noms: Record<string, keyof EchangeLlm> = {
    req_id: "reqId",
    user_id: "userId",
    chat_id: "chatId",
    model: "model",
    path: "path",
    request_payload: "requestPayload",
    content: "content",
    tool_calls: "toolCalls",
    usage: "usage",
    timings: "timings",
    finish_reason: "finishReason",
    status: "status",
    error: "error",
  };
  const e: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kwargs)) {
    const nom = noms[k];
    if (nom === undefined) throw new Error(`argument inconnu : ${k}`);
    e[nom] = v;
  }
  return e as EchangeLlm;
}

async function lignesApres(base: Base, dernier: number): Promise<Dict[]> {
  const lignes = await base.all<Dict>("SELECT * FROM llm_calls WHERE id > ? ORDER BY id", [dernier]);
  return lignes.map(({ id: _id, ts: _ts, ...reste }) => reste);
}

async function dernierId(base: Base): Promise<number> {
  const r = await base.get<{ n: number }>("SELECT COALESCE(MAX(id), 0) AS n FROM llm_calls");
  return Number(r?.n ?? 0);
}

let ctx: number | null = null;
installerContexteUsage({ utilisateurCourant: () => ctx });

/** Générateur pseudo-aléatoire reproductible (mulberry32). */
function alea(graine: number): () => number {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MORCEAUX = [
  "a",
  "é",
  "😀",
  "\n",
  '"',
  "\\",
  "\u0000",
  "\u001f",
  "\u007f",
  "\u2028",
  "\ud800",
  "\udc00",
  "中",
  " ",
  "<think>",
  "x".repeat(40),
];
const FEUILLES: unknown[] = [
  0,
  -0,
  1,
  -7,
  0.1,
  1e21,
  1e-7,
  2 ** 53 + 2,
  Number.NaN,
  Infinity,
  -Infinity,
  3.5,
  new FlottantPy(1),
  new FlottantPy(2.5),
  true,
  false,
  null,
  12n,
  new Date(0),
  new Map([[1, 2]]),
  new Set([1]),
];
const CLES = ["model", "messages", "é", "😀", "__proto__", "10", "2", "a\nb", "", "content"];

function texteAleatoire(r: () => number): string {
  return Array.from({ length: Math.floor(r() * 7) }, () => MORCEAUX[Math.floor(r() * MORCEAUX.length)]).join(
    "",
  );
}

function valeurAleatoire(r: () => number, profondeur: number, dansConteneur: boolean): unknown {
  const x = r();
  if (profondeur <= 0 || x < 0.4) {
    if (dansConteneur && x < 0.05) return x < 0.025 ? undefined : () => 1;
    return r() < 0.5 ? texteAleatoire(r) : FEUILLES[Math.floor(r() * FEUILLES.length)];
  }
  if (x < 0.7)
    return Array.from({ length: Math.floor(r() * 5) }, () => valeurAleatoire(r, profondeur - 1, true));
  const o: Record<string, unknown> = {};
  for (let i = Math.floor(r() * 5); i > 0; i--)
    Object.defineProperty(o, CLES[Math.floor(r() * CLES.length)] ?? "", {
      value: valeurAleatoire(r, profondeur - 1, true),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  return o;
}

describe("sérialisation bornée du journal (au plus `limite` points de code écrits)", () => {
  it("identique au préfixe de pyJsonDumps complet, à chaque limite (3 000 valeurs aléatoires reproductibles)", () => {
    const r = alea(17);
    let essais = 0;
    for (let n = 0; n < 3000; n++) {
      const v = valeurAleatoire(r, 4, false);
      const complet = pyJsonDumps(v, { ensureAscii: false });
      const total = longueurPy(complet);
      const limites = new Set([0, 1, 2, 3, total - 1, total, total + 1]);
      for (let i = 0; i < 6; i++) limites.add(Math.floor(r() * (total + 2)));
      for (const limite of limites) {
        if (limite < 0) continue;
        expect(jsonBorne(v, limite), `${complet} / ${limite}`).toBe(prefixePy(complet, limite));
        essais += 1;
      }
    }
    expect(essais).toBeGreaterThan(20_000);
  });

  it("s'arrête à la limite : les éléments suivants ne sont jamais convertis, un long texte n'est pas parcouru", () => {
    let appels = 0;
    const lignes = Array.from({ length: 1000 }, (_, i) => ({
      toJSON: () => (appels++, { role: "user", n: i }),
    }));
    expect(jsonBorne({ messages: lignes }, 60)).toBe(
      prefixePy(pyJsonDumps({ messages: lignes }, { ensureAscii: false }), 60),
    );
    appels = 0;
    jsonBorne({ messages: lignes }, 60);
    expect(appels).toBeLessThan(5);
    const long = "é".repeat(2_000_000);
    expect(jsonBorne({ content: long }, 100)).toBe('{"content": "' + "é".repeat(87));
  });

  it("racine non sérialisable et référence circulaire : TypeError comme pyJsonDumps", () => {
    expect(() => jsonBorne(undefined, 10)).toThrow(TypeError);
    const o: Record<string, unknown> = {};
    o["moi"] = o;
    expect(() => jsonBorne(o, 1000)).toThrow(TypeError);
  });
});

describe("durée tirée des timings (vecteurs Python : float(), chaînes, booléens, infini)", () => {
  it("même durée en ms, ou même exception", () => {
    for (const d of V.durees) {
      if ("erreur" in d) {
        expect(() => durationMsFromTimings(d.timings), JSON.stringify(d.timings)).toThrow();
        continue;
      }
      expect(durationMsFromTimings(d.timings), JSON.stringify(d.timings)).toBe(d.valeur);
    }
  });
});

describe("lignes llm_calls écrites par la capture : identiques au Python (SQLite des vecteurs)", () => {
  let t: BaseDeTest;
  let restaurer: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    for (const [id, nom] of V.comptes)
      await t.base.run(
        "INSERT INTO users(id, username, pass_salt, pass_hash, created_at) VALUES(?,?,?,?,?)",
        [id, nom, "s", "h", 0],
      );
    remplacerBase(t.base);
    viderCacheUids();
    restaurer = surchargerConfig(V.reglages);
  });

  afterAll(async () => {
    restaurer();
    remplacerBase(undefined);
    ctx = null;
    await t.fermer();
  });

  it(`${V.captures.length} captures dans l'ordre : compte résolu, JSON borné en points de code, affinités SQLite, cas sautés`, async () => {
    expect(V.captures.length).toBeGreaterThanOrEqual(30);
    for (const c of V.captures) {
      const remettre = surchargerConfig(c.reglages);
      ctx = c.ctx;
      const avant = await dernierId(t.base);
      await captureLlmExchange(echange(pyJsonLoads(c.kwargs_json) as Dict));
      expect(await lignesApres(t.base, avant), c.kwargs_json.slice(0, 120)).toEqual(c.lignes);
      remettre();
    }
  });
});

describe.each(MOTEURS)("anneau llm_calls (%s)", (moteur) => {
  let t: BaseDeTest;

  beforeAll(async () => {
    t = ouvrirBaseDeTest(moteur);
    await initialiserBase(t.base);
    remplacerBase(t.base);
  });

  afterEach(async () => {
    await t.base.run("DELETE FROM llm_calls");
  });

  afterAll(async () => {
    remplacerBase(undefined);
    await t.fermer();
  });

  async function ecrire(n: number, maxEntries: number): Promise<void> {
    for (let i = 0; i < n; i++)
      await recordLlmCall({
        reqId: `r${i}`,
        model: "m",
        path: "tools",
        requestJson: '{"messages":[]}',
        responseJson: "{}",
        maxEntries,
      });
  }

  async function ids(): Promise<number[]> {
    return (await t.base.all<{ id: number }>("SELECT id FROM llm_calls ORDER BY id")).map((r) =>
      Number(r.id),
    );
  }

  it("garde exactement les n plus récents ; rien de supprimé sous le plafond ou pile au plafond ; anneau de 1", async () => {
    await ecrire(25, 10);
    const tous = await ids();
    expect(tous.length).toBe(10);
    expect(tous).toEqual(Array.from({ length: 10 }, (_, i) => (tous[0] ?? 0) + i));
    await t.base.run("DELETE FROM llm_calls");
    await ecrire(4, 10);
    expect((await ids()).length).toBe(4);
    await t.base.run("DELETE FROM llm_calls");
    await ecrire(10, 10);
    expect((await ids()).length).toBe(10);
    await t.base.run("DELETE FROM llm_calls");
    await ecrire(5, 1);
    expect((await ids()).length).toBe(1);
  });

  it.each([[[]], [[3, 4, 5]], [[1, 2]], [[18, 19, 20]], [[2, 5, 8, 11, 14, 17]]])(
    "borne par clé primaire = ancienne purge `NOT IN`, ids à trous %j",
    async (trous) => {
      const crees: number[] = [];
      for (let i = 0; i < 20; i++)
        crees.push(await t.base.insertId("INSERT INTO llm_calls(ts, status) VALUES(0, 'ok')", []));
      for (const p of trous as number[])
        await t.base.run("DELETE FROM llm_calls WHERE id = ?", [crees[p - 1] ?? 0]);
      await recordLlmCall({ reqId: "neuf", maxEntries: 7 });
      const restants = await ids();
      const survivants = crees.filter((_, i) => !(trous as number[]).includes(i + 1));
      expect(restants.length).toBe(7);
      expect(restants.slice(0, 6)).toEqual(survivants.slice(-6));
    },
  );

  it("une ligne lue comme par la console : colonnes, payloads intacts, plus récente d'abord", async () => {
    await recordLlmCall({
      reqId: "a1",
      userId: 7,
      chatId: "c1",
      model: "qwen",
      path: "classic",
      status: "ok",
      finishReason: "stop",
      promptTokens: 100,
      completionTokens: 20,
      durationMs: 450,
      nMessages: 3,
      requestJson: '{"messages":[]}',
      responseJson: '{"content":"hi"}',
    });
    await recordLlmCall({ reqId: "a2", status: "error", error: "e".repeat(1500) });
    const lignes = await t.base.all<Dict>("SELECT * FROM llm_calls ORDER BY id DESC");
    expect(lignes[0]?.["req_id"]).toBe("a2");
    expect(String(lignes[0]?.["error"]).length).toBe(1000);
    expect(lignes[1]).toMatchObject({
      req_id: "a1",
      user_id: 7,
      chat_id: "c1",
      model: "qwen",
      path: "classic",
      status: "ok",
      finish_reason: "stop",
      prompt_tokens: 100,
      completion_tokens: 20,
      duration_ms: 450,
      n_messages: 3,
      n_tool_calls: null,
      request_json: '{"messages":[]}',
      response_json: '{"content":"hi"}',
      error: null,
    });
  });
});

describe("capture best-effort (tests pytest)", () => {
  let t: BaseDeTest;
  let restaurer: () => void;

  beforeAll(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    remplacerBase(t.base);
    viderCacheUids();
    restaurer = surchargerConfig({ LLM_DEBUG_ENABLED: true });
  });

  afterAll(async () => {
    restaurer();
    remplacerBase(undefined);
    await t.fermer();
  });

  it("la requête est gardée entière, la réponse sans raisonnement, la durée vient des timings", async () => {
    await captureLlmExchange({
      reqId: "x",
      userId: 3,
      chatId: "c",
      model: "qwen",
      path: "classic",
      requestPayload: { messages: [{ role: "user", content: "salut" }], temperature: 0.7 },
      content: "bonjour",
      usage: { prompt_tokens: 5, completion_tokens: 2 },
      timings: { prompt_ms: 10, predicted_ms: 40 },
      finishReason: "stop",
    });
    const ligne = await t.base.get<Dict>("SELECT * FROM llm_calls WHERE req_id = 'x'");
    expect([ligne?.["n_messages"], ligne?.["duration_ms"]]).toEqual([1, 50]);
    const reponse = JSON.parse(String(ligne?.["response_json"])) as Dict;
    expect(reponse["content"]).toBe("bonjour");
    expect(reponse).not.toHaveProperty("thinking");
    expect((JSON.parse(String(ligne?.["request_json"])) as Dict)["temperature"]).toBe(0.7);
  });

  it("désactivée : aucune écriture ; une base absente ou une valeur non liable n'interrompt jamais l'appelant", async () => {
    const remettre = surchargerConfig({ LLM_DEBUG_ENABLED: false });
    await captureLlmExchange({ reqId: "y", requestPayload: { messages: [] }, content: "x" });
    remettre();
    expect(await t.base.get("SELECT 1 AS un FROM llm_calls WHERE req_id = 'y'")).toBeUndefined();
    await captureLlmExchange({ reqId: "z", usage: { prompt_tokens: { a: 1 } } });
    expect(await t.base.get("SELECT 1 AS un FROM llm_calls WHERE req_id = 'z'")).toBeUndefined();
    remplacerBase(undefined);
    await expect(captureLlmExchange({ reqId: "w" })).resolves.toBeUndefined();
    await expect(recordLlmCall({ reqId: "w", maxEntries: 10 })).resolves.toBeUndefined();
    expect(await uidPourNom("alice")).toBeNull();
    remplacerBase(t.base);
  });

  it("le nom de compte est résolu en base, puis mis en cache (un échec de base n'est pas mis en cache)", async () => {
    await t.base.run(
      "INSERT INTO users(id, username, pass_salt, pass_hash, created_at) VALUES(5, 'carol', 's', 'h', 0)",
    );
    expect(await uidPourNom("carol")).toBe(5);
    await t.base.run("DELETE FROM users WHERE id = 5");
    expect(await uidPourNom("carol")).toBe(5);
    expect(await uidPourNom("")).toBeNull();
    expect(await uidPourNom(12)).toBeNull();
  });
});
