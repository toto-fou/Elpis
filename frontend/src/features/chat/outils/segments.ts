// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/outils/segments.ts — segments texte/outils d'un message assistant (porté de `chat/_tool_segments.js`) : reconstruction depuis la `tool_history` persistée et libellés partagés entre le direct et le rechargement. */
import { restaurerMarqueursTour } from "@elpis/commun/marqueurs-tour";
import type { MetaOutils } from "@elpis/contracts";

import type { EtapeOutil } from "./types.ts";

type Objet = Record<string, unknown>;

export interface ChampsShell {
  shellRc: number | null;
  shellMs: number;
  shellOut?: string;
}

export interface EtapeReconstruite extends EtapeOutil {
  args: Objet | null;
  result: string | null;
  status: string;
  seg: number;
  round: number;
  thinking: string;
  thinkingOpen: boolean;
  isRag: boolean;
  ragLabel: string;
}

export interface SegmentsReconstruits {
  segTexts: string[];
  toolSteps: EtapeReconstruite[];
}

export interface OptionsSegments {
  prevHistory?: unknown;
  finalContent?: unknown;
  delta?: boolean;
  /** `tool_meta` validé du message : durée, réflexion et arrêt de chaque étape. */
  meta?: MetaOutils | null;
}

/** Extrait d'un résultat gardé au rechargement ; la longueur complète est signalée. */
export const RESULTAT_RECHARGE_MAX = 2000;

const estObjet = (v: unknown): v is Objet => !!v && typeof v === "object" && !Array.isArray(v);

/** Libellé lisible d'un appel RAG (vide hors `rag_*`). */
export function ragCallLabel(name: unknown, args: unknown): string {
  const nom = String(name || "");
  if (nom.indexOf("rag_") !== 0) return "";
  const a = estObjet(args) ? args : {};
  if (nom === "rag_search") {
    const q = String(a["query"] || "");
    return "Recherche : " + (q.length > 45 ? q.substring(0, 45) + "..." : q);
  }
  if (nom === "rag_read") {
    if (a["source"] !== undefined && a["source"] !== null)
      return "Lecture autour de [" + String(a["source"]) + "]";
    return "Lecture : " + String(a["document"] || "document");
  }
  if (nom === "rag_list") return a["collection"] ? "Documents de la collection" : "Collections actives";
  if (nom === "rag_index") return "Indexation de fichiers du bac à sable";
  return "Consultation documentaire";
}

/** Résumé lisible d'un résultat RAG (« 3 sources trouvées »…). */
export function ragResultLabel(name: unknown, resultStr: unknown): string {
  const nom = String(name || "");
  if (nom.indexOf("rag_") !== 0) return "";
  try {
    const p: unknown = JSON.parse(typeof resultStr === "string" && resultStr ? resultStr : "{}");
    const o = estObjet(p) ? p : {};
    if (o["ok"] === false) return "Échec";
    const passages = Array.isArray(o["passages"]) ? o["passages"].length : 0;
    const s = passages > 1 ? "s" : "";
    if (nom === "rag_search") return passages > 0 ? `${passages} passage${s} trouvé${s}` : "Aucun résultat";
    if (nom === "rag_read") return passages > 0 ? `${passages} passage${s} lu${s}` : "Rien à lire";
    if (nom === "rag_list") {
      const liste = Array.isArray(o["collections"]) ? o["collections"] : o["documents"];
      const n = Array.isArray(liste) ? liste.length : 0;
      const quoi = Array.isArray(o["collections"]) ? "collection" : "document";
      return `${n} ${quoi}${n > 1 ? "s" : ""}`;
    }
    if (nom === "rag_index") {
      const n = Number(o["added"] || 0) + Number(o["replaced"] || 0);
      return n > 0 ? `${n} fichier${n > 1 ? "s" : ""} en indexation` : "Aucun fichier ajouté";
    }
    return "";
  } catch {
    return "Résultat reçu";
  }
}

/** Résultat d'outil en erreur : `{"error": …}` seul ou enveloppe `{"ok": false, …}`. */
export function resultIsError(result: unknown): boolean {
  if (!result || typeof result !== "string") return false;
  try {
    const p: unknown = JSON.parse(result);
    if (!estObjet(p)) return false;
    if ("ok" in p && p["ok"] === false) return true;
    return "error" in p && Object.keys(p).length === 1;
  } catch {
    return false;
  }
}

/** Champs console d'un `execute_shell` lus dans son résultat JSON (null hors forme attendue ou en arrière-plan). */
export function shellFieldsFromResult(resStr: unknown): ChampsShell | null {
  if (!resStr || typeof resStr !== "string") return null;
  try {
    const pr: unknown = JSON.parse(resStr);
    if (!estObjet(pr) || pr["background"]) return null;
    const stdout = pr["stdout"];
    if (typeof stdout !== "string") return null;
    const stderr = typeof pr["stderr"] === "string" ? pr["stderr"] : "";
    const full = stdout + (stderr ? (stdout ? "\n" : "") + stderr : "");
    const out: ChampsShell = {
      shellRc: typeof pr["returncode"] === "number" ? pr["returncode"] : null,
      shellMs: Number(pr["duration_ms"]) || 0,
    };
    if (full) out.shellOut = full.length > 65536 ? full.slice(-65536) : full;
    return out;
  } catch {
    return null;
  }
}

function genreEtape(name: string, args: Objet | null): string | undefined {
  if (name === "task") return "task";
  if (name === "todowrite") return "todo";
  if (name === "memory") {
    const a = args ? String(args["action"] || "").toLowerCase() : "";
    if (a === "add" || a === "replace" || a === "remove" || a === "rewrite") return "memory";
  }
  return undefined;
}

function signature(e: unknown): string {
  if (!estObjet(e)) return "";
  if (e["role"] === "tool") return "t:" + String(e["tool_call_id"] || "");
  const appels = e["tool_calls"];
  if (e["role"] === "assistant" && Array.isArray(appels) && appels.length) {
    const tc: unknown = appels[appels.length - 1];
    return "a:" + String((estObjet(tc) && tc["id"]) || "");
  }
  const c = e["content"];
  return String(e["role"] || "") + ":" + String(c == null ? "" : c).slice(0, 60);
}

function apresDernierUser(h: readonly unknown[]): number {
  for (let i = h.length - 1; i >= 0; i--) {
    const e = h[i];
    if (estObjet(e) && e["role"] === "user") return i + 1;
  }
  return 0;
}

function debutDuTour(h: readonly unknown[], prev: readonly unknown[] | null): number {
  if (!prev) return apresDernierUser(h);
  if (h.length <= prev.length) return apresDernierUser(h);
  const voulue = signature(prev[prev.length - 1]);
  if (signature(h[prev.length - 1]) === voulue) return prev.length;
  for (let j = h.length - 1; j >= 0; j--) if (signature(h[j]) === voulue) return j + 1;
  return apresDernierUser(h);
}

function appliquerMeta(step: EtapeReconstruite, m: MetaOutils["steps"][string] | undefined): void {
  if (!m) return;
  if (typeof m.ms === "number") step.durationMs = m.ms;
  if (m.think) step.thinking = m.think;
  if (typeof m.think_ms === "number") step.thinkingMs = m.think_ms;
  if (m.state === "stopped") step.status = "stopped";
}

/** Vue entrelacée d'un message rechargé ; null si rien d'affichable. */
export function parseToolHistorySegments(
  toolHistory: unknown,
  opts: OptionsSegments = {},
): SegmentsReconstruits | null {
  if (!Array.isArray(toolHistory) || !toolHistory.length) return null;
  const h = toolHistory as readonly unknown[];
  const prev =
    Array.isArray(opts.prevHistory) && opts.prevHistory.length
      ? (opts.prevHistory as readonly unknown[])
      : null;
  const finalContent = typeof opts.finalContent === "string" ? restaurerMarqueursTour(opts.finalContent) : "";
  const start = opts.delta ? 0 : debutDuTour(h, prev);

  const segTexts: string[] = [];
  const toolSteps: EtapeReconstruite[] = [];
  const parId: Record<string, EtapeReconstruite> = Object.create(null) as Record<string, EtapeReconstruite>;
  let tourOutils = false;
  let nRound = -1;

  for (let i = start; i < h.length; i++) {
    const e = h[i];
    if (!estObjet(e) || e["role"] === "user") continue;
    if (e["role"] === "tool") {
      const id = e["tool_call_id"];
      const st = typeof id === "string" && id ? parId[id] : undefined;
      if (st) {
        const c = e["content"];
        const resStr = restaurerMarqueursTour(typeof c === "string" ? c : c == null ? "" : JSON.stringify(c));
        st._is_error = resultIsError(resStr);
        st.result = resStr.slice(0, RESULTAT_RECHARGE_MAX);
        if (resStr.length > RESULTAT_RECHARGE_MAX) st.resultLength = resStr.length;
        if (st.name.indexOf("rag_") === 0) st.ragResultLabel = ragResultLabel(st.name, resStr);
        if (st.name === "execute_shell") {
          const shf = shellFieldsFromResult(resStr);
          if (shf) {
            st.shellDone = true;
            st.shellRc = shf.shellRc;
            st.shellMs = shf.shellMs;
            if (shf.shellOut != null) st.shellOut = shf.shellOut;
          }
        }
      }
      continue;
    }
    if (e["role"] !== "assistant") continue;
    const brut = e["tool_calls"];
    const appels = Array.isArray(brut) && brut.length ? (brut as readonly unknown[]) : null;
    const txt = typeof e["content"] === "string" ? restaurerMarqueursTour(e["content"]).trim() : "";
    if (!appels) {
      if (txt && tourOutils) segTexts.push(txt);
      continue;
    }
    tourOutils = true;
    nRound++;
    if (txt) segTexts.push(txt);
    else if (!segTexts.length) segTexts.push("");
    const seg = segTexts.length - 1;
    for (const appel of appels) {
      const a = estObjet(appel) ? appel : {};
      const fn = estObjet(a["function"]) ? a["function"] : {};
      const name = String(fn["name"] || "?");
      let args: Objet | null = null;
      const fa = fn["arguments"];
      if (typeof fa === "string" && fa) {
        try {
          const p: unknown = JSON.parse(fa);
          args = estObjet(p) ? p : null;
        } catch {
          args = null;
        }
      } else if (estObjet(fa)) args = fa;
      const step: EtapeReconstruite = {
        name,
        args,
        result: null,
        status: "done",
        seg,
        round: nRound,
        thinking: "",
        thinkingOpen: false,
        isRag: false,
        ragLabel: ragCallLabel(name, args),
      };
      const genre = genreEtape(name, args);
      if (genre) step._kind = genre;
      toolSteps.push(step);
      if (typeof a["id"] === "string" && a["id"]) {
        parId[a["id"]] = step;
        step.callId = a["id"];
        appliquerMeta(step, opts.meta?.steps[a["id"]]);
      }
    }
  }

  if (segTexts.length) {
    const dernier = segTexts.length - 1;
    const texte = segTexts[dernier];
    const aDesEtapes = toolSteps.some((s) => s.seg === dernier);
    if (texte && !aDesEtapes) {
      const fc = finalContent.trim();
      if (fc && (fc === texte || fc.indexOf(texte) === 0)) segTexts.pop();
    }
  }
  if (!toolSteps.length) return null;
  return { segTexts, toolSteps };
}

export const segmentsOutils = Object.freeze({
  parseToolHistorySegments,
  ragCallLabel,
  ragResultLabel,
  resultIsError,
  shellFieldsFromResult,
});
