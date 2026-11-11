// SPDX-License-Identifier: MIT
/** apps/core/test/llm/raisonnement-infill.test.ts — tokens de réflexion (vecteurs Python, compte exact simulé) et complétion FIM `/infill` avec signal au disjoncteur. */
import "./environnement-fournisseurs";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type * as ModuleTokens from "../../src/contexte/tokens";
import { lireVecteurs } from "../vecteurs-moteur";
import { FauxServeur, portFerme } from "./faux-serveur";
import { moteurFrais, urlLlama } from "./moteur-frais";
import type { Moteur } from "./moteur-frais";

vi.mock("../../src/contexte/tokens", async (importOriginal) => {
  const original = await importOriginal<typeof ModuleTokens>();
  return { ...original, countTokensExact: vi.fn(original.countTokensExact) };
});

interface VecteursRaisonnement {
  entiers: { valeur: unknown; entier: number | null }[];
  natifs: { usage: unknown; tokens: number | null }[];
  estimations: { ratio: number | null; texte: string | null; modele: string | null; tokens: number }[];
  mesures: {
    texte: string | null;
    usage: unknown;
    sortie: unknown;
    llamacpp: boolean;
    compte: number | null | "panne";
    mesure: [number, boolean];
  }[];
}

const V = lireVecteurs<VecteursRaisonnement>("moteur-raisonnement");
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
  m.ports.installerDisjoncteur(null);
  m.tokens.measuredRatio.clear();
  s.requetes.length = 0;
});

describe("tokens de réflexion (vecteurs Python)", () => {
  it("entier positif, usage déclaré (niché puis plat), estimation au ratio mesuré", () => {
    for (const c of V.entiers)
      expect(m.raisonnement.posInt(c.valeur), JSON.stringify(c.valeur)).toBe(c.entier);
    for (const c of V.natifs)
      expect(m.raisonnement.nativeReasoningTokens(c.usage), JSON.stringify(c.usage)).toBe(c.tokens);
    for (const c of V.estimations) {
      m.tokens.measuredRatio.clear();
      if (c.ratio !== null) m.tokens.measuredRatio.set("m", c.ratio);
      expect(m.raisonnement.estimateThinkingTokens(c.texte, c.modele), JSON.stringify(c)).toBe(c.tokens);
    }
  });

  it("mesure d'un tour : déclaré, sinon /tokenize (cible llama.cpp), sinon estimé ; borné par la sortie", async () => {
    const exact = vi.mocked(m.tokens.countTokensExact);
    m.tokens.measuredRatio.clear();
    for (const c of V.mesures) {
      exact.mockImplementation(() =>
        c.compte === "panne" ? Promise.reject(new Error("panne")) : Promise.resolve(c.compte),
      );
      const cible = new m.cible.LlmTarget({
        providerType: c.llamacpp ? "llamacpp" : "openai",
        isDefault: c.llamacpp,
      });
      const r = await m.cible.useLlmTarget(cible, () =>
        m.raisonnement.measureThinkingTokens(c.texte, {
          modelId: "m",
          usage: c.usage,
          outputTokens: c.sortie,
        }),
      );
      expect(r, JSON.stringify({ ...c, texte: c.texte?.slice(0, 20), mesure: undefined })).toEqual(c.mesure);
    }
    exact.mockReset();
  });

  it("au-delà de 400 000 caractères : estimation directe, sans /tokenize", async () => {
    const exact = vi.mocked(m.tokens.countTokensExact);
    exact.mockClear();
    const [n, estime] = await m.raisonnement.measureThinkingTokens("a".repeat(400_001), { modelId: "m" });
    expect([n, estime]).toEqual([Math.trunc(400_001 / 3.3), true]);
    expect(exact).not.toHaveBeenCalled();
  });
});

describe("complétion FIM /infill", () => {
  it("corps (profil infill, arrêts FIM, modèle), contenu direct ou par choices, échec avec indice", async () => {
    s.json("GET /props", { default_generation_settings: { params: { temperature: 0.8, top_k: 40 } } });
    s.json("POST /infill", { content: "x = 1", model: "coder" });
    expect(await m.infill.llmInfill("def f():\n", "\n", "coder")).toEqual({
      ok: true,
      content: "x = 1",
      model: "coder",
    });
    const corps = s.sur("/infill")[0]?.json() as Record<string, unknown>;
    const attendu = await m.parametres.resolveSampling("coder", "infill");
    expect(corps).toEqual({
      input_prefix: "def f():\n",
      input_suffix: "\n",
      ...attendu,
      stop: [...m.infill.FIM_STOP],
      model: "coder",
    });
    s.json("POST /infill", { content: "", choices: [{ text: "", content: "par choices" }] });
    expect(await m.infill.llmInfill("a", "b")).toEqual({ ok: true, content: "par choices", model: "" });
    s.texte("POST /infill", "non", 404);
    expect(await m.infill.llmInfill("a", "b")).toEqual({
      ok: false,
      error: "Endpoint /infill non disponible.",
      hint: "Vérifiez que le modèle supporte FIM (Fill-In-the-Middle).",
    });
  });

  it("serveur muet : panne de transport signalée au disjoncteur (s'il est posé), jamais une erreur HTTP", async () => {
    const signaux: unknown[] = [];
    m.ports.installerDisjoncteur({
      signalerPanneTransport: (eng, modele) => void signaux.push([eng.key, modele]),
    });
    s.texte("POST /infill", "boum", 500);
    await m.infill.llmInfill("a", "b", "q");
    expect(signaux).toEqual([]);
    const mort = new m.moteurs.EngineRef({
      key: "conn:5",
      baseRoot: `http://127.0.0.1:${await portFerme()}`,
    });
    const r = await m.moteurs.useEngine(mort, () => m.infill.llmInfill("a", "b", "q"));
    expect(r["ok"]).toBe(false);
    expect(signaux).toEqual([["conn:5", "q"]]);
    m.ports.installerDisjoncteur(null);
    await m.moteurs.useEngine(mort, () => m.infill.llmInfill("a", "b"));
  });
});
