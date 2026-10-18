// SPDX-License-Identifier: MIT
/** apps/core/src/executions/registre.ts — exécutions (table `runs`) : une ligne par tour de chat, routine, sous-agent, compaction ou tour « Images », portée courante et mesures (port de shared_infra/observability/runs.py). */
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";

import {
  estErreurAnnulation,
  dormirMs,
  floatPy,
  intPy,
  prefixePy,
  pyJsonDumps,
  pyJsonLoads,
  stripPy,
  strPy,
  texteOu,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { TABLES } from "@elpis/db";
import type { Executeur, Valeur } from "@elpis/db";

import { journal } from "../journal";

const log = journal("uvicorn.error");

export const KINDS = ["chat", "routine", "subagent", "compaction", "image"] as const;
/** Source d'usage (`usage_events.source`) du propriétaire de chaque genre ; un tour « Images » pose lui-même son issue. */
const SOURCES: Readonly<Record<string, readonly string[]>> = {
  chat: ["chat"],
  routine: ["routine", "webhook"],
  subagent: ["subagent"],
  compaction: ["compression"],
  image: [],
};
const FICHIERS_MAX = 10000;
export const ECHANTILLON_S = 10.0;
const TEXTE_MAX = 191;
/** Une exécution « running » plus vieille que ceci est tenue pour perdue par l'entretien. */
export const RUNNING_STALE_S = 24 * 3600;

let horloge: () => number = () => Date.now() / 1000;
let base: Executeur | null = null;
let echantillonneur: ((uid: number) => Promise<{ cpu_pct?: unknown; mem_mb?: unknown } | null>) | null = null;
let dormir: (s: number, signal: AbortSignal) => Promise<void> = (s, signal) =>
  dormirMs(s * 1000, signal).catch(() => undefined);

/** Base où s'écrivent les lignes (`null` : aucune écriture, mesures en mémoire seulement). */
export function installerBaseExecutions(x: Executeur | null): void {
  base = x;
}

/** `running_container_stats(uid)` des exécuteurs de la sandbox ; absent, rien n'est échantillonné. */
export function installerEchantillonneurBac(
  f: ((uid: number) => Promise<{ cpu_pct?: unknown; mem_mb?: unknown } | null>) | null,
): void {
  echantillonneur = f;
}

/** Tests : horloge logique et attente des relances. */
export function reglerExecutionsPourTests(o: {
  horloge?: (() => number) | null;
  dormir?: ((s: number, signal: AbortSignal) => Promise<void>) | null;
}): void {
  if (o.horloge !== undefined) horloge = o.horloge ?? (() => Date.now() / 1000);
  if (o.dormir !== undefined && o.dormir !== null) dormir = o.dormir;
}

export function newRunId(kind: string, suffix = ""): string {
  return `${kind}-${suffix || randomBytes(8).toString("hex")}`;
}

/** `int(v or 0)`, négatif ou illisible ramené à 0. */
function entier(v: unknown): number {
  let n: number;
  try {
    n = intPy(veritePy(v) ? v : 0);
  } catch {
    return 0;
  }
  return n > 0 ? n : 0;
}

export class Execution {
  readonly id: string;
  readonly kind: string;
  readonly user_id: number | null;
  readonly chat_id: string;
  readonly routine_id: number | null;
  readonly parent_id: string;
  readonly model: string;
  /** Moteur réellement visé : un run de routine le pose à sa fin (`e.engine = current_engine().key`). */
  engine: string;
  readonly started_at: number = horloge();
  ended_at: number | null = null;
  status = "running";
  error_kind = "";
  input_tokens = 0;
  output_tokens = 0;
  cache_read_tokens = 0;
  cache_creation_tokens = 0;
  thinking_tokens = 0;
  tool_tokens = 0;
  llm_calls = 0;
  prefill_ms = 0;
  decode_ms = 0;
  wait_ms = 0;
  tool_calls = 0;
  tool_errors = 0;
  readonly tool_families = new Map<string, number>();
  sandbox_cpu_peak: number | null = null;
  sandbox_mem_peak_mb: number | null = null;
  private readonly fichiers = new Set<string>();
  private statutLlm = "";
  private ecritures: Promise<void> = Promise.resolve();

  constructor(champs: {
    id: string;
    kind: string;
    user_id?: number | null;
    chat_id?: string;
    routine_id?: number | null;
    parent_id?: string;
    model?: string;
    engine?: string;
  }) {
    this.id = champs.id;
    this.kind = champs.kind;
    this.user_id = champs.user_id ?? null;
    this.chat_id = champs.chat_id ?? "";
    this.routine_id = champs.routine_id ?? null;
    this.parent_id = champs.parent_id ?? "";
    this.model = champs.model ?? "";
    this.engine = champs.engine ?? "";
  }

  addUsage(o: {
    source: string;
    status: string;
    input_tokens?: unknown;
    output_tokens?: unknown;
    cache_read_tokens?: unknown;
    cache_creation_tokens?: unknown;
    thinking_tokens?: unknown;
    tool_tokens?: unknown;
    error_kind?: string;
  }): void {
    this.input_tokens += entier(o.input_tokens);
    this.output_tokens += entier(o.output_tokens);
    this.cache_read_tokens += entier(o.cache_read_tokens);
    this.cache_creation_tokens += entier(o.cache_creation_tokens);
    this.thinking_tokens += entier(o.thinking_tokens);
    this.tool_tokens += entier(o.tool_tokens);
    if ((SOURCES[this.kind] ?? []).includes(o.source)) {
      this.statutLlm = stripPy(o.status || "ok") || "ok";
      if (o.error_kind) this.error_kind = prefixePy(strPy(o.error_kind), 120);
    }
  }

  /** Un appel LLM abouti : `timings` de llama.cpp (`prompt_ms`, `predicted_ms`) quand le moteur les donne. */
  addLlmCall(timings: unknown): void {
    const t: Dict =
      timings !== null && typeof timings === "object" && !Array.isArray(timings) ? (timings as Dict) : {};
    this.llm_calls += 1;
    for (const [cle, attr] of [
      ["prompt_ms", "prefill_ms"],
      ["predicted_ms", "decode_ms"],
    ] as const) {
      try {
        const v = t[cle];
        this[attr] += Math.max(0, intPy(floatPy(veritePy(v) ? v : 0)));
      } catch {
        // valeur illisible : rien n'est ajouté
      }
    }
  }

  addWait(ms: unknown): void {
    this.wait_ms += entier(ms);
  }

  addToolCall(category: string, status: string): void {
    this.tool_calls += 1;
    const cat = prefixePy(category || "other", 64);
    this.tool_families.set(cat, (this.tool_families.get(cat) ?? 0) + 1);
    if (status !== "success") this.tool_errors += 1;
  }

  /** Fichiers modifiés (`files` d'un `tool_result`) : chemins distincts. */
  addFiles(files: Iterable<unknown> | null | undefined): void {
    for (const f of files ?? []) {
      const p = f !== null && typeof f === "object" && !Array.isArray(f) ? (f as Dict)["path"] : f;
      if (typeof p === "string" && p && this.fichiers.size < FICHIERS_MAX) this.fichiers.add(p);
    }
  }

  noteSandbox(cpuPct: unknown, memMb: unknown): void {
    if (cpuPct !== null && cpuPct !== undefined)
      this.sandbox_cpu_peak = Math.max(this.sandbox_cpu_peak ?? 0, floatPy(cpuPct));
    if (memMb !== null && memMb !== undefined)
      this.sandbox_mem_peak_mb = Math.max(this.sandbox_mem_peak_mb ?? 0, floatPy(memMb));
  }

  /** Pose l'issue (la première l'emporte) : celle donnée, sinon celle du dernier tour LLM de la source du propriétaire, sinon `ok`. */
  finish(status?: string | null, errorKind = ""): void {
    if (this.status !== "running") return;
    this.status = status || this.statutLlm || "ok";
    if (errorKind) this.error_kind = prefixePy(strPy(errorKind), 120);
    this.ended_at = horloge();
  }

  get filesChanged(): number {
    return this.fichiers.size;
  }

  row(): Record<string, Valeur> {
    const familles = Object.fromEntries(this.tool_families);
    return {
      id: this.id,
      kind: this.kind,
      user_id: this.user_id,
      chat_id: prefixePy(this.chat_id, TEXTE_MAX),
      routine_id: this.routine_id,
      parent_id: prefixePy(this.parent_id, TEXTE_MAX),
      model: this.model,
      engine: this.engine,
      started_at: this.started_at,
      ended_at: this.ended_at,
      status: prefixePy(this.status, TEXTE_MAX),
      error_kind: this.error_kind,
      input_tokens: this.input_tokens,
      output_tokens: this.output_tokens,
      cache_read_tokens: this.cache_read_tokens,
      cache_creation_tokens: this.cache_creation_tokens,
      thinking_tokens: this.output_tokens
        ? Math.min(this.thinking_tokens, this.output_tokens)
        : this.thinking_tokens,
      tool_tokens: Math.min(this.tool_tokens, this.input_tokens),
      llm_calls: this.llm_calls,
      prefill_ms: this.prefill_ms,
      decode_ms: this.decode_ms,
      wait_ms: this.wait_ms,
      tool_calls: this.tool_calls,
      tool_errors: this.tool_errors,
      tool_families: pyJsonDumps(familles, { sortKeys: true }),
      files_changed: this.fichiers.size,
      sandbox_cpu_peak: this.sandbox_cpu_peak,
      sandbox_mem_peak_mb: this.sandbox_mem_peak_mb,
    };
  }

  /** Ligne écrite sans l'attendre, dans l'ordre des appels ; la finale est retentée (base occupée). */
  ecrire(finale = false): void {
    const ligne = this.row();
    const essais = finale ? 3 : 1;
    this.ecritures = this.ecritures.then(async () => {
      for (let essai = 0; essai < essais; essai++) {
        if (await upsertRun(ligne)) return;
        if (essai + 1 < essais) await dormir(0.2 * (essai + 1), new AbortController().signal);
      }
    });
  }

  /** Tests et arrêt : écritures en cours terminées. */
  ecrituresTerminees(): Promise<void> {
    return this.ecritures;
  }
}

const courante = new AsyncLocalStorage<Execution>();

export function currentRun(): Execution | null {
  return courante.getStore() ?? null;
}

export function currentRunId(): string {
  return currentRun()?.id ?? "";
}

/** Colonnes REAL d'une table du schéma : rendues en flottants Python (`1.0`). */
function colonnesReelles(table: string): ReadonlySet<string> {
  return new Set(
    (TABLES.find((t) => t.name === table)?.cols ?? []).filter((c) => c.type === "real").map((c) => c.name),
  );
}

/** Ligne lue telle que sqlite3 la rend à Python : REAL en flottants. */
export function lignePy(table: string, ligne: Dict): Dict {
  const reels = colonnesReelles(table);
  const out: Dict = {};
  for (const [k, v] of Object.entries(ligne))
    out[k] = reels.has(k) && typeof v === "number" ? versFlottantPy(v) : v;
  return out;
}

/** Écrit la ligne (création ou mise à jour) ; best-effort. */
export async function upsertRun(row: Record<string, Valeur>, x: Executeur | null = base): Promise<boolean> {
  if (x === null) return false;
  try {
    const cols = Object.keys(row);
    const sets = cols
      .filter((c) => c !== "id")
      .map((c) => `${c}=excluded.${c}`)
      .join(", ");
    await x.run(
      `INSERT INTO runs(${cols.join(", ")}) VALUES(${cols.map(() => "?").join(", ")}) ON CONFLICT(id) DO UPDATE SET ${sets}`,
      cols.map((c) => row[c] ?? null),
    );
    return true;
  } catch (e) {
    log.debug(`[runs] écriture de ${strPy(row["id"])} impossible (non bloquant) : ${String(e)}`);
    return false;
  }
}

export async function getRun(x: Executeur, runId: string): Promise<Dict | null> {
  const r = await x.get("SELECT * FROM runs WHERE id = ?", [runId]);
  if (r === undefined) return null;
  const d = lignePy("runs", r);
  try {
    const brut = d["tool_families"];
    d["tool_families"] = pyJsonLoads(typeof brut === "string" && brut ? brut : "{}");
  } catch {
    d["tool_families"] = {};
  }
  return d;
}

/** Supprime les exécutions commencées il y a plus de `retentionDays` jours (`<= 0` : rien) ; best-effort. */
export async function purgeRuns(x: Executeur, retentionDays: number): Promise<number> {
  if (retentionDays <= 0) return 0;
  try {
    const n = await x.run("DELETE FROM runs WHERE started_at < ?", [horloge() - retentionDays * 86400]);
    return Math.max(0, n.changes ?? 0);
  } catch (e) {
    log.debug(`[maintenance] purge_runs failed (non-fatal) : ${String(e)}`);
    return 0;
  }
}

/** Exécutions restées « running » plus de `maxAgeS` : « lost » ; best-effort, rend le nombre. */
export async function markLostRuns(x: Executeur, maxAgeS: number = RUNNING_STALE_S): Promise<number> {
  try {
    const maintenant = horloge();
    const n = await x.run(
      "UPDATE runs SET status = 'lost', ended_at = ? WHERE status = 'running' AND started_at < ?",
      [maintenant, maintenant - maxAgeS],
    );
    return Math.max(0, n.changes ?? 0);
  } catch (e) {
    log.debug(`[maintenance] mark_lost_runs failed (non-fatal) : ${String(e)}`);
    return 0;
  }
}

/** Pics CPU / RAM de la sandbox du compte toutes les `ECHANTILLON_S` ; une mesure lente est abandonnée. */
async function echantillonner(e: Execution, signal: AbortSignal): Promise<void> {
  const uid = Math.trunc(e.user_id ?? 0);
  while (!signal.aborted) {
    await dormir(ECHANTILLON_S, signal);
    if (signal.aborted || echantillonneur === null) return;
    try {
      const st = await Promise.race([
        echantillonneur(uid),
        new Promise<null>((ok) => {
          const t = setTimeout(() => ok(null), ECHANTILLON_S * 1000);
          t.unref();
        }),
      ]);
      if (st) e.noteSandbox(st.cpu_pct, st.mem_mb);
    } catch {
      continue;
    }
  }
}

export interface OptionsPortee {
  runId?: string;
  userId?: unknown;
  chatId?: unknown;
  routineId?: number | null;
  /** `undefined` : l'exécution englobante. */
  parentId?: string | null;
  model?: string;
  engine?: string;
  sampleSandbox?: boolean;
}

function estDelai(e: unknown): boolean {
  return e instanceof Error && e.name === "TimeoutError";
}

/** `run_scope` : exécution courante pour la durée de `fn` ; issue posée par une erreur qui traverse, ligne écrite au début et à la fin. */
export async function runScope<T>(
  kind: string,
  o: OptionsPortee,
  fn: (e: Execution) => Promise<T>,
): Promise<T> {
  const parent = currentRun();
  let uid: number | null = null;
  if (o.userId !== null && o.userId !== undefined)
    try {
      uid = intPy(o.userId);
    } catch {
      uid = null;
    }
  const e = new Execution({
    id: o.runId || newRunId(kind),
    kind,
    user_id: uid,
    chat_id: texteOu(o.chatId, ""),
    routine_id: o.routineId ?? null,
    parent_id: o.parentId === undefined ? (parent?.id ?? "") : (o.parentId ?? ""),
    model: o.model ?? "",
    engine: o.engine ?? "",
  });
  const arret = new AbortController();
  try {
    return await courante.run(e, async () => {
      e.ecrire();
      if ((o.sampleSandbox ?? true) && uid && parent === null) void echantillonner(e, arret.signal);
      return fn(e);
    });
  } catch (err) {
    if (estDelai(err)) e.finish("timeout");
    else if (estErreurAnnulation(err)) e.finish("cancelled");
    else e.finish("error");
    throw err;
  } finally {
    arret.abort();
    e.finish();
    e.ecrire(true);
  }
}
