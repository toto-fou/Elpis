// SPDX-License-Identifier: MIT
/** apps/core/src/llm/infill.ts — complétion de code FIM (`/infill`) de l'éditeur ; un serveur muet est signalé au disjoncteur (la route l'enveloppe de `withLLM`). */
import { veritePy } from "@elpis/commun";

import { journal } from "../journal";
import type { Dict } from "../python";
import { getPy, inPy, itemPy } from "./dict-py";
import { llamaPost } from "./llama-http";
import { currentEngine } from "./moteurs";
import { BREAKER_TRANSPORT_ERRORS } from "./ordonnanceur/disjoncteur";
import { resolveSampling } from "./parametres";
import { disjoncteur, ErreurPortAbsent } from "./ports";

const log = journal("infill");

export const FIM_STOP: readonly string[] = [
  "\n\n\n",
  "<|endoftext|>",
  "<|fim_pad|>",
  "<|file_separator|>",
  "```",
];

/** Panne de transport : comptée par le disjoncteur comme pour un tour de chat (le garde ne voit qu'un succès). */
function signalerServeurMuet(r: Dict, model: string | null): void {
  if (!BREAKER_TRANSPORT_ERRORS.has(String(r["error_type"]))) return;
  try {
    disjoncteur().signalerPanneTransport(currentEngine(), model);
  } catch (e) {
    if (!(e instanceof ErreurPortAbsent)) throw e;
    log.debug("disjoncteur non branché : panne non comptée");
  }
}

/** `/infill` : sampling du modèle (profil `infill`), arrêts propres au FIM ; `{ok, content, model}` ou `{ok:false, error, hint}`. */
export async function llmInfill(
  inputPrefix: string,
  inputSuffix: string,
  model: string | null = null,
): Promise<Dict> {
  const sampling = await resolveSampling(model, "infill");
  const corps: Dict = {
    input_prefix: inputPrefix,
    input_suffix: inputSuffix,
    ...sampling,
    stop: [...FIM_STOP],
  };
  if (model) corps["model"] = model;
  const r = await llamaPost("/infill", corps, 60.0);
  if (r["_status"] === 0) signalerServeurMuet(r, model);
  if (r["_status"] === 200) {
    let contenu = getPy(r, "content", "");
    if (!veritePy(contenu) && inPy("choices", r)) {
      const choix = itemPy(r, "choices");
      if (Array.isArray(choix) && choix.length > 0) {
        const premier = choix[0];
        const texte = getPy(premier, "text", "");
        contenu = veritePy(texte) ? texte : getPy(premier, "content", "");
      }
    }
    return { ok: true, content: contenu, model: getPy(r, "model", model || "") };
  }
  return {
    ok: false,
    error: getPy(r, "error", "Endpoint /infill non disponible."),
    hint: "Vérifiez que le modèle supporte FIM (Fill-In-the-Middle).",
  };
}
