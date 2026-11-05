// SPDX-License-Identifier: MIT
/** frontend/src/features/reglages/sections.ts — sous-menus de la modale : sections d'un onglet visibles pour ce compte, section affichée, section trouvée par la recherche. */
import { entreeRail, sansAccent } from "./rail";
import type { SectionRail } from "./rail";

/** Ce que lisent les conditions d'affichage (une partie du domaine des réglages). */
export interface ContexteSections {
  settingsSections: Record<string, string>;
  settings: {
    enable_editor?: unknown;
    image_ready?: unknown;
    image_enabled?: unknown;
    image_prefs?: unknown;
  };
  features: { voice_stt?: unknown; voice_tts?: unknown };
  mascottesOffertes: boolean;
}

/** Sections soumises à une condition, par `onglet/section` ; les autres sont toujours visibles. */
const CONDITIONS: Readonly<Record<string, (c: ContexteSections) => boolean>> = {
  "appearance/mascotte": (c) => c.mascottesOffertes,
  "chat/voix": (c) => !!(c.features.voice_stt || c.features.voice_tts),
  "features/images": (c) =>
    !!c.settings.image_ready && c.settings.image_enabled !== false && !!c.settings.image_prefs,
  "features/editeur": (c) => !!c.settings.enable_editor,
};

/** Sections d'un onglet visibles pour ce compte. */
export function sectionsVisibles(c: ContexteSections, onglet: string): readonly SectionRail[] {
  const liste = entreeRail(onglet)?.sections ?? [];
  return liste.filter((s) => CONDITIONS[`${onglet}/${s.id}`]?.(c) ?? true);
}

/** Section affichée : la dernière choisie si elle reste visible, sinon la première. */
export function sectionCourante(c: ContexteSections, onglet: string): SectionRail | null {
  const liste = sectionsVisibles(c, onglet);
  return liste.find((s) => s.id === c.settingsSections[onglet]) ?? liste[0] ?? null;
}

/** Première section d'un onglet dont le libellé ou les mots-clés contiennent la requête. */
export function sectionTrouvee(onglet: string, requete: string): string | null {
  const q = sansAccent(requete.trim());
  if (!q) return null;
  const s = entreeRail(onglet)?.sections?.find((x) => sansAccent(`${x.libelle} ${x.mots}`).includes(q));
  return s?.id ?? null;
}
