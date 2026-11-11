// SPDX-License-Identifier: MIT
/** apps/core/test/contexte/tokens.test.ts — compteur de tokens : repli estimé (vecteurs Python multilingues) et comptage exact sur un faux llama-server. */
import "../llm/environnement-fournisseurs";

import type { ServerResponse } from "node:http";
import { CHARS_PER_TOKEN } from "@elpis/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { estDict, longueurPy } from "../../src/python";
import type { Dict } from "../../src/python";
import { lireVecteurs } from "../vecteurs-moteur";
import { attendre, FauxServeur, fauxLlama, portFerme } from "../llm/faux-serveur";
import type { RequeteRecue } from "../llm/faux-serveur";
import { moteurFrais, urlLlama } from "../llm/moteur-frais";
import type { Moteur } from "../llm/moteur-frais";

interface VecteursJetons {
  constantes: { CHARS_PER_TOKEN: number; MSG_OVERHEAD_TOKENS: number; IMAGE_TOKEN_COST: number };
  textes: {
    texte: string;
    longueur: number;
    pondere: number;
    est: number;
    empreinte: string;
    outils_json: string;
  }[];
  larges: { n: number; pondere: number; mixte: number }[];
  stables: [number, number][];
  ratios: {
    appels: [string | null, number, number, number | string | null][];
    ratios: Record<string, number>;
    lus: Record<string, number>;
    vers_chars: [number, string | null, number][];
  }[];
  messages: {
    ratio: number | null;
    message: Dict;
    est: number;
    mesure: Record<string, number>;
    texte_tokenize: string;
    payload_chars: number;
    images: number;
  }[];
  listes: {
    messages: unknown[];
    payload_chars: number;
    images: number;
    forfait: number;
    approx: number[];
    mesure: number[];
    outils: number[];
    texte_seul: unknown[] | null;
  }[];
}

const V = lireVecteurs<VecteursJetons>("moteur-jetons");
let m: Moteur;
let s: FauxServeur;

function tokeniser(req: RequeteRecue, rep: ServerResponse): void {
  rep.writeHead(200, { "content-type": "application/json" });
  rep.end(JSON.stringify({ tokens: Array.from((req.json() as { content: string }).content) }));
}

function rendre(req: RequeteRecue, rep: ServerResponse): void {
  const corps = req.json() as { messages: { role: string; content: string }[] };
  rep.writeHead(200, { "content-type": "application/json" });
  rep.end(JSON.stringify({ prompt: corps.messages.map((x) => `<${x.role}>${x.content}`).join("") }));
}

beforeAll(async () => {
  s = await fauxLlama();
  m = await moteurFrais(urlLlama(s.url));
});

afterAll(async () => {
  await m.fermer();
  await s.arreter();
});

beforeEach(() => {
  m.tokens.measuredRatio.clear();
  m.tokens.tokenizeCache.clear();
  m.tokens.tokenizeDownUntil.clear();
  m.tokens.shortTokenMemo.clear();
  s.requetes.length = 0;
  s.route("POST /tokenize", tokeniser);
  s.route("POST /apply-template", (_r, rep) => {
    rep.writeHead(404);
    rep.end();
  });
});

function moteurVers(base: string, providerType = "llamacpp") {
  return new m.moteurs.EngineRef({ key: `url:${base}`, baseRoot: base, providerType });
}

describe("repli estimé (vecteurs Python)", () => {
  it("constantes du compteur (ratio de @elpis/config, le même que le Python)", () => {
    expect(CHARS_PER_TOKEN).toBe(V.constantes.CHARS_PER_TOKEN);
    expect(m.tokens.MSG_OVERHEAD_TOKENS).toBe(V.constantes.MSG_OVERHEAD_TOKENS);
    expect(m.tokens.IMAGE_TOKEN_COST).toBe(V.constantes.IMAGE_TOKEN_COST);
  });

  it("textes multilingues : points de code, table des caractères larges, estimation", () => {
    for (const c of V.textes) {
      expect(longueurPy(c.texte), c.texte).toBe(c.longueur);
      expect(m.tokens.weightedLen(c.texte), c.texte).toBe(c.pondere);
      expect(m.tokens.estTokensText(c.texte), c.texte).toBe(c.est);
    }
    for (const c of V.larges) {
      expect(m.tokens.weightedLen("中".repeat(c.n))).toBe(c.pondere);
      expect(m.tokens.weightedLen(`ab${"😀".repeat(c.n)}é`)).toBe(c.mixte);
    }
    for (const [n, chars] of V.stables) expect(m.tokens.tokensToCharsStable(n)).toBe(chars);
  });

  it("clé de /tokenize : sha256[:24] du texte en UTF-8, demi-paires remplacées par « ? »", async () => {
    for (const c of V.textes.filter((x) => x.texte)) {
      m.tokens.tokenizeCache.clear();
      m.tokens.tokenizeCache.set(JSON.stringify(["m", c.empreinte, false]), 77);
      expect(await m.tokens.countTokensExact(c.texte, "m"), c.texte).toBe(77);
    }
    expect(s.sur("/tokenize")).toHaveLength(0);
  });

  it("ratio mesuré : EWMA par modèle et repli du process, mesures hors bornes ou avec images ignorées", () => {
    for (const c of V.ratios) {
      m.tokens.measuredRatio.clear();
      for (const [mid, chars, tok, img] of c.appels) m.tokens.noteRealUsage(mid, chars, tok, img as number);
      expect(Object.fromEntries(m.tokens.measuredRatio), JSON.stringify(c.appels)).toEqual(c.ratios);
      for (const [k, v] of Object.entries(c.lus))
        expect(m.tokens.measuredCharsPerToken(k === "None" ? null : k)).toBe(v);
      for (const [n, k, chars] of c.vers_chars) expect(m.tokens.tokensToChars(n, k)).toBe(chars);
    }
  });

  it("messages de toutes formes : estimation, ratio mesuré, texte pour /tokenize, chars comptables, images", () => {
    for (const c of V.messages) {
      m.tokens.measuredRatio.clear();
      if (c.ratio !== null) {
        m.tokens.measuredRatio.set("m1", c.ratio);
        m.tokens.measuredRatio.set("", c.ratio + 0.5);
      }
      const ctx = `${String(c.ratio)} ${JSON.stringify(c.message)}`;
      expect(m.tokens.estTokensMessage(c.message), ctx).toBe(c.est);
      expect(m.tokens.estTokensMessageMeasured(c.message, null), ctx).toBe(c.mesure["None"]);
      expect(m.tokens.estTokensMessageMeasured(c.message, "m1"), ctx).toBe(c.mesure["m1"]);
      expect(m.tokens.messageTextForTokenize(c.message), ctx).toBe(c.texte_tokenize);
      expect(m.tokens.payloadChars([c.message]), ctx).toBe(c.payload_chars);
      expect(m.tokens.countImageBlocks([c.message]), ctx).toBe(c.images);
    }
  });

  it("listes : forfaits image, approximations, part des outils, texte seul pour /apply-template", () => {
    for (const c of V.listes) {
      m.tokens.measuredRatio.clear();
      m.tokens.measuredRatio.set("m1", 3.0);
      const msgs = c.messages;
      expect(m.tokens.payloadChars(msgs)).toBe(c.payload_chars);
      expect(m.tokens.countImageBlocks(msgs)).toBe(c.images);
      expect(m.tokens.imageForfaitTokens(msgs)).toBe(c.forfait);
      expect([
        m.tokens.approxPromptTokens(msgs),
        m.tokens.approxPromptTokens(msgs, { extraFixed: 100 }),
        m.tokens.approxPromptTokens(msgs, { extraFixed: -5 }),
      ]).toEqual(c.approx);
      expect([
        m.tokens.measuredPromptTokens(msgs, { modelId: "m1" }),
        m.tokens.measuredPromptTokens(msgs, { extraFixed: 7 }),
      ]).toEqual(c.mesure);
      expect([
        m.tokens.toolPromptTokens(msgs, "m1"),
        m.tokens.toolPromptTokens(msgs, null, { defsTokens: 250 }),
        m.tokens.toolPromptTokens(msgs, "m1", { defsTokens: null }),
      ]).toEqual(c.outils);
      if (c.texte_seul !== null)
        expect(m.tokens.messagesTextOnly(msgs.filter(estDict))).toEqual(c.texte_seul);
    }
  });
});

describe("comptage exact sur le faux llama-server", () => {
  it("/tokenize : corps, modèle, add_special, LRU (une seule requête par clé)", async () => {
    expect(await m.tokens.countTokensExact("")).toBe(0);
    expect(await m.tokens.countTokensExact("bonjour", "m")).toBe(7);
    expect(await m.tokens.countTokensExact("bonjour", "m")).toBe(7);
    expect(s.sur("/tokenize").map((r) => r.json())).toEqual([
      { content: "bonjour", add_special: false, model: "m" },
    ]);
    expect(await m.tokens.countTokensExact("bonjour", "m", { addSpecial: true })).toBe(7);
    expect(await m.tokens.countTokensExact("中文😀", null, { useCache: false })).toBe(3);
    expect(
      s
        .sur("/tokenize")
        .slice(1)
        .map((r) => r.json()),
    ).toEqual([
      { content: "bonjour", add_special: true, model: "m" },
      { content: "中文😀", add_special: false },
    ]);
    expect(m.tokens.tokenizeCache.size).toBe(2);
  });

  it("cible hors llama.cpp : aucun compte exact, aucune requête", async () => {
    const r = await m.moteurs.useEngine(moteurVers(s.url, "openai"), () =>
      Promise.all([
        m.tokens.countTokensExact("x"),
        m.tokens.countRenderedPromptTokensExact([{ role: "user", content: "x" }]),
      ]),
    );
    expect(r).toEqual([null, null]);
    expect(s.requetes).toHaveLength(0);
  });

  it("disjoncteur : serveur injoignable = 3 s sans /tokenize, propre à CE serveur", async () => {
    const mort = moteurVers(`http://127.0.0.1:${await portFerme()}`);
    await m.moteurs.useEngine(mort, async () => {
      expect(await m.tokens.countTokensExact("abc")).toBeNull();
      expect(m.tokens.tokenizeBackoffActive()).toBe(true);
      expect(await m.tokens.countTokensForMessages([{ role: "user", content: "x" }])).toBeNull();
    });
    expect(m.tokens.tokenizeBackoffActive()).toBe(false);
    expect(await m.tokens.countTokensExact("abc")).toBe(3);
    const [url] = m.http.engineUrlHeaders("/tokenize", mort);
    const jusque = m.tokens.tokenizeDownUntil.get(url) ?? 0;
    expect(jusque - m.http.monotonic()).toBeGreaterThan(2.5);
    m.tokens.tokenizeDownUntil.set(url, m.http.monotonic() - 0.01);
    expect(m.tokens.tokenizeBackoffActive(mort)).toBe(false);
  });

  it("disjoncteur : ReadTimeout sur un texte court l'ouvre, pas sur un gros texte ni sur un 500", async () => {
    const lent = await FauxServeur.demarrer({ "POST /tokenize": () => new Promise(() => undefined) });
    const panne = await FauxServeur.demarrer();
    panne.texte("POST /tokenize", "boum", 500);
    try {
      await m.moteurs.useEngine(moteurVers(lent.url), async () => {
        expect(await m.tokens.countTokensExact("x".repeat(20_001), null, { timeout: 0.1 })).toBeNull();
        expect(m.tokens.tokenizeBackoffActive()).toBe(false);
        expect(await m.tokens.countTokensExact("court", null, { timeout: 0.1 })).toBeNull();
        expect(m.tokens.tokenizeBackoffActive()).toBe(true);
      });
      await m.moteurs.useEngine(moteurVers(panne.url), async () => {
        expect(await m.tokens.countTokensExact("court")).toBeNull();
        expect(m.tokens.tokenizeBackoffActive()).toBe(false);
      });
    } finally {
      await lent.arreter();
      await panne.arreter();
    }
  });

  it("annulation : le comptage en vol s'interrompt et lève, sans disjoncteur ni repli estimé", async () => {
    const lent = await FauxServeur.demarrer({ "POST /tokenize": () => new Promise(() => undefined) });
    try {
      await m.moteurs.useEngine(moteurVers(lent.url), async () => {
        const raison = new DOMException("stop", "AbortError");
        const enVol = (f: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> => {
          const ctrl = new AbortController();
          setTimeout(() => ctrl.abort(raison), 30);
          return f(ctrl.signal);
        };
        await expect(enVol((signal) => m.tokens.countTokensExact("court", null, { signal }))).rejects.toBe(
          raison,
        );
        await expect(
          enVol((signal) =>
            m.tokens.countTokensForMessages([{ role: "user", content: "x" }], null, { signal }),
          ),
        ).rejects.toBe(raison);
        await expect(
          enVol((signal) =>
            m.tokens.countMessagesTokensPerMsg([{ role: "user", content: "y" }], null, { signal }),
          ),
        ).rejects.toBe(raison);
        expect(m.tokens.tokenizeBackoffActive()).toBe(false);
        const deja = new AbortController();
        deja.abort(raison);
        await expect(m.tokens.countTokensExact("z", null, { signal: deja.signal })).rejects.toBe(raison);
      });
    } finally {
      await lent.arreter();
    }
  });

  it("texte avec demi-paire isolée : encodage refusé comme httpx, null sans disjoncteur", async () => {
    expect(await m.tokens.countTokensExact("a\ud83db")).toBeNull();
    expect(m.tokens.tokenizeBackoffActive()).toBe(false);
    expect(s.sur("/tokenize")).toHaveLength(0);
  });

  it("LRU borné à 2048 : la plus ancienne clé sort", async () => {
    for (let i = 0; i < m.tokens.TOKENIZE_CACHE_MAX; i++) m.tokens.tokenizeCache.set(`k${i}`, i);
    expect(await m.tokens.countTokensExact("neuf", "m")).toBe(4);
    expect(m.tokens.tokenizeCache.size).toBe(2048);
    expect(m.tokens.tokenizeCache.has("k0")).toBe(false);
    expect([...m.tokens.tokenizeCache.keys()].at(-1)).toContain('"m"');
  });

  it("invalidation : par modèle (clé brute ou <serveur>|<modèle>), tout, ou au changement de modèle", async () => {
    const cle = (mk: string) => JSON.stringify([mk, "h", false]);
    for (const mk of ["m", "conn:3|m", "autre"]) m.tokens.tokenizeCache.set(cle(mk), 1);
    m.tokens.invalidateTokenizeCache("m");
    expect([...m.tokens.tokenizeCache.keys()]).toEqual([cle("autre")]);
    m.tokens.invalidateTokenizeCache();
    expect(m.tokens.tokenizeCache.size).toBe(0);
    m.tokens.tokenizeCache.set(cle("m"), 1);
    const registre = await import("../../src/llm/registre-caches");
    registre.viderAuChangement();
    expect(m.tokens.tokenizeCache.size).toBe(0);
  });

  it("prompt rendu : /apply-template (texte seul, outils, modèle) puis /tokenize avec add_special", async () => {
    s.route("POST /apply-template", rendre);
    const messages = [
      { role: "system", content: "S" },
      {
        role: "user",
        content: [
          { type: "text", text: "a" },
          { type: "image_url", image_url: { url: "x" } },
          { type: "text", text: "b" },
        ],
      },
    ];
    const outils = [{ type: "function", function: { name: "f" } }];
    expect(await m.tokens.countRenderedPromptTokensExact(messages, outils, "m")).toBe(
      "<system>S<user>a b".length,
    );
    expect(s.sur("/apply-template")[0]?.json()).toEqual({
      messages: [
        { role: "system", content: "S" },
        { role: "user", content: "a b" },
      ],
      tools: outils,
      model: "m",
    });
    expect(s.sur("/tokenize")[0]?.json()).toEqual({
      content: "<system>S<user>a b",
      add_special: true,
      model: "m",
    });
    expect(await m.tokens.countRenderedPromptTokensExact([])).toBe(0);
    expect(await m.tokens.countTokensForMessages(messages, "m")).toBe("<system>S<user>a b".length);
  });

  it("conversation sans /apply-template : un /tokenize par message (+4), null si l'un échoue", async () => {
    const msgs = [
      { role: "user", content: "abc" },
      { role: "assistant", content: "de" },
    ];
    expect(await m.tokens.countTokensForMessages(msgs)).toBe(
      "user\nabc".length + 4 + "assistant\nde".length + 4,
    );
    expect(await m.tokens.countTokensForMessages([])).toBe(0);
    await expect(m.tokens.countTokensForMessages(["x"])).rejects.toMatchObject({ type: "AttributeError" });
    s.route("POST /tokenize", (req, rep) => {
      const ok = !(req.json() as { content: string }).content.includes("panne");
      rep.writeHead(ok ? 200 : 500, { "content-type": "application/json" });
      rep.end(JSON.stringify({ tokens: [1, 2] }));
    });
    const msgs2 = [
      { role: "user", content: "ok" },
      { role: "user", content: "panne" },
    ];
    expect(await m.tokens.countTokensForMessages(msgs2)).toBeNull();
  });

  it("par message : surcoût + forfait image, mémo par objet et par contenu court, recompte si le contenu change", async () => {
    const a: Dict = { role: "user", content: "bonjour" };
    const b: Dict = { role: "user", content: [{ type: "text", text: "vu" }, { type: "image_url" }] };
    const [n1, repli1] = await m.tokens.countMessagesTokensPerMsgEx([a, b], "m");
    expect(n1).toEqual(["user\nbonjour".length + 8, "user\nvu".length + 8 + m.tokens.IMAGE_TOKEN_COST]);
    expect(repli1).toBe(0);
    const avant = s.sur("/tokenize").length;
    expect(
      await m.tokens.countMessagesTokensPerMsg([a, b, { role: "user", content: "bonjour" }], "m"),
    ).toEqual([n1[0], n1[1], n1[0]]);
    expect(s.sur("/tokenize")).toHaveLength(avant);
    a["content"] = "au revoir";
    const [n2] = await m.tokens.countMessagesTokensPerMsgEx([a], "m");
    expect(n2).toEqual(["user\nau revoir".length + 8]);
    expect(s.sur("/tokenize")).toHaveLength(avant + 1);
  });

  it("par message, serveur injoignable : repli au ratio mesuré, compté comme estimé", async () => {
    m.tokens.measuredRatio.set("m", 2.0);
    const msgs: Dict[] = [
      { role: "user", content: "abcdefgh" },
      { role: "assistant", content: "" },
    ];
    await m.moteurs.useEngine(moteurVers(`http://127.0.0.1:${await portFerme()}`), async () => {
      const [n, repli] = await m.tokens.countMessagesTokensPerMsgEx(msgs, "m");
      expect(n).toEqual([8 + 4, 8 + 0]);
      expect(repli).toBe(2);
    });
  });

  it("outils : JSON de json.dumps (ensure_ascii=False) envoyé tel quel, estimé si le compte exact manque", async () => {
    expect(await m.tokens.countToolsTokensEx([])).toEqual([0, false]);
    expect(await m.tokens.countToolsTokensEx(null)).toEqual([0, false]);
    for (const c of V.textes) {
      const avant = s.sur("/tokenize").length;
      const r = await m.tokens.countToolsTokensEx([{ t: c.texte }], "m");
      if (c.outils_json.isWellFormed()) {
        expect(s.sur("/tokenize").length, c.texte).toBe(avant + 1);
        expect((s.sur("/tokenize").at(-1)?.json() as { content: string }).content).toBe(c.outils_json);
        expect(r).toEqual([Array.from(c.outils_json).length, false]);
      } else expect(r).toEqual([Math.max(1, m.tokens.estTokensText(c.outils_json)), true]);
    }
  });

  it("comptages concurrents : au plus 8 /tokenize en vol", async () => {
    let enVol = 0;
    let pic = 0;
    s.route("POST /tokenize", async (req, rep) => {
      pic = Math.max(pic, ++enVol);
      await attendre(20);
      enVol--;
      tokeniser(req, rep);
    });
    const msgs = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `message ${i}` }));
    const n = await m.tokens.countMessagesTokensPerMsg(msgs, "m");
    expect(n).toHaveLength(20);
    expect(pic).toBeLessThanOrEqual(8);
    expect(pic).toBeGreaterThan(1);
  });
});
