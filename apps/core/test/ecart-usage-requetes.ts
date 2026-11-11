// SPDX-License-Identifier: MIT
/** apps/core/test/ecart-usage-requetes.ts — écart voulu au Python : usage_events compte aussi les requêtes dont le moteur rapporte le cache (cache_reported_calls) et celles servies en partie par lui (cache_hit_calls). */
import type { Dict } from "@elpis/commun";

const estObjet = (v: unknown): v is Dict => v !== null && typeof v === "object" && !Array.isArray(v);

/** Lignes attendues (Python) complétées des deux compteurs : un tour sans compte explicite vaut une requête mesurée si son usage d'entrée (`usages[i]`) porte le cache ; une ligne écrite directement (`usages` nul) aucune. */
export function avecRequetes(lignes: readonly Dict[], usages: readonly unknown[] | null): Dict[] {
  return lignes.map((l, i) => {
    const u = usages?.[i];
    const rapporte =
      estObjet(u) && (Object.hasOwn(u, "cache_read_input_tokens") || estObjet(u["prompt_tokens_details"]));
    const mesure = rapporte && Number(l["input_tokens"]) > 0 ? 1 : 0;
    return {
      ...l,
      cache_reported_calls: mesure,
      cache_hit_calls: mesure && Number(l["cache_read_tokens"]) > 0 ? 1 : 0,
    };
  });
}
