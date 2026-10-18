// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/evenements.ts — décodage d'une valeur du flux NDJSON en `EvenementFlux` validé par `@elpis/contracts`. */
import { isStreamEventType, schemaEvenementFlux } from "@elpis/contracts";
import type { EvenementFlux, StreamEventType } from "@elpis/contracts";

export type Decode =
  | { readonly statut: "valide"; readonly ev: EvenementFlux }
  | { readonly statut: "hors_contrat"; readonly type: StreamEventType; readonly raison: string }
  | { readonly statut: "inconnu"; readonly type: string }
  | { readonly statut: "invalide"; readonly raison: string };

function estObjet(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const CLES_DELTA = new Set(["type", "text", "n", "_s"]);

/** Delta de texte conforme au schéma strict (`text` chaîne, `n` et `_s` entiers facultatifs, aucune autre clé) : la forme la plus fréquente du flux, vérifiée sans Zod. */
function deltaConforme(brut: Record<string, unknown>): boolean {
  if (typeof brut["text"] !== "string") return false;
  for (const cle in brut) {
    if (!CLES_DELTA.has(cle)) return false;
    if ((cle === "n" || cle === "_s") && !Number.isSafeInteger(brut[cle])) return false;
  }
  return true;
}

/** Type connu mais charge hors schéma : « hors_contrat » (signalé, jamais typé) ; type inconnu ou valeur non objet : refusé. */
export function decoderEvenement(brut: unknown): Decode {
  if (!estObjet(brut)) return { statut: "invalide", raison: "valeur non objet" };
  const type = brut["type"];
  if (typeof type !== "string") return { statut: "invalide", raison: "champ type absent" };
  if (!isStreamEventType(type)) return { statut: "inconnu", type };
  if ((type === "content_token" || type === "thinking_token") && deltaConforme(brut))
    return { statut: "valide", ev: brut as EvenementFlux };
  const r = schemaEvenementFlux.safeParse(brut);
  if (r.success) return { statut: "valide", ev: r.data };
  const premiere = r.error.issues[0];
  const raison = premiere ? `${premiere.path.join(".") || "(racine)"} : ${premiere.message}` : "schéma";
  return { statut: "hors_contrat", type, raison };
}
