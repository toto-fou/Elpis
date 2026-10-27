// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/execution-outils.ts — exécution d'un lot d'appels d'outils : série pour les mutants, parallèle borné sinon (sous-agents `task` consécutifs ensemble, à la seule borne de l'administrateur, hors LLAMA_TOOL_PARALLELISM), progression et journaux, télémétrie, aucun frère orphelin. */
import {
  CancelledError,
  estDict,
  estErreurAnnulation,
  jsonLoads,
  longueurPy,
  prefixePy,
  pyJsonDumps,
  strPy,
  utf8Remplace,
} from "@elpis/commun";
import { sousPrefixes } from "@elpis/securite";
import type { SousAgent } from "@elpis/securite";

import { LLAMA_TOOL_PARALLELISM } from "../llm/constantes";
import { journal } from "../journal";
import type { ClasseLot, ContexteParent } from "../outils/catalogue";
import { categorize } from "../outils/categories";
import { flattenExceptionMessage } from "../outils/mcp/clients";
import { toolTraits } from "../outils/traits";
import type { Dict } from "../python";
import { emit } from "./evenements";
import type { SurEvenement } from "./evenements";
import { executionEnCours, logMetric } from "./ports";
import { watchToolCall } from "./surveillance";

const log = journal("boucle.execution-outils");

export const TELEMETRY_WAIT_S = 0.25;

export interface Progression {
  progress: number;
  total?: number | undefined;
  message?: string | undefined;
}

export interface RappelsOutil {
  meta?: Dict | null;
  /** Id de l'appel du modèle : les `task_step` d'un sous-agent le portent. */
  callId?: string | null;
  /** Périmètre du sous-agent qui appelle : son échéance souple borne l'appel, sa durée restante est reprise à l'envoi. */
  sousAgent?: SousAgent | null;
  /** Contexte du run appelant, transmis à l'outil intégré (un `task` en `fork`). */
  parent?: (() => ContexteParent) | null;
  onProgress?: ((p: Progression) => void | Promise<void>) | null;
  onLog?: ((params: Dict) => void | Promise<void>) | null;
  /** Un outil intégré y enregistre le résultat à rendre si le tour est annulé pendant l'appel (cf. `AppelIntegre`). */
  rendreSiAnnule?: ((fournir: () => string | null) => void) | null;
  signal?: AbortSignal | undefined;
}

export type ExecuteSingle = (toolName: string, finalArgs: Dict, o: RappelsOutil) => Promise<unknown>;

function chargerDict(texte: string): Dict | null {
  try {
    const v = jsonLoads(texte);
    return estDict(v) ? v : null;
  } catch {
    return null;
  }
}

/** Statut d'un appel pour `tool_call_metrics` : `blocked`, `timeout`, `error` ou `success`. */
export function callStatus(p: Dict, result: string, status: string): string {
  if (p["args_error"]) return "blocked";
  if (status !== "error") return "success";
  if (prefixePy(result, 200).includes('"timeout"')) {
    const d = chargerDict(result);
    if (d !== null && d["error"] === "timeout") return "timeout";
  }
  return "error";
}

/** Code de sortie d'une commande (`returncode` du résultat), sinon `null`. */
export function exitCode(result: string): number | null {
  if (!result.includes('"returncode"')) return null;
  const rc = chargerDict(result)?.["returncode"];
  if (typeof rc === "bigint") return Number(rc);
  return typeof rc === "number" && Number.isInteger(rc) ? rc : null;
}

const CLES_SHELL = [
  "stream",
  "seq",
  "done",
  "returncode",
  "duration_ms",
  "timed_out",
  "bytes_total",
  "live_truncated",
];

/** Événement `shell_output` d'une charge de sortie en direct (`call_id` : seul discriminant de deux shells parallèles). */
function evenementShell(nom: string, callId: unknown, charge: Dict): Dict {
  const ev: Dict = { type: "shell_output", name: nom, call_id: callId ?? null };
  for (const k of CLES_SHELL) if (Object.hasOwn(charge, k)) ev[k] = charge[k];
  if (typeof charge["chunk"] === "string") ev["chunk"] = prefixePy(charge["chunk"], 8192);
  return ev;
}

/** Notification de journal MCP : battement tu, sortie de shell en direct, sinon `tool_log`. */
async function relayerJournal(
  onEvent: SurEvenement,
  nom: string,
  callId: unknown,
  params: Dict,
): Promise<void> {
  const level = params["level"] || "info";
  const loggerName = params["logger"] || "";
  let data = params["data"];
  const extra = estDict(data) ? data["extra"] : undefined;
  if (estDict(extra) && extra["kind"] === "heartbeat") return;
  if (estDict(extra) && extra["kind"] === "shell_output") {
    await emit(onEvent, evenementShell(nom, callId, extra));
    return;
  }
  if (estDict(data) && Object.hasOwn(data, "msg")) data = data["msg"];
  if (typeof data === "string" && data.includes("__shell_output__")) {
    let lu: unknown;
    try {
      lu = jsonLoads(data);
    } catch {
      lu = null;
    }
    const charge = estDict(lu) ? lu["__shell_output__"] : undefined;
    if (estDict(charge)) {
      await emit(onEvent, evenementShell(nom, callId, charge));
      return;
    }
  }
  let msg: string;
  if (estDict(data) || Array.isArray(data)) {
    try {
      msg = prefixePy(pyJsonDumps(data, { ensureAscii: false }), 1000);
    } catch {
      msg = prefixePy(strPy(data), 1000);
    }
  } else msg = data !== null && data !== undefined ? prefixePy(strPy(data), 1000) : "";
  await emit(onEvent, {
    type: "tool_log",
    name: nom,
    ...(callId !== null && callId !== undefined ? { call_id: strPy(callId) } : {}),
    level: strPy(level),
    logger: strPy(loggerName),
    message: msg,
  });
}

/** Sémaphore d'exécution (`asyncio.Semaphore`) : l'ordre d'arrivée est respecté. */
class Semaphore {
  private libres: number;
  private readonly attente: (() => void)[] = [];

  constructor(n: number) {
    this.libres = n;
  }

  async prendre(): Promise<void> {
    if (this.libres > 0) {
      this.libres--;
      return;
    }
    await new Promise<void>((ok) => this.attente.push(ok));
  }

  rendre(): void {
    const suivant = this.attente.shift();
    if (suivant) suivant();
    else this.libres++;
  }
}

function attendreMs(ms: number): Promise<void> {
  return new Promise((ok) => {
    const t = setTimeout(ok, ms);
    t.unref();
  });
}

/** Deux appels dont l'un au moins écrit se gênent : l'un écrit partout (`null`) et l'autre quelque part, ou deux préfixes de chemin s'emboîtent ; `[]` n'écrit nulle part. */
export function ecrituresEnConflit(a: ClasseLot, b: ClasseLot): boolean {
  if (!a.ecrit || !b.ecrit) return false;
  const [x, y] = [a.chemins, b.chemins];
  if (x === null) return y === null || y.length > 0;
  if (y === null) return x.length > 0;
  return x.some((p) => y.some((q) => sousPrefixes(p, [q]) || sousPrefixes(q, [p])));
}

const RIEN: ClasseLot = { ecrit: false, chemins: [] };

export interface OptionsLot {
  executeSingle: ExecuteSingle;
  recordMetric: (...args: unknown[]) => unknown;
  isToolFailure: (r: unknown) => boolean;
  onEvent: SurEvenement;
  username: string;
  chatId: string | null;
  onCancelSnapshot: () => Promise<void>;
  iteration: number;
  emitProgressLog?: boolean;
  isCancelled?: (() => boolean) | null;
  signal?: AbortSignal | undefined;
  resultsOut?: Map<number, string>;
  /** Appels `task` consécutifs lancés ensemble au plus (1 : l'un après l'autre). */
  tachesSimultanees?: number;
  /** Classe un appel du lot (outil intégré à classeur) ; deux appels qui écrivent sur les mêmes chemins partent l'un après l'autre, dans l'ordre du lot. */
  classer?: ((nom: string, args: Dict) => ClasseLot | null) | null;
}

/** Exécute `prepared` (`{call_id, tool_name, final_args, meta, args_error}`) dans l'ordre du modèle ; rend `index → résultat JSON`. */
export async function executeToolBatch(prepared: Dict[], o: OptionsLot): Promise<Map<number, string>> {
  const resultats = o.resultsOut ?? new Map<number, string>();
  const parallelisme = Math.max(1, LLAMA_TOOL_PARALLELISM);
  const sem = new Semaphore(parallelisme);
  const limiteTaches = Math.max(1, Math.trunc(o.tachesSimultanees ?? 1));
  const semTaches = new Semaphore(limiteTaches);
  const emitProgressLog = o.emitProgressLog ?? true;
  const annulationReelle = (signalLot?: AbortSignal): boolean =>
    Boolean((o.isCancelled && o.isCancelled()) || o.signal?.aborted || signalLot?.aborted);
  let instantaneDuLot = false;

  const execOne = async (
    idx: number,
    p: Dict,
    signalLot?: AbortSignal,
    avant: readonly Promise<unknown>[] = [],
  ): Promise<void> => {
    const nom = strPy(p["tool_name"]);
    const signal = signalLot ?? o.signal;
    const callId = p["call_id"] === null || p["call_id"] === undefined ? null : strPy(p["call_id"]);
    const rappels: RappelsOutil = emitProgressLog
      ? {
          onProgress: async (pr: Progression) => {
            try {
              await emit(o.onEvent, {
                type: "tool_progress",
                name: nom,
                ...(callId !== null ? { call_id: callId } : {}),
                progress: Number(pr.progress),
                total: pr.total !== undefined && pr.total !== null ? Number(pr.total) : null,
                message: pr.message || "",
              });
            } catch (e) {
              if (estErreurAnnulation(e)) throw e;
            }
          },
          onLog: async (params: Dict) => {
            try {
              await relayerJournal(o.onEvent, nom, p["call_id"], params);
            } catch (e) {
              if (estErreurAnnulation(e)) throw e;
              log.debug(`[tool_log emit] échec : ${String(e)}`);
            }
          },
        }
      : {};
    let rendu: (() => string | null) | null = null;
    const rappelsOutil: RappelsOutil = {
      ...rappels,
      rendreSiAnnule: (fournir) => {
        rendu = fournir;
      },
    };
    /** Annulation réelle : le résultat que l'outil a promis de rendre part dans le lot partiel, que l'instantané matérialise ; sans lui, la sentinelle. */
    const deposerRendu = (): void => {
      if (rendu === null || resultats.has(idx)) return;
      try {
        const r = rendu();
        if (typeof r === "string" && r) resultats.set(idx, r);
      } catch {
        // la sentinelle reste le repli
      }
    };
    const borne = nom === "task" ? semTaches : sem;
    await Promise.all(avant);
    await borne.prendre();
    if (annulationReelle(signalLot)) {
      borne.rendre();
      if (!instantaneDuLot) await o.onCancelSnapshot();
      throw new CancelledError("User cancelled");
    }
    let duree: number;
    const debut = Date.now() / 1000;
    try {
      const t0 = performance.now();
      try {
        const r = p["args_error"]
          ? { ok: false, error: p["args_error"] }
          : await o.executeSingle(nom, p["final_args"] as Dict, {
              meta: (p["meta"] as Dict | null) ?? null,
              callId,
              ...rappelsOutil,
              signal,
            });
        resultats.set(idx, typeof r === "string" ? r : pyJsonDumps(r));
      } catch (e) {
        if (annulationReelle(signalLot)) {
          deposerRendu();
          if (!instantaneDuLot) await o.onCancelSnapshot();
          throw e;
        }
        resultats.set(
          idx,
          estErreurAnnulation(e)
            ? pyJsonDumps({
                error: `outil '${nom}' : transport MCP interrompu (cancel-scope) — réessayez l'appel`,
              })
            : pyJsonDumps({ error: flattenExceptionMessage(e) }),
        );
      }
      duree = Math.trunc(performance.now() - t0);
      p["duration_ms"] = duree;
    } finally {
      borne.rendre();
    }

    try {
      const r = resultats.get(idx) ?? "";
      const statut = o.isToolFailure(r) ? "error" : "ok";
      const etat = callStatus(p, r, statut);
      try {
        executionEnCours()?.ajouterAppelOutil(categorize(nom), etat);
      } catch {
        // comptage best-effort
      }
      const ecrire = (): void => {
        logMetric("tool_call", 1, { tool: nom, user: o.username, status: statut });
        const fa = p["final_args"];
        const argsTxt =
          typeof fa === "string"
            ? fa
            : fa !== null && fa !== undefined
              ? pyJsonDumps(fa, { ensureAscii: false })
              : "";
        o.recordMetric(o.username, o.chatId, nom, etat, duree, {
          errorShort: etat !== "success" ? prefixePy(r, 500) : null,
          callId: p["call_id"],
          startedAt: debut,
          exitCode: exitCode(r),
          argsBytes: utf8Remplace(argsTxt).length,
          resultBytes: utf8Remplace(r).length,
        });
        watchToolCall({
          chatId: o.chatId,
          iteration: o.iteration,
          tool: nom,
          argsChars: longueurPy(argsTxt),
          resultChars: longueurPy(r),
          durationMs: duree,
          status: statut,
        });
      };
      const tele = Promise.resolve()
        .then(ecrire)
        .catch(() => undefined);
      await Promise.race([tele, attendreMs(TELEMETRY_WAIT_S * 1000)]);

      if (nom === "todowrite" && statut === "ok") {
        try {
          const charge = jsonLoads(r);
          if (estDict(charge) && Array.isArray(charge["todos"])) {
            await emit(o.onEvent, {
              type: "todo_updated",
              todos: charge["todos"],
              remaining: charge["remaining"] ?? null,
            });
            if (Object.hasOwn(charge, "checklist")) {
              const mince = Object.fromEntries(Object.entries(charge).filter(([k]) => k !== "todos"));
              resultats.set(idx, pyJsonDumps(mince, { ensureAscii: false }));
            }
          }
        } catch (e) {
          if (estErreurAnnulation(e)) throw e;
        }
      }
    } catch (e) {
      if (estErreurAnnulation(e) || annulationReelle(signalLot)) {
        if (annulationReelle(signalLot) && !instantaneDuLot) await o.onCancelSnapshot();
        throw e;
      }
    }
  };

  /** Lot parallèle : au premier échec (annulation réelle), les frères sont arrêtés ET attendus, puis un seul instantané. */
  const executerEnParallele = async (items: [number, Dict][]): Promise<void> => {
    const arret = new AbortController();
    const signalLot = o.signal ? AbortSignal.any([o.signal, arret.signal]) : arret.signal;
    instantaneDuLot = true;
    try {
      let premier: unknown = undefined;
      const classes = new Map<number, ClasseLot>();
      for (const [k, p] of items) {
        const classe = p["args_error"]
          ? null
          : (o.classer?.(strPy(p["tool_name"]), p["final_args"] as Dict) ?? null);
        if (classe !== null) classes.set(k, classe);
      }
      const finis = new Map<number, Promise<void>>();
      const taches = items.map(([k, p]) => {
        const classe = classes.get(k);
        const avant = items
          .filter(
            ([i]) => i < k && classe !== undefined && ecrituresEnConflit(classes.get(i) ?? RIEN, classe),
          )
          .map(([i]) => finis.get(i) as Promise<void>);
        if (avant.length)
          log.info(
            `[execute_tool_batch] Iter ${o.iteration} : appel ${k + 1} (${strPy(p["tool_name"])}) après ${avant.length} appel(s) qui écrivent sur les mêmes chemins`,
          );
        const fini = execOne(k, p, signalLot, avant).catch((e: unknown) => {
          if (premier === undefined) premier = e;
          arret.abort(new CancelledError("lot interrompu"));
        });
        finis.set(k, fini);
        return fini;
      });
      await Promise.all(taches);
      if (premier === undefined) return;
      if (annulationReelle()) {
        await o.onCancelSnapshot();
        throw new CancelledError("User cancelled");
      }
      throw premier;
    } finally {
      instantaneDuLot = false;
    }
  };

  let i = 0;
  const n = prepared.length;
  while (i < n) {
    const estTache = (k: number): boolean => strPy(prepared[k]!["tool_name"]) === "task";
    if (limiteTaches > 1 && estTache(i) && i + 1 < n && estTache(i + 1)) {
      let j = i;
      while (j < n && estTache(j)) j++;
      log.info(
        `[execute_tool_batch] Iter ${o.iteration} : ${j - i} sous-agents en parallèle (au plus ${limiteTaches} à la fois)`,
      );
      const items: [number, Dict][] = [];
      for (let k = i; k < j; k++) items.push([k, prepared[k]!]);
      await executerEnParallele(items);
      i = j;
      continue;
    }
    if (toolTraits(strPy(prepared[i]!["tool_name"])).serial) {
      await execOne(i, prepared[i]!);
      i++;
      continue;
    }
    let j = i;
    while (j < n && !toolTraits(strPy(prepared[j]!["tool_name"])).serial) j++;
    if (j - i === 1) await execOne(i, prepared[i]!);
    else {
      log.info(
        `[execute_tool_batch] Iter ${o.iteration} : batch parallèle de ${j - i} tools (parallelism=${parallelisme})`,
      );
      const items: [number, Dict][] = [];
      for (let k = i; k < j; k++) items.push([k, prepared[k]!]);
      await executerEnParallele(items);
    }
    i = j;
  }
  return resultats;
}
