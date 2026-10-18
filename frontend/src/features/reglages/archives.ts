// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/archives.ts — Paramètres › Archives et données : conversations archivées (restauration, suppression groupée), vidage des conversations et de l'espace de développement. */
import { schemaListeChats, schemaReponseSuppressions } from "@elpis/contracts";
import type { ResumeChat } from "@elpis/contracts";
import type { Ref } from "vue";

import { corpsJson, lireSchema, nombre, objet } from "../../utils/lecture-json";
import type { CtxReglages, VueReglages } from "./types";

const ENTETES_JSON = { "Content-Type": "application/json" };

export function creerArchives(vue: VueReglages, ctx: CtxReglages) {
  const { ref } = vue;
  const { showToast, openConfirm, fetchAuth } = ctx;
  const archivesList: Ref<ResumeChat[]> = ref([]);
  const archiveSelectMode = ref(false);
  const archiveSelected: Ref<string[]> = ref([]);

  async function loadArchives(): Promise<void> {
    try {
      const d = await lireSchema(await fetchAuth("/api/saved/chats?archived=1", {}, true), schemaListeChats);
      if (d) archivesList.value = d.items;
    } catch {
      /* liste inchangée */
    }
  }

  async function restoreArchive(id: string): Promise<void> {
    try {
      const res = await fetchAuth(`/api/saved/chats/${id}/unarchive`, { method: "POST" });
      if (res?.ok) {
        void loadArchives();
        void ctx.loadChatsList?.();
      }
    } catch {
      /* au mieux */
    }
  }

  async function deleteArchive(id: string, title?: string): Promise<void> {
    const confirme = await openConfirm(
      "Supprimer cette conversation archivée ?",
      title || "",
      true,
      "Supprimer",
    );
    if (!confirme) return;
    try {
      const res = await fetchAuth(`/api/saved/chats/${id}`, { method: "DELETE" });
      if (res?.ok) void loadArchives();
    } catch {
      /* au mieux */
    }
  }

  function toggleArchiveSelect(id: string): void {
    const i = archiveSelected.value.indexOf(id);
    if (i >= 0) archiveSelected.value.splice(i, 1);
    else archiveSelected.value.push(id);
  }

  /** Désarchivage groupé : boucle sur la route unitaire (idempotente, pas de route par lot). */
  async function unarchiveSelectedArchives(): Promise<void> {
    const ids = archiveSelected.value.slice();
    if (!ids.length) return;
    let ok = 0;
    for (const id of ids) {
      try {
        const res = await fetchAuth(`/api/saved/chats/${id}/unarchive`, { method: "POST" });
        if (res?.ok) ok++;
      } catch {
        /* compté comme échec */
      }
    }
    showToast(
      `${ok} conversation(s) restaurée(s)` + (ok < ids.length ? ` (${ids.length - ok} échec)` : ""),
      ok === ids.length ? "success" : "error",
    );
    archiveSelected.value = [];
    archiveSelectMode.value = false;
    void loadArchives();
    void ctx.loadChatsList?.();
  }

  async function deleteSelectedArchives(): Promise<void> {
    const confirme = await openConfirm(
      `Supprimer ${archiveSelected.value.length} archive(s) ?`,
      "Cette action est irréversible.",
      true,
    );
    if (!confirme) return;
    try {
      const res = await fetchAuth("/api/saved/chats/delete-batch", {
        method: "POST",
        headers: ENTETES_JSON,
        body: JSON.stringify({ ids: archiveSelected.value }),
      });
      const d = await lireSchema(res, schemaReponseSuppressions);
      if (d) {
        showToast(`${d.deleted} archive(s) supprimée(s)`);
        archiveSelected.value = [];
        archiveSelectMode.value = false;
        void loadArchives();
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  async function clearSandbox(): Promise<void> {
    const confirme = await openConfirm(
      "Vider l'espace de développement ?",
      "Tous les fichiers et dossiers de votre sandbox seront définitivement supprimés.",
      true,
      "Tout supprimer",
    );
    if (!confirme) return;
    try {
      const res = await fetchAuth("/api/sandbox/clear", { method: "POST" });
      if (res?.ok) {
        const data = objet(await corpsJson(res));
        showToast(`${nombre(data["deleted"])} élément(s) supprimé(s)`);
        void ctx.loadSandboxFiles?.();
        void ctx.checkExternalModsSoon?.(0);
      } else {
        showToast("Erreur lors du nettoyage", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  async function clearAllChats(): Promise<void> {
    const confirme = await openConfirm(
      "Supprimer toutes les conversations ?",
      "Toutes vos conversations actives seront définitivement supprimées. Les archives ne sont pas affectées.",
      true,
      "Tout supprimer",
    );
    if (!confirme) return;
    try {
      const res = await fetchAuth("/api/saved/chats/clear-all", { method: "POST" });
      if (res?.ok) {
        const data = objet(await corpsJson(res));
        showToast(`${nombre(data["deleted"])} conversation(s) supprimée(s)`);
        void ctx.loadChatsList?.();
      } else {
        showToast("Erreur", "error");
      }
    } catch {
      showToast("Erreur réseau", "error");
    }
  }

  /** Remise à plat à la fermeture des Paramètres. */
  function reinitialiserAFermeture(): void {
    archiveSelectMode.value = false;
    archiveSelected.value = [];
  }

  return {
    archivesList,
    archiveSelectMode,
    archiveSelected,
    loadArchives,
    restoreArchive,
    deleteArchive,
    toggleArchiveSelect,
    unarchiveSelectedArchives,
    deleteSelectedArchives,
    clearSandbox,
    clearAllChats,
    reinitialiserAFermeture,
  };
}
