// SPDX-License-Identifier: MIT
/** packages/contracts/test/core/images.test.ts — contrats des images générées (état, galerie, suppression) et de la voix (état, transcription) rejoués contre le core TS réel ; sans moteur d'images ni de dictée, la transcription réussie est vérifiée sur des exemples. */
import { writeFileSync } from "node:fs";

import { config, invalidateConfigCache } from "@elpis/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { CONTRATS_REST, schemaReponseEtatImages, schemaReponseTranscription } from "../../src";
import { cle, creerCompte, demarrerCore } from "./aides";
import type { CoreDeTest } from "./aides";

let core: CoreDeTest;
let cookie = "";
let cookieLou = "";
let uid = 0;

beforeAll(async () => {
  core = await demarrerCore();
  uid = await creerCompte(core.base, "zoe", "mdp-de-zoe-1");
  await creerCompte(core.base, "lou", "mdp-de-lou-1");
  cookie = await core.connecter("zoe", "mdp-de-zoe-1");
  cookieLou = await core.connecter("lou", "mdp-de-lou-1");
});

afterAll(async () => {
  await core.fermer();
});

async function inserer(id: string, quand: number): Promise<void> {
  await core.base.run(
    "INSERT INTO generated_images(id, user_id, chat_id, prompt, params_json, model, mime, width, height, bytes, rel_path, thumb_rel_path, created_at) " +
      "VALUES (?, ?, 'c1', 'Un chat', '{\"seed\": 42, \"revised_prompt\": \"Un chat roux\"}', 'm', 'image/png', 512, 512, 10, ?, '', ?)",
    [id, uid, `${id}.png`, quand],
  );
}

describe("contrats REST : images (core réel)", () => {
  it("état : moteur désactivé, puis moteur prêt", async () => {
    expect(await core.appeler("GET", "/api/image/status", { cookie })).toEqual({
      ready: false,
      available: false,
    });
    writeFileSync(
      config.CONFIG_JSON_PATH,
      JSON.stringify({
        image: { enabled: true, provider: "openai", url: "http://127.0.0.1:1/v1", model: "m" },
      }),
    );
    invalidateConfigCache();
    const pret = schemaReponseEtatImages.parse(await core.appeler("GET", "/api/image/status", { cookie }));
    expect(pret).toMatchObject({ ready: true, available: true, provider: "openai", stored: 0 });
    await core.appeler("GET", "/api/image/status");
  });

  it("galerie paginée, filtre de conversation, suppression d'une image du compte", async () => {
    await inserer("0123456789abcdef0123456789abcdef", 1700000001);
    await inserer("fedcba9876543210fedcba9876543210", 1700000002);
    expect(await core.appeler("GET", "/api/images?limit=1", { cookie })).toMatchObject({
      items: [{ id: "fedcba9876543210fedcba9876543210", seed: 42, revised_prompt: "Un chat roux" }],
      next_before: 1700000002,
      total: 2,
    });
    await core.appeler("GET", "/api/images?before=1700000002&chat_id=c1", { cookie });
    await core.appeler("GET", `/api/images?chat_id=${"x".repeat(200)}`, { cookie });
    expect(await core.appeler("GET", "/api/images", { cookie: cookieLou })).toMatchObject({
      items: [],
      total: 0,
    });
    await core.appeler("DELETE", "/api/images/0123456789abcdef0123456789abcdef", { cookie: cookieLou });
    expect(await core.appeler("DELETE", "/api/images/0123456789abcdef0123456789abcdef", { cookie })).toEqual({
      ok: true,
    });
    await core.appeler("DELETE", "/api/images/0123456789abcdef0123456789abcdef", { cookie });
    await core.appeler("GET", "/api/images");
  });

  it("voix : état du compte, transcription refusée sans moteur, formes de réponse", async () => {
    expect(await core.appeler("GET", "/api/voice/status", { cookie })).toMatchObject({
      stt: false,
      tts: false,
      dictation: false,
      sample_rate: 16000,
    });
    await core.appeler("GET", "/api/voice/status");
    await core.televerser("/api/voice/transcribe", {
      cookie,
      fichier: Buffer.alloc(100),
      nom: "a.wav",
      type: "audio/wav",
    });
    expect(schemaReponseTranscription.parse({ text: "Bonjour", duration_ms: 1200 })).toEqual({
      text: "Bonjour",
      duration_ms: 1200,
    });
    const ecarte = { text: "", rejected: "trop court" };
    expect(schemaReponseTranscription.parse(ecarte)).toEqual(ecarte);
  });

  it("toutes les routes des domaines images et voix ont été interrogées", () => {
    const attendues = CONTRATS_REST.filter((r) => r.domaine === "images" || r.domaine === "voix").map(cle);
    expect([...core.couvertes].filter((k) => attendues.includes(k)).sort()).toEqual([...attendues].sort());
  });
});
