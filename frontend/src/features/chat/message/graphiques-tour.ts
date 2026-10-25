// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/graphiques-tour.ts — graphiques tracés par un outil du tour que la réponse finale ne cite pas : tracés à sa suite, seul endroit où un graphique est rendu. */
import type { EtapeOutil } from "../outils/types.ts";
import type { MessageFil } from "./chronologie.ts";

const REF = /^![0-9a-f]{12}$/i;

/** Référence `!id` rendue par un outil `chart_*`, sinon une chaîne vide. */
export function refGraphique(s: EtapeOutil): string {
  if (!(s.name ?? "").startsWith("chart_")) return "";
  let r: unknown = s.result;
  if (typeof r === "string") {
    try {
      r = JSON.parse(r);
    } catch {
      return "";
    }
  }
  const ref = r && typeof r === "object" ? (r as Record<string, unknown>)["ref"] : null;
  return typeof ref === "string" && REF.test(ref) ? ref : "";
}

/** Références des graphiques du tour que la réponse finale ne cite pas, dans l'ordre et sans doublon ; rien tant que le tour s'écrit. */
export function graphiquesNonCites(m: MessageFil): string[] {
  if (m.isStreaming) return [];
  const reponse = (m.content ?? "").toLowerCase();
  const refs = (m.toolSteps ?? []).map(refGraphique).filter((r) => r && !reponse.includes(r.toLowerCase()));
  return [...new Set(refs)];
}
