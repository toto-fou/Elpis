// SPDX-License-Identifier: MIT
/** frontend/test/images/formats.test.ts — fonctions pures de la génération d'images : champs de message, formats, préférences, commande /image, libellés. */
import { describe, expect, it } from "vitest";

import {
  IMAGE_MSG_KEYS,
  copyImageFields,
  imageCellStyle,
  imageErrorText,
  imageFileName,
  imagePickFixed,
  imageProgressText,
  imageRequestLabel,
  imageSizeFor,
  imageSizeLabel,
  imageVariantRequest,
  isImageMessage,
  normalizeImagePrefs,
  parseImageCommand,
} from "../../src/features/images/formats";
import { STATUT } from "./fixtures";

describe("champs d'un message", () => {
  it("copyImageFields recopie les seuls champs d'image non vides", () => {
    const src = {
      role: "assistant",
      content: "x",
      image_request: { size: "1024x1024", n: 1 },
      generated_images: [{ id: "a1" }],
      tool_images: [],
      revised_prompt: "",
      image_meta: { model: "m" },
      image_error: null,
      autre: 1,
    };
    expect(copyImageFields(src, {})).toEqual({
      image_request: { size: "1024x1024", n: 1 },
      generated_images: [{ id: "a1" }],
      image_meta: { model: "m" },
    });
  });

  it("IMAGE_MSG_KEYS couvre les six champs du contrat", () => {
    expect([...IMAGE_MSG_KEYS].sort()).toEqual([
      "generated_images",
      "image_error",
      "image_meta",
      "image_request",
      "revised_prompt",
      "tool_images",
    ]);
  });

  it("aller-retour persistance puis réhydratation : rien ne se perd", () => {
    const live = {
      role: "assistant",
      content: "[Image générée : « x »]",
      generated_images: [{ id: "a1", url: "/api/images/a1", width: 1024, height: 576, seed: 4 }],
      revised_prompt: "A lighthouse",
      image_meta: { model: "Qwen", duration_s: 12 },
      image_error: { code: "timeout", message: "", retryable: true },
    };
    const persiste = copyImageFields(live, { role: "assistant", content: live.content });
    const relu = copyImageFields(JSON.parse(JSON.stringify(persiste)), { role: "assistant" });
    for (const k of ["generated_images", "revised_prompt", "image_meta", "image_error"] as const) {
      expect(relu[k]).toEqual(live[k]);
    }
  });

  it("isImageMessage : tour image, résultat ou échec, pas une réponse avec images d'outil", () => {
    expect(isImageMessage({ role: "assistant", _imageTurn: true })).toBe(true);
    expect(isImageMessage({ role: "assistant", generated_images: [{ id: "a" }] })).toBe(true);
    expect(isImageMessage({ role: "assistant", image_error: { code: "timeout" } })).toBe(true);
    expect(isImageMessage({ role: "assistant", content: "texte", tool_images: [{ id: "b" }] })).toBe(false);
    expect(isImageMessage({ role: "assistant", content: "texte" })).toBe(false);
  });
});

describe("formats et préférences", () => {
  it("imageSizeFor : côté long au pas de 64, orientation respectée", () => {
    expect(imageSizeFor("16:9", 1024, 64)).toEqual({ w: 1024, h: 576 });
    expect(imageSizeFor("9:16", 1024, 64)).toEqual({ w: 576, h: 1024 });
    expect(imageSizeFor("1:1", 768, 64)).toEqual({ w: 768, h: 768 });
    expect(imageSizeFor("21:9", 1024, 64)).toEqual({ w: 1024, h: 448 });
    expect(imageSizeFor("n'importe", 512, 64)).toEqual({ w: 512, h: 512 });
  });

  it("imageCellStyle : même boîte pour la tuile et l'image, plus petite en lot", () => {
    expect(imageCellStyle(1024, 576, 1)).toEqual({ width: "360px", aspectRatio: "1024 / 576" });
    expect(imageCellStyle(576, 1024, 1)).toEqual({ width: "203px", aspectRatio: "576 / 1024" });
    expect(imageCellStyle(1024, 1024, 3).width).toBe("208px");
  });

  it("normalizeImagePrefs ramène les préférences aux limites du moteur", () => {
    const f = (p: unknown, st = STATUT) => normalizeImagePrefs(p, st);
    expect(f({ ratio: "16:9", side: 1024, n: 2, enhance: true })).toEqual({
      ratio: "16:9",
      side: 1024,
      n: 2,
      enhance: true,
    });
    expect(f({ ratio: "21:9", side: 2048, n: 9 })).toEqual({
      ratio: "1:1",
      side: 1536,
      n: 3,
      enhance: false,
    });
    expect(f({ side: 900 }).side).toBe(768);
    expect(f({ enhance: true }, { ...STATUT, enhance_enabled: false }).enhance).toBe(false);
    expect(f(null)).toEqual({ ratio: "1:1", side: 1024, n: 1, enhance: false });
  });

  it("imagePickFixed : taille fixe la plus proche du ratio puis du côté", () => {
    const tailles = ["1024x1024", "1536x1024", "1024x1536"];
    expect(imagePickFixed(tailles, "16:9", 1024)).toBe("1536x1024");
    expect(imagePickFixed(tailles, "9:16", 1024)).toBe("1024x1536");
    expect(imagePickFixed(tailles, "1:1", 512)).toBe("1024x1024");
    expect(imagePickFixed([], "1:1", 512)).toBe("");
  });
});

describe("commande /image, variantes, nom de fichier, libellés", () => {
  it("parseImageCommand : ratio et nombre en tête, dans les deux ordres", () => {
    const f = (raw: string) => parseImageCommand(raw, STATUT);
    expect(f("16:9 x2 un phare  sous l'orage")).toEqual({
      prompt: "un phare  sous l'orage",
      ratio: "16:9",
      n: 2,
      error: "",
    });
    expect(f("x3 4:3 chat")).toEqual({ prompt: "chat", ratio: "4:3", n: 3, error: "" });
    expect(f("portrait un arbre")).toEqual({ prompt: "un arbre", ratio: "2:3", n: null, error: "" });
    expect(f("×9 une ville en 16:9").n).toBe(3);
    expect(f("×9 une ville en 16:9").prompt).toBe("une ville en 16:9");
    expect(f("")).toEqual({ prompt: "", ratio: null, n: null, error: "" });
    expect(f("5:4 un pont").error).toMatch(/Format non proposé/);
  });

  it("imageVariantRequest : même demande, sans graine", () => {
    const req = { size: "1024x576", n: 2, seed: 42, steps: 8, ref_image_id: "ab12", enhance: true };
    expect(imageVariantRequest(req)).toEqual({
      size: "1024x576",
      n: 2,
      steps: 8,
      ref_image_id: "ab12",
      enhance: true,
    });
    expect(req.seed).toBe(42);
  });

  it("imageFileName : description, graine, extension ; id court à défaut", () => {
    expect(
      imageFileName({ id: "abcdef1234", seed: 4812, mime: "image/png" }, "Un phare, sous l'orage !"),
    ).toBe("Un-phare-sous-l-orage-4812.png");
    expect(imageFileName({ id: "abcdef1234", mime: "image/jpeg" }, "")).toBe("image-abcdef12.jpg");
    expect(imageFileName({ id: "x1", seed: 0, mime: "image/webp" }, "é")).toBe("é-0.webp");
    expect(imageFileName({ id: "x1", seed: 1 }, "a".repeat(80))).toHaveLength(40 + "-1.png".length);
  });

  it("imageSizeLabel et imageRequestLabel", () => {
    expect(imageSizeLabel("1024x576")).toBe("16:9 · 1024×576");
    expect(imageSizeLabel("1024x1024")).toBe("Carré · 1024×1024");
    expect(imageSizeLabel("1000x300")).toBe("1000×300");
    expect(imageRequestLabel({ size: "576x1024", n: 2, seed: 7, enhance: true, ref_image_id: "a1" })).toBe(
      "9:16 · 576×1024 · ×2 · graine 7 · modification · enrichie",
    );
  });

  it("imageProgressText : file, durée estimée, pourcentage seulement s'il est publié", () => {
    expect(imageProgressText({ state: "queued", queue_position: 2 })).toBe("En file · 2e");
    expect(imageProgressText({ state: "queued", queue_position: 1 })).toBe("En file · 1re");
    expect(imageProgressText({ state: "queued" })).toBe("En file");
    expect(imageProgressText({ state: "waiting" })).toBe("En attente d’un créneau");
    expect(imageProgressText({ state: "generating", eta_s: 30 }, 12)).toBe("Génération · 12 s / ≈30 s");
    expect(imageProgressText({ state: "generating" }, 75)).toBe("Génération · 1 min 15 s");
    expect(imageProgressText({ state: "generating", pct: 40, pct_real: false }, 5)).toBe("Génération · 5 s");
    expect(imageProgressText({ state: "generating", pct: 40.4, pct_real: true }, 5)).toBe(
      "Génération · 40 %",
    );
  });

  it("imageErrorText : message du serveur, sinon libellé du code", () => {
    expect(imageErrorText({ code: "timeout", message: "" })).toBe("Délai dépassé");
    expect(imageErrorText({ code: "engine", message: "Moteur saturé" })).toBe("Moteur saturé");
    expect(imageErrorText({ code: "inconnu" })).toBe("Erreur du moteur d’images");
    expect(imageErrorText("texte libre")).toBe("texte libre");
    expect(imageErrorText({ code: "enhance" })).toBe("Enrichir indisponible");
  });
});
