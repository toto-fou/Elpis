// SPDX-License-Identifier: MIT
/** apps/core/test/images/service.test.ts — capacités en cache, créneaux de la file commune (attente, Stop, priorités, délai), génération rangée par compte, enrichissement. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished } from "vitest";

import { surchargerConfig } from "@elpis/config";
import { initialiserBase } from "@elpis/db";
import type { Base } from "@elpis/db";
import { ouvrirBaseDeTest } from "@elpis/db/test";
import type { BaseDeTest } from "@elpis/db/test";

import { imageRequest } from "../../src/images/base";
import type { ImageError } from "../../src/images/base";
import { enhancePrompt, systemPrompt } from "../../src/images/enrichissement";
import { recentTimings, root, saveImages } from "../../src/images/magasin";
import { fileImages, installerFileImages } from "../../src/images/ports";
import {
  capabilities,
  estimateSeconds,
  forgetCapabilities,
  generateAndStore,
  prendreCreneau,
  ProgressTracker,
  runGeneration,
} from "../../src/images/service";
import { portFerme } from "../llm/faux-serveur";
import { FauxMoteur } from "./faux-moteur";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAUklEQVR4nO3PMQ0AIADAMEAI/qUgCxEcDcmqYJtn7/GzpQNeNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oDWgNaA1oF2vFwFk2XER3gAAAABJRU5ErkJggg==",
  "base64",
);
const json = (v: unknown): { texte: string } => ({ texte: JSON.stringify(v) });
const attendre = (ms: number): Promise<void> => new Promise((ok) => setTimeout(ok, ms));
const sansSuivi = (): void => undefined;

let moteur: FauxMoteur;
beforeAll(async () => {
  moteur = await FauxMoteur.demarrer();
});
afterAll(async () => {
  await moteur.arreter();
});

describe("capacités du moteur", () => {
  beforeEach(() => forgetCapabilities());

  it("gardées 60 s ; un échec de connexion gardé 10 s (pas de nouvelle tentative)", async () => {
    moteur.file("GET /sdcpp/v1/capabilities", [json({ model: { name: "m" }, limits: {} })]);
    const cfg = { provider: "sdcpp", url: moteur.url };
    const avant = moteur.sur("/sdcpp/v1/capabilities").length;
    expect((await capabilities(cfg))["model"]).toBe("m");
    expect((await capabilities(cfg))["model"]).toBe("m");
    expect(moteur.sur("/sdcpp/v1/capabilities").length - avant).toBe(1);
    const panne = { provider: "sdcpp", url: `http://127.0.0.1:${await portFerme()}` };
    const premiere = await capabilities(panne).catch((e: unknown) => e);
    for (let i = 0; i < 3; i++) await expect(capabilities(panne)).rejects.toBe(premiere);
    expect((premiere as ImageError).code).toBe("unavailable");
    expect(await capabilities({ provider: "openai", url: moteur.url })).toEqual({});
  });

  it("réponse inattendue : `{}` sans cache (le moteur tranchera à la soumission)", async () => {
    moteur.file("GET /sdcpp/v1/capabilities", [{ statut: 500, texte: "x" }]);
    const cfg = { provider: "sdcpp", url: moteur.url, verify: true };
    const avant = moteur.sur("/sdcpp/v1/capabilities").length;
    expect(await capabilities(cfg)).toEqual({});
    expect(await capabilities(cfg)).toEqual({});
    expect(moteur.sur("/sdcpp/v1/capabilities").length - avant).toBe(2);
  });
});

describe("créneaux : un serveur d'images de plus dans la file commune", () => {
  afterEach(() => installerFileImages(null));

  it("tous pris : `onWait` une fois, puis le créneau passe au suivant ; adresses indépendantes", async () => {
    const attentes: string[] = [];
    const a = await prendreCreneau("http://gpu", 1, "high", undefined, () => attentes.push("a"));
    expect(attentes).toEqual([]);
    const second = prendreCreneau("http://gpu", 1, "high", undefined, () => attentes.push("b"));
    await attendre(20);
    expect(attentes).toEqual(["b"]);
    const autre = await prendreCreneau("http://autre", 1, "high", undefined, () => attentes.push("c"));
    a.rendre();
    const b = await second;
    b.rendre();
    autre.rendre();
    expect(attentes).toEqual(["b"]);
    expect(fileImages().status("image:http://gpu", "image").kind).toBe("ready");
  });

  it("`high` passe devant `low` ; Stop pendant l'attente : « cancelled », sans créneau pris", async () => {
    const ordre: string[] = [];
    const tenu = await prendreCreneau("http://prio", 1, "high", undefined, sansSuivi);
    const bas = prendreCreneau("http://prio", 1, "low", undefined, sansSuivi).then((c) => {
      ordre.push("low");
      return c;
    });
    const haut = prendreCreneau("http://prio", 1, "high", undefined, sansSuivi).then((c) => {
      ordre.push("high");
      return c;
    });
    const stop = new AbortController();
    const annule = prendreCreneau("http://prio", 1, "high", stop.signal, sansSuivi);
    await attendre(10);
    stop.abort();
    const e = await annule.catch((x: unknown) => x);
    expect([(e as ImageError).code, (e as ImageError).message]).toEqual(["cancelled", "Génération annulée."]);
    tenu.rendre();
    (await haut).rendre();
    (await bas).rendre();
    expect(ordre).toEqual(["high", "low"]);
  });

  it("`onWait` qui lève (émission coupée) : la demande quitte la file, aucun créneau ne reste tenu", async () => {
    const tenu = await prendreCreneau("http://emit", 1, "high", undefined, sansSuivi);
    const coupee = await prendreCreneau("http://emit", 1, "high", undefined, () => {
      throw new Error("emit KO");
    }).catch((x: unknown) => x);
    expect((coupee as Error).message).toBe("emit KO");
    const serviePendant = await prendreCreneau("http://emit", 1, "high", undefined, async () => {
      tenu.rendre();
      await attendre(10);
      throw new Error("emit KO");
    }).catch((x: unknown) => x);
    expect((serviePendant as Error).message).toBe("emit KO");
    const attentes: string[] = [];
    const suivant = await Promise.race([
      prendreCreneau("http://emit", 1, "high", undefined, () => attentes.push("attente")),
      attendre(1000).then(() => null),
    ]);
    expect(suivant).not.toBeNull();
    expect(attentes).toEqual([]);
    suivant?.rendre();
    expect(
      fileImages()
        .stats("image:http://emit")
        .active_models.every((m) => m.shared_busy === 0),
    ).toBe(true);
  });

  it("attente au-delà du plafond : « busy »", async () => {
    const tenu = await prendreCreneau("http://lent", 1, "high", undefined, sansSuivi);
    const e = await prendreCreneau("http://lent", 1, "high", undefined, sansSuivi, 0.05).catch(
      (x: unknown) => x,
    );
    expect([(e as ImageError).code, (e as ImageError).message]).toEqual([
      "busy",
      "Moteur d'images occupé trop longtemps.",
    ]);
    tenu.rendre();
  });

  it("Stop d'une génération OpenAI : le créneau reste tenu jusqu'à la fin estimée du calcul distant", async () => {
    const m = await FauxMoteur.demarrer();
    try {
      m.route("POST /v1/images/generations", () => undefined);
      const cfg = { provider: "openai", url: m.url, model: "m", max_concurrent: 1, timeout_sec: 60 };
      const stop = new AbortController();
      const etats: string[] = [];
      const p = runGeneration(
        cfg,
        imageRequest({ prompt: "x", width: 64, height: 64 }),
        (state) => {
          etats.push(state);
          if (state === "generating") setTimeout(() => stop.abort(), 20);
        },
        stop.signal,
        { etaS: 0.3 },
      );
      const e = await p.catch((x: unknown) => x);
      expect((e as ImageError).code).toBe("cancelled");
      const attentes: string[] = [];
      const t0 = performance.now();
      const suivant = await prendreCreneau(m.url, 1, "high", undefined, () => attentes.push("attente"));
      expect(attentes).toEqual(["attente"]);
      expect(performance.now() - t0).toBeGreaterThan(150);
      suivant.rendre();
      expect(etats).toEqual(["generating"]);
    } finally {
      await m.arreter();
    }
  });

  it("sd-server ne prend pas de créneau : sa propre file publie la position", async () => {
    moteur.file("POST /sdcpp/v1/img_gen", [{ statut: 202, ...json({ id: "s1" }) }]);
    moteur.file("GET /sdcpp/v1/jobs/s1", [
      json({ status: "completed", result: { images: [PNG.toString("base64")] } }),
    ]);
    const out = await runGeneration(
      { provider: "sdcpp", url: moteur.url, max_concurrent: 1 },
      imageRequest({ prompt: "x", width: 64, height: 64, seed: 4 }),
      sansSuivi,
    );
    expect(out.map((r) => r.seed)).toEqual([4]);
    expect(fileImages().stats("image:" + moteur.url).active_models).toEqual([]);
  });
});

describe("génération rangée par compte (magasin)", () => {
  let t: BaseDeTest;
  let base: Base;
  let dossier: string;
  let restaurer: () => void;

  beforeEach(async () => {
    t = ouvrirBaseDeTest("sqlite");
    base = t.base;
    await initialiserBase(base);
    dossier = mkdtempSync(join(tmpdir(), "elpis-images-"));
    restaurer = surchargerConfig({ DB_PATH: join(dossier, "app.db") });
    for (const [id, nom] of [
      [1, "alice"],
      [2, "bob"],
    ] as const)
      await base.run(
        "INSERT INTO users (id, username, pass_salt, pass_hash, created_at) VALUES (?, ?, '', '', 0)",
        [id, nom],
      );
  });
  afterEach(async () => {
    restaurer();
    await t.fermer();
    rmSync(dossier, { recursive: true, force: true });
  });

  const resultat = (seed: number | null, revise = "") => ({
    data: PNG,
    mime: "image/png",
    width: 64,
    height: 48,
    seed,
    revisedPrompt: revise,
    extra: {},
  });

  it("fichiers sous le dossier du compte, vignette WebP, références sans URL arbitraire, ligne complète", async () => {
    const refs = await saveImages(base, 1, "chat1", "un chat", {
      model: "m".repeat(300),
      params: { size: "64x48", provider: "sdcpp", negative_prompt: "é", steps: 4, edit: false },
      results: [resultat(7, "rp"), resultat(8)],
      keep: 50,
      steps: 4,
      durationS: 2.5,
    });
    expect(refs.map((r) => [r.url, r.thumb_url, r.width, r.height, r.mime, r.seed])).toEqual(
      refs.map((r) => [`/api/images/${r.id}`, `/api/images/${r.id}?thumb=1`, 64, 48, "image/png", r.seed]),
    );
    expect(refs.map((r) => r.seed)).toEqual([7, 8]);
    expect(readdirSync(join(root(), "1")).sort()).toEqual(
      refs.flatMap((r) => [`${r.id}.png`, `${r.id}.thumb.webp`]).sort(),
    );
    const lignes = await base.all("SELECT * FROM generated_images ORDER BY created_at");
    expect(
      lignes.map((l) => [
        l["user_id"],
        l["chat_id"],
        l["prompt"],
        l["steps"],
        l["megapixels"],
        l["duration_s"],
      ]),
    ).toEqual([
      [1, "chat1", "un chat", 4, 0.0061, 2.5],
      [1, "chat1", "un chat", 4, 0.0061, null],
    ]);
    expect(String(lignes[0]?.["model"]).length).toBe(191);
    expect(lignes[0]?.["params_json"]).toBe(
      '{"size": "64x48", "provider": "sdcpp", "negative_prompt": "é", "steps": 4, "edit": false, "seed": 7, "revised_prompt": "rp"}',
    );
    expect(await recentTimings(base, "m".repeat(191), 4)).toEqual([[2.5, 0.0061]]);
  });

  it("rétention du compte (jamais moins que le lot) ; conversations disparues ramassées après le délai de grâce", async () => {
    const lot = { model: "m", params: {}, keep: 2 };
    const vieux = await saveImages(base, 1, null, "a", { ...lot, results: [resultat(1)] });
    await base.run("UPDATE generated_images SET created_at = created_at - 10000");
    await base.run(
      "INSERT INTO chats (id, user_id, title, messages_json, updated_at) VALUES ('vivant', 1, 't', '[]', 0)",
    );
    const orphelin = await saveImages(base, 1, "disparu", "b", { ...lot, keep: 50, results: [resultat(2)] });
    await base.run("UPDATE generated_images SET created_at = created_at - 8000 WHERE id = ?", [
      orphelin[0]?.id ?? "",
    ]);
    const bob = await saveImages(base, 2, null, "c", { ...lot, results: [resultat(3)] });
    const nouveaux = await saveImages(base, 1, "vivant", "d", {
      ...lot,
      results: [resultat(4), resultat(5), resultat(6)],
    });
    const ids = (await base.all("SELECT id FROM generated_images ORDER BY id")).map((l) => l["id"]);
    expect(ids).toEqual([...nouveaux, ...bob].map((r) => r.id).sort());
    expect(existsSync(join(root(), "1", `${vieux[0]?.id}.png`))).toBe(false);
    expect(existsSync(join(root(), "1", `${orphelin[0]?.id}.thumb.webp`))).toBe(false);
  });

  it("échec de l'inscription : les fichiers déjà écrits sont retirés", async () => {
    const panne = Object.create(base) as Base;
    panne.transaction = () => Promise.reject(new Error("base indisponible"));
    await expect(
      saveImages(panne, 1, null, "x", { model: "m", params: {}, keep: 5, results: [resultat(1)] }),
    ).rejects.toThrow("base indisponible");
    expect(readdirSync(join(root(), "1"))).toEqual([]);
  });

  it("generateAndStore : moteur, magasin, durée mesurée et estimation suivante", async () => {
    moteur.file("POST /sdcpp/v1/img_gen", [{ statut: 202, ...json({ id: "g1" }) }]);
    moteur.file("GET /sdcpp/v1/jobs/g1", [
      json({ status: "generating" }),
      json({ status: "completed", result: { images: [PNG.toString("base64")] } }),
    ]);
    const horloge = { t: 100 };
    const req = imageRequest({ prompt: "x", width: 64, height: 64, seed: 9, steps: 3 });
    const tracker = new ProgressTracker(req, null, { monotone: () => (horloge.t += 0.5), murale: () => 0 });
    const vus: string[] = [];
    const { refs, meta } = await generateAndStore(
      { provider: "sdcpp", url: moteur.url, model: "cfg-modele", keep_per_user: 10 },
      req,
      {
        userId: 2,
        chatId: null,
        prompt: "x",
        caps: { model: "sd-modele" },
        onProgress: (s) => vus.push(s),
        tracker,
        extra: { source: "tool" },
        base,
      },
    );
    expect(vus).toEqual(["generating"]);
    expect(meta["model"]).toBe("sd-modele");
    expect(typeof meta["duration_s"]).toBe("number");
    const ligne = await base.get("SELECT params_json, model, duration_s FROM generated_images WHERE id = ?", [
      refs[0]?.id ?? "",
    ]);
    expect(JSON.parse(String(ligne?.["params_json"]))).toEqual({
      size: "64x64",
      provider: "sdcpp",
      negative_prompt: "",
      steps: 3,
      edit: false,
      source: "tool",
      seed: 9,
    });
    expect(await estimateSeconds(base, "sd-modele", req)).toBeGreaterThanOrEqual(1);
    expect(await estimateSeconds(base, "inconnu", req)).toBeNull();
  });
});

describe("enrichissement de la description", () => {
  it("prompt système du dépôt, sortie nettoyée ; panne : demande telle quelle ; Stop : remonte", async () => {
    expect(systemPrompt()).toContain("diffusion");
    const vus: unknown[] = [];
    const ok = await enhancePrompt("un phare", {
      model: null,
      llmCall: (msgs) => {
        vus.push(msgs.map((m) => m.role));
        return Promise.resolve('<think>…</think> Prompt: "A lighthouse in a storm, engraving style"');
      },
    });
    expect(ok).toEqual({ prompt: "A lighthouse in a storm, engraving style", raison: "" });
    expect(vus).toEqual([["system", "user"]]);
    expect(
      await enhancePrompt("un phare", {
        model: null,
        llmCall: () => Promise.reject(new Error("moteur coupé")),
      }),
    ).toEqual({
      prompt: null,
      raison: "modèle indisponible",
    });
    expect(
      await enhancePrompt("un phare de bretagne", { model: null, llmCall: () => Promise.resolve("court") }),
    ).toEqual({
      prompt: null,
      raison: "réponse inutilisable",
    });
    expect(await enhancePrompt("x", { model: null })).toEqual({
      prompt: null,
      raison: "modèle indisponible",
    });
    const stop = new AbortController();
    const p = enhancePrompt("x", {
      model: null,
      signal: stop.signal,
      llmCall: () => new Promise(() => undefined),
    });
    stop.abort();
    await expect(p).rejects.toBeDefined();
  });

  it("prompt édité en console avec des fins de ligne CRLF : lu comme Python (\\n)", () => {
    const avant = process.env["ELPIS_RACINE"];
    const d = mkdtempSync(join(tmpdir(), "elpis-fragments-"));
    onTestFinished(() => rmSync(d, { recursive: true, force: true }));
    mkdirSync(join(d, "system_prompts"));
    writeFileSync(join(d, "system_prompts", "IMAGE_PROMPT_ENHANCE.md"), "Réécris\r\nen anglais\r");
    process.env["ELPIS_RACINE"] = d;
    try {
      expect(systemPrompt()).toBe("Réécris\nen anglais");
    } finally {
      if (avant === undefined) delete process.env["ELPIS_RACINE"];
      else process.env["ELPIS_RACINE"] = avant;
    }
  });
});
