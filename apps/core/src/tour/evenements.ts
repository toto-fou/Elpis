// SPDX-License-Identifier: MIT
/** apps/core/src/tour/evenements.ts — pompe NDJSON du tour : file bornée du worker, drain coalescé avec ping, filtre après un Stop, suivi réel du chargement d'un modèle, arrêt de la session du moteur (chatbot_app/turn/events.py). */
import { arrondiPy, egalPy, estDict, intPy, veritePy, versFlottantPy } from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { config } from "@elpis/config";

import { journal } from "../journal";
import { getLlmClient } from "../llm/client-http";
import { baseServeur, cachedCaps } from "../llm/fournisseurs/llama-capacites";
import { cancelStream, conversationId } from "../llm/fournisseurs/llama-flux";
import { watchLoad } from "../llm/fournisseurs/llama-modeles";
import { resolveEngineForUser } from "../llm/moteurs";
import type { EngineRef } from "../llm/moteurs";
import { isChatCancelled } from "./etat";
import { currentRun } from "./journal-run";

const log = journal("uvicorn.error");

/** `DELETE /v1/stream` sur la session du chat, sur le serveur du run (lu dans son journal) ; renonce seulement sur PREUVE d'un moteur trop ancien. */
export async function cancelEngineStream(uid: number, chatId: string): Promise<void> {
  try {
    if (!config.LLAMA_RESUMABLE_STREAM) return;
    let engine: EngineRef | null = null;
    try {
      const cur = currentRun(uid, chatId);
      const cle = String((cur?.["engine_key"] as string | undefined) || "builtin");
      if (cle !== "builtin") {
        engine = await resolveEngineForUser(uid, cle);
        if (engine === null || !engine.isLlamacpp) return;
      }
    } catch (e) {
      log.debug(`[chat.cancel_engine.resolve] ${String(e).slice(0, 120)}`);
    }
    const caps = engine !== null ? cachedCaps("", { engine }) : cachedCaps();
    if (caps.known && !caps.resumableStream) return;
    const conv = conversationId(uid, chatId);
    if (!conv) return;
    if (engine !== null) {
      const auth = engine.headerDict();
      await cancelStream(getLlmClient(engine.baseRoot), engine.baseRoot, conv, "", {
        headers: Object.keys(auth).length ? auth : null,
      });
      return;
    }
    await cancelStream(getLlmClient(), baseServeur(config.LLAMA_URL), conv);
  } catch (e) {
    log.debug(`[chat_cancel] arrêt moteur indisponible : ${String(e).slice(0, 120)}`);
  }
}

// ── File du worker et drain vers le client ─────────────────────────────────────

export const DELAI = Symbol("délai");

/** `asyncio.Queue(maxsize)` : `put` attend une place, `get` attend un élément (borné par un délai ou un abandon). */
export class FileEvenements {
  private readonly elements: (Dict | null)[] = [];
  private readonly lecteurs: ((e: Dict | null | typeof DELAI) => void)[] = [];
  private readonly ecrivains: (() => void)[] = [];

  private readonly max: number;

  constructor(max = 1000) {
    this.max = max;
  }

  get taille(): number {
    return this.elements.length;
  }

  async put(e: Dict | null): Promise<void> {
    while (this.elements.length >= this.max) await new Promise<void>((ok) => this.ecrivains.push(ok));
    const lecteur = this.lecteurs.shift();
    if (lecteur) lecteur(e);
    else this.elements.push(e);
  }

  /** Élément suivant sans attendre ; `undefined` si la file est vide. */
  getNowait(): Dict | null | undefined {
    if (!this.elements.length) return undefined;
    const e = this.elements.shift()!;
    this.ecrivains.shift()?.();
    return e;
  }

  /** Élément suivant ; `DELAI` après `timeoutS`, ou à l'abandon de `signal`. */
  get(timeoutS: number | null, signal?: AbortSignal): Promise<Dict | null | typeof DELAI> {
    const pret = this.getNowait();
    if (pret !== undefined) return Promise.resolve(pret);
    return new Promise((ok) => {
      let t: NodeJS.Timeout | undefined;
      const finir = (e: Dict | null | typeof DELAI): void => {
        clearTimeout(t);
        signal?.removeEventListener("abort", abandon);
        const i = this.lecteurs.indexOf(finir);
        if (i >= 0) this.lecteurs.splice(i, 1);
        ok(e);
      };
      const abandon = (): void => finir(DELAI);
      this.lecteurs.push(finir);
      if (timeoutS !== null) t = setTimeout(abandon, timeoutS * 1000);
      if (signal?.aborted) abandon();
      else signal?.addEventListener("abort", abandon, { once: true });
    });
  }

  /** Lecteur parti : plus rien n'est lu, la file est vidée et les producteurs bloqués repartent. */
  couper(): void {
    this.elements.length = 0;
    for (const ok of this.ecrivains.splice(0)) ok();
  }
}

function cleFusion(e: unknown): unknown[] | null {
  if (!estDict(e)) return null;
  const t = e["type"];
  if (t === "content_token" || t === "thinking_token") return [t];
  if (t === "tool_call_delta" && !veritePy(e["reset"])) return [t, e["iter"] ?? null, e["index"] ?? null];
  return null;
}

export interface OptionsDrain {
  windowMs?: number;
  idlePingS?: number;
  signal?: AbortSignal;
  dormir?: (s: number) => Promise<void>;
}

/** Draine la file vers le client en agrégeant les jetons consécutifs (`n` = nombre agrégé) ; ping par silence de 20 s ; s'arrête sur la fin du flux ou l'abandon. */
export async function* drainCoalesced(q: FileEvenements, o: OptionsDrain = {}): AsyncGenerator<Dict> {
  const windowMs = o.windowMs ?? 25.0;
  const idlePingS = o.idlePingS ?? 20.0;
  const dormir = o.dormir ?? ((s: number) => new Promise<void>((ok) => setTimeout(ok, s * 1000)));
  let pending: Dict | null | undefined;
  for (;;) {
    let ev: Dict | null;
    if (pending !== undefined) {
      ev = pending;
      pending = undefined;
    } else {
      const lu = await q.get(idlePingS > 0 ? idlePingS : null, o.signal);
      if (o.signal?.aborted) return;
      if (lu === DELAI) {
        yield { type: "ping" };
        continue;
      }
      ev = lu;
    }
    if (ev === null) return;
    const cle = cleFusion(ev);
    if (cle !== null) {
      const groupe: Dict[] = [ev];
      const prendre = (): boolean => {
        for (;;) {
          const suivant = q.getNowait();
          if (suivant === undefined) return false;
          if (suivant !== null && egalPy(cleFusion(suivant), cle)) groupe.push(suivant);
          else {
            pending = suivant;
            return true;
          }
        }
      };
      if (!prendre() && windowMs > 0) {
        await dormir(windowMs / 1000);
        prendre();
      }
      if (groupe.length > 1) {
        if (cle[0] === "tool_call_delta") {
          const noms = groupe.map((g) => (veritePy(g["name_delta"]) ? String(g["name_delta"]) : "")).join("");
          const args = groupe.map((g) => (veritePy(g["args_delta"]) ? String(g["args_delta"]) : "")).join("");
          const fusion: Dict = { ...ev };
          delete fusion["name_delta"];
          delete fusion["args_delta"];
          if (noms) fusion["name_delta"] = noms;
          if (args) fusion["args_delta"] = args;
          ev = fusion;
        } else {
          const n = groupe.reduce((s, g) => s + intPy(veritePy(g["n"]) ? g["n"] : 1), 0);
          ev = { ...ev, text: groupe.map((g) => String(g["text"] ?? "")).join(""), n };
        }
      }
    }
    yield ev;
  }
}

/** Après un Stop, seuls passent le `final` et le bilan d'un sous-agent (`task_step` final). */
export function dropEventAfterCancel(type: unknown, cancelled: boolean, status?: unknown): boolean {
  if (!cancelled || type === "final") return false;
  return !(type === "task_step" && status === "final");
}

// ── Suivi du chargement d'un modèle ────────────────────────────────────────────

const suivis = new Map<string, AbortController>();

/** Suit le chargement réel du modèle (`/models/sse`) et republie `queue_status` à chaque pas, puis `queue_cleared` ; un suivi par conversation. */
export function startLoadWatch(
  model: string,
  onEvent: (ev: Dict) => Promise<void>,
  uid: number,
  chatId: string,
  baseStatus: Dict,
): void {
  const cle = `${uid}\x00${chatId || ""}`;
  suivis.get(cle)?.abort();
  const arret = new AbortController();
  suivis.set(cle, arret);
  void (async () => {
    try {
      const surPas = async (stage: string, pct: number | null, stages: string[]): Promise<void> => {
        if (isChatCancelled(uid, chatId)) {
          arret.abort();
          return;
        }
        const ev: Dict = {};
        for (const [k, v] of Object.entries(baseStatus)) if (k !== "type") ev[k] = v;
        ev["kind"] = "loading";
        ev["stage"] = stage || "";
        ev["stages"] = stages || [];
        if (pct !== null) ev["progress_pct"] = versFlottantPy(arrondiPy(pct, 1));
        await onEvent({ type: "queue_status", ...ev });
      };
      if (
        (await watchLoad(model, "", surPas, { timeoutS: 600.0, signal: arret.signal })) === true &&
        !arret.signal.aborted
      )
        await onEvent({ type: "queue_cleared" });
    } catch (e) {
      log.debug(`[queue_status] suivi de chargement abandonné : ${String(e).slice(0, 150)}`);
    } finally {
      if (suivis.get(cle) === arret) suivis.delete(cle);
    }
  })();
}

/** Arrête le suivi : le flux du tour se ferme. */
export function stopLoadWatch(uid: number, chatId: string): void {
  const cle = `${uid}\x00${chatId || ""}`;
  suivis.get(cle)?.abort();
  suivis.delete(cle);
}
