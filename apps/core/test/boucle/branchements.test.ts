// SPDX-License-Identifier: MIT
/** apps/core/test/boucle/branchements.test.ts — ports de la boucle posés par la composition : file unique du process (tours, sous-agents, créneaux d'images), prompts de capacité, vision, todos du chat. */
import "../llm/environnement-fournisseurs";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createUser, getUser } from "@elpis/auth";
import { surchargerConfig } from "@elpis/config";
import type { Executeur } from "@elpis/db";
import { initialiserBase } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  brancherBoucle,
  fileDuProcess,
  todosDuProcess,
  visionDuProcess,
} from "../../src/boucle/branchements";
import {
  fileLlm,
  installerFileLlm,
  installerTodos,
  installerVisionBureau,
  portTodos,
  portVisionBureau,
} from "../../src/boucle/ports";
import { getChatTodos, setChatTodos, upsertChat } from "../../src/chats/stockage";
import { installerPromptsCapacites, portPromptsCapacites } from "../../src/contexte/ports";
import {
  appelEnrichissement,
  fileImages,
  installerAppelEnrichissement,
  installerFileImages,
  reglerCapacite,
} from "../../src/images/ports";
import { prendreCreneau } from "../../src/images/service";
import { brancherLlm } from "../../src/llm/branchement";
import { closeLlmClient } from "../../src/llm/client-http";
import { closeAdminClient } from "../../src/llm/llama-http";
import { BUILTIN_KEY, builtinEngine } from "../../src/llm/moteurs";
import { LLMQueue } from "../../src/llm/ordonnanceur";
import {
  installerOrdonnanceur,
  occupation,
  ordonnanceur,
  sourcesDuProcess,
} from "../../src/llm/ordonnanceur/process";
import { buildCapabilityBlock, capabilityWantsRuntimeContext } from "../../src/prompts/systeme";
import { fauxLlama } from "../llm/faux-serveur";
import type { FauxServeur } from "../llm/faux-serveur";

let t: BaseDeTest;
let llama: FauxServeur;
let restaurer: () => void;
let temporaire = "";

beforeEach(async () => {
  temporaire = mkdtempSync(path.join(tmpdir(), "elpis-branchements-"));
  t = ouvrirBaseDeTest("sqlite");
  await initialiserBase(t.base);
  brancherLlm(t.base);
  llama = await fauxLlama({ props: { total_slots: 1 }, modeles: { data: [] } });
  restaurer = surchargerConfig({
    LLAMA_URL: `${llama.url}/v1/chat/completions`,
    LLAMA_PROVIDER_TYPE: "llamacpp",
    LLAMA_MODEL: "golden-model",
    LLAMA_MAX_MODELS: 1,
    LLAMA_MAX_CONCURRENCY: 1,
    LLM_SCHEDULING_MODE: "classic",
    CONFIG_JSON_PATH: path.join(temporaire, "absent.json"),
  });
  installerOrdonnanceur(null);
});

afterEach(async () => {
  installerFileLlm(null);
  installerFileImages(null);
  installerAppelEnrichissement(null);
  installerPromptsCapacites(null);
  installerVisionBureau(null);
  installerTodos(null);
  installerOrdonnanceur(null);
  restaurer();
  await closeLlmClient();
  await closeAdminClient();
  await llama.arreter();
  await t.fermer();
  rmSync(temporaire, { recursive: true, force: true });
});

describe("brancherBoucle", () => {
  it("pose les implémentations réelles derrière les ports aux noms Python", () => {
    brancherBoucle(t.base);
    expect(fileLlm()).toBe(fileDuProcess);
    expect(fileImages()).toBe(ordonnanceur());
    expect(appelEnrichissement()).not.toBeNull();
    expect(portPromptsCapacites()).toEqual({ capabilityWantsRuntimeContext, buildCapabilityBlock });
    expect(portVisionBureau()).toBe(visionDuProcess);
    expect(portTodos()).not.toBeNull();
    installerOrdonnanceur(new LLMQueue(sourcesDuProcess()));
    expect(fileImages()).toBe(ordonnanceur());
  });

  it("un tour passe par la file unique du process (moteur courant, disjoncteur, réglages relus)", async () => {
    brancherBoucle(t.base);
    const vu = await fileDuProcess.withLLM("golden-model", "high", undefined, async (slot) => {
      expect(slot.server).toBe(BUILTIN_KEY);
      return occupation(builtinEngine());
    });
    expect(vu).toEqual({ current_model: "golden-model", active_count: 1 });
    expect(occupation(builtinEngine())).toEqual({ current_model: null, active_count: 0 });
  });

  it("tour avec outils en optimized : le modèle est tenu, le créneau seulement pendant chaque appel", async () => {
    const remettre = surchargerConfig({ LLM_SCHEDULING_MODE: "optimized" });
    try {
      brancherBoucle(t.base);
      let liberer = (): void => undefined;
      const tenu = new Promise<void>((ok) => (liberer = ok));
      const a = fileDuProcess.withLLM("golden-model", "high", undefined, () => tenu, { outils: true });
      let entre = false;
      const b = fileDuProcess.withLLM(
        "golden-model",
        "high",
        undefined,
        async (slot) => {
          entre = true;
          return slot.appelLLM(async () => 7);
        },
        { outils: true },
      );
      expect(await b).toBe(7);
      expect(entre).toBe(true);
      liberer();
      await a;
    } finally {
      remettre();
    }
  });

  it("créneaux d'images dans la même file : politique `image:` (capacité du moteur), attente au-delà", async () => {
    brancherBoucle(t.base);
    const url = "http://images.local:7860";
    const server = "image:" + url;
    expect(sourcesDuProcess().politique(server)).toEqual({ maxModels: 1, maxConcurrency: 1 });
    expect(sourcesDuProcess().politique(BUILTIN_KEY)).toEqual({ maxModels: 1, maxConcurrency: 1 });
    const a = await prendreCreneau(url, 2, "high", undefined, () => undefined);
    const b = await prendreCreneau(url, 2, "high", undefined, () => undefined);
    expect(sourcesDuProcess().politique(server)).toEqual({ maxModels: 1, maxConcurrency: 2 });
    expect(ordonnanceur().stats(server).max_conversations_per_model_config_fallback).toBe(2);
    let attentes = 0;
    const c = prendreCreneau(url, 2, "low", undefined, () => {
      attentes += 1;
    });
    await new Promise((ok) => setTimeout(ok, 20));
    expect(attentes).toBe(1);
    a.rendre();
    (await c).rendre();
    b.rendre();
    reglerCapacite(server, 1);
  });

  it("capture d'un outil `pw_*` : URL, pas et session ; rien pour un autre outil", () => {
    const ss = visionDuProcess.extractPwScreenshotUrl(
      "pw_click",
      { session_id: "sess-0001" },
      '{"ok": true, "screenshot_step": 3}',
    );
    expect(ss).toMatchObject({ step: 3, session_id: "sess-0001" });
    expect(ss?.url).toMatch(/^\/api\/playwright\/screenshot\/step_sess-0001_3\.png\?t=\d+$/);
    expect(visionDuProcess.extractPwScreenshotUrl("read_file", {}, "{}")).toBeNull();
  });

  it("todos du chat : compte résolu une fois (cache), chat inconnu vide, compte inconnu null", async () => {
    await createUser(t.base, "alice", "mdp-alice", { isAdmin: 0 });
    const uid = Number((await getUser(t.base, "alice"))!.id);
    await upsertChat(t.base, uid, "c1", "Titre", [], 1_700_000_000);
    await setChatTodos(t.base, uid, "c1", [{ content: "a", status: "in_progress" }]);
    let lecturesComptes = 0;
    const compteur = new Proxy(t.base, {
      get(cible, nom, recepteur) {
        const v: unknown = Reflect.get(cible, nom, recepteur);
        if (nom !== "get" || typeof v !== "function") return v;
        return (sql: string, ...reste: unknown[]) => {
          if (sql.includes("FROM users")) lecturesComptes += 1;
          return (v as (...a: unknown[]) => unknown).call(cible, sql, ...reste);
        };
      },
    }) as Executeur;
    const port = todosDuProcess(compteur);
    expect(await port.todosDuChat("alice", "c1")).toEqual(await getChatTodos(t.base, uid, "c1"));
    expect(await port.todosDuChat("alice", "c1")).toHaveLength(1);
    expect(await port.todosDuChat("alice", "inconnu")).toEqual([]);
    expect(lecturesComptes).toBe(1);
    expect(await port.todosDuChat("bob", "c1")).toBeNull();
  });
});
