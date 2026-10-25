// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/onglets.ts — sous-onglets par tâche des pages Images et Voix : onglets, rattachement d'un réglage à son onglet, point « modifié ». */

export interface OngletConsole {
  readonly id: string;
  readonly label: string;
  /** Chemins (relatifs au préfixe de la page) rangés dans cet onglet ; les autres vont au premier. */
  readonly champs: readonly string[];
}

export interface OngletAffiche {
  readonly id: string;
  readonly label: string;
  readonly modifie: boolean;
}

export const ONGLETS_IMAGES: readonly OngletConsole[] = Object.freeze([
  { id: "connexion", label: "Connexion", champs: [] },
  {
    id: "limites",
    label: "Limites",
    champs: [
      "max_side",
      "default_side",
      "max_n",
      "max_concurrent",
      "timeout_sec",
      "size_policy",
      "sizes",
      "edit_mode",
    ],
  },
  { id: "acces", label: "Accès", champs: ["groups", "tool_max_calls", "enhance_enabled", "keep_per_user"] },
]);

export const ONGLETS_VOIX: readonly OngletConsole[] = Object.freeze([
  { id: "dictee", label: "Dictée", champs: ["stt."] },
  { id: "lecture", label: "Lecture", champs: ["tts."] },
]);

/** Onglet d'un chemin de configuration complet (`image.max_side`), ou « » s'il ne relève pas de la page (activation comprise). */
function ongletDe(onglets: readonly OngletConsole[], prefixe: string, chemin: string): string {
  if (!chemin.startsWith(prefixe)) return "";
  const reste = chemin.slice(prefixe.length);
  if (reste === "enabled") return "";
  const trouve = onglets.find((o) =>
    o.champs.some((c) => reste === c || (c.endsWith(".") && reste.startsWith(c))),
  );
  return (trouve ?? onglets[0])?.id ?? "";
}

/** Onglets de la page avec le point « modifié » sur ceux qui portent une modification non enregistrée. */
export function ongletsAvecModifications(
  onglets: readonly OngletConsole[],
  prefixe: string,
  modifications: readonly { store: string; path: string }[],
): OngletAffiche[] {
  const sales = new Set(
    modifications.filter((m) => m.store === "config").map((m) => ongletDe(onglets, prefixe, m.path)),
  );
  return onglets.map((o) => ({ id: o.id, label: o.label, modifie: sales.has(o.id) }));
}
