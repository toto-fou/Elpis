// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/hotes-outils.ts — console › Sandbox › Hôtes d'outils : état des hôtes, affectation et migration d'un compte (`/api/admin/toolhosts*`). */
import {
  schemaReponseHotesOutils,
  schemaReponseMigrationPlacement,
  schemaReponsePlacement,
} from "@elpis/contracts";
import type { ReponseHotesOutils } from "@elpis/contracts";
import { ref } from "vue";
import type { Ref } from "vue";

import type { ClientHttp } from "../../platform/http/client";
import { valeurOuNull } from "../../platform/http/resultat";

export interface CtxHotesOutilsAdmin {
  showToast?(message: string, type?: string): void;
  openConfirm?(titre: string, message: string, danger: boolean, libelle?: string): Promise<boolean>;
}

export function setupAdminHotesOutils(ctx: CtxHotesOutilsAdmin | null | undefined, http: ClientHttp) {
  const toast = (m: string, type?: string): void => ctx?.showToast?.(m, type);
  const toolhosts: Ref<ReponseHotesOutils | null> = ref(null);
  const toolhostMoveTarget: Ref<Record<string, string>> = ref({});
  const toolhostBusy = ref(false);

  async function loadToolhosts(): Promise<void> {
    toolhosts.value = valeurOuNull(
      await http.requete("/api/admin/toolhosts", {}, { schema: schemaReponseHotesOutils }),
    );
  }

  async function action(userId: string | number, migrer: boolean): Promise<void> {
    const host = toolhostMoveTarget.value[userId];
    if (!host || toolhostBusy.value) return;
    const ok = await ctx?.openConfirm?.(
      migrer ? "Migrer le sandbox" : "Réaffecter l'hôte",
      migrer
        ? "Déplacer les fichiers du compte #" +
            userId +
            " vers « " +
            host +
            " » ? L'ancien contenu est conservé sur l'hôte de départ."
        : "Affecter le compte #" + userId + " à « " + host + " » sans déplacer ses fichiers ?",
      migrer,
      migrer ? "Migrer" : "Affecter",
    );
    if (!ok) return;
    toolhostBusy.value = true;
    try {
      const url =
        "/api/admin/toolhosts/placements/" + encodeURIComponent(String(userId)) + (migrer ? "/migrate" : "");
      const init: RequestInit = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ host_id: host }),
      };
      const r = migrer
        ? await http.requete(url, init, { schema: schemaReponseMigrationPlacement })
        : await http.requete(url, init, { schema: schemaReponsePlacement });
      if (r.type === "ok") {
        const fichiers = (r.valeur as { files?: unknown }).files;
        toast(migrer ? "Migré : " + (Number(fichiers) || 0) + " fichiers" : "Compte affecté", "success");
        toolhostMoveTarget.value[userId] = "";
      } else {
        const detail =
          r.type === "requete" || r.type === "refus" || r.type === "serveur" || r.type === "conflit"
            ? r.erreur.detail
            : null;
        toast(detail || "Opération impossible", "error");
      }
    } finally {
      toolhostBusy.value = false;
      await loadToolhosts();
    }
  }

  return {
    toolhosts,
    toolhostMoveTarget,
    toolhostBusy,
    loadToolhosts,
    migrateToolhostPlacement: (userId: string | number) => action(userId, true),
    assignToolhostPlacement: (userId: string | number) => action(userId, false),
  };
}
