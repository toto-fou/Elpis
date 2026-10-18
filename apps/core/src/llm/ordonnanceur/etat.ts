// SPDX-License-Identifier: MIT
/** apps/core/src/llm/ordonnanceur/etat.ts — widget de file (`queue_status`), durées estimées, mode. */

export const DEFAULT_ESTIMATE_MS = 15_000;
export const RECENT_LLM_DURATIONS_MAX = 20;

export type ModeOrdonnancement = "classic" | "optimized";
type Attente = { model: string; loaded: string | null; position: number; active: number; est_ms: number };
export type QueueStatus = { kind: "ready" } | ({ kind: "waiting" | "loading" } & Attente);

/** Ce que la file sait au moment de la demande : entrées de `_build_queue_status`, inventaire du routeur compris. */
export type EntreeEtat = {
  model: string;
  exclModel: string | null;
  exclCount: number;
  statuts: ReadonlyMap<string, string> | null;
  chargeConnu: string | null;
  actifs: number;
  enAttente: number;
  plein: boolean;
  dureeUnitaire: number;
  dureeChargement: number;
};

/** `sum()` de Python ≥ 3.12 sur des flottants (compensation de Neumaier) : moyennes identiques au bit près. */
export function sommePython(valeurs: readonly number[]): number {
  let [somme, compensation] = [0 + (valeurs[0] ?? 0), 0];
  for (const x of valeurs.slice(1)) {
    const t = somme + x;
    compensation += Math.abs(somme) >= Math.abs(x) ? somme - t + x : x - t + somme;
    somme = t;
  }
  return compensation && Number.isFinite(compensation) ? somme + compensation : somme;
}

/** `record_llm_duration` : fenêtre glissante des 20 dernières durées strictement positives, par modèle. */
export function ajouterDuree(fenetres: Map<string, number[]>, model: string, dureeMs: number): void {
  const fenetre = fenetres.get(model) ?? fenetres.set(model, []).get(model) ?? [];
  if (Number.isFinite(dureeMs) && dureeMs > 0) fenetre.push(dureeMs);
  if (fenetre.length > RECENT_LLM_DURATIONS_MAX) fenetre.shift();
}

/** `estimate_single_run_ms` : moyenne de la fenêtre majorée de 20 %, 15 s sans mesure. */
export function estimerDuree(fenetre: readonly number[]): number {
  if (fenetre.length === 0) return DEFAULT_ESTIMATE_MS;
  return Math.trunc((sommePython(fenetre) / fenetre.length) * 1.2);
}

/** `resolve_scheduling_mode` : `llm.scheduling_mode`, « auto » par défaut, suit alors le mode recommandé. */
export function resoudreMode(valeur: unknown, recommande: ModeOrdonnancement): ModeOrdonnancement {
  const brut = valeur || "auto";
  const mode = typeof brut === "object" ? "" : String(brut).toLowerCase();
  return mode === "classic" || mode === "optimized" ? mode : recommande;
}

/** `_build_queue_status` après lecture de l'inventaire du routeur (`get_queue_status_for_async`). */
export function construireEtat(e: EntreeEtat): QueueStatus {
  const charges = e.statuts?.size ? [...e.statuts].filter(([, s]) => s === "loaded").map(([m]) => m) : null;
  const loaded = !charges ? e.chargeConnu : charges.includes(e.model) ? e.model : (charges[0] ?? null);
  const switchExcl = Boolean(e.exclModel && e.exclModel !== e.model);
  const switchLlama = charges?.length === 0 || Boolean(loaded && loaded !== e.model);
  if (!switchExcl && !switchLlama && !e.plein) return { kind: "ready" };
  const position = switchExcl ? e.exclCount + 1 : switchLlama ? 1 : e.enAttente + 1;
  const estMs = switchExcl ? e.dureeUnitaire * e.exclCount : switchLlama ? 0 : e.dureeUnitaire * position;
  const kind = switchExcl || switchLlama ? "loading" : "waiting";
  const chargement = kind === "loading" ? e.dureeChargement : 0;
  const active = Math.max(e.actifs, e.exclCount, 1);
  return {
    kind,
    model: e.model,
    loaded: loaded || e.exclModel,
    position,
    active,
    est_ms: Math.trunc(estMs + chargement),
  };
}
