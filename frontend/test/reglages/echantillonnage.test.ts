// SPDX-License-Identifier: MIT
/** frontend/test/reglages/echantillonnage.test.ts — interrupteur « Raisonnement conservé » : offert là où le serveur le déclare, éteint par défaut quand il le dit. */
import * as Vue from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import { libelleEffort } from "../../src/features/chat/page/puces";
import { lireSurcharge, setupEchantillonnage } from "../../src/features/reglages/echantillonnage";
import type { MetaMoteur } from "../../src/features/reglages/echantillonnage";

const BASE = {
  task: "chat",
  supports_thinking: true,
  supports_reasoning_effort: false,
  reasoning_effort_values: [],
  supports_continue_final_message: null,
  sources: { props: {}, task_profile: {}, user_override: {} },
  effective: {},
  param_sources: {},
  agent_defaults: {},
};

function monter(reponse: Record<string, unknown>, connecteur = "") {
  const stock = new Map<string, string>();
  const s = setupEchantillonnage(
    Vue,
    {
      selectedModel: Vue.ref("m"),
      activeModelIds: Vue.ref(["m"]),
      selectedConnector: Vue.ref(connecteur),
      selectedEngineMeta: Vue.ref<MetaMoteur | null>(
        connecteur ? { key: connecteur, providerType: "sglang" } : null,
      ),
      settings: Vue.ref({}),
      ctxUsage: Vue.ref(null),
    },
    {
      fetchAuth: async () => new Response(JSON.stringify({ model_id: "m", ...BASE, ...reponse })),
      stockage: {
        getItem: (k) => stock.get(k) ?? null,
        removeItem: (k) => void stock.delete(k),
      },
    },
  );
  return s;
}

describe("Raisonnement conservé", () => {
  it("SGLang : offert même via un connecteur, éteint par défaut, activé seulement par un choix explicite", async () => {
    const s = monter(
      { degraded: true, supports_preserve_reasoning: true, preserve_reasoning_default: false },
      "conn:5",
    );
    await s.loadEffectiveParams("m");
    expect(s.preserveReasoningSupported.value).toBe(true);
    expect(s.preserveReasoningEnabled.value).toBe(false);
    expect(s.samplingOverride.value.preserve_reasoning).toBeNull();
    s.preserveReasoningEnabled.value = true;
    expect(s.samplingOverride.value.preserve_reasoning).toBe(true);
  });

  it("llama.cpp : défaut du gabarit affiché actif comme avant ; serveur qui ne le déclare pas : masqué", async () => {
    const llama = monter({ supports_preserve_reasoning: true });
    await llama.loadEffectiveParams("m");
    expect([llama.preserveReasoningSupported.value, llama.preserveReasoningEnabled.value]).toEqual([
      true,
      true,
    ]);
    for (const supports of [null, false]) {
      const s = monter({ supports_preserve_reasoning: supports });
      await s.loadEffectiveParams("m");
      expect(s.preserveReasoningSupported.value, String(supports)).toBe(false);
    }
  });
});

/** Montage avec un compte, un ancien stockage navigateur et les écritures PUT observées. */
function monterCompte(ancien: string | null, compte: Record<string, unknown> | null) {
  const stock = new Map<string, string>(ancien === null ? [] : [["sampling_override", ancien]]);
  const puts: unknown[] = [];
  const settings = Vue.ref<{ sampling_override?: unknown }>({});
  const s = setupEchantillonnage(
    Vue,
    {
      selectedModel: Vue.ref(""),
      activeModelIds: Vue.ref([]),
      selectedConnector: Vue.ref(""),
      selectedEngineMeta: Vue.ref<MetaMoteur | null>(null),
      settings,
      ctxUsage: Vue.ref(null),
    },
    {
      fetchAuth: async (_url, init) => {
        puts.push(JSON.parse(String(init.body)));
        return new Response("{}");
      },
      stockage: { getItem: (k) => stock.get(k) ?? null, removeItem: (k) => void stock.delete(k) },
    },
  );
  settings.value = compte === null ? {} : { sampling_override: compte };
  return { s, stock, puts, settings };
}

describe("Réglages rangés sur le compte", () => {
  afterEach(() => vi.useRealTimers());

  it("navigateur seul : écrit sur le compte (PUT sampling_override) puis oublié", async () => {
    vi.useFakeTimers();
    const { s, stock, puts } = monterCompte(JSON.stringify({ temperature: 0.3, max_tokens: 2000 }), null);
    await Vue.nextTick();
    expect(s.samplingOverride.value.temperature).toBe(0.3);
    await vi.advanceTimersByTimeAsync(0);
    expect(puts).toEqual([{ sampling_override: { temperature: 0.3, max_tokens: 2000 } }]);
    expect(stock.has("sampling_override")).toBe(false);
  });

  it("compte déjà renseigné : il fait foi, l'ancien stockage est oublié sans écriture", async () => {
    vi.useFakeTimers();
    const { s, stock, puts } = monterCompte(JSON.stringify({ temperature: 0.3 }), { temperature: 0.9 });
    await Vue.nextTick();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s.samplingOverride.value.temperature).toBe(0.9);
    expect(puts).toEqual([]);
    expect(stock.has("sampling_override")).toBe(false);
  });

  it("une saisie est écrite sur le compte après le délai, une seule fois", async () => {
    vi.useFakeTimers();
    const { s, puts } = monterCompte(null, {});
    await Vue.nextTick();
    s.samplingOverride.value.top_p = 0.5;
    await vi.advanceTimersByTimeAsync(700);
    expect(puts).toEqual([{ sampling_override: { top_p: 0.5 } }]);
  });
});

describe("Mode de longueur", () => {
  it("Auto : clé absente ; Limiter : valeur de la réserve ou 8 192 ; Auto efface, Limiter rend la dernière", async () => {
    const { s } = monterCompte(null, {});
    await Vue.nextTick();
    expect(s.modeLongueur.value).toBe("auto");
    s.choisirModeLongueur("limit");
    expect([s.modeLongueur.value, s.samplingOverride.value.max_tokens]).toEqual(["limit", 8192]);
    s.samplingOverride.value.max_tokens = 3000;
    await Vue.nextTick();
    s.choisirModeLongueur("auto");
    expect([s.modeLongueur.value, s.samplingOverride.value.max_tokens]).toEqual(["auto", null]);
    s.choisirModeLongueur("limit");
    expect(s.samplingOverride.value.max_tokens).toBe(3000);
  });
});

describe("Effort de Claude", () => {
  it("`max` relu depuis le compte et libellé ; une valeur inconnue est écartée", () => {
    expect(lireSurcharge({ reasoning_effort: "max" }).reasoning_effort).toBe("max");
    expect(lireSurcharge({ reasoning_effort: "ultra" }).reasoning_effort).toBeNull();
    expect(libelleEffort("max")).toBe("Maximale");
  });
});
