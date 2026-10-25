// SPDX-License-Identifier: MIT
/** apps/core/src/tour/historique.ts — l'historique du chat entre le client, la base et le modèle : normalisation du payload, champs portés par les messages, greffe d'un tour stoppé, « Continuer », expansion vers le format OpenAI (chatbot_app/turn/history.py). */
import {
  BLANC_PY,
  egalPy,
  estDict,
  floatPy,
  FlottantPy,
  intPy,
  longueurPy,
  motifPy,
  prefixePy,
  stripPy,
  strPy,
  texteOu,
  veritePy,
} from "@elpis/commun";
import type { Dict } from "@elpis/commun";

import { clipResumeThinking, RESUME_AFTER_THINK_INSTRUCTION } from "../boucle/reprise-raisonnement";
import { AppelsParId, mergeUserSuffix, pruneKey, userSuffixSig } from "../contexte/elagage";
import { copyFields } from "../images/messages";
import { fusionnerSourcesRag, sourcesRagPropres } from "../rag/sources-message";
import { erreurPropre, fusionnerMetaOutils, metaOutilsPropre } from "./journal-etapes";

/** `_msg_text` : texte d'un contenu, parts `text` d'un contenu multimodal jointes par une espace. */
export function msgText(contenu: unknown): string {
  if (contenu === null || contenu === undefined) return "";
  if (typeof contenu === "string") return contenu;
  if (Array.isArray(contenu))
    return contenu
      .filter((p) => estDict(p) && p["type"] === "text")
      .map((p) => strPy((p as Dict)["text"] ?? ""))
      .join(" ");
  return strPy(contenu);
}

/** Texte du DERNIER message utilisateur (multimodal compris), `""` sans question. */
export function lastUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  for (const m of [...messages].reverse())
    if (estDict(m) && m["role"] === "user") return stripPy(msgText(m["content"]));
  return "";
}

/** Textes des `k` dernières questions non vides (récente d'abord), pour le choix des skills. */
export function recentUserText(messages: unknown, k = 3): string {
  if (!Array.isArray(messages) || k <= 0) return "";
  const textes: string[] = [];
  for (const m of [...messages].reverse()) {
    if (!estDict(m) || m["role"] !== "user") continue;
    const t = stripPy(msgText(m["content"]));
    if (t) textes.push(t);
    if (textes.length >= k) break;
  }
  return textes.join("\n");
}

function nombre(v: unknown): number | null {
  return typeof v === "number" || v instanceof FlottantPy ? floatPy(v) : null;
}

const estEntier = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Pied d'un message des tours précédents renvoyé par le client : valeurs simples et bornées, jamais le raisonnement ni les outils. */
export function metricsForPersist(met: unknown): Dict {
  if (!estDict(met)) return {};
  const out: Dict = {};
  for (const [k, v] of Object.entries(met).slice(0, 40)) {
    if (k === "tool_history" || k === "thinking") continue;
    if (v === null || typeof v === "boolean" || nombre(v) !== null) out[k] = v;
    else if (typeof v === "string" && longueurPy(v) <= 200) out[k] = v;
    else if (k === "kv_cache" && estDict(v)) {
      const kv: Dict = {};
      for (const x of ["used", "total", "pct"])
        if (typeof v[x] === "boolean" || nombre(v[x]) !== null) kv[x] = v[x];
      out[k] = kv;
    }
  }
  return out;
}

/** `task_runs` persistés sans `tools` (déroulé non rendu par la carte agent) ; `transcript` gardé. */
export function taskRunsForPersist(runs: unknown): Dict[] {
  if (!Array.isArray(runs)) return [];
  return runs
    .filter(estDict)
    .map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "tools")));
}

const B = BLANC_PY;
const THINK_ONLY_RE = new RegExp(`^${B}*${motifPy("<think>")}[\\s\\S]*${motifPy("</think>")}${B}*\\n?$`, "u");

export const CANCEL_PLACEHOLDER = "_(génération interrompue)_";

const RESUME_ANSWER =
  "Resume your previous answer exactly where it stopped. Do not repeat it and do not restart it from the beginning — simply continue.";

/** Consigne de reprise selon la nature du dernier assistant (réponse entamée ou raisonnement seul). */
export function resumeInstruction(contenu: unknown): string {
  return THINK_ONLY_RE.test(texteOu(contenu, "")) ? RESUME_AFTER_THINK_INSTRUCTION : RESUME_ANSWER;
}

/** Signatures (id + nom + préfixe) des entrées agentiques d'une entrée de `tool_history` ; vide pour du texte. */
export function toolEntrySigs(h: unknown): Set<string> {
  const sigs = new Set<string>();
  if (!estDict(h)) return sigs;
  if (h["role"] === "assistant" && veritePy(h["tool_calls"])) {
    for (const tc of Array.isArray(h["tool_calls"]) ? h["tool_calls"] : []) {
      if (!estDict(tc)) continue;
      const fn = estDict(tc["function"]) ? tc["function"] : {};
      sigs.add(
        JSON.stringify(["tc", cle(tc["id"]), cle(fn["name"]), prefixePy(texteOu(fn["arguments"], ""), 80)]),
      );
    }
  } else if (h["role"] === "tool")
    sigs.add(JSON.stringify(["tr", cle(h["tool_call_id"]), prefixePy(texteOu(h["content"], ""), 80)]));
  return sigs;
}

function cle(v: unknown): unknown {
  return v === undefined ? null : v instanceof FlottantPy ? floatPy(v) : v;
}

// ── Fichiers modifiés, jalons de compaction, segments d'un « Continuer » ──────

const FC_CHANGES = ["created", "modified", "deleted", "moved"];
const FC_SHA = /^[0-9a-f]{64}$/u;
const FC_MAX = 200;

/** Entrée `files_changed` validée (elle revient du client). */
export function fcClean(e: unknown): Dict | null {
  if (!estDict(e)) return null;
  const path = e["path"];
  if (typeof path !== "string" || !path || longueurPy(path) > 1024) return null;
  const out: Dict = { path, change: FC_CHANGES.includes(e["change"] as string) ? e["change"] : "modified" };
  for (const k of ["before", "after"]) {
    const v = e[k];
    out[k] = typeof v === "string" && FC_SHA.test(v) ? v : null;
  }
  for (const k of ["added", "removed"]) {
    const v = e[k];
    if (estEntier(v) && v >= 0 && v < 10 ** 8) out[k] = v;
  }
  if (typeof e["from"] === "string" && longueurPy(e["from"]) <= 1024) out["from"] = e["from"];
  return out;
}

/** Fusionne les `files` d'un résultat d'outil : « avant » du premier outil, « après » du dernier ; créé puis supprimé = rien. */
export function fcMerge(acc: Map<string, Dict>, files: unknown): void {
  if (!Array.isArray(files)) return;
  for (const brut of files.slice(0, FC_MAX)) {
    const e = fcClean(brut);
    if (e === null) continue;
    const chemin = e["path"] as string;
    const prev = acc.get(chemin);
    if (prev === undefined) {
      if (acc.size < FC_MAX) acc.set(chemin, e);
      continue;
    }
    const merged: Dict = { ...prev, after: e["after"] };
    delete merged["added"];
    delete merged["removed"];
    if (prev["change"] === "created") merged["change"] = e["change"] === "deleted" ? "deleted" : "created";
    else if (e["change"] === "deleted") merged["change"] = "deleted";
    else if (prev["change"] === "deleted") merged["change"] = "modified";
    if (prev["change"] === "created" && e["change"] === "deleted") {
      acc.delete(chemin);
      continue;
    }
    acc.set(chemin, merged);
  }
}

export function fcList(msg: Dict): Dict[] {
  const fc = msg["files_changed"];
  if (!Array.isArray(fc)) return [];
  return fc
    .slice(0, FC_MAX)
    .map(fcClean)
    .filter((e): e is Dict => e !== null);
}

const COMPACTION_NOMBRES = [
  "round",
  "threshold",
  "ctx_size",
  "tokens_before",
  "tokens_after",
  "tokens_saved",
  "messages_before",
  "messages_after",
  "duration_ms",
  "turns_compressed",
];

/** Jalon de compaction gardé sur un message : champs connus, bornés (il revient du client). */
export function compactionPourMessage(c: Dict): Dict {
  const out: Dict = {};
  for (const k of COMPACTION_NOMBRES) {
    const v = nombre(c[k]);
    if (v !== null && Number.isFinite(v) && v >= 0 && v < 10 ** 9) out[k] = Math.trunc(v);
  }
  for (const [k, n] of [
    ["reason", 32],
    ["path", 32],
    ["model_used", 120],
  ] as const) {
    const v = c[k];
    if (typeof v === "string" && v) out[k] = prefixePy(v, n);
  }
  if (typeof c["had_previous_summary"] === "boolean") out["had_previous_summary"] = c["had_previous_summary"];
  return out;
}

function roundsDOutils(toolHistory: unknown): number {
  if (!Array.isArray(toolHistory)) return 0;
  return toolHistory.filter((h) => estDict(h) && h["role"] === "assistant" && veritePy(h["tool_calls"]))
    .length;
}

/** « Continuer » : `task_runs`, exécutions, jalons et images du segment tronqué EN TÊTE de ceux de la continuation ; mute `msg`. */
export function mergePrevSegmentLists(prev: Dict, msg: Dict): void {
  if (veritePy(prev["tool_history_delta"]) && Array.isArray(msg["compactions"])) {
    const dec = roundsDOutils(prev["tool_history"]);
    if (dec)
      msg["compactions"] = (msg["compactions"] as unknown[]).map((c) =>
        estDict(c) ? { ...c, round: intPy(veritePy(c["round"]) ? c["round"] : 0) + dec } : c,
      );
  }
  const [pAnc, pNeuf] = [prev["pruned"], msg["pruned"]];
  if (estEntier(pAnc) && pAnc > 0) msg["pruned"] = pAnc + (estEntier(pNeuf) ? pNeuf : 0);
  for (const k of ["task_runs", "run_ids", "compactions", "tool_images"]) {
    const anc = Array.isArray(prev[k]) ? (prev[k] as unknown[]) : [];
    if (!anc.length) continue;
    const neuf = Array.isArray(msg[k]) ? (msg[k] as unknown[]) : [];
    msg[k] = [...anc, ...neuf.filter((x) => !anc.some((a) => egalPy(a, x)))];
  }
  if (Array.isArray(prev["rag_sources"]) && prev["rag_sources"].length)
    msg["rag_sources"] = fusionnerSourcesRag(prev["rag_sources"], msg["rag_sources"]);
  if (prev["tool_meta"] !== undefined) {
    const meta = fusionnerMetaOutils(prev["tool_meta"], msg["tool_meta"]);
    if (meta) msg["tool_meta"] = meta;
  }
  const ancFc = fcList(prev);
  if (ancFc.length) {
    const acc = new Map(ancFc.map((e) => [e["path"] as string, e]));
    fcMerge(acc, fcList(msg));
    msg["files_changed"] = [...acc.values()];
  }
}

/** Tronc + delta de la continuation, concaténés ; delta seulement si aucun segment cumulatif (legacy) n'y entre. */
export function mergeContinueToolHistory(prev: Dict, contHist: unknown, contIsDelta: boolean): Dict {
  const prevHist = Array.isArray(prev["tool_history"]) ? (prev["tool_history"] as unknown[]) : [];
  const prevDelta = veritePy(prev["tool_history_delta"]);
  const cont = Array.isArray(contHist) ? (contHist as unknown[]) : [];
  const merged = [...prevHist, ...cont];
  if (!merged.length) return {};
  return {
    tool_history: merged,
    tool_history_delta: (prevDelta || !prevHist.length) && (contIsDelta || !cont.length),
  };
}

// ── Payload client ───────────────────────────────────────────────────────────

const CLIENT_ROLES = ["user", "assistant", "system", "tool", "notice"];
const NOTICE_FIELDS = ["kind", "ts", "round", "tokens_after", "summary"];
const GRAFT_KEYS = [
  "tool_history",
  "tool_history_delta",
  "task_runs",
  "resume_thinking",
  "thinkingTruncated",
  "run_ids",
  "compactions",
  "tool_images",
  "rag_sources",
  "tool_meta",
  "error",
];

/** Recolle aux assistants TRONQUÉS du payload l'état d'outils que seule la base connaît (même position, même question, même texte) ; rend le nombre de messages complétés. */
export function graftStoppedTurnState(filtres: Dict[], persistables: Dict[], dbMsgs: unknown): number {
  if (!Array.isArray(dbMsgs) || filtres.length !== persistables.length) return 0;
  let n = 0;
  for (let i = 0; i < filtres.length; i++) {
    if (i >= dbMsgs.length) break;
    if (i === 0) continue;
    const m = filtres[i]!;
    const d: unknown = dbMsgs[i];
    if (!(estDict(d) && m["role"] === "assistant" && d["role"] === "assistant" && veritePy(d["isTruncated"])))
      continue;
    if (veritePy(m["tool_history"]) || !(veritePy(d["tool_history"]) || veritePy(d["task_runs"]))) continue;
    const prevC = filtres[i - 1]!;
    const prevD: unknown = dbMsgs[i - 1];
    if (!(estDict(prevD) && egalPy(prevC["role"] ?? null, prevD["role"] ?? null))) continue;
    if (!egalPy(prevC["content"] ?? null, prevD["content"] ?? null)) continue;
    const mc = m["content"];
    if (!(
      egalPy(mc ?? null, d["content"] ?? null) ||
      mc === "" ||
      mc === null ||
      mc === undefined ||
      mc === CANCEL_PLACEHOLDER
    ))
      continue;
    const ajout: Dict = {};
    for (const k of GRAFT_KEYS) if (veritePy(d[k]) && !veritePy(m[k])) ajout[k] = d[k];
    if (!Object.keys(ajout).length) continue;
    if (!("isTruncated" in ajout)) ajout["isTruncated"] = true;
    filtres[i] = { ...m, ...ajout };
    persistables[i] = { ...persistables[i], ...ajout };
    n += 1;
  }
  return n;
}

/** Sources RAG qu'un client a perdues (instantané d'onglet, ancienne version) reprises de la base : même position, même rôle, même texte. */
export function greffeSourcesRag(persistables: Dict[], dbMsgs: unknown): number {
  if (!Array.isArray(dbMsgs)) return 0;
  let n = 0;
  persistables.forEach((m, i) => {
    const d: unknown = dbMsgs[i];
    if (m["role"] !== "assistant" || veritePy(m["rag_sources"]) || !estDict(d) || d["role"] !== "assistant")
      return;
    if (!egalPy(m["content"] ?? null, d["content"] ?? null)) return;
    const sources = sourcesRagPropres(d["rag_sources"]);
    if (!sources.length) return;
    m["rag_sources"] = sources;
    n += 1;
  });
  return n;
}

/** Payload client → `[filtrés, persistables]` : dicts d'origine aux rôle et contenu valides, et copies aux champs whitelistés (historique d'outils compris). */
export function normalizeClientMessages(messages: unknown): [Dict[], Dict[]] {
  const filtres: Dict[] = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!estDict(m) || !CLIENT_ROLES.includes(m["role"] as string)) continue;
    const c = "content" in m ? m["content"] : "";
    if (typeof c !== "string" && !Array.isArray(c)) continue;
    filtres.push(m);
  }
  const persistables: Dict[] = [];
  for (const m of filtres) {
    const mm: Dict = { role: m["role"], content: "content" in m ? m["content"] : "" };
    if (veritePy(m["tool_history"])) {
      mm["tool_history"] = m["tool_history"];
      if (veritePy(m["tool_history_delta"])) mm["tool_history_delta"] = true;
    }
    if (veritePy(m["thinking"])) mm["thinking"] = m["thinking"];
    if (typeof m["resume_thinking"] === "string" && m["resume_thinking"])
      mm["resume_thinking"] = m["resume_thinking"];
    if (veritePy(m["thinkingTruncated"])) mm["thinkingTruncated"] = true;
    if (veritePy(m["images"])) mm["images"] = m["images"];
    const fcl = veritePy(m["files_changed"]) ? fcList(m) : [];
    if (fcl.length) mm["files_changed"] = fcl;
    if (veritePy(m["task_runs"])) {
      const runs = taskRunsForPersist(m["task_runs"]);
      if (runs.length) mm["task_runs"] = runs;
    }
    if (Array.isArray(m["run_ids"])) {
      const rids = (m["run_ids"] as unknown[])
        .filter((r): r is string => typeof r === "string" && r.length > 0 && longueurPy(r) <= 64)
        .slice(0, 64);
      if (rids.length) mm["run_ids"] = rids;
    }
    const pruned = m["pruned"];
    if (estEntier(pruned) && pruned > 0 && pruned < 100000) mm["pruned"] = pruned;
    if (Array.isArray(m["compactions"])) {
      const cps = (m["compactions"] as unknown[]).slice(0, 20).filter(estDict).map(compactionPourMessage);
      if (cps.length) mm["compactions"] = cps;
    }
    const met = metricsForPersist(m["metrics"]);
    if (Object.keys(met).length) mm["metrics"] = met;
    copyFields(m, mm);
    if (m["role"] === "assistant" && Array.isArray(m["rag_sources"])) {
      const sources = sourcesRagPropres(m["rag_sources"]);
      if (sources.length) mm["rag_sources"] = sources;
    }
    if (m["role"] === "assistant" && m["tool_meta"] !== undefined) {
      const meta = metaOutilsPropre(m["tool_meta"]);
      if (meta) mm["tool_meta"] = meta;
    }
    if (m["role"] === "assistant" && m["error"] !== undefined) {
      const erreur = erreurPropre(m["error"]);
      if (erreur) mm["error"] = erreur;
    }
    if (m["role"] === "user" && m["origin"] === "job_wake") {
      mm["origin"] = "job_wake";
      if (estDict(m["wake"])) mm["wake"] = m["wake"];
    }
    if (m["role"] === "notice")
      for (const k of NOTICE_FIELDS) if (m[k] !== null && m[k] !== undefined) mm[k] = m[k];
    persistables.push(mm);
  }
  return [filtres, persistables];
}

/** Tronc gardé devant la continuation d'un « Continuer » : jamais le marqueur d'interface d'un Stop sans prose. */
export function troncPourReprise(prev: Dict): string {
  const texte = msgText("content" in prev ? prev["content"] : "");
  return stripPy(texte) === CANCEL_PLACEHOLDER ? "" : texte;
}

/** Dernier assistant d'un fil qui peut finir par des notices : `[prev, avant, après]`, `prev` vide sans assistant final. */
export function splitForContinue(msgs: Dict[]): [Dict, Dict[], Dict[]] {
  let i = msgs.length - 1;
  while (i >= 0 && (msgs[i] ?? {})["role"] === "notice") i -= 1;
  if (i < 0 || (msgs[i] ?? {})["role"] !== "assistant") return [{}, msgs, []];
  return [msgs[i]!, msgs.slice(0, i), msgs.slice(i + 1)];
}

export interface OptionsExpansion {
  isContinue?: boolean;
  prunedKeys?: readonly unknown[];
  resumeNative?: boolean;
  userSuffixes?: unknown;
}

function suiteDeReprise(rt: unknown, resumeNative: boolean): Dict[] {
  const clip = clipResumeThinking(strPy(rt));
  if (resumeNative) return [{ role: "assistant", content: "", reasoning_content: clip }];
  return [
    { role: "assistant", content: "<think>\n" + clip + "\n</think>" },
    { role: "user", content: RESUME_AFTER_THINK_INSTRUCTION },
  ];
}

/** Historique client → messages OpenAI : `tool_history` intercalée (préfixe rejoué des formats cumulatifs coupé), résultats élagués en condensé d'une ligne, suffixes de questions, reprise d'un « Continuer ». */
export function expandHistoryForLlm(messages: Dict[], o: OptionsExpansion = {}): Dict[] {
  const isContinue = o.isContinue ?? false;
  const pruned = new Set((o.prunedKeys ?? []).filter((k): k is string => typeof k === "string"));
  const suffixes = estDict(o.userSuffixes) ? o.userSuffixes : {};
  const avecSuffixes = Object.keys(suffixes).length > 0;
  const out: Dict[] = [];
  const vues = new Set<string>();
  const appels = new AppelsParId();
  let rangQuestion = 0;
  let derniereQuestion = -1;
  messages.forEach((mm, j) => {
    if ((mm ?? {})["role"] === "user") derniereQuestion = j;
  });
  let dernier = messages.length - 1;
  while (dernier >= 0 && (messages[dernier] ?? {})["role"] === "notice") dernier -= 1;
  const reprise = (contenu: unknown, m: Dict): void => {
    const c = veritePy(contenu) ? stripPy(strPy(contenu)) : "";
    if (c && c !== CANCEL_PLACEHOLDER) {
      out.push(
        { role: "assistant", content: contenu },
        { role: "user", content: resumeInstruction(contenu) },
      );
    } else if (veritePy(m["resume_thinking"]))
      out.push(...suiteDeReprise(m["resume_thinking"], o.resumeNative ?? false));
  };
  messages.forEach((m, i) => {
    const role = m["role"];
    if (role === "notice") return;
    let contenu = m["content"];
    const hist = m["tool_history"];
    if (role === "assistant" && Array.isArray(hist) && hist.length) {
      let debut = 0;
      if (!veritePy(m["tool_history_delta"])) {
        for (const [k, h] of hist.entries()) {
          const sigs = toolEntrySigs(h);
          if (!sigs.size) continue;
          if ([...sigs].every((s) => vues.has(s))) {
            debut = k + 1;
            continue;
          }
          break;
        }
        while (debut < hist.length && estDict(hist[debut]) && hist[debut]["role"] === "user") debut += 1;
        while (debut < hist.length && estDict(hist[debut]) && hist[debut]["role"] === "tool") debut += 1;
      }
      for (const h of hist.slice(debut)) {
        if (!estDict(h)) continue;
        const hr = h["role"];
        if (hr !== "assistant" && hr !== "tool" && hr !== "user") continue;
        const e: Dict = { role: hr };
        if ("content" in h) e["content"] = h["content"] ?? null;
        if (hr === "assistant" && veritePy(h["tool_calls"])) e["tool_calls"] = h["tool_calls"];
        appels.noter(h);
        if (hr === "tool" && veritePy(h["tool_call_id"])) {
          e["tool_call_id"] = h["tool_call_id"];
          if (pruned.size) {
            const cle = pruneKey(h);
            if (cle !== null && pruned.has(cle)) e["content"] = appels.marqueur(h);
          }
        }
        out.push(e);
        for (const s of toolEntrySigs(h)) vues.add(s);
      }
      if (isContinue && i === dernier) reprise(contenu, m);
      else if (veritePy(contenu)) out.push({ role: "assistant", content: contenu });
      return;
    }
    if (isContinue && i === dernier && role === "assistant") {
      reprise(contenu, m);
      return;
    }
    if (role === "user" && avecSuffixes && (i < derniereQuestion || isContinue)) {
      const sig = userSuffixSig(rangQuestion, contenu);
      if (Object.hasOwn(suffixes, sig)) contenu = mergeUserSuffix(contenu, suffixes[sig] as string);
    }
    if (role === "user") rangQuestion += 1;
    out.push({ role, content: contenu ?? null });
  });
  return out;
}
