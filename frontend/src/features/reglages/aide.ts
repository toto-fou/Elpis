// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/aide.ts — fenêtre d'aide : guide utilisateur (`/api/help/readme`), chargement à jeton pour ignorer les réponses périmées. */
import { schemaReponseAide } from "@elpis/contracts";

import { lireSchema } from "../../utils/lecture-json";
import type { CtxReglages, VueReglages } from "./types";

export function creerAide(vue: VueReglages, ctx: CtxReglages) {
  const { ref } = vue;
  const showHelpModal = ref(false);
  const readmeContent = ref("");
  const isLoadingReadme = ref(false);
  let sequence = 0;

  async function openHelp(): Promise<void> {
    const maSequence = ++sequence;
    showHelpModal.value = true;
    isLoadingReadme.value = true;
    try {
      const res = await ctx.fetchAuth("/api/help/readme", {}, true);
      if (maSequence !== sequence) return;
      const d = await lireSchema(res, schemaReponseAide);
      if (maSequence !== sequence) return;
      readmeContent.value = d ? d.content : "# Erreur lors du chargement de l'aide.";
    } catch {
      if (maSequence !== sequence) return;
      readmeContent.value = "# Erreur réseau lors du chargement de l'aide.";
    } finally {
      if (maSequence === sequence) isLoadingReadme.value = false;
    }
  }

  return { showHelpModal, readmeContent, isLoadingReadme, openHelp };
}
