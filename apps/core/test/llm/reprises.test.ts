// SPDX-License-Identifier: MIT
/** apps/core/test/llm/reprises.test.ts — taxonomie des pannes LLM, messages, Retry-After et dates HTTP (vecteurs Python), attentes annulables et pause entre tentatives. */
import "./environnement-fournisseurs";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ErreurPython } from "@elpis/commun";

import { lireVecteurs } from "../vecteurs-moteur";
import { FauxServeur } from "./faux-serveur";
import { moteurFrais, urlLlama } from "./moteur-frais";
import type { Moteur } from "./moteur-frais";

interface Description {
  fatale: boolean;
  chargement: boolean;
  famille: string;
  message_utilisateur: string;
  fournisseur: string;
  detail: string;
  detail_3: string;
  corps_lu: string;
}

interface VecteursReprises {
  messages_famille: Record<string, string>;
  http: ({ code: number; corps: string } & Description)[];
  transport: ({ type: string } & Description)[];
  autres: ({ cas: string } & Description)[];
  llm_failure: { message: string; kind: string; detail: string };
  retry_after: { en_tetes: Record<string, string> | null; secondes: number | null }[];
  dates: { brut: string; epoch: number | null }[];
  backoff: { tentative: number; base: number | null; plafond: number | null; max: number }[];
  fournisseur: ({
    statut: unknown;
    corps: unknown;
    url: string | null;
    message_demande: string;
    code: number;
    texte: string;
    url_requete: string;
    message: string;
  } & Description)[];
}

const V = lireVecteurs<VecteursReprises>("moteur-reprises");
let m: Moteur;
let s: FauxServeur;

beforeAll(async () => {
  s = await FauxServeur.demarrer();
  m = await moteurFrais(urlLlama(s.url));
});

afterAll(async () => {
  await m.fermer();
  await s.arreter();
});

afterEach(() => {
  vi.restoreAllMocks();
  m.reprises.forgetLlmSuccess();
});

function erreurHttp(code: number, corps: string, entetes: Record<string, string> | null = null) {
  const requete = { method: "POST", url: "http://moteur.invalid/v1/chat/completions" };
  const reponse = new m.client.ReponseHttp({
    statusCode: code,
    request: requete,
    text: corps,
    headers: entetes,
  });
  return new m.client.HTTPStatusError(`HTTP ${code}`, { request: requete, response: reponse });
}

function decrire(e: unknown): Description {
  const r = m.reprises;
  return {
    fatale: r.llmErrorIsFatal(e),
    chargement: r.llmErrorIsLoading(e),
    famille: r.llmErrorKind(e),
    message_utilisateur: r.llmErrorUserMessage(e),
    fournisseur: r.providerMessage(e),
    detail: r.llmErrorDetail(e),
    detail_3: r.llmErrorDetail(e, 3),
    corps_lu: r.errorBodyText(e),
  };
}

function sansCles<T extends object>(o: T, cles: string[]): Description {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !cles.includes(k))) as unknown as Description;
}

describe("vecteurs Python", () => {
  it("messages par famille", () => {
    expect(m.reprises.KIND_MESSAGES).toEqual(V.messages_famille);
  });

  it("erreurs HTTP : fatale, chargement, famille, message, message du fournisseur, détail, corps", () => {
    for (const c of V.http)
      expect(decrire(erreurHttp(c.code, c.corps)), `${c.code} ${c.corps.slice(0, 60)}`).toEqual(
        sansCles(c, ["code", "corps"]),
      );
  });

  it("pannes de transport et erreurs étrangères", () => {
    const classes: Record<string, new (message: string) => Error> = {
      ConnectError: m.client.ConnectError,
      ConnectTimeout: m.client.ConnectTimeout,
      ReadTimeout: m.client.ReadTimeout,
      WriteTimeout: m.client.WriteTimeout,
      PoolTimeout: m.client.PoolTimeout,
      RemoteProtocolError: m.client.RemoteProtocolError,
      ReadError: m.client.ReadError,
    };
    for (const c of V.transport) {
      const Classe = classes[c.type];
      expect(Classe, c.type).toBeDefined();
      if (Classe) expect(decrire(new Classe("panne de transport")), c.type).toEqual(sansCles(c, ["type"]));
    }
    const autres: Record<string, unknown> = {
      aucune: null,
      runtime: Object.assign(new Error("boum"), { name: "RuntimeError" }),
      valeur: new ErreurPython("ValueError", "x".repeat(400)),
    };
    for (const c of V.autres) expect(decrire(autres[c.cas]), c.cas).toEqual(sansCles(c, ["cas"]));
  });

  it("LLMFailure : message actionnable, famille, détail avec le nombre de tentatives", () => {
    const corps = V.http.find((c) => c.corps.includes("exceeds the available context size"))?.corps ?? "";
    const e = new m.reprises.LLMFailure(erreurHttp(400, corps), { attempts: 2 });
    expect({ message: e.message, kind: e.kind, detail: e.detail }).toEqual(V.llm_failure);
  });

  it("Retry-After (secondes, millisecondes, illisible) borné à 60 s ; dates HTTP comme parsedate_to_datetime", () => {
    for (const c of V.retry_after) {
      const e = c.en_tetes === null ? new m.client.ReadTimeout("") : erreurHttp(429, "", c.en_tetes);
      expect(m.reprises.retryAfterSeconds(e), JSON.stringify(c.en_tetes)).toBe(c.secondes);
    }
    for (const c of V.dates) expect(m.reprises.parsedateEpoch(c.brut), c.brut).toBe(c.epoch);
    const dans30s = new Date(Date.now() + 30_000).toUTCString();
    const delai = m.reprises.retryAfterSeconds(erreurHttp(429, "", { "retry-after": dans30s }));
    expect(delai).toBeGreaterThan(28);
    expect(delai).toBeLessThanOrEqual(30);
  });

  it("backoff à gigue complète : plafond min(cap, base·2^tentative)", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    for (const c of V.backoff)
      expect(
        m.reprises.backoffDelay(c.tentative, { base: c.base ?? undefined, cap: c.plafond ?? undefined }),
        JSON.stringify(c),
      ).toBe(c.max);
  });

  it("erreur du fournisseur remise en forme HTTP (statut texte ou absent, URL par défaut)", () => {
    for (const c of V.fournisseur) {
      const e = m.reprises.providerHttpError(c.statut, c.corps, {
        message: c.message_demande,
        ...(c.url !== null ? { url: c.url } : {}),
      });
      const ctx = JSON.stringify([c.statut, c.url]);
      expect(e.response.statusCode, ctx).toBe(c.code);
      expect(e.response.text, ctx).toBe(c.texte);
      expect(e.request.url, ctx).toBe(c.url_requete);
      expect(e.message, ctx).toBe(c.message);
      expect(decrire(e), ctx).toEqual(
        sansCles(c, ["statut", "corps", "url", "message_demande", "code", "texte", "url_requete", "message"]),
      );
    }
  });
});

describe("attentes et pause entre tentatives", () => {
  it("sommeil découpé : l'annulation coupe dans la tranche (drapeau ou signal)", async () => {
    let stop = false;
    setTimeout(() => (stop = true), 30);
    const t0 = performance.now();
    await expect(m.reprises.cancelAwareSleep(5, () => stop)).rejects.toBeInstanceOf(m.client.CancelledError);
    expect(performance.now() - t0).toBeLessThan(1000);
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 30);
    await expect(m.reprises.cancelAwareSleep(5, null, ctl.signal)).rejects.toBeInstanceOf(
      m.client.CancelledError,
    );
    await m.reprises.cancelAwareSleep(0.05, null);
  });

  it("attente de /health : 503 puis 200, échéance, annulation", async () => {
    let n = 0;
    s.route("GET /health", (_q, rep) => {
      rep.writeHead(n++ < 2 ? 503 : 200);
      rep.end();
    });
    expect(await m.reprises.waitLlamaReady(5, { pollS: 0.01 })).toBe(true);
    expect(n).toBe(3);
    expect(await m.reprises.waitLlamaReady(0.05, { probe: () => Promise.resolve(503), pollS: 0.01 })).toBe(
      false,
    );
    expect(
      await m.reprises.waitLlamaReady(1, { probe: () => Promise.reject(new Error("x")), pollS: 0.3 }),
    ).toBe(false);
    await expect(m.reprises.waitLlamaReady(5, { isCancelled: () => true })).rejects.toBeInstanceOf(
      m.client.CancelledError,
    );
  });

  it("503 ou redémarrage d'un llama.cpp : attendre /health avant de retenter ; ailleurs Retry-After puis backoff", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const attentes: unknown[] = [];
    const attendrePret = (maxWaitS?: number | null) => {
      attentes.push(maxWaitS);
      return Promise.resolve(true);
    };
    await m.reprises.retryPause(erreurHttp(503, ""), 0, { attendrePret });
    expect(attentes).toHaveLength(1);
    await m.reprises.retryPause(new m.client.ConnectError("x"), 0, { attendrePret });
    expect(attentes).toHaveLength(1);
    m.reprises.noteLlmSuccess();
    expect(m.reprises.engineWasAlive()).toBe(true);
    await m.reprises.retryPause(new m.client.ConnectError("x"), 0, { attendrePret });
    expect(attentes).toHaveLength(2);
    const distant = new m.cible.LlmTarget({ isDefault: false, providerType: "openai", baseUrl: "http://x" });
    await m.cible.useLlmTarget(distant, () =>
      m.reprises.retryPause(erreurHttp(503, ""), 0, { attendrePret }),
    );
    expect(attentes).toHaveLength(2);
    const t0 = performance.now();
    await m.reprises.retryPause(erreurHttp(429, "", { "retry-after-ms": "120" }), 0);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(100);
    const eng = new m.moteurs.EngineRef({ key: "conn:4", baseRoot: "http://x" });
    expect(m.moteurs.useEngine(eng, () => m.reprises.engineWasAlive())).toBe(false);
  });
});
