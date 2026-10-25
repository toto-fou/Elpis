// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/memoire.ts — Paramètres › Mémoire : état USER.md et MEMORY.md du compte (`/api/memory/state`), édition par brouillon, effacement. */
import { schemaReponseEtatMemoire } from "@elpis/contracts";
import type { ReponseEtatMemoire } from "@elpis/contracts";
import { computed, ref } from "vue";
import type { Ref } from "vue";

import type { ClientHttp } from "../../platform/http/client";
import { valeurOuNull } from "../../platform/http/resultat";
import type { ApiResult } from "../../platform/http/resultat";

export type GenreMemoire = "user" | "memory";
const CLE: Record<GenreMemoire, "user_md" | "memory_md"> = { user: "user_md", memory: "memory_md" };

export interface CtxMemoire {
  showToast?(message: string, type?: string): void;
  openConfirm?(titre: string, message: string, danger: boolean, libelle?: string): Promise<boolean>;
  openChatById?(id: string): unknown;
}

/** Ce que le module lit de la composition des réglages (`reglages.ts`) : le document des réglages, son instantané, la fermeture normale de la modale. */
export interface DependancesMemoire {
  readonly settings: Ref<Record<string, unknown>>;
  readonly snapshot: Ref<string>;
  readonly showSettingsModal: Ref<boolean>;
  closeSettings(): Promise<unknown> | unknown;
}

export interface OrigineAffichee {
  date: string;
  label: string;
  chatId: string | null;
  canOpen: boolean;
}

const nettoyer = (liste: readonly unknown[] | undefined): string[] =>
  (liste ?? []).map((e) => String(e ?? "").trim()).filter(Boolean);

function detail(r: ApiResult<unknown>): string | null {
  if (r.type === "requete" || r.type === "refus" || r.type === "serveur" || r.type === "conflit") {
    return r.erreur.detail ?? "";
  }
  return null;
}

export function setupMemoire(ctx: CtxMemoire | null | undefined, dep: DependancesMemoire, http: ClientHttp) {
  const toast = (m: string, type?: string): void => ctx?.showToast?.(m, type);
  const userMemory: Ref<ReponseEtatMemoire | null> = ref(null);
  const userMemoryLoading = ref(false);
  const userMemoryError = ref("");
  const userMemoryDeleting = ref(false);
  const memoryEditing = ref(false);
  const memorySaving = ref(false);
  const memorySaveError = ref("");
  const memoryDraft: Ref<Record<GenreMemoire, string[]>> = ref({ user: [], memory: [] });

  async function loadUserMemory(): Promise<void> {
    userMemoryLoading.value = true;
    userMemoryError.value = "";
    try {
      const d = valeurOuNull(
        await http.requete("/api/memory/state", {}, { schema: schemaReponseEtatMemoire }),
      );
      if (d) userMemory.value = d;
      else userMemoryError.value = "Impossible de charger la mémoire.";
    } finally {
      userMemoryLoading.value = false;
    }
  }

  const fichier = (kind: GenreMemoire) => userMemory.value?.[CLE[kind]];
  const memStored = (kind: GenreMemoire): string[] => fichier(kind)?.entries ?? [];

  function memoryOrigin(kind: GenreMemoire, i: number): OrigineAffichee | null {
    const o = fichier(kind)?.origins?.[i];
    if (!o?.ts) return null;
    const d = new Date(o.ts * 1000);
    const memeAnnee = d.getFullYear() === new Date().getFullYear();
    const date = d.toLocaleDateString(
      "fr-FR",
      memeAnnee
        ? { day: "2-digit", month: "2-digit" }
        : { day: "2-digit", month: "2-digit", year: "numeric" },
    );
    let label: string;
    if (o.source === "settings") label = "Paramètres";
    else if (o.source === "undo") label = "annulation";
    else if (o.chat_id && o.chat_title) label = "« " + o.chat_title + " »";
    else if (o.chat_id) label = "chat supprimé";
    else label = "assistant";
    return {
      date,
      label,
      chatId: o.chat_id || null,
      canOpen: !!(o.source === "tool" && o.chat_id && o.chat_exists),
    };
  }

  async function openMemoryOrigin(kind: GenreMemoire, i: number): Promise<void> {
    const o = memoryOrigin(kind, i);
    if (!o?.canOpen || !o.chatId || !ctx?.openChatById) return;
    await dep.closeSettings();
    if (dep.showSettingsModal.value) return;
    ctx.openChatById(o.chatId);
  }

  function startMemoryEdit(): void {
    if (!userMemory.value) return;
    memoryDraft.value = { user: memStored("user").slice(), memory: memStored("memory").slice() };
    memorySaveError.value = "";
    memoryEditing.value = true;
  }

  function cancelMemoryEdit(): void {
    memoryEditing.value = false;
    memorySaveError.value = "";
    memoryDraft.value = { user: [], memory: [] };
  }

  const addMemoryEntry = (kind: GenreMemoire): void => {
    memoryDraft.value[kind].push("");
  };
  const removeMemoryEntry = (kind: GenreMemoire, i: number): void => {
    memoryDraft.value[kind].splice(i, 1);
  };

  function memoryDraftChars(kind: GenreMemoire): number {
    const liste = nettoyer(memoryDraft.value[kind]);
    return liste.length ? liste.join("\n§\n").length : 0;
  }
  const memoryLimit = (kind: GenreMemoire): number => fichier(kind)?.limit || 0;
  function memoryOver(kind: GenreMemoire): boolean {
    const lim = memoryLimit(kind);
    return !!lim && memoryEditing.value && memoryDraftChars(kind) > lim;
  }
  const memoryOverLimit = computed(() => memoryOver("user") || memoryOver("memory"));

  const modifie = (kind: GenreMemoire): boolean => {
    const avant = memStored(kind);
    const apres = nettoyer(memoryDraft.value[kind]);
    return apres.length !== avant.length || apres.some((e, i) => e !== avant[i]);
  };
  const memoryDirty = computed(() => memoryEditing.value && (modifie("user") || modifie("memory")));

  async function saveMemoryEdit(): Promise<void> {
    if (memorySaving.value || !userMemory.value) return;
    const jobs: Array<{ kind: GenreMemoire; entries: string[]; emptied: boolean }> = [];
    for (const kind of ["user", "memory"] as const) {
      if (!modifie(kind)) continue;
      const apres = nettoyer(memoryDraft.value[kind]);
      jobs.push({ kind, entries: apres, emptied: !apres.length && memStored(kind).length > 0 });
    }
    if (!jobs.length) {
      cancelMemoryEdit();
      return;
    }
    if (jobs.some((j) => j.emptied)) {
      const ok = await ctx?.openConfirm?.(
        "Vider ce que l'assistant a retenu ?",
        "Les entrées supprimées ne sont pas récupérables.",
        true,
        "Vider",
      );
      if (!ok) return;
    }
    memorySaving.value = true;
    memorySaveError.value = "";
    const erreurs: string[] = [];
    try {
      for (const j of jobs) {
        const r = await http.requete(`/api/memory/state/${j.kind}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: j.entries }),
        });
        if (r.type === "ok") continue;
        const msg = detail(r);
        erreurs.push(
          (j.kind === "user" ? "Profil" : "Notes") +
            " : " +
            (msg ? msg : msg === null ? "erreur réseau" : "enregistrement refusé"),
        );
      }
    } finally {
      memorySaving.value = false;
    }
    if (erreurs.length) {
      memorySaveError.value = erreurs.join(" · ");
      return;
    }
    memoryEditing.value = false;
    memoryDraft.value = { user: [], memory: [] };
    toast("Mémoire enregistrée.", "success");
    await loadUserMemory();
  }

  async function deleteUserMemory(): Promise<void> {
    if (userMemoryDeleting.value) return;
    const ok = await ctx?.openConfirm?.(
      "Effacer toute la mémoire ?",
      "Tout ce que l'assistant a retenu (profil, notes, scopes) sera supprimé définitivement. Cette action est irréversible.",
      true,
      "Effacer",
    );
    if (!ok) return;
    userMemoryDeleting.value = true;
    try {
      const r = await http.requete("/api/memory/state", { method: "DELETE" });
      if (r.type === "ok") {
        toast("Mémoire effacée.", "success");
        await loadUserMemory();
      } else {
        toast("Échec de la suppression de la mémoire.", "error");
      }
    } finally {
      userMemoryDeleting.value = false;
    }
  }

  async function persistMemoryEnabled(): Promise<void> {
    const val = !!dep.settings.value.memory_enabled;
    const r = await http.requete("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ memory_enabled: val }),
    });
    if (r.type !== "ok") {
      toast(
        r.type === "requete" || r.type === "refus" || r.type === "serveur" || r.type === "conflit"
          ? "Mémoire : enregistrement échoué."
          : "Mémoire : erreur réseau.",
        "error",
      );
      return;
    }
    try {
      const s = JSON.parse(dep.snapshot.value || "{}") as Record<string, unknown>;
      s.memory_enabled = val;
      dep.snapshot.value = JSON.stringify(s);
    } catch {
      /* instantané au mieux */
    }
    toast(val ? "Mémoire long-terme activée." : "Mémoire long-terme désactivée.");
  }

  return {
    userMemory,
    userMemoryLoading,
    userMemoryError,
    userMemoryDeleting,
    loadUserMemory,
    persistMemoryEnabled,
    memoryEditing,
    memorySaving,
    memorySaveError,
    memoryDraft,
    memoryOverLimit,
    memoryDirty,
    startMemoryEdit,
    cancelMemoryEdit,
    saveMemoryEdit,
    addMemoryEntry,
    removeMemoryEntry,
    memoryDraftChars,
    memoryLimit,
    memoryOver,
    memoryOrigin,
    openMemoryOrigin,
    deleteUserMemory,
  };
}
