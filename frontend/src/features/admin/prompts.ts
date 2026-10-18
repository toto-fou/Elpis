// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/prompts.ts — console › Modèles & services › Prompts : fichiers de prompts système par catégorie (liste groupée, éditeur, aperçu assemblé) pris en compte sans redémarrage. */
import {
  schemaReponseApercuPrompt,
  schemaReponsePromptSysteme,
  schemaReponsePromptsSysteme,
} from "@elpis/contracts";
import type { Ref } from "vue";

import { corpsJson, detailErreur, lireSchema } from "../../utils/lecture-json";
import type { BaseAdmin, PromptSysteme } from "./etat";

type ApercuPrompt = typeof schemaReponseApercuPrompt._output;
const ENTETES_JSON = { "Content-Type": "application/json" };

export interface GroupePrompts {
  id: string;
  label: string;
  icon: string;
}
export interface MetaPrompt {
  group: string;
  label: string;
  icon: string;
  desc: string;
  usage: string;
}

const GROUPES: readonly GroupePrompts[] = Object.freeze([
  { id: "base", label: "Base chatbot", icon: "ph-robot" },
  { id: "compress", label: "Compression", icon: "ph-arrows-in" },
  { id: "memory", label: "Mémoire", icon: "ph-brain" },
  { id: "vision", label: "Vision & Desktop", icon: "ph-eye" },
  { id: "other", label: "Autres", icon: "ph-file-text" },
]);

const META: Readonly<Record<string, MetaPrompt>> = Object.freeze({
  CHATBOT_SYSTEM: {
    group: "base",
    label: "Identité du chatbot",
    icon: "ph-robot",
    desc: "Prompt de base de toutes les sessions",
    usage: "Injecté en tête de chaque conversation.",
  },
  COMPRESSOR_SYSTEM: {
    group: "compress",
    label: "Compression de conversation",
    icon: "ph-arrows-in",
    desc: "Résume/compacte les longues conversations",
    usage: "Utilisé par le compresseur de contexte.",
  },
  AX_MEMORY_HEADER: {
    group: "memory",
    label: "Mémoire navigateur (AX)",
    icon: "ph-brain",
    desc: "En-tête du bloc mémoire DOM par site",
    usage: "Préfixe le bloc mémoire AX des sessions navigateur.",
  },
  VISION_DETECT: {
    group: "vision",
    label: "Vision — détection",
    icon: "ph-scan",
    desc: "Détecte tous les éléments interactifs",
    usage: "Grounding UI complet (moteur de vision desktop).",
  },
  VISION_DETECT_EDGE: {
    group: "vision",
    label: "Vision — barre des tâches",
    icon: "ph-scan",
    desc: "Détection de la barre du bas",
    usage: "Grounding ciblé sur la taskbar.",
  },
  VISION_DETECT_QUERY: {
    group: "vision",
    label: "Vision — ciblé",
    icon: "ph-scan",
    desc: "Détection ciblée par requête",
    usage: "Grounding desktop ciblé par {query}.",
  },
  VISION_READ: {
    group: "vision",
    label: "Vision — lecture (OCR)",
    icon: "ph-eye",
    desc: "Transcription de texte d'image",
    usage: "OCR / lecture de texte à l'écran.",
  },
});

export function fmtBytes(n: unknown): string {
  const v = Number(n) || 0;
  if (v < 1024) return v + " o";
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " Ko";
  return (v / 1024 / 1024).toFixed(1) + " Mo";
}

export function creerPrompts(b: BaseAdmin) {
  const { vue, ctx, e } = b;
  const { computed, ref } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const { promptsSelected, promptsEditorDirty } = e;
  const promptsList: Ref<PromptSysteme[]> = ref([]);
  const promptsEditorText = ref("");
  const promptsLoading = ref(false);
  const promptsPreview: Ref<ApercuPrompt | null> = ref(null);
  const promptsPreviewCats: Ref<string[]> = ref([]);
  const promptsCollapsed: Ref<Set<string>> = ref(new Set());

  const promptMeta = (cat: string): MetaPrompt =>
    META[cat] ?? { group: "other", label: cat, icon: "ph-file-text", desc: "", usage: "" };
  const promptsGrouped = computed(() => {
    const parGroupe: Record<string, PromptSysteme[]> = {};
    for (const it of promptsList.value || []) (parGroupe[promptMeta(it.category).group] ??= []).push(it);
    return GROUPES.map((g) => ({ ...g, items: parGroupe[g.id] ?? [] })).filter((g) => g.items.length > 0);
  });
  const isPromptGroupCollapsed = (id: string): boolean => promptsCollapsed.value.has(id);
  function togglePromptGroup(id: string): void {
    const s = new Set(promptsCollapsed.value);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    promptsCollapsed.value = s;
  }

  /** Liste du dossier de prompts ; amorce l'aperçu sur toutes les catégories la première fois. */
  async function loadSystemPrompts(): Promise<void> {
    promptsLoading.value = true;
    try {
      const d = await lireSchema(await fetchAuth("/api/admin/system-prompts"), schemaReponsePromptsSysteme);
      if (!d) {
        showToast("Erreur chargement prompts", "error");
        return;
      }
      promptsList.value = d.items;
      if (promptsPreviewCats.value.length === 0)
        promptsPreviewCats.value = promptsList.value.map((it) => it.category);
      const premier = promptsList.value[0];
      if (!promptsSelected.value && premier) await selectPrompt(premier.category);
      else await refreshPreview();
    } catch (err) {
      showToast("Erreur réseau: " + (err instanceof Error ? err.message : String(err)), "error");
    } finally {
      promptsLoading.value = false;
    }
  }

  /** Charge une catégorie dans l'éditeur (`_TEMPLATE` en lecture seule) ; confirme l'abandon des modifications locales. */
  async function selectPrompt(category: string): Promise<void> {
    if (promptsEditorDirty.value) {
      const ok = await openConfirm(
        "Modifications non sauvegardées",
        `Tu as des modifications non sauvegardées sur "${promptsSelected.value}". Les abandonner ?`,
        true,
        "Abandonner",
      );
      if (!ok) return;
    }
    promptsLoading.value = true;
    try {
      const url =
        category === "_TEMPLATE"
          ? "/api/admin/system-prompts/_template"
          : `/api/admin/system-prompts/${encodeURIComponent(category)}`;
      const d = await lireSchema(await fetchAuth(url), schemaReponsePromptSysteme);
      if (!d) {
        showToast(`Erreur chargement ${category}`, "error");
        return;
      }
      promptsSelected.value = category;
      promptsEditorText.value = d.content || "";
      promptsEditorDirty.value = false;
    } catch (err) {
      showToast("Erreur réseau: " + (err instanceof Error ? err.message : String(err)), "error");
    } finally {
      promptsLoading.value = false;
    }
  }

  /** Enregistre le contenu de l'éditeur puis rafraîchit la liste et l'aperçu. */
  async function savePrompt(): Promise<boolean | undefined> {
    const cat = promptsSelected.value;
    if (!cat || cat === "_TEMPLATE") return undefined;
    if (!promptsEditorDirty.value) return undefined;
    promptsLoading.value = true;
    try {
      const r = await fetchAuth(`/api/admin/system-prompts/${encodeURIComponent(cat)}`, {
        method: "PUT",
        headers: ENTETES_JSON,
        body: JSON.stringify({ content: promptsEditorText.value }),
      });
      if (!r || !r.ok) {
        showToast(detailErreur(await corpsJson(r)) || "Erreur d’enregistrement", "error");
        return false;
      }
      promptsEditorDirty.value = false;
      showToast(`${cat}.md enregistré`, "success");
      await loadSystemPrompts();
      await refreshPreview();
      return true;
    } catch (err) {
      showToast("Erreur réseau: " + (err instanceof Error ? err.message : String(err)), "error");
      return false;
    } finally {
      promptsLoading.value = false;
    }
  }

  /** Abandonne les modifications locales et relit le disque. */
  async function reloadPrompt(): Promise<void> {
    if (!promptsSelected.value) return;
    promptsEditorDirty.value = false;
    await selectPrompt(promptsSelected.value);
  }

  /** Aperçu assemblé des catégories cochées ; non critique, les erreurs sont avalées. */
  async function refreshPreview(): Promise<void> {
    const cats = promptsPreviewCats.value || [];
    const qs = cats.length ? `?categories=${encodeURIComponent(cats.join(","))}` : "";
    try {
      const d = await lireSchema(
        await fetchAuth(`/api/admin/system-prompts/_preview${qs}`),
        schemaReponseApercuPrompt,
      );
      if (d) promptsPreview.value = d;
    } catch {
      /* aperçu inchangé */
    }
  }

  return {
    promptsList,
    promptsSelected,
    promptsEditorText,
    promptsEditorDirty,
    promptsLoading,
    promptsPreview,
    promptsPreviewCats,
    loadSystemPrompts,
    selectPrompt,
    savePrompt,
    reloadPrompt,
    refreshPreview,
    promptsGrouped,
    isPromptGroupCollapsed,
    togglePromptGroup,
    promptMeta,
    fmtBytes,
  };
}
