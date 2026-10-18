// SPDX-License-Identifier: MIT
/** frontend/src/modeles/automation-model.ts — modèle pur d'une automatisation du Studio et générateur de code Python (runtime elpis_auto). */
import { summarizeExpect, summarizeStep } from "./scenario-model.ts";
import type { Ancre, ArgsAction, Attente, PasScenario } from "./scenario-model.ts";

export interface Condition {
  type?: string;
  anchor?: Ancre;
  query?: string;
  expected?: string;
  cmp?: string;
  state?: string;
}

export interface EtapeAuto {
  kind?: string;
  op?: string;
  anchor?: Ancre;
  args?: ArgsAction;
  expect?: Attente | null;
  timeout_ms?: number;
  retry?: number;
  on_error?: string;
  comment?: string;
  cond?: Condition;
  times?: number;
  window?: string;
  text?: string;
  name?: string;
  source?: string;
  key?: string;
  query?: string;
  [cle: string]: unknown;
}

export interface ParamAuto {
  name: string;
  value?: unknown;
}

export interface ScriptAuto {
  version?: number;
  name?: string;
  target?: string;
  os?: string;
  monitor?: number | string;
  timeout_s?: number | string | null;
  params?: ParamAuto[];
  steps?: EtapeAuto[];
  updated_at?: string | null;
}

export interface ErreurBloc {
  index: number;
  message: string;
}

export interface LignePlan {
  line: number;
  indent: number;
  text: string;
  kind: string;
  anchor: string;
}

export const DEFAULT_TIMEOUT_MS = 30000;
const BLOCK_OPEN: Readonly<Record<string, boolean>> = { if: true, loop: true };
export const KINDS = ["action", "wait", "check", "if", "else", "end", "loop", "focus", "note", "var", "code"];
export const TIMEOUT_VAR = "TIMEOUT";
export const FOOTER = "raise SystemExit(s.finish())";

const TIMEOUT_RX = /^(TIMEOUT[ \t]*=[ \t]*)(\d+(?:\.\d+)?)([ \t]*(?:#.*)?)$/m;
const TIMEOUT_DECL_RX = /^TIMEOUT[ \t]*(?::[^=\n]*)?=(?!=)/m;
const TIMEOUT_COMMENT =
  "   # délai par défaut (s) de tout ce qui attend ; timeout=… sur une ligne pour la changer";
const NEEDS_TARGET = [
  "click",
  "left_click",
  "invoke",
  "double_click",
  "triple_click",
  "right_click",
  "middle_click",
  "set_value",
  "move",
  "drag",
  "toggle",
  "check",
  "uncheck",
  "select",
  "expand",
  "collapse",
  "scroll_into_view",
];
const IDENTITY_KEYS = [
  "auto_id",
  "name",
  "role",
  "path",
  "near",
  "side",
  "image",
  "describe",
  "window",
  "rel",
  "at",
];

export function newAutomation(entree?: Partial<ScriptAuto> | null): ScriptAuto {
  const fields = entree || {};
  return {
    version: 2,
    name: fields.name || "",
    target: fields.target || "",
    os: fields.os || "",
    monitor: Number(fields.monitor || 0),
    timeout_s: Number(fields.timeout_s) > 0 ? Number(fields.timeout_s) : null,
    params: Array.isArray(fields.params) ? fields.params.slice() : [],
    steps: Array.isArray(fields.steps) ? fields.steps.slice() : [],
    updated_at: fields.updated_at || null,
  };
}

/** Étape d'action normalisée par scenario-model ({op, anchor, args, expect?}) devenue kind « action ». */
export function actionStep(step?: Partial<PasScenario> | null): EtapeAuto {
  return { ...(step || {}), kind: "action" } as EtapeAuto;
}

export function makeStep(kind: string, fields?: Partial<EtapeAuto> | null): EtapeAuto {
  if (KINDS.indexOf(kind) < 0) throw new Error("kind inconnu : " + kind);
  const st: EtapeAuto = { kind, ...(fields || {}) };
  if (kind === "loop" && !(Number(st.times) > 0)) st.times = 3;
  if (kind === "if" && !st.cond) st.cond = { type: "exists", query: "" };
  if (kind === "var" && !st.name) st.name = "valeur";
  if (kind === "var" && !st.source) st.source = "value";
  return st;
}

/** Indentation d'affichage de chaque étape ; else/end au niveau du bloc qu'ils ferment. */
export function blockDepths(steps?: readonly EtapeAuto[] | null): number[] {
  let d = 0;
  const out: number[] = [];
  for (const st of steps || []) {
    const kind = st.kind ?? "";
    if (kind === "end" || kind === "else") d = Math.max(0, d - 1);
    out.push(d);
    if (BLOCK_OPEN[kind] || kind === "else") d++;
  }
  return out;
}

export function validateBlocks(steps?: readonly EtapeAuto[] | null): { ok: boolean; errors: ErreurBloc[] } {
  const stack: { kind: string; i: number; hasElse: boolean }[] = [];
  const errors: ErreurBloc[] = [];
  (steps || []).forEach((st, i) => {
    const kind = st.kind ?? "";
    if (BLOCK_OPEN[kind]) stack.push({ kind, i, hasElse: false });
    else if (kind === "else") {
      const top = stack[stack.length - 1];
      if (!top || top.kind !== "if") errors.push({ index: i, message: "« Sinon » sans « Si »" });
      else if (top.hasElse) errors.push({ index: i, message: "deux « Sinon » pour le même « Si »" });
      else top.hasElse = true;
    } else if (kind === "end") {
      if (!stack.length) errors.push({ index: i, message: "« Fin » sans bloc ouvert" });
      else stack.pop();
    }
  });
  for (const b of stack) {
    errors.push({
      index: b.i,
      message: (b.kind === "if" ? "« Si »" : "« Boucle »") + " jamais fermé (ajoute « Fin »)",
    });
  }
  return { ok: errors.length === 0, errors };
}

export function condLabel(entree?: Condition | null): string {
  const cond = entree || {};
  const who = (cond.anchor && (cond.anchor.label || cond.anchor.auto_id)) || cond.query || "?";
  switch (cond.type) {
    case "missing":
      return "si « " + who + " » absent";
    case "value":
      return (
        "si « " +
        who +
        " » " +
        (cond.cmp === "exact" ? "= " : "contient ") +
        "« " +
        (cond.expected || "") +
        " »"
      );
    case "state":
      return "si « " + who + " » est " + (cond.state || "?");
    case "text":
      return "si le texte « " + (cond.query || "") + " » est visible";
    default:
      return "si « " + who + " » présent";
  }
}

export function stepLabel(step?: EtapeAuto | null): string {
  if (!step) return "";
  const exp = (): string => summarizeExpect(step.expect, step.timeout_ms || DEFAULT_TIMEOUT_MS);
  switch (step.kind) {
    case "wait":
      return "attendre : " + exp();
    case "check":
      return "vérifier : " + exp();
    case "if":
      return condLabel(step.cond);
    case "else":
      return "sinon";
    case "end":
      return "fin";
    case "loop":
      return "répéter " + (step.times || 1) + " fois";
    case "focus":
      return "premier plan « " + (step.window || "") + " »";
    case "note":
      return "note : " + (step.text || "");
    case "var":
      return (
        step.name +
        " ← " +
        (step.source === "clipboard"
          ? "presse-papiers"
          : step.source === "param"
            ? "paramètre " + (step.key || "")
            : "valeur de « " + ((step.anchor && step.anchor.label) || step.query || "?") + " »")
      );
    case "code":
      return "code : " + String(step.text || "").split("\n")[0];
    default:
      return summarizeStep(step as Partial<PasScenario>);
  }
}

export function pyStr(s: unknown): string {
  const v = String(s == null ? "" : s);
  return (
    '"' +
    v
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "")
      .replace(/\t/g, "\\t") +
    '"'
  );
}

function pyIdent(s: unknown): string {
  let v = String(s || "valeur").replace(/[^A-Za-z0-9_]/g, "_");
  if (/^[0-9]/.test(v)) v = "_" + v;
  return v || "valeur";
}

/** Qualité d'ancrage d'une cible : uia | nom | chemin | vision | coords | "" (décide ce que le code contient). */
export function anchorQuality(entree?: Ancre | null): string {
  const anchor = entree || {};
  if (anchor.auto_id) return "uia";
  let name = anchor.label || anchor.query || "";
  if (name && anchor.role && name === anchor.role) name = "";
  if (name && anchor.source !== "vision" && !anchor.ambiguous) return "nom";
  if (anchor.path && anchor.source !== "vision") return "chemin";
  if (name && anchor.source !== "vision") return "nom";
  if (name) return "vision";
  const c = anchor.center;
  if ((Array.isArray(c) && c.length >= 2) || (anchor.x !== undefined && anchor.x !== null)) return "coords";
  return "";
}

/** kwargs de ciblage : identité principale (auto_id | nom+rôle | chemin) puis replis ; `lean` = identité seule. */
export function targetKwargs(entree?: Ancre | null, opts?: { lean?: boolean } | null): string {
  const anchor = entree || {};
  const lean = !!(opts && opts.lean);
  const parts: string[] = [];
  const q = anchorQuality(anchor);
  const rel = (): void => {
    if (lean) return;
    if (anchor.image) parts.push("image=" + pyStr(anchor.image));
    if (anchor.window && Array.isArray(anchor.rel) && anchor.rel.length >= 2) {
      parts.push("window=" + pyStr(anchor.window));
      parts.push("rel=(" + Number(anchor.rel[0]).toFixed(3) + ", " + Number(anchor.rel[1]).toFixed(3) + ")");
    }
  };
  if (q === "chemin") {
    parts.push("path=" + pyStr(anchor.path));
    if (!lean && anchor.near) {
      parts.push("near=" + pyStr(anchor.near));
      if (anchor.role) parts.push("role=" + pyStr(anchor.role));
      if (anchor.side) parts.push("side=" + pyStr(anchor.side));
    }
    rel();
    return parts.join(", ");
  }
  if (anchor.auto_id) parts.push("auto_id=" + pyStr(anchor.auto_id));
  let name = anchor.label || anchor.query || "";
  if (name && anchor.role && name === anchor.role) name = "";
  if (name) parts.push("name=" + pyStr(name));
  if (anchor.role && name) parts.push("role=" + pyStr(anchor.role));
  if (q === "coords" || q === "vision") {
    const c = anchor.center;
    if (Array.isArray(c) && c.length >= 2)
      parts.push("at=(" + Math.round(c[0] ?? 0) + ", " + Math.round(c[1] ?? 0) + ")");
    else if (anchor.x !== undefined && anchor.y !== undefined && anchor.x !== null) {
      parts.push("at=(" + Math.round(anchor.x) + ", " + Math.round(anchor.y) + ")");
    }
    return parts.join(", ");
  }
  rel();
  return parts.join(", ");
}

const usable = (a: Ancre | null | undefined): boolean =>
  !!(a && (a.auto_id || a.label || a.path || a.near || a.image));

function timeoutKw(ms: unknown): string {
  const v = Number(ms);
  if (!isFinite(v) || v <= 0) return "timeout=" + TIMEOUT_VAR;
  return "timeout=" + Math.round(v / 100) / 10;
}

function fmtSec(sec: unknown): string {
  let v = Number(sec);
  if (!isFinite(v) || v <= 0) v = DEFAULT_TIMEOUT_MS / 1000;
  return String(Math.round(v * 10) / 10);
}

/** Valeur de `TIMEOUT = N` dans le code, ou null s'il n'y en a pas (ou si elle est calculée). */
export function readTimeoutValue(code: unknown): number | null {
  const m = TIMEOUT_RX.exec(String(code || ""));
  return m ? Number(m[2]) : null;
}

export function timeoutDeclared(code: unknown): boolean {
  return TIMEOUT_DECL_RX.test(String(code || ""));
}

/** Le code sans chaînes (vidées en « "" ») ni commentaires, pour chercher un nom sans se faire piéger. */
export function pyCodeOnly(code: unknown): string {
  const s = String(code || "");
  const n = s.length;
  let out = "";
  let i = 0;
  while (i < n) {
    const ch = s.charAt(i);
    if (ch === "#") {
      while (i < n && s.charAt(i) !== "\n") i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const q = s.substr(i, 3) === ch + ch + ch ? ch + ch + ch : ch;
      i += q.length;
      while (i < n) {
        if (s.charAt(i) === "\\") {
          i += 2;
          continue;
        }
        if (s.substr(i, q.length) === q) {
          i += q.length;
          break;
        }
        if (q.length === 1 && s.charAt(i) === "\n") break;
        i++;
      }
      out += '""';
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

export function usesTimeoutVar(code: unknown): boolean {
  return /\bTIMEOUT\b/.test(pyCodeOnly(code));
}

/** Dernière ligne de l'en-tête (docstring, imports, Session, params) : rien ne s'insère au-dessus. */
export function headerEnd(lines?: readonly string[] | null): number {
  let end = -1;
  let inDoc = false;
  const all = lines || [];
  for (let i = 0; i < all.length; i++) {
    const t = String(all[i] || "").trim();
    const q = (t.match(/"""/g) || []).length;
    if (inDoc) {
      end = i;
      if (q % 2 === 1) inDoc = false;
      continue;
    }
    if (q) {
      end = i;
      if (q % 2 === 1) inDoc = true;
      continue;
    }
    if (!t || t.charAt(0) === "#") continue;
    if (/^(s = Session\(|p = s\.params\(|from |import |TIMEOUT\s*=)/.test(t)) {
      end = i;
      continue;
    }
    break;
  }
  return end;
}

/** Garantit la variable TIMEOUT (valeur d'un ancien `timeout=N` conservée ; délai calculé intact). */
export function ensureTimeoutVar(entree: unknown, secondes?: unknown): string {
  const code = String(entree || "");
  let sec = secondes;
  if (timeoutDeclared(code)) return code;
  const all = code.split("\n");
  const i = all.findIndex((l) => /^s = Session\(/.test(l));
  if (i < 0) {
    all.splice(headerEnd(all) + 1, 0, TIMEOUT_VAR + " = " + fmtSec(sec) + TIMEOUT_COMMENT);
    return all.join("\n");
  }
  let line = all[i] ?? "";
  const lit = /\btimeout\s*=\s*(\d+(?:\.\d+)?)\s*(?=[,)])/.exec(line);
  if (lit) {
    sec = Number(lit[1]);
    line = line.replace(/\btimeout\s*=\s*\d+(?:\.\d+)?(?=\s*[,)])/, "timeout=" + TIMEOUT_VAR);
  } else if (!/\btimeout\s*=/.test(line)) {
    if (/\(\s*\)/.test(line)) line = line.replace(/\(\s*\)/, "(timeout=" + TIMEOUT_VAR + ")");
    else line = line.replace(/([^(\s])\s*\)(\s*(#.*)?)$/, "$1, timeout=" + TIMEOUT_VAR + ")$2");
  }
  all[i] = line;
  all.splice(i, 0, TIMEOUT_VAR + " = " + fmtSec(sec) + TIMEOUT_COMMENT);
  return all.join("\n");
}

/** Change la valeur par défaut (`TIMEOUT = sec`), en déclarant la variable si besoin ; une déclaration calculée reste intacte. */
export function setTimeoutValue(entree: unknown, sec: unknown): string {
  const code = String(entree || "");
  if (TIMEOUT_RX.test(code))
    return code.replace(
      TIMEOUT_RX,
      (_m, head: string, _v: string, tail: string) => head + fmtSec(sec) + tail,
    );
  if (timeoutDeclared(code)) return code;
  return ensureTimeoutVar(code, sec);
}

const join = (parts: readonly string[]): string => parts.filter((p) => p).join(", ");

function expectTarget(expect: Attente): string {
  let a: Ancre = expect.anchor || {};
  if (!a.label && !a.auto_id && expect.query) a = { label: expect.query, role: a.role };
  return targetKwargs(a, { lean: true });
}

/** Lignes Python d'une attente ou d'une vérification (après une action, ou étape seule). */
function expectLines(entree: Attente | null | undefined, timeoutMs: unknown, asCheck: boolean): string[] {
  const expect = entree || {};
  const t = timeoutKw(timeoutMs);
  const q = expect.query || "";
  const cmpKw = (): string => {
    const e = pyStr(expect.expected || "");
    if (expect.cmp === "exact") return "equals=" + e;
    if (expect.cmp === "regex" || expect.match) return "regex=" + e;
    return "contains=" + e;
  };
  switch (expect.kind) {
    case "none":
      return [];
    case "stable":
      return ["s.wait.stable(" + t + ")"];
    case "pause":
      return ["s.wait.seconds(" + Math.round(Math.max(0, Number(timeoutMs) || 0) / 100) / 10 + ")"];
    case "window_ready":
      return ["s.wait.window(" + join([pyStr(q || "."), t]) + ")"];
    case "appear":
      return ["s.wait.appear(" + t + ")"];
    case "element":
      return [
        "s." + (asCheck ? "expect.exists" : "wait.element") + "(" + join([expectTarget(expect), t]) + ")",
      ];
    case "element_gone":
      return ["s." + (asCheck ? "expect.gone" : "wait.gone") + "(" + join([expectTarget(expect), t]) + ")"];
    case "text":
      return ["s.wait.text(" + join([pyStr(q), t]) + ")   # vision : exige Elpis"];
    case "text_gone":
      return ["s.wait.text(" + join([pyStr(q), "gone=True", t]) + ")   # vision : exige Elpis"];
    case "value":
      return ["s.expect.value(" + join([expectTarget(expect), cmpKw(), t]) + ")"];
    case "value_gone":
      return ["s.expect.value(" + join([expectTarget(expect), cmpKw(), "negate=True", t]) + ")"];
    case "state":
      return ["s.expect.state(" + join([pyStr(expect.state || "enabled"), expectTarget(expect), t]) + ")"];
    case "count":
      return [
        "s.expect.count(" +
          join([
            "role=" + pyStr(expect.role || ""),
            q ? "contains=" + pyStr(q) : "",
            "op=" + pyStr(expect.op || "=="),
            "n=" + Number(expect.count || 0),
            t,
          ]) +
          ")",
      ];
    default:
      return ["s.wait.stable(" + t + ")"];
  }
}

function actionLines(step: EtapeAuto): string[] {
  const a = step.args || {};
  const an = step.anchor || {};
  const t = targetKwargs(an);
  let lines: string[] = [];
  const op = step.op || "click";
  let ex: Attente | null | undefined = step.expect;
  const needSnapshot = !!ex && ex.kind === "appear";
  if (needSnapshot) lines.push("s.snapshot()");
  const mods = a.modifiers ? "modifiers=" + pyStr(a.modifiers) : "";
  const btnKw = (dflt?: string): string => {
    const b = String(a.button || dflt || "left").toLowerCase();
    return b !== "left" ? "button=" + pyStr(b) : "";
  };
  const clicksKw = (dflt: number): string => {
    const c = Number(a.clicks) > 1 ? Number(a.clicks) : dflt;
    return c > 1 ? "clicks=" + c : "";
  };
  if (!t && NEEDS_TARGET.indexOf(op) >= 0) {
    return [
      "# s." +
        (op === "set_value" ? "set_value" : op.indexOf("click") >= 0 || op === "invoke" ? "click" : op) +
        "(…)   # cible non retrouvée à l'enregistrement" +
        (an.id ? " (" + an.id + ")" : "") +
        " : à compléter",
    ];
  }
  switch (op) {
    case "click":
    case "left_click":
    case "invoke":
      lines.push("s.click(" + join([t, btnKw(), clicksKw(1), mods]) + ")");
      break;
    case "double_click":
      lines.push("s.click(" + join([t, btnKw(), clicksKw(2) || "clicks=2", mods]) + ")");
      break;
    case "triple_click":
      lines.push("s.click(" + join([t, btnKw(), "clicks=3", mods]) + ")");
      break;
    case "right_click":
      lines.push("s.click(" + join([t, 'button="right"', clicksKw(1), mods]) + ")");
      break;
    case "middle_click":
      lines.push("s.click(" + join([t, 'button="middle"', clicksKw(1), mods]) + ")");
      break;
    case "type":
      lines.push("s.type(" + pyStr(a.text || "") + ")");
      break;
    case "paste":
      lines.push("s.paste(" + pyStr(a.text || "") + ")");
      break;
    case "copy":
      lines.push("s.copy()");
      break;
    case "key":
    case "hotkey":
    case "press":
      lines.push("s.key(" + pyStr(a.keys || "") + ")");
      break;
    case "set_value":
      lines.push("s.set_value(" + join([pyStr(a.text || ""), t]) + ")");
      break;
    case "scroll":
      lines.push("s.scroll(" + join([String(Number(a.dy || 0)), t]) + ")");
      break;
    case "move":
      lines.push("s.move(" + t + ")");
      break;
    case "drag":
      lines.push(
        "s.drag(" +
          join([
            "to=(" + Math.round(Number(a.x2 || 0)) + ", " + Math.round(Number(a.y2 || 0)) + ")",
            t,
            a.modifiers ? "modifiers=" + pyStr(a.modifiers) : "",
          ]) +
          ")",
      );
      break;
    case "launch": {
      const win = ex && ex.kind === "window_ready" && ex.query ? ex.query : "";
      lines.push(
        "s.launch(" +
          join([
            pyStr(a.app || a.target || an.query || ""),
            win ? "wait_window=" + pyStr(win) : "",
            timeoutKw(step.timeout_ms),
          ]) +
          ")",
      );
      if (ex && ex.kind === "window_ready") ex = null;
      break;
    }
    case "toggle":
    case "check":
    case "uncheck":
    case "select":
    case "expand":
    case "collapse":
    case "scroll_into_view":
      lines.push("s." + op + "(" + t + ")");
      break;
    default:
      lines.push("# opération inconnue : " + op);
      break;
  }
  if (Number(step.retry) > 0) {
    const k = needSnapshot ? 1 : 0;
    const cible = lines[k];
    if (cible && /^s\.[a-z_]+\(/.test(cible)) {
      lines[k] = cible.replace(
        /\)$/,
        (cible.endsWith("()") ? "" : ", ") + "retry=" + Number(step.retry) + ")",
      );
    }
  }
  if (ex && ex.kind && ex.kind !== "none") lines = lines.concat(expectLines(ex, step.timeout_ms, false));
  return lines;
}

function condExpr(entree?: Condition | null): string {
  const cond = entree || {};
  let a: Ancre = cond.anchor || {};
  if (!a.label && !a.auto_id && cond.query) a = { label: cond.query, role: a.role };
  const t = targetKwargs(a, { lean: true });
  switch (cond.type) {
    case "missing":
      return "not s.exists(" + t + ")";
    case "value":
      if (cond.cmp === "exact") return "s.value(" + t + ") == " + pyStr(cond.expected || "");
      return pyStr(cond.expected || "") + " in s.value(" + t + ")";
    case "state":
      return "s.state(" + join([pyStr(cond.state || "enabled"), t]) + ")";
    case "text":
      return "s.sees(" + pyStr(cond.query || "") + ")";
    default:
      return "s.exists(" + t + ")";
  }
}

export function needsVision(steps?: readonly EtapeAuto[] | null): boolean {
  return (steps || []).some((st) => {
    const ex = st.expect || {};
    if (ex.kind === "text" || ex.kind === "text_gone") return true;
    return st.kind === "if" && !!st.cond && st.cond.type === "text";
  });
}

/** Le script complet ; `now` est injectable pour des tests déterministes. */
export function automationToPython(entree?: ScriptAuto | null, now?: Date | null): string {
  const script = entree || {};
  const steps = script.steps || [];
  const d = now || new Date();
  const p2 = (n: number): string => String(n).padStart(2, "0");
  const stamp =
    d.getFullYear() +
    "-" +
    p2(d.getMonth() + 1) +
    "-" +
    p2(d.getDate()) +
    " " +
    p2(d.getHours()) +
    ":" +
    p2(d.getMinutes());
  const name = script.name || "automatisation";
  const out: string[] = [];
  out.push("# -*- coding: utf-8 -*-");
  const doc = (v: unknown): string => String(v).replace(/\\/g, "\\\\").replace(/"""/g, '\\"\\"\\"');
  out.push('"""' + doc(name) + " — généré par Elpis Studio le " + stamp + ".");
  out.push(
    "Cible : " +
      doc(script.target || "?") +
      (script.os ? " (" + doc(script.os) + ")" : "") +
      ", écran " +
      Number(script.monitor || 0) +
      ".",
  );
  out.push("Exécuter sur la machine cible : run-script.bat " + pyIdent(name) + ".py [--param=valeur ...]");
  out.push('"""');
  out.push("from elpis_auto import Session");
  out.push("");
  const vision = needsVision(steps);
  out.push(TIMEOUT_VAR + " = " + fmtSec(script.timeout_s) + TIMEOUT_COMMENT);
  out.push(
    "s = Session(" +
      join([
        "monitor=" + Number(script.monitor || 0),
        "timeout=" + TIMEOUT_VAR,
        vision ? 'needs=["vision"]' : "",
      ]) +
      ")",
  );
  const params = script.params || [];
  if (params.length) {
    out.push(
      "p = s.params({" +
        params.map((p) => pyStr(p.name) + ": " + pyStr(p.value == null ? "" : p.value)).join(", ") +
        "})",
    );
  }
  out.push("");

  let depth = 0;
  const pad = (n: number): string => "    ".repeat(n);
  const lastOpen: boolean[] = [];
  const emit = (line: string): void => {
    out.push(line ? pad(depth) + line : "");
    if (lastOpen.length) lastOpen[lastOpen.length - 1] = true;
  };
  const openBlock = (line: string): void => {
    out.push(pad(depth) + line);
    depth++;
    lastOpen.push(false);
  };
  const closeBlock = (): boolean => {
    if (!lastOpen.length) return false;
    if (!lastOpen[lastOpen.length - 1]) out.push(pad(depth) + "pass");
    lastOpen.pop();
    depth = Math.max(0, depth - 1);
    return true;
  };

  for (const st of steps) {
    if (!st) continue;
    if (st.comment) emit("# " + String(st.comment).replace(/\n/g, " "));
    switch (st.kind) {
      case "if":
        openBlock("if " + condExpr(st.cond) + ":");
        break;
      case "else":
        if (closeBlock()) openBlock("else:");
        else emit("# « Sinon » sans « Si » — ignoré");
        break;
      case "end":
        if (!closeBlock()) emit("# « Fin » sans bloc ouvert — ignoré");
        break;
      case "loop":
        openBlock("for _i in range(" + Math.max(1, Number(st.times || 1)) + "):");
        break;
      case "focus":
        emit("s.focus(window=" + pyStr(st.window || "") + ")");
        break;
      case "note":
        emit("s.note(" + pyStr(st.text || "") + ")");
        break;
      case "wait":
        expectLines(st.expect, st.timeout_ms, false).forEach(emit);
        break;
      case "check":
        expectLines(st.expect, st.timeout_ms, true).forEach(emit);
        break;
      case "var":
        if (st.source === "clipboard") emit(pyIdent(st.name) + " = s.copy()");
        else if (st.source === "param") emit(pyIdent(st.name) + " = p[" + pyStr(st.key || st.name) + "]");
        else
          emit(
            pyIdent(st.name) +
              " = s.value(" +
              targetKwargs(usable(st.anchor) ? st.anchor : { label: st.query }, { lean: true }) +
              ")",
          );
        break;
      case "code":
        String(st.text || "")
          .split("\n")
          .forEach((l) => emit(l));
        break;
      default: {
        const lines = actionLines(st);
        if (st.on_error === "continue") {
          const label = stepLabel(st).replace(/"/g, "'");
          openBlock("with s.step(" + join([pyStr(label), 'on_error="continue"']) + "):");
          lines.forEach(emit);
          closeBlock();
        } else {
          lines.forEach(emit);
        }
      }
    }
  }
  while (lastOpen.length) {
    out.push(pad(depth) + "# bloc non fermé — fermé ici");
    closeBlock();
  }
  out.push("");
  out.push("raise SystemExit(s.finish())");
  out.push("");
  return out.join("\n");
}

/** Squelette d'un script neuf : en-tête, Session et pied. */
export function scriptSkeleton(meta?: Partial<ScriptAuto> | null, now?: Date | null): string {
  return automationToPython(newAutomation(meta || {}), now);
}

/** Indice de la ligne de pied (ou la fin). */
export function footerIndex(lines: readonly string[]): number {
  for (let i = lines.length - 1; i >= 0; i--) if ((lines[i] ?? "").trim() === FOOTER) return i;
  return lines.length;
}

/** Lignes Python d'une étape, pour l'insertion dans l'éditeur. */
export function stepLines(entree?: EtapeAuto | null): string[] {
  const step = entree || {};
  switch (step.kind) {
    case "wait":
      return expectLines(step.expect, step.timeout_ms, false);
    case "check":
      return expectLines(step.expect, step.timeout_ms, true);
    case "if":
      return ["if " + condExpr(step.cond) + ":", "    pass"];
    case "else":
      return ["else:", "    pass"];
    case "loop":
      return ["for _i in range(" + Math.max(1, Number(step.times || 1)) + "):", "    pass"];
    case "focus":
      return ["s.focus(window=" + pyStr(step.window || "") + ")"];
    case "note":
      return ["s.note(" + pyStr(step.text || "") + ")"];
    case "var":
      if (step.source === "clipboard") return [pyIdent(step.name) + " = s.copy()"];
      if (step.source === "param") return [pyIdent(step.name) + " = p[" + pyStr(step.key || step.name) + "]"];
      return [
        pyIdent(step.name) +
          " = s.value(" +
          targetKwargs(usable(step.anchor) ? step.anchor : { label: step.query }, { lean: true }) +
          ")",
      ];
    case "code":
      return String(step.text || "").split("\n");
    default:
      return actionLines(step);
  }
}

const indentOf = (line: string | null | undefined): number => {
  const m = /^(\s*)/.exec(line || "");
  return m ? (m[1] ?? "").length : 0;
};

/** La ligne ouvre-t-elle un bloc ? Le « : » final est lu hors chaînes et commentaires. */
export function isBlockOpener(line: string | null | undefined): boolean {
  return (
    /^\s*(if|elif|else|for|while|with|try|except|finally|def|class)\b/.test(line || "") &&
    /:\s*$/.test(pyCodeOnly(line))
  );
}

const blank = (l: string | null | undefined): boolean => {
  const t = String(l || "").trim();
  return !t || t.charAt(0) === "#";
};

/** Dernière ligne du bloc ouvert en `i` (corps plus indenté, vides et commentaires ignorés). */
export function blockEnd(lines: readonly string[], i: number): number {
  const base = indentOf(lines[i]);
  let end = i;
  for (let j = i + 1; j < lines.length; j++) {
    if (blank(lines[j])) continue;
    if (indentOf(lines[j]) <= base) break;
    end = j;
  }
  return end;
}

/** Où écrire « else: » pour le curseur en `cur` : après la fin du bloc qui le contient, à son indentation ; null sinon. */
export function elseInsertPoint(
  entree: readonly string[] | null | undefined,
  cur: number | null | undefined,
): { after: number; indent: number } | null {
  const lines = entree || [];
  if (cur == null || cur < 0 || cur >= lines.length) return null;
  const CLAUSE = /^\s*(if|elif|for|while|try|except)\b/;
  let op = -1;
  if (isBlockOpener(lines[cur]) && CLAUSE.test(lines[cur] ?? "")) op = cur;
  else {
    let ind = blank(lines[cur]) ? Infinity : indentOf(lines[cur]);
    for (let k = cur - 1; k >= 0; k--) {
      if (blank(lines[k])) continue;
      const ik = indentOf(lines[k]);
      if (ik < ind) {
        if (isBlockOpener(lines[k]) && CLAUSE.test(lines[k] ?? "")) {
          op = k;
          break;
        }
        if (ik === 0) break;
        ind = ik;
      }
    }
  }
  if (op < 0) return null;
  return { after: blockEnd(lines, op), indent: indentOf(lines[op]) };
}

/** Retire la ligne `i` sans casser le Python : un ouvrant part avec son corps et ses clauses ; un corps vidé reçoit « pass ». */
export function deleteLineAt(
  entree: unknown,
  i: number | null | undefined,
): { code: string; removed: number } {
  const all = String(entree || "").split("\n");
  if (i == null || i < 0 || i >= all.length) return { code: String(entree || ""), removed: 0 };
  const start = i;
  let end = i;
  const base = indentOf(all[i]);
  if (isBlockOpener(all[i])) {
    end = blockEnd(all, i);
    const clauses = /^\s*(if|try|for|while)\b/.test(all[i] ?? "");
    while (clauses) {
      let nx = end + 1;
      while (nx < all.length && blank(all[nx])) nx++;
      if (
        nx < all.length &&
        indentOf(all[nx]) === base &&
        /^\s*(elif|else|except|finally)\b/.test(all[nx] ?? "") &&
        isBlockOpener(all[nx])
      )
        end = blockEnd(all, nx);
      else break;
    }
  }
  all.splice(start, end - start + 1);
  let prev = start - 1;
  while (prev >= 0 && blank(all[prev])) prev--;
  if (prev >= 0 && isBlockOpener(all[prev]) && indentOf(all[prev]) < base) {
    let next = start;
    while (next < all.length && blank(all[next])) next++;
    if (next >= all.length || indentOf(all[next]) <= indentOf(all[prev])) {
      all.splice(start, 0, " ".repeat(indentOf(all[prev]) + 4) + "pass");
      return { code: all.join("\n"), removed: end - start };
    }
  }
  return { code: all.join("\n"), removed: end - start + 1 };
}

/** Insère `lines` après la ligne `after` (-1 : avant le pied), à son indentation ; un « pass » de bloc vide est remplacé. */
export function insertLinesAt(
  entree: unknown,
  apres: number | null | undefined,
  lines?: readonly string[] | null,
  indentOverride?: number | null,
): { code: string; line: number } {
  const all = String(entree || "").split("\n");
  let after = apres;
  if (after != null && after >= 0 && (after <= headerEnd(all) || after >= footerIndex(all))) after = -1;
  let at = after == null || after < 0 || after >= all.length ? footerIndex(all) : after + 1;
  const ref = after != null && after >= 0 && after < all.length ? (all[after] ?? "") : "";
  let n = indentOverride == null ? indentOf(ref) : Math.max(0, Number(indentOverride) || 0);
  const opener = indentOverride == null && isBlockOpener(ref);
  if (opener) n += 4;
  const indent = " ".repeat(n);
  let replacePass = ref.trim() === "pass" && indentOverride == null;
  const suivante = after == null ? undefined : all[after + 1];
  if (after != null && opener && suivante != null && suivante.trim() === "pass" && indentOf(suivante) === n) {
    after = after + 1;
    at = after;
    replacePass = true;
  }
  const body = (lines || []).map((l) => (l ? indent + l : ""));
  if (replacePass) all.splice(after as number, 1, body[0] ?? "");
  else all.splice(at, 0, body[0] ?? "");
  const first = replacePass ? (after as number) : at;
  if (body.length > 1) all.splice(first + 1, 0, ...body.slice(1));
  return { code: all.join("\n"), line: first };
}

/** Plan de lecture du code : une ligne par instruction utile, avec niveau, genre et qualité d'ancrage. */
export function outlineFromCode(code: unknown): LignePlan[] {
  const rows: LignePlan[] = [];
  let inDoc = false;
  String(code || "")
    .split("\n")
    .forEach((raw, i) => {
      const t = raw.trim();
      const quotes = (t.match(/"""/g) || []).length;
      if (quotes % 2 === 1) {
        inDoc = !inDoc;
        return;
      }
      if (inDoc || quotes) return;
      if (!t || t.charAt(0) === "#" || t === "pass") return;
      if (/^(from |import |s = Session\(|p = s\.params\(|raise SystemExit|TIMEOUT\s*=)/.test(t)) return;
      let kind = "code";
      if (/:$/.test(t) && /^(if |elif |else|for |while |with |try|except|finally)/.test(t)) kind = "block";
      else if (/^s\.wait\./.test(t)) kind = "wait";
      else if (/^s\.expect\./.test(t)) kind = "check";
      else if (/^s\.note\(/.test(t)) kind = "note";
      else if (/^s\.(launch|focus|close)\(/.test(t)) kind = "window";
      else if (/^s\.[a-z_]+\(/.test(t)) kind = "action";
      let anchor = "";
      if (/auto_id=/.test(t)) anchor = "uia";
      else if (/\bname=/.test(t)) anchor = "nom";
      else if (/\bpath=/.test(t)) anchor = "chemin";
      else if (/\bnear=/.test(t)) anchor = "voisin";
      else if (/\bimage=/.test(t)) anchor = "image";
      else if (/\bdescribe=/.test(t)) anchor = "vision";
      else if (/\bat=\(|\brel=\(/.test(t)) anchor = "coords";
      rows.push({ line: i, indent: Math.floor(indentOf(raw) / 4), text: t, kind, anchor });
    });
  return rows;
}

/** Découpe les arguments d'un appel Python au niveau 0 (tuples et chaînes respectés). */
function splitArgs(argstr: string): string[] {
  const out: string[] = [];
  let cur = "";
  let depth = 0;
  let q: string | null = null;
  for (let i = 0; i < argstr.length; i++) {
    const ch = argstr.charAt(i);
    if (q) {
      cur += ch;
      if (ch === "\\") cur += argstr.charAt(++i);
      else if (ch === q) q = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      q = ch;
      cur += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const keyOf = (a: string): string => (a.split("=")[0] ?? "").trim();

/** Applique une identité proposée à une ligne : l'identité principale est remplacée, replis et autres arguments gardés. */
export function applyIdentity(line: string | null | undefined, suggest: string | null | undefined): string {
  const m = /^(\s*)(.*?)(\(([\s\S]*)\))(\s*#.*)?$/.exec(line || "");
  if (!m || !suggest) return line ?? "";
  const head = (m[1] ?? "") + (m[2] ?? "");
  const args = splitArgs(m[4] ?? "");
  const tail = m[5] || "";
  const sug = splitArgs(suggest);
  const sugKeys = sug.map(keyOf);
  const primary = ["auto_id", "name", "role", "path", "near", "side", "describe"];
  const kept = args.filter((a) => {
    const k = a.indexOf("=") > 0 ? keyOf(a) : "";
    if (!k) return true;
    if (sugKeys.indexOf(k) >= 0) return false;
    return primary.indexOf(k) < 0;
  });
  const positional = kept.filter((a) => a.indexOf("=") < 0 || /^["']/.test(a));
  const named = kept.filter((a) => positional.indexOf(a) < 0);
  const ordered = named.slice().sort((a, b) => {
    const ia = IDENTITY_KEYS.indexOf(keyOf(a));
    const ib = IDENTITY_KEYS.indexOf(keyOf(b));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  return head + "(" + positional.concat(sug, ordered).join(", ") + ")" + tail;
}

/** Le premier bloc ```python d'une réponse (sinon tout le texte s'il ressemble à du code, sinon rien). */
export function extractPythonBlock(texte: unknown): string {
  const text = String(texte || "");
  const m = /```(?:python|py)?\s*\n([\s\S]*?)```/i.exec(text);
  if (m) return (m[1] ?? "").replace(/\s+$/, "");
  if (/^\s*s\.[a-z_]+\(/m.test(text)) return text.trim();
  return "";
}

/** Aide-mémoire de l'API elpis_auto (assistant IA et aide à l'écran). */
export const API_CHEATSHEET = [
  "API elpis_auto (objet s = Session) — une ligne = une action :",
  's.launch("calc.exe", wait_window="Calculatrice", timeout=TIMEOUT)   s.focus(window="Bloc-notes")   s.close(window="…", timeout=TIMEOUT)',
  's.click(auto_id="…", name="…", role="button")   clicks=2 (double)   button="right"   at=(x, y) en dernier recours',
  's.click(path="#Panel/group[2]/button[1]")   contrôle SANS nom : chemin depuis un ancêtre nommé (#auto_id ou role:Nom), rôle[rang] à chaque pas',
  'Pile d\'identités (essayées dans l\'ordre) : auto_id, path, name+role, near="Libellé" (+side=right|left|below|above), image="assets/x.png", describe="…" (vision Elpis), window="#Win"+rel=(fx, fy), at=(x, y)',
  's.require(window="Titre", launch="app.exe")   s.require(gone="Titre")   s.require(checked=True, name="…")   préconditions (état de départ garanti)',
  "Options : python -m elpis_auto --dry-run | --trace | --repeat N | --data jeu.csv script.py   ·   import lib.xxx (dossier lib/ à côté du script)",
  's.type("texte")   s.key("ctrl+s")   s.paste("texte")   v = s.copy()   s.set_value("12", auto_id="…")',
  's.scroll(-3, name="…")   s.drag(to=(x, y), name="…")   s.toggle/check/uncheck/select/expand/collapse(name="…")',
  "TIMEOUT = 30 en tête du script : délai par défaut de tout ce qui attend. Écrire timeout=TIMEOUT sur chaque wait/expect/launch ; une valeur (timeout=120) seulement pour une étape qui a besoin d'un autre délai",
  's.wait.window("Titre", timeout=TIMEOUT)   s.wait.element(name="…", timeout=TIMEOUT)   s.wait.gone(name="…", timeout=TIMEOUT)   s.wait.stable(timeout=TIMEOUT)   s.wait.appear(timeout=TIMEOUT)',
  "s.wait.seconds(20) : pause FIXE (seulement quand rien d'observable ne signale la fin ; sinon une attente nommée rend la main plus tôt)",
  "s = Session(monitor=1, timeout=TIMEOUT, patience=120) : délai SANS activité à l'écran (tant que ça bouge, on attend, jusqu'à patience s) ; appli lourde : TIMEOUT = 90 et patience=300   window=\"Titre\" sur un clic = premier plan si possible, jamais une panne",
  's.expect.exists(name="…", timeout=TIMEOUT)   s.expect.gone(…, timeout=TIMEOUT)   s.expect.value(name="Total", contains="42" | equals= | regex=, timeout=TIMEOUT)',
  's.expect.state("checked", name="…")   s.expect.count(role="button", op=">=", n=3)',
  's.exists(name="…") -> bool   s.value(name="…") -> str   s.state("checked", name="…") -> bool   s.note("…")',
  'with s.step("libellé", on_error="continue"): …   retry=2 sur une action   p = s.params({"cle": "défaut"})',
  "Règle : viser auto_id, sinon name + role (arbre d'accessibilité), sinon path= ; at=(x, y) seulement s'il n'y a rien d'autre.",
].join("\n");
