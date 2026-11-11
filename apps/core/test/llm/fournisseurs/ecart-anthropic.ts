// SPDX-License-Identifier: MIT
/** apps/core/test/llm/fournisseurs/ecart-anthropic.ts — écart voulu à l'ancien cœur Python : la réflexion adaptative (Claude ≥ 4.6) est demandée aussi avec des outils. */
type Dict = Record<string, unknown>;

/** Corps Python ramené au TS : avec outils et réflexion demandée, le `thinking` adaptatif du modèle s'ajoute (le budget fixe reste sans outils). */
export function corpsAnthropicTs(
  pense: boolean,
  corps: Dict,
  reflexion: (modele: string, maxTokens: number) => Dict | null,
): Dict {
  if (!pense || !("tools" in corps) || "thinking" in corps) return corps;
  const cfg = reflexion(String(corps["model"]), Number(corps["max_tokens"]));
  return cfg?.["type"] === "adaptive" ? { ...corps, thinking: cfg } : corps;
}
