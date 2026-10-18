// SPDX-License-Identifier: MIT
/** frontend/src/features/routines/journal.ts — affichage du journal des runs : libellés, classes, durées, texte de la réponse et aperçu. */

export interface RunAffichable {
  status?: string | null;
  summary?: string | null;
  error?: string | null;
  files?: unknown[] | null;
}

/** Le serveur tronque le résumé à 4000 caractères. */
export const PLAFOND_RESUME_RUN = 4000;

const LIBELLES_STATUT: Readonly<Record<string, string>> = {
  ok: "Réussi",
  error: "Échec",
  running: "En cours",
  skipped: "Ignoré",
  orphaned: "Interrompu",
  cancelled: "Arrêté",
};

const CLASSES_STATUT: Readonly<Record<string, string>> = {
  ok: "bg-emerald-100 text-emerald-700",
  error: "bg-red-100 text-red-700",
  running: "bg-blue-100 text-blue-700",
  skipped: "bg-slate-100 text-slate-500",
  orphaned: "bg-amber-100 text-amber-700",
  cancelled: "bg-slate-200 text-slate-600",
};

export function libelleStatut(status: unknown): string {
  const s = typeof status === "string" ? status : "";
  return LIBELLES_STATUT[s] || s || "—";
}

export function classeStatut(status: unknown): string {
  return (typeof status === "string" ? CLASSES_STATUT[status] : undefined) || "bg-slate-100 text-slate-500";
}

export function formaterHeure(ts: number | null | undefined): string {
  if (!ts) return "—";
  try {
    return new Date(ts * 1000).toLocaleString("fr-FR");
  } catch {
    return "—";
  }
}

/** Bascule s → min → h aux seuils usuels. */
export function formaterDuree(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)} s`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(Math.round(m % 60)).padStart(2, "0")}`;
}

export function formaterRelatif(ts: unknown, maintenant = Date.now()): string {
  if (typeof ts !== "number" || !ts) return "";
  const s = Math.max(0, Math.floor(maintenant / 1000 - ts));
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  return `il y a ${Math.floor(s / 86400)} j`;
}

/** Retire le raisonnement resté dans les résumés persistés avant le nettoyage du serveur. */
export function retirerReflexion(t: string | null | undefined): string {
  let s = String(t || "");
  if (!/<think>|<\|thinking\|>/i.test(s)) return s;
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "");
  s = s.replace(/<\|thinking\|>[\s\S]*?<\|\/thinking\|>/gi, "");
  s = s.replace(/<think>[\s\S]*$/i, "");
  s = s.replace(/<\|thinking\|>[\s\S]*$/i, "");
  return s.trim();
}

export function runEstMarkdown(run: RunAffichable | null | undefined): boolean {
  return !!run && run.status !== "error" && run.status !== "orphaned" && run.status !== "skipped";
}

/** Réponse finale, ou erreur / raison d'abandon selon le statut. */
export function texteDetailRun(run: RunAffichable | null | undefined): string {
  if (!run) return "";
  if (run.status === "error" || run.status === "orphaned" || run.status === "skipped") return run.error || "";
  return retirerReflexion(run.summary || "");
}

/** Aperçu d'une ligne : le Markdown est aplati. */
export function apercuRun(run: RunAffichable | null | undefined): string {
  const t = texteDetailRun(run);
  if (!t || !runEstMarkdown(run)) return t;
  return t
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^\s*\|.*$/gm, " ")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}[-*+]\s+/gm, "")
    .replace(/[`*_>#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Mesure sur le résumé brut : le serveur tronque avant le retrait de la réflexion. */
export function runEstTronque(run: RunAffichable | null | undefined): boolean {
  return runEstMarkdown(run) && String(run?.summary || "").length >= PLAFOND_RESUME_RUN;
}

export function fichiersRun(run: RunAffichable | null | undefined): string[] {
  return run && Array.isArray(run.files) ? run.files.map(String) : [];
}

export function nomDeFichier(p: string | null | undefined): string {
  const s = String(p || "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return (i >= 0 ? s.slice(i + 1) : s) || s;
}
