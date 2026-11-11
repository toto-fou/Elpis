// SPDX-License-Identifier: MIT
/** frontend/test/admin/moteurs.test.ts — console › Inférence : type déclaré (alias de `llama.engine`), profil affiché, rapport de sonde (capacités, conseils, adresses) et bouton « Tester ». */
import type { RapportMoteur } from "@elpis/contracts";
import { createApp, h, nextTick } from "vue";
import type { App, Component } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import CapacitesMoteur from "../../src/components/admin/CapacitesMoteur.vue";
import { profilConsole, typeDeclare } from "../../src/features/admin/moteurs";
import { resumeCharge } from "../../src/features/chat/modeles/charge";

let app: App | null = null;
afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = "";
});

function rapport(champs: Partial<RapportMoteur> = {}): RapportMoteur {
  return {
    cle: "builtin",
    type: "sglang",
    libelle: "SGLang",
    base_url: "http://10.0.0.5:30000",
    joignable: true,
    version: "0.5.21",
    modeles: [{ id: "Qwen/Qwen3-8B", max_model_len: 32768 }],
    modele_declare: "Qwen/Qwen3-8B",
    modele_servi: "Qwen/Qwen3-8B",
    contexte: 32768,
    metriques: false,
    tokenisation: true,
    jetons_en_cache: null,
    parseurs_connus: true,
    parseur_reflexion: "qwen3",
    parseur_outils: null,
    concurrence: { mode: "moteur", max: 48 },
    chargement: false,
    cle_api: true,
    adresses: [
      { role: "santé", chemin: "/health", statut: 200, ok: true },
      { role: "métriques", chemin: "/metrics", statut: 404, ok: false },
    ],
    charge: null,
    conseils: [
      {
        code: "metriques",
        niveau: "avertissement",
        message: "Métriques indisponibles (cache KV, charge du moteur) : ajoutez --enable-metrics.",
      },
    ],
    sonde_a: 1,
    ...champs,
  };
}

function monter(props: Record<string, unknown>, surTester?: () => void): HTMLElement {
  const hote = document.createElement("div");
  document.body.appendChild(hote);
  app = createApp({ render: () => h(CapacitesMoteur as Component, { ...props, onTester: surTester }) });
  app.mount(hote);
  return hote;
}

describe("type déclaré et profil de la console", () => {
  it("mêmes alias que le serveur ; inconnu = générique", () => {
    expect(["vllm", " SGLang ", "llama.cpp", "", "ollama", undefined, 3].map(typeDeclare)).toEqual([
      "vllm",
      "sglang",
      "llamacpp",
      "llamacpp",
      "generic",
      "llamacpp",
      "llamacpp",
    ]);
  });

  it("file d'Elpis pour llama.cpp seul ; concurrence du moteur avec son option", () => {
    expect(profilConsole("llamacpp").file).toBe(true);
    expect(profilConsole("vllm")).toMatchObject({ file: false, port: 8000 });
    expect(profilConsole("vllm").concurrence).toContain("--max-num-seqs");
    expect(profilConsole("sglang")).toMatchObject({ file: false, port: 30000 });
    expect(profilConsole("sglang").concurrence).toContain("--max-running-requests");
  });

  it("ligne de charge : seulement ce que le moteur expose", () => {
    expect(resumeCharge(null)).toBe("");
    expect(resumeCharge({ en_cours: 0, en_attente: null, debit_tps: 0, cache_prefixe_pct: null })).toBe(
      "0 en cours",
    );
    expect(
      resumeCharge({
        en_cours: 2,
        en_attente: 1,
        debit_tps: 41.5,
        cache_prefixe_pct: 63,
        prefill_tps: 3800.4,
        ttft_s: 0.84,
      }),
    ).toBe(
      "2 en cours · 1 en attente · 41,5 jetons/s · prefill 3\u202f800 jetons/s · 1er jeton 0,8 s · cache de préfixe 63 %",
    );
    expect(resumeCharge({ en_cours: 1, prefill_tps: 0, ttft_s: null })).toBe("1 en cours");
  });
});

describe("CapacitesMoteur", () => {
  it("rapport : état, version, capacités, parseurs, conseil avec le drapeau, adresses", async () => {
    let clics = 0;
    const hote = monter({ rapport: rapport(), testable: true }, () => {
      clics += 1;
    });
    await nextTick();
    const texte = hote.textContent?.replace(/\s+/g, " ") ?? "";
    expect(texte).toContain("Joignable");
    expect(texte).toContain("SGLang 0.5.21");
    expect(hote.querySelector('[data-capacite="contexte"]')?.textContent).toMatch(/32\s768 jetons/u);
    expect(hote.querySelector('[data-capacite="concurrence"]')?.textContent).toContain("par le moteur (48)");
    expect(hote.querySelector('[data-capacite="reflexion"]')?.textContent).toContain("qwen3");
    expect(hote.querySelector('[data-capacite="outils"]')?.textContent).toContain("sans parseur");
    expect(hote.querySelector('[data-conseil="metriques"]')?.textContent).toContain("--enable-metrics");
    expect(hote.querySelectorAll("details li")).toHaveLength(2);
    hote.querySelector<HTMLButtonElement>("[data-tester-moteur]")?.click();
    expect(clics).toBe(1);
  });

  it("injoignable : pas de grille, l'erreur seule ; sans rapport : pas encore sondé", async () => {
    const hote = monter({
      rapport: rapport({
        joignable: false,
        conseils: [{ code: "injoignable", niveau: "erreur", message: "SGLang ne répond pas." }],
      }),
    });
    await nextTick();
    expect(hote.textContent).toContain("Injoignable");
    expect(hote.querySelectorAll("[data-capacite]")).toHaveLength(0);
    expect(hote.querySelector("[data-tester-moteur]")).toBeNull();
    app?.unmount();
    const vide = monter({ rapport: null, testable: true });
    await nextTick();
    expect(vide.textContent).toContain("Pas encore sondé.");
  });
});
