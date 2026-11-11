// SPDX-License-Identifier: MIT
/** frontend/test/images/images.test.ts — mode « Images » du chat : demande envoyée, préférences du compte, modification, galerie, visionneuse, suppression annulable. */
import { ref } from "vue";
import type { Ref } from "vue";
import { describe, expect, it } from "vitest";

import type { ApiImages, PageGalerie, StatutMoteurImages } from "../../src/features/images/api";
import { creerImages } from "../../src/features/images/images";
import type { OptionsToast, PieceJointeImage, ReglagesImages } from "../../src/features/images/images";
import type { PreferencesImages } from "../../src/features/images/formats";
import { STATUT } from "./fixtures";

function statut(extra: Partial<StatutMoteurImages> = {}): StatutMoteurImages {
  return { ...(STATUT as unknown as StatutMoteurImages), ...extra };
}

interface Montage {
  api: ReturnType<typeof creerImages>;
  settings: Ref<ReglagesImages>;
  attachedFiles: Ref<PieceJointeImage[]>;
  toasts: Array<[string, string | undefined, OptionsToast | undefined]>;
  prefsEnvoyees: PreferencesImages[];
  appelsGalerie: Array<{
    limite: number;
    avant?: number | null | undefined;
    chat?: string | null | undefined;
  }>;
}

function monter(
  st: StatutMoteurImages | null = statut(),
  reglages: ReglagesImages = {},
  pages: PageGalerie[] = [],
  chat: string | null = null,
): Montage {
  const settings = ref<ReglagesImages>({ image_ready: true, image_enabled: true, ...reglages });
  const attachedFiles = ref<PieceJointeImage[]>([]);
  const toasts: Montage["toasts"] = [];
  const prefsEnvoyees: PreferencesImages[] = [];
  const appelsGalerie: Montage["appelsGalerie"] = [];
  const faux: ApiImages = {
    statut: () => Promise.resolve(st),
    galerie: (p) => {
      appelsGalerie.push(p);
      return Promise.resolve(pages[appelsGalerie.length - 1] ?? null);
    },
    supprimer: () => Promise.resolve("ok"),
    enregistrerPreferences: (p) => {
      prefsEnvoyees.push(p);
      return Promise.resolve();
    },
  };
  const api = creerImages(
    faux,
    { settings, isStreaming: ref(false), attachedFiles, currentChatId: ref(chat) },
    { showToast: (m, k, o) => void toasts.push([m, k, o]), focusInput: () => undefined },
  );
  return { api, settings, attachedFiles, toasts, prefsEnvoyees, appelsGalerie };
}

describe("mode Images", () => {
  it("applique les préférences du compte et borne la demande", async () => {
    const { api } = monter();
    expect(await api.toggleImageMode(true)).toBe(true);
    expect(api.imageMode.value).toBe(true);
    expect(api.buildImageRequest(false)).toEqual({
      n: 2,
      size: "1024x576",
      ratio: "16:9",
      side: 1024,
      enhance: true,
    });
  });

  it("n'envoie les options avancées que si le moteur les comprend", async () => {
    const { api } = monter();
    await api.toggleImageMode(true);
    Object.assign(api.imageOpts, { seed: "42", steps: "8", negative_prompt: " flou ", strength: 0.6 });
    const avec = api.buildImageRequest(true);
    expect(avec.seed).toBe(42);
    expect(avec.steps).toBe(8);
    expect(avec.negative_prompt).toBe("flou");
    expect(avec.strength).toBe(0.6);
    expect(api.buildImageRequest(false).strength).toBeUndefined();

    const o = monter(statut({ features: {} }));
    await o.api.toggleImageMode(true);
    Object.assign(o.api.imageOpts, { seed: "42", steps: "8", negative_prompt: "flou" });
    const sans = o.api.buildImageRequest(true);
    expect(sans.seed).toBeUndefined();
    expect(sans.steps).toBeUndefined();
    expect(sans.negative_prompt).toBeUndefined();
    expect(sans.strength).toBeUndefined();
  });

  it("/image : format et nombre propres à la demande, préférences intactes", async () => {
    const { api } = monter();
    await api.loadImageStatus(true);
    const req = api.buildImageRequest(false, { ratio: "3:4", n: 3 });
    expect(req.size).toBe("768x1024");
    expect(req.n).toBe(3);
    expect(api.imageOpts.ratio).toBe("16:9");
    expect(api.imageOpts.n).toBe(2);
  });

  it("politique fixed : la taille fixe la plus proche part, sans ratio", async () => {
    const { api } = monter(statut({ size_policy: "fixed", sizes: ["1024x1024", "1536x1024", "1024x1536"] }));
    await api.toggleImageMode(true);
    const req = api.buildImageRequest(false);
    expect(req.size).toBe("1536x1024");
    expect(req.ratio).toBeUndefined();
    api.setImageFixed("1024x1536");
    expect(api.buildImageRequest(false).size).toBe("1024x1536");
    expect(api.imageOpts.ratio).toBe("2:3");
  });

  it("changer le format écrit la préférence du compte, enregistrée après un délai", async () => {
    const { api, settings, prefsEnvoyees } = monter();
    await api.toggleImageMode(true);
    api.setImageRatio("4:3");
    expect(settings.value.image_prefs).toEqual({ ratio: "4:3", side: 1024, n: 2, enhance: true });
    await new Promise((r) => setTimeout(r, 700));
    expect(prefsEnvoyees).toEqual([{ ratio: "4:3", side: 1024, n: 2, enhance: true }]);
    api.flipImageRatio();
    expect(api.imageOpts.ratio).toBe("3:4");
    api.setImageRatio("16:9");
    expect(api.imageOpts.ratio).toBe("9:16");
  });

  it("refuse le mode sans moteur : toast et pas d'activation", async () => {
    const { api, toasts } = monter({ ready: false, available: false });
    expect(await api.toggleImageMode(true)).toBe(false);
    expect(api.imageMode.value).toBe(false);
    expect(toasts[0]?.[0]).toMatch(/Aucun moteur/);
  });

  it("suit la case des Paramètres en direct", () => {
    const { api, settings } = monter();
    expect(api.imageAvailable.value).toBe(true);
    settings.value = { ...settings.value, image_enabled: false };
    expect(api.imageAvailable.value).toBe(false);
    settings.value = { image_ready: false, image_enabled: true };
    expect(api.imageAvailable.value).toBe(false);
  });

  it("Échap : popover d'abord, puis sortie du mode sur une saisie vide", async () => {
    const { api } = monter();
    await api.toggleImageMode(true);
    api.toggleImagePop("more");
    expect(api.imageEscape(true, true)).toBe(true);
    expect(api.imagePop.value).toBe("");
    expect(api.imageMode.value).toBe(true);
    expect(api.imageEscape(false, true)).toBe(false);
    expect(api.imageEscape(true, false)).toBe(false);
    expect(api.imageEscape(true, true)).toBe(true);
    expect(api.imageMode.value).toBe(false);
  });
});

describe("modification, visionneuse, suppression", () => {
  it("Modifier une image : mode Images, image désignée, pièce jointe retirée et annoncée", async () => {
    const { api, attachedFiles, toasts } = monter();
    attachedFiles.value = [{ name: "a.png", isImage: true }];
    await api.editGeneratedImage({
      id: "ab12",
      url: "/api/images/ab12",
      thumb_url: "/api/images/ab12?thumb=1",
    });
    expect(api.imageMode.value).toBe(true);
    expect(api.imageEditRef.value?.id).toBe("ab12");
    expect(attachedFiles.value).toHaveLength(0);
    expect(api.buildImageRequest(false).ref_image_id).toBe("ab12");
    expect(toasts.some(([m]) => /Pièce jointe retirée/.test(m))).toBe(true);
  });

  it("la visionneuse retrouve l'image cliquée par id, une image retirée avant", () => {
    const { api } = monter();
    const items = [
      { id: "a1", url: "/api/images/a1" },
      { id: "a2", url: "/api/images/a2" },
      { id: "a3", url: "/api/images/a3" },
    ];
    api.removeImage(items[0]);
    api.openImageViewer(items, 1);
    expect(api.imageViewerCurrent.value?.id).toBe("a2");
    api.closeImageViewer();
    api.openImageViewer(items, 2);
    expect(api.imageViewerCurrent.value?.id).toBe("a3");
  });

  it("nom de fichier : la description de l'utilisateur, pas la description enrichie", () => {
    const { api } = monter();
    api.openImageViewer([{ id: "b1", seed: 7 }], 0, { prompt: "Un phare", revised: "A lighthouse at night" });
    expect(api.imageViewerNamePrompt.value).toBe("Un phare");
    expect(api.imageViewerPrompt.value).toBe("A lighthouse at night");
  });

  it("suppression en attente : partagée pour l'envoi au déchargement, retirée par Annuler", () => {
    const { api, toasts } = monter();
    api.removeImage({ id: "d1" });
    const attente = (window as unknown as { __elpisImageDeletes: Set<string> }).__elpisImageDeletes;
    expect(attente.has("d1")).toBe(true);
    expect(api.imageCellState("d1")).toBe("pending");
    toasts[toasts.length - 1]?.[2]?.onAction?.();
    expect(attente.has("d1")).toBe(false);
    expect(api.imageCellState("d1")).toBe("");
  });

  it("à l'expiration du toast, la suppression part puis l'image est marquée supprimée", async () => {
    const { api, toasts } = monter();
    api.removeImage({ id: "d2" });
    await toasts[toasts.length - 1]?.[2]?.onExpire?.();
    expect(api.imageCellState("d2")).toBe("deleted");
  });
});

describe("galerie", () => {
  it("pages par curseur « avant », filtre de la conversation ouverte", async () => {
    const mk = (id: string) => ({ id }) as never;
    const pages: PageGalerie[] = [
      { items: [mk("a1"), mk("a2")], next_before: 900.5, total: 3, keep: 50 },
      { items: [mk("a3")], next_before: null, total: 3, keep: 50 },
      { items: [mk("c1")], next_before: null, total: 1, keep: 50 },
    ];
    const { api, appelsGalerie } = monter(statut(), {}, pages, "chat42");
    await api.openImageGallery("all");
    expect(appelsGalerie[0]).toEqual({ limite: 48, avant: null, chat: null });
    expect(api.imageGallery.value?.items).toHaveLength(2);
    expect(api.imageGallery.value?.done).toBe(false);
    await api.loadMoreGallery();
    expect(appelsGalerie[1]).toEqual({ limite: 48, avant: 900.5, chat: null });
    expect(api.imageGallery.value?.items.map((x) => x.id)).toEqual(["a1", "a2", "a3"]);
    expect(api.imageGallery.value?.done).toBe(true);
    await api.loadMoreGallery();
    expect(appelsGalerie).toHaveLength(2);
    api.setGalleryFilter("chat");
    await new Promise((r) => setTimeout(r, 0));
    expect(appelsGalerie[2]).toEqual({ limite: 48, avant: null, chat: "chat42" });
    expect(api.imageGallery.value?.items.map((x) => x.id)).toEqual(["c1"]);
    api.closeImageGallery();
    expect(api.imageGallery.value).toBeNull();
  });
});
