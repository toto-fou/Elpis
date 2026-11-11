// SPDX-License-Identifier: MIT
/** apps/core/test/llm/moteurs.test.ts — serveurs et cibles d'inférence : vecteurs Python (clés, racines, connecteurs simulés) et portée AsyncLocalStorage. */
import { setImmediate as prochainTour, setTimeout as attendre } from "node:timers/promises";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { surchargerConfig } from "@elpis/config";

import {
  cibleDuContexte,
  currentTarget,
  defaultTarget,
  EngineUnavailable,
  LlmTarget,
  resolveLlmTarget,
  useLlmTarget,
} from "../../src/llm/cible";
import type { ChampsCible } from "../../src/llm/cible";
import {
  BUILTIN_KEY,
  baseRoot,
  builtinEngine,
  connectorKey,
  currentEngine,
  EngineRef,
  engineForTarget,
  engineLimits,
  parseEngineKey,
  resolveEngineForUser,
  useEngine,
} from "../../src/llm/moteurs";
import { installerConnecteurs } from "../../src/llm/ports";
import type { ConnecteurPublic, ConnecteurSecret } from "../../src/llm/ports";
import { lireVecteurs, rejouer } from "../vecteurs-moteur";
import type { Attendu } from "../vecteurs-moteur";

type Dict = Record<string, unknown>;
type SpecCible = Dict | null;

interface Vecteurs {
  connecteurs: Record<string, ConnecteurSecret>;
  integre_fixe: Dict;
  cles: { key: string | null; valeur: unknown }[];
  connector_key: ({ id: unknown } & Attendu)[];
  base_root: { url: string | null; racine: string }[];
  integre: { url: string; provider_type: string; moteur: Dict }[];
  cibles_defaut: { provider_type: string | null; cible: Dict }[];
  proprietes: { cible: Dict; proprietes: Dict }[];
  moteurs_de_cible: { cible: SpecCible; forme: string; moteur?: Dict; erreur?: string }[];
  resolutions: (Dict & {
    user_id: unknown;
    connector_id: unknown;
    model: string | null;
    strict: boolean;
    touch: boolean;
    autorises: unknown;
    lignes: string;
    bump: string;
    cible?: Dict;
    erreur?: Dict;
    appels: unknown[];
  })[];
  utilisateurs: { user_id: unknown; key: string | null; moteur: Dict | null; appels: unknown[] }[];
  limites: (Dict & {
    integre?: [number, number];
    meta?: unknown;
    connector_id?: number | null;
    appels?: unknown[];
  } & Attendu)[];
  courants: { cible: SpecCible; mode: string; moteur: Dict }[];
}

const v = lireVecteurs<Vecteurs>("moteur-cibles");
const restaurations: (() => void)[] = [];

function surcharger(partiel: Dict): void {
  restaurations.push(surchargerConfig(partiel as Parameters<typeof surchargerConfig>[0]));
}

beforeEach(() => surcharger(v.integre_fixe));
afterEach(() => {
  while (restaurations.length > 0) restaurations.pop()?.();
  installerConnecteurs(null);
});

function champs(spec: Dict): ChampsCible {
  const noms: Record<string, keyof ChampsCible> = {
    wire: "wire",
    provider_type: "providerType",
    base_url: "baseUrl",
    api_key: "apiKey",
    model: "model",
    connector_id: "connectorId",
    is_default: "isDefault",
  };
  return Object.fromEntries(Object.entries(spec).map(([k, x]) => [noms[k] ?? k, x])) as ChampsCible;
}

function vueCible(t: LlmTarget): Dict {
  return {
    wire: t.wire,
    provider_type: t.providerType,
    base_url: t.baseUrl,
    api_key: t.apiKey,
    model: t.model,
    connector_id: t.connectorId,
    is_default: t.isDefault,
    is_local_llamacpp: t.isLocalLlamacpp,
    is_llamacpp: t.isLlamacpp,
  };
}

function vueMoteur(e: EngineRef): Dict {
  return {
    key: e.key,
    base_root: e.baseRoot,
    provider_type: e.providerType,
    headers: e.headers.map((h) => [...h]),
    connector_id: e.connectorId,
    label: e.label,
    is_builtin: e.isBuiltin,
    is_llamacpp: e.isLlamacpp,
    repr: String(e),
    header_dict: e.headerDict(),
    url: e.url("/props"),
    cache_keys: ["", null, "qwen", "a|b"].map((m) => [m, e.cacheKey(m)]),
  };
}

/** Connecteurs simulés comme dans le générateur Python ; rend le journal des appels. */
function simuler(autorises: unknown, lignes: string, bump: string, metas: unknown = null): unknown[] {
  const appels: unknown[] = [];
  installerConnecteurs({
    async getSecretForUser(uid, cid) {
      appels.push(["get", uid, cid]);
      if (lignes === "leve") throw new Error("base illisible");
      const ligne = v.connecteurs[String(cid)];
      return ligne === undefined ? null : structuredClone(ligne);
    },
    async bumpLastUsed(cid) {
      appels.push(["bump", cid]);
      if (bump === "leve") throw new Error("base en lecture seule");
    },
    allowedProviderTypes() {
      appels.push(["allowed"]);
      if (autorises === "leve") throw new Error("config illisible");
      return [...(autorises as string[])];
    },
    async getMeta(cid) {
      appels.push(["meta", cid]);
      if (metas === "leve") throw new Error("base illisible");
      return structuredClone(metas) as ConnecteurPublic | null;
    },
  });
  return appels;
}

describe("vecteurs Python de llm_core/engines.py et llm_core/_target.py", () => {
  it("clés de moteur, clés de connecteur et racines d'URL", () => {
    for (const c of v.cles) expect(parseEngineKey(c.key), String(c.key)).toEqual(c.valeur);
    for (const c of v.connector_key) rejouer(() => connectorKey(c.id), c, String(c.id));
    for (const c of v.base_root) expect(baseRoot(c.url), String(c.url)).toBe(c.racine);
  });

  it("serveur intégré dérivé de LLAMA_URL, relu à chaque appel", () => {
    for (const c of v.integre) {
      surcharger({ LLAMA_URL: c.url, LLAMA_PROVIDER_TYPE: c.provider_type });
      expect(vueMoteur(builtinEngine()), c.url).toEqual(c.moteur);
    }
    for (const c of v.cibles_defaut) {
      surcharger({ LLAMA_PROVIDER_TYPE: c.provider_type });
      expect(vueCible(defaultTarget()), String(c.provider_type)).toEqual(c.cible);
    }
  });

  it("propriétés d'une cible et serveur d'une cible", () => {
    for (const c of v.proprietes) expect(vueCible(new LlmTarget(champs(c.cible)))).toEqual(c.proprietes);
    for (const c of v.moteurs_de_cible) {
      const cible =
        c.cible === null ? null : c.forme === "canard" ? champs(c.cible) : new LlmTarget(champs(c.cible));
      if (c.erreur !== undefined) {
        rejouer(() => engineForTarget(cible), { erreur: c.erreur }, JSON.stringify(c.cible));
        continue;
      }
      expect(vueMoteur(engineForTarget(cible)), JSON.stringify(c.cible)).toEqual(c.moteur);
    }
  });

  it("résolution d'une cible par connecteur : repli, strict, politique de fournisseurs, dernier usage", async () => {
    for (const c of v.resolutions) {
      const appels = simuler(c.autorises, c.lignes, c.bump);
      const contexte = JSON.stringify([c.user_id, c.connector_id, c.model, c.strict, c.touch, c.autorises]);
      try {
        const t = await resolveLlmTarget(c.user_id, c.connector_id, c.model, {
          strict: c.strict,
          touch: c.touch,
        });
        expect(c.erreur, contexte).toBeUndefined();
        expect(vueCible(t), contexte).toEqual(c.cible);
      } catch (e) {
        expect(e, contexte).toBeInstanceOf(EngineUnavailable);
        const err = e as EngineUnavailable;
        expect({ reason: err.reason, message: err.message }, contexte).toEqual(c.erreur);
      }
      expect(appels, contexte).toEqual(c.appels);
    }
  });

  it("serveur d'une clé pour un compte", async () => {
    for (const c of v.utilisateurs) {
      const appels = simuler(["openai", "anthropic"], "ok", "ok");
      const e = await resolveEngineForUser(c.user_id, c.key);
      expect(e === null ? null : vueMoteur(e), String(c.key)).toEqual(c.moteur);
      expect(appels).toEqual(c.appels);
    }
  });

  it("limites déclarées d'un serveur", async () => {
    for (const c of v.limites) {
      if (c.integre !== undefined) {
        surcharger({ LLAMA_MAX_MODELS: c.integre[0], LLAMA_MAX_CONCURRENCY: c.integre[1] });
        expect(await engineLimits(builtinEngine())).toEqual(c.valeur);
        continue;
      }
      const appels = simuler([], "ok", "ok", c.meta);
      const moteur = new EngineRef({
        key: `conn:${c.connector_id}`,
        baseRoot: "http://x",
        connectorId: c.connector_id,
      });
      const promesse = engineLimits(moteur);
      if ("erreur" in c) await expect(promesse).rejects.toMatchObject({ type: c.erreur });
      else expect(await promesse).toEqual(c.valeur);
      expect(appels).toEqual(c.appels);
    }
  });

  it("serveur courant : surcharge, puis cible du tour, puis intégré", () => {
    const surcharge = new EngineRef({
      key: "conn:9",
      baseRoot: "http://surcharge",
      providerType: "vllm",
      label: "s",
    });
    for (const c of v.courants) {
      const cible = c.cible === null ? null : new LlmTarget(champs(c.cible));
      const moteur = useLlmTarget(cible, () => {
        if (c.mode === "aucune") return currentEngine();
        if (c.mode === "surcharge") return useEngine(surcharge, () => currentEngine());
        return useEngine(surcharge, () => useEngine(null, () => currentEngine()));
      });
      expect(vueMoteur(moteur), `${JSON.stringify(c.cible)} ${c.mode}`).toEqual(c.moteur);
    }
  });
});

describe("portée AsyncLocalStorage (les ContextVar de Python)", () => {
  const a = new LlmTarget({
    isDefault: false,
    providerType: "llamacpp",
    baseUrl: "http://a/v1",
    connectorId: 1,
  });
  const b = new LlmTarget({
    isDefault: false,
    providerType: "openai",
    baseUrl: "http://b/v1",
    connectorId: 2,
  });

  it("hors portée : cible par défaut neuve à chaque appel, serveur intégré", () => {
    expect(cibleDuContexte()).toBeNull();
    expect(currentTarget()).not.toBe(currentTarget());
    expect(currentTarget().isDefault).toBe(true);
    expect(currentEngine().key).toBe(BUILTIN_KEY);
  });

  it("la cible traverse await, minuteries et microtâches, puis disparaît à la sortie", async () => {
    await useLlmTarget(a, async () => {
      expect(currentTarget()).toBe(a);
      await attendre(2);
      expect(currentTarget()).toBe(a);
      await prochainTour();
      await new Promise<void>((fin) => {
        setTimeout(() => {
          expect(currentTarget()).toBe(a);
          queueMicrotask(() => {
            expect(currentEngine().key).toBe("conn:1");
            fin();
          });
        }, 1);
      });
    });
    expect(cibleDuContexte()).toBeNull();
  });

  it("Promise.all : les branches voient la cible du parent, une surcharge de branche ne fuit pas", async () => {
    const vus = await useLlmTarget(a, () =>
      Promise.all([
        (async () => {
          await attendre(3);
          return currentTarget();
        })(),
        useLlmTarget(b, async () => {
          await attendre(1);
          return currentTarget();
        }),
        (async () => {
          await attendre(2);
          return useEngine(builtinEngine(), async () => {
            await prochainTour();
            return currentEngine().key;
          });
        })(),
        (async () => {
          await attendre(4);
          return currentEngine().key;
        })(),
      ]),
    );
    expect(vus).toEqual([a, b, BUILTIN_KEY, "conn:1"]);
  });

  it("deux requêtes concurrentes restent isolées", async () => {
    const requete = (cible: LlmTarget, nom: string): Promise<string[]> =>
      useLlmTarget(cible, async () => {
        const vu: string[] = [];
        for (let i = 0; i < 5; i++) {
          await attendre(i % 2 === 0 ? 1 : 0);
          vu.push(`${nom}:${currentTarget().baseUrl}:${currentEngine().key}`);
        }
        return vu;
      });
    const [ra, rb] = await Promise.all([requete(a, "A"), requete(b, "B")]);
    expect(new Set(ra)).toEqual(new Set(["A:http://a/v1:conn:1"]));
    expect(new Set(rb)).toEqual(new Set(["B:http://b/v1:conn:2"]));
  });

  it("useEngine(null) rend la règle normale sous une surcharge, et la sortie restaure l'extérieur", async () => {
    const s = new EngineRef({ key: "conn:7", baseRoot: "http://s" });
    await useLlmTarget(b, async () => {
      await useEngine(s, async (e) => {
        expect(e).toBe(s);
        await attendre(1);
        expect(currentEngine()).toBe(s);
        expect(useEngine(null, () => currentEngine().key)).toBe("conn:2");
        expect(currentEngine()).toBe(s);
      });
      expect(currentEngine().key).toBe("conn:2");
    });
  });
});

describe("ports et sécurité", () => {
  it("connecteurs non installés : comme un import en échec (repli, ou « clé illisible » en strict)", async () => {
    installerConnecteurs(null);
    const t = await resolveLlmTarget(5, 1, "m");
    expect(t.isDefault).toBe(true);
    expect(t.model).toBe("m");
    await expect(resolveLlmTarget(5, 1, null, { strict: true })).rejects.toMatchObject({ reason: "key" });
    expect(await engineLimits(new EngineRef({ key: "conn:3", baseRoot: "", connectorId: 3 }))).toEqual([
      0, 0,
    ]);
    expect(await resolveEngineForUser(5, "conn:1")).toBeNull();
  });

  it("un EngineRef est figé et ne montre jamais sa clé d'API", () => {
    const e = engineForTarget(
      new LlmTarget({ isDefault: false, apiKey: "sk-secret", connectorId: 4, baseUrl: "http://x" }),
    );
    expect(Object.isFrozen(e)).toBe(true);
    expect(e.headerDict()).toEqual({ Authorization: "Bearer sk-secret" });
    for (const texte of [String(e), JSON.stringify({ e }), inspect(e), `${e}`])
      expect(texte).not.toContain("sk-secret");
  });
});
