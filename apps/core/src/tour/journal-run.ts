// SPDX-License-Identifier: MIT
/** apps/core/src/tour/journal-run.ts — journal des événements d'un run de chat, relisible pour se rattacher au run (y compris après redémarrage) : un dossier par compte et chat, lignes `{"s", "e"}` (port de shared_infra/runtime/run_journal.py). */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";

import {
  estAlnumPy,
  estDict,
  floatPy,
  FlottantPy,
  intPy,
  longueurPy,
  pyJsonDumps,
  pyJsonLoads,
  strPy,
  texteOu,
  veritePy,
  versFlottantPy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";
import { configView } from "@elpis/config";

import { journal } from "../journal";
import { cheminExecution } from "../llm/acces-moteurs";
import { verrousChat } from "./etat";

const log = journal("uvicorn.error");

/** Journal terminé : supprimé après ce délai (le tour est en base depuis). */
export const RETENTION_S = 600.0;
/** Journal jamais terminé (processus tué) : supprimé après ce délai. */
export const ORPHAN_S = 24 * 3600.0;
export const FLUSH_INTERVAL_S = 0.1;
export const FLUSH_MAX_EVENTS = 64;
export const SWEEP_EVERY_S = 300.0;
export const READ_CHUNK_BYTES = 1 << 20;
const COALESCABLE: ReadonlySet<string> = new Set(["content_token", "thinking_token"]);
const DROPPABLE: ReadonlySet<string> = new Set([
  "content_token",
  "thinking_token",
  "tool_call_delta",
  "shell_output",
  "prompt_progress",
  "tool_progress",
  "kv_cache",
  "ping",
]);

/** Horloge, attente et dossier : remplaçables par les tests (horloge logique, journal écrit à la demande). */
export interface ReglagesJournal {
  dossier: string | null;
  flushIntervalS: number;
  maxBytes: (() => number) | null;
  maintenant: () => number;
  dormir: (s: number, signal: AbortSignal) => Promise<void>;
  balayage: boolean;
}

const DEFAUTS: ReglagesJournal = {
  dossier: null,
  flushIntervalS: FLUSH_INTERVAL_S,
  maxBytes: null,
  maintenant: () => Date.now() / 1000,
  dormir: (s, signal) =>
    new Promise((ok) => {
      const t = setTimeout(ok, Math.min(s * 1000, 2 ** 31 - 1));
      t.unref();
      signal.addEventListener("abort", () => (clearTimeout(t), ok()), { once: true });
    }),
  balayage: true,
};
let reglages: ReglagesJournal = { ...DEFAUTS };
let dernierBalayage = 0;

export function reglerJournalPourTests(r: Partial<ReglagesJournal> | null): void {
  reglages = r === null ? { ...DEFAUTS } : { ...reglages, ...r };
}

/** `RUN_DIR` : surcharge du canal, sinon `ELPIS_RUNTIME_DIR/chat_runs`, sinon le chemin historique. */
export function runDir(): string {
  return reglages.dossier ?? cheminExecution("chat_runs", "ELPIS_CHAT_RUNS_DIR", "/tmp/elpis_chat_runs");
}

/** Égalité des clés de fusion comme les tuples Python (`1 == 1.0 == True`). */
function egalPy(a: unknown, b: unknown): boolean {
  const n = (v: unknown): boolean =>
    typeof v === "number" || typeof v === "boolean" || v instanceof FlottantPy;
  if (n(a) && n(b)) return floatPy(a) === floatPy(b);
  return (a ?? null) === (b ?? null);
}

/** Clé de fusion de deux événements consécutifs (`null` : jamais fusionné). */
function mergeKey(ev: Dict): unknown[] | null {
  const t = ev["type"];
  if (typeof t === "string" && COALESCABLE.has(t) && (!("text" in ev) || typeof ev["text"] === "string"))
    return [t];
  if (t === "tool_call_delta" && !veritePy(ev["reset"])) return [t, ev["iter"], ev["index"]];
  return null;
}

/** `asyncio.Event` : `set` réveille l'attente en cours ou la prochaine, `clear` le réarme. */
class Reveil {
  private pose = false;
  private attentes = new Set<AbortController>();

  set(): void {
    this.pose = true;
    for (const a of this.attentes) a.abort();
    this.attentes.clear();
  }

  clear(): void {
    this.pose = false;
  }

  /** Jusqu'au réveil ou au délai ; `signal` donné : aussi jusqu'à son abandon. */
  async attendre(s: number, signal?: AbortSignal): Promise<void> {
    if (this.pose) return;
    const a = new AbortController();
    this.attentes.add(a);
    signal?.addEventListener("abort", () => a.abort(), { once: true });
    try {
      await reglages.dormir(s, a.signal);
    } finally {
      this.attentes.delete(a);
      a.abort();
    }
  }
}

function memesCles(a: unknown[] | null, b: unknown[] | null): boolean {
  return a !== null && b !== null && a.length === b.length && a.every((x, i) => egalPy(x, b[i]));
}

interface EnAttente extends Dict {
  _parts?: string[] | [string[], string[]];
}

function joinParts(ev: EnAttente): Dict {
  const out: Dict = {};
  for (const [k, v] of Object.entries(ev)) if (k !== "_parts") out[k] = v;
  const parts = ev._parts!;
  if (Array.isArray(parts[0])) {
    const [noms, args] = [(parts[0] as string[]).join(""), (parts[1] as string[]).join("")];
    if (noms) out["name_delta"] = noms;
    if (args) out["args_delta"] = args;
  } else out["text"] = (parts as string[]).join("");
  return out;
}

/** `llm.run_journal_max_mb` (64 Mo par défaut, 1 Mo au moins). */
function maxBytes(): number {
  if (reglages.maxBytes !== null) return reglages.maxBytes();
  let mb: number;
  try {
    const llm = configView()["llm"];
    if (veritePy(llm) && !estDict(llm)) throw new TypeError("llm");
    const v = estDict(llm) && "run_journal_max_mb" in llm ? llm["run_journal_max_mb"] : 64;
    mb = floatPy(veritePy(v) ? v : 64);
  } catch {
    mb = 64;
  }
  return Math.trunc((mb > 1 ? mb : 1) * 1024 * 1024);
}

/** La racine appartient-elle à ce compte, sans droits pour les autres ? Sinon le journal est désactivé (un tiers injecterait des événements). */
function baseOk(creer: boolean): boolean {
  const base = runDir();
  if (creer) {
    try {
      mkdirSync(base, { recursive: true, mode: 0o700 });
      chmodSync(base, 0o700);
    } catch {
      return false;
    }
  }
  try {
    const st = statSync(base);
    return st.uid === process.geteuid?.() && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function chatDir(userId: number, chatId: string): string {
  const h = createHash("sha256")
    .update(`${Math.trunc(userId)}\x00${chatId}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return join(runDir(), `u${Math.trunc(userId)}-${h}`);
}

/** Identifiant de run : lettres et chiffres Unicode seulement, 32 au plus. */
export function safeRunId(runId: unknown): string {
  return Array.from(texteOu(runId, "")).filter(estAlnumPy).slice(0, 32).join("");
}

function ecrireJsonAtomique(chemin: string, data: Dict): void {
  const tmp = chemin.replace(/\.json$/u, ".tmp");
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, pyJsonDumps(data, { ensureAscii: false }));
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, chemin);
}

function supprimer(chemin: string): void {
  try {
    unlinkSync(chemin);
  } catch {
    // déjà absent
  }
}

/** Journal d'UN run : `append` ne bloque jamais, l'écriture part par lots. */
export class RunJournal {
  readonly userId: number;
  readonly chatId: string;
  readonly runId: string;
  readonly meta: Dict;
  readonly dir: string;
  readonly path: string;
  private pending: EnAttente[] = [];
  private seq = 0;
  private octets = 0;
  private readonly cap = maxBytes();
  private truncated = false;
  closed = false;
  private ok = false;
  private boucle: Promise<void> | null = null;
  private readonly reveil = new Reveil();
  private ecriture: Promise<void> = Promise.resolve();

  constructor(userId: number, chatId: string, runId: string, meta: Dict = {}) {
    this.userId = Math.trunc(userId);
    this.chatId = strPy(chatId);
    this.runId = safeRunId(runId);
    this.meta = { ...meta };
    this.dir = chatDir(this.userId, this.chatId);
    this.path = join(this.dir, `${this.runId}.jsonl`);
  }

  /** Crée le journal, pose `current.json` et écrit `run_started` ; `false` : journal indisponible, le tour continue. */
  async open(started: Dict): Promise<boolean> {
    if (!this.runId) return false;
    try {
      this.preparer();
    } catch (e) {
      log.warn(
        `[run_journal] ouverture impossible (${String(e instanceof Error ? e.message : e).slice(0, 160)}) — reprise de l'affichage indisponible pour ce tour`,
      );
      return false;
    }
    this.ok = true;
    this.append({ ...started, type: "run_started", run_id: this.runId });
    this.boucle = this.boucleEcriture();
    return true;
  }

  private preparer(): void {
    const maintenant = reglages.maintenant();
    if (reglages.balayage && maintenant - dernierBalayage > SWEEP_EVERY_S) {
      dernierBalayage = maintenant;
      try {
        sweep();
      } catch {
        // balayage best-effort
      }
    }
    if (!baseOk(true)) throw new Error(`${runDir()} n'est pas privé à ce compte`);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    try {
      chmodSync(this.dir, 0o700);
    } catch {
      // droits laissés tels quels
    }
    for (const nom of readdirSync(this.dir)) {
      if (!nom.endsWith(".end")) continue;
      const rid = nom.slice(0, -4);
      if (rid !== this.runId)
        for (const s of [".jsonl", ".end", ".annonce"]) supprimer(join(this.dir, `${rid}${s}`));
    }
    closeSync(openSync(this.path, "w", 0o600));
    ecrireJsonAtomique(join(this.dir, "current.json"), {
      run_id: this.runId,
      chat_id: this.chatId,
      user_id: this.userId,
      started_at: versFlottantPy(maintenant),
      ...this.meta,
    });
  }

  append(ev: unknown): void {
    if (!this.ok || this.closed || !estDict(ev)) return;
    const t = ev["type"];
    if (this.truncated && typeof t === "string" && DROPPABLE.has(t)) return;
    let dernier = this.pending.at(-1);
    if (dernier !== undefined && mergeKey(dernier) !== null && memesCles(mergeKey(dernier), mergeKey(ev))) {
      if (dernier._parts === undefined) {
        dernier = { ...dernier };
        this.pending[this.pending.length - 1] = dernier;
        if (t === "tool_call_delta") {
          const nom = texteOu(dernier["name_delta"], "");
          const args = texteOu(dernier["args_delta"], "");
          delete dernier["name_delta"];
          delete dernier["args_delta"];
          dernier._parts = [[nom], [args]];
        } else dernier._parts = [texteOu(dernier["text"], "")];
      }
      if (t === "tool_call_delta") {
        const p = dernier._parts as [string[], string[]];
        p[0].push(texteOu(ev["name_delta"], ""));
        p[1].push(texteOu(ev["args_delta"], ""));
      } else {
        (dernier._parts as string[]).push(texteOu(ev["text"], ""));
        dernier["n"] =
          intPy(veritePy(dernier["n"]) ? dernier["n"] : 1) + intPy(veritePy(ev["n"]) ? ev["n"] : 1);
      }
    } else this.pending.push(ev as EnAttente);
    if (this.pending.length >= FLUSH_MAX_EVENTS && this.ok) this.reveil.set();
  }

  /** Écrit `run_end` et la marque de fin ; idempotent. */
  async close(status = "done"): Promise<void> {
    if (!this.ok || this.closed) return;
    this.append({ type: "run_end", status: texteOu(status, "done") });
    this.closed = true;
    if (this.boucle !== null) {
      this.reveil.set();
      const delai = new AbortController();
      await Promise.race([this.boucle.finally(() => delai.abort()), reglages.dormir(5.0, delai.signal)]);
    }
    await this.flush();
    try {
      this.markEnd();
    } catch {
      // marque best-effort
    }
  }

  markEnd(): void {
    closeSync(openSync(join(this.dir, `${this.runId}.end`), "w", 0o600));
  }

  private async boucleEcriture(): Promise<void> {
    while (!this.closed) {
      await this.reveil.attendre(reglages.flushIntervalS);
      this.reveil.clear();
      await this.flush();
    }
  }

  /** Écrit les événements en attente (fusionnés, bornés au plafond du journal). */
  async flush(): Promise<void> {
    if (!this.pending.length) return;
    const tour = this.ecriture.then(() => this.ecrireLot());
    this.ecriture = tour.catch(() => undefined);
    await tour;
  }

  private ecrireLot(): void {
    const lot = this.pending;
    this.pending = [];
    const lignes: string[] = [];
    for (let ev of lot as Dict[]) {
      if ("_parts" in ev) ev = joinParts(ev as EnAttente);
      const t = ev["type"];
      if (this.octets >= this.cap && typeof t === "string" && DROPPABLE.has(t)) {
        if (!this.truncated) {
          this.truncated = true;
          this.seq += 1;
          lignes.push(pyJsonDumps({ s: this.seq, e: { type: "journal_truncated" } }) + "\n");
        }
        continue;
      }
      let ligne: string;
      try {
        this.seq += 1;
        ligne = pyJsonDumps({ s: this.seq, e: ev }, { ensureAscii: false }) + "\n";
      } catch {
        continue;
      }
      this.octets += longueurPy(ligne);
      lignes.push(ligne);
    }
    if (!lignes.length) return;
    try {
      writeFileSync(this.path, lignes.join(""), { flag: "a", encoding: "utf8" });
    } catch (e) {
      log.debug(`[run_journal] écriture impossible : ${String(e).slice(0, 120)}`);
    }
  }
}

// ── Lecture ──────────────────────────────────────────────────────────────

/** Pointeur du dernier run de ce chat, enrichi de `ended` ; `null` sans journal. */
export function currentRun(userId: number, chatId: string): Dict | null {
  if (!baseOk(false)) return null;
  const d = chatDir(userId, chatId);
  let data: unknown;
  try {
    data = pyJsonLoads(readFileSync(join(d, "current.json"), "utf8"));
  } catch {
    return null;
  }
  if (!estDict(data)) return null;
  const rid = safeRunId(data["run_id"]);
  if (!rid || !existsSync(join(d, `${rid}.jsonl`))) return null;
  data["run_id"] = rid;
  data["ended"] = existsSync(join(d, `${rid}.end`));
  return data;
}

/** Runs du chat dont le journal n'a ni marque de fin ni marque d'annonce (process mort sans l'avoir clos), les plus récemment écrits d'abord, `max` au plus ; `exclure` : le run qui commence. */
export function runsSansFin(userId: number, chatId: string, exclure = "", max = 8): string[] {
  if (!baseOk(false)) return [];
  const d = chatDir(userId, chatId);
  const trouves: [string, number][] = [];
  try {
    for (const nom of readdirSync(d)) {
      if (!nom.endsWith(".jsonl")) continue;
      const rid = nom.slice(0, -6);
      if (!rid || safeRunId(rid) !== rid || rid === exclure) continue;
      if (existsSync(join(d, `${rid}.end`)) || existsSync(join(d, `${rid}.annonce`))) continue;
      trouves.push([rid, statSync(join(d, nom)).mtimeMs]);
    }
  } catch {
    return [];
  }
  return trouves
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([rid]) => rid);
}

/** Pose la marque « annoncé » d'un run interrompu : ses sous-agents ne sont plus annoncés aux tours suivants ; best-effort. */
export function marquerAnnonce(userId: number, chatId: string, runId: string): void {
  const rid = safeRunId(runId);
  if (!rid || !baseOk(false)) return;
  try {
    closeSync(openSync(join(chatDir(userId, chatId), `${rid}.annonce`), "w", 0o600));
  } catch {
    // la marque manque : l'annonce sera répétée, sans autre effet
  }
}

export function journalPath(userId: number, chatId: string, runId: string): string | null {
  const rid = safeRunId(runId);
  return rid ? join(chatDir(userId, chatId), `${rid}.jsonl`) : null;
}

export function isEnded(userId: number, chatId: string, runId: string): boolean {
  const rid = safeRunId(runId);
  return Boolean(rid) && existsSync(join(chatDir(userId, chatId), `${rid}.end`));
}

/** Lignes ENTIÈRES à partir de `offset` (octets) → `[entrées, nouvel offset]` ; une ligne partielle attend la lecture suivante. */
export function readLines(chemin: string, offset: number, max = READ_CHUNK_BYTES): [Dict[], number] {
  const fd = openSync(chemin, "r");
  let morceau: Buffer;
  try {
    const lire = (pos: number): Buffer => {
      const b = Buffer.alloc(max);
      return b.subarray(0, readSync(fd, b, 0, max, pos));
    };
    morceau = lire(offset);
    while (morceau.length && !morceau.includes(0x0a)) {
      const suite = lire(offset + morceau.length);
      if (!suite.length) break;
      morceau = Buffer.concat([morceau, suite]);
    }
  } finally {
    closeSync(fd);
  }
  if (!morceau.length) return [[], offset];
  const fin = morceau.lastIndexOf(0x0a);
  if (fin < 0) return [[], offset];
  const out: Dict[] = [];
  const decodeur = new TextDecoder("utf-8", { fatal: true });
  let debut = 0;
  const utile = morceau.subarray(0, fin + 1);
  for (let i = 0; i <= utile.length; i++) {
    const c = utile[i];
    if (i < utile.length && c !== 0x0a && c !== 0x0d) continue;
    const brut = utile.subarray(debut, i);
    debut = i + 1 + (c === 0x0d && utile[i + 1] === 0x0a ? 1 : 0);
    if (c === 0x0d && utile[i + 1] === 0x0a) i++;
    if (!brut.toString("latin1").trim()) continue;
    try {
      const item = pyJsonLoads(decodeur.decode(brut));
      if (estDict(item) && estDict(item["e"])) out.push(item);
    } catch {
      continue;
    }
  }
  return [out, offset + fin + 1];
}

/** Chats du compte dont un run est EN COURS : journal non terminé et verrou de présence tenu. */
export function listActiveChatIds(userId: number): string[] {
  const out: string[] = [];
  if (!baseOk(false)) return out;
  let dossiers: string[];
  try {
    dossiers = readdirSync(runDir()).filter((n) => n.startsWith(`u${Math.trunc(userId)}-`));
  } catch {
    return out;
  }
  for (const nom of dossiers) {
    const d = join(runDir(), nom);
    let data: unknown;
    try {
      data = pyJsonLoads(readFileSync(join(d, "current.json"), "utf8"));
    } catch {
      continue;
    }
    if (!estDict(data)) continue;
    const rid = safeRunId(data["run_id"]);
    const cid = texteOu(data["chat_id"], "");
    if (!rid || !cid || existsSync(join(d, `${rid}.end`))) continue;
    if (verrousChat.isHeld("gen", Math.trunc(userId), cid)) out.push(cid);
  }
  return out;
}

/** Supprime les journaux terminés depuis `RETENTION_S` et les orphelins de plus de `ORPHAN_S` ; rend le nombre de runs supprimés. */
export function sweep(now: number = reglages.maintenant()): number {
  let supprimes = 0;
  let dossiers: string[];
  try {
    dossiers = readdirSync(runDir(), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(runDir(), e.name));
  } catch {
    return 0;
  }
  for (const d of dossiers) {
    try {
      for (const nom of readdirSync(d).filter((n) => n.endsWith(".jsonl"))) {
        const jl = join(d, nom);
        const fin = join(d, `${nom.slice(0, -6)}.end`);
        let expire: boolean;
        try {
          expire = existsSync(fin)
            ? now - statSync(fin).mtimeMs / 1000 > RETENTION_S
            : now - statSync(jl).mtimeMs / 1000 > ORPHAN_S;
        } catch {
          continue;
        }
        if (expire) {
          supprimer(jl);
          supprimer(fin);
          supprimer(join(d, `${nom.slice(0, -6)}.annonce`));
          supprimes += 1;
        }
      }
      if (!readdirSync(d).some((n) => n.endsWith(".jsonl"))) rmSync(d, { recursive: true, force: true });
    } catch {
      continue;
    }
  }
  return supprimes;
}
