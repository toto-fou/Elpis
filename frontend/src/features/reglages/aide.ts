// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/aide.ts — fenêtre d'aide : guide utilisateur (`/api/help/readme`) chargé une fois, rechargé après un échec, section demandée à l'ouverture. */
import { schemaReponseAide } from "@elpis/contracts";

import { lireSchema } from "../../utils/lecture-json";
import type { CtxReglages, VueReglages } from "./types";

const INDISPONIBLE =
  "## Aide indisponible\n\nL'aide n'a pas pu être chargée. Réessayez dans un instant ; si cela dure, demandez à votre administrateur.";

/** Section du guide (clé `<!-- aide: cle -->`) ouverte depuis chaque page autre que le chat. */
export const BLOCS_AIDE: Readonly<Record<string, string>> = {
  routines: "routines",
  rag: "rag",
  studio: "studio",
  agents: "agents",
  code: "remote",
};

/** Clé de la section du guide qui correspond à l'écran en cours ; vide sur l'accueil. */
export function cleAide(vue: string, editeurOuvert: boolean, enConversation: boolean): string {
  if (vue !== "chat") return BLOCS_AIDE[vue] ?? "";
  if (editeurOuvert) return "editeur";
  return enConversation ? "chat" : "";
}

export function creerAide(vue: VueReglages, ctx: CtxReglages) {
  const { ref } = vue;
  const showHelpModal = ref(false);
  const readmeContent = ref("");
  const isLoadingReadme = ref(false);
  const helpSection = ref("");
  let charge = false;
  let enCours: Promise<void> | null = null;

  async function charger(): Promise<void> {
    isLoadingReadme.value = true;
    let texte: string;
    try {
      const d = await lireSchema(await ctx.fetchAuth("/api/help/readme", {}, true), schemaReponseAide);
      texte = d?.content ?? "";
    } catch {
      texte = "";
    }
    charge = texte !== "";
    readmeContent.value = texte || INDISPONIBLE;
    isLoadingReadme.value = false;
    enCours = null;
  }

  /** Ouvre l'aide sur la section de clé ou d'ancre `section`, sinon sur celle de l'écran en cours ; un chargement en cours est attendu, pas doublé. */
  async function openHelp(section?: unknown): Promise<void> {
    helpSection.value = typeof section === "string" ? section : (ctx.contexteAide?.() ?? "");
    showHelpModal.value = true;
    if (charge) return;
    enCours ??= charger();
    await enCours;
  }

  return { showHelpModal, readmeContent, isLoadingReadme, helpSection, openHelp };
}
