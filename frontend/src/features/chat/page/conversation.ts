// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/conversation.ts — menu « Conversation » commun à l'en-tête, à la rangée du volet et au clic droit : entrées et exécution sur une conversation, chargée d'abord si elle n'est pas ouverte. */

export const FORMATS_EXPORT = [
  { id: "md", libelle: "Markdown" },
  { id: "json", libelle: "JSON" },
  { id: "txt", libelle: "Texte brut" },
  { id: "pdf", libelle: "PDF" },
] as const;

export type FormatExport = (typeof FORMATS_EXPORT)[number]["id"];
export type ActionConversation =
  "renommer" | "rechercher" | "archiver" | "supprimer" | `exporter:${FormatExport}`;

export interface CibleConversation {
  id: string;
  title: string;
}

/** Ce que le menu lit de la racine (domaines du chat). */
export interface ActionsConversation {
  readonly currentChatId: string | null;
  messageSearchActive: boolean;
  messageSearch: string;
  loadChat(id: string): unknown;
  renameChat(id: string, titre: string): unknown;
  archiveChat(id: string): unknown;
  deleteChat(id: string): unknown;
  exportChatAs(format: string): unknown;
}

export async function executerConversation(
  action: ActionConversation,
  cible: CibleConversation,
  d: ActionsConversation,
): Promise<void> {
  const id = String(cible.id);
  if (action === "renommer") await d.renameChat(id, cible.title);
  else if (action === "archiver") await d.archiveChat(id);
  else if (action === "supprimer") await d.deleteChat(id);
  else {
    // Rechercher et exporter agissent sur la conversation ouverte : l'autre est chargée d'abord.
    if (String(d.currentChatId ?? "") !== id) await d.loadChat(id);
    if (action === "rechercher") d.messageSearchActive = true;
    else await d.exportChatAs(action.slice("exporter:".length));
  }
}
