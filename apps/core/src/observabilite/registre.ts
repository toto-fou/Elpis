// SPDX-License-Identifier: MIT
/** apps/core/src/observabilite/registre.ts — registre des widgets du tableau de bord : mise en page, calcul borné en parallèle, index des événements (MetricsRegistry). */
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";

import { getLlmHealthSync } from "../llm/sante";
import { dbSizeBytes, dirSizeBytes } from "./fournisseurs/base";
import type { ContexteMetriques, Fournisseur, SystemeMetriques } from "./fournisseurs/base";
import { fournisseursMoteur } from "./fournisseurs/moteur";
import { fournisseursOutils } from "./fournisseurs/outils";
import { fournisseursUsage } from "./fournisseurs/usage";
import type { MoniteurFond } from "./moniteur";
import { cpuCountCores, cpuCountLogical, cpuFreq, diskUsage, SondeProcessus, virtualMemory } from "./sondes";
import type { Executeur } from "@elpis/db";

/** Widgets montrés par défaut : ceux qui répondent à une question d'exploitant, avec une valeur juste. */
export const DEFAULT_WIDGETS: ReadonlySet<string> = new Set([
  "usage_tokens",
  "usage_offhours",
  "usage_turns",
  "usage_failure_rate",
  "usage_cache",
  "usage_input_timeline",
  "usage_thinking",
  "usage_thinking_timeline",
  "usage_timeline",
  "usage_user_peaks",
  "usage_top_users",
  "usage_by_source",
  "usage_by_model",
  "usage_heatmap",
  "usage_turns_timeline",
  "routine_runs",
  "routine_runs_timeline",
  "scheduler_health",
  "kpi_llm_status",
  "kpi_top_model",
  "kpi_users",
  "kpi_dau",
  "kpi_chats",
  "kpi_messages",
  "kpi_avg_tps",
  "kpi_latency_p95",
  "latency_percentiles",
  "tool_error_rate",
  "kpi_ram",
  "kpi_disk",
  "kpi_db_size",
  "system_load",
]);

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** `pool.map` borné : au plus `limite` calculs simultanés, résultats dans l'ordre des entrées. */
async function enParallele<T, R>(
  elements: readonly T[],
  limite: number,
  f: (x: T) => Promise<R>,
): Promise<R[]> {
  const sortie = new Array<R>(elements.length);
  let suivant = 0;
  const ouvrier = async (): Promise<void> => {
    while (suivant < elements.length) {
      const i = suivant++;
      sortie[i] = await f(elements[i] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limite, elements.length)) }, ouvrier));
  return sortie;
}

export class MetricsRegistry {
  readonly providers: Fournisseur[] = [];
  private index: Map<string, string[]> | null = null;

  register(p: Fournisseur): void {
    this.providers.push(p);
    this.index = null;
  }

  /** Widgets dont les données dépendent d'un type d'événement (index inverse construit à la première lecture). */
  affectedProviderIds(eventType: string): string[] {
    if (this.index === null) {
      this.index = new Map();
      for (const p of this.providers)
        for (const et of p.eventTypes) {
          const ids = this.index.get(et) ?? [];
          ids.push(p.id);
          this.index.set(et, ids);
        }
    }
    return this.index.get(eventType) ?? [];
  }

  private async calculer(ctx: ContexteMetriques, p: Fournisseur, scopeHours: number): Promise<Dict> {
    try {
      return await p.getData(ctx, scopeHours);
    } catch (e) {
      return { error: message(e) };
    }
  }

  /** Mise en page (catégorie, défaut, purge) et données de tous les widgets, 12 calculs au plus à la fois. */
  async getDashboardConfig(ctx: ContexteMetriques, scopeHours = 24): Promise<Dict> {
    const layout = this.providers.map((p) => ({
      id: p.id,
      title: p.title,
      type: p.type,
      width: p.width,
      category: p.category,
      default: DEFAULT_WIDGETS.has(p.id),
      purge: p.purgeSpec,
    }));
    const donnees = await enParallele(this.providers, Math.min(this.providers.length, 12), (p) =>
      this.calculer(ctx, p, scopeHours),
    );
    const data: Dict = {};
    this.providers.forEach((p, i) => (data[p.id] = donnees[i]));
    return { layout, data };
  }

  /** Données des seuls widgets demandés (ids inconnus ignorés), dans l'ordre du registre. */
  async getWidgetsData(ctx: ContexteMetriques, ids: Iterable<string>, scopeHours = 24): Promise<Dict> {
    const voulus = new Set(ids);
    const cibles = this.providers.filter((p) => voulus.has(p.id));
    const sortie: Dict = {};
    if (!cibles.length) return sortie;
    const donnees = await enParallele(cibles, Math.min(cibles.length, 8), (p) =>
      this.calculer(ctx, p, scopeHours),
    );
    cibles.forEach((p, i) => (sortie[p.id] = donnees[i]));
    return sortie;
  }
}

/** Registre complet : widgets historiques, puis ceux du registre d'usage, puis ceux des outils. */
export function creerRegistre(): MetricsRegistry {
  const r = new MetricsRegistry();
  for (const p of [...fournisseursMoteur(), ...fournisseursUsage(), ...fournisseursOutils()]) r.register(p);
  return r;
}

export const registry = creerRegistre();

/** Mesures réelles du système : sondes /proc et /sys, statfs, base et dossiers relatifs au répertoire courant. */
export function systemeDuProcess(processus: SondeProcessus = new SondeProcessus()): SystemeMetriques {
  return {
    virtualMemory: () => virtualMemory(),
    diskUsage: (chemin) => diskUsage(chemin),
    cpuCountLogical: () => cpuCountLogical(),
    cpuCountCores: () => cpuCountCores(),
    cpuFreq: () => cpuFreq(),
    createTime: () => processus.createTime(),
    tailleBase: () => dbSizeBytes(config.DB_PATH),
    tailleDossier: (chemin) => dirSizeBytes(chemin),
  };
}

/** Contexte des widgets pour la base du process et son moniteur de fond (historique vide sans moniteur). */
export function contexteMetriques(base: Executeur, moniteur: MoniteurFond | null = null): ContexteMetriques {
  return {
    base,
    systeme: systemeDuProcess(),
    historique: () => moniteur?.history ?? [],
    santeLlm: () => getLlmHealthSync(),
  };
}
