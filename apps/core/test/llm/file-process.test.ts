// SPDX-License-Identifier: MIT
/** apps/core/test/llm/file-process.test.ts — instantané de la file rejoué contre le Python, diffuseur partagé, ordonnanceur du process (niveau 1 seul, occupation, réglages des connecteurs, disjoncteur) et diffusion vers main et l'admin. */
import "./environnement-fournisseurs";

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { pyJsonDumps } from "@elpis/commun";
import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { configurerChiffrement } from "@elpis/securite";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { CycleDeVie } from "../../src/cycle";
import { brancherEvenements } from "../../src/evenements/branchement";
import { SystemEvents } from "../../src/evenements/systeme";
import { DiffuseurFile, instantaneFile, reglagesLlm } from "../../src/familles/llm";
import { Journal } from "../../src/journal";
import { brancherDiffusionLlm, brancherLlm } from "../../src/llm/branchement";
import {
  installerRelaisModeles,
  modelCache,
  refreshModelsEverywhere,
  viderCacheModeles,
} from "../../src/llm/cache-modeles";
import { closeLlmClient } from "../../src/llm/client-http";
import { createConnector } from "../../src/llm/connecteurs";
import { invalidate as oublierCaps } from "../../src/llm/fournisseurs/llama-capacites";
import { viderInventaires } from "../../src/llm/fournisseurs/llama-modeles";
import { closeAdminClient } from "../../src/llm/llama-http";
import { invalidateAllModelCaches } from "../../src/llm/modeles";
import { BUILTIN_KEY, builtinEngine, EngineRef, resolveEngineForUser } from "../../src/llm/moteurs";
import { LLMCircuitOpen, LLMQueue } from "../../src/llm/ordonnanceur";
import {
  avecLLM,
  etatFile,
  installerOrdonnanceur,
  moteurDeFile,
  occupation,
  ordonnanceur,
  oublierServeur,
  portDisjoncteur,
  preparerServeur,
  sourcesDuProcess,
  tenirModele,
} from "../../src/llm/ordonnanceur/process";
import { diffusion, installerDiffusion } from "../../src/llm/ports";
import { journalMuet } from "../aides";
import {
  appAuthentifiee,
  attendreQue,
  environnementAuth,
  JETON_INTERNE,
  SOURCE_TEST,
} from "../evenements/aides";
import { lireVecteurs } from "../vecteurs-moteur";
import { fauxLlama, FauxServeur, portFerme } from "./faux-serveur";

type Dict = Record<string, unknown>;

const V = lireVecteurs<{ ts: number; cas: { stats: Dict; flux: string; reponse: string }[] }>("llm-file");
const PROPS_ROUTEUR = { build_info: "b10545-abc", role: "router", total_slots: 1 };
const INVENTAIRE = {
  data: [
    { id: "golden-model", status: { value: "loaded" } },
    { id: "m", status: { value: "unloaded" } },
  ],
};
const reglagesAvant = { ...reglagesLlm };
let dossier: string;

beforeAll(() => {
  dossier = mkdtempSync(path.join(tmpdir(), "elpis-file-process-"));
  configurerChiffrement({ cleEnv: "unit-test-master-key", fichierCle: path.join(dossier, ".k") });
});

afterAll(() => {
  rmSync(dossier, { recursive: true, force: true });
});

afterEach(() => {
  Object.assign(reglagesLlm, reglagesAvant);
});

/** Moteur pointé sur un faux llama-server, ordonnanceur et caches remis à neuf. */
function moteurSur(llama: FauxServeur): () => Promise<void> {
  const restaurer = surchargerConfig({
    LLAMA_URL: `${llama.url}/v1/chat/completions`,
    LLAMA_PROVIDER_TYPE: "llamacpp",
    LLAMA_MODEL: "golden-model",
    LLAMA_MAX_MODELS: 1,
    LLAMA_MAX_CONCURRENCY: 2,
    LLM_SCHEDULING_MODE: "classic",
    CONFIG_JSON_PATH: path.join(dossier, "absent.json"),
  });
  installerOrdonnanceur(null);
  oublierCaps();
  viderInventaires();
  invalidateAllModelCaches();
  viderCacheModeles();
  return async () => {
    installerOrdonnanceur(null);
    viderCacheModeles();
    restaurer();
    await closeLlmClient();
    await closeAdminClient();
  };
}

describe("instantané de la file rejoué contre le Python (_build_snapshot)", () => {
  it.each(V.cas.map((c, i) => [i, c] as const))(
    "cas %i : flux SSE (ASCII) et réponse JSON (UTF-8)",
    (_i, c) => {
      const instantane = instantaneFile(c.stats, V.ts);
      expect(pyJsonDumps(instantane, { separators: [",", ":"] })).toBe(c.flux);
      expect(pyJsonDumps(instantane, { ensureAscii: false, separators: [",", ":"] })).toBe(c.reponse);
    },
  );
});

describe("diffuseur de la file (_QueueStatusBroadcaster)", () => {
  it("boucle lancée au premier abonné, arrêtée après le dernier ; un nouvel abonné reçoit le dernier instantané puis une boucle neuve (B14)", async () => {
    reglagesLlm.intervalleMs = 20;
    let n = 0;
    const d = new DiffuseurFile(() => ({ n: ++n }));
    expect(d.actif).toBe(false);
    const a = d.abonner();
    expect(d.actif).toBe(true);
    expect(await a.prendre(1_000)).toEqual({ n: 1 });
    expect(await a.prendre(1_000)).toEqual({ n: 2 });
    d.desabonner(a);
    await attendreQue(() => !d.actif, 2_000, "arrêt de la boucle");
    const dernier = n;
    await new Promise((ok) => setTimeout(ok, 60));
    expect(n).toBe(dernier);
    const b = d.abonner();
    expect(d.actif).toBe(true);
    expect(await b.prendre(1_000)).toEqual({ n: dernier });
    expect(await b.prendre(1_000)).toEqual({ n: dernier + 1 });
    d.desabonner(b);
    await attendreQue(() => !d.actif, 2_000, "second arrêt");
  });

  it("file bornée à 4 : un abonné lent garde les derniers ; une panne d'instantané est journalisée, la boucle continue", async () => {
    reglagesLlm.intervalleMs = 5;
    const lignes: string[] = [];
    let n = 0;
    const d = new DiffuseurFile(
      () => {
        n += 1;
        if (n === 2) throw new Error("panne");
        return { n };
      },
      new Journal({ niveau: "debug", sortie: (l) => lignes.push(l) }),
    );
    const a = d.abonner();
    await attendreQue(() => n >= 10, 5_000, "dix tours");
    const vus = (a.contenu() as { n: number }[]).map((x) => x.n);
    expect(vus).toHaveLength(4);
    expect(vus.every((v, i) => i === 0 || v === (vus[i - 1] ?? 0) + 1)).toBe(true);
    expect(vus[0]).toBeGreaterThan(2);
    expect(lignes.join("\n")).toContain("[queue-status] snapshot error: panne");
    d.desabonner(a);
    await attendreQue(() => !d.actif, 2_000, "arrêt");
  });
});

describe("ordonnanceur du process", () => {
  let t: BaseDeTest;
  let llama: FauxServeur;
  let finir: () => Promise<void>;

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    await initialiserBase(t.base);
    await t.base.run(
      "INSERT INTO users(username, pass_salt, pass_hash, created_at, is_admin) VALUES ('bob', 's', 'h', 0, 0)",
    );
    brancherLlm(t.base);
    llama = await fauxLlama({ props: PROPS_ROUTEUR, modeles: INVENTAIRE });
    finir = moteurSur(llama);
  });

  afterEach(async () => {
    await finir();
    await llama.arreter();
    await t.fermer();
  });

  it("tenirModele : le niveau 1 seul (ni créneau, ni disjoncteur) ; occupation ; un autre modèle attend la libération", async () => {
    installerOrdonnanceur(
      new LLMQueue({ ...sourcesDuProcess(), disjoncteur: { enabled: true, failsToOpen: 1, cooldownS: 60 } }),
    );
    ordonnanceur().disjoncteur(BUILTIN_KEY).recordFailure("a");
    await expect(
      avecLLM(builtinEngine(), "a", "high", undefined, () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(LLMCircuitOpen);
    const tenu = await tenirModele(builtinEngine(), "a");
    expect(occupation(builtinEngine())).toEqual({ current_model: "a", active_count: 1 });
    expect(ordonnanceur().stats(BUILTIN_KEY).active_models).toEqual([]);
    let entre = false;
    const autre = avecLLM(builtinEngine(), "b", "high", undefined, () => {
      entre = true;
      return Promise.resolve(7);
    });
    await new Promise((ok) => setTimeout(ok, 50));
    expect(entre).toBe(false);
    tenu.release();
    expect(await autre).toBe(7);
    expect(occupation(builtinEngine())).toEqual({ current_model: null, active_count: 0 });
  });

  it("disjoncteur ouvert : échec immédiat même quand le serveur accepte sans jamais répondre (allow avant toute sonde)", async () => {
    const fige = await FauxServeur.demarrer({ "*": () => new Promise<void>(() => undefined) });
    const restaurer = surchargerConfig({ LLAMA_URL: `${fige.url}/v1/chat/completions` });
    try {
      invalidateAllModelCaches();
      installerOrdonnanceur(
        new LLMQueue({
          ...sourcesDuProcess(),
          disjoncteur: { enabled: true, failsToOpen: 1, cooldownS: 60 },
        }),
      );
      ordonnanceur().disjoncteur(BUILTIN_KEY).recordFailure("golden-model");
      const debut = performance.now();
      await expect(
        avecLLM(builtinEngine(), null, "high", undefined, () => Promise.resolve(1)),
      ).rejects.toBeInstanceOf(LLMCircuitOpen);
      expect(performance.now() - debut).toBeLessThan(500);
      expect(fige.requetes).toEqual([]);
    } finally {
      restaurer();
      await fige.arreter();
    }
  });

  it("état du widget : inventaire du routeur relu (prêt, chargement) ; serveur hors file = prêt, sans attente", async () => {
    expect(await etatFile("golden-model")).toEqual({ kind: "ready" });
    expect(await etatFile("m")).toMatchObject({
      kind: "loading",
      model: "m",
      loaded: "golden-model",
      position: 1,
    });
    const cloud = new EngineRef({ key: "conn:9", baseRoot: "http://127.0.0.1:1", providerType: "openai" });
    expect(moteurDeFile(cloud)).toEqual({ id: "conn:9", enFile: false });
    expect(moteurDeFile(builtinEngine())).toEqual({ id: BUILTIN_KEY, enFile: true });
    expect(await etatFile("gpt", cloud)).toEqual({ kind: "ready", model: "gpt" });
    expect(await etatFile(null, cloud)).toEqual({ kind: "ready", model: "" });
    expect(await avecLLM(cloud, "gpt", "low", undefined, (slot) => Promise.resolve(slot.server))).toBe(
      "conn:9",
    );
    expect(occupation(cloud)).toEqual({ current_model: null, active_count: 0 });
  });

  it("réglages d'un connecteur : politique relue en base, créneaux de son /props, oubli après modification", async () => {
    const routeur = await fauxLlama({ props: { ...PROPS_ROUTEUR, total_slots: 4 }, modeles: INVENTAIRE });
    try {
      const cid = await createConnector(t.base, {
        scope: "shared",
        provider_type: "llamacpp",
        wire: "openai",
        base_url: routeur.url,
        max_models: 2,
        max_concurrency: 3,
      });
      const eng = await resolveEngineForUser(1, `conn:${cid}`);
      if (eng === null) throw new Error("connecteur introuvable");
      await preparerServeur(eng);
      expect(ordonnanceur().stats(eng.key)).toMatchObject({
        max_models: 2,
        max_conversations_per_model_config_fallback: 3,
        total_slots_from_props: 4,
      });
      await t.base.run("UPDATE llm_connectors SET max_models=NULL, max_concurrency=1 WHERE id=?", [cid]);
      await preparerServeur(eng);
      expect(ordonnanceur().stats(eng.key)).toMatchObject({ max_models: 2 });
      oublierServeur(eng.key);
      await preparerServeur(eng);
      expect(ordonnanceur().stats(eng.key)).toMatchObject({
        max_models: 1,
        max_conversations_per_model_config_fallback: 1,
      });
    } finally {
      await routeur.arreter();
    }
  });

  it("disjoncteur du moteur : une panne de transport vue hors du garde compte pour le modèle effectif", async () => {
    installerOrdonnanceur(
      new LLMQueue({ ...sourcesDuProcess(), disjoncteur: { enabled: true, failsToOpen: 2, cooldownS: 60 } }),
    );
    const port = portDisjoncteur();
    port.signalerPanneTransport(builtinEngine(), null);
    expect(ordonnanceur().disjoncteur(BUILTIN_KEY).etats.get("golden-model")?.fails).toBe(1);
    port.signalerPanneTransport(builtinEngine(), "golden-model");
    await expect(
      avecLLM(builtinEngine(), null, "high", undefined, () => Promise.resolve(1)),
    ).rejects.toBeInstanceOf(LLMCircuitOpen);
  });
});

describe("diffusion du moteur (refresh_models_everywhere)", () => {
  it("main publie model_status sur le canal lu par l'admin ; dans l'admin, seul main émet les model_status et le relais le fait rafraîchir (une requête), sans échec si main est absent", async () => {
    const env = await environnementAuth();
    const llama = await fauxLlama({ props: PROPS_ROUTEUR, modeles: INVENTAIRE });
    const finir = moteurSur(llama);
    const cycle = new CycleDeVie(journalMuet);
    let rafraichis = 0;
    const evt = brancherEvenements({
      mode: "main",
      cycle,
      auth: env.dep,
      redemarrage: SOURCE_TEST,
      journal: journalMuet,
      rafraichirModeles: () => {
        rafraichis += 1;
      },
    });
    const { app } = await appAuthentifiee("main", evt.famille, env.dep);
    await app.listen({ port: 0, host: "127.0.0.1" });
    try {
      brancherDiffusionLlm({ systemEvents: evt.systemEvents });
      await refreshModelsEverywhere();
      const publies = (evt.canal?.lire(0).entrees ?? []).map((e) => JSON.parse(e.donnees) as Dict);
      expect(publies).toMatchObject([
        { type: "model_status", data: { models: ["golden-model", "m"], server_reachable: true } },
      ]);
      expect(rafraichis).toBe(0);

      const busAdmin = new SystemEvents();
      const vus: Dict[] = [];
      busAdmin.surDiffusion((m) => void vus.push(m));
      viderCacheModeles();
      const urlMain = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      brancherDiffusionLlm({
        systemEvents: busAdmin,
        versMain: { url: urlMain, jeton: () => JETON_INTERNE, journal: journalMuet },
      });
      await refreshModelsEverywhere();
      expect(rafraichis).toBe(1);
      expect(vus).toEqual([]);
      expect(modelCache).toMatchObject({ models: ["golden-model", "m"] });
      expect(evt.canal?.lire(0).entrees).toHaveLength(1);
      diffusion().diffuser({ type: "log", message: "[LLM] journal de l'admin", level: "INFO" });
      diffusion().diffuser({ type: "model_changed", data: {} });
      expect(busAdmin.getRecentLogs().map((e) => e.message)).toEqual(["[LLM] journal de l'admin"]);
      expect(vus.map((m) => m["type"])).toEqual(["model_changed"]);

      brancherDiffusionLlm({
        systemEvents: busAdmin,
        versMain: { url: `http://127.0.0.1:${await portFerme()}`, jeton: () => JETON_INTERNE },
      });
      await expect(refreshModelsEverywhere()).resolves.toBeUndefined();
      expect(rafraichis).toBe(1);
    } finally {
      installerDiffusion(null);
      installerRelaisModeles(null);
      await app.close();
      await finir();
      await llama.arreter();
      await env.t.fermer();
    }
  });
});
