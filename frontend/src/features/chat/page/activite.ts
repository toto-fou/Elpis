// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/page/activite.ts — retour à une ligne du fil : étape `shell_job` d'une tâche de fond, défilement jusqu'à la ligne avec un bref surlignage. */
import type { MessageChat } from "../coeur/types";

const messagesChat = (m: readonly unknown[]): readonly MessageChat[] => m as readonly MessageChat[];

/** Appel `shell_job` qui a lancé ce job : son identifiant figure dans le résultat de l'outil. */
export function appelDuJob(messages: readonly unknown[], jobId: string): string | null {
  const liste = messagesChat(messages);
  for (let i = liste.length - 1; i >= 0; i--) {
    for (const s of liste[i]?.toolSteps ?? []) {
      if (s.name !== "shell_job" || !s.callId) continue;
      const res = typeof s.result === "string" ? s.result : JSON.stringify(s.result ?? "");
      if (res.includes(jobId)) return s.callId;
    }
  }
  return null;
}

const SURLIGNAGE_MS = 1200;

/** Fait défiler jusqu'à la ligne visible de l'étape (elle-même ou son groupe replié, `data-etapes`) et la surligne ; faux si elle est absente. */
export function allerALEtape(callId: string | null | undefined): boolean {
  if (!callId) return false;
  const id = CSS.escape(callId);
  const visible = (sel: string): HTMLElement | null =>
    [...document.querySelectorAll<HTMLElement>(sel)].find((l) => !l.closest("[hidden]")) ?? null;
  const el = visible(`[data-etape="${id}"]`) ?? visible(`[data-etapes~="${id}"]`);
  if (!el) return false;
  const reduit = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  el.scrollIntoView({ block: "center", behavior: reduit ? "auto" : "smooth" });
  if (!reduit && typeof el.animate === "function") {
    el.animate([{ boxShadow: "0 0 0 3px var(--accent-ring)" }, { boxShadow: "0 0 0 0 transparent" }], {
      duration: SURLIGNAGE_MS,
      easing: "ease-out",
    });
  } else {
    el.style.outline = "2px solid var(--accent-ring)";
    setTimeout(() => (el.style.outline = ""), SURLIGNAGE_MS);
  }
  return true;
}
