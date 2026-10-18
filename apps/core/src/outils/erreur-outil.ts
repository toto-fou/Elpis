// SPDX-License-Identifier: MIT
/** apps/core/src/outils/erreur-outil.ts — erreur d'outil (`_toolkit.err`) avec le catalogue de libellés `errors.<code>` de context_config. */
import { estDict } from "@elpis/commun";

import { CTX } from "../contexte/config-contexte";
import type { Dict } from "../python";

/** Échec qui apprend au modèle à se rattraper (`_toolkit.err`), libellés surchargeables à froid. */
export function err(
  code: string,
  message: string,
  o: { fix?: string; nextAction?: string; retryable?: boolean } & Dict = {},
): Dict {
  const { fix, nextAction, retryable, ...contexte } = o;
  const e: Dict = { ok: false, error: code, message };
  if (fix) e["fix"] = fix;
  if (nextAction) e["next_action"] = nextAction;
  if (retryable) e["retryable"] = true;
  Object.assign(e, contexte);
  try {
    const ov = CTX.get(`errors.${code}`);
    if (estDict(ov)) {
      if (ov["message"]) e["message"] = ov["message"];
      if (ov["fix"]) e["fix"] = ov["fix"];
    }
  } catch {
    // libellés d'origine
  }
  return e;
}
