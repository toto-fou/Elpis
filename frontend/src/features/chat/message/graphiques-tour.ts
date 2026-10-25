// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/message/graphiques-tour.ts — graphiques tracés par un outil du tour que la réponse ne cite pas : affichés sous leur étape. */
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

/** Étape (`flat`) → référence des graphiques qu'aucun texte du tour ne cite ; rien tant que le tour s'écrit. */
export function graphiquesNonCites(m: MessageFil): ReadonlyMap<number, string> {
  const out = new Map<number, string>();
  if (m.isStreaming) return out;
  const textes = [...(m.segTexts ?? []), m.content ?? ""].join("\n").toLowerCase();
  (m.toolSteps ?? []).forEach((s, flat) => {
    const ref = refGraphique(s);
    if (ref && !textes.includes(ref.toLowerCase())) out.set(flat, ref);
  });
  return out;
}
