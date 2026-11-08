// SPDX-License-Identifier: MIT
/** frontend/src/features/admin/libelles-activite.ts — libellés et teintes des statuts et genres d'exécution et d'appel d'outil (Activité). */

const LIB_STATUT: Readonly<Record<string, string>> = {
  ok: "ok",
  error: "erreur",
  cancelled: "annulée",
  timeout: "délai dépassé",
  running: "en cours",
  lost: "perdue",
  blocked: "bloqué",
};
const LIB_GENRE: Readonly<Record<string, string>> = {
  chat: "Tour de chat",
  routine: "Routine",
  subagent: "Sous-agent",
  compaction: "Compaction",
  image: "Image",
};

export const libStatut = (s: string): string => LIB_STATUT[s] ?? s;
export const libGenre = (k: string): string => LIB_GENRE[k] ?? k;

/** Classe de la pastille d'une exécution. */
export function classeEtatRun(s: string): string {
  if (s === "ok") return "";
  if (s === "running") return "sup-etat--info";
  return s === "cancelled" ? "sup-etat--warn" : "sup-etat--danger";
}

/** Classe de la pastille d'un appel d'outil. */
export function classeEtatOutil(s: string): string {
  if (s === "error") return "sup-etat--danger";
  return s === "blocked" || s === "timeout" ? "sup-etat--warn" : "";
}

/** Format d'un identifiant d'exécution (même règle que le serveur) ; un repli comme « chat » n'en est pas un. */
export const estIdExecution = (id: unknown): id is string =>
  typeof id === "string" && /^[a-z]{1,16}-[A-Za-z0-9_-]{1,64}$/u.test(id);
