// SPDX-License-Identifier: MIT
/** frontend/src/features/editor/aide-raccourcis.ts — aide des raccourcis clavier de l'éditeur (Ctrl+/ hors du code ; dans Monaco, Ctrl+/ commente la ligne). */
import { ref } from "vue";
import type { Ref } from "vue";

import type { ReglagesEditeur } from "./instances";

export interface Raccourci {
  keys: string[];
  desc: string;
  note?: string;
}

export interface GroupeRaccourcis {
  title: string;
  items: Raccourci[];
}

export const GROUPES_RACCOURCIS: readonly GroupeRaccourcis[] = [
  {
    title: "Navigation",
    items: [
      { keys: ["Ctrl", "P"], desc: "Ouvrir un fichier (récents d'abord)" },
      { keys: ["Ctrl", "Maj", "F"], desc: "Rechercher dans les fichiers" },
      { keys: ["Alt", "L"], desc: "Localiser le fichier dans l'arbre" },
      { keys: ["Alt", "←"], desc: "Position précédente" },
      { keys: ["Alt", "→"], desc: "Position suivante" },
      { keys: ["Ctrl", "G"], desc: "Aller à la ligne" },
      { keys: ["Ctrl", "Maj", "O"], desc: "Aller au symbole", note: "dans le code" },
      { keys: ["F12"], desc: "Aller à la définition" },
      { keys: ["Ctrl", "/"], desc: "Afficher cette aide" },
    ],
  },
  {
    title: "Édition",
    items: [
      { keys: ["Ctrl", "S"], desc: "Enregistrer" },
      { keys: ["Ctrl", "Alt", "S"], desc: "Tout enregistrer" },
      { keys: ["Maj", "Alt", "F"], desc: "Formater le document" },
      { keys: ["Alt", "\\"], desc: "Complétion IA" },
      { keys: ["Ctrl", "F"], desc: "Rechercher dans le fichier" },
      { keys: ["Ctrl", "H"], desc: "Rechercher et remplacer" },
      { keys: ["Ctrl", "D"], desc: "Occurrence suivante (multi-curseur)" },
      { keys: ["Alt", "Clic"], desc: "Ajouter un curseur" },
      { keys: ["Ctrl", "/"], desc: "Commenter / décommenter", note: "dans le code" },
    ],
  },
  {
    title: "Affichage",
    items: [
      { keys: ["Ctrl", "B"], desc: "Afficher / masquer l'explorateur" },
      { keys: ["Ctrl", "`"], desc: "Terminal" },
      { keys: ["Ctrl", "Maj", "P"], desc: "Palette de commandes Monaco" },
    ],
  },
  {
    title: "Onglets",
    items: [
      { keys: ["Alt", "W"], desc: "Fermer l'onglet" },
      { keys: ["Alt", "PgSuiv"], desc: "Onglet suivant" },
      { keys: ["Alt", "PgPréc"], desc: "Onglet précédent" },
      { keys: ["Ctrl", "Maj", "T"], desc: "Rouvrir le dernier onglet fermé" },
      { keys: ["Clic du milieu"], desc: "Fermer l'onglet" },
      { keys: ["Glisser"], desc: "Réordonner" },
    ],
  },
  {
    title: "Arbre",
    items: [
      { keys: ["↑", "↓"], desc: "Ligne précédente / suivante" },
      { keys: ["→", "←"], desc: "Ouvrir / fermer le dossier" },
      { keys: ["Ctrl", "Clic"], desc: "Ajouter à la sélection" },
      { keys: ["Maj", "Clic"], desc: "Sélectionner une plage" },
      { keys: ["F2"], desc: "Renommer" },
      { keys: ["Suppr"], desc: "Supprimer" },
    ],
  },
];

export function setupEditorShortcutsHelp(settings: Ref<ReglagesEditeur>) {
  const shortcutsModalVisible = ref(false);
  const openShortcutsModal = (): void => {
    shortcutsModalVisible.value = true;
  };
  const closeShortcutsModal = (): void => {
    shortcutsModalVisible.value = false;
  };
  // Capture : vu avant Monaco ; focus dans le code, Ctrl+/ lui reste (commenter la ligne).
  function surTouche(e: KeyboardEvent): void {
    if (!settings.value?.enable_editor) return;
    if (!((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === "/" || e.key === "?"))) return;
    const actif = document.activeElement;
    if (actif?.closest?.(".monaco-editor")) return;
    e.preventDefault();
    if (shortcutsModalVisible.value) closeShortcutsModal();
    else openShortcutsModal();
  }
  window.addEventListener("keydown", surTouche, true);
  return {
    shortcutsModalVisible,
    shortcutGroups: GROUPES_RACCOURCIS,
    openShortcutsModal,
    closeShortcutsModal,
    libererAideRaccourcis: () => window.removeEventListener("keydown", surTouche, true),
  };
}
