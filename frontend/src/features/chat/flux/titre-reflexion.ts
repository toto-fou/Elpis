// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/flux/titre-reflexion.ts — titre lisible tiré du raisonnement en cours, pour la barre de statut (porté de `chat/_thinking_title.js`). */

/** Majuscule initiale, ponctuation de tête retirée. */
export function _cap(s: string | null | undefined): string {
  const t = (s || "").trim().replace(/^[,;:-]+\s*/, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const ETAPES: ReadonlyArray<readonly [RegExp, (m: RegExpMatchArray) => string]> = [
  [
    /(?:let me|let's|je dois|je vais|I need to|I should|I'll|il faut|nous devons)\s+([^.!?\n]{5,50})/i,
    (m) => _cap(m[1]),
  ],
  [/(?:first[,:]?|d'abord[,:]?|étape 1|step 1)\s*([^.!?\n]{5,50})/i, () => "Analyse initiale"],
  [/(?:now[,:]?|next[,:]?|ensuite[,:]?|maintenant[,:]?)\s+([^.!?\n]{5,50})/i, (m) => _cap(m[1])],
  [/(?:wait|hmm|actually|en fait)\s*[,]?\s*([^.!?\n]{5,50})/i, () => "Vérification..."],
  [/(?:calculat|calculons|comput|let me calc)\s*([^.!?\n]{0,40})/i, () => "Calcul en cours..."],
  [
    /(?:the answer|la réponse|the result|le résultat)\s*(?:is|=|est)?\s*([^.!?\n]{2,40})/i,
    () => "Formulation de la réponse",
  ],
  [
    /(?:in conclusion|en conclusion|to summarize|pour résumer|finally|finalement)\s*([^.!?\n]{5,50})/i,
    () => "Conclusion",
  ],
];

/** Titre (55 caractères au plus) des 2 000 derniers caractères du raisonnement. */
export function _thinkingTitle(text: string | null | undefined): string {
  const last = (text || "").slice(-2000).trim();
  for (const [re, fn] of ETAPES) {
    const m = last.match(re);
    if (m) {
      const t = fn(m);
      if (t && t.length >= 3) return t.slice(0, 55);
    }
  }
  const phrases = last
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8);
  if (phrases.length > 0) return _cap(phrases[phrases.length - 1]).slice(0, 55);
  return "Réflexion en cours...";
}

export function setupChatThinkingTitle(): { _thinkingTitle: typeof _thinkingTitle; _cap: typeof _cap } {
  return { _thinkingTitle, _cap };
}
