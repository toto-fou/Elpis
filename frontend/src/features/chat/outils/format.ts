// SPDX-License-Identifier: MIT
/** frontend/src/features/chat/outils/format.ts — mise en forme des étapes d'outils : arguments, résultat, compression, console shell (sans Vue, chargeable par Node). */
import { ansiToHtml, escapeHtml } from "../../../utils/ansi.ts";
import { fmtTokenCount } from "../../../utils/utils-purs.ts";
import type { EtapeOutil, GroupeSegment, StatsCompression } from "./types.ts";

/** Une valeur d'argument : JSON indenté, chaîne JSON re-indentée, chaîne simple telle quelle (vrais retours à la ligne). */
export function fmtToolArgVal(val: unknown): string {
  if (val === null || val === undefined) return String(val);
  if (typeof val === "object") return JSON.stringify(val, null, 2);
  if (typeof val === "string") {
    const t = val.trim();
    if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return val;
      }
    }
    return val;
  }
  return String(val as number | boolean | bigint | symbol);
}

function brut(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v as string);
}

/** Résultat d'outil lisible ; l'ordre des stratégies est le métier (`error` avant les champs texte). */
export function formatToolResult(raw: unknown): string {
  if (raw === null || raw === undefined || raw === "") return "--";
  let obj: unknown;
  try {
    obj = JSON.parse(raw as string);
  } catch {
    return raw as string;
  }
  if (typeof obj === "string") return obj;
  if (typeof obj !== "object" || obj === null) return String(obj as number | boolean);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "(aucun résultat)";
    return obj
      .map((item: unknown) => {
        if (typeof item === "string") return "• " + item;
        if (typeof item === "object" && item !== null) {
          const o = item as Record<string, unknown>;
          const label = o.text || o.content || o.name || o.path || o.value || o.output;
          return "• " + (label !== undefined ? String(label as string) : JSON.stringify(item));
        }
        return "• " + String(item as number);
      })
      .join("\n");
  }
  const o = obj as Record<string, unknown>;
  if (o.error !== undefined) return "Erreur : " + String(o.error as string);
  for (const f of ["content", "text", "output", "result", "stdout", "data", "message"]) {
    const v = o[f];
    if (v !== undefined && v !== null && typeof v === "string") {
      const extra = Object.entries(o).filter(([k]) => k !== f && k !== "ok");
      if (extra.length === 0) return v;
      return v + "\n" + extra.map(([k, x]) => `${k}: ${brut(x)}`).join("\n");
    }
  }
  if (o.ok !== undefined && Object.keys(o).length <= 4) {
    const status = o.ok ? "✓ OK" : "✗ Erreur";
    const extra = Object.entries(o)
      .filter(([k]) => k !== "ok")
      .map(([k, x]) => `${k}: ${brut(x)}`)
      .join(" · ");
    return extra ? `${status} -- ${extra}` : status;
  }
  return Object.entries(o)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v, null, 2) : String(v as string)}`)
    .join("\n");
}

const decimale = (x: number): string => x.toLocaleString("fr-FR", { maximumFractionDigits: 1 });

/** Durée en français : « 0,4 s », « 1,2 s », « 18 s », « 1 min 22 s », « 2 h 05 min ». */
export function fmtDuree(ms: number | null | undefined): string {
  const s = Math.max(0, Number(ms) || 0) / 1000;
  if (s < 0.1) return "< 0,1 s";
  if (s < 10) return decimale(Math.floor(s * 10) / 10) + " s";
  const n = Math.floor(s);
  if (n < 60) return n + " s";
  if (n < 3600) return Math.floor(n / 60) + " min " + String(n % 60).padStart(2, "0") + " s";
  return Math.floor(n / 3600) + " h " + String(Math.floor((n % 3600) / 60)).padStart(2, "0") + " min";
}

/** Abréviation des compteurs de jetons du fil, en français (« 32 k », « 1,2 M »). */
export function fmtTokensCourt(n: number | null | undefined): string {
  return fmtTokenCount(n);
}

export function fmtCompression(stats: StatsCompression | null | undefined): string {
  if (!stats || !stats.tokens_before) return "";
  const before = fmtTokensCourt(stats.tokens_before);
  const after = fmtTokensCourt(stats.tokens_after || 0);
  const saved = stats.tokens_saved || 0;
  const pct = stats.tokens_before > 0 ? Math.round((saved / stats.tokens_before) * 100) : 0;
  return pct > 0 ? `${before} → ${after} jetons (−${pct} %)` : `${before} → ${after} jetons`;
}

function commande(step: EtapeOutil): string {
  const a = step.args;
  return String((a && (a.command || a.cmd)) || "");
}

const cacheEtape = new WeakMap<EtapeOutil, { html: string; dernier: boolean }>();

function htmlEtapeShell(step: EtapeOutil, dernier: boolean): string {
  const c = cacheEtape.get(step);
  if (c !== undefined && c.dernier === dernier) return c.html;
  let html =
    '<span class="sh-prompt">$</span> <span class="sh-cmd">' + escapeHtml(commande(step)) + "</span>\n";
  if (step.shellOut != null && step.shellOut !== "") {
    let out: string;
    try {
      out = ansiToHtml(step.shellOut);
    } catch {
      out = "";
    }
    html += out;
    if (!/\n$/.test(step.shellOut)) html += "\n";
  }
  if (step.status === "running" && dernier) html += '<span class="sh-cursor">▋</span>';
  else if (step.shellDone && typeof step.shellRc === "number" && step.shellRc !== 0)
    html += '<span class="sh-rc">↳ code ' + step.shellRc + "</span>\n";
  cacheEtape.set(step, { html, dernier });
  return html;
}

const cacheConsole = new WeakMap<GroupeSegment, string>();

/** HTML de la console d'un segment (`$ cmd`, sortie ANSI échappée, code retour) ; cache sur l'identité du groupe et des étapes. */
export function htmlConsoleShell(grp: GroupeSegment | null | undefined): string {
  if (!grp || !grp.shellRuns || !grp.shellRuns.length) return "";
  const c = cacheConsole.get(grp);
  if (c !== undefined) return c;
  const n = grp.shellRuns.length;
  const html = grp.shellRuns.map((r, i) => htmlEtapeShell(r.step, i === n - 1)).join("\n");
  cacheConsole.set(grp, html);
  return html;
}

/** Texte brut de la console (commandes et sorties, sans ANSI interprété), pour le presse-papiers. */
export function texteConsoleShell(grp: GroupeSegment | null | undefined): string {
  const runs = (grp && grp.shellRuns) || [];
  return runs
    .map((r) => {
      let t = "$ " + commande(r.step) + "\n";
      const out = r.step.shellOut;
      if (out) t += out + (/\n$/.test(out) ? "" : "\n");
      return t;
    })
    .join("\n");
}
