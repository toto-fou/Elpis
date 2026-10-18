// SPDX-License-Identifier: MIT
/** apps/core/src/boucle/surveillance.ts — traceur contexte/perf (NDJSON par jour et par process, `LLAMA_WATCH=1`) et rapport hors ligne. */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  arrondiPy,
  comparePointsDeCode,
  estDict,
  fixePy,
  intPy,
  longueurPy,
  prefixePy,
  pyJsonDumps,
  strPy,
} from "@elpis/commun";

import type { Dict } from "../python";

const HEAD_CHARS = 160;
const PRUNE_MARKER = "chars omitted — tool history compaction";
const VISION_MARKER = "previous screenshot elided";
const VRAIS = new Set(["1", "true", "yes", "on"]);

function drapeau(nom: string): boolean {
  return VRAIS.has((process.env[nom] ?? "").trim().toLowerCase());
}

export function watchEnabled(): boolean {
  return drapeau("LLAMA_WATCH");
}

function watchDir(): string {
  return (process.env["LLAMA_WATCH_DIR"] ?? "").trim() || path.join("traces", "llm-watch");
}

function jour(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** Une ligne NDJSON (fichier du jour et du process) ; tout échec est tu. */
function ecrire(record: Dict): void {
  try {
    const d = watchDir();
    mkdirSync(d, { recursive: true });
    appendFileSync(
      path.join(d, `watch-${jour()}-${process.pid}.ndjson`),
      pyJsonDumps(record, { ensureAscii: false, separators: [",", ":"] }) + "\n",
      "utf-8",
    );
  } catch {
    return;
  }
}

/** Résumé d'UN message du prompt assemblé (taille, marqueurs, extrait). */
export function msgEntry(i: number, m: Dict): Dict {
  const role = m["role"];
  const c = m["content"];
  const e: Dict = { i, role };
  const complet = drapeau("LLAMA_WATCH_FULL");
  if (typeof c === "string") {
    e["chars"] = longueurPy(c);
    if (role === "tool") {
      if (m["tool_call_id"]) e["tcid"] = m["tool_call_id"];
      if (c.includes(PRUNE_MARKER)) e["pruned"] = true;
    }
    if (complet) e["content"] = c;
    else if (c) e["head"] = prefixePy(c, HEAD_CHARS);
  } else if (Array.isArray(c)) {
    const txt = c
      .filter((b) => estDict(b) && typeof b["text"] === "string")
      .map((b) => (b as Record<string, string>)["text"])
      .join("");
    e["chars"] = longueurPy(txt);
    e["imgs"] = c.filter((b) => estDict(b) && b["type"] === "image_url").length;
    if (c.some((b) => estDict(b) && strPy(b["text"] || "").includes(VISION_MARKER)))
      e["vision_pruned"] = true;
    if (complet) e["content"] = txt;
    else if (txt) e["head"] = prefixePy(txt, HEAD_CHARS);
  }
  const tcs = m["tool_calls"];
  if (Array.isArray(tcs) && tcs.length)
    e["tool_calls"] = tcs.filter(estDict).map((tc) => {
      const fn = estDict(tc["function"]) ? tc["function"] : {};
      return { name: fn["name"] ?? null, args_chars: longueurPy(strPy(fn["arguments"] || "")) };
    });
  return e;
}

export interface AppelSurveille {
  chatId: string | null;
  path: string;
  iteration: number | null;
  model: string | null;
  messages: readonly unknown[] | null;
  toolsPayload: readonly unknown[] | null;
  usage: Dict | null;
  timings: Dict | null;
  fit?: Dict | null;
  extra?: Dict | null;
}

/** Enregistrement d'UN appel LLM (vue envoyée + mesure réelle du serveur), sans horodatage. */
export function recordLlmCall(a: AppelSurveille): Dict {
  const usage = a.usage || {};
  const timings = a.timings || {};
  const rec: Dict = {
    kind: "llm_call",
    chat: strPy(a.chatId || ""),
    path: a.path,
    iter: a.iteration,
    model: a.model || "",
  };
  if (a.messages && a.messages.length) {
    const entrees = a.messages.flatMap((m, i) => (estDict(m) ? [msgEntry(i, m)] : []));
    rec["n_msgs"] = entrees.length;
    rec["total_chars"] = entrees.reduce((n, e) => n + intPy(e["chars"] ?? 0), 0);
    rec["head_chars"] = entrees.find((e) => e["role"] === "system")?.["chars"] ?? 0;
    rec["msgs"] = entrees;
  }
  if (a.toolsPayload && a.toolsPayload.length) {
    try {
      rec["tools"] = {
        n: a.toolsPayload.length,
        chars: longueurPy(pyJsonDumps(a.toolsPayload, { ensureAscii: false, sortKeys: true })),
      };
    } catch {
      rec["tools"] = { n: a.toolsPayload.length };
    }
  }
  const pt = intPy(usage["prompt_tokens"] || 0);
  const ct = intPy(usage["completion_tokens"] || 0);
  const pn = timings["prompt_n"];
  rec["usage"] = { prompt_tokens: pt, completion_tokens: ct };
  rec["timings"] = Object.fromEntries(
    ["prompt_n", "prompt_ms", "predicted_n", "predicted_ms", "cache_n"]
      .filter((k) => Object.hasOwn(timings, k))
      .map((k) => [k, timings[k]]),
  );
  if (pt > 0 && typeof pn === "number" && pn >= 0) {
    const reused = Math.max(0, pt - Math.trunc(pn));
    rec["kv"] = { reused, ratio: arrondiPy(reused / pt, 4) };
  }
  if (a.fit && Object.keys(a.fit).length) rec["fit"] = a.fit;
  if (a.extra && Object.keys(a.extra).length) rec["extra"] = a.extra;
  return rec;
}

/** Journalise UN appel LLM ; no-op si `LLAMA_WATCH` est inactif. */
export function watchLlmCall(a: AppelSurveille): void {
  if (!watchEnabled()) return;
  try {
    const { kind, ...reste } = recordLlmCall(a);
    ecrire({ kind, ts: arrondiPy(Date.now() / 1000, 3), ...reste });
  } catch {
    return;
  }
}

/** Journalise UNE exécution d'outil (tailles, durée, statut). */
export function watchToolCall(t: {
  chatId: string | null;
  iteration: number | null;
  tool: string;
  argsChars: number;
  resultChars: number;
  durationMs: number;
  status: string;
}): void {
  if (!watchEnabled()) return;
  ecrire({
    kind: "tool",
    ts: arrondiPy(Date.now() / 1000, 3),
    chat: strPy(t.chatId || ""),
    iter: t.iteration,
    tool: t.tool,
    args_chars: Math.trunc(t.argsChars),
    result_chars: Math.trunc(t.resultChars),
    ms: Math.trunc(t.durationMs),
    status: t.status,
  });
}

function fmtK(n: number): string {
  return Math.abs(n) >= 1000 ? `${fixePy(n / 1000, 1)}k` : String(Math.trunc(n));
}

function charger(chemins: readonly string[]): Dict[] {
  const sortie: Dict[] = [];
  for (const p of chemins) {
    let texte: string;
    try {
      texte = readFileSync(p, "utf-8");
    } catch {
      continue;
    }
    for (const brute of texte.split("\n")) {
      const ligne = brute.trim();
      if (!ligne) continue;
      try {
        const r: unknown = JSON.parse(ligne);
        if (estDict(r)) sortie.push(r);
      } catch {
        continue;
      }
    }
  }
  return sortie.sort((a, b) => Number(a["ts"] ?? 0) - Number(b["ts"] ?? 0));
}

const champ = (r: Dict, k: string): Dict => (estDict(r[k]) ? r[k] : {});
const nombre = (v: unknown): number => (typeof v === "number" ? v : Number(v || 0) || 0);

/** Synthèse des traces par chat : volumétrie, efficacité du cache KV, pires itérations, messages et outils lourds. */
export function report(chemins: readonly string[]): string {
  const recs = charger(chemins);
  if (!recs.length) return "aucun record (fichiers vides ou LLAMA_WATCH inactif)";
  const calls = recs.filter((r) => r["kind"] === "llm_call");
  const tools = recs.filter((r) => r["kind"] === "tool");
  const lignes: string[] = [];
  const chats = [...new Set(recs.map((r) => strPy(r["chat"] ?? "")))].sort(comparePointsDeCode);
  for (const chat of chats) {
    const cc = calls.filter((r) => r["chat"] === chat);
    const ct = tools.filter((r) => r["chat"] === chat);
    if (!cc.length && !ct.length) continue;
    lignes.push(`── chat ${chat || "(sans id)"} — ${cc.length} appel(s) LLM, ${ct.length} outil(s)`);
    if (cc.length) {
      const pt = cc.reduce((n, r) => n + nombre(champ(r, "usage")["prompt_tokens"]), 0);
      const gen = cc.reduce((n, r) => n + nombre(champ(r, "usage")["completion_tokens"]), 0);
      const pn = cc.reduce((n, r) => n + Math.trunc(nombre(champ(r, "timings")["prompt_n"])), 0);
      const pms = cc.reduce((n, r) => n + nombre(champ(r, "timings")["prompt_ms"]), 0);
      const reused = cc.reduce((n, r) => n + nombre(champ(r, "kv")["reused"]), 0);
      lignes.push(
        `   tokens soumis Σ=${fmtK(pt)}  générés Σ=${fmtK(gen)}  re-préfillés Σ=${fmtK(pn)}  prefill Σ=${fixePy(pms / 1000, 1)}s`,
      );
      if (pt)
        lignes.push(
          `   cache KV : réutilisé ${fmtK(reused)}/${fmtK(pt)} (${fixePy((100 * reused) / pt, 0)} %)`,
        );
      const pires = cc
        .filter((r) => Object.keys(champ(r, "kv")).length)
        .map((r, i) => [r, i] as const)
        .sort(([a, i], [b, j]) => nombre(champ(a, "kv")["ratio"]) - nombre(champ(b, "kv")["ratio"]) || i - j)
        .slice(0, 3)
        .map(([r]) => r);
      for (const r of pires)
        lignes.push(
          `   pire ratio : iter=${strPy(r["iter"] ?? null)} ratio=${fixePy(100 * nombre(champ(r, "kv")["ratio"]), 0)} % (prompt=${fmtK(nombre(champ(r, "usage")["prompt_tokens"]))}, re-préfillé=${fmtK(Math.trunc(nombre(champ(r, "timings")["prompt_n"])))})`,
        );
      const dernier = cc[cc.length - 1]!;
      const msgs = Array.isArray(dernier["msgs"]) ? (dernier["msgs"] as Dict[]) : [];
      if (msgs.length) {
        const lourds = msgs
          .map((e, i) => [e, i] as const)
          .sort(([a, i], [b, j]) => nombre(b["chars"]) - nombre(a["chars"]) || i - j)
          .slice(0, 5)
          .map(([e]) => e);
        lignes.push(
          "   messages les plus lourds (dernier appel) : " +
            lourds
              .map(
                (e) =>
                  `#${strPy(e["i"])} ${strPy(e["role"] ?? null)}${e["pruned"] ? "(élagué)" : ""} ${fmtK(nombre(e["chars"]))}c`,
              )
              .join(", "),
        );
        lignes.push(
          `   tête système : ${fmtK(nombre(dernier["head_chars"]))}c ; total : ${fmtK(nombre(dernier["total_chars"]))}c ; tools payload : ${fmtK(nombre(champ(dernier, "tools")["chars"]))}c`,
        );
      }
    }
    if (ct.length) {
      const parOutil = new Map<string, { n: number; out: number; max: number; ms: number; err: number }>();
      for (const t of ct) {
        const nom = strPy(t["tool"] ?? "?");
        const a = parOutil.get(nom) ?? { n: 0, out: 0, max: 0, ms: 0, err: 0 };
        a.n += 1;
        a.out += nombre(t["result_chars"]);
        a.max = Math.max(a.max, nombre(t["result_chars"]));
        a.ms += nombre(t["ms"]);
        a.err += t["status"] === "error" ? 1 : 0;
        parOutil.set(nom, a);
      }
      lignes.push(
        "   outils : " +
          [...parOutil.entries()]
            .map((x, i) => [x, i] as const)
            .sort(([[, a], i], [[, b], j]) => b.out - a.out || i - j)
            .map(
              ([[nom, a]]) =>
                `${nom}×${a.n} (Σ${fmtK(a.out)}c, max ${fmtK(a.max)}c, Σ${fixePy(a.ms / 1000, 1)}s${a.err ? `, err ${a.err}` : ""})`,
            )
            .join(" · "),
      );
    }
  }
  return lignes.join("\n");
}
