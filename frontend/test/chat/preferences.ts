// SPDX-License-Identifier: MIT
/** frontend/test/chat/preferences.ts — préférences d'affichage du chat pour les tests : un déroulé, le reste par défaut. */
import { PREFERENCES_PAR_DEFAUT } from "../../src/features/reglages/affichage-chat";
import type { Deroule, PreferencesChat } from "../../src/features/reglages/affichage-chat";

export function prefsDeroule(deroule: Deroule, autres: Partial<PreferencesChat> = {}): PreferencesChat {
  return { ...PREFERENCES_PAR_DEFAUT, deroule, ...autres };
}
