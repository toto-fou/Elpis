// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/recherche-messages.ts — résultats de la recherche dans la conversation : rangs des messages qui contiennent le texte, parcours précédent et suivant en boucle. */

/** Rangs des messages dont le texte contient la requête (casse ignorée). */
export function rangsTrouves(messages: readonly unknown[], requete: string): number[] {
  const q = requete.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  messages.forEach((m, i) => {
    const contenu = (m as { content?: unknown } | null)?.content;
    if (typeof contenu === "string" && contenu.toLowerCase().includes(q)) out.push(i);
  });
  return out;
}

/** Position suivante (+1) ou précédente (-1) dans la liste, en boucle ; -1 si la liste est vide. */
export function positionVoisine(position: number, total: number, sens: 1 | -1): number {
  if (total <= 0) return -1;
  if (position < 0) return sens === 1 ? 0 : total - 1;
  return (position + sens + total) % total;
}
