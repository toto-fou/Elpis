// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/coeur/envoi.ts — envoi d'un message (porté d'`app-chat.js`) : commande « / » tapée, mode Images, mode plan scellé, pièces jointes, commande /image et variantes, chats pré-configurés (assistants de skill et de routine, document), copie d'une réponse. */
import { journal } from "../../../platform/journal";
import { imageVariantRequest, parseImageCommand } from "../../images/formats";
import type { SurfaceImages } from "../../images/images";
import { nextTick } from "vue";

import { ASSISTANTS, lignesCadrage, PREFIXE_REGLAGE, valeursInitiales } from "./assistants.ts";
import type { CoeurChat } from "./liens.ts";
import type { MessageChat, Objet } from "./types.ts";

/** Ce que l'envoi lit du composeur (menu « / ») et du module des images (session FONCTIONS). */
export interface DependancesEnvoi {
  closeMentionDropdown(): void;
  slashResolve?: (texte: string) => unknown;
  slashRun?: (entree: unknown) => Promise<unknown> | unknown;
  slashDismiss?: () => void;
  pinnedSkills: { value: { name: string; description?: string; domain?: string }[] };
  images: ModuleImages;
  ensureServerChat(source: string): Promise<string | false>;
  startNewChat(): Promise<void>;
}

/** Partie du module des images lue par l'envoi. */
export type ModuleImages = Pick<
  SurfaceImages,
  | "imageMode"
  | "imageAvailable"
  | "buildImageRequest"
  | "clearImageEditRef"
  | "loadImageStatus"
  | "toggleImageMode"
  | "setImageRatio"
  | "setImageN"
>;

export function creerEnvoi(c: CoeurChat, dep: DependancesEnvoi) {
  const { r, ctx, e, f, l } = c;

  function remettreFocus(): void {
    void nextTick(() => {
      l.autoResize();
      r.inputRef.value?.focus();
    });
  }

  function arreterDictee(): void {
    try {
      l.voix().stopDictation();
    } catch (err) {
      journal.erreur("[voix]", err);
    }
  }

  // Mode « Images » : la description part au moteur d'images, une seule pièce jointe (l'image à modifier).
  async function envoyerImage(): Promise<void> {
    const prompt = r.inputMessage.value.trim();
    if (!prompt) return;
    const pj = e.attachedFiles.value;
    const premiere = pj[0];
    if (pj.length > 1 || (premiere && !premiere.isImage)) {
      ctx.showToast("Mode Images : une seule image jointe, celle à modifier.", "info");
      return;
    }
    if (premiere) dep.images.clearImageEditRef();
    const src = premiere
      ? [{ name: premiere.name, dataUrl: premiere.content || "", mimeType: premiere.mimeType }]
      : undefined;
    arreterDictee();
    r.messages.value.push({
      role: "user",
      content: prompt,
      images: src,
      image_request: dep.images.buildImageRequest(!!src),
    });
    e.attachedFiles.value = [];
    dep.images.clearImageEditRef();
    r.inputMessage.value = "";
    remettreFocus();
    await l.generateResponse();
  }

  async function sendMessage(): Promise<void> {
    dep.closeMentionDropdown();
    // Commande « / » tapée à la main : avant la garde de génération (un refus est dit), sans toucher aux pièces jointes.
    const coup = dep.slashResolve ? dep.slashResolve(r.inputMessage.value) : null;
    if (coup) {
      r.inputMessage.value = "";
      dep.slashDismiss?.();
      void nextTick(() => ctx.autoResize?.());
      await dep.slashRun?.(coup);
      return;
    }
    if (r.isStreaming.value) return;
    if (dep.images.imageMode.value) {
      await envoyerImage();
      return;
    }
    // Lecture seule armée sur un chat vierge : le chat doit exister avant le flux (refus sans rien consommer).
    if (e.planMode.value && !r.currentChatId.value) {
      const ok = await dep.ensureServerChat(r.inputMessage.value.trim());
      if (!ok) {
        ctx.showToast(
          "Mode plan impossible à garantir (le serveur n'a pas créé la conversation) — message non envoyé. Réessayez, ou coupez le mode avec /plan off.",
          "error",
          { duration: 10000 },
        );
        return;
      }
    }
    // Collections RAG choisies sur un chat vierge : scellées à sa création, avant le flux.
    if (!r.currentChatId.value && l.ragEnAttente().length) {
      if (!(await dep.ensureServerChat(r.inputMessage.value.trim()))) {
        ctx.showToast(
          "Conversation non créée : collections non activées, message non envoyé. Réessayez.",
          "error",
        );
        return;
      }
    }
    let texte = r.inputMessage.value.trim();
    let fichiers: { name: string; lines: number }[] = [];
    let images: { name: string; dataUrl: string; mimeType?: string }[] = [];
    if (e.attachedFiles.value.length > 0) {
      const textes = e.attachedFiles.value.filter((x) => !x.isImage);
      const imgs = e.attachedFiles.value.filter((x) => x.isImage);
      if (textes.length > 0) {
        fichiers = textes.map((x) => ({ name: x.name, lines: (x.content || "").split("\n").length }));
        const blocs = textes
          .map((x) => "--- FILE: " + x.name + " ---\n" + x.content + "\n--- END FILE ---")
          .join("\n\n");
        texte = blocs + (texte ? "\n\n" + texte : "");
      }
      images = imgs.map((x) => ({ name: x.name, dataUrl: x.content || "", mimeType: x.mimeType }));
      e.attachedFiles.value = [];
    }
    if (!texte && images.length === 0) return;
    arreterDictee();
    r.messages.value.push({
      role: "user",
      content: texte || "",
      files: fichiers.length > 0 ? fichiers : undefined,
      images: images.length > 0 ? images : undefined,
      displayContent: fichiers.length > 0 || images.length > 0 ? r.inputMessage.value.trim() : undefined,
    });
    r.inputMessage.value = f.composeRestoreDraft !== null ? f.composeRestoreDraft : "";
    f.composeRestoreDraft = null;
    remettreFocus();
    await l.generateResponse();
  }

  /** Message utilisateur qui précède `index` (la demande d'un résultat d'image). */
  function utilisateurAvant(index: number): MessageChat | null {
    const msgs = r.messages.value;
    for (let i = Math.min(index, msgs.length) - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m && m.role === "user") return m;
    }
    return null;
  }

  function imagePromptFor(index: number): string {
    return utilisateurAvant(index)?.content || "";
  }

  function imageRequestFor(index: number): Objet | null {
    return utilisateurAvant(index)?.image_request || null;
  }

  /** « Variantes » : un nouveau tour avec la même demande et une autre graine. */
  async function imageVariants(index: number): Promise<void> {
    if (r.isStreaming.value) return;
    const u = utilisateurAvant(index);
    if (!u || !u.image_request) return;
    r.messages.value.push({
      role: "user",
      content: u.content || "",
      images: u.images && u.images.length ? u.images : undefined,
      image_request: imageVariantRequest(u.image_request),
    });
    await l.generateResponse();
  }

  /** Commande « /image [ratio] [xN] description » ; sans description, elle ouvre le mode Images. */
  async function runImageSlash(raw: unknown): Promise<{ ok: boolean; msg?: string; silent?: boolean }> {
    const refus = (msg: string): { ok: false; msg: string } => {
      const t = String(raw || "").trim();
      if (t && !String(r.inputMessage.value || "").trim()) {
        r.inputMessage.value = "/image " + t;
        remettreFocus();
      }
      return { ok: false, msg };
    };
    const im = dep.images;
    if (!im.imageAvailable.value) return refus("Génération d’images indisponible.");
    const st = await im.loadImageStatus();
    const cmd = parseImageCommand(raw, st ? { ...st } : null);
    if (cmd.error) return refus(cmd.error);
    if (!cmd.prompt) {
      if (!(await im.toggleImageMode(true))) return { ok: true, silent: true };
      if (cmd.ratio) im.setImageRatio(cmd.ratio);
      if (cmd.n) im.setImageN(cmd.n);
      return { ok: true, silent: true };
    }
    if (r.isStreaming.value) return refus("Une génération est en cours.");
    if (!st || !st.available) return refus("Génération d’images indisponible.");
    const pj = e.attachedFiles.value;
    const premiere = pj[0];
    if (pj.length > 1 || (premiere && !premiere.isImage))
      return refus("Une seule image jointe, celle à modifier.");
    const src = premiere
      ? [{ name: premiere.name, dataUrl: premiere.content || "", mimeType: premiere.mimeType }]
      : undefined;
    r.messages.value.push({
      role: "user",
      content: cmd.prompt,
      images: src,
      image_request: im.buildImageRequest(!!src, { ratio: cmd.ratio, n: cmd.n }),
    });
    e.attachedFiles.value = [];
    im.clearImageEditRef();
    remettreFocus();
    await l.generateResponse();
    return { ok: true, silent: true };
  }

  async function copyAssistantMessage(content: string | null | undefined): Promise<void> {
    if (!content) return;
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) await navigator.clipboard.writeText(content);
      else {
        const ta = document.createElement("textarea");
        ta.value = content;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      ctx.showToast("Réponse copiée");
    } catch (err) {
      ctx.showToast("Impossible de copier : " + ((err instanceof Error && err.message) || ""), "error");
    }
  }

  function ouvrirAssistant(id: string, pre: Record<string, string> = {}): void {
    const d = ASSISTANTS[id];
    if (d) e.assistantForm.value = { open: true, id, valeurs: valeursInitiales(d, pre) };
  }

  // Chat neuf cadré : Paramètres fermés, catégories cochées, skill de procédure épinglé, cadrage envoyé au premier message.
  async function lancerAssistant(o: {
    categories: string[];
    skill: { name: string; description: string };
    lignes: string[];
    manquantes?: Record<string, string>;
  }): Promise<void> {
    try {
      void ctx.closeSettings?.(true);
      void ctx.loadSettingsData?.();
    } catch {
      /* réglages absents */
    }
    r.currentView.value = "chat";
    await dep.startNewChat();
    const lt = { ...e.localTools.value };
    for (const cat of o.categories) if (cat in lt) lt[cat] = true;
    for (const [cle, message] of Object.entries(o.manquantes ?? {})) {
      const reglage = cle.startsWith(PREFIXE_REGLAGE) ? cle.slice(PREFIXE_REGLAGE.length) : null;
      const absent = reglage ? r.settings.value[reglage] === false : !(cle in lt);
      if (absent) ctx.showToast(message, "info");
    }
    e.localTools.value = lt;
    if (!dep.pinnedSkills.value.some((s) => s.name === o.skill.name))
      dep.pinnedSkills.value.push({ name: o.skill.name, description: o.skill.description, domain: "" });
    r.inputMessage.value = o.lignes.join("  \n");
    await sendMessage();
  }

  async function lancerAssistantForm(): Promise<void> {
    const form = e.assistantForm.value;
    const d = ASSISTANTS[form.id];
    if (!d) return;
    const manque = d.champs.find((c) => c.requis && !(form.valeurs[c.cle] || "").trim());
    if (manque) {
      ctx.showToast(`${manque.libelle} requis`, "error");
      return;
    }
    e.assistantForm.value = { ...form, open: false };
    await lancerAssistant({
      categories: d.categories,
      skill: d.skill,
      lignes: lignesCadrage(d, form.valeurs),
      manquantes: d.manquantes,
    });
  }

  return {
    sendMessage,
    imagePromptFor,
    imageRequestFor,
    imageVariants,
    runImageSlash,
    copyAssistantMessage,
    ouvrirAssistant,
    lancerAssistant,
    lancerAssistantForm,
  };
}
