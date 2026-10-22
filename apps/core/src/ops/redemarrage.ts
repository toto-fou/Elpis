// SPDX-License-Identifier: MIT
/** apps/core/src/ops/redemarrage.ts — rechargement gracieux du process (`schedule_self_reload`), générations en cours et appel de `restart-self` de main. */
import { setTimeout as attendre } from "node:timers/promises";

import type { PortCycleVie } from "../admin/securite";
import type { CycleDeVie } from "../cycle";
import { DELAI_ARRET_MS } from "../cycle";
import type { AppelInterne } from "../evenements/canal";
import type { Journal } from "../journal";
import { verrousChat } from "../tour/etat";

export const DELAI_RECHARGEMENT_MS = 5_000;
const DELAI_APPEL_MAIN_MS = 5_000;

/** Générations en cours vues par un process : les siennes (main), celles de main par le canal interne (admin) ; `null` = inconnu. */
export type SourceGenerations = () => Promise<number | null>;

/** `active_generations` : verrous « gen » tenus par les tours du chat de ce process ; une panne vaut 0. */
export function activeGenerations(): Promise<number> {
  try {
    return Promise.resolve(verrousChat.countHeld("gen"));
  } catch {
    return Promise.resolve(0);
  }
}

export const CHEMIN_GENERATIONS = "/api/internal/generations";

/** Générations de main lues depuis l'admin (`GET /api/internal/generations`, jeton interne) ; main injoignable ou réponse illisible : `null`. */
export async function lireGenerationsMain(appel: {
  url: string;
  jeton: () => string;
  fetch?: typeof fetch;
  delaiMs?: number;
}): Promise<number | null> {
  try {
    const r = await (appel.fetch ?? fetch)(`${appel.url.replace(/\/+$/u, "")}${CHEMIN_GENERATIONS}`, {
      headers: { authorization: `Bearer ${appel.jeton()}` },
      signal: AbortSignal.timeout(appel.delaiMs ?? DELAI_APPEL_MAIN_MS),
    });
    if (!r.ok) {
      await r.body?.cancel().catch(() => undefined);
      return null;
    }
    const corps = (await r.json()) as { active_generations?: unknown } | null;
    const n = corps?.active_generations;
    return typeof n === "number" && Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** Plafond du drain : le process attend au plus `DELAI_ARRET_MS` que ses générations finissent avant de s'arrêter. */
export function gracefulDrainSeconds(): number {
  return DELAI_ARRET_MS / 1000;
}

let minuterie: NodeJS.Timeout | undefined;

/** `schedule_self_reload` : après `delaiMs`, attend (en servant toujours) que ses générations finissent, au plus `drainMs`, puis demande l'arrêt gracieux ; un seul en attente, annulé si le process s'arrête avant. */
export function planifierRechargement(
  cycle: CycleDeVie,
  journal: Journal,
  delaiMs = DELAI_RECHARGEMENT_MS,
  sourceGenerations: SourceGenerations = activeGenerations,
  options: { locales?: SourceGenerations; drainMs?: number; pauseMs?: number } = {},
): void {
  void sourceGenerations().then((n) => {
    if (n)
      journal.warn(
        `[reload] ${n} génération(s) en cours : le redémarrage attend leur fin (plafond ${gracefulDrainSeconds()} s), les requêtes restent servies jusque-là.`,
      );
  });
  if (minuterie !== undefined) {
    journal.info("[reload] rechargement déjà planifié");
    return;
  }
  const locales = options.locales ?? activeGenerations;
  const drainMs = options.drainMs ?? DELAI_ARRET_MS;
  const arret = cycle.signalArret;
  const drainer = async (): Promise<void> => {
    const limite = performance.now() + drainMs;
    for (;;) {
      const n = await locales();
      if (arret.aborted) return;
      if (n === 0 || performance.now() >= limite) break;
      try {
        await attendre(options.pauseMs ?? 1_000, undefined, { signal: arret });
      } catch {
        return;
      }
    }
    minuterie = undefined;
    if (!cycle.demanderRedemarrage())
      journal.error(
        "[reload] rechargement impossible (arrêt déjà en cours ou non branché) — les binds n'ont PAS changé",
      );
  };
  const t = setTimeout(() => void drainer(), delaiMs);
  minuterie = t;
  arret.addEventListener(
    "abort",
    () => {
      clearTimeout(t);
      if (minuterie === t) minuterie = undefined;
    },
    { once: true },
  );
  journal.info(
    `[reload] scheduled graceful reload in ${Math.round(delaiMs / 1000)}s, pid=${process.pid} ppid=${process.ppid}`,
  );
}

/** Pour les tests : oublie un rechargement planifié. */
export function annulerRechargement(): void {
  clearTimeout(minuterie);
  minuterie = undefined;
}

/** URL de main pour `/api/admin/restart` : `MAIN_INTERNAL_URL`, sinon `MAIN_PUBLIC_URL`, sinon la boucle locale ; `/` finaux retirés. */
export function urlMainRedemarrage(env: Record<string, string | undefined> = process.env): string {
  return (env["MAIN_INTERNAL_URL"] || env["MAIN_PUBLIC_URL"] || "http://127.0.0.1:8001").replace(/\/+$/u, "");
}

/** URL de main pour les bascules (base, HTTPS) : `MAIN_INTERNAL_URL` seule, sinon la boucle locale. */
export function urlMainInterneBrute(env: Record<string, string | undefined> = process.env): string {
  return (env["MAIN_INTERNAL_URL"] || "http://127.0.0.1:8001").replace(/\/+$/u, "");
}

export interface ReponseMain {
  readonly statut: number;
  readonly texte: string;
}

/** `POST <main>/api/admin/internal/restart-self` sous le jeton interne (E18) ; une erreur réseau ou un délai dépassé lève. */
export async function appelerRestartSelf(
  urlMain: string,
  jeton: string,
  options: { fetch?: typeof fetch; delaiMs?: number } = {},
): Promise<ReponseMain> {
  const reponse = await (options.fetch ?? fetch)(`${urlMain}/api/admin/internal/restart-self`, {
    method: "POST",
    headers: { authorization: `Bearer ${jeton}` },
    signal: AbortSignal.timeout(options.delaiMs ?? DELAI_APPEL_MAIN_MS),
  });
  return { statut: reponse.status, texte: await reponse.text() };
}

/** Texte d'une erreur réseau (`str(exc)` de httpx) : la cause d'undici quand elle existe. */
export function messageErreurReseau(e: unknown): string {
  if (e instanceof Error && e.name === "TimeoutError") return "timed out";
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.message) return cause.message;
  return e instanceof Error ? e.message : String(e);
}

export interface DependancesRedemarrage {
  readonly cycle: CycleDeVie;
  readonly journal: Journal;
  /** `metric_broadcast.publish_event` : bannière vue par les clients de tous les process. */
  diffuserPartout(message: Record<string, unknown>): Promise<boolean>;
  /** Jeton interne vers main ; absent dans main lui-même (un seul process à recharger). */
  readonly jetonMain?: () => string;
  readonly fetch?: typeof fetch;
  readonly generations?: SourceGenerations;
}

/** `_reloader` (page Base) et `_restart_app` (HTTPS) : bannière `restart`, `restart-self` de main depuis l'admin, puis rechargement de soi ; rend faux si main n'a pas accusé. */
export async function redemarrerMainPuisSoi(
  dep: DependancesRedemarrage,
  message: string,
  etiquette: string,
): Promise<boolean> {
  try {
    await dep.diffuserPartout({ type: "restart", message, started_at: Date.now() / 1000 });
  } catch (e) {
    dep.journal.warn({ err: e }, `[${etiquette}] annonce du redémarrage impossible`);
  }
  let mainOk = true;
  if (dep.jetonMain) {
    try {
      const r = await appelerRestartSelf(urlMainInterneBrute(), dep.jetonMain(), { fetch: dep.fetch });
      mainOk = r.statut === 200;
      if (!mainOk)
        dep.journal.warn(`[${etiquette}] main restart-self returned ${r.statut}: ${r.texte.slice(0, 200)}`);
    } catch (e) {
      mainOk = false;
      dep.journal.warn(`[${etiquette}] redémarrage de main impossible : ${messageErreurReseau(e)}`);
    }
  }
  planifierRechargement(dep.cycle, dep.journal, DELAI_RECHARGEMENT_MS, dep.generations);
  return mainOk;
}

/** Cycle de vie de la console Sécurité (HTTPS, écoute) : `restart-self` de main depuis l'admin, puis rechargement de soi. */
export function portCycleVie(cycle: CycleDeVie, journal: Journal, versMain?: AppelInterne): PortCycleVie {
  return {
    redemarrerMain: async () =>
      versMain === undefined ||
      (await appelerRestartSelf(urlMainInterneBrute(), versMain.jeton(), { fetch: versMain.fetch }))
        .statut === 200,
    programmerRechargement: (delaiS) =>
      planifierRechargement(
        cycle,
        journal,
        delaiS * 1000,
        versMain ? () => lireGenerationsMain(versMain) : activeGenerations,
      ),
  };
}
