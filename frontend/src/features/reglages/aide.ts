// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/aide.ts — fenêtre d'aide : guide utilisateur ou documentation développeur (`/api/help/readme`), chargement à jeton pour ignorer les réponses périmées. */
import { schemaReponseAide } from "@elpis/contracts";
import type { Ref } from "vue";

import { lireSchema } from "../../utils/lecture-json";
import type { CtxReglages, VueReglages } from "./types";

export type DocAide = "user" | "dev";

export function creerAide(vue: VueReglages, ctx: CtxReglages) {
  const { nextTick, ref } = vue;
  const showHelpModal = ref(false);
  const readmeContent = ref("");
  const isLoadingReadme = ref(false);
  const helpDoc: Ref<DocAide> = ref("user");
  const helpBodyRef: Ref<HTMLElement | null> = ref(null);
  let sequence = 0;

  async function openHelp(doc?: unknown): Promise<void> {
    const cible: DocAide = doc === "user" || doc === "dev" ? doc : helpDoc.value || "user";
    const maSequence = ++sequence;
    helpDoc.value = cible;
    showHelpModal.value = true;
    isLoadingReadme.value = true;
    try {
      const res = await ctx.fetchAuth("/api/help/readme?doc=" + encodeURIComponent(cible), {}, true);
      if (maSequence !== sequence) return;
      const d = await lireSchema(res, schemaReponseAide);
      if (maSequence !== sequence) return;
      if (d) {
        readmeContent.value = d.content;
        helpDoc.value = d.doc;
      } else {
        readmeContent.value = "# Erreur lors du chargement de la documentation.";
      }
    } catch {
      if (maSequence !== sequence) return;
      readmeContent.value = "# Erreur réseau lors du chargement de la documentation.";
    } finally {
      if (maSequence === sequence) {
        isLoadingReadme.value = false;
        void nextTick(() => {
          if (helpBodyRef.value) ctx.addCodeCopyButtons?.(true, helpBodyRef.value);
        });
      }
    }
  }

  function switchHelpDoc(doc: unknown): void {
    if (doc !== "user" && doc !== "dev") return;
    if (doc === helpDoc.value && readmeContent.value) return;
    void openHelp(doc);
  }

  return { showHelpModal, readmeContent, isLoadingReadme, helpDoc, helpBodyRef, openHelp, switchHelpDoc };
}
