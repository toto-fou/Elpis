// SPDX-License-Identifier: MIT
/** apps/core/test/llm/fournisseurs/ecart-dialecte-etendu.ts — écart voulu au Python (ecarts-python.md de la v0.1.2, « Moteurs vLLM et SGLang ») : ces moteurs gardent les champs de leur dialecte étendu dans le payload assaini. */
import { aDialecteEtendu, CHAMPS_DIALECTE_ETENDU } from "../../../src/llm/profils";

type Dict = Record<string, unknown>;

/** Sortie Python ramenée au TS : pour vLLM et SGLang, les champs étendus de l'entrée s'ajoutent au reste assaini. */
export function sortieAssainieTs(cible: Dict, entree: Dict, sortie: Dict): Dict {
  const type = typeof cible["provider_type"] === "string" ? cible["provider_type"] : "";
  if (!aDialecteEtendu(type)) return sortie;
  const gardes = Object.entries(entree).filter(([k]) => CHAMPS_DIALECTE_ETENDU.has(k));
  return { ...sortie, ...Object.fromEntries(gardes) };
}
